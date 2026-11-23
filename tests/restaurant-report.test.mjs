/*
 * RESTORAN HISOBOTI (web panel "Hisobotlar") — 2026-11-23 audit tuzatishlari.
 *
 *  [1] String restaurantId (JWT'dagidek) bilan buyurtmalar va ledger TOPILADI
 *      (eski aggregate'lar hech narsa topmasdi → "0 ta buyurtma")
 *  [2] Kun — TOSHKENT kuni; buyurtma deliveredAt bo'yicha (updatedAt emas)
 *  [3] Pul — v2 snapshot: taom, restoran komissiyasi, mijoz xizmat haqi,
 *      ulush, naqdda LokmaGo qismi, karta ulushi; eski buyurtma alohida
 *  [4] 1-QOIDA: to'lanmay bekor bo'lgan / awaiting_payment restoranga CHIQMAYDI
 *  [5] Ledger ko'rinishi: LokmaGo sof daromadi / Click haqi (meta) CHIQMAYDI
 *  [6] Boshqa restoran ma'lumoti aralashmaydi; eski "T00:00:00" format ham Toshkent kuni
 *
 * Faqat lokal/scratch baza: MONGO_URI (standart mongodb://127.0.0.1:27018).
 * npm run test:restaurant-report
 */
import mongoose from 'mongoose';
import { Order } from '../src/models/Order.js';
import { Ledger } from '../src/models/Ledger.js';
import { Restaurant } from '../src/models/Restaurant.js';
import {
  buildRestaurantSummary, buildRestaurantDaily, buildRestaurantOrderList,
  restaurantLedgerView, normalizeEdge,
} from '../src/services/restaurantReport.js';
import { restaurantBillingController } from '../src/controllers/restaurantBilling.js';

const URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27018/';
if (/mongodb\+srv|atlas|mongodb\.net/i.test(URI)) {
  console.error('Bu test faqat lokal bazada ishlaydi'); process.exit(2);
}

let fails = 0;
const ok = (c, m) => { console.log(c ? '  ✓' : '  ✗ FAIL:', m); if (!c) fails++; };
const eq = (a, b, m) => ok(a === b, `${m} (kutilgan ${b}, chiqdi ${a})`);

await mongoose.connect(URI, { dbName: 'test_restaurant_report' });
await mongoose.connection.db.dropDatabase();

const R = new mongoose.Types.ObjectId();
const OTHER = new mongoose.Types.ObjectId();
const at = (s) => new Date(s);
const v2 = (f) => ({ model: 'v2', currency: 'UZS', unit: 'tiyin', ...f });

await Restaurant.collection.insertMany([
  { _id: R, name: 'Test', balance: 100000, totalPaidOut: 70000 },
  { _id: OTHER, name: 'Boshqa', balance: 0 },
]);

