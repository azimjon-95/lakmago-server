/*
 * ═══════════════════════════════════════════════════════════
 * REAL-TIME: RESTORAN XONASIGA XOM BUYURTMA KETMAYDI
 * ═══════════════════════════════════════════════════════════
 * `order:new` / `order:update` restoran xonasiga avval xom hujjat yuborardi: LokmaGo netto
 * daromadi, Click haqi, populate qilingan butun User (manzillar, kartalar, bonus). Endi har
 * ikki yo'l (socket va /panel/orders) bir xil toPanelOrder dan o'tadi. Admin xonasi xom qoladi.
 * HAQIQIY funksiyalar: changeOrderStatus, confirmOrderDelivered, controller'lar. npm run test:order-socket
 */
process.env.MONGO_URI = 'mongodb://127.0.0.1:27017/lokma_order_socket';
process.env.JWT_SECRET = 'x'.repeat(40);
process.env.TELEGRAM_BOT_TOKEN = '';
process.env.RESTAURANT_BOT_TOKEN = '';

import { createServer } from 'node:http';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const mongoose = (await import('mongoose')).default;
await mongoose.connect(process.env.MONGO_URI);
await mongoose.connection.db.dropDatabase();

const { Order } = await import('../src/models/Order.js');
const { Restaurant } = await import('../src/models/Restaurant.js');
const { User } = await import('../src/models/User.js');
const { initSocket, getIO } = await import('../src/sockets/io.js');
const { restaurantOrderView, emitOrderToRestaurant } = await import('../src/services/orderSocket.js');
const { toPanelOrder, restaurantFinanceView } = await import('../src/services/panelOrderView.js');
const { changeOrderStatus } = await import('../src/services/orderFlow.js');
const { confirmOrderDelivered } = await import('../src/services/deliveryCheck.js');
const { orderController } = await import('../src/controllers/misc.js');

