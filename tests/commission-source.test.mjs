/*
 * ═══════════════════════════════════════════════════════════
 * KOMISSIYA MANBAI: HAR RESTORAN — O'Z KELISHUVI. STATIK 10% YO'Q.
 * ═══════════════════════════════════════════════════════════
 * 9 xil kelishuvli restoran (5+5, 10+0, 2.5+2.5, 0+9, 7+3, 12.5+0, 0+0, 3.3+1.7 va
 * kelishuvsiz). Haqiqiy POST /orders kontrolleri → snapshot → to'lov (recordSuccess) →
 * yakunlash (settleOrder) → jurnal → audit. Har bosqichda foiz AYNAN restoranning
 * o'z kelishuvidan; yig'indisi 10 bo'lmagan restoranda hech qayerda 10% chiqmaydi.
 * npm run test:commission
 */
process.env.MONGO_URI = 'mongodb://127.0.0.1:27017/lokma_commission_source';
process.env.JWT_SECRET = 'x'.repeat(40);
process.env.RESTAURANT_BOT_TOKEN = '';
process.env.TELEGRAM_BOT_TOKEN = '';
process.env.SPLIT_LOKMA_PERCENT = '10';   // eski .env qiymati qoldirilgan bo'lsa ham HECH NARSAGA TA'SIR QILMASIN

const warns = [];
const origWarn = console.warn;
console.warn = (...a) => { warns.push(a.join(' ')); };

const mongoose = (await import('mongoose')).default;
await mongoose.connect(process.env.MONGO_URI);
await mongoose.connection.db.dropDatabase();

const { Order } = await import('../src/models/Order.js');
const { Restaurant } = await import('../src/models/Restaurant.js');
const { Dish } = await import('../src/models/Dish.js');
const { User } = await import('../src/models/User.js');
const { Ledger } = await import('../src/models/Ledger.js');
const { Payment } = await import('../src/models/Payment.js');
const { CommissionAgreement } = await import('../src/models/CommissionAgreement.js');
const { config } = await import('../src/config/index.js');
const Split = await import('../src/services/paymentSplit.js');
const { recordSuccess } = await import('../src/services/paymentRecord.js');
const { changeOrderStatus } = await import('../src/services/orderFlow.js');
const { orderController } = await import('../src/controllers/misc.js');
const { auditCommission, formatAudit } = await import('../src/services/commissionAudit.js');