const base = { restaurantId: R, items: [], createdAt: at('2026-11-20T09:00:00+05:00') };
await Order.collection.insertMany([
  // A — karta, restoran kuryeri, Toshkent 00:30 (UTC bo'yicha OLDINGI kun)
  { ...base, status: 'delivered', paymentMethod: 'click', fulfillment: 'delivery', courierParty: 'restaurant', isPaid: true,
    dailyNumber: 1, subtotal: 100000, deliveryFee: 15000, total: 117500,
    deliveredAt: at('2026-11-20T00:30:00+05:00'), updatedAt: at('2026-11-20T00:30:00+05:00'),
    items: [{ name: 'Osh', quantity: 2, unitPrice: 50000 }],
    finance: v2({ foodSubtotal: 10000000, discountAmount: 0, restaurantCommissionPercent: 2.5, restaurantCommissionAmount: 250000,
      customerFeePercent: 2.5, customerFeeAmount: 250000, deliveryFee: 1500000, restaurantDeliveryPayout: 1500000,
      restaurantPayout: 11250000, lokmaGrossCommission: 500000, lokmaNetCommission: 323750, clickFeeAmount: 176250, totalCharged: 11750000 }) },
  // B — naqd, olib ketish (restoran o'zi oldi), Toshkent 23:30
  { ...base, status: 'delivered', paymentMethod: 'cash', fulfillment: 'pickup', courierParty: null, isPaid: true,
    dailyNumber: 2, subtotal: 70000, deliveryFee: 0, total: 71750,
    deliveredAt: at('2026-11-20T23:30:00+05:00'), updatedAt: at('2026-11-21T10:00:00+05:00'), // keyin baho qoldirildi
    items: [{ name: 'Osh', quantity: 1, unitPrice: 50000 }, { name: 'Choy', quantity: 4, unitPrice: 5000 }],
    finance: v2({ foodSubtotal: 7000000, restaurantCommissionPercent: 2.5, restaurantCommissionAmount: 175000,
      customerFeePercent: 2.5, customerFeeAmount: 175000, restaurantDeliveryPayout: 0,
      restaurantPayout: 6825000, lokmaGrossCommission: 350000, totalCharged: 7175000 }) },
  // C — naqd, LOKMAGO kuryeri olgan (restoran uchun karta kabi)
  { ...base, status: 'delivered', paymentMethod: 'cash', fulfillment: 'delivery', courierParty: 'lokma', isPaid: true,
    dailyNumber: 3, subtotal: 50000, deliveryFee: 10000, total: 61250,
    deliveredAt: at('2026-11-20T13:00:00+05:00'), updatedAt: at('2026-11-20T13:00:00+05:00'),
    finance: v2({ foodSubtotal: 5000000, restaurantCommissionPercent: 2.5, restaurantCommissionAmount: 125000,
      customerFeePercent: 2.5, customerFeeAmount: 125000, restaurantDeliveryPayout: 0, courierParty: 'lokma',
      restaurantPayout: 4875000, lokmaGrossCommission: 250000, totalCharged: 6125000 }) },
  // D — eski (snapshot'siz) karta buyurtma
  { ...base, status: 'delivered', paymentMethod: 'payme', fulfillment: 'delivery', isPaid: true,
    dailyNumber: 4, subtotal: 40000, deliveryFee: 0, total: 40000,
    deliveredAt: at('2026-11-20T15:00:00+05:00'), updatedAt: at('2026-11-20T15:00:00+05:00') },
  // E — zal (dinein), naqd, eski
  { ...base, status: 'delivered', paymentMethod: 'cash', fulfillment: 'dinein', isPaid: true,
    subtotal: 30000, deliveryFee: 0, total: 30000,
    deliveredAt: at('2026-11-20T19:00:00+05:00'), updatedAt: at('2026-11-20T19:00:00+05:00') },
  // Chegaradan tashqari: 19-kuni 23:50 va 21-kuni 00:10 (Toshkent)
  { ...base, status: 'delivered', paymentMethod: 'cash', fulfillment: 'pickup', dailyNumber: 9, subtotal: 11111, total: 11111,
    deliveredAt: at('2026-11-19T23:50:00+05:00'), updatedAt: at('2026-11-20T12:00:00+05:00') }, // baho 20-kuni — KIRMASLIGI kerak
  { ...base, status: 'delivered', paymentMethod: 'cash', fulfillment: 'pickup', dailyNumber: 1, subtotal: 22222, total: 22222,
    deliveredAt: at('2026-11-21T00:10:00+05:00'), updatedAt: at('2026-11-21T00:10:00+05:00') },
  // F — restoran ko'rgan, keyin bekor (naqd)
  { ...base, status: 'cancelled', paymentMethod: 'cash', fulfillment: 'delivery', dailyNumber: 5, subtotal: 20000, total: 20000,
    cancelReason: 'Taom tugagan', cancelledAt: at('2026-11-20T14:00:00+05:00'), updatedAt: at('2026-11-20T14:00:00+05:00') },
  // G — to'lanmay bekor bo'lgan KARTA (restoran HECH QACHON ko'rmagan) — chiqmasligi shart
  { ...base, status: 'cancelled', paymentMethod: 'click', fulfillment: 'delivery', dailyNumber: null, paidAt: null, isPaid: false,
    subtotal: 99000, total: 99000, cancelReason: 'To‘lov amalga oshirilmadi',
    cancelledAt: at('2026-11-20T16:00:00+05:00'), updatedAt: at('2026-11-20T16:00:00+05:00') },
  // H — awaiting_payment (chiqmasligi shart)
  { ...base, status: 'awaiting_payment', paymentMethod: 'click', fulfillment: 'delivery', subtotal: 88000, total: 88000,
    dailyNumber: null, paidAt: null, updatedAt: at('2026-11-20T17:00:00+05:00') },
  // I, J — hozir jarayonda
  { ...base, status: 'pending', paymentMethod: 'cash', fulfillment: 'pickup', dailyNumber: 6, subtotal: 1, total: 1, updatedAt: at('2026-11-20T18:00:00+05:00') },
  { ...base, status: 'preparing', paymentMethod: 'click', fulfillment: 'delivery', dailyNumber: 7, isPaid: true, paidAt: at('2026-11-20T18:00:00+05:00'),
    subtotal: 1, total: 1, updatedAt: at('2026-11-20T18:00:00+05:00') },
  // Boshqa restoran — aralashmasligi kerak
  { ...base, restaurantId: OTHER, status: 'delivered', paymentMethod: 'cash', fulfillment: 'pickup', dailyNumber: 1, subtotal: 555555, total: 555555,
    deliveredAt: at('2026-11-20T12:00:00+05:00'), updatedAt: at('2026-11-20T12:00:00+05:00') },
]);

