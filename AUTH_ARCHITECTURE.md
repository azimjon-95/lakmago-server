# LokmaGo — Auth Arxitekturasi

Barcha platformalar (Telegram, Web, kelajakda Android/iOS) bitta LokmaGo
`User` accountidan foydalanadi. Bu hujjat auth tizimining to'liq holatini
va kelajakdagi provayderlarni (Google, Apple, Phone) qanday qo'shish
kerakligini tasvirlaydi.

**Bosqichlar tarixi:**
- 1-bosqich (`c81f21b`) — `AuthIdentity`/`Session` fundamenti, refresh token.
- 2-bosqich (`50d7205`) — Telegram Login Widget (brauzer), `/users/me`, `Address`.
- 3-bosqich (joriy) — mobil-tayyor arxitektura, account linking, session nazorati.

---

## 1. Ma'lumot modeli

```
User (models/User.js)
  — profil: firstName, lastName, username, avatarUrl, phone, phoneVerified
  — status: ACTIVE | BLOCKED | DELETED
  — provayderga xos maydonlarga BOG'LANMAGAN (telegramId HALI mavjud,
    pastga qarang — "Nega telegramId hali User'da" bo'limi)

AuthIdentity (models/AuthIdentity.js)
  — userId, provider ('telegram'|'phone'|'google'|'apple'), providerUserId
  — unique({provider, providerUserId}) — bitta provider-akkaunt faqat
    BITTA User'ga tegishli bo'lishi mumkin
  — unique({userId, provider}) — bitta User bitta providerdan faqat
    BITTA marta bog'langan bo'lishi mumkin

Session (models/Session.js)
  — userId, refreshTokenHash (SHA-256, xom token HECH QACHON saqlanmaydi)
  — deviceId, platform ('telegram'|'web'|'android'|'ios')
  — expiresAt (TTL index — MongoDB o'zi avtomatik o'chiradi), revokedAt
  — CHEKLOVSIZ: bitta User bir vaqtning o'zida ko'p Session'ga ega
    bo'lishi mumkin (telegram + web + android + ios parallel)

Address (models/Address.js)
  — userId, title, address, latitude/longitude, entrance/apartment/
    floor/comment, isDefault
```

## 2. Auth oqimi (umumiy, barcha provayderlar uchun)

```
[Provider] → validate → completeAuth(identity) → AuthIdentity → User → Session → tokens
```

Har bir provayder controlleri quyidagi UMUMIY qadamlarni bajaradi
(Telegram uchun `controllers/misc.js`da amalga oshirilgan, bo'lajak
Google/Apple/Phone HAM shu qadamlarni takrorlaydi):

1. **Provider tokenini serverda validate qilish** — clientdan kelgan
   xom ID'ga HECH QACHON ishonilmaydi. Telegram'da ikkita mustaqil
   mexanizm bor (initData va Login Widget — pastga qarang), Google/Apple
   uchun ularning JWT/ID-token'i providerning public key'i bilan
   tekshiriladi (kelajakda).
2. **User topish yoki yaratish** — `provider+providerUserId` orqali.
   Login vaqtida ("hali kim ekanligi noma'lum" holat).
3. **`linkIdentity(userId, provider, providerUserId)`** chaqiriladi
   (`services/authIdentity.js`) — AuthIdentity'ni xavfsiz bog'laydi.
   Bu funksiya HOZIR HAM ishlatiladi (nazariy emas) — Telegram login
   oqimining o'zi shundan foydalanadi.
