# LokmaGo — Moliyaviy yadro auditi (1-bosqich)

**Sana:** 2026-11-22 · **Repo:** `lakmago-server` @ `63585f7`, `lakmago-admin` (main)
**Holat:** faqat audit. TZ 19-band talabiga ko'ra production kodga **hech qanday o'zgartirish kiritilmagan**.

---

## 0. Qisqa xulosa

1. **Hisob dvigateli (formulalar) to'g'ri.** `orderFinance.computeOrderFinance` TZ jadvalidagi 7 ta kelishuvning barchasida to'g'ri natija beradi. U butun tiyinda hisoblaydi, komissiyani yetkazishdan olmaydi, shlyuz haqini LokmaGo o'z ulushidan qoplaydi. Rekonsiliatsiya tenglamasi buyurtma yaratilishida majburiy: mos kelmasa buyurtma yaratilmaydi.
2. **Asosiy xavf formulada emas, yozish qatlamida.** `settleOrder`, `recordRefund`, `recordPayment` takrorlanishdan faqat `findOne → create` bilan himoyalangan: unique indeks yo'q, MongoDB tranzaksiyasi yo'q. `Restaurant.balance` esa `findById → save()` bilan yangilanadi. Natijada parallel so'rovlar **payout ayirmasini o'chirib yuborishi** mumkin, bu esa ikki marta pul to'lash xavfini tug'diradi (F-01).
3. **Qaytarish va bekor qilish yo'llarida 4 ta tasdiqlangan nuqson bor:** F-04, F-05, F-06, F-07. Ular hisobotdagi raqamlarni noto'g'ri qiladi, bittasi esa qaytarishni umuman yozmaydi.
4. **Ledger hozir "yagona haqiqat manbai" bo'la olmaydi.** Ishora (+/−) qoidasi yagona emas, summalar so'mda kasr son (float), posting kaliti yo'q, naqd qarz va karta qarzi bitta `balance` raqamida aralashgan.
5. **Muhit cheklovi:** sandbox'da MongoDB yo'q (`fastdl.mongodb.org` yopiq). Shuning uchun bazaga bog'liq 3 ta mavjud test va har qanday concurrency/tranzaksiya testi **bu yerda ishga tushirilmadi**. Production MongoDB replica set ekanligi ham noma'lum (§7).

---

## 1. Ko'rib chiqilgan fayllar

**Server:** `services/orderFinance.js`, `customerPricing.js`, `pricingEngine.js`, `paymentSplit.js`, `paymentRecord.js`, `billing.js` (settleOrder, recordPayment, finalizeCashPayment, recordRefund, recordLegacyRefund, recordPayout, resolveCommission), `refund.js`, `deliveryParty.js`, `courierPool.js` (settleCourier), `promoBilling.js` (deductFromSettlement, markDebtPaid), `click.js`, `paynetUws.js`, `orderFlow.js` (runSideEffects), `controllers/misc.js` (buyurtma yaratish: moliya bloki, 690–935 qatorlar), `controllers/cardPayment.js`, `controllers/agreements.js`, `controllers/billing.js` (overview), `routes/*` (moliya marshrutlari), `models/Ledger.js`, `Payment.js`, `Payout.js` (indekslar), `Transaction.js` (indekslar), `CommissionAgreement.js`, `Restaurant.js` (balance), `Settings.js`, `config/index.js` (split.*).