await Ledger.collection.insertMany([
  // Toshkent 00:20 (UTC — 19-kun) → 20-kun qatoriga tushishi kerak
  { restaurantId: R, type: 'commission', amount: 5000, createdAt: at('2026-11-20T00:20:00+05:00'),
    meta: { note: '5% · agreement', lokmaNetCommission: 3237.5, clickFoodFeeAmount: 1500, customerFeeAmount: 2500 } },
  { restaurantId: R, type: 'restaurant_due', amount: 112500, createdAt: at('2026-11-20T00:20:00+05:00'), meta: { note: 'ulush' } },
  { restaurantId: R, type: 'payout', amount: -20000, createdAt: at('2026-11-10T12:00:00+05:00') },
  { restaurantId: R, type: 'payout', amount: -50000, createdAt: at('2026-11-20T12:00:00+05:00'), meta: { note: 'Bank' } },
  { restaurantId: R, type: 'bonus_compensation', amount: 3000, createdAt: at('2026-11-20T13:00:00+05:00') },
  { restaurantId: OTHER, type: 'payout', amount: -777777, createdAt: at('2026-11-20T12:00:00+05:00') },
]);

const RID = String(R); // JWT'dagidek — STRING
const DAY = { from: '2026-11-20', to: '2026-11-20' };