4. **BLOCKED tekshiruvi** — `user.status === 'BLOCKED'` bo'lsa rad etiladi.
5. **Session yaratish** — `signAccessToken()` (qisqa, 1 soat) +
   `generateRefreshToken()` (uzoq, 30 kun, DB'da hash holida).

## 3. Telegram — ikkita mustaqil validatsiya mexanizmi

| | Mini App (`Telegram.WebApp.initData`) | Login Widget (brauzer) |
|---|---|---|
| Qachon | Bot ichida ochilganda | lokma.uz'da "Telegram orqali kirish" |
| Endpoint | `POST /auth/telegram` | `POST /auth/telegram-web` |
| secret_key | `HMAC-SHA256("WebAppData", bot_token)` | `SHA256(bot_token)` |
| Funksiya | `verifyTelegramInitData()` | `verifyTelegramLoginWidget()` |

**Ikkalasi ham bir xil `completeTelegramAuth()` orqali yakunlanadi**
(`controllers/misc.js`) — shuning uchun ikkala yo'l ham bir xil User
accountga olib boradi (telegramId qidiruvi bir xil).

## 4. Account linking fundamenti

`services/authIdentity.js` — `linkIdentity(userId, provider, providerUserId)`:

- Identity mavjud emas → yaratiladi.
- Identity ALLAQACHON shu userId'ga bog'langan → no-op (idempotent).
- Identity BOSHQA userId'ga bog'langan → **xato** (`IDENTITY_ALREADY_LINKED`,
  409) — bu aynan `Telegram → User #1, Google → User #2` (bitta mijoz uchun
  ikkita alohida akkaunt) holatining oldini oladi.

**Kelajakda Google/Apple/Phone qo'shilganda ikkita ssenariy bo'ladi:**

- **Login** (foydalanuvchi hali tizimga kirmagan): provider controller
  identity orqali User qidiradi, topilmasa yangi User yaratadi (Telegram
  bilan bir xil pattern).
- **Linking** (foydalanuvchi ALLAQACHON tizimga kirgan, masalan Telegram
  orqali, va endi Google'ni ham bog'lamoqchi): `POST /auth/link/google`
  kabi endpoint (`auth` middleware bilan, `req.userId` mavjud) to'g'ridan
  to'g'ri `linkIdentity(req.userId, 'google', googleId)` ni chaqiradi.
  Bu funksiya ALLAQACHON yozilgan va test qilingan — yangi provider
  qo'shilganda faqat provider-tokenni validate qiluvchi qatlam kerak
  bo'ladi, linking xavfsizligi qayta yozilmaydi.

## 5. Session nazorati (device management)

```
GET    /auth/sessions       — joriy foydalanuvchining barcha FAOL sessiyalari
                               (platform, deviceId, createdAt — refreshTokenHash
                               HECH QACHON qaytarilmaydi)
DELETE /auth/sessions/:id   — bitta sessiyani bekor qiladi ("boshqa
                               qurilmada chiqish"). Faqat O'ZINING
                               sessiyasi — userId bo'yicha tekshiriladi.
```

Bu ikkita endpoint HOZIR ham real va foydali (Telegram + Web bilan),
Android/iOS qo'shilganda ayniqsa muhim bo'ladi — foydalanuvchi qaysi
qurilmalarda tizimga kirganini ko'rib, xohlagan birini chiqarib
yuborishi mumkin bo'ladi.

## 6. Token strategiyasi

| | Access token | Refresh token |
|---|---|---|
| Muddat | 1 soat | 30 kun |
| Format | JWT (`{userId, role, type:'access'}`) | Tasodifiy 48-bayt hex |
| Saqlash (server) | Saqlanmaydi (stateless) | SHA-256 hash, `Session` sifatida |
| Rotatsiya | — | Har `refresh`da eskisi revoke, yangisi yaratiladi |

Admin/restoran/xodim panellari (`signToken()`, 30 kunlik, `middleware/auth.js`)
BU TIZIMDAN ALOHIDA — ularga tegilmadi, alohida ish sifatida qoladi.

## 7. Xavfsizlik nazorati ro'yxati

| Talab | Holat |
|---|---|
| Access token qisqa muddatli | ✅ 1 soat |
| Refresh token rotation | ✅ har refresh'da |
| Refresh token hash (DB'da xom holda emas) | ✅ SHA-256 |
| Session revoke | ✅ logout + revokeSession |
| Device/session nazorati | ✅ GET/DELETE /auth/sessions |
| Rate limiting | ✅ `loginLimiter` — telegram/telegram-web/refresh |
| HTTPS | ⚠️ infratuzilma darajasida (nginx/VPS) — kod darajasida tekshirib bo'lmaydi |
| Provider tokenlarini serverda validate qilish | ✅ initData + Login Widget, ikkalasi ham HMAC bilan |
| .env orqali sirlarni saqlash | ✅ `JWT_SECRET`, `TELEGRAM_BOT_TOKEN` |
| Token/sir log qilinmasligi | ✅ tekshirildi — auth kodida hech qanday token/parol console'ga chiqmaydi |
| provider+providerUserId unique | ✅ `AuthIdentity` compound unique index |
| Duplicate account himoyasi | ✅ `linkIdentity()` — 10/10 test |

## 8. API contract va versionlash

Barcha endpointlar `/api` prefiksi ostida mount qilingan
(`app.use('/api', apiLimiter, router)`, `src/index.js`). Kelajakda
breaking change kerak bo'lsa, `/api/v2/...` alohida router sifatida
qo'shilishi mumkin — hozirgi `/api/...` o'zgarishsiz qoladi.

## 9. Nega `User.telegramId` hali ham mavjud

`AuthIdentity` provayderga xos identifikatorni User'dan ajratish uchun
1-bosqichda qo'shildi, LEKIN `User.telegramId` maydoni OLIB TASHLANMADI:
u 14+ fayl bo'ylab (referral, bot xabarlari, kuryer dispetcherligi va
h.k.) to'g'ridan-to'g'ri ishlatiladi. Buni olib tashlash jonli tizimda
katta, xavfli refaktoring bo'lardi. `AuthIdentity` va `User.telegramId`
PARALLEL, sinxron ishlaydi (`completeTelegramAuth` ikkalasini ham
yangilaydi). Bu qoldiq — kelajakda, alohida, past-risk bosqichda,
`User.telegramId`ga bog'liq barcha joylar `AuthIdentity` orqali qayta
yozilishi mumkin, lekin bu Auth fundamenti ishlashiga to'sqinlik qilmaydi.

## 10. Kelajakdagi provayder qo'shish — amaliy qadamlar

Masalan Google qo'shilganda:

1. `AuthIdentity.provider` enum'iga `'google'` ALLAQACHON bor — o'zgarish
   kerak emas.
2. `controllers/authGoogle.js` (yangi) — Google ID-token'ini Google'ning
   public key'lari bilan tekshiradi (`google-auth-library` kabi kutubxona).
3. Login: `User.findOne` o'rniga `findIdentity('google', googleSub)`
   orqali User topiladi (yoki yangi User yaratiladi + `linkIdentity()`).
4. Linking: `POST /auth/link/google` (auth middleware bilan) →
   `linkIdentity(req.userId, 'google', googleSub)`.
5. Token/Session — `signAccessToken()`, `generateRefreshToken()`,
   `Session.create()` — O'ZGARISHSIZ qayta ishlatiladi.

**Hech qanday User/Session/AuthIdentity modeli, hech qanday token
mantiqi qayta yozilmaydi** — faqat provider-validation qatlami qo'shiladi.
