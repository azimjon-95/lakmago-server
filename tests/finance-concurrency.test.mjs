/*
 * ═══ MOLIYA — HAQIQIY CONCURRENCY TESTLARI (MongoDB kerak) ═══  npm run test:finance-concurrency
 *
 * Bir buyurtma/restoran ustida BIR VAQTDA kelgan so'rovlar: settleOrder, recordPayout, recordRefund,
 * recordPayment, recordSuccess. Har birida: faqat BITTA yozuv, balans bir marta o'zgaradi, asldan ortiq
 * qaytarilmaydi va restoran balansi = jurnaldan hisoblangan balans (rekonsiliatsiya invarianti).
 *
 * Bir jarayon ichida (Promise.all — ulanishlar havzasi orqali haqiqiy parallel so'rovlar) va alohida
 * JARAYONLAR orqali ("ikki worker bir buyurtmani tasdiqlaydi").
 *
 * Muhit:  MONGO_URI (standart mongodb://127.0.0.1:27017) — har ishga tushishda alohida test bazasi yaratiladi
 *         va oxirida o'chiriladi. FINANCE_TX=off — replica set'da ham tranzaksiyasiz yo'lni tekshirish uchun.
 */
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const RAW = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017';
const m = /^(mongodb(?:\+srv)?:\/\/[^/?]+)(?:\/[^?]*)?(\?.*)?$/.exec(RAW);
if (!m) throw new Error(`MONGO_URI noto'g'ri: ${RAW}`);
const BASE = RAW;
const role = process.argv[2];
const dbName = role === 'worker' ? process.argv[3] : `lokmago_fin_conc_${process.pid}_${Date.now()}`;
process.env.MONGO_URI = `${m[1]}/${dbName}${m[2] || ''}`;
process.env.NODE_ENV ||= 'test';

const mongoose = (await import('mongoose')).default;
await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 8000, maxPoolSize: 50 });

const { Order } = await import('../src/models/Order.js');
const { Restaurant } = await import('../src/models/Restaurant.js');
const { Ledger } = await import('../src/models/Ledger.js');
const { Payout } = await import('../src/models/Payout.js');
const { Payment } = await import('../src/models/Payment.js');
const billing = await import('../src/services/billing.js');
const { computeOrderFinance } = await import('../src/services/orderFinance.js');
const { applyDeliveryParty } = await import('../src/services/deliveryParty.js');
const { detectTopology, transactionsSupported } = await import('../src/services/financeTx.js');

/* ── Worker rejimi: bitta buyurtmani N marta parallel settle qiladi ── */
if (role === 'worker') {
  const orderId = process.argv[4];
  const n = Number(process.argv[5]) || 5;
  const results = await Promise.all(Array.from({ length: n }, () => billing.settleOrder(orderId).catch((e) => ({ error: e.message }))));
  process.send?.({ ok: results.filter((r) => r && !r.error).length, errors: results.filter((r) => r?.error).map((r) => r.error) });
  await mongoose.disconnect();
  process.exit(0);
}

let failed = 0; let passed = 0;
const ok = (cond, name, extra = '') => { if (cond) { passed += 1; console.log(`  ✓ ${name}`); } else { failed += 1; console.log(`  ✗ FAIL: ${name} ${extra}`); } };
const eq = (a, b, name) => ok(a === b, name, `→ ${a} ≠ ${b}`);
const T = (som) => som * 100;
const oid = () => new mongoose.Types.ObjectId();

await Promise.all([Ledger.init(), Payout.init(), Payment.init(), Order.init(), Restaurant.init()]);
const topology = await detectTopology();
const txOn = await transactionsSupported();
console.log(`\nBaza: ${topology} · tranzaksiya: ${txOn ? 'HA' : "YO'Q"} (FINANCE_TX=${process.env.FINANCE_TX || 'auto'}) · ${dbName}`);