let fails = 0;
const ok = (c, m) => { console.log(c ? '  ✓' : '  ✗ FAIL:', m); if (!c) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const call = async (fn, req) => {
  let status = 200; let body = null;
  const res = { status(c) { status = c; return this; }, json(b) { body = b; return this; } };
  await fn(req, res, (e) => { body = { next: e?.message }; status = 500; });
  await sleep(250);
  return { status, body };
};
const DAY = 86_400_000;

const user = await User.create({ firstName: 'Azim', telegramId: '9001', phone: '+998901112233' });

/* ── 9 xil kelishuv ── */
const SCENARIOS = [
  { name: 'Chinor Yashang', rest: 5, cust: 5 },
  { name: 'Ziynat', rest: 10, cust: 0 },
  { name: 'TOTLI', rest: 2.5, cust: 2.5 },
  { name: 'Nol-to‘qqiz', rest: 0, cust: 9 },
  { name: 'Yetti-uch', rest: 7, cust: 3 },
  { name: 'O‘n ikki yarim', rest: 12.5, cust: 0 },
  { name: 'Komissiyasiz', rest: 0, cust: 0 },
  { name: 'Uch-nuqta-uch', rest: 3.3, cust: 1.7 },
  { name: 'Kelishuvsiz', rest: null, cust: null },
];
const BASE_SOM = 100_000;
const rests = [];
for (const sc of SCENARIOS) {
  const r = await Restaurant.create({
    name: sc.name, cuisine: 'x', category: 'restoran', isActive: true, isApproved: true, lat: 41.3111, lng: 69.2797, address: 'Sang',
    deliveryEnabled: true, pickupEnabled: true, cashEnabled: true, deliveryFee: 0, openTime: '00:00', closeTime: '23:59',
    workingDays: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
  });
  const dish = await Dish.create({ restaurantId: r._id, section: 'menu', name: 'Pasta', price: BASE_SOM });
  let ag = null;
  if (sc.rest !== null) ag = await CommissionAgreement.create({ restaurantId: r._id, restaurantCommissionPercent: sc.rest, customerFeePercent: sc.cust, effectiveFrom: new Date(Date.now() - DAY) });
  rests.push({ ...sc, r, dish, ag, total: sc.rest === null ? 0 : sc.rest + sc.cust });
}

const place = async (x, paymentMethod) => {
  const res = await call(orderController.create, { userId: String(user._id), user: { _id: user._id }, body: {
    address: 'Uy', phone: '+998901112233', paymentMethod, paymentLabel: paymentMethod, fulfillment: 'pickup', timingMode: 'asap',
    orders: [{ restaurantId: String(x.r._id), restaurantName: x.name, subtotal: BASE_SOM, items: [{ dishId: String(x.dish._id), name: 'Pasta', quantity: 1, unitPrice: BASE_SOM }] }],
  } });
  const order = await Order.findOne({ restaurantId: x.r._id, paymentMethod }).sort({ createdAt: -1 });
  return { res, order };
};
const gross = (pct, tiyin = BASE_SOM * 100) => Math.round((tiyin * pct) / 100);
const complete = async (order, r) => {
  await Order.updateOne({ _id: order._id }, { status: 'ready' });
  await changeOrderStatus({ orderId: order._id, restaurantId: r._id, status: 'delivered' });
  await sleep(450);
};

console.log('\n[1] Statik 10% konfiguratsiyada YO‘Q; bo‘linish funksiyalari foizsiz ishlamaydi');
{
  ok(!('defaultLokmaPercent' in config.split), 'config.split.defaultLokmaPercent — YO‘Q (.env da SPLIT_LOKMA_PERCENT=10 qoldirilgan bo‘lsa ham)');
  for (const bad of [undefined, null, '', NaN, -1, 101, 'abc']) {
    let e1 = null; let e2 = null; let e3 = null;
    try { Split.splitClick(10_000_000, bad); } catch (e) { e1 = e; }
    try { Split.splitPaynet(10_000_000, bad); } catch (e) { e2 = e; }
    try { Split.computeSplit('payme', 10_000_000, bad); } catch (e) { e3 = e; }
    ok(e1 && e2 && e3 && /LokmaGo foizi/.test(e1.message), `foiz ${JSON.stringify(bad)} → aniq xato (jimgina 10% emas)`);
  }
  let e0 = null; try { Split.splitClick(10_000_000); } catch (e) { e0 = e; }
  ok(Boolean(e0), 'splitClick(total) — foizsiz chaqirilsa xato (ilgari 10% bo‘lardi)');
  const z = Split.splitClick(10_000_000, 0);
  ok(z.lokmaGrossCommission === 0 && z.restaurantAmount === 10_000_000, '0% — to‘g‘ri qiymat (komissiyasiz restoran)');
  ok(Split.splitClick(10_000_000, '7.5').lokmaGrossCommission === 750_000, 'matn "7.5" → 7.5%');
  ok(Split.assertLokmaPercent(100) === 100 && Split.assertLokmaPercent(0) === 0, 'chegaralar 0 va 100 — to‘g‘ri');
}

console.log('\n[2] POST /orders: har restoran o‘z kelishuvi foizida (snapshot)');
const placed = [];
for (const x of rests) {
  const { res, order } = await place(x, 'cash');
  ok(res.status === 201 && order, `${x.name}: buyurtma yaratildi`);
  const f = order.finance;
  const expRest = x.rest ?? 0; const expCust = x.cust ?? 0;
  ok(f.restaurantCommissionPercent === expRest && f.customerFeePercent === expCust, `${x.name}: foiz ${f.restaurantCommissionPercent}+${f.customerFeePercent} (kutilgan ${expRest}+${expCust})`);
  ok(f.lokmaGrossCommission === gross(expRest) + gross(expCust), `${x.name}: LokmaGo daromadi ${f.lokmaGrossCommission / 100} so‘m = ${expRest}% + ${expCust}% (taom ${BASE_SOM.toLocaleString('ru-RU')} dan)`);
  ok(x.ag ? String(f.commissionAgreementId) === String(x.ag._id) : f.commissionAgreementId === null, `${x.name}: ${x.ag ? 'o‘z kelishuvi ID si' : 'kelishuv yo‘q (null)'}`);
  placed.push({ ...x, order });
}
ok(warns.filter((w) => /faol kelishuv YO'Q/.test(w)).length === 1 && /Kelishuvsiz/.test(warns.find((w) => /faol kelishuv YO'Q/.test(w))), 'kelishuvsiz restoran uchun jurnalda OGOHLANTIRISH (1 marta)');
{
  const before = warns.length;
  await place(rests[8], 'cash');
  ok(warns.length === before, 'ogohlantirish soatiga bir marta (har buyurtmada takrorlanmaydi)');
}

