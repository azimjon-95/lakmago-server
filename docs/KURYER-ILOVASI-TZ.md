# TZ: LokmaGo kuryer ilovasi

LokmaGo'ning o'z kuryerlari uchun ilova (alohida frontend, masalan `lokma-courier`; Capacitor — iOS/Android).
Server tomoni tayyor: `src/controllers/delivery.js`, `src/services/courierPool.js`. Tizim mantig'i: `docs/YETKAZISH-REJIMLARI.md`.

## 1. Asosiy g'oya

- Restoran buyurtmani **qabul qilgach**, buyurtma **umumiy qutiga** tushadi.
- O'sha tumandagi barcha kuryerlar uni ko'radi, **kim birinchi «Olaman» bossa — o'sha oladi**. Server buni atomik qiladi: ikkinchi kuryer «Bu buyurtmani boshqa kuryer oldi» javobini oladi.
- Kuryer faqat **o'zi tanlagan tumanlardagi** buyurtmalarni ko'radi. Tumanni istalgan payt o'zgartiradi (masalan bugun Chust tumaniga borib ishlaydi).
- Qutida **mijozning aniq manzili va telefoni ko'rinmaydi** — faqat restoran, masofa, kuryer haqi va naqd summasi. To'liq ma'lumot buyurtmani olgach ochiladi.

## 2. Ekranlar

### 2.1 Kirish
- **Kiritiladi:** telefon va PIN (4–8 raqam). Kuryerni admin qo'shadi va PIN beradi. Ro'yxatdan o'tish ilovada yo'q.
- `POST /api/courier/auth/login { phone, pin }` → `{ token, courier }`. Token xavfsiz xotirada saqlanadi (Capacitor Preferences / Keychain).
- **Xatolar:**
  - `401 BAD_CREDENTIALS` — «Telefon yoki PIN noto'g'ri»;
  - `403 COURIER_PENDING` — «Akkaunt hali tasdiqlanmagan»;
  - `403 COURIER_BLOCKED` — «Akkaunt bloklangan»;
  - `429` — ko'p urinish, 15 daqiqa kuting.
- Har qanday so'rovda `401 SESSION_EXPIRED` kelsa (PIN almashgan yoki bloklangan) — tokenni o'chirib, kirish ekraniga qaytish.

### 2.2 Bosh ekran: «Ishdaman» va quti
- **Tepada:**
  - katta **«Ishdaman / Dam olyapman»** almashtirgichi — `PATCH /api/courier/me { isOnline }`. Tuman tanlanmagan bo'lsa server `400 NO_DISTRICTS` qaytaradi → tumanlar ekranini ochish;
  - tanlangan tumanlar (chiplar) va «O'zgartirish» tugmasi.
- **Balans kartasi** (`GET /api/courier/me`):
  - `balanceSom` — musbat bo'lsa «LokmaGo sizga qarz: X so'm», manfiy bo'lsa «Qo'lingizdagi LokmaGo puli: X so'm»;
  - `cashRoomSom` — «Yana X so'mlik naqd buyurtma olishingiz mumkin». 0 yoki manfiy bo'lsa, ogohlantirish: «Naqdni topshiring».
