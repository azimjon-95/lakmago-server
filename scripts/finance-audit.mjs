/*
 * ═══ MOLIYAVIY AUDIT — FAQAT O'QIYDI ═══   npm run finance:audit [-- --json] [-- --from=YYYY-MM-DD --to=YYYY-MM-DD]
 *
 * Bazaga HECH NARSA yozmaydi (indeks ham yaratmaydi). Production'da xavfsiz ishga tushirish mumkin.
 * Ko'rsatadi:
 *   0. baza turi (replica set / standalone) — tranzaksiya arxitekturasi shunga bog'liq;
 *   1. bir buyurtmaga BIR NECHTA hisob-kitob (commission > 0 yoki birlamchi restaurant_due takrori) — F-02 izi;
 *   2. restoran balansi ≠ jurnaldan hisoblangan balans — F-01 (yo'qolgan yangilanish) izi;
 *   3. bir buyurtmada bir nechta payment_in — F-19;
 *   4. bir provayder tranzaksiyasiga bir nechta Payment yoki bir buyurtmaga bir nechta SUCCESS Payment — F-16;
 *   5. qaytarilgan summa > mijoz to'lagan — F-10;
 *   6. musbat komissiyasiz manfiy komissiya (yetkazishdan oldin bekor) — F-05 izi;
 *   7. yarim qolgan settlement (financeSettlement.state = SETTLING) va balansi band qilingan PROCESSING payout'lar;
 *   8. takroriy postingKey (unique indeks yaratishdan oldin — bo'lmasligi kerak).
 * Topilgan narsalar TUZATILMAYDI — tuzatish faqat ko'rib chiqilgan reja bo'yicha, alohida buyruq bilan.
 */
import 'dotenv/config';
import mongoose from 'mongoose';

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
const uri = process.env.MONGO_URI || 'mongodb://localhost:27017/lokmago';
await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000, readPreference: 'secondaryPreferred' });
const db = mongoose.connection.db;
const range = {};
if (args.from) range.$gte = new Date(`${args.from}T00:00:00+05:00`);
if (args.to) range.$lt = new Date(new Date(`${args.to}T00:00:00+05:00`).getTime() + 86400000);
const created = Object.keys(range).length ? { createdAt: range } : {};
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const out = { generatedAt: new Date().toISOString(), filter: { from: args.from || null, to: args.to || null }, sections: {} };

// 0. topologiya
const hello = await db.admin().command({ hello: 1 });
out.topology = hello.msg === 'isdbgrid' ? 'sharded' : (hello.setName ? `replicaset:${hello.setName}` : 'standalone');

const L = db.collection('ledgers');
// 1. takroriy hisob-kitob
out.sections.duplicateSettlements = await L.aggregate([
  { $match: { ...created, type: 'commission', amount: { $gt: 0 }, orderId: { $ne: null } } },
  { $group: { _id: '$orderId', n: { $sum: 1 }, total: { $sum: '$amount' }, restaurantId: { $first: '$restaurantId' } } },
  { $match: { n: { $gt: 1 } } }, { $limit: 500 },
]).toArray();
out.sections.duplicatePrimaryDue = await L.aggregate([
  { $match: { ...created, type: 'restaurant_due', orderId: { $ne: null }, 'meta.note': { $not: /Qaytarish|qaytarish/ } } },
  { $group: { _id: '$orderId', n: { $sum: 1 }, total: { $sum: '$amount' }, restaurantId: { $first: '$restaurantId' } } },
  { $match: { n: { $gt: 1 } } }, { $limit: 500 },
]).toArray();

// 2. balans vs jurnal (butun tarix; filtr qo'llanmaydi — balans kumulyativ)
const ledgerBal = await L.aggregate([
  { $match: { restaurantId: { $ne: null }, type: { $in: ['restaurant_due', 'bonus_compensation', 'payout'] } } },
  { $group: { _id: '$restaurantId', s: { $sum: '$amount' } } },
]).toArray();
const promoAdj = await L.aggregate([
  { $match: { restaurantId: { $ne: null }, type: 'adjustment', 'meta.note': /jalb qilish qarzi — delivery tushumidan/ } },
  { $group: { _id: '$restaurantId', s: { $sum: '$amount' } } },
]).toArray();
const lb = new Map(ledgerBal.map((x) => [String(x._id), x.s]));
const pa = new Map(promoAdj.map((x) => [String(x._id), x.s]));
const rests = await db.collection('restaurants').find({}, { projection: { name: 1, balance: 1 } }).toArray();
out.sections.balanceDrift = rests.map((x) => {
  const ledger = r2(lb.get(String(x._id)) || 0);
  const promo = r2(pa.get(String(x._id)) || 0);   // payout'dan ushlangan promo qarzi: balansdan ayirilgan, jurnalda + yozilgan
  const expected = r2(ledger - promo);
  return { restaurantId: x._id, name: x.name, balance: r2(x.balance), ledgerDerived: expected, diff: r2((x.balance || 0) - expected) };
}).filter((x) => Math.abs(x.diff) >= 0.01).sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));

