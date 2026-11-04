# TZ: LokmaGo kuryer ilovasi (restoran ilovasi ichidagi «Kuryer» tomoni)

**Yagona ilova** (`lokmago-restaurant-android`: Android + iOS). Ochilganda **«Restoran boshqaruvi» / «Kuryer»** tanlanadi, keyin shu tomonning login/paroli.
Kuryer akkauntini **admin** yaratadi (`LokmaGo kuryerlari` sahifasi). Server: `controllers/courierApp.js`, `services/courierApp.js`, `services/courierPool.js`, `services/courierTrack.js`.
Tizim mantig'i: `docs/YETKAZISH-REJIMLARI.md`, API: `docs/COURIER-APP.md`.

## 1. Asosiy g'oya
- Restoran buyurtmani **qabul qilgach**, LokmaGo kuryeri yetkazadigan buyurtma **umumiy qutiga** tushadi.
- **Kim birinchi «Qabul qilish» bossa — o'sha oladi** (server atomik: ikkinchi kuryer «boshqa kuryer oldi» oladi).
- Kuryer ko'radi: o'z **ish tumanlaridagi** buyurtmalarni **va** o'ziga **biriktirilgan restoranlar**ning buyurtmalarini. Restoranga kuryerlar biriktirilgan bo'lsa (admin), uning buyurtmalarini **faqat shular** ko'radi va oladi (tumanidan qat'i nazar).
- Qutida **mijoz manzili va telefoni yo'q** — faqat restoran, tuman, taomlar, kuryer haqi, naqd summasi, masofa. To'liq ma'lumot qabul qilgach ochiladi.

## 2. Kuryerning kunlik ishi
1. **«Ishni boshladim»** → smena ochiladi, **joylashuv har 5 soniyada** serverga ketadi (smena ochiq turguncha).
2. Quti ro'yxati (5 s da yangilanadi + push). **«Qabul qilish»** → faol buyurtma.
3. **Restoranga boradi** → **«Taomni oldim»** (serverga joylashuv bilan; restorandan uzoq bo'lsa adminga belgilanadi).
4. **Mijozga olib boradi** → **«Topshirdim»** (mijoz manziliga yaqinligi tekshiriladi; naqd bo'lsa pul olinadi).
5. **«Ishni yakunladim»** — faqat faol buyurtma bo'lmaganda.

Ekranlarda ko'rinadi: bosqich («Restoranga boring va taomni oling» / «Taom qo'lingizda — mijozga olib boring»), **«Sizning haqingiz»** (kuryer ulushi, masalan 27 000), naqd bo'lsa **«Mijozdan olinadi: X»**, tekin yetkazishda «mijozga tekin».

## 3. Nazorat (admin ko'radi)
- **Jonli xarita** (`GET /admin/courier-accounts/live`): smenadagi kuryerlar, hozirgi joyi, signal (yashil / eskirgan >60 s / yo'q), **qaysi taomni qayerdan qayerga olib ketyapti** (bosqich, maqsadgacha masofa, olingan vaqt, naqd).
- **Kuryer yo'li** (`/admin/courier-accounts/:id/track`) — bazaga yozilgan nuqtalar (harakatda har ≥15 m, turganda har 60 s; 45 kun saqlanadi).
- **Buyurtma izi** (`/admin/orders/:id/courier-trace`): olish → taomni oldi → topshirdi, har biri kuryerning o'sha paytdagi joylashuvi va maqsadgacha masofa bilan.
- **Shubhali voqealar** (`/admin/courier-events`): «oldim» restorandan >250 m, «topshirdim» mijozdan >400 m, joylashuv yo'q/eskirgan. Standart holda **bloklanmaydi** (GPS xato berishi mumkin); `COURIER_ENFORCE_PROXIMITY=1` bo'lsa uzoqdan bosish rad etiladi.

## 4. Pul (kuryer ko'radigan)
- Naqd buyurtma: mijozdan **jami summa** olinadi → kuryer balansidan ayriladi (u pul LokmaGo'niki); kuryer ulushi balansiga qo'shiladi. Qo'lidagi LokmaGo puli chegaradan (standart 500 000) oshsa — yangi **naqd** buyurtma ololmaydi, avval topshiradi.
- Karta buyurtma: kuryerga faqat ulushi yoziladi.
- Naqdni topshirish va ulushni to'lash — **admin kassasi** (ilovada tugma yo'q).

## 5. Ilova API (`/api/courier-app/*`, kuryer JWT)
| Usul | Yo'l | Izoh |
|---|---|---|
| POST | `/login` | `{login, password}` → token |
| GET | `/me` | profil, tumanlar, smena, **hamyon** (balans, naqd chegarasi) |
| PATCH | `/me` | `{workDistricts}` — kuryer o'z tumanlarini o'zgartiradi (ilovada hali tugma yo'q) |
| GET | `/shift` · POST `/shift/start` · `/shift/end` | smena |
| POST | `/location` | har ~5 s `{lat,lng,accuracy?,speed?,heading?}`; 204 |
| GET | `/offers` | quti (o'z tumanlari + biriktirilgan restoranlar), masofa bo'yicha |
| POST | `/offers/:id/accept` | olish; xatolar: `RACE_LOST`, `ACTIVE_LIMIT`, `DEBT_LIMIT`, `OFFLINE`, `WRONG_DISTRICT`, `NOT_YOUR_RESTAURANT` |
| GET | `/active` | faol buyurtma: `stage`, `canPickup`, `canDeliver`, mijoz ma'lumoti, `deliveryFee` = kuryer haqi |
| POST | `/active/pickup` | **«Taomni oldim»** |
| POST | `/active/deliver` | **«Topshirdim»** |
| GET | `/history`, `/stats`, `/shifts` | tarix, hisobot (kuryer haqi), smenalar |
| POST/DELETE | `/devices`, `/devices/test` | push token |

Xato javoblari: `{ error, code, ...qo'shimcha }`. Soket: handshake `auth.token` → `courier:<id>`, `courier-district:<tuman>` xonalari (`pool:new`, `pool:taken`, `courier:order`).

## 6. Hali qilinmagan (keyingi bosqich)
- Ilovada **tuman tanlash** ekrani (API tayyor: `PATCH /me`, `GET /districts`); hozircha tumanni admin belgilaydi.
- Bir vaqtda **bir nechta** faol buyurtma (ilova hozircha bittasini ko'rsatadi; `maxActiveOrders` = 1).
- Ilovadan **hamyon** (balans) ko'rinishi (`GET /me` → `wallet` tayyor).
