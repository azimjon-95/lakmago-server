# LokmaGo — Moliyaviy yadro auditi (yakuniy)

**Sana:** 2026-11-22/23
**Repo:** `lakmago-server` (`main` @ `63585f7` bilan taqqoslandi), `lakmago-admin`
**Tuzatishlar:** `fix/finance-phase2` branch'ida — **`main`'ga qo'shilmagan, production'ga chiqarilmagan.**
Tuzatishlar tafsiloti: `FINANCIAL_FIX_REPORT.md`. Testlar: `FINANCIAL_TEST_REPORT.md`.

---

## 0. Xulosa

| | |
|---|---|
| Reestrdagi yozuvlar | **28 ta**: F-00, F-00b, F-01 … F-25, T-01 |
| Kritik / yuqori (🔴/🟠) | 10 ta |
| ✅ tuzatildi va eski kodga qarshi test bilan isbotlandi | 15 ta |
| ✅* tuzatildi, test bor, eski kod bilan solishtirilmagan | 2 ta (F-11, F-21) |
| 🟡 qisman tuzatildi | 3 ta (F-03, F-12, F-16) |
| ⏳ tuzatilmagan (qaror, ruxsat yoki keyingi bosqich kerak) | 6 ta (F-13, F-14, F-17, F-18, F-20, F-23) |
| ℹ️ ma'lumot uchun (nuqson emas) | 2 ta (F-24, F-25) |
| Production MongoDB turi | **ANIQLANMAGAN** — §2 ga qarang (buyruq sizda) |

**Eng xavfli uchta nuqson** eski kodga qarshi haqiqiy MongoDB'da qayta ishlab chiqarildi:

1. **F-00 — mijoz `subtotal` i.** Haqiqiy `orderController.create` orqali tekshirildi:
   - 3 450 so'mlik buyurtma 50 000 minimal summa bilan qabul qilindi;
   - yetkazish narxi 0 bo'lib qoldi;
   - olib ketish va aksiya chegirmasi taomning **butun narxiga** (68 000) teng chiqdi, ya'ni restoran ulushi 0.
2. **F-01 — balans `save()`.** Bir restoranning 20 ta buyurtmasi parallel hisob-kitob qilinganda balans **1 215 000 so'm kam** chiqdi: jurnalda 1 350 000, balansda 135 000.
3. **F-02 — takroriy hisob-kitob.**
   - Bitta buyurtmaga 25 ta parallel `settleOrder` chaqiruvidan **25 ta** komissiya va 25 ta restoran ulushi yozildi.
   - 4 ta alohida jarayondan kelgan 24 ta chaqiruvdan **11 tasi** o'tdi.

---

## 1. Ko'rib chiqilgan fayllar

**Server:**

| Guruh | Fayllar |
|---|---|
| Hisob | `services/orderFinance.js`, `customerPricing.js`, `pricingEngine.js`, `paymentSplit.js`, `refund.js`, `deliveryParty.js` |
| Buxgalteriya | `services/billing.js`: `settleOrder`, `recordPayment`, `finalizeCashPayment`, `recordRefund`, `recordLegacyRefund`, `recordPayout`, `resolveCommission` |
| Kuryer | `services/courierPool.js` (`settleCourier`) |
| To'lovlar | `services/paymentRecord.js` (`recordSuccess`, `releaseOrderToKitchen`, `recordFailure`), `promoBilling.js` (`deductFromSettlement`, `markDebtPaid`), `click.js`, `paynetUws.js`, `promotions.js` (`applyPromotion`, `appliesTo`), `priceVerification.js` |
| Buyurtma oqimi | `orderFlow.js` (`changeOrderStatus`, `runSideEffects`), `deliveryEngine.js` (`quoteDelivery`), `orderPricing.js` (`checkMinOrder`) |
| Controller'lar | `controllers/misc.js` (`orderController.create`, 340–1010 qatorlar), `cardPayment.js`, `agreements.js`, `billing.js` (`overview`) |
| Modellar | `Ledger`, `Payment`, `Payout`, `Transaction`, `CommissionAgreement`, `Restaurant`, `Order`, `Settings`, `Notification`, `Promotion`, `Dish` |
| Boshqa | `config/index.js`, `routes/*` (moliya marshrutlari) |