console.log('\n[1–4] summary (string restaurantId, Toshkent kuni)');
const s = await buildRestaurantSummary(RID, DAY);
eq(s.orders.ordersTotal, 5, 'yetkazilgan buyurtmalar (A,B,C,D,E; chegaradan tashqarisi va boshqa restoran yo‘q)');
eq(s.orders.revenue, 320500, 'jami (total) summa');
eq(s.orders.cash.count, 3, 'naqd soni (B, C, E)');
eq(s.orders.card.count, 2, 'karta soni (A, D)');
eq(s.orders.delivery, 3, 'yetkazish'); eq(s.orders.pickup, 1, 'olib ketish'); eq(s.orders.dinein, 1, 'zal');
eq(s.orders.cancelled, 1, 'bekor — faqat restoran ko‘rgan F (G to‘lanmagan karta chiqmaydi)');
eq(s.orders.cancelledFood, 20000, 'bekor bo‘lgan taom summasi (faqat F)');
eq(s.orders.cancelReasons[0]?.reason, 'Taom tugagan', 'bekor sababi');
ok(!s.orders.cancelReasons.some((r) => /To‘lov amalga oshirilmadi/.test(r.reason)), '1-QOIDA: to‘lanmagan buyurtma sababi ham chiqmaydi');
eq(s.orders.active, 2, 'hozir jarayonda (pending + preparing; awaiting_payment emas)');
eq(s.orders.topDishes[0]?.name, 'Choy', 'eng ko‘p sotilgan (soni bo‘yicha)');
eq(s.orders.topDishes[0]?.qty, 4, 'Choy soni');
eq(s.orders.topDishes[1]?.qty, 3, 'Osh soni (A 2 + B 1)');
eq(s.orders.topDishes[1]?.amount, 150000, 'Osh summasi');
eq(s.finance.food, 290000, 'taom savdosi');
eq(s.finance.commission, 5500, 'restoran komissiyasi (v2: 2500+1750+1250)');
eq(s.finance.customerFee, 5500, 'mijoz xizmat haqi (alohida)');
eq(s.finance.delivery, 15000, 'restoranga yetkazish puli (LokmaGo kuryeri yetkazgani kirmaydi)');
eq(s.finance.share, 229500, 'restoran ulushi (v2)');
eq(s.finance.toLokma, 3500, 'naqd (B): LokmaGo’ga beriladigan qism = komissiya + mijoz xizmat haqi');
eq(s.finance.fromLokma, 161250, 'LokmaGo o‘tkazadigan: A karta + C LokmaGo kuryeri naqdi');
eq(s.finance.cashCollected, 101750, 'restoran qo‘lida olgan naqd (B + E)');
eq(s.finance.legacyOrders, 2, 'snapshot’siz buyurtmalar (D, E) alohida sanaldi');
eq(s.finance.commissionPercent, 2.5, 'komissiya foizi'); eq(s.finance.customerFeePercent, 2.5, 'mijoz foizi');
eq(s.finance.payouts.amount, 50000, 'davrdagi o‘tkazma (boshqa restoranniki kirmaydi)');
eq(s.finance.bonusCompensation, 3000, 'sovg‘a bonusi');
eq(s.finance.net, 160750, 'davr natijasi = 161250 − 3500 + 3000');
eq(s.orders.lokmaCourierCash, 1, 'LokmaGo kuryeri olgan naqd soni');
eq(s.payout.pendingToReceive, 100000, 'umumiy balans (o‘zgarmagan qoida)');
eq(s.payout.lastPayout?.amount, 50000, 'oxirgi o‘tkazma');
eq(s.period.timezone, 'Asia/Tashkent', 'vaqt zonasi javobda');
const leaked = JSON.stringify(s);
ok(!/lokmaNet|clickFee|lokmaGross|lokmaCashNet/i.test(leaked), 'summary javobida LokmaGo daromadi / Click haqi yo‘q');

console.log('\n[6] eski panel formati ("T00:00:00"/"T23:59:59") — Toshkent kuni');
eq(normalizeEdge('2026-11-20T00:00:00'), '2026-11-20', 'from normalizatsiya');
eq(normalizeEdge('2026-11-20T23:59:59'), '2026-11-20', 'to normalizatsiya');
eq(normalizeEdge('2026-11-20T10:00:00Z'), '2026-11-20T10:00:00Z', 'aniq lahza o‘zgarmaydi');
const sOld = await buildRestaurantSummary(RID, { from: '2026-11-20T00:00:00', to: '2026-11-20T23:59:59' });
eq(sOld.orders.ordersTotal, 5, 'eski format bilan ham 5 ta');
const sObj = await buildRestaurantSummary(R, DAY);
eq(sObj.finance.share, s.finance.share, 'ObjectId bilan ham bir xil natija');

