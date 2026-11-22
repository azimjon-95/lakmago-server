# LokmaGo — Moliyaviy tuzatishlar hisoboti

**Branch:** `lakmago-server` → `fix/finance-phase2`, `lakmago-admin` → `fix/finance-phase2`
**Holat:** ⛔ **`main`'ga qo'shilmagan, production'ga chiqarilmagan.** Qo'shish shartlari — §6.
Nuqsonlar reestri: `FINANCIAL_AUDIT_REPORT.md` §4. Testlar: `FINANCIAL_TEST_REPORT.md`.

---

## 1. Tamoyillar

- **Ikkinchi hisob dvigateli yo'q.** `orderFinance.computeOrderFinance` yagona bo'lib qoldi, faqat ixtiyoriy kirish parametrlari qo'shildi.
- **Biznes qoidalari o'zgarmagan,** egasi javob berganlaridan tashqari (Q2 — 0% + admin signali, Q3 — menyu yig'indisi). Komissiya bazasi (Q1) va kategoriya aksiyalari (Q8) ataylab o'zgartirilmagan.
- **Idempotentlik faqat oldindan tekshirishga tayanmaydi.** Uni unique indeks va atomik `findOneAndUpdate` (claim / CAS) kafolatlaydi.
- **Tranzaksiya arxitekturasi taxmin bilan tanlanmagan.** Server bazaga `hello` buyrug'ini yuborib, haqiqiy turini aniqlaydi.
- **Faqat qo'shiluvchi sxema o'zgarishlari.** Tarixiy yozuvlar o'zgartirilmaydi.
- **Yon ta'sirlar tranzaksiyadan tashqarida.** Socket, bonus va Telegram faqat muvaffaqiyatli commit'dan keyin bajariladi, shuning uchun tranzaksiya qayta urinilganda ikki marta ketmaydi.

---

## 2. O'zgarishlar (fayl bo'yicha)

### Yangi fayllar

| Fayl | Vazifa |
|---|---|
| `src/services/financeTx.js` | `detectTopology()` — haqiqiy `hello`. `runFinanceTx(fn)` — replica set yoki sharded bo'lsa `withTransaction` (drayver transient xatolarda qayta urinadi), aks holda tranzaksiyasiz. `FINANCE_TX=off/on` — majburlash. `isDuplicateKey()` — bulk yozuvda faqat **hamma** xato dublikat bo'lsa `true`. |
| `scripts/finance-audit.mjs` | `npm run finance:audit [-- --json --from= --to=]` — **faqat o'qiydi**. Topadi: baza turi, takroriy settle, balans va jurnal farqi, `payment_in` takrori, Payment dublikatlari, ortiqcha qaytarish, musbatsiz manfiy komissiya, `SETTLING`/`PROCESSING` qolib ketganlar, takroriy `postingKey`. |
| `tests/finance-core.test.mjs` | Bazasiz formula va xossa testlari (139) |
| `tests/finance-concurrency.test.mjs` | Haqiqiy MongoDB concurrency testlari (53), 3 rejimda |
| `tests/order-server-pricing.test.mjs` | F-00: haqiqiy `orderController.create` orqali soxta so'rovlar (37) |
| `tests/paynet-ledger.test.mjs` | Paynet to'lov jurnali va provayder bekor qilishi (14) |

### O'zgargan fayllar

