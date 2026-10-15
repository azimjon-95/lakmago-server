/*
 * PAYNET SUMMA BIRLIGI — GetInformation va PerformTransaction so'mda.
 * Baza KERAK EMAS (Order/Transaction/recordSuccess stub). npm run test:paynet-amount
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(40);
const { Order } = await import('../src/models/Order.js');
const { Transaction } = await import('../src/models/Transaction.js');
const { handlePaynetRpc } = await import('../src/services/paynetUws.js');
const { config } = await import('../src/config/index.js');

let fails = 0;
const ok = (c, m) => { console.log(c ? '  ✓' : '  ✗ FAIL:', m); if (!c) fails++; };
const OID = 'a'.repeat(24);
const total = 119500; // so'm
const sid = '155';
config.paynet = { ...(config.paynet || {}), enabled: true, serviceId: sid };

const chain = (v) => ({ select() { return this; }, lean: async () => v });
let order = { _id: OID, total, status: 'awaiting_payment', save: async () => {} };
Order.findById = async () => order; // paynetUws.findOrderByClientId shu metodni ishlatadi
let txCreated = null; let recorded = null;
Transaction.findOne = async () => null;
Transaction.create = async (d) => { txCreated = d; return { _id: 'b'.repeat(24), ...d }; };
// recordSuccess ni import qilib o'rniga o'rnatish mumkin emas — shuning uchun PerformTransaction
// paymentRecord.js ichidagi chaqiruv xatosiz bo'lishi kerak; natijani Transaction.create orqali tekshiramiz.

console.log('\n[1] GetInformation — amount so‘mda');
{
  const r = await handlePaynetRpc({ jsonrpc: '2.0', id: 1, method: 'GetInformation', params: { serviceId: sid, fields: { client_id: OID } } });
  ok(!r.error, 'to‘lov uchun buyurtma topildi');
  ok(r.result?.fields?.amount === String(total), `amount = "${r.result?.fields?.amount}" (so‘m, ${total})`);
  ok(r.result?.fields?.amount !== String(total * 100), 'eski tiyin qiymati ("11950000") yuborilmaydi');
}
{
  order = { ...order, status: 'paid' };
  const r = await handlePaynetRpc({ jsonrpc: '2.0', id: 2, method: 'GetInformation', params: { serviceId: sid, fields: { client_id: OID } } });
  ok(Boolean(r.error), 'awaiting_payment bo‘lmagan buyurtma — xato (o‘zgarmagan)');
  order = { ...order, status: 'awaiting_payment' };
}

console.log('\n[2] PerformTransaction — so‘m bilan tekshiriladi');
{
  const tx = (amount, tid) => handlePaynetRpc({ jsonrpc: '2.0', id: 3, method: 'PerformTransaction', params: { amount, serviceId: sid, transactionId: tid, fields: { client_id: OID } } });
  txCreated = null;
  let r = await tx(String(total), 'T-OK');
  ok(txCreated && txCreated.amount === total * 100, `to‘g‘ri summa (so‘m) tekshiruvdan o‘tdi va tiyinda yozildi (${txCreated?.amount})`);
  txCreated = null;
  r = await tx(String(total * 100), 'T-TIYIN');
  ok(r.error?.code === 413 && txCreated === null, 'tiyin summa (11950000) RAD ETILADI (413), hech narsa yozilmaydi');
  txCreated = null;
  r = await tx(String(total - 1), 'T-LESS');
  ok(r.error?.code === 413 && txCreated === null, 'kam summa rad etiladi (413)');
}

console.log(fails ? `\n✗ ${fails} ta xato` : '\n✓ Hammasi o‘tdi');
process.exit(fails ? 1 : 0);