async function makeRestaurant(balance = 0) {
  const _id = oid();
  await Restaurant.collection.insertOne({ _id, name: `R-${_id}`, category: 'magazin', cuisine: 'test', balance, totalPaidOut: 0, totalOrders: 0, isActive: true });
  // Boshlang'ich balans jurnalda ham bo'lsin (invariant: balans = jurnal)
  if (balance) await Ledger.collection.insertOne({ type: 'restaurant_due', amount: balance, restaurantId: _id, meta: { note: 'test: boshlang‘ich balans' }, createdAt: new Date() });
  return _id;
}
async function makeOrder(restaurantId, { food = 100000, delivery = 20000, R = 5, C = 5, method = 'click', party = 'restaurant', status = 'delivered', isPaid = true } = {}) {
  let fin = computeOrderFinance({
    foodBaseTiyin: T(food), deliveryFeeTiyin: T(delivery), restaurantCommissionPercent: R, customerFeePercent: C,
    paymentFeePercent: method === 'cash' ? 0 : 1.5,
  });
  fin = applyDeliveryParty(fin, { party, nominalDeliveryFeeTiyin: T(delivery), percent: 10 });
  const _id = oid();
  await Order.collection.insertOne({
    _id, restaurantId, userId: null, status, paymentMethod: method, isPaid, courierParty: party,
    subtotal: fin.customerFoodTotal / 100, deliveryFee: delivery, total: fin.totalCharged / 100, finance: fin,
    items: [], createdAt: new Date(),
  });
  return { _id, fin };
}
/** Restoran balansi jurnaldan: restaurant_due + bonus_compensation + payout (promo o'chiq) */
async function ledgerBalance(restaurantId) {
  const rows = await Ledger.aggregate([
    { $match: { restaurantId, type: { $in: ['restaurant_due', 'bonus_compensation', 'payout'] } } },
    { $group: { _id: null, s: { $sum: '$amount' } } },
  ]);
  return Math.round((rows[0]?.s || 0) * 100) / 100;
}
const cnt = (q) => Ledger.countDocuments(q);

/* ───────── S1: bir buyurtma — 25 parallel settleOrder (karta) ───────── */
console.log('\n[S1] Bir karta buyurtmasi — 25 ta parallel settleOrder');
{
  const r = await makeRestaurant();
  const { _id, fin } = await makeOrder(r);
  const res = await Promise.all(Array.from({ length: 25 }, () => billing.settleOrder(_id)));
  eq(res.filter(Boolean).length, 1, 'faqat bitta so‘rov hisob-kitob qildi');
  eq(await cnt({ orderId: _id, type: 'restaurant_due' }), 1, 'restaurant_due — 1 ta');
  eq(await cnt({ orderId: _id, type: 'commission' }), 1, 'commission — 1 ta');
  const rest = await Restaurant.findById(r).lean();
  eq(rest.balance, fin.restaurantPayout / 100, `balans bir marta: +${fin.restaurantPayout / 100}`);
  eq(rest.totalOrders, 1, 'totalOrders bir marta');
  eq((await Order.findById(_id).lean()).financeSettlement?.state, 'SETTLED', 'financeSettlement = SETTLED');
}

/* ───────── S2: naqd — 25 parallel ───────── */
console.log('\n[S2] Naqd buyurtma — 25 ta parallel settleOrder (komissiya qarzi bir marta)');
{
  const r = await makeRestaurant();
  const { _id, fin } = await makeOrder(r, { method: 'cash' });
  await Promise.all(Array.from({ length: 25 }, () => billing.settleOrder(_id)));
  eq(await cnt({ orderId: _id, type: 'restaurant_due' }), 1, 'restaurant_due — 1 ta');
  eq((await Restaurant.findById(r).lean()).balance, -fin.lokmaGrossCommission / 100, `balans −${fin.lokmaGrossCommission / 100} (5%+5% gross)`);
  eq(await cnt({ orderId: _id, type: 'payment_in' }), 1, 'naqd payment_in — 1 ta (finalizeCashPayment parallel)');
}

