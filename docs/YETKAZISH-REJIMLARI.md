# Yetkazish rejimlari, tumanlar va LokmaGo kuryerlari (2026-11)

## 1. Uch rejim — har restoranga LokmaGo admini belgilaydi

| Rejim (`Restaurant.courierMode`) | Kim yetkazadi | Yetkazish puli |
|---|---|---|
| `own` (standart, hozirgidek) | restoranning o'z kuryeri | 100% restoranga |
| `lokma` | LokmaGo kuryeri — umumiy quti, kim ulgursa | kuryerga, LokmaGo foizini oladi |
| `both` | restoran **har buyurtmada** tanlaydi | tanloviga qarab |

- **Rejimni kim o'zgartiradi:** restoran rejimini o'zi o'zgartira olmaydi. Panelda faqat ko'radi (`GET /panel/courier-settings`).
- **'both' rejimidagi tanlov:** restoran buyurtma kartasida «O'zim yetkazaman» yoki «LokmaGo kuryeri»ni bosadi (`POST /panel/orders/:id/courier-party`). Tanlanmasa — o'zi yetkazadi deb hisoblanadi.
- **Tanlovni o'zgartirish:** LokmaGo kuryeri olgach o'zgartirib bo'lmaydi.

**Tekin yetkazish** (`lokmaFreeDelivery`, faqat `lokma` rejimida):
- mijozdan yetkazish puli **olinmaydi** (narx 0, client «Bepul» ko'rsatadi);
- kuryer ulushini LokmaGo o'z hisobidan to'laydi (`deliverySubsidy`) va bu holatda foiz olmaydi.
- `both`/`own` da tekin yoqib bo'lmaydi — aks holda restoran tekinga yetkazib qolardi.

**Rejim o'zgarishi** faqat **yangi** buyurtmalarga ta'sir qiladi. Har buyurtmaning puli yaratilgan paytdagi snapshot'da muzlatilgan.

## 2. Pul (`services/deliveryParty.js`, birlik — tiyin)

**LokmaGo foizi** — global `Settings.courier.commissionPercent` (standart 10%). Restoranga alohida foiz berish mumkin: `Restaurant.lokmaCourierPercent`, `null` bo'lsa global ishlaydi.

**Misol:** taom 100 000, yetkazish 30 000, LokmaGo foizi 10%, restoran komissiyasi 10%.

| | O'z kuryeri | LokmaGo kuryeri | LokmaGo, tekin |
|---|---|---|---|
| Mijoz to'laydi (xizmat haqisiz) | 130 000 | 130 000 | 100 000 |
| Restoranga | 90 000 + 30 000 | 90 000 | 90 000 |
| Kuryerga | — (restoran o'zi) | 27 000 | 27 000 (LokmaGo to'laydi) |
| LokmaGo yetkazishdan | 0 | +3 000 | −27 000 |

**Rekonsiliatsiya** har tiyingacha tekshiriladi (`orderFinance.reconcile`):
```
restaurantPayout + courierPayout + lokmaNetCommission + clickFeeAmount === totalCharged
```
Eski snapshot'larda `courierPayout` yo'q, ya'ni 0 — formula avvalgidek. Test: 3000 ta tasodifiy buyurtmada bironta tiyin yo'qolmaydi (`tests/delivery-party.test.mjs`).

### Kuryer balansi (Ledger, `courierId`)
Balans = kuryerga tegishli barcha `Ledger` yozuvlari yig'indisi:
- **musbat** — LokmaGo kuryerga qarzdor;
- **manfiy** — kuryer qo'lida LokmaGo puli bor.

Yozuv turlari:

| Yozuv | Qachon | Summa |
|---|---|---|
| `courier_cash` | naqd buyurtma yetkazildi | −jami (mijozdan olingan pul LokmaGo'niki) |
| `courier_earning` | har yetkazilgan buyurtma | +kuryer ulushi |
| `courier_handover` | kuryer naqdni topshirdi (moliya bo'limi yozadi) | + |
| `courier_payout` | LokmaGo kuryerga to'ladi (moliya bo'limi) | − |
| `courier_adjustment` | tuzatish, sabab majburiy | ± |

- **Yozish joyi:** yozuvlar `billing.settleOrder` ichidan yoziladi (`courierPool.settleCourier`). «Yetkazildi»ning barcha yo'llari — kuryer, mijoz «Oldim», avtomatik yakunlash — shu yerdan o'tadi.
- **Takrorlanmaslik:** atomik `lokmaCourier.settledAt` bayrog'i yozuv ikki marta tushmasligini ta'minlaydi. Yozuv xato bersa, bayroq qaytariladi.

### Restoran hisobi (LokmaGo kuryeri, naqd)
Restoran naqdni ko'rmagan. Unga taom ulushini LokmaGo to'laydi, shuning uchun restoran ledger'ida bu **karta buyurtmasidek** yoziladi (`restaurant_due +restaurantPayout`, `isCash: false`). Komissiya qarzi yozilmaydi.

### Naqd chegarasi
`Settings.courier.debtLimitSom` (standart 500 000), kuryerga alohida berish mumkin: `Courier.debtLimitSom`.

Naqd buyurtmani olishda tekshiriladi:
```
balans − yo'ldagi naqd − (shu buyurtma jami − kuryer ulushi) ≥ −chegara
```
- **Oshsa:** buyurtma olinmaydi (`409 DEBT_LIMIT`), kuryer avval naqdni topshiradi.
- **Chegara 0 bo'lsa:** oldindan to'ldirilgan balans talab qilinadi (depozit modeli).

## 3. Tumanlar (`constants/districts.js`)
- **Ro'yxat:** Namangan viloyati — Namangan shahri (Davlatobod, Yangi Namangan tumanlari bilan) va 11 tuman, jami 14 ta kalit. Manba — namstat.uz.
- **Kalitlar** bazada saqlanadi va **o'zgartirilmaydi**. Standart — `pop`.
- **Restoran:** `district`. Buyurtma yaratilganda `Order.district` ga muzlatiladi.
- **Kuryer:** `workDistricts` (bir nechta). Kuryer o'zi ilovada o'zgartira oladi.

## 4. Umumiy quti (`services/courierPool.js`)

**Qutiga kiradi:**
```
courierParty = 'lokma', kuryer yo'q, fulfillment = 'delivery', status ∈ {accepted, preparing, ready}, district ∈ kuryer tumanlari
```

**Olish (claim):**
- bitta atomik `findOneAndUpdate` — filtrda «kuryer hali yo'q» sharti bor;
- test: 5 kuryer bir oniyda bossa, faqat 1 tasi oladi;
- cheklovlar: «Ishdaman», bir vaqtdagi buyurtmalar (`maxActiveOrders`, standart 3), naqd chegarasi.

**Holatlar:** «Oldim» → `delivering`, «Topshirdim» → `delivered`. Ikkalasi `orderFlow.changeOrderStatus({ courierId })` orqali o'tadi, shuning uchun mijoz xabari, restoran boti, admin paneli va hisob-kitob bir joydan ishlaydi.
- Restoran LokmaGo buyurtmasini «Yo'lda» qila olmaydi — aks holda buyurtma qutidan chiqib, hech kim ololmay qolardi.
- Restoran LokmaGo buyurtmasiga o'z kuryeri havolasini yarata olmaydi (panel, bot va servisda to'silgan).

**Admin:** qutini ko'radi, qo'lda kuryerga beradi yoki qaytaradi (`/admin/courier-pool`, `/admin/orders/:id/courier-assign|release`).

## 5. Ruxsatlar

| Amal | Kim |
|---|---|
| Rejim, tekin yetkazish, restoran foizi (`PATCH /admin/restaurants/:id/courier-settings`) | **faqat bosh admin** |
| Global foiz, naqd chegarasi, bir vaqtdagi buyurtmalar (`/admin/courier-settings`) | **faqat bosh admin** |
| Restoran tumani (`PATCH /admin/restaurants/:id/district`) | admin + «restaurants» bo'limi |
| Kuryerlar: qo'shish, tuman, PIN, blok; quti | admin + «couriers» bo'limi |
| Kuryer kassasi (naqd topshirish, to'lov, tuzatish) | admin + «billing» bo'limi (buxgalter) |
| «both» rejimida buyurtma bo'yicha tanlov | restoran |

Ruxsatlar testda haqiqiy middleware zanjiri bilan tekshirilgan (`tests/courier-auth.test.mjs`).

### Kuryer kirishi
- Kuryer mobil ilovada **login va parol** bilan kiradi (`CourierAccount`, bcrypt; token boshqa kalit bilan imzolanadi).
- Token tarkibida `tokenVersion` bor: parol almashsa yoki kuryer bloklansa, eski sessiyalar **darhol** bekor bo'ladi.
- «Ishdaman» = ochiq **smena**; joylashuv har 5 s (Redis, ixtiyoriy) va bazaga siyraklashtirilib (trek).

### Restoranga kuryer biriktirish
`Restaurant.exclusiveCouriers` (admin: `PUT /admin/restaurants/:id/couriers`). Bo'sh emas bo'lsa — shu restoranning LokmaGo buyurtmalarini **faqat shu kuryerlar** ko'radi va oladi (tumanidan qat'i nazar); boshqa kuryerlarga yopiq (`NOT_YOUR_RESTAURANT`).

### Nazorat
Trek (`CourierTrackPoint`), voqealar (`CourierEvent`: oldi / taomni oldi / topshirdi + joylashuv + masofa tekshiruvi), jonli ko'rinish va buyurtma izi — `docs/KURYER-ILOVASI-TZ.md` 3-bo'lim.

## 6. Xavfsizlik tuzatishi: soket xonalari
- **Avval:** `join:admin` va `join:restaurant` hech qanday tekshiruvsiz ishlardi. Istalgan odam barcha buyurtmalar yangilanishini, mijoz ma'lumotlari bilan birga, eshita olardi.
- **Endi:** token talab qilinadi (`sockets/panelSocketAuth.js`). Admin panel tokenni handshake'da yuboradi (`lakmago-admin/src/lib/socket.js`).
- **Hali ochiq:** `join:user` va `track:order` (mijoz ilovasi) ham tekshiruvsiz. Xavf kamroq — ID'larni topish qiyin — lekin keyingi bosqichda token bilan yopilishi kerak.

## 7. Deploy tartibi (MUHIM)
1. **Server va admin panel BIRGA chiqariladi.** Yangi server soket xonasiga tokensiz qo'shmaydi. Eski admin panel token yubormaydi, shuning uchun uning «jonli» yangilanishlari to'xtaydi (sahifani yangilash ishlaydi). Admin panel deploy bo'lgach tiklanadi.
2. **Migratsiya** server ishga tushganda o'zi bajariladi va qayta ishlatish xavfsiz (`services/deliveryMigrations.js`):
   - barcha restoranlarga `district = pop`, `courierMode = own` yoziladi — pul oqimi **o'zgarmaydi**;
   - kuryerlarga `status` va `phoneKey` yoziladi.
3. **Birinchi sinov:** bitta restoranni `lokma` rejimiga o'tkazing, kuryer qo'shing (telefon + PIN + tuman) va kuryer ilovasi yoki API orqali to'liq oqimni sinang.
4. **Mijoz ilovasi:** o'zgarish kerak emas — yetkazish 0 so'm bo'lsa allaqachon «Bepul» ko'rsatiladi.

## 8. Ochiq savollar (biznes qarori kerak)
- **Mijoz rad etsa:** kuryer taomni olgach mijoz rad etsa, restoran ulushi to'lanadimi? Hozir faqat **yetkazilgan** buyurtma hisoblanadi (avvalgi qoida).
- **Kuryer maoshi:** hozir faqat har yetkazishdan ulush. Kunlik yoki minimal kafolat yo'q.
- **Push-bildirishnoma:** ilova yopiq bo'lganda kuryerga push yuborish — keyingi bosqich.

## 9. Testlar
```
npm run test:delivery-party       # pul taqsimoti, rekonsiliatsiya, tumanlar
npm run test:courier-pool         # quti, kim ulgursa (poyga), limitlar, naqd chegarasi, both, balans
npm run test:courier-auth         # PIN, token, soket xonalari, ruxsatlar
npm run test:courier-flow         # oldim/topshirdim, restoran cheklovlari
npm run test:panel-order-courier  # restoran ko'radigan kuryer ma'lumoti (ulush yashirin)
```
Baza kerak emas — `tests/helpers/fakeModel.mjs`. Admin: `npm run test:delivery-ui` (interfeys render).