**Admin:** `pages/admin/BillingPage.jsx` (qaysi API'larni chaqiradi), `components/NotificationCenter.jsx`.

**Client** (faqat solishtirish uchun): `store/cart.js`, `store/orders.js`, `pages/Cart/CartPage.jsx` — mijoz `subtotal` ni qanday yuborishi.

---

## 2. Production MongoDB turi — ANIQLANMAGAN

Production bazasi VPS'da. Unga kirish uchun SSH kalitlari va production secret'lari kerak, men ularga tegmadim. Shuning uchun haqiqiy turni bu sessiyada tekshira olmadim.

**Buni yashirmaslik uchun arxitektura taxminga emas, server tekshiruviga tayanadi:**

- Server ishga tushganda bazaga `hello` buyrug'ini yuboradi (`services/financeTx.js` → `detectTopology`) va log'ga yozadi:
  ```
  [finance-tx] baza: replicaset|standalone · tranzaksiya: HA|YO'Q
  ```
- **Replica set yoki sharded bo'lsa:** settle, refund va payout `session.withTransaction` ichida bajariladi.
- **Standalone bo'lsa:** tranzaksiyasiz ishlaydi.
- **Idempotentlik ikkala holatda ham bir xil:** unique indeks va atomik `findOneAndUpdate`. Tranzaksiya faqat ko'p hujjatli atomiklikni qo'shadi.

**VPS'da tekshirish buyrug'i** (faqat o'qiydi, hech narsa yozmaydi):
```
cd ~/lakmago-server && node --input-type=module -e "import 'dotenv/config'; import m from 'mongoose'; await m.connect(process.env.MONGO_URI); const h = await m.connection.db.admin().command({hello:1}); console.log(h.setName ? 'REPLICA SET: '+h.setName : (h.msg==='isdbgrid' ? 'SHARDED' : 'STANDALONE')); process.exit(0)"
```

Agar standalone chiqsa, ikki yo'l bor (sizning qaroringiz, §6 Q9):
- **(a)** VPS'dagi mongod'ni bitta tugunli replica set'ga o'tkazish (`replSet` + `rs.initiate`). Bu infratuzilma o'zgarishi, restart talab qiladi va **sizning tasdig'ingizsiz qilinmaydi**.
- **(b)** Tranzaksiyasiz ishlash. Takrorlanish baribir imkonsiz, lekin jarayon o'rtada uzilsa (masalan, server o'chsa) settlement `SETTLING` holatida qolib ketishi mumkin. `npm run finance:audit` buni ko'rsatadi.

---

## 3. Haqiqiy hisob yo'llari (kod izohidan emas, chaqiruvlardan)

```
Menyu narxi     catalog.js → customerPricing.applyPricing           (har qism alohida, so'mda floor)
Buyurtma        misc.js orderController.create
                  → priceVerification.verifyItemPrices               (baza narxi, variant, majburiy qo'shimcha)
                  → [F-00 dan keyin] customerPricing.itemsCustomerBreakdown  (server subtotal)
                  → checkMinOrder / quoteDelivery / pickup chegirma / applyPromotion
                  → orderFinance.computeOrderFinance → deliveryParty.applyDeliveryParty → reconcile
To'lov (Click)  click.clickComplete / cardPayment → paymentRecord.recordSuccess → billing.recordPayment
To'lov (Paynet) paynetUws.PerformTransaction → recordSuccess (+ [F-07] recordPayment)
Yetkazildi      orderFlow.runSideEffects / deliveryCheck / courierDispatch → billing.settleOrder
                  → finalizeCashPayment → courierPool.settleCourier → [yadro] commission, restaurant_due, bonus, balans
Bekor           orderFlow (cancelled + isPaid) → billing.recordRefund → refund.computeRefund
Paynet bekor    paynetUws.CancelTransaction → [F-06 dan keyin] changeOrderStatus → recordRefund
Payout          settlement/billing controller → billing.recordPayout
O'lik kod       pricingEngine.js (chaqiruvchisi yo'q)
```

**Ledger ishora qoidasi (hozirgi).** Turlar har xil nuqtai nazardan yozilgan:

| type | Ishora | Nuqtai nazar |
|---|---|---|
| `payment_in`, `refund` | + / − | LokmaGo kassasi |
| `commission` | + / − | LokmaGo daromadi |
| `restaurant_due` | karta: +ulush, naqd: −komissiya | restoran balansi |
| `payout` | − | restoran balansi |
| `bonus_compensation` | + | restoran balansi |
| promo `adjustment` | + | aslida restoran balansini **kamaytiradi** (F-12) |

---

## 4. Nuqsonlar reestri

Holat belgilari:
- ✅ — branch'da tuzatildi va test eski kodda yiqilib, yangisida o'tishi bilan isbotlandi;
- ✅* — tuzatildi, test bor, lekin eski kodga qarshi solishtirilmagan;
- 🟡 — qisman tuzatildi;
- ⏳ — tuzatilmagan.

| ID | Daraja | Fayl → funksiya | Sabab | Holat |
|---|---|---|---|---|
| **F-00** | 🔴 Kritik | `controllers/misc.js` → `orderController.create` | Mijoz yuborgan `subtotal` (`z.number()`, tekshiruvsiz) minimal summa, bepul yetkazish chegarasi, olib ketish chegirmasi va foizli aksiya uchun ishlatilardi. Chegirma `computeOrderFinance` da taom summasigacha "qisqartirilardi" — taom tekinga tushardi. | ✅ `server-pricing` P2–P5 |
| **F-00b** | 🔴 Kritik | `services/priceVerification.js` → `verifyItemPrices` | Bazada topilmagan yoki `dishId`'siz pozitsiyada **mijoz narxi** qoldirilardi. `misc.js` dagi mavjudlik tekshiruvi topilmagan ID'ni ushlamasdi. | ✅ `server-pricing` P9 |
| **F-01** | 🔴 Kritik | `services/billing.js` → `settleOrder`, `recordLegacyRefund` | `findById → balance = eski + ulush → save()`. Oraliqdagi `$inc` (payout yoki boshqa settle) o'chib ketadi. Payout ayirmasi o'chsa, o'sha pul **qayta to'lanishi** mumkin. | ✅ concurrency S5 (eski: −1 215 000) |
| **F-02** | 🔴 Kritik | `billing.js` → `settleOrder` | Takrordan himoya faqat `findOne(restaurant_due) → create`. "Yetkazildi" 3 yo'ldan keladi, unique indeks yo'q. | ✅ S1–S3 (eski: 25/25, 11/24) |
| **F-03** | 🔴 Yuqori | `billing.js` (hammasi) | Ko'p hujjatli yozuvlar (ledger + balans + holat) atomik emas, loyihada tranzaksiya yo'q. | 🟡 replica set'da tranzaksiya (avtomatik aniqlanadi); standalone'da atomik emas — §2 |
| **F-04** | 🔴 Yuqori | `services/refund.js` → `computeRefund`; `billing.recordRefund` | Qaytarishda yetkazuvchi hisobga olinmasdi. LokmaGo kuryeri buyurtmasida tekshiruv yiqilib, `recordRefund` **jimgina `null`** qaytarardi: mijozga pul qaytadi, jurnalda esa yo'q. | ✅ finance-core, S9 |
| **F-05** | 🟠 Yuqori | `billing.js` → `recordRefund` | Komissiya teskari yozuvi shartsiz edi. Yetkazishdan oldin bekor qilinganda musbatsiz manfiy komissiya paydo bo'lardi va hisobotdagi komissiya kamayib ko'rinardi. | ✅ finance-core, S8 |
| **F-06** | 🟠 Yuqori | `services/paynetUws.js` → `handleCancelTransaction` | `order.status='cancelled'; save()` — `changeOrderStatus` chetlab o'tilardi. Restoranga xabar ketmasdi (oshxona tayyorlashda davom etishi mumkin edi), refund yozilmasdi, Payment SUCCESS bo'lib qolardi. | ✅ `paynet-ledger` [3] |
| **F-07** | 🟠 O'rta-yuqori | `paynetUws.js` → `handlePerformTransaction` | Paynet to'lovi `payment_in` ga yozilmasdi, admin "tushum"i kam ko'rinardi. | ✅ `paynet-ledger` [1] |
| **F-08** | 🟡 O'rta | `customerPricing` va `orderFinance.computeOrderFinance` | Menyu har qismni so'mda `floor` qiladi, buyurtma esa jamini tiyinda `round` qiladi. Mijoz menyuda ko'rganidan 3–7 so'm ko'p to'lardi. | ✅ finance-core, P1 |
| **F-09** | 🟡 O'rta | `paynetUws.js` (GetInformation ↔ Perform) | Kasr so'mli jami (10 849,65): GetInformation `round` qiladi, Perform esa aniq tiyinni kutadi, natijada `WRONG_AMOUNT`. | ✅ jami endi butun so'm (F-08 bilan) |
| **F-10** | 🟡 O'rta | `billing.recordRefund`, `refund.computeRefund` | `find → create` poygasi parallel so'rovlarda ortiqcha qaytarishga olib kelardi. Qisman qaytarishlar yig'indisi asldan ±1–2 tiyin farq qilardi. | ✅ S7 (eski: 12/12 o'tdi), 400 tasodifiy holat |
| **F-11** | 🟡 O'rta | `billing.recordPayout` | Promo qarzi balans tekshiruvidan **oldin** ushlanardi: payout FAILED bo'lsa ham promo "to'langan" bo'lib qolardi. Ledger yozuvi balansdan alohida so'rov edi. | ✅* tartib tuzatildi; promo yoqilgan holat alohida testlanmagan |
| **F-12** | 🟡 O'rta | `models/Ledger.js` | Ishora qoidasi aralash, summalar so'mda kasr `Number`, `postingKey`/`currency`/aktyor yo'q. | 🟡 `postingKey` (partial unique) qo'shildi; ishora va tiyin — ⏳ (migratsiya rejasi kerak) |
| **F-13** | 🟡 O'rta | `Restaurant.balance`, `controllers/billing.overview` | Bitta `balance` naqd qarz va karta qarzini netlaydi. `cash_debt_recovery` yozuvlari yo'q. Overview `Σ balance` ni restoranlar bo'yicha qo'shadi. | ⏳ Q4 qarori kerak |
| **F-14** | 🟡 O'rta | `controllers/agreements.js` → `upsert` | `updateMany(ARCHIVED)` va `create` alohida bajariladi: orada **0% oyna** paydo bo'ladi, parallel so'rovlar 2 ta ACTIVE shartnoma yaratishi mumkin. Versiya va tarix yo'q. | ⏳ keyingi bosqich (avval ACTIVE dublikatlar hisoboti) |
| **F-15** | 🟡 O'rta | `misc.js` → `warnNoAgreement` | Shartnomasiz restoran: 0% va faqat log. | ✅ qaror: 0% + admin `finance` bildirishnomasi (demo'da yo'q) |
| **F-16** | 🟡 O'rta | `models/Payment.js`, `paymentRecord.recordSuccess` | Bir buyurtmaga bir nechta SUCCESS (har xil `providerTransactionId` bilan) bo'lishi mumkin; `providerTransactionId` unique emas. | 🟡 bir xil tranzaksiya takrori — S10 da 1 ta; unique indeks production dublikat hisobotidan keyin (`finance:audit`) |
| **F-17** | 🟢 Past-o'rta | `controllers/cardPayment.js` → `pay`, `recheck` | `tx.state=2` `recordSuccess` dan **oldin** saqlanadi (click.js da allaqachon tuzatilgan naqsh). `recheck` status'ni shartsiz `pending` qiladi. | ⏳ CLAUDE.md 2-qoida fayli — ruxsat kerak |
| **F-18** | 🟢 Past | `services/pricingEngine.js` | O'lik ikkinchi dvigatel. | ⏳ zararsiz, o'chirish taklifi |
| **F-19** | 🟢 Past | `billing.recordPayment` | `findOne → create` tufayli `payment_in` takrorlanardi. | ✅ S2 (eski: 6 ta), S10 |
| **F-20** | 🟢 Past | `click.js` → `verifySign` | Imzo `===` bilan solishtiriladi, timing-safe emas. | ⏳ |
| **F-21** | 🟢 Past | `courierPool.settleCourier` | `insertMany` qisman yiqilsa, qayta urinishda yozuv takrorlanardi. | ✅* postingKey |
| **F-22** | 🟠 Yuqori | `billing.recordRefund` | Naqd + LokmaGo kuryeri buyurtmasida `isCash` `settleOrder` dagidan farq qilardi, teskari yozuv noto'g'ri yo'nalishda tushardi. | ✅ finance-core |
| **F-23** | 🟡 O'rta (qaror) | `promotions.applyPromotion` → `appliesTo` | `scope: 'category'` aksiyasi `item.category` ga qaraydi, lekin zod uni olib tashlaydi. Kategoriya aksiyalari **hech qachon qo'llanmaydi**. Mijoz soxtalashtira olmaydi (P12). | ⏳ Q8 — yoqilsa narxlar o'zgaradi |
| **F-24** | 🟢 Past | `paymentSplit.computeSplit` (legacy) | Eski buyurtmalarda komissiya yetkazish bilan birga hisoblangan. | ℹ️ ataylab (tarix), o'zgartirilmaydi |
| **F-25** | ℹ️ | TZ 6-misol | 1,5% × 120 000 = 1 800 (TZ'da 1 725 yozilgan). Kod jami summadan hisoblaydi. | ℹ️ Q5 |
| **T-01** | 🟢 | `tests/tz-finance.test.mjs` | Eskirgan tekshiruv: `duplicated` kutadi, kod esa `alreadyExisted` qaytaradi. `main` da ham yiqiladi. | ✅ test tuzatildi |

---

## 5. Bir vaqtdagi so'rovlar — ssenariylar tahlili (3-band)

### 5.1 Settlement (hisob-kitob)

| Ssenariy | Eski kod | Yangi kod | Dalil |
|---|---|---|---|
| Kuryer "topshirdim" + mijoz "oldim" + avto-yakunlash bitta buyurtma uchun | Har biri `findOne` → yo'q → yozadi. N ta komissiya, N ta ulush, balans N marta oshadi | `Order.financeSettlement` claim'i faqat bittasida o'tadi, qolganlari `null`. Yozuvlarda unique `postingKey` | S1: 25→1, S3: jarayonlar aro 24→1 |
| Bir restoranning ko'p buyurtmasi bir vaqtda | `save()` eski balans ustidan yozadi, ulushlar yo'qoladi | Faqat `$inc` | S5 |
| Settle va payout bir vaqtda | `save()` payout'ning `$inc −X` ini o'chiradi, balans X ga oshadi va X qayta to'lanishi mumkin | Ikkalasi ham `$inc`, natija = Σulush − Σpayout | S5: balans = jurnal |
| Shu o'zgarishdan **oldin** settle qilingan buyurtma | — | Claim'dan keyin `restaurant_due` topiladi → `legacy-ledger` belgisi, qayta yozilmaydi | S4 |
| Jarayon yozuvlar o'rtasida uzilsa | Ledger bor, balans yo'q (yoki aksincha); qayta urinish `already` bilan to'siladi | Replica set: tranzaksiya to'liq bekor bo'ladi. Standalone: `SETTLING` qoladi, `finance:audit` ko'rsatadi | ⚠ standalone holati — §2 |

### 5.2 Payout

| Ssenariy | Eski kod | Yangi kod | Dalil |
|---|---|---|---|
| Bir xil `idempotencyKey` bilan ikki marta bosish | `Payout.create` unique — to'g'ri edi | O'zgarmagan | S6: 15→1 |
| Turli kalitlar, balans yetarli emas | `balance ≥ amount` atomik filtri — to'g'ri edi | O'zgarmagan | S5, S6 |
| Payout va settle bir vaqtda | F-01: settle payout'ni o'chirib yuborardi | `$inc` | S5 |
| Balans yetmaganda promo qarzi | Avval ushlanib, keyin rad etilardi (promo "to'langan" qolardi) | Avval balans claim, keyin promo | F-11 |
| Balans olindi, keyin jarayon uzildi | Balans kamaygan, `payout` yozuvi yo'q | Payout `PROCESSING` + `balanceClaimed` holatida qoladi, `finance:audit` ko'rsatadi. Ikki marta to'lanmaydi | kod, audit |
| Tashqi bank o'tkazmasi | Qo'lda (admin "to'landi" deydi) | O'zgarmagan: tashqi o'tkazma Mongo tranzaksiyasiga kirmaydi | — |

### 5.3 Refund

| Ssenariy | Eski kod | Yangi kod | Dalil |
|---|---|---|---|
| 12 ta parallel 30%lik qisman qaytarish | Hammasi `find` dan "qolgan 100%" ni ko'radi, **12 tasi ham** o'tadi (360%) | `financeRefund.seq` CAS rezervi: 3 tasi o'tadi (90%), qolganlari rad | S7 |
| Parallel to'liq qaytarish (bekor qilish + provayder) | Bir nechta refund yozuvi | Bittasi | S7, S8 |
| Ketma-ket qisman qaytarishlar yig'indisi | ±1–2 tiyin farq | Teleskopik hisob, yig'indi aniq | 400 tasodifiy holat |
| Hisob-kitobdan oldin bekor | Manfiy komissiya yoziladi | Yozilmaydi | S8 |
| Payout'dan keyin qaytarish | Restoran balansi manfiyga ketadi (keyingi tushumdan yopiladi) | O'zgarmagan, balans `$inc` bilan to'g'ri | S7 (balans asl holatiga qaytdi) |

### 5.4 To'lov yozuvlari

| Ssenariy | Eski | Yangi | Dalil |
|---|---|---|---|
| Bir xil webhook takrori (bir tranzaksiya) | `Payment` `idempotencyKey` upsert — to'g'ri edi | O'zgarmagan | S10 |
| `payment_in` parallel | Takrorlanardi | `postingKey` | S2, S10 |
| Ikki **xil** tranzaksiya bilan ikki marta to'lov | Ikkita SUCCESS | O'zgarmagan (F-16) — `finance:audit` ko'rsatadi | ⏳ |

---

## 6. Egasi qarori kerak bo'lgan savollar

| # | Savol | Hozirgi holat |
|---|---|---|
| Q1 | Restoran ustamasi (`deliveryMarkupPercent`) komissiya bazasiga kirsinmi? | Kiradi (tanlov bo'lmadi, o'zgartirilmadi) |
| Q4 | Naqd qarzni yopish: karta settle'da avtomatik va alohida yozuv bilan (TZ 7), yoki hozirgidek bitta `balance` da? | Implitsit netlash |
| Q5 | Click haqi jami summadan (yetkazish bilan) va to'liq LokmaGo zimmasidami? | Ha |
| Q6 | Qaytarilgan karta to'lovida Click haqi kimniki? | Proporsional teskari |
| Q7 | Kuryer foizi standarti 10% (belgilanmagan restoran uchun) | 10% |
| **Q8** | **Kategoriya aksiyalari** (F-23) yoqilsinmi? Yoqilsa, restoranlar unutgan faol aksiyalar to'satdan qo'llana boshlaydi. | Hech qachon qo'llanmaydi |
| **Q9** | Production standalone chiqsa: replica set'ga o'tkazamizmi (restart kerak)? | — |
| **Q10** | `cardPayment.js` (F-17) ni tuzatishga ruxsat (CLAUDE.md 2-qoida fayli)? | Tegilmagan |

Javob berilgan: Q2 — 0% + admin signali. Q3 — menyu narxlari yig'indisi.

---

## 7. Orqaga moslik

- **Faqat qo'shimcha o'zgarishlar.** Yangi maydonlar: `Ledger.postingKey`, `Order.financeSettlement`, `Order.financeRefund`, `Order.finance.feeRounding`, Notification turi `finance`. Eski yozuvlar o'zgartirilmaydi.
- **Indeks:** `Ledger.postingKey` partial unique. Eski yozuvlarda bu maydon yo'q, shuning uchun indeks qurilishida to'qnashuv **bo'lmaydi**. Mongoose `autoIndex` uni server ishga tushganda quradi.
- **Eski settle qilingan buyurtmalar** `restaurant_due` yozuvi orqali taniladi (S4).
- **Eski qaytarishlar** jurnaldan o'qiladi, birinchi yangi qaytarishda rezerv holatiga o'tadi.
- **Buyurtma summasi:** ustama yoki mijoz haqi bor restoranlarda yangi buyurtma bir necha so'mga **kamayadi** (endi menyuda ko'rsatilgani olinadi). Halol mijoz savati o'zgarmaydi.
- **Bazada yo'q pozitsiya** endi 400 `DISH_UNAVAILABLE` qaytaradi. Mijoz ilovasi har doim `dishId` yuboradi, shuning uchun bu faqat soxta yoki o'chirilgan taom so'rovlariga ta'sir qiladi.