| Fayl → funksiya | O'zgarish | Nuqson |
|---|---|---|
| `controllers/misc.js` → `orderController.create` | Narx tekshiruvidan keyin `o.subtotal` = server menyu yig'indisi (`itemsCustomerBreakdown`). Minimal summa, yetkazish, olib ketish chegirmasi va aksiya shundan hisoblanadi. Bazada yo'q pozitsiya → 400 `DISH_UNAVAILABLE`. Shartnoma bir marta olinadi. Snapshot'ga pozitsiya bo'laklari uzatiladi. Shartnomasiz restoranda admin signali (demo'dan tashqari). | F-00, F-00b, F-08, F-15 |
| `services/priceVerification.js` → `verifyItemPrices` | `unknown` ro'yxati qaytaradi (bazada yo'q yoki `dishId`'siz pozitsiyalar) | F-00b |
| `services/customerPricing.js` | `itemCustomerUnitBreakdown` va `itemsCustomerBreakdown` — menyu bilan **aynan bir xil** yaxlitlash. `itemCustomerUnitPrice` natijasi o'zgarmagan. | F-08 |
| `services/orderFinance.js` → `computeOrderFinance` | Ixtiyoriy `deliveryMarkupLinesTiyin` va `customerFeeLinesTiyin` (chegirmada proporsional, butun so'm, BigInt). Foizlar 0..100 dan tashqari bo'lsa xato beradi. `feeRounding` belgisi. Parametrlarsiz chaqirilsa natija avvalgidek. | F-08, F-09 |
| `services/refund.js` → `computeRefund` | Asl snapshot'dan teleskopik proporsiya. Yetkazish taqsimoti (restoran / kuryer / LokmaGo) to'liq teskari yoziladi. `validateRefund` `courierPayout` ni ham tekshiradi. | F-04, F-10 |
| `services/billing.js` → `settleOrder` | Yadro `settleOrderCore` ga ajratildi: `Order.financeSettlement` atomik claim, legacy tekshiruvi, yozuvlar `postingKey` bilan, balans faqat `$inc`, `SETTLED` belgisi. Hammasi `runFinanceTx` ichida. Formula va yozuvlar tarkibi o'zgarmagan. | F-01, F-02, F-03 |
| `billing.js` → `recordPayment` | Unique `postingKey: payment_in:<orderId>` | F-19 |
| `billing.js` → `recordRefund` / `recordLegacyRefund` | `financeRefund.seq` CAS rezervi (8 urinish). Yozuvlar `postingKey` bilan. Komissiya teskari yozuvi faqat settle qilingan buyurtmada. `isCash` `settleOrder` bilan bir xil. Balans `$inc` bilan. | F-01, F-05, F-10, F-22 |
| `billing.js` → `recordPayout` | Avval balans claim (tranzaksiya), keyin promo qarzi, keyin `payout` yozuvi (`postingKey`), `totalPaidOut` va SUCCESS birga (tranzaksiya) | F-01, F-11 |
| `services/courierPool.js` → `settleCourier` | `postingKey: courier:<orderId>:<type>`, `ordered:false`. Hamma xato dublikat bo'lsa — muvaffaqiyat. | F-21 |
| `services/paynetUws.js` | Perform → `recordPayment` (`payment_in`). Cancel → `changeOrderStatus` (restoranga xabar va refund); u rad etsa zaxira yo'l + `recordRefund`. Keyin `isPaid=false`, Payment → REFUNDED. | F-06, F-07 |
| `models/Ledger.js` | `postingKey` va `uniq_postingKey` partial unique indeksi | F-02, F-12 |
| `models/Order.js` | `financeSettlement {state, claimedAt, settledAt, mode}`, `financeRefund {seq, foodBaseTiyin, deliveryRefunded, totalSom, legacyFull}`, `finance.feeRounding` | F-02, F-10 |
| `models/Notification.js`, `services/notifications.js` | `finance` turi (faqat admin) | F-15 |
| `config/index.js` → `connectDB` | Ishga tushganda log: `[finance-tx] baza: … · tranzaksiya: …` | §2 |
| `tests/tz-finance.test.mjs` | Eskirgan tekshiruv: `alreadyExisted` ni qabul qiladi | T-01 |
| `package.json` | `test:finance-core`, `test:finance-concurrency`, `test:server-pricing`, `test:paynet-ledger`, `finance:audit`; `finance-core` `npm test` ga qo'shildi | — |
| **admin** `components/NotificationCenter.jsx` | `finance` turi: "Moliya" yorlig'i → `/billing` | F-15 |

---

## 3. Idempotentlik kafolatlari (4-band)

| Operatsiya | Baza darajasidagi kafolat | Atomik operatsiya |
|---|---|---|
| Settle | `Ledger.postingKey` unique (`settle:<id>:commission`, `:restaurant_due`, `:bonus_compensation`) | `Order.findOneAndUpdate({ 'financeSettlement.state': { $exists: false } })` claim; `Restaurant $inc` |
| Payment jurnali | `postingKey payment_in:<orderId>` | — |
| Payment yozuvi | `Payment.idempotencyKey` unique (avvaldan bor) | upsert `$setOnInsert` (avvaldan bor) |
| Refund | `postingKey refund:<id>:<seq>:*` | `Order.findOneAndUpdate({ 'financeRefund.seq': joriy })` CAS |
| Payout | `Payout.idempotencyKey` unique (avvaldan bor) + `postingKey payout:<payoutId>` | `Restaurant.findOneAndUpdate({ balance: { $gte } }, { $inc })` |
| Kuryer | `postingKey courier:<id>:<type>` | `lokmaCourier.settledAt` claim (avvaldan bor) |
| Paynet Perform | `Transaction (provider, providerTransId)` unique (avvaldan bor) | — |

---

## 4. Tuzatilmagan va qolgan xavflar

| # | Xavf | Nega qoldi | Keyingi qadam |
|---|---|---|---|
| R-1 | **Production MongoDB turi noma'lum.** Standalone bo'lsa settle/refund/payout ko'p hujjatli atomik emas. Takrorlanish baribir imkonsiz, lekin uzilishda `SETTLING` yoki `PROCESSING` qolib ketishi mumkin. | Production'ga kirish yo'q | VPS'da `hello` buyrug'i (Audit §2), keyin Q9 |
| R-2 | **Production'da allaqachon bo'lgan zarar** (takroriy settle, balans farqi, `payment_in` dublikatlari) tuzatilmagan | TZ: avtomatik tuzatish taqiqlangan | `npm run finance:audit` natijasi → ko'rib chiqilgan tuzatish rejasi |
| R-3 | F-13: naqd qarz va karta qarzi bitta `balance` da, `cash_debt_recovery` yo'q, overview netlaydi | Q4 qarori kerak | 4-bosqich |
| R-4 | F-14: shartnomani almashtirish atomik emas | Avval ACTIVE dublikatlar hisoboti kerak | `runFinanceTx` + partial unique (`restaurantId`, ACTIVE) |
| R-5 | F-16: bir buyurtmaga ikki xil tranzaksiya bilan ikki SUCCESS | Production dublikat hisoboti kerak | `finance:audit` → indeks |
| R-6 | F-17 `cardPayment.js` | CLAUDE.md 2-qoida — ruxsat kerak | Q10 |
| R-7 | F-23 kategoriya aksiyalari qo'llanmaydi | Q8 | — |
| R-8 | F-12: Ledger summalari so'mda kasr son, ishora qoidasi aralash | Katta migratsiya | `amountTiyin` + `account` maydonlari (rejada) |
| R-9 | LokmaGo kuryeri yetkazgandan **keyingi** qaytarishda kuryer jurnali (`courier_earning`) teskari yozilmaydi | Biznes qoidasi aniq emas: kuryer ishini bajargan | Qaror kerak |
| R-10 | Concurrency testlari **bitta tugunli** replica set'da. Ko'p tugunli klasterda `w:majority` kechikishi va failover sinalmagan. | Muhit | Staging klaster |
| R-11 | `coords-chain`, `courier-app`, `db-backup`, `market-catalog-category`, `order-socket`, `pickup-bot` testlari yiqiladi — `main` da ham aynan shunday | Moliyaga aloqasi yo'q, muhit yoki avvaldan bor | Test hisoboti §4 |

---

## 5. Joylashtirish (faqat tasdiqdan keyin)

1. Shartlar (§6) bajarilgan, PR ko'rib chiqilgan va **siz tasdiqlagansiz**.
2. **Oldindan, faqat o'qish:**
   - VPS'da `hello` buyrug'i (baza turi);
   - `npm run finance:audit -- --json > audit-before.json` (joriy holat, takroriy `postingKey` = 0 bo'lishi kerak).
3. `git pull` → `pm2 restart lakmago-server`.
4. Log'da quyidagilar chiqishi kerak:
   - `[finance-tx] baza: …`;
   - Mongoose `uniq_postingKey` indeksini quradi (eski yozuvlarda maydon yo'q, to'qnashuv bo'lmaydi).
5. **Joylashtirishdan keyin:**
   - 1 ta naqd va 1 ta karta test buyurtmasi;
   - `npm run finance:audit` — yangi yozuvlarda dublikat bo'lmasligi kerak.
6. **Mijoz ilovasini o'zgartirish shart emas** — server mavjud payload'ni qabul qiladi.
7. **Admin** branch'i alohida (Vercel), faqat bildirishnoma yorlig'i.

## 6. `main`'ga qo'shish shartlari (siz qo'ygan talab)

- [x] Barcha moliyaviy testlar local replica set'da o'tdi.
- [x] Tranzaksiyasiz rejim va standalone'da concurrency testlari o'tdi.
- [x] F-00 server tekshiruvi haqiqiy controller orqali tasdiqlandi.
- [ ] **Production baza turi aniqlandi** (R-1).
- [ ] `finance:audit` production'da ishga tushirildi va natija ko'rib chiqildi (R-2).
- [ ] Mavjud 6 ta moliyaga aloqasiz yiqilayotgan test bo'yicha qaror (tuzatish yoki "ma'lum" deb belgilash).
- [ ] Sizning tasdig'ingiz.

## 7. Orqaga qaytarish (rollback)

- **Kod:** oldingi commit'ga `git checkout` + `pm2 restart`.
- **Ma'lumotlar** to'liq mos qoladi:
  - yangi maydonlar (`postingKey`, `financeSettlement`, `financeRefund`, `feeRounding`) eski kod uchun e'tiborsiz;
  - eski kod `restaurant_due` mavjudligi bo'yicha ishlaydi, shuning uchun yangi kod settle qilgan buyurtmani qayta settle qilmaydi.
- **Indeks** `uniq_postingKey` eski kodga xalaqit bermaydi: eski kod `postingKey` yozmaydi. Kerak bo'lsa `db.ledgers.dropIndex('uniq_postingKey')`.
- **Rollback'dan keyin** F-00/F-01/F-02 xavflari qaytadi, shuning uchun rollback faqat favqulodda holatda.