/* ───────── S3: alohida JARAYONLAR ───────── */
console.log('\n[S3] 4 ta alohida jarayon × 6 parallel settleOrder bitta buyurtmaga');
{
  const r = await makeRestaurant();
  const { _id, fin } = await makeOrder(r);
  const self = fileURLToPath(import.meta.url);
  const outs = await Promise.all(Array.from({ length: 4 }, () => new Promise((resolve) => {
    const c = fork(self, ['worker', dbName, String(_id), '6'], { env: { ...process.env, MONGO_URI: BASE } });
    c.on('message', resolve);
    c.on('exit', (code) => { if (code) resolve({ ok: 0, errors: [`exit ${code}`] }); });
  })));
  eq(outs.reduce((s, o) => s + (o.ok || 0), 0), 1, '24 urinishdan faqat bittasi hisob-kitob qildi (jarayonlar aro)');
  eq(outs.flatMap((o) => o.errors || []).length, 0, 'xatosiz');
  eq(await cnt({ orderId: _id }), 2, 'jurnalda aynan 2 yozuv (commission + restaurant_due)');
  eq((await Restaurant.findById(r).lean()).balance, fin.restaurantPayout / 100, 'balans bir marta');
}

/* ───────── S4: eski hisob-kitob qilingan buyurtma ───────── */
console.log('\n[S4] Shu o‘zgarishdan OLDIN hisob-kitob qilingan buyurtma (financeSettlement yo‘q)');
{
  const r = await makeRestaurant();
  const { _id } = await makeOrder(r);
  await Ledger.collection.insertOne({ type: 'restaurant_due', amount: 950, orderId: _id, restaurantId: r, createdAt: new Date() });
  await Restaurant.updateOne({ _id: r }, { $inc: { balance: 950 } });
  const res = await Promise.all(Array.from({ length: 5 }, () => billing.settleOrder(_id)));
  eq(res.filter(Boolean).length, 0, 'qayta hisob-kitob yo‘q');
  eq(await cnt({ orderId: _id, type: 'restaurant_due' }), 1, 'yozuv takrorlanmadi');
  eq((await Restaurant.findById(r).lean()).balance, 950, 'balans o‘zgarmadi');
  eq((await Order.findById(_id).lean()).financeSettlement?.mode, 'legacy-ledger', 'holat legacy-ledger deb belgilandi');
}

/* ───────── S5: lost update — parallel settle + parallel payout ───────── */
console.log('\n[S5] Bir restoran: 30 buyurtma parallel settle + 12 parallel payout (turli kalit)');
{
  const r = await makeRestaurant();
  const orders = await Promise.all(Array.from({ length: 30 }, () => makeOrder(r, { food: 50000, delivery: 0, R: 10, C: 0 })));
  const share = orders[0].fin.restaurantPayout / 100;   // 45 000
  // Avval 10 tasi — payout uchun balans paydo bo'lsin, keyin qolgan 20 tasi payout bilan BIR VAQTDA
  await Promise.all(orders.slice(0, 10).map((o) => billing.settleOrder(o._id)));
  const payoutAmt = 100000;
  const [settles, payouts] = await Promise.all([
    Promise.all(orders.slice(10).map((o) => billing.settleOrder(o._id))),
    Promise.all(Array.from({ length: 12 }, (_, i) => billing.recordPayout(r, payoutAmt, null, 'test', `po-${r}-${i}`).then(() => 'ok').catch((e) => e.message))),
  ]);
  eq(settles.filter(Boolean).length, 20, '20 ta settle muvaffaqiyatli');
  const okPayouts = payouts.filter((p) => p === 'ok').length;
  const rest = await Restaurant.findById(r).lean();
  const expected = 30 * share - okPayouts * payoutAmt;
  eq(rest.balance, expected, `balans = 30×${share} − ${okPayouts}×${payoutAmt} (yo‘qolgan yangilanish yo‘q)`);
  ok(rest.balance >= 0, 'balans manfiy emas');
  eq(rest.balance, await ledgerBalance(r), 'Restaurant.balance = jurnaldan hisoblangan balans');
  eq(await Payout.countDocuments({ restaurantId: r, status: 'SUCCESS' }), okPayouts, 'SUCCESS payout soni = jurnaldagi payout');
  eq(await cnt({ restaurantId: r, type: 'payout' }), okPayouts, 'payout yozuvlari soni mos');
  eq(rest.totalPaidOut, okPayouts * payoutAmt, 'totalPaidOut mos');
}

