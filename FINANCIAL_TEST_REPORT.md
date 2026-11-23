# LokmaGo — Moliyaviy test hisoboti

**Branch:** `fix/finance-phase2` (server) · **Taqqoslash:** `main` @ `63585f7`
**Sana:** 2026-11-22/23 · Har bir natija shu muhitda **haqiqatan ishga tushirilgan**. Ishga tushirilmaganlari §6 da alohida.

---

## 1. Muhit

| | |
|---|---|
| Node.js | v22.23.4 |
| MongoDB | 7.0.34 (conda-forge) — **local, production emas** |
| Replica set | `rs0`, bitta tugun, `127.0.0.1:27017` (tranzaksiya qo'llab-quvvatlanadi) |
| Standalone | `127.0.0.1:27018` (tranzaksiyasiz yo'lni tekshirish uchun) |
| Production MongoDB | ❌ **tekshirilmagan** — kirish yo'q (`FINANCIAL_AUDIT_REPORT.md` §2) |

---

## 2. Yangi moliyaviy testlar

Har bir test **eski kodga (`main`) qarshi ham** ishga tushirildi: yangi kodda o'tishi va eski kodda yiqilishi nuqson haqiqiy ekanini va test uni ushlashini ko'rsatadi.

| Test | Tekshiruv | Branch | `main` (eski kod) | Nimani isbotlaydi |
|---|---|---|---|---|
| `finance-core.test.mjs` (bazasiz) | 140 | ✅ 140/140 | ❌ 13 xato | TZ 16 A/B/C/D/F formulalari; menyu = to'lov; 400 tasodifiy holatda qaytarish yig'indisi aniq; F-04, F-05, F-22 |
| `finance-concurrency.test.mjs` — replica set + tranzaksiya | 53 | ✅ 53/53 | ❌ 12 xato, keyin yiqildi | Quyida §3 |
| ↳ replica set, `FINANCE_TX=off` | 53 | ✅ 53/53 | — | Tranzaksiyasiz yo'lda ham takror yo'q |
| ↳ **standalone** mongod | 53 | ✅ 53/53 | — | Production standalone bo'lsa ham idempotentlik saqlanadi |
| `order-server-pricing.test.mjs` (haqiqiy controller) | 37 | ✅ 37/37 | ❌ 7 xato, keyin yiqildi | F-00, F-00b — quyida §4 |
| `paynet-ledger.test.mjs` | 14 | ✅ 14/14 | ❌ 8 xato | F-06, F-07 |

**`main` da qayd etilgan raqamlar (eski kod):**
- 25 ta parallel settle → **25 ta** komissiya va 25 ta restoran ulushi;
- 4 jarayon × 6 → **11 tasi** hisob-kitob qildi;
- naqd buyurtmada **6 ta** `payment_in`;
- restoran balansi 135 000, jurnal bo'yicha 1 350 000 (**−1 215 000 so'm** yo'qolgan yangilanish);
- 30%lik qisman qaytarish 12 marta yuborildi → **12 tasining hammasi** o'tdi;
- F-00: minimal summa chetlab o'tildi, yetkazish 0, chegirma = taomning **butun narxi (68 000)**.

---

## 3. Concurrency ssenariylari (`finance-concurrency`, 3 rejim × 53 tekshiruv)

| # | Ssenariy | Natija (uchala rejimda) |
|---|---|---|
| S1 | Bir karta buyurtmasi — 25 ta parallel `settleOrder` | 1 ta hisob-kitob, 1 ta komissiya, 1 ta ulush, balans bir marta, `SETTLED` |
| S2 | Naqd buyurtma — 25 ta parallel | Komissiya qarzi bir marta, `payment_in` bir marta |
| S3 | **4 ta alohida Node jarayoni × 6** parallel bitta buyurtmaga | 24 tadan faqat 1 tasi; jurnalda aynan 2 ta yozuv |
| S4 | Shu o'zgarishdan **oldin** settle qilingan buyurtma (eski yozuv) | Qayta yozilmaydi, `legacy-ledger` deb belgilanadi |
| S5 | Bir restoran: 30 buyurtma settle + 12 ta parallel payout | Balans = Σulush − Σpayout; **balans = jurnal**; payout soni mos |
| S6 | Bir xil `idempotencyKey` × 15; balansdan katta payout | 1 ta to'lov, 14 tasi `alreadyExisted`; katta payout FAILED, balans o'zgarmadi |
| S7 | 12 ta parallel 30%lik qaytarish, keyin 8 ta parallel to'liq qaytarish | 3 tasi o'tdi (90%), qoldiq **bir marta**; jami = mijoz to'lagani (aniq); Σ restaurant_due = 0, Σ komissiya = 0 |
| S8 | Yetkazishdan oldin bekor — 10 ta parallel to'liq qaytarish | 1 ta refund, manfiy komissiya yo'q, restoran balansiga tegilmadi |
| S9 | LokmaGo kuryeri buyurtmasini qaytarish | Jurnalga yozildi (eski kodda `null`), restoran ulushi teskari |
| S10 | `payment_in` × 20; `recordSuccess` × 10 (bir xil tranzaksiya) | 1 ta `payment_in`, 1 ta SUCCESS, buyurtma bir marta `pending` |
| S11 | Barcha test restoranlari | `Restaurant.balance` = jurnaldan hisoblangan balans; takroriy `postingKey` yo'q |

---

## 4. F-00 — buyurtma summasi serverda (`order-server-pricing`, 37 tekshiruv)

| # | Soxta so'rov | Kutilgan (server) | Natija |
|---|---|---|---|
| P1 | Halol savat (ustama 10% + haq 5%, variant, qo'shimcha, majburiy) | subtotal = menyu 78 200, baza 68 000, `feeRounding=lines`, jami butun so'm, rekonsiliatsiya | ✅ |
| P2 | Real 3 450, `subtotal` 999 999 | 400 `MIN_ORDER` | ✅ (eski: qabul qilindi) |
| P3 | Real 78 200, `subtotal` 999 999 (bepul chegara 200 000) | Yetkazish 24 200 (bepul emas) | ✅ (eski: 0) |
| P4 | Olib ketish 10%, `subtotal` 999 999 | Chegirma 7 820 (10% × 78 200), restoran ulushi bor | ✅ (eski: 68 000) |
| P5 | Aksiya 10%, `subtotal` 999 999 | Chegirma 7 820 | ✅ (eski: 68 000) |
| P6/P7 | `unitPrice` 1, variant narxi 1, qo'shimcha 1, noma'lum "Oltin" (−50 000), majburiy Non yuborilmagan | Baza 62 000 (55 000 + 5 000 + Non 2 000), nom bazadan, noma'lum tanlov e'tiborsiz, Non majburan qo'shildi | ✅ |
| P8 | Miqdor 0, −1, 1,5, "2" | 400; katta miqdor (20) serverda hisoblanadi | ✅ |
| P9 | Bazada yo'q `dishId`, `dishId`'siz pozitsiya | 400 `DISH_UNAVAILABLE` | ✅ |
| P10 | Boshqa restoran taomi | 400 | ✅ |
| P11 | Mijoz `deliveryFee: 0`, `serviceFee: 50000`, `total: 1` | E'tiborsiz: yetkazish serverdan, xizmat haqi 0, jami halol buyurtma bilan bir xil | ✅ |
| P12 | Pozitsiyada `category` | Saqlanmaydi (kategoriya aksiyasini soxtalashtirib bo'lmaydi) | ✅ |

---

## 5. To'liq to'plam: `main` va branch (barcha test fayllari, local MongoDB bilan)

| | `main` | branch |
|---|---|---|
| Fayllar | 81 (+3 yangi fayl yo'q) | 85 |
| ✅ o'tdi | 74 | **79** |
| ❌ yiqildi | 7 | **6** |

**Mavjud fayllar bo'yicha yagona farq:** `tz-finance` — `main` da ❌ (eskirgan tekshiruv, T-01), branch'da ✅.

**Ikkalasida bir xil yiqiladigan 6 ta test** — moliyaga aloqasi yo'q yoki muhit sababli:

| Test | Sabab |
|---|---|
| `coords-chain` | `../lokma-courier` repo kerak (bu sessiyada yo'q) |
| `courier-app` | Redis talab qiladi — Redis ishga tushirildi, lekin test keshga ulanmadi (sozlama) |
| `db-backup` | Zaxira vaqti va guruh xabari, muhitga bog'liq |
| `market-catalog-category` | Do'kon kategoriyalari |
| `order-socket` | "customerOrderView qo'riqchisi" |
| `pickup-bot` | Bot tugmalari |

**Tebranuvchan test — `notify-settings`.** U bir xil `dailyNumber` bilan buyurtmalar kiritadi, Mongoose esa unique indeksni fonda quradi. Natija: `main` da 6 dan 1 marta, branch'da 6 dan 1 marta yiqiladi — test o'zining muammosi. Yakuniy yugurishda o'tdi.

### O'zgartirilgan mavjud testlar (sababi bilan)

| Test | O'zgarish | Sabab |
|---|---|---|
| `tz-finance` | `alreadyExisted` ham qabul qilinadi | Test kod qaytarmaydigan `duplicated` maydonini kutardi (`main` da ham yiqilardi) |
| `gift-bonus` [10] | Soxta modellar yangi settle chaqiruvlariga (claim, `insertMany`, `$inc`) moslandi. **Tekshiruvlar o'zgarmagan.** | Eski soxtalashtirish `findById → save()` ni taqlid qilardi |
| `order-create-gifts`, `order-device-check` | Pozitsiyaga `dishId` va soxta `Dish` qo'shildi (narx = mijoz yuborgani) | Testlar `dishId`'siz pozitsiyaga tayangan — aynan F-00b teshigi |
| `finance-core` | `recordRefund` soxtalashtirishiga `Order` (CAS) qo'shildi | Yangi rezerv mexanizmi |

### Natijalar jadvali

| Test fayli | `main` | branch |
|---|---|---|
| `_ferret-shim.mjs` | ✅ o‘tdi | ✅ o‘tdi |
| `address-update.test.mjs` | ✅ o‘tdi | ✅ o‘tdi |
| `admin-order-delivery.test.mjs` | ✅ o‘tdi | ✅ o‘tdi |
| `admin-order-monitor.test.mjs` | ✅ o‘tdi | ✅ o‘tdi |
| `agreement-chain.test.mjs` | ✅ o‘tdi | ✅ o‘tdi |
| `apple-auth.test.mjs` | ✅ o‘tdi | ✅ o‘tdi |
| `banner-district.test.mjs` | ✅ o‘tdi | ✅ o‘tdi |
| `boot.test.mjs` | ✅ o‘tdi | ✅ o‘tdi |
| `bot-broadcast.test.mjs` | ✅ o‘tdi | ✅ o‘tdi |
| `bot-menu.test.mjs` | ✅ o‘tdi | ✅ o‘tdi |
| `cash-payment.test.mjs` | ✅ o‘tdi | ✅ o‘tdi |
| `catalog-cache.test.mjs` | ✅ o‘tdi | ✅ o‘tdi |
| `catalog-counts.test.mjs` | ✅ o‘tdi | ✅ o‘tdi |
| `catalog-db-import.test.mjs` | ✅ o‘tdi | ✅ o‘tdi |
| `catalog-paging.test.mjs` | ✅ o‘tdi | ✅ o‘tdi |
| `catalogcategories-grok-shape.test.mjs` | ✅ o‘tdi | ✅ o‘tdi |
| `commission-source.test.mjs` | ✅ o‘tdi | ✅ o‘tdi |
| `coords-chain.test.mjs` | ❌ yiqildi | ❌ yiqildi |
| `cors-origins.test.mjs` | ✅ o‘tdi | ✅ o‘tdi |
| `courier-app-pool.test.mjs` | ✅ o‘tdi | ✅ o‘tdi |
| `courier-app.test.mjs` | ❌ yiqildi | ❌ yiqildi |
| `courier-auth.test.mjs` | ✅ o‘tdi | ✅ o‘tdi |
| `courier-flow.test.mjs` | ✅ o‘tdi | ✅ o‘tdi |
| `courier-pool.test.mjs` | ✅ o‘tdi | ✅ o‘tdi |
| `courier-track.test.mjs` | ✅ o‘tdi | ✅ o‘tdi |
| `customer-ask.test.mjs` | ✅ o‘tdi | ✅ o‘tdi |
| `customer-incidents.test.mjs` | ✅ o‘tdi | ✅ o‘tdi |
| `db-backup-resilience.test.mjs` | ✅ o‘tdi | ✅ o‘tdi |
| `db-backup.test.mjs` | ❌ yiqildi | ❌ yiqildi |
| `delivery-baseprice.test.mjs` | ✅ o‘tdi | ✅ o‘tdi |
| `delivery-party.test.mjs` | ✅ o‘tdi | ✅ o‘tdi |
| `delivery-pricing.test.mjs` | ✅ o‘tdi | ✅ o‘tdi |
| `delivery-road-distance.test.mjs` | ✅ o‘tdi | ✅ o‘tdi |
| `demo-account.test.mjs` | ✅ o‘tdi | ✅ o‘tdi |
| `device-check.test.mjs` | ✅ o‘tdi | ✅ o‘tdi |
| `device-platform.test.mjs` | ✅ o‘tdi | ✅ o‘tdi |
| `dish-realtime.test.mjs` | ✅ o‘tdi | ✅ o‘tdi |
| `dish-variants.test.mjs` | ✅ o‘tdi | ✅ o‘tdi |
| `district-resolver.test.mjs` | ✅ o‘tdi | ✅ o‘tdi |
| `fair-feed.test.mjs` | ✅ o‘tdi | ✅ o‘tdi |
| `finance-accountant.test.mjs` | ✅ o‘tdi | ✅ o‘tdi |
| `finance-concurrency.test.mjs` | — yo‘q | ✅ o‘tdi |
| `finance-core.test.mjs` | — yo‘q | ✅ o‘tdi |
| `finance-flow.test.mjs` | ✅ o‘tdi | ✅ o‘tdi |
| `finance.test.mjs` | ✅ o‘tdi | ✅ o‘tdi |
| `gift-bonus.test.mjs` | ✅ o‘tdi | ✅ o‘tdi |
| `group-restaurant.test.mjs` | ✅ o‘tdi | ✅ o‘tdi |
| `incident-group.test.mjs` | ✅ o‘tdi | ✅ o‘tdi |
| `incident-post-mode.test.mjs` | ✅ o‘tdi | ✅ o‘tdi |
| `mandatory-addons.test.mjs` | ✅ o‘tdi | ✅ o‘tdi |
| `market-catalog-category.test.mjs` | ❌ yiqildi | ❌ yiqildi |
| `market-category-registry.test.mjs` | ✅ o‘tdi | ✅ o‘tdi |
| `mobile-push.test.mjs` | ✅ o‘tdi | ✅ o‘tdi |
| `morning-checklist.test.mjs` | ✅ o‘tdi | ✅ o‘tdi |
| `notify-settings.test.mjs` | ✅ o‘tdi | ✅ o‘tdi |
| `order-contact-links.test.mjs` | ✅ o‘tdi | ✅ o‘tdi |
| `order-create-gifts.test.mjs` | ✅ o‘tdi | ✅ o‘tdi |
| `order-customer-price.test.mjs` | ✅ o‘tdi | ✅ o‘tdi |
| `order-device-check.test.mjs` | ✅ o‘tdi | ✅ o‘tdi |
| `order-server-pricing.test.mjs` | — yo‘q | ✅ o‘tdi |
| `order-socket.test.mjs` | ❌ yiqildi | ❌ yiqildi |
| `order-track.test.mjs` | ✅ o‘tdi | ✅ o‘tdi |
| `panel-catalog.test.mjs` | ✅ o‘tdi | ✅ o‘tdi |
| `panel-order-courier.test.mjs` | ✅ o‘tdi | ✅ o‘tdi |
| `paynet-amount.test.mjs` | ✅ o‘tdi | ✅ o‘tdi |
| `paynet-ledger.test.mjs` | — yo‘q | ✅ o‘tdi |
| `pickup-bot.test.mjs` | ❌ yiqildi | ❌ yiqildi |
| `promo-modals.test.mjs` | ✅ o‘tdi | ✅ o‘tdi |
| `refund.test.mjs` | ✅ o‘tdi | ✅ o‘tdi |
| `restaurant-app.test.mjs` | ✅ o‘tdi | ✅ o‘tdi |
| `restaurant-contact.test.mjs` | ✅ o‘tdi | ✅ o‘tdi |
| `restaurant-pins.test.mjs` | ✅ o‘tdi | ✅ o‘tdi |
| `restaurant-reminders.test.mjs` | ✅ o‘tdi | ✅ o‘tdi |
| `revenue.test.mjs` | ✅ o‘tdi | ✅ o‘tdi |
| `store-menu.test.mjs` | ✅ o‘tdi | ✅ o‘tdi |
| `support-chat.test.mjs` | ✅ o‘tdi | ✅ o‘tdi |
| `support-delivery.test.mjs` | ✅ o‘tdi | ✅ o‘tdi |
| `support-group-thread.test.mjs` | ✅ o‘tdi | ✅ o‘tdi |
| `support-group.test.mjs` | ✅ o‘tdi | ✅ o‘tdi |
| `tg-link-login.test.mjs` | ✅ o‘tdi | ✅ o‘tdi |
| `tz-finance.test.mjs` | ❌ yiqildi | ✅ o‘tdi |
| `video-broadcast.test.mjs` | ✅ o‘tdi | ✅ o‘tdi |
| `video-dimensions.test.mjs` | ✅ o‘tdi | ✅ o‘tdi |
| `webhook-guard.test.mjs` | ✅ o‘tdi | ✅ o‘tdi |
| `wedding-owner-proxy.test.mjs` | ✅ o‘tdi | ✅ o‘tdi |
---

## 6. Ishga tushirilMAGAN yoki qamrab olinmagan

| # | Nima | Nega | Ta'siri |
|---|---|---|---|
| N-1 | **Production MongoDB turi** (`hello`) | Kirish yo'q | Tranzaksiya production'da ishlaydimi — noma'lum (log ko'rsatadi) |
| N-2 | **`npm run finance:audit` production'da** | Kirish yo'q | Mavjud zarar (takroriy settle, balans farqi) noma'lum. Skript faqat test bazasida sinaldi (9 turdagi buzilish topildi) |
| N-3 | Ko'p tugunli replica set, `w:majority`, failover | Muhit | Concurrency testlari bitta tugunda |
| N-4 | Click, Paynet, Payme **sandbox** bilan haqiqiy to'lov | Tarmoq va hisob yo'q | Webhook'lar soxta so'rov bilan sinaldi |
| N-5 | Payout + **promo qarzi yoqilgan** holat (F-11) | Test sozlamasi | Tartib kodda tuzatilgan, alohida test yo'q |
| N-6 | LokmaGo kuryeri yetkazgandan keyin qaytarishda kuryer jurnali | Biznes qoidasi aniq emas (R-9) | — |
| N-7 | `cardPayment.js` (F-17) | O'zgartirilmagan (ruxsat kerak) | — |
| N-8 | Shartnoma almashtirish poygasi (F-14) | Tuzatilmagan | — |
| N-9 | Mijoz ilovasi va admin paneli (UI) end-to-end | Server o'zgarishi — client payload'i o'zgarmagan | Admin: faqat build ✅ |
| N-10 | `coords-chain`, `courier-app`, `db-backup`, `market-catalog-category`, `order-socket`, `pickup-bot` | `main` da ham yiqiladi | Moliyaga aloqasi yo'q |

---

## 7. Qayta ishga tushirish

```bash
# MongoDB replica set (local)
mongod --replSet rs0 --port 27017 --dbpath ./data/rs0 --fork --logpath ./rs0.log
#   so'ng bir marta: replSetInitiate { _id:'rs0', members:[{_id:0, host:'127.0.0.1:27017'}] }

npm run test:finance-core            # bazasiz
npm run test:finance-concurrency     # replica set + tranzaksiya
FINANCE_TX=off npm run test:finance-concurrency
MONGO_URI=mongodb://127.0.0.1:27018 npm run test:finance-concurrency   # standalone
npm run test:server-pricing
npm run test:paynet-ledger
npm run finance:audit -- --json      # FAQAT O'QIYDI
```