console.log('\n[3] Yakunlash: jurnaldagi komissiya har restoranda o‘z foizida');
for (const x of placed) {
  await complete(x.order, x.r);
  const rows = await Ledger.find({ orderId: x.order._id, type: 'commission' }).lean();
  const total = x.rest === null ? 0 : x.total;
  if (total === 0) {
    ok(rows.length === 0, `${x.name}: 0% — komissiya yozuvi YO‘Q`);
  } else {
    ok(rows.length === 1 && rows[0].amount === (gross(x.rest) + gross(x.cust)) / 100 && rows[0].meta.commissionPercent === total,
      `${x.name}: jurnal ${rows[0]?.amount?.toLocaleString('ru-RU')} so‘m · ${rows[0]?.meta?.commissionPercent}% (kutilgan ${total}%)`);
  }
}
{
  // "Hech qayerda 10%" xossasi: yig'indisi 10 bo'lmagan restoranlarda
  const notTen = placed.filter((x) => x.total !== 10);
  let bad = 0;
  for (const x of notTen) {
    const rows = await Ledger.find({ orderId: x.order._id, type: 'commission' }).lean();
    if (rows.some((r) => r.meta.commissionPercent === 10 || r.amount === BASE_SOM * 0.1)) bad++;
  }
  ok(bad === 0, `yig‘indisi 10% bo‘lmagan ${notTen.length} ta restoranda hech qayerda 10% chiqmadi`);
  const sameTotal = placed.filter((x) => x.total === 10);
  const split = sameTotal.map((x) => `${x.rest}+${x.cust}`);
  ok(sameTotal.length === 3 && new Set(split).size === 3, `yig‘indisi 10% bo‘lgan restoranlar bir-biridan FARQ qiladi (${split.join(' · ')}): taqsimot ham o‘zinikidan`);
  const ziy = placed.find((x) => x.name === 'Ziynat'); const yet = placed.find((x) => x.name === 'Yetti-uch');
  const zr = await Ledger.findOne({ orderId: ziy.order._id, type: 'commission' }).lean(); const yr = await Ledger.findOne({ orderId: yet.order._id, type: 'commission' }).lean();
  ok(zr.meta.restaurantCommissionAmount === 10000 && zr.meta.customerFeeAmount === 0 && yr.meta.restaurantCommissionAmount === 7000 && yr.meta.customerFeeAmount === 3000, 'Ziynat 10+0 → restoran 10 000 / mijoz 0; Yetti-uch 7+3 → restoran 7 000 / mijoz 3 000');
}

console.log('\n[4] KARTA to‘lovi (recordSuccess): Payment.lokmaPercentApplied — restoranning o‘z foizi');
for (const x of rests) {
  const { res, order } = await place(x, 'click');
  if (!(res.status === 201 && order)) { ok(false, `${x.name}: click buyurtma yaratilmadi (${res.status} ${JSON.stringify(res.body)})`); continue; }
  await recordSuccess({ order: order.toObject(), provider: 'click', providerTransactionId: `tx-${x._id || x.name}`, amountTiyin: order.finance.totalCharged });
  const p = await Payment.findOne({ orderId: order._id }).lean();
  const expTotal = x.total;
  const expGross = gross(x.rest ?? 0) + gross(x.cust ?? 0);
  ok(p && p.lokmaPercentApplied === expTotal && p.lokmaGrossCommission === expGross, `${x.name}: to‘lov foizi ${p?.lokmaPercentApplied}% (kutilgan ${expTotal}%), LokmaGo ${p?.lokmaGrossCommission / 100} so‘m`);
  if (x.total !== 10) ok(p.lokmaPercentApplied !== 10, `${x.name}: 10% emas`);
}