let fails = 0;
const ok = (c, m) => { console.log(c ? '  ✓' : '  ✗ FAIL:', m); if (!c) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// haqiqiy socket.io serveri; faqat chiqayotgan hodisalarni yozib boramiz
initSocket(createServer());
const rec = [];
getIO().to = (room) => ({ emit: (ev, payload) => rec.push({ room, ev, payload }) });
const forRestaurant = () => rec.filter((r) => r.room.startsWith('restaurant:') && /^order:(new|update)$/.test(r.ev));
const forAdmin = () => rec.filter((r) => r.room === 'admin' && /^order:(new|update)$/.test(r.ev));

const SECRETS = ['lokmaNetCommission', 'lokmaGrossCommission', 'clickFeeAmount', 'clickResidualAmount', 'lokmaCashNet',
  'SECRET-ADDR', 'SECRET-CARD', 'SECRET-HASH', 'bonusBalance', 'passwordHash', 'addresses', 'cards'];
const leaks = (v) => { const j = JSON.stringify(v); return SECRETS.filter((k) => j.includes(k)); };

const R = await Restaurant.create({ name: 'TOTLI', cuisine: 'x', category: 'restoran', isActive: true, isApproved: true });
// sxemani chetlab o'tamiz: haqiqiy bazadagi User'da bor, lekin restoranga CHIQMASLIGI kerak bo'lgan maydonlar
const uid = new mongoose.Types.ObjectId();
await User.collection.insertOne({
  _id: uid, telegramId: '9101', firstName: 'Azim', lastName: 'Karimov', username: 'azim', phone: '+998901112233', photoUrl: 'p.jpg',
  addresses: [{ label: 'SECRET-ADDR' }], cards: [{ last4: '4242', token: 'SECRET-CARD' }], bonusBalance: 777, passwordHash: 'SECRET-HASH',
});
const FIN = { model: 'v2', unit: 'tiyin', currency: 'UZS', foodSubtotal: 1_000_000, discountAmount: 0, customerFeePercent: 5, customerFeeAmount: 50_000, restaurantCommissionPercent: 5,
  restaurantCommissionAmount: 50_000, restaurantPayout: 950_000, deliveryFee: 0, totalCharged: 1_000_000,
  clickFeeAmount: 31_337, clickResidualAmount: 777, lokmaGrossCommission: 50_000, lokmaNetCommission: 12_345, lokmaCashNet: 11_111 };
const mk = (over = {}) => Order.create({
  userId: uid, restaurantId: R._id, restaurantName: 'TOTLI', items: [{ name: 'Pasta', quantity: 1, unitPrice: 10000 }],
  subtotal: 10000, total: 10250, deliveryFee: 0, status: 'ready', fulfillment: 'delivery', address: 'Uy', phone: '+998901112233',
  paymentMethod: 'cash', isPaid: false, finance: FIN, ...over,
});
const baseKeys = (o) => Object.keys(o).sort().join(',');

console.log('\n[1] restaurantOrderView — sof funksiya');
{
  const doc = await mk();
  ok(leaks(doc.toObject()).length > 0, `tayyorgarlik: xom hujjatda sirlar BOR (${leaks(doc.toObject()).slice(0, 3).join(', ')}…)`);

  const v = await restaurantOrderView(doc);                              // userId — oddiy ObjectId (populate yo'q)
  ok(leaks(v).length === 0, `populate qilinmagan hujjat: sirlar YO‘Q (${leaks(v).join(',') || 'toza'})`);
  ok(baseKeys(v.finance) === baseKeys(restaurantFinanceView(FIN)), 'finance — faqat restoran ko‘radigan maydonlar');
  ok(v.finance.restaurantPayout === 9500 && v.finance.foodSubtotal === 10000 && v.finance.restaurantCommissionAmount === 500, 'finance so‘mda (tiyin ÷ 100): payout 9 500, taom 10 000, komissiya 500');
  ok(v.customer.name === 'Azim Karimov' && v.customer.phone === '+998901112233' && v.customer.username === 'azim' && typeof v.userId === 'string', 'mijoz o‘qib olindi: ism, telefon; userId matn');
  ok(v.restaurantConfirm !== undefined, 'restaurantConfirm bor (panel ro‘yxati bilan bir xil)');

  const full = await Order.findById(doc._id).populate('userId');         // BUTUN User hujjati populate qilingan
  ok(JSON.stringify(full.toObject()).includes('SECRET-HASH'), 'tayyorgarlik: populate("userId") butun User hujjatini (parol hash bilan) olib keldi');
  const vf = await restaurantOrderView(full);
  ok(leaks(vf).length === 0 && vf.customer.name === 'Azim Karimov', 'populate qilingan BUTUN User: manzil/karta/bonus/parol hash CHIQMAYDI');

  const lean = await Order.findById(doc._id).lean();
  ok(leaks(await restaurantOrderView(lean)).length === 0, '.lean() obyekt — toza');

  // HTTP yo'li (/panel/orders) bilan bir xil shakl
  const list = toPanelOrder(await Order.findById(doc._id).populate('userId', 'firstName lastName username telegramId phone photoUrl').lean());
  const a = JSON.parse(JSON.stringify(v)); const b = JSON.parse(JSON.stringify(list));
  delete a.restaurantConfirm; delete b.restaurantConfirm;
  const diff = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
  if (diff.length) console.log('    farq:', diff.map((k) => `${k}: ${JSON.stringify(a[k])?.slice(0, 80)} ≠ ${JSON.stringify(b[k])?.slice(0, 80)}`).join(' | '));
  ok(diff.length === 0, 'socket ko‘rinishi /panel/orders ro‘yxati bilan AYNAN bir xil (kalitlar va qiymatlar)');

  const vg = await restaurantOrderView({ ...lean, userId: null });     // sxema userId ni talab qiladi — oddiy obyekt
  ok(vg.customer.name === 'Mijoz' && vg.customer.phone === '+998901112233' && vg.userId === null, 'mijozsiz (mehmon) buyurtma: "Mijoz" + buyurtma telefoni');
  const gone = await mk({ userId: new mongoose.Types.ObjectId() });
  ok((await restaurantOrderView(gone)).customer.name === 'Mijoz', 'o‘chirilgan mijoz — xato emas, "Mijoz"');

  const real = User.findById; User.findById = () => { throw new Error('baza uzildi'); };
  const origErr = console.error; console.error = () => {};
  let broke = false; let vb;
  try { vb = await restaurantOrderView(doc); } catch { broke = true; }
  console.error = origErr; User.findById = real;
  ok(!broke && vb.customer.name === 'Mijoz' && leaks(vb).length === 0, 'mijozni o‘qishda baza xatosi — yiqilmaydi, sirsiz ko‘rinish');

  // emit yordamchisi: xato bo'lsa xom buyurtma EMAS, minimal bo'lak
  rec.length = 0;
  const bad = { _id: doc._id, restaurantId: R._id, status: 'ready', toObject() { throw new Error('buzuq'); } };
  console.error = () => {};
  await emitOrderToRestaurant(getIO(), 'order:update', bad);
  console.error = origErr;
  ok(rec.length === 1 && JSON.stringify(rec[0].payload) === JSON.stringify({ _id: String(doc._id), status: 'ready' }), 'ko‘rinish yasab bo‘lmasa — XOM emas, faqat { _id, status } yuboriladi');
  rec.length = 0; await emitOrderToRestaurant(null, 'order:update', doc); await emitOrderToRestaurant(getIO(), 'order:update', null);
  ok(rec.length === 0, 'io yoki buyurtma yo‘q — jim');
}

console.log('\n[2] HAQIQIY oqimlar: restoran xonasi toza, admin xonasi xom');
{
  // Hodisalar ikki xil: TO'LIQ buyurtma (items bor) yoki QISQA BO'LAK ({_id,status} / {_id,isPaid,paidAt})
  const PATCH_KEYS = ['_id', 'status', 'isPaid', 'paidAt'];
  const isPatch = (p) => Object.keys(p).every((k) => PATCH_KEYS.includes(k));
  const check = (label) => {
    const r = forRestaurant(); const a = forAdmin();
    const full = r.filter((e) => !isPatch(e.payload));
    ok(full.length >= 1, `${label}: restoran xonasiga to‘liq buyurtma ketdi (jami ${r.length} hodisa, shundan ${r.length - full.length} qisqa bo‘lak)`);
    ok(r.every((e) => leaks(e.payload).length === 0), `${label}: restoran payload'ida sir YO‘Q`);
    ok(full.every((e) => e.payload.customer?.name === 'Azim Karimov' && e.payload.finance?.restaurantPayout === 9500), `${label}: to‘liq payload'da mijoz obyekti va so‘mdagi finance bor (ro‘yxat bilan bir xil shakl)`);
    ok(a.some((e) => JSON.stringify(e.payload).includes('lokmaNetCommission')), `${label}: ADMIN xonasi xom ko‘rinishda (moliya ko‘rinadi)`);
  };

  rec.length = 0;
  const a1 = await mk({ status: 'pending' });
  await changeOrderStatus({ orderId: a1._id, restaurantId: R._id, status: 'accepted' }); await sleep(120);
  check('orderFlow (restoran statusni o‘zgartirdi)');

  rec.length = 0;
  const a2 = await mk({ status: 'delivering' });
  await confirmOrderDelivered(a2._id, 'customer'); await sleep(500);
  check('deliveryCheck (mijoz "Ha, oldim")');

  rec.length = 0;
  const a3 = await mk({ status: 'delivering' });
  let body = null;
  await orderController.confirmDelivery({ params: { id: String(a3._id) }, body: {}, user: { _id: uid, userId: String(uid) }, userId: String(uid) },
    { status() { return this; }, json(b) { body = b; return this; } }, () => {});
  await sleep(600);
  check('misc.confirmDelivery (mijoz ilovasi)');
}

console.log('\n[3] QO‘RIQCHI: kelajakda xom buyurtma restoran xonasiga yana yuborilmasin');
{
  const walk = (d) => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : p.endsWith('.js') ? [p] : []; });
  const bad = [];
  for (const f of walk('src')) {
    const lines = readFileSync(f, 'utf8').split('\n');
    lines.forEach((l, i) => {
      const m = l.match(/\.to\(`restaurant:\$\{[^}]+\}`\)\.emit\('order:(new|update)',\s*([^)]+)\)/);
      if (m && !/^\s*(\{|patch\b)/.test(m[2])) bad.push(`${f}:${i + 1} → ${m[2].trim()}`);
    });
  }
  ok(bad.length === 0, `restoran xonasiga xom buyurtma yuboradigan joy: ${bad.length ? bad.join(' | ') : 'YO‘Q'} (faqat minimal { _id, status } yoki patch ruxsat)`);
}