/* ───────── S6: bir xil kalit bilan 15 parallel payout ───────── */
console.log('\n[S6] Bir xil idempotencyKey bilan 15 ta parallel payout');
{
  const r = await makeRestaurant(500000);
  const key = `same-${r}`;
  const res = await Promise.all(Array.from({ length: 15 }, () => billing.recordPayout(r, 200000, null, 'test', key).catch((e) => ({ error: e.message }))));
  eq(res.filter((x) => x && !x.alreadyExisted && !x.error).length, 1, 'faqat bittasi to‘ladi');
  eq(res.filter((x) => x?.alreadyExisted).length, 14, 'qolgan 14 tasi alreadyExisted');
  eq((await Restaurant.findById(r).lean()).balance, 300000, 'balans bir marta kamaydi');
  eq(await cnt({ restaurantId: r, type: 'payout' }), 1, 'jurnalda 1 payout');
  // Balans yetmaydi
  const bad = await billing.recordPayout(r, 999999, null, 'test', `big-${r}`).catch((e) => e.message);
  ok(String(bad).includes('yetarli emas'), 'balansdan katta payout rad etildi');
  eq((await Payout.findOne({ idempotencyKey: `big-${r}` }).lean()).status, 'FAILED', 'rad etilgan payout FAILED');
  eq((await Restaurant.findById(r).lean()).balance, 300000, 'rad etilganda balans o‘zgarmadi');
}

/* ───────── S7: parallel qisman qaytarishlar ───────── */
console.log('\n[S7] 12 ta parallel qisman qaytarish (har biri 30%) — asldan oshmaydi');
{
  const r = await makeRestaurant();
  const { _id, fin } = await makeOrder(r, { food: 100000, delivery: 20000 });
  await billing.settleOrder(_id);
  const balAfterSettle = (await Restaurant.findById(r).lean()).balance;
  const order = await Order.findById(_id).lean();
  const res = await Promise.all(Array.from({ length: 12 }, () => billing.recordRefund(order, 'click', null, { foodBaseRefundTiyin: T(30000), refundDelivery: false })));
  const okN = res.filter(Boolean).length;
  eq(okN, 3, '3 tasi o‘tdi (90%), qolgani qolgan summadan katta — rad');
  const st = (await Order.findById(_id).lean()).financeRefund;
  eq(st.foodBaseTiyin, T(90000), 'rezerv: 90 000 taom bazasi');
  eq(await cnt({ orderId: _id, type: 'refund' }), 3, 'refund yozuvlari — 3 ta');
  const refunds = await Ledger.find({ orderId: _id, type: 'refund' }).lean();
  ok(refunds.reduce((s, l) => s + Math.abs(l.amount), 0) <= fin.totalCharged / 100, 'jami qaytarilgan ≤ mijoz to‘lagan');
  // Qolganini to'liq + yetkazish bilan, yana 8 ta parallel
  const rest = await Promise.all(Array.from({ length: 8 }, async () => billing.recordRefund(await Order.findById(_id).lean(), 'click', null, { refundDelivery: true })));
  eq(rest.filter(Boolean).length, 1, 'qolgan qism faqat BIR marta qaytarildi');
  const all = await Ledger.find({ orderId: _id, type: 'refund' }).lean();
  eq(Math.round(all.reduce((s, l) => s + Math.abs(l.amount), 0) * 100), fin.totalCharged, 'jami qaytarilgan = mijoz to‘lagani (aniq)');
  const dueSum = (await Ledger.find({ orderId: _id, type: 'restaurant_due' }).lean()).reduce((s, l) => s + l.amount, 0);
  eq(Math.round(dueSum * 100), 0, 'restoran ulushi to‘liq teskari (Σ restaurant_due = 0)');
  const comSum = (await Ledger.find({ orderId: _id, type: 'commission' }).lean()).reduce((s, l) => s + l.amount, 0);
  eq(Math.round(comSum * 100), 0, 'komissiya to‘liq teskari (Σ commission = 0)');
  eq((await Restaurant.findById(r).lean()).balance, Math.round((balAfterSettle - fin.restaurantPayout / 100) * 100) / 100, 'balans asl holatiga qaytdi');
  eq((await Restaurant.findById(r).lean()).balance, await ledgerBalance(r), 'balans = jurnal');
}