console.log('\n[5] Kelishuv KEYIN o‘zgarsa — buyurtma o‘z (yaratilgan paytdagi) foizida qoladi');
{
  const x = rests[2]; // TOTLI 2.5+2.5
  const { order } = await place(x, 'click');
  const t = new Date();
  await CommissionAgreement.updateOne({ _id: x.ag._id }, { status: 'ARCHIVED', effectiveTo: t });
  await CommissionAgreement.create({ restaurantId: x.r._id, restaurantCommissionPercent: 8, customerFeePercent: 8, effectiveFrom: t });
  await recordSuccess({ order: order.toObject(), provider: 'click', providerTransactionId: 'tx-late', amountTiyin: order.finance.totalCharged });
  const p = await Payment.findOne({ orderId: order._id }).lean();
  ok(p.lokmaPercentApplied === 5, `kelishuv 5% → 16% ga o‘zgargach to‘lov yozildi: foiz ${p.lokmaPercentApplied}% (buyurtmaning o‘z 5% i; ilgari HOZIRGI kelishuv yozilardi)`);
  const fresh = (await place(x, 'cash')).order;
  ok(fresh.finance.restaurantCommissionPercent === 8 && fresh.finance.customerFeePercent === 8, 'yangi buyurtma — yangi kelishuv (8+8)');
  await complete(order, x.r);
  const row = await Ledger.findOne({ orderId: order._id, type: 'commission' }).lean();
  ok(row.meta.commissionPercent === 5, 'eski buyurtma jurnalda ham 5% (o‘zgarmadi)');
}

console.log('\n[6] Snapshot‘siz ESKI buyurtma: buyurtma yaratilgan paytdagi kelishuv (arxivlanganlar ham)');
{
  const r = await Restaurant.create({ name: 'Tarixiy', cuisine: 'x', category: 'restoran', isActive: true, isApproved: true });
  await CommissionAgreement.create({ restaurantId: r._id, restaurantCommissionPercent: 4, customerFeePercent: 3, effectiveFrom: new Date(Date.now() - 30 * DAY), effectiveTo: new Date(Date.now() - 10 * DAY), status: 'ARCHIVED' });
  await CommissionAgreement.create({ restaurantId: r._id, restaurantCommissionPercent: 6, customerFeePercent: 5, effectiveFrom: new Date(Date.now() - 10 * DAY) });
  const mkLegacy = (daysAgo) => Order.create({
    userId: user._id, restaurantId: r._id, restaurantName: 'Tarixiy', items: [{ name: 'Pasta', quantity: 1, unitPrice: 100000 }],
    subtotal: 100000, total: 100000, status: 'pending', fulfillment: 'pickup', paymentMethod: 'click', isPaid: false,
    createdAt: new Date(Date.now() - daysAgo * DAY),
  });
  const pay = async (o, tag) => {
    await recordSuccess({ order: (await Order.findById(o._id)).toObject(), provider: 'click', providerTransactionId: tag, amountTiyin: 10_000_000 });
    return Payment.findOne({ orderId: o._id }).lean();
  };
  const oldO = await mkLegacy(20); const newO = await mkLegacy(2); const noneO = await mkLegacy(40);
  ok(!oldO.finance || oldO.finance.model !== 'v2', 'tayyorgarlik: buyurtmalarda snapshot YO‘Q');
  const p1 = await pay(oldO, 'tx-l1'); const p2 = await pay(newO, 'tx-l2');
  const before = warns.length;
  const p3 = await pay(noneO, 'tx-l3');
  ok(p1.lokmaPercentApplied === 7 && p1.lokmaGrossCommission === 700_000, `20 kun oldingi buyurtma → o‘sha paytdagi (arxivlangan) kelishuv 4+3 = ${p1.lokmaPercentApplied}%`);
  ok(p2.lokmaPercentApplied === 11 && p2.lokmaGrossCommission === 1_100_000, `2 kun oldingi → joriy kelishuv 6+5 = ${p2.lokmaPercentApplied}%`);
  ok(p3.lokmaPercentApplied === 0 && p3.lokmaGrossCommission === 0 && p3.restaurantAmount === 10_000_000, `40 kun oldingi (kelishuv yo‘q) → ${p3.lokmaPercentApplied}% — ilgari 10% yozilardi`);
  ok(warns.length === before + 1 && /faol kelishuv topilmadi/.test(warns.at(-1)), 'bu holat jurnalda ogohlantirildi');
  const { agreementAt, activeAgreement } = await import('../src/models/CommissionAgreement.js');
  ok((await activeAgreement(r._id, new Date(Date.now() - 20 * DAY))) === null, '(sabab) activeAgreement arxivlanganni TOPMAYDI…');
  ok((await agreementAt(r._id, new Date(Date.now() - 20 * DAY))).restaurantCommissionPercent === 4, '…agreementAt esa topadi');
}