console.log('\n[2] daily — Toshkent kunlari');
const d = await buildRestaurantDaily(RID, { from: '2026-11-19', to: '2026-11-21' });
const d20 = d.find((r) => r.day === '2026-11-20');
const d19 = d.find((r) => r.day === '2026-11-19');
const d21 = d.find((r) => r.day === '2026-11-21');
ok(Boolean(d20), '20-kun qatori bor');
eq(d20?.orders, 5, '20-kun buyurtmalari');
eq(d20?.o_share, 229500, '20-kun ulush (snapshot)');
eq(d20?.o_commission, 5500, '20-kun restoran komissiyasi');
eq(d20?.komissiya, 5000, 'ledger komissiyasi 00:20 Toshkent → 20-kunda (UTC’da 19 bo‘lardi)');
eq(d20?.tolangan, 50000, '20-kun o‘tkazma');
eq(d20?.bonusKompensatsiya, 3000, '20-kun bonus');
eq(d19?.orders, 1, '19-kun 23:50 dagi buyurtma 19-kunda (baho 20-kuni qoldirilgan bo‘lsa ham)');
eq(d21?.orders, 1, '21-kun 00:10 dagi buyurtma 21-kunda');
eq(d[0]?.day, '2026-11-21', 'yangisi birinchi');

console.log('\n[3] orders — har bir buyurtma');
const l = await buildRestaurantOrderList(RID, DAY);
eq(l.items.length, 5, 'yetkazilganlar ro‘yxati');
eq(l.cancelled.length, 1, 'bekorlar (faqat F)');
ok(!l.cancelled.some((c) => c.food === 99000), '1-QOIDA: G (to‘lanmagan karta) ro‘yxatda yo‘q');
ok(!l.items.some((o) => o.total === 88000), '1-QOIDA: awaiting_payment yo‘q');
const A = l.items.find((o) => o.dailyNumber === 1);
eq(A?.money.share, 112500, 'A ulushi'); eq(A?.money.commission, 2500, 'A komissiyasi');
eq(A?.money.fromLokma, 112500, 'A: LokmaGo o‘tkazadi');
const B = l.items.find((o) => o.dailyNumber === 2);
eq(B?.money.toLokma, 3500, 'B (naqd): LokmaGo’ga beriladi');
eq(B?.payGroup, 'cash', 'B naqd');
const Dl = l.items.find((o) => o.dailyNumber === 4);
eq(Dl?.money.v2, false, 'D eski'); eq(Dl?.money.share, null, 'D ulushi noma’lum (0 deb ko‘rsatilmaydi)');
ok(!/lokmaNet|clickFee|lokmaGross|lokmaCashNet/i.test(JSON.stringify(l)), 'ro‘yxatda LokmaGo daromadi / Click haqi yo‘q');

console.log('\n[5] ledger endpoint — meta chiqmaydi, string ID bilan ishlaydi');
let body;
const res = { json: (b) => { body = b; } };
await restaurantBillingController.ledger({ restaurantId: RID, query: { from: '2026-11-20', to: '2026-11-20' } }, res, (e) => { throw e; });
await new Promise((r) => setTimeout(r, 50));
ok(Array.isArray(body) && body.length === 4, `20-kun yozuvlari: 4 ta (chiqdi ${body?.length})`);
const com = body?.find((x) => x.type === 'commission');
eq(com?.note, '5% · agreement', 'izoh qoladi');
ok(com && !('meta' in com), 'meta yo‘q');
ok(!/lokmaNet|clickFood|777777/.test(JSON.stringify(body)), 'LokmaGo sof daromadi, Click haqi, boshqa restoran yo‘q');
body = null;
await restaurantBillingController.ledger({ restaurantId: RID, query: { type: 'payout' } }, res, (e) => { throw e; });
await new Promise((r) => setTimeout(r, 50));
eq(body?.length, 2, 'o‘tkazmalar tarixi (type=payout)');
eq(restaurantLedgerView({ _id: 'x', type: 'payout', amount: -1, meta: { lokmaNetCommission: 1 } }).note, '', 'view: meta faqat izoh');

console.log('\n[6] noto‘g‘ri sana → PeriodError (jimgina "0 ta" emas)');
let perr = null;
try { await buildRestaurantSummary(RID, { from: '2026-13-45', to: '2026-11-20' }); } catch (e) { perr = e; }
eq(perr?.name, 'PeriodError', 'PeriodError');

await mongoose.connection.db.dropDatabase();
await mongoose.disconnect();
console.log(fails ? `\n✗ ${fails} ta xato` : '\n✓ hammasi o‘tdi');
process.exit(fails ? 1 : 0);