**Admin:** `pages/admin/BillingPage.jsx` (qaysi API'lar chaqirilishi), `RestaurantPayoutSection.jsx` (faqat nomi).

---

## 2. Mavjud arxitektura — haqiqiy chaqiruv yo'llari

Quyidagi yo'llar kod izohlaridan emas, `grep` qilingan haqiqiy chaqiruvlardan olingan.

### 2.1 Narx va moliyaviy snapshot

| Bosqich | Haqiqiy kod | Izoh |
|---|---|---|
| Menyuda narx ko'rsatish | `controllers/catalog.js` → `customerPricing.applyPricing` | Har bir taomga alohida, **so'mda, pastga yaxlitlab (floor)** |
| Buyurtma yaratish | `misc.js:763` → `computeOrderFinance` → `applyDeliveryParty` → `reconcile` | Butun savat summasidan, **tiyinda, yaqin songa yaxlitlab (round)** |
| Pozitsiya narxi (ko'rsatish) | `misc.js:828` → `itemCustomerUnitPrice` | Faqat ko'rsatish uchun, hisobga kirmaydi |
| `pricingEngine.js` | **chaqiruvchisi yo'q** | O'lik kod: ikkinchi dvigatel, `floor` ishlatadi |
| Shlyuz bo'linishi | `paymentRecord.recordSuccess` → `splitFromFinance` (v2) / `computeSplit` (legacy) | v2 snapshot'dan o'qiydi, qayta hisoblamaydi |
| Qaytarish | `refund.computeRefund` → `computeOrderFinance` (qaytarilayotgan qism uchun) | `applyDeliveryParty` **chaqirilmaydi** (F-04) |

Snapshot `Order.finance` da muzlatiladi: `model:'v2'`, `commissionAgreementId`, `agreementEffectiveFrom`. Eski buyurtmalar (`model` yo'q) `resolveCommission` orqali legacy yo'ldan o'tadi.

### 2.2 Pul harakati (Ledger yozuvlari)

```
Karta (Click):   webhook complete → recordSuccess (Payment upsert) → releaseOrderToKitchen
                 → recordPayment (Ledger payment_in)
Karta (Paynet):  PerformTransaction → recordSuccess            (payment_in YOZILMAYDI — F-07)
Naqd:            delivered → settleOrder → finalizeCashPayment → recordPayment('cash')
Yetkazildi:      orderFlow / deliveryCheck(avto) / courierDispatch → settleOrder
                 → commission (+), restaurant_due (karta: +ulush, naqd: −komissiya),
                   bonus_compensation (+) → restaurant.balance = ... → save()
LokmaGo kuryeri: settleOrder → settleCourier (atomik claim) → courier_cash / courier_earning
Bekor (to'langan): orderFlow cancelled+isPaid → recordRefund
Paynet bekor:    CancelTransaction → order.status='cancelled'; save()   (refund YO'Q — F-06)
Payout:          recordPayout → Payout.create (unique kalit) → deductFromSettlement (promo)
                 → Restaurant.findOneAndUpdate({balance ≥ amount}, $inc) → Ledger payout
```

### 2.3 Mavjud Ledger turlari va ishora (+/−)

| type | Ishora | Kimning nuqtai nazari |
|---|---|---|
| `payment_in` | + | LokmaGo kassasi (faqat Click va naqd) |
| `commission` | + / − (qaytarish) | LokmaGo daromadi |
| `restaurant_due` | karta: +ulush, naqd: −komissiya, qaytarish: teskari | Restoran balansi |
| `payout` | − | Restoran balansi |
| `refund` | − | LokmaGo kassasi |
| `bonus_compensation` | + | Restoran balansi |
| `adjustment` | promo qarzi uchun **+** (restoran balansini esa *kamaytiradi*) | Aralash — F-12 |
| `courier_*` | ± | Kuryer balansi |

---

## 3. To'g'ri ishlayotgan va saqlanishi kerak bo'lgan qismlar

Quyidagilar sinovdan o'tkazilgan yoki kodda aniq ko'rinadi.

- **Formulalar** (`fin-probe` skripti, §6): ovqat 100 000, yetkazish 15 000, Click 1.5% bilan:

  | R+C | Mijoz | Restoran (taom) | LokmaGo gross | Click | LokmaGo net | Rekons. |
  |---|---|---|---|---|---|---|
  | 5+0 | 115 000 | 95 000 | 5 000 | 1 725 | 3 275 | ✓ |
  | 0+5 | 120 000 | 100 000 | 5 000 | 1 800 | 3 200 | ✓ |
  | 5+5 | 120 000 | 95 000 | 10 000 | 1 800 | 8 200 | ✓ |
  | 10+0 | 115 000 | 90 000 | 10 000 | 1 725 | 8 275 | ✓ |
  | 6+2 | 117 000 | 94 000 | 8 000 | 1 755 | 6 245 | ✓ |
  | 3+7 | 122 000 | 97 000 | 10 000 | 1 830 | 8 170 | ✓ |
  | 0+0 | 115 000 | 100 000 | 0 | 1 725 | −1 725 | ✓ |

- **Yetkazish** komissiya bazasiga kirmaydi. Restoran kuryerida 100% restoranga, LokmaGo kuryerida esa kuryer va LokmaGo foizi o'rtasida bo'linadi (`deliveryParty.js`).
- **Naqd:** komissiya qarzi `lokmaGrossCommission` (mijoz haqi ham ichida), bu TZ 5.1 ga mos. Naqd buyurtmaga Click haqi yozilmaydi (2026-10 tuzatish).
- **Snapshot muzlatiladi.** Shartnoma o'zgarsa ham eski buyurtma o'z foizida qoladi. Legacy buyurtmalar alohida yo'ldan o'tadi va `financeModel:'legacy'` bilan belgilanadi.
- **"Standart 10%" olib tashlangan.** `assertLokmaPercent`, `Settings.commissionPercent` = 0. Shartnoma yo'q bo'lsa 0% qo'llanadi va ogohlantirish yoziladi (bu ham qaror talab qiladi — F-15).
- **Payout:** unique `idempotencyKey` bilan avval kalit band qilinadi, keyin atomik `$inc` va `balance ≥ amount` filtri.
- **Webhooklar:** Click md5 imzosi va summasi tekshiriladi. Paynet aniq tiyin summa va `TX_EXISTS` ni tekshiradi. `Transaction (provider, providerTransId)` unique. `releaseOrderToKitchen` faqat `awaiting_payment → pending` o'tishini atomik bajaradi (CLAUDE.md 1-qoida). `Payment` `idempotencyKey` bo'yicha upsert qilinadi.
- **`settleCourier`** — to'g'ri atomik claim namunasi (`findOneAndUpdate` + `settledAt: null`).
- **Ledger** hech qayerda o'chirilmaydi va tahrirlanmaydi (`grep` bilan tekshirildi).

---

## 4. Tasdiqlangan nuqsonlar

"Tasdiqlangan" deganda kod yo'li o'qilgan va iloji bo'lgan joyda skript bilan qayta ishlab chiqarilgan nuqson tushuniladi. Bazaga bog'liq poyga holatlari kod bo'yicha isbotlangan, lekin haqiqiy MongoDB'da ishga tushirilmagan (§7).

| ID | Daraja | Nuqson | Dalil |
|---|---|---|---|
| **F-01** | 🔴 Kritik | **`settleOrder` balansni o'qib-qayta-yozadi.** `restaurant = findById` qilinadi, ledger yozuvlari yaratiladi, keyin `restaurant.balance = stale + share; save()`. Shu oraliqda `recordPayout` `$inc: {balance: −X}` bajarsa, `save()` eski qiymat ustidan yozadi va **payout ayirmasi yo'qoladi**. Balans X ga oshib qoladi va admin X ni yana to'lay oladi. Bir restoranning ikki buyurtmasi bir vaqtda yakunlansa, bitta ulush yo'qoladi. `recordLegacyRefund` da ham xuddi shu naqsh bor. | `billing.js:530,554,583,592`; `776` |
| **F-02** | 🔴 Yuqori | **Takroriy hisob-kitobdan faqat `findOne → create` himoya qiladi.** "Yetkazildi" uchta mustaqil yo'ldan keladi: `orderFlow`, `deliveryCheck` avto-yakunlash, `courierDispatch`. Ular bir vaqtda kelsa `commission` va `restaurant_due` ikki marta yoziladi, balans ham ikki marta oshadi. Ledger'da unique kalit yo'q. | `billing.js:426` |
| **F-03** | 🔴 Yuqori | **Atomiklik yo'q.** `settleOrder` 2–4 ta ledger yozuvi va balansni alohida-alohida yozadi. Jarayon o'rtada yiqilsa, ledger va balans bir-biridan ajrab qoladi, qayta urinishni esa `already` tekshiruvi to'sib qo'yadi. Loyihada birorta `startSession`/`withTransaction` yo'q. | `grep` |
| **F-04** | 🔴 Yuqori | **LokmaGo kuryeri yetkazgan karta buyurtmasini to'liq qaytarish jurnalga yozilmaydi.** `computeRefund` yetkazuvchini hisobga olmaydi va yetkazishni restoran ulushiga qo'shadi (115 000 > asl 95 000). Natijada `validateRefund` yiqiladi va `recordRefund` faqat `console.error` bilan `null` qaytaradi: mijozga pul qaytadi, jurnalda esa hech narsa yo'q. Qisman qaytarishda kuryer ulushi ham teskari yozilmaydi. | probe: `lokmaFullRefund.validate.ok=false` |
| **F-05** | 🟠 Yuqori | **Yetkazishdan oldin bekor qilingan karta buyurtmasi.** `recordRefund` `restaurant_due` mavjudligini tekshiradi, lekin `commission` ning teskari yozuvini **shartsiz** yozadi. Musbat yozuvsiz manfiy komissiya paydo bo'ladi va hisobotdagi "komissiya" kamayib ko'rinadi. | `billing.js:723–733` |
| **F-06** | 🟠 Yuqori | **Paynet `CancelTransaction`** buyurtmani `order.status='cancelled'; save()` bilan bekor qiladi va `changeOrderStatus` ni chetlab o'tadi. Refund ledger yozuvi yo'q. `Payment` SUCCESS va `payoutStatus` PENDING bo'lib qoladi. **Restoranga xabar ketmaydi** va oshxona tayyorlashda davom etishi mumkin (CLAUDE.md 1-qoidaga yondosh xavf). | `paynetUws.js:~275` |
| **F-07** | 🟠 O'rta-yuqori | **Paynet to'lovlari `payment_in` ga yozilmaydi** (Click yozadi). Admin overview'dagi "tushum" Paynet bo'yicha kam ko'rinadi. | `grep recordPayment` |
| **F-08** | 🟡 O'rta | **Mijoz menyuda ko'rgan summa ≠ to'laydigan summa.** Menyu har pozitsiyani so'mda `floor` qiladi, buyurtma esa jamini tiyinda `round` qiladi. Probe'da bir savatda **+3,45 … +7,45 so'm** farq chiqdi (mijoz ko'proq to'laydi). Jami summa kasr son ham bo'ladi (`10 849,65`). | probe `display*`, `fractionalTotal` |
| **F-09** | 🟡 O'rta | **Kasr summa Paynet'ni buzadi.** `GetInformation` summani `Math.round(order.total)` bilan so'mda qaytaradi, `Perform` esa aniq `round(total×100)` tiyinni kutadi. Natijada `WRONG_AMOUNT` qaytadi va to'lov o'tmaydi. | `paynetUws.js:142,183` |
| **F-10** | 🟡 O'rta | **Qaytarish poygasi va yaxlitlash.** Avvalgi qaytarishlar `find` qilinadi, keyin `create` bo'ladi, shuning uchun parallel qaytarishlarda ortiqcha qaytarish mumkin. Ketma-ket qisman qaytarishlarda oxirgi qism qoldiqni olmaydi: probe'da restoran ulushi asldan **1 tiyin ortiq** teskari yozildi, komissiya esa 2 tiyin kam. | probe `cumulativeRefund` |
| **F-11** | 🟡 O'rta | **Payout: promo qarzi balans tekshiruvidan OLDIN ushlanadi.** `markDebtPaid` va ledger `adjustment` darhol yoziladi. Balans yetmasa payout FAILED bo'ladi, lekin promo qarz "to'langan" bo'lib qoladi. Bundan tashqari balansdan `amount` ayiriladi, `payout` yozuviga esa `amount − deducted` tushadi. | `billing.js:887–925`, `promoBilling.js:196` |
| **F-12** | 🟡 O'rta | **Ledger tuzilishi.** Ishora qoidasi yagona emas (§2.3). Summalar so'mda kasr `Number` ko'rinishida. `postingKey`/unique yo'q, `currency` yo'q, tizim yozuvlarida aktyor yo'q. Restoran balansini ledger'dan qayta qurish uchun turga xos qoidalar kerak (masalan, promo `adjustment +` aslida restoranni kamaytiradi). | `Ledger.js` |
| **F-13** | 🟡 O'rta | **Bitta `balance` naqd qarz (receivable) va karta qarzini (payable) aralashtiradi.** TZ 7 talab qilgan alohida `cash_debt_recovery` yozuvlari yo'q: qarz yopilishi implitsit. Admin overview `Σ balance` ni barcha restoranlar bo'yicha qo'shadi, bu musbat va manfiylarni bir raqamga netlaydi (TZ 12.1 taqiqlaydi). | `billing.controller overview:135` |
| **F-14** | 🟡 O'rta | **Shartnomani almashtirish atomik emas.** Avval `updateMany(ARCHIVED)`, keyin `create`. Orada **0% oyna** paydo bo'ladi. Ikki parallel so'rov ikkita ACTIVE shartnoma yaratishi mumkin (partial unique indeks yo'q). Versiya, o'zgartirish tarixi va kelajak sanasi yo'q. `createdBy` `ref:'User'`. | `agreements.js upsert` |
| **F-15** | 🟡 O'rta (qaror) | **Shartnomasiz restoran:** buyurtma 0% komissiya bilan yaratiladi, ogohlantirish soatiga bir marta log'ga yoziladi. Uydirma foiz emas, lekin **jim daromad yo'qotish**. | `misc.js:750` |
| **F-16** | 🟡 O'rta | **`Payment`: bir buyurtmaga bir nechta SUCCESS bo'lishi mumkin.** Idempotency kaliti tranzaksiya ID'ni ham o'z ichiga oladi, shuning uchun ikki xil ID — ikki xil yozuv. `providerTransactionId` unique emas (`Transaction` da unique). `Payment.amount` provayder summasidan emas, snapshot'dan yoziladi (summa oldinroq tekshirilgani uchun xavf past). | `Payment.js`, `paymentRecord.js:73` |
| **F-17** | 🟢 Past-o'rta | **`cardPayment.js` (token orqali to'lov).** `tx.state=2` `recordSuccess` dan OLDIN saqlanadi — `click.js` da allaqachon tuzatilgan naqsh. `recheck` status'ni shartsiz `pending` qiladi. CLAUDE.md 2-qoida faylida, tegish uchun tasdiq kerak. | `cardPayment.js:160,240` |
| **F-18** | 🟢 Past | `pricingEngine.js` — o'lik ikkinchi dvigatel. Legacy `computeSplit` komissiyani yetkazish bilan birga hisoblaydi (faqat tarix uchun, ataylab). | — |
| **F-19** | 🟢 Past | `recordPayment` — `findOne → create`, ya'ni `payment_in` ikki marta yozilishi mumkin. | `billing.js:337` |
| **F-20** | 🟢 Past | Click imzosi `===` bilan solishtiriladi, timing-safe emas. | `click.js:60` |
| **F-21** | 🟢 Past | `settleCourier` `insertMany` qisman yiqilsa, qayta urinishda birinchi yozuv takrorlanadi. | `courierPool.js:420` |

---

## 5. Biznes qoidasi noaniqliklari — egasi qarori kerak

TZ "noaniq bo'lsa so'ra, taxmin qilma" deydi. Quyidagi savollar 2-bosqichdan oldin hal bo'lishi kerak.

| # | Savol | Hozirgi xatti-harakat | Ta'sir |
|---|---|---|---|
| Q1 | **Komissiya bazasi.** Restoranning o'z "yetkazish ustamasi" (`deliveryMarkupPercent`, masalan +10%) komissiya bazasiga kiradimi? | **Kiradi:** 100 000 + 10% ustama → komissiya 110 000 dan, ya'ni 5 500. TZ "faqat food base" deydi. | Ustamali har bir restoranning komissiyasi |
| Q2 | **Shartnomasiz restoran.** Buyurtma bloklansinmi yoki 0% bilan qabul qilinsinmi? | 0% va log | Daromad yo'qotish vs buyurtma to'xtashi |
| Q3 | **Yaxlitlash.** Qaysi narx asosiy: menyuda ko'rsatilgan pozitsiya narxlari yig'indisi (butun so'm) yoki savat bo'yicha hisob? Taklif: **pozitsiya narxi yig'indisi, butun so'mda** (F-08 va F-09 ikkalasini yopadi). | Savat bo'yicha, tiyinda | Mijoz narxi, Paynet |
| Q4 | **Naqd qarzni yopish vaqti.** Karta buyurtmasi hisob-kitob qilinganda avtomatik (TZ 7) yoki payout paytida? | Implitsit: bitta `balance` da netlanadi | Hisobot va audit izi |
| Q5 | **Click haqi bazasi.** Haq mijoz to'lagan jami summadan (yetkazish va mijoz haqi bilan) olinadimi va to'liq LokmaGo zimmasidami? TZ 6-misolida 1 725 yozilgan, lekin jami 120 000 bo'lsa 1,5% — 1 800. | Jamidan, LokmaGo qoplaydi | LokmaGo net daromadi |
| Q6 | **Qaytarilgan karta to'lovida Click haqi** kimning zimmasida (Click qaytaradimi)? | Qaytarish qismi uchun proporsional teskari yoziladi | LokmaGo net |
| Q7 | **Kuryer foizi standarti 10%** (`Settings.courier.commissionPercent`, restoranga belgilanmagan bo'lsa). Qabul qilinadimi? | 10% | "Jim standart" taqiqiga zid bo'lishi mumkin |

---

## 6. Qanday tekshirildi

- `scratchpad/fin-probe.mjs` — sof funksiyalar ustida: TZ jadvali, menyu va to'lov farqi, LokmaGo kuryeri qaytarishi, kumulyativ qaytarish, ustama bazasi, kasr summa. Natijalar §3 va §4 da keltirilgan.
- Mavjud testlar (shu commit'da ishga tushirildi):

  | Test | Natija |
  |---|---|
  | `finance.test.mjs` | ✓ o'tdi |
  | `refund.test.mjs` | ✓ o'tdi |
  | `revenue.test.mjs` | ✓ o'tdi |
  | `agreement-chain.test.mjs` | ✓ o'tdi |
  | `delivery-party.test.mjs` | ✓ 11/11 |
  | `courier-pool.test.mjs` | ✓ 20/20 |
  | `finance-flow`, `tz-finance`, `finance-accountant` | ⛔ **ishga tushmadi** — `ECONNREFUSED 127.0.0.1:27017` (MongoDB yo'q) |

  Mavjud testlar F-04 va F-05 ni ushlamaydi: ular LokmaGo kuryeri va "hisob-kitobdan oldin bekor" holatlarini qamramaydi.

---

## 7. Muhit cheklovlari (yashirilmaydi)

- **MongoDB tranzaksiyasi** faqat replica set yoki sharded cluster'da ishlaydi. Production (VPS, pm2) qaysi turdaligi noma'lum: standalone `mongod` bo'lsa `withTransaction` xato beradi.
  - **Agar replica set bo'lsa:** settle, refund va payout uchun `session.withTransaction` va transient xatoda qayta urinish.
  - **Agar standalone bo'lsa** (yoki o'tish davrida): bitta hujjat ustida atomik claim (`Order.financeState`, `settleCourier` kabi), har bir yozuvga **unique `postingKey`**, balansni faqat `$inc` bilan yangilash va yarim qolgan yozuvlarni claim'dan yakunlaydigan **recovery worker**. Bu haqiqiy atomiklik emas, lekin idempotent va yakunlanadigan oqim beradi. Hujjatlarda ham shunday deb yoziladi.
- **Sandbox'da MongoDB binari yuklanmaydi** (`fastdl.mongodb.org` → ulanib bo'lmadi). Integratsiya va concurrency testlari uchun quyidagilardan biri kerak:
  - staging MongoDB URI (replica set);
  - testlarni sizning Mac yoki VPS staging'ingizda ishga tushirish;
  - `fastdl.mongodb.org` ni allowlist'ga qo'shish.

---

## 8. Taklif etilayotgan o'zgarishlar (2–8 bosqichlar)

Bu bosqichlar Q1–Q7 javoblari va tasdiq olingandan keyin bajariladi. Ikkinchi dvigatel yaratilmaydi, mavjud maydon nomlari saqlanadi.

| Bosqich | O'zgarish | Yopadigan nuqson |
|---|---|---|
| 2 · Dvigatel | `computeOrderFinance` yagona bo'lib qoladi. Pozitsiya narxi bilan bir xil yaxlitlash (Q3); qaytarishda oxirgi qism qoldiqni oladi; `computeRefund` → `applyDeliveryParty` bilan kuryer ulushi teskari. `pricingEngine.js` o'chiriladi yoki "deprecated" deb belgilanadi. Formula testlari TZ 16-A/B. | F-04, F-08, F-09, F-10, F-18 |
| 3 · Ledger va settle | Ledger'ga **qo'shiladigan** maydonlar (eski yozuvlar o'zgarmaydi): `postingKey` (unique, sparse), `amountTiyin` (Int), `currency`, `account` (`restaurant_payable` \| `restaurant_receivable` \| `lokma_revenue` \| `provider_fee` \| `courier_payable`), `paymentId`, `settlementId`, `actor`, `reason`. Yangi turlar (`cash_commission`, `cash_debt_recovery`, `payment_provider_fee`, `refund_reversal`) enum'ga **qo'shiladi**. `settleOrder` atomik claim (`Order.financeState: PENDING → SETTLING → SETTLED`) bilan ishlaydi, balans faqat `$inc` bilan o'zgaradi; replica set bo'lsa tranzaksiya ichida. | F-01, F-02, F-03, F-12, F-19 |
| 4 · Naqd va karta | `Restaurant` ga ikkita proyeksiya: `payableTiyin` va `receivableTiyin` (`balance` moslik uchun saqlanadi). Karta settle'da qarzni yopish `cash_debt_recovery` yozuvlari bilan, ikkala tomonga havola qilib, faqat o'z restorani ichida va qisman ham bo'lishi mumkin (Q4). | F-13 |
| 5 · Qaytarish va payout | Qaytarish uchun atomik rezerv (`Order.refundedFoodBaseTiyin` `$inc`, chegara filtri bilan), komissiya teskari yozuvi faqat settle qilingan bo'lsa. Paynet bekor qilish `changeOrderStatus` orqali (restoranga xabar va refund). Paynet'ga `payment_in`. Payout'da promo qarz balans claim'idan KEYIN. `Payment` da `(orderId, status:SUCCESS)` monitoringi va `providerTransactionId` unique (dublikatlar hisobotidan keyin). | F-05, F-06, F-07, F-10, F-11, F-16 |
| 6 · Rekonsiliatsiya | `services/financialReconciliation.js` + `npm run finance:audit [--from --to --json]`. **Faqat o'qiydi.** TZ 13-banddagi 12 ta tekshiruv. Proyeksiyani qayta qurish: `finance:rebuild --dry-run` hisobot beradi, `--apply` faqat aniq tasdiq bilan. | TZ 13, 14, 17 |
| 7 · Admin hisobotlar | Overview'da 17 ta mustaqil ko'rsatkich (net raqam yo'q), restoran kartasi, provayder bo'yicha solishtirish (taxminiy / tasdiqlangan / mos / farqli), sana bazasi tanlovi, Asia/Tashkent vaqt zonasi, drill-down. | TZ 12 |
| 8 · Regressiya | Barcha moliya testlari va concurrency testlari (MongoDB kerak — §7), legacy buyurtmalar mosligi. | — |

**Migratsiya tamoyillari** (batafsil `FINANCIAL_MIGRATION_PLAN.md` da, 3-bosqichda yoziladi):
- Faqat qo'shiluvchi o'zgarishlar: yangi maydonlar ixtiyoriy, eski yozuvlar qayta yozilmaydi.
- Unique indeksdan oldin dublikatlar hisobotini chiqaradigan skript ishga tushiriladi. Dublikatlar o'chirilmaydi, faqat karantin bayrog'i qo'yiladi va tasdiqlangan tartibda hal qilinadi.
- `--apply` yoki indeks yaratish faqat sizning aniq tasdig'ingizdan keyin bajariladi.

---

## 9. Orqaga moslik xavflari

- `Ledger.amount` (so'm) restoran paneli va admin hisobotlarida ishlatiladi. Shuning uchun u o'zgarmaydi, yoniga `amountTiyin` qo'shiladi.
- `Restaurant.balance` ni panel (`/panel/billing/*`) va payout o'qiydi. Yangi proyeksiyalar qo'shilsa ham `balance` = `payable − receivable` bo'lib qoladi.
- Yangi enum qiymatlari eski kodga zarar qilmaydi (Mongoose faqat yozishda tekshiradi). Lekin eski hisobot agregatsiyalari yangi turlarni ko'rmaydi, shuning uchun hisobotlar bir vaqtda yangilanadi.
- `financeState` maydoni bo'lmagan eski buyurtmalar "settle qilingan" deb `restaurant_due` mavjudligi bo'yicha aniqlanadi (hozirgidek).

---

## 10. Keyingi qadam

1-bosqich yakunlandi. **2-bosqich Q1–Q7 javoblari va MongoDB test muhiti (§7) hal bo'lgach boshlanadi.** Production'ga, ENV'ga yoki ma'lumotlarga hech narsa yozilmagan.