console.log('\n[7] AUDIT: toza ma‘lumotda hammasi mos; qo‘lda buzilgan joylarni TOPADI');
{
  const clean = await auditCommission();
  ok(clean.anomalies.snapshotVsAgreement.count === 0 && clean.anomalies.paymentPercent.count === 0 && clean.anomalies.ledgerPercent.count === 0 && clean.anomalies.static10Suspects.count === 0, `toza: farq yo‘q (${JSON.stringify(Object.fromEntries(Object.entries(clean.anomalies).map(([k, v]) => [k, v.count])))})`);
  ok(/HAMMASI MOS/.test(formatAudit(clean)), 'hisobot: "HAMMASI MOS"');
  ok(clean.withoutAgreement.some((r) => r.name === 'Kelishuvsiz') && clean.withoutAgreement.length === 1, 'kelishuvsiz restoran ro‘yxatda (komissiya 0%)');
  ok(clean.globals.envSplitLokmaPercent === '10' && /ENDI ISHLATILMAYDI/.test(formatAudit(clean)), '.env dagi eski SPLIT_LOKMA_PERCENT haqida: "ENDI ISHLATILMAYDI"');
  const totli = clean.restaurants.find((r) => r.name === 'TOTLI');
  ok(Object.keys(totli.percentsUsed).sort().join() === '2.5+2.5,8+8' || Object.keys(totli.percentsUsed).sort().join() === '2.5+2.5', `TOTLI qo‘llangan foizlar tarixi: ${JSON.stringify(totli.percentsUsed)}`);

  // Buzamiz: (a) snapshot 10 qilindi, (b) to'lovga 10, (c) jurnalga 10, (d) eski maydon
  const chinor = placed.find((x) => x.name === 'Chinor Yashang'); // 5+5 = 10 — kutilgan 10, shuning uchun "shubhali" emas
  const zero = placed.find((x) => x.name === 'Nol-to‘qqiz');       // 0+9 — kutilgan 9
  await Order.updateOne({ _id: zero.order._id }, { 'finance.restaurantCommissionPercent': 10, 'finance.customerFeePercent': 0 });
  const totliPay = await Payment.findOne({ lokmaPercentApplied: 5 });
  await Payment.updateOne({ _id: totliPay._id }, { lokmaPercentApplied: 10 });
  const uch = placed.find((x) => x.name === 'Uch-nuqta-uch');
  await Ledger.updateOne({ orderId: uch.order._id, type: 'commission' }, { 'meta.commissionPercent': 10 });
  await Restaurant.updateOne({ _id: rests[1].r._id }, { commissionPercent: 7 });
  const dirty = await auditCommission();
  const A = dirty.anomalies;
  ok(A.snapshotVsAgreement.count === 1 && A.snapshotVsAgreement.sample[0].applied === '10+0' && A.snapshotVsAgreement.sample[0].agreementAtThatTime === '0+9', `snapshot≠kelishuv topildi: ${JSON.stringify(A.snapshotVsAgreement.sample[0])}`);
  ok(A.paymentPercent.count === 1 && A.paymentPercent.sample[0].recorded === 10 && A.paymentPercent.sample[0].expected === 5, `to‘lov foizi farqi topildi: yozilgan 10, kutilgan 5`);
  // 2 ta: (1) qo'lda 10 yozilgan jurnal (kutilgan 5); (2) snapshot'i buzilgan buyurtmaning jurnali (9) endi snapshot'ga (10) mos emas
  ok(A.ledgerPercent.count === 2 && A.ledgerPercent.sample.some((s) => s.recorded === 10 && s.expected === 5), 'jurnal foizi farqi topildi: yozilgan 10, kutilgan 5');
  ok(A.ledgerPercent.sample.some((s) => s.recorded === 9 && s.expected === 10), '…va buzilgan snapshot bilan jurnal (9 ≠ 10) ham topildi — ikki manba o‘zaro tekshiriladi');
  ok(A.static10Suspects.count === 3, `"10% shubhali" — 3 ta (snapshot, to‘lov, jurnal): ${A.static10Suspects.count}`);
  ok(dirty.legacyDiffers.some((r) => r.name === 'Ziynat' && r.legacy === 7 && r.agreement === 10), 'eski maydon (7%) kelishuv (10%) dan farq qilishi aytildi');
  ok(/FARQLAR BOR/.test(formatAudit(dirty)) && /\[static10Suspects\]/.test(formatAudit(dirty)), 'hisobot: "FARQLAR BOR" + namunalar');
  void chinor;
  const since = await auditCommission({ since: new Date(Date.now() + DAY).toISOString() });
  ok(since.restaurants.every((r) => r.orders.total === 0) && since.anomalies.snapshotVsAgreement.count === 0, '--since kelajakdagi sana: buyurtma yo‘q');
}

console.warn = origWarn;
console.log(fails ? `\n✗ ${fails} ta xato` : '\n✓ HAMMASI O‘TDI');
await mongoose.disconnect();
process.exit(fails ? 1 : 0);
