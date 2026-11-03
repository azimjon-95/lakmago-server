# Kuryer ilovasi (BOSQICH 2) — login/parol bilan kiradigan ishchi kuryerlar

`DeliveryAssignment` dagi arxitektura izohlari (BOSQICH 1 → 2) amalga oshirildi. **Bosqich 1 (havola orqali, ro'yxatsiz) o'zgarmagan** va yonma-yon ishlayveradi.
Buyurtma holati, «birinchi qabul qilgan oladi» va hisob-kitob uchun MAVJUD funksiyalar ishlatiladi (`acceptShare`, `deliverShare`) — ularning mantig'i qayta yozilmagan.

## Xavfsizlik modeli
* Kuryer JWT'si **boshqa kalit** bilan imzolanadi (`COURIER_JWT_SECRET`, bo'sh bo'lsa `JWT_SECRET:courier`). Mavjud `auth` middleware'i (mijoz `/orders…`,
  restoran, admin) uni **rad etadi**; kuryer middleware'i (`courierAuth`) esa restoran/mijoz tokenini rad etadi. Testlangan.
* Har so'rovda akkaunt faolligi tekshiriladi: admin bloklasa token tugashini kutmasdan darhol to'xtaydi.
* Kuryer identifikatori faqat tokendan. Hamma so'rov `assignedAccountId = req.courierId` bo'yicha: boshqa kuryerning buyurtmasi / tarixi / joylashuviga yo'l yo'q.
* **Taklifda mijoz ma'lumoti yo'q** (telefon, ism, aniq manzil, koordinata) — faqat restoran, tuman, taomlar, yetkazish haqi, masofa. Qabul qilgach ko'rinadi. Push'da ham yo'q.
* Parollar `bcrypt`; javoblarda hash yo'q. Yangi kolleksiyalar: `courieraccounts`, `couriershifts`, `courierdevices`, `courieroffers`. Mavjud kolleksiyalar o'zgarmagan;
  `DeliveryAssignment` ga bitta ixtiyoriy maydon qo'shildi (`assignedAccountId`, default null). Migratsiya yo'q.

## API (`/api/courier-app/*`, kuryer JWT)
| | |
|---|---|
| `POST /login {login, password}` | token + profil (login registrga bog'liq emas) |
| `GET /me`, `GET /shift` | profil, smena holati, faol buyurtma |
| `POST /shift/start` · `POST /shift/end` | «Ishni boshladim» / «Ishni yakunladim» (idempotent; faol buyurtma bor bo'lsa yakunlash 409) |
| `POST /location {lat,lng,accuracy?,speed?,heading?}` | **har ~5 soniyada**; smena ochiq bo'lishi shart; chegara tekshiruvi; 30 so'rov/daq limit |
| `GET /offers` | ochiq takliflar (radius 10 km, eng yaqini birinchi) |
| `POST /offers/:id/accept` | atomik: birinchi olgan oladi; to'liq ma'lumot qaytadi |
| `GET /active` · `POST /active/deliver` | faol buyurtma · «Topshirdim» (hisob-kitob mavjud mantiq bilan) |
| `GET /history?limit&before` · `GET /stats` · `GET /shifts` | tarix; bugun/7/30 kun hisobot (yetkazishlar, haq — faqat ma'lumot, ish vaqti, masofa); smena tarixi |
| `POST/DELETE /devices`, `POST /devices/test` | push token (FCM/APNs), test |
Admin (`couriers` ruxsati): `GET/POST /api/admin/courier-accounts`, `PATCH /api/admin/courier-accounts/:id` (bloklash, parolni tiklash).

## Joylashuv — Redis (har ~5 s)
`courier:loc:<id>` HASH `{lat,lng,acc,spd,hdg,ts}` **TTL 90 s** (jim qolgan / telefoni o'chgan kuryer o'zi yo'qoladi); `couriers:onshift` SET.
«Yaqin kuryerlar» = to'plamdagilarni pipeline bilan o'qib masofa hisoblash (yuzlab kuryer uchun yetarli; minglab bo'lsa GEOSEARCH).
Vaqt **serverniki**. **Redis majburiy emas** (platforma qoidasi): yo'q bo'lsa jarayon xotirasiga yoziladi (bitta nusxada to'liq ishlaydi; bir nechta nusxada Redis kerak).
Faol buyurtma bo'lsa nuqta `DeliveryAssignment.location` ga ham yoziladi — mijoz kuzatuvi (`orderTrack`) o'zgarishsiz ishlaydi; mijoz manziliga 150 m qolganda «yetib keldi».
Smena bazada saqlanadi (ish vaqti, masofa); 16 soatdan oshgan unutilgan smena avtomatik yopiladi.

## Takliflar va push
Taymer (5 s): ochiq `DeliveryAssignment` (restoran yoki bot havola yaratganda) → smenada, joylashuvi yangi, restoranga ≤ `COURIER_OFFER_RADIUS_M` (10 km), band bo'lmagan
kuryerlar → push (FCM `courier_offer`, iOS `courier_alert.wav` — restoran signalidan **alohida melodiya**). Har kuryerga bir taklif ko'pi bilan 3 marta, 30 s oralig'ida
(`CourierOffer` unikal indeks: ikki tick / ikki server nusxasi dublikat yubormaydi). Taklif olinsa qolganlarga `courier_offer_closed`. Yaroqsiz token o'chiriladi.
Bir vaqtda ushlab turish: `COURIER_MAX_ACTIVE` (1).

## Deploy / rollback (faqat sizning tasdig'ingiz bilan)
1. `.env`: ixtiyoriy `COURIER_JWT_SECRET`, `REDIS_URL` (tavsiya). `git pull` → `pm2 restart lakmago-server`.
2. Admin: «Kuryer akkauntlari» sahifasida akkaunt yarating (yoki `POST /api/admin/courier-accounts`).
Rollback: `git revert` + restart — yangi kolleksiyalar va maydon qoladi, hech narsaga ta'sir qilmaydi.