console.log('\n[4] MIJOZ javoblari: moliya snapshoti YO‘Q, qolgan maydonlar o‘zgarmagan');
{
  const call = async (fn, req) => { let body = null; const res = { status() { return this; }, json(b) { body = b; return this; } }; await fn(req, res, () => {}); await sleep(300); return body; };
  const norm = (v) => JSON.parse(JSON.stringify(v));
  const sg = await mk({ status: 'delivered', groupId: 'g-sock-1' });
  const fresh = norm((await Order.findById(sg._id)).toJSON());
  const withoutFinance = (() => { const j = { ...fresh }; delete j.finance; return j; })();
  ok(fresh.finance && fresh.finance.lokmaNetCommission === 12345, 'tayyorgarlik: xom hujjatda finance.lokmaNetCommission BOR');

  const mine = norm(await call(orderController.myOrders, { userId: String(uid) }));
  const mineRow = mine.find((x) => x._id === String(sg._id));
  ok(Array.isArray(mine) && mine.every((x) => !('finance' in x)) && leaks(mine).length === 0, 'myOrders: hech bir buyurtmada finance yo‘q');
  ok(JSON.stringify(mineRow) === JSON.stringify(withoutFinance), 'myOrders: qolgan barcha maydonlar AYNAN o‘zgarmagan (faqat finance olingan)');

  const one = norm(await call(orderController.getOne, { params: { id: String(sg._id) }, userId: String(uid) }));
  ok(!('finance' in one) && leaks(one).length === 0 && JSON.stringify(one) === JSON.stringify(withoutFinance), 'getOne: finance yo‘q, qolgani aynan shu');

  const grp = norm(await call(orderController.getGroup, { params: { groupId: 'g-sock-1' }, userId: String(uid) }));
  ok(grp.length === 1 && !('finance' in grp[0]) && grp[0]._id === String(sg._id), 'getGroup: finance yo‘q');

  const dl = await mk({ status: 'delivering' });
  const cd = norm(await call(orderController.confirmDelivery, { params: { id: String(dl._id) }, body: {}, user: { _id: uid, userId: String(uid) }, userId: String(uid) }));
  ok(cd._id === String(dl._id) && cd.status === 'delivered' && !('finance' in cd) && leaks(cd).length === 0, 'confirmDelivery ("Ha, oldim"): holat yangilandi, finance yo‘q');

  const act = norm(await call(orderController.active, { userId: String(uid) }));
  ok(Array.isArray(act) && act.length >= 1 && act.every((x) => !('finance' in x)) && leaks(act).length === 0, 'active (faol buyurtmalar): finance yo‘q');
  const cn = await mk({ status: 'pending' });
  const cc = norm(await call(orderController.cancelOrder, { params: { id: String(cn._id) }, body: { reason: 'sinov' }, userId: String(uid), user: { _id: uid, userId: String(uid) } }));
  ok(cc && cc._id === String(cn._id) && cc.status === 'cancelled' && !('finance' in cc) && leaks(cc).length === 0, 'cancelOrder: bekor qilindi, javobda finance yo‘q');

  // begona foydalanuvchi buyurtmasini ko'ra olmaydi (avvalgi himoya saqlangan)
  const stranger = new mongoose.Types.ObjectId();
  const miss = await call(orderController.getOne, { params: { id: String(sg._id) }, userId: String(stranger) });
  ok(miss && miss.error === 'Buyurtma topilmadi', 'begona mijoz buyurtmani ko‘ra olmaydi (404)');

  const src = readFileSync('src/controllers/misc.js', 'utf8');
  const handlerBody = (name) => { const i = src.indexOf(`\n  ${name}: asyncHandler(`); const rest = src.slice(i + 5); const n = rest.search(/\n  [a-zA-Z]+: asyncHandler\(/); return rest.slice(0, n === -1 ? undefined : n); };
  const customerHandlers = ['myOrders', 'getGroup', 'getOne', 'confirmDelivery', 'cancelOrder', 'active', 'create'];
  const raw = customerHandlers.filter((h) => /res(\.status\(\d+\))?\.json\(((order|orders)\)|\{[^}]*orders: created[,\s}])/.test(handlerBody(h)) || !/customerOrderView/.test(handlerBody(h)));
  ok(raw.length === 0, `QO‘RIQCHI: mijoz handlerlarining hammasi customerOrderView ishlatadi (ishlatmaydi: ${raw.join(', ') || 'yo‘q'})`);
}

console.log(fails ? `\n✗ ${fails} ta xato` : '\n✓ HAMMASI O‘TDI');
await mongoose.disconnect();
process.exit(fails ? 1 : 0);