- **Quti ro'yxati** (`GET /api/courier/pool`). Har kartada:
  - restoran nomi va manzili, holat («Tayyorlanmoqda» / «Tayyor»);
  - restorandan mijozgacha masofa (`distanceKm`, to'g'ri chiziq);
  - **kuryer haqi** `earningSom` (masalan 27 000 so'm);
  - to'lov: **naqd X so'm oling** (`cashToCollectSom`) yoki «Karta — to'langan»;
  - «Tekin yetkazish» belgisi (`freeDelivery`) — mijozdan yetkazish puli olinmaydi, kuryer haqi baribir beriladi;
  - **«Olaman»** tugmasi.
- **«Olaman»** — `POST /api/courier/orders/:id/claim`:
  - `200` → «Faol buyurtmalar» ekraniga;
  - `409 RACE_LOST` → «Boshqa kuryer ulgurdi», karta ro'yxatdan olib tashlanadi;
  - `409 ACTIVE_LIMIT` → «Bir vaqtda N tadan ortiq olib bo'lmaydi»;
  - `409 DEBT_LIMIT` → «Qo'lingizdagi naqd chegaradan oshadi — avval topshiring» (javobda `balanceSom`, `openCashSom`, `limitSom`);
  - `409 OFFLINE` → «Avval «Ishdaman»ni yoqing»;
  - `409 WRONG_DISTRICT` → tumanlar o'zgargan, ro'yxatni yangilash.

### 2.3 Tumanlar
- Ro'yxat: `GET /api/districts`. U Namangan shahri (3 ta) va 11 ta tumandan iborat, uz/uzc/ru nomlari bilan. Ikki guruhda, belgilash (chip) shaklida ko'rsatiladi.
- Saqlash: `PATCH /api/courier/me { workDistricts: [...] }`.
- Saqlangach soketga `courier:refresh-rooms` yuboriladi (yangi tuman hodisalari kelishi uchun) va quti qayta yuklanadi.

### 2.4 Faol buyurtma
`GET /api/courier/orders/active` — to'liq ma'lumot:
- **restoran:** nom, manzil, telefon (qo'ng'iroq), xarita/navigatsiya tugmasi;
- **mijoz:** ism, telefon (qo'ng'iroq), manzil, izoh/mo'ljal, koordinata (navigatsiya);
- taomlar ro'yxati, jami summa, naqd bo'lsa **«Mijozdan X so'm oling»**.

Holatga qarab tugmalar:

| Holat | Tugma | So'rov |
|---|---|---|
| Olindi, restoranda | **«Taomni oldim»** | `POST /orders/:id/pickup` → «Yo'lda» |
| Olindi, restoranda | «Qaytarish» (faqat olishdan oldin, tasdiq so'raladi) | `POST /orders/:id/release` → qutiga qaytadi |
| Yo'lda | **«Mijozga topshirdim»** | `POST /orders/:id/deliver` |

- **«Taomni oldim»:** restoran «Tayyor»ni bosmagan bo'lsa ham ishlaydi (taom qo'lda). Bosishdan oldin tasdiq oynasi chiqadi: «Taom qo'lingizdami?».
- **«Topshirdim»:** naqd bo'lsa tasdiq oynasi — «Mijozdan X so'm oldingizmi?». Javobda yangilangan balans keladi.

### 2.5 Tarix va kassa
- `GET /api/courier/orders/history?days=30` — yetkazilganlar, har biri bo'yicha haq, jami daromad.
- `GET /api/courier/ledger` — balans harakatlari:
  - «Mijozdan naqd olindi» (−);
  - «Yetkazish ulushi» (+);
  - «Naqd topshirildi» (+);
  - «Kuryerga to'landi» (−);
  - «Tuzatish».
- Naqdni topshirish va to'lovni **LokmaGo kassasi (admin)** yozadi — ilovada bunday tugma yo'q.

## 3. Real vaqt (Socket.IO)

- **Ulanish:** `io(SOCKET_URL, { auth: { token } })` — server kuryerni avtomatik `courier:<id>` va `courier-district:<tuman>` xonalariga qo'shadi (`courier:joined { ok, districts }`).
- **Hodisalar:**
  - `pool:new { orderId }` — qutiga yangi buyurtma: ovoz/tebranish (faqat «Ishdaman» holatida) va ro'yxatni yangilash;
  - `pool:taken { orderId }` / `pool:removed { orderId }` — kartani ro'yxatdan olib tashlash;
  - `courier:order { _id, status | released }` — o'z buyurtmasi o'zgardi (restoran «Tayyor» bosdi, bekor qilindi, admin qaytardi) → faol buyurtmani yangilash va xabar ko'rsatish.
- **Ishonchlilik:** soket uzilsa, quti har 20 soniyada `GET /pool` bilan yangilanadi. Faqat soketga tayanmang.

## 4. Push-bildirishnoma (keyingi bosqich)

Ilova yopiq bo'lsa ham «Qutida yangi buyurtma» kelishi uchun FCM/APNs kerak. Serverda kuryer qurilma tokeni hali yo'q — keyingi bosqich (`docs/MOBIL-PUSH.md` naqshi bo'yicha).

## 5. Qoidalar

- **Pul:** ilova pulni hisoblamaydi — barcha summalar serverdan keladi (`*Som` maydonlar). Hisob mantig'i faqat serverda.
- **Joylashuv:** kuryerdan joylashuv faqat «Ishdaman» holatida va ruxsat bilan so'raladi. Mijozga kuzatuv xaritasi — keyingi bosqich.
- **Tillar:** uz (lotin), uzc (kirill), ru — tumanlar nomi serverdan uchala tilda keladi.

## 6. API qisqacha

| Usul | Yo'l | Izoh |
|---|---|---|
| POST | `/courier/auth/login` | telefon + PIN → token |
| GET | `/courier/me` | profil, balans, chegara, tumanlar ro'yxati |
| PATCH | `/courier/me` | `workDistricts`, `isOnline`, `vehicle` |
| GET | `/courier/pool` | quti (o'z tumanlari, manzilsiz) |
| GET | `/courier/orders/active` | olingan buyurtmalar (to'liq) |
| GET | `/courier/orders/history` | tarix va daromad |
| GET | `/courier/ledger` | balans harakatlari |
| POST | `/courier/orders/:id/claim` | olish (kim ulgursa) |
| POST | `/courier/orders/:id/release` | qaytarish (olishdan oldin) |
| POST | `/courier/orders/:id/pickup` | taomni oldim → yo'lda |
| POST | `/courier/orders/:id/deliver` | topshirdim → yakunlandi |
| GET | `/districts` | tumanlar (ochiq) |

Barcha so'rovlarda `Authorization: Bearer <token>` (login va `/districts` dan tashqari).