/* ───────── S8: yetkazishdan oldin bekor (karta) — 10 parallel to'liq qaytarish ───────── */
console.log('\n[S8] Yetkazishdan oldin bekor: 10 parallel to‘liq qaytarish');
{
  const r = await makeRestaurant();
  const { _id, fin } = await makeOrder(r, { status: 'cancelled' });
  const order = await Order.findById(_id).lean();
  const res = await Promise.all(Array.from({ length: 10 }, () => billing.recordRefund(order, 'click')));
  eq(res.filter(Boolean).length, 1, 'faqat bitta qaytarish');
  eq(await cnt({ orderId: _id, type: 'refund' }), 1, 'refund — 1 ta');
  eq(await cnt({ orderId: _id, type: 'commission' }), 0, 'manfiy komissiya yo‘q (hisob-kitob bo‘lmagan)');
  eq(Math.round(Math.abs((await Ledger.findOne({ orderId: _id, type: 'refund' }).lean()).amount) * 100), fin.totalCharged, 'mijozga to‘liq summa');
  eq((await Restaurant.findById(r).lean()).balance, 0, 'restoran balansi tegilmadi');
}

/* ───────── S9: LokmaGo kuryeri buyurtmasi qaytarishi ───────── */
console.log('\n[S9] LokmaGo kuryeri yetkazgan karta buyurtmasi — to‘liq qaytarish jurnalga yoziladi');
{
  const r = await makeRestaurant();
  const { _id, fin } = await makeOrder(r, { party: 'lokma' });
  await Order.updateOne({ _id }, { $set: { 'financeSettlement.state': 'SETTLED' } });
  await Ledger.create({ type: 'restaurant_due', amount: fin.restaurantPayout / 100, orderId: _id, restaurantId: r });
  await Restaurant.updateOne({ _id: r }, { $inc: { balance: fin.restaurantPayout / 100 } });
  const res = await billing.recordRefund(await Order.findById(_id).lean(), 'click');
  ok(res && res.refunded === fin.totalCharged / 100, 'qaytarish yozildi (ilgari validateRefund yiqilib null qaytardi)');
  eq((await Restaurant.findById(r).lean()).balance, 0, 'restoran ulushi (faqat taom) teskari — balans 0');
}

/* ───────── S10: recordPayment va recordSuccess ───────── */
console.log('\n[S10] payment_in — 20 parallel; recordSuccess — 10 parallel bir xil tranzaksiya');
{
  const r = await makeRestaurant();
  const { _id } = await makeOrder(r, { status: 'awaiting_payment', isPaid: false });
  const order = await Order.findById(_id).lean();
  await Promise.all(Array.from({ length: 20 }, () => billing.recordPayment(order, 'click')));
  eq(await cnt({ orderId: _id, type: 'payment_in' }), 1, 'payment_in — 1 ta');
  const { recordSuccess } = await import('../src/services/paymentRecord.js');
  await Promise.all(Array.from({ length: 10 }, () => recordSuccess({ order, provider: 'click', providerTransactionId: 'T-1', amountTiyin: Math.round(order.total * 100) }).catch(() => null)));
  eq(await Payment.countDocuments({ orderId: _id, status: 'SUCCESS' }), 1, 'Payment SUCCESS — 1 ta');
  eq((await Order.findById(_id).lean()).status, 'pending', 'buyurtma bir marta oshxonaga chiqdi (pending)');
}

/* ───────── S11: global invariant ───────── */
console.log('\n[S11] Barcha test restoranlari: Restaurant.balance = jurnaldan hisoblangan balans');
{
  const all = await Restaurant.find({}).lean();
  let bad = 0;
  for (const x of all) {
    const lb = await ledgerBalance(x._id);
    if (Math.abs((x.balance || 0) - lb) > 0.001) { bad += 1; console.log(`    ${x.name}: balans ${x.balance} ≠ jurnal ${lb}`); }
  }
  eq(bad, 0, `${all.length} restoran — hammasi mos`);
  const dups = await Ledger.aggregate([{ $match: { postingKey: { $type: 'string' } } }, { $group: { _id: '$postingKey', n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }]);
  eq(dups.length, 0, 'takroriy postingKey yo‘q');
}

await mongoose.connection.dropDatabase().catch(() => {});
await mongoose.disconnect();
console.log(`\n${failed ? `✗ ${failed} ta XATO` : '✓ HAMMASI O‘TDI'} (${passed} tekshiruv · ${topology} · tx ${txOn ? 'ha' : "yo'q"})`);
process.exit(failed ? 1 : 0);
