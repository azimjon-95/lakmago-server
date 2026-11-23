/*
 * Paynet: to'lov jurnali (F-07) va provayder bekor qilishi (F-06) — haqiqiy MongoDB bilan.  npm run test:paynet-ledger
 *   PerformTransaction → Payment SUCCESS + Ledger payment_in (bitta) + buyurtma oshxonaga (pending)
 *   takroriy Perform → TX_EXISTS, yozuvlar takrorlanmaydi
 *   CancelTransaction → buyurtma umumiy oqim orqali bekor (cancelledAt), refund yozuvi, Payment REFUNDED, isPaid=false
 */
process.env.JWT_SECRET ||= 'x'.repeat(40);
process.env.NODE_ENV = 'development';
process.env.RESTAURANT_BOT_TOKEN = '1:X';
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 1 } }) });

const mongoose = (await import('mongoose')).default;
await mongoose.connect('mongodb://127.0.0.1:27017/lokma_paynet_ledger');
await mongoose.connection.db.dropDatabase();

const { Order } = await import('../src/models/Order.js');
const { Ledger } = await import('../src/models/Ledger.js');
const { Payment } = await import('../src/models/Payment.js');
const { Restaurant } = await import('../src/models/Restaurant.js');
const { handlePaynetRpc } = await import('../src/services/paynetUws.js');
const { config } = await import('../src/config/index.js');
const { computeOrderFinance } = await import('../src/services/orderFinance.js');
await Promise.all([Ledger.init(), Payment.init()]);

let fails = 0; let passes = 0;
const ok = (c, m) => { console.log(c ? '  ✓' : '  ✗ FAIL:', m); if (c) passes++; else fails++; };
const wait = (ms = 400) => new Promise((r) => setTimeout(r, ms));
const sid = '155';
config.paynet = { ...(config.paynet || {}), enabled: true, serviceId: sid };

const r = await Restaurant.create({ name: 'PAYNET-R', cuisine: 'milliy', category: 'restoran', isActive: true, isApproved: true });
const fin = computeOrderFinance({ foodBaseTiyin: 5000000, deliveryFeeTiyin: 1000000, restaurantCommissionPercent: 5, customerFeePercent: 5, paymentFeePercent: 1 });
const orderId = new mongoose.Types.ObjectId();
await Order.collection.insertOne({
  _id: orderId, restaurantId: r._id, status: 'awaiting_payment', paymentMethod: 'paynet', isPaid: false,
  subtotal: fin.customerFoodTotal / 100, deliveryFee: 10000, total: fin.totalCharged / 100, finance: fin, items: [],
  createdAt: new Date(), courierParty: 'restaurant', fulfillment: 'delivery',
});
const amount = fin.totalCharged;
const rpc = (method, params) => handlePaynetRpc({ jsonrpc: '2.0', id: 1, method, params: { serviceId: sid, ...params } });

console.log('\n[1] PerformTransaction');
{
  const res = await rpc('PerformTransaction', { amount, transactionId: 'PN-1', fields: { client_id: String(orderId) } });
  await wait();
  ok(!res.error, `muvaffaqiyatli (${JSON.stringify(res.error || '')})`);
  ok(await Payment.countDocuments({ orderId, status: 'SUCCESS' }) === 1, 'Payment SUCCESS — 1 ta');
  ok(await Ledger.countDocuments({ orderId, type: 'payment_in' }) === 1, 'payment_in yozildi (F-07 — ilgari Paynet uchun yozilmasdi)');
  ok((await Order.findById(orderId).lean()).status === 'pending', 'buyurtma oshxonaga chiqdi (pending)');
}

console.log('\n[2] Takroriy PerformTransaction (bir xil transactionId)');
{
  const res = await rpc('PerformTransaction', { amount, transactionId: 'PN-1', fields: { client_id: String(orderId) } });
  ok(Boolean(res.error), 'rad etildi');
  ok(await Ledger.countDocuments({ orderId, type: 'payment_in' }) === 1, 'payment_in takrorlanmadi');
}

console.log('\n[3] CancelTransaction (buyurtma hali yetkazilmagan)');
{
  const res = await rpc('CancelTransaction', { transactionId: 'PN-1' });
  await wait(800);
  ok(!res.error, `muvaffaqiyatli (${JSON.stringify(res.error || '')})`);
  const o = await Order.findById(orderId).lean();
  ok(o.status === 'cancelled' && Boolean(o.cancelledAt), 'buyurtma umumiy oqim orqali bekor qilindi (cancelledAt bor)');
  ok(o.isPaid === false, 'isPaid = false');
  const refunds = await Ledger.find({ orderId, type: 'refund' }).lean();
  ok(refunds.length === 1 && Math.round(Math.abs(refunds[0].amount) * 100) === amount, `refund yozuvi: ${refunds.map((x) => x.amount)}`);
  ok(await Ledger.countDocuments({ orderId, type: 'commission' }) === 0, 'manfiy komissiya yo‘q (hisob-kitob bo‘lmagan)');
  ok((await Payment.findOne({ orderId }).lean()).status === 'REFUNDED', 'Payment → REFUNDED');
  const again = await rpc('CancelTransaction', { transactionId: 'PN-1' });
  ok(Boolean(again.error), 'takroriy bekor qilish rad etildi');
  ok(await Ledger.countDocuments({ orderId, type: 'refund' }) === 1, 'refund takrorlanmadi');
}

await mongoose.connection.db.dropDatabase();
await mongoose.disconnect();
console.log(`\n${fails ? `✗ ${fails} ta XATO` : '✓ HAMMASI O‘TDI'} (${passes} tekshiruv)`);
process.exit(fails ? 1 : 0);