// 3. payment_in takrori
out.sections.duplicatePaymentIn = await L.aggregate([
  { $match: { ...created, type: 'payment_in', orderId: { $ne: null } } },
  { $group: { _id: '$orderId', n: { $sum: 1 }, total: { $sum: '$amount' } } }, { $match: { n: { $gt: 1 } } }, { $limit: 500 },
]).toArray();

// 4. Payment dublikatlari
const P = db.collection('payments');
out.sections.duplicateProviderTx = await P.aggregate([
  { $match: { ...created, providerTransactionId: { $nin: ['', null] } } },
  { $group: { _id: { provider: '$provider', tx: '$providerTransactionId' }, n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }, { $limit: 500 },
]).toArray();
out.sections.multipleSuccessPerOrder = await P.aggregate([
  { $match: { ...created, status: 'SUCCESS' } },
  { $group: { _id: '$orderId', n: { $sum: 1 }, amounts: { $push: '$amount' } } }, { $match: { n: { $gt: 1 } } }, { $limit: 500 },
]).toArray();

// 5. ortiqcha qaytarish
out.sections.overRefund = await L.aggregate([
  { $match: { ...created, type: 'refund', orderId: { $ne: null } } },
  { $group: { _id: '$orderId', refunded: { $sum: { $abs: '$amount' } } } },
  { $lookup: { from: 'orders', localField: '_id', foreignField: '_id', as: 'o', pipeline: [{ $project: { total: 1 } }] } },
  { $project: { refunded: 1, total: { $first: '$o.total' } } },
  { $match: { $expr: { $gt: ['$refunded', { $add: ['$total', 0.01] }] } } }, { $limit: 500 },
]).toArray();

// 6. musbatsiz manfiy komissiya
out.sections.orphanNegativeCommission = await L.aggregate([
  { $match: { ...created, type: 'commission', orderId: { $ne: null } } },
  { $group: { _id: '$orderId', pos: { $sum: { $cond: [{ $gt: ['$amount', 0] }, '$amount', 0] } }, neg: { $sum: { $cond: [{ $lt: ['$amount', 0] }, '$amount', 0] } } } },
  { $match: { pos: 0, neg: { $lt: 0 } } }, { $limit: 500 },
]).toArray();

// 7. yarim qolgan jarayonlar
out.sections.stuckSettlements = await db.collection('orders').find({ 'financeSettlement.state': 'SETTLING' }, { projection: { restaurantId: 1, financeSettlement: 1 } }).limit(500).toArray();
out.sections.stuckPayouts = await db.collection('payouts').find({ status: 'PROCESSING' }, { projection: { restaurantId: 1, amount: 1, createdAt: 1, 'snapshot.balanceClaimed': 1 } }).limit(500).toArray();

// 8. takroriy postingKey
out.sections.duplicatePostingKeys = await L.aggregate([
  { $match: { postingKey: { $type: 'string' } } }, { $group: { _id: '$postingKey', n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }, { $limit: 100 },
]).toArray();

out.summary = Object.fromEntries(Object.entries(out.sections).map(([k, v]) => [k, v.length]));
if (args.json) {
  console.log(JSON.stringify(out, null, 2));
} else {
  console.log(`\nMOLIYAVIY AUDIT (faqat o'qish) · ${out.generatedAt} · baza: ${out.topology}`);
  if (args.from || args.to) console.log(`Davr: ${args.from || '…'} — ${args.to || '…'}`);
  const labels = {
    duplicateSettlements: 'Bir buyurtmada bir nechta komissiya (takroriy hisob-kitob)',
    duplicatePrimaryDue: 'Bir buyurtmada bir nechta birlamchi restaurant_due',
    balanceDrift: 'Restoran balansi ≠ jurnal (yo‘qolgan yangilanish)',
    duplicatePaymentIn: 'Bir buyurtmada bir nechta payment_in',
    duplicateProviderTx: 'Bir provayder tranzaksiyasiga bir nechta Payment',
    multipleSuccessPerOrder: 'Bir buyurtmaga bir nechta SUCCESS Payment',
    overRefund: 'Qaytarilgan > buyurtma summasi',
    orphanNegativeCommission: 'Musbatsiz manfiy komissiya',
    stuckSettlements: 'Yarim qolgan settlement (SETTLING)',
    stuckPayouts: 'PROCESSING holatidagi payout',
    duplicatePostingKeys: 'Takroriy postingKey',
  };
  for (const [k, label] of Object.entries(labels)) {
    const v = out.sections[k];
    console.log(`\n${v.length ? '⚠' : '✓'} ${label}: ${v.length}`);
    v.slice(0, 10).forEach((x) => console.log(`    ${JSON.stringify(x)}`));
    if (v.length > 10) console.log(`    … yana ${v.length - 10} ta (--json bilan to‘liq)`);
  }
  const drift = out.sections.balanceDrift.reduce((s, x) => s + x.diff, 0);
  if (out.sections.balanceDrift.length) console.log(`\nBalans farqi jami: ${r2(drift)} so‘m (musbat — balans jurnaldan KO‘P: ortiqcha to‘lash xavfi)`);
}
await mongoose.disconnect();
