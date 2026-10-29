/*
 * APP STORE DEMO HISOB + HISOBNI O'CHIRISH — HAQIQIY baza (MONGO_URI).  npm run test:demo
 * Demo haqiqiy dunyoga tegmasligi, haqiqiy mijozlar esa avvalgidek ishlashi isbotlanadi.
 */
import http from 'node:http';
import mongoose from 'mongoose';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(48);
process.env.DEMO_LOGIN_ENABLED = 'true';
process.env.DEMO_LOGIN = 'appreview';
process.env.DEMO_PASSWORD = 'ParolBilanDemo123';

const { config } = await import('../src/config/index.js');
const { User } = await import('../src/models/User.js');
const { Order } = await import('../src/models/Order.js');
const { Restaurant } = await import('../src/models/Restaurant.js');
const { Dish } = await import('../src/models/Dish.js');
const { Session } = await import('../src/models/Session.js');
const { AuthIdentity } = await import('../src/models/AuthIdentity.js');
const { PushSubscription } = await import('../src/models/PushSubscription.js');
const { Address } = await import('../src/models/Address.js');
const demo = await import('../src/services/demoAccount.js');
const { orderController, completeTelegramAuth } = await import('../src/controllers/misc.js');
const { demoController } = await import('../src/controllers/demo.js');
const { userProfileController } = await import('../src/controllers/userProfile.js');
const { restaurantController, catalogController } = await import('../src/controllers/catalog.js').then((m) => ({ restaurantController: m.restaurantController, catalogController: m.restaurantController }));
const { deleteAccount } = await import('../src/services/accountDeletion.js');
const { initSocket, getIO } = await import('../src/sockets/io.js');

await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/lokma_demo_test');
for (const M of [User, Order, Restaurant, Dish, Session, AuthIdentity, PushSubscription, Address]) await M.deleteMany({}).setOptions({ includeDemo: true });

let fails = 0; const ok = (c, m) => { console.log(c ? '  ✓' : '  ✗ FAIL:', m); if (!c) fails++; };
const silent = { log() {}, error() {}, warn() {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const call = async (fn, req) => {
  let status = 200; let body = null;
  const res = { headers: {}, status(c) { status = c; return this; }, json(b) { body = b; return this; }, set(k, v) { this.headers[k] = v; return this; } };
  await fn({ headers: {}, query: {}, ...req }, res, (e) => { body = { next: e?.message }; status = 500; });
  await sleep(120);
  return { status, body };
};

// Soket hodisalarini kuzatish: kim qaysi xonaga nima yubordi
initSocket(http.createServer());
const emitted = [];
{
  const io = getIO(); const origTo = io.to.bind(io);
  io.to = (room) => { const t = origTo(room); const oe = t.emit.bind(t); t.emit = (ev, payload) => { emitted.push({ room: String(room), ev, payload }); return oe(ev, payload); }; return t; };
}
const roomsOf = (since) => emitted.slice(since).map((e) => e.room);

const REAL = await Restaurant.create({ name: 'Haqiqiy TOTLI', cuisine: 'x', category: 'restoran', isActive: true, isApproved: true, lat: 41.3111, lng: 69.2797, address: 'Sang', deliveryEnabled: true, pickupEnabled: true, cashEnabled: true, deliveryFee: 0, openTime: '00:00', closeTime: '23:59', workingDays: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] });
const REAL_DISH = await Dish.create({ restaurantId: REAL._id, section: 'menu', name: 'Pasta', price: 50000 });
const realUser = await User.create({ firstName: 'Haqiqiy', telegramId: '777001', phone: '+998901112233' });

console.log('\n[1] Demo ma’lumotlari (idempotent, xavfsiz sozlash)');
const r1 = await demo.ensureDemoData(silent);
ok(r1.ok && demo.isDemoReady(), 'ensureDemoData muvaffaqiyatli, demo TAYYOR');
const dRest = await Restaurant.findOne({ isDemo: true }).lean();
ok(dRest && dRest.name === 'LokmaGo Demo' && dRest.isActive === false && dRest.isApproved === true, 'demo restoran NOFAOL (umumiy ro‘yxatlarda hech kimga ko‘rinmaydi)');
ok(dRest.delivery.maxDistanceKm === 0 && dRest.delivery.pricingMode === 'flat', 'yetkazish radiusi cheklanmagan (tekshiruvchi AQSHdan bo‘lishi mumkin), narx bitta');
ok(dRest.workingDays.length === 7 && dRest.openTime === '00:00', 'har kuni, kun bo‘yi ochiq');
const dDishes = await Dish.find({ restaurantId: dRest._id }).lean(); ok(dDishes.length === 8, `menyu: ${dDishes.length} ta taom`);
const dUser = await User.findOne({ isDemo: true }).lean();
ok(dUser.login === 'appreview' && dUser.role === 'customer' && dUser.status === 'ACTIVE', 'demo mijoz hisobi: login appreview, role customer');
ok(!JSON.stringify(dUser).includes('ParolBilanDemo123') && dUser.passwordHash.startsWith('$2'), 'parol bazada FAQAT bcrypt xeshi');
ok(dUser.addresses.length === 1 && String(dUser.defaultAddressId) === String(dUser.addresses[0]._id) && dUser.phoneVerified, 'saqlangan manzil va tasdiqlangan telefon bor — buyurtma berish uchun hammasi tayyor');
const r2 = await demo.ensureDemoData(silent);
ok(r2.userId === r1.userId && r2.restaurantId === r1.restaurantId, 'qayta ishga tushirish: bir xil hisob va restoran');
ok((await Restaurant.countDocuments({ isDemo: true })) === 1 && (await User.countDocuments({ isDemo: true })) === 1 && (await Dish.countDocuments({ restaurantId: dRest._id })) === 8, 'takrorlanish YO‘Q (1 restoran, 1 hisob, 8 taom)');

console.log('\n[2] Demo kirish');
const lg = await demo.demoLogin({ login: 'AppReview', password: 'ParolBilanDemo123', platform: 'ios', deviceId: 'apple-1' });
ok(lg.demo === true && lg.token && lg.accessToken && lg.refreshToken && lg.user.isDemo === true, 'kirish: token, accessToken, refreshToken, user.isDemo (login katta-kichik harfga sezgir emas)');
ok(!('passwordHash' in JSON.parse(JSON.stringify(lg.user))), 'javobda parol xeshi YO‘Q');
const sess = await Session.findOne({ userId: dUser._id });
ok(sess && sess.platform === 'ios' && sess.deviceId === 'apple-1', 'sessiya yaratildi (platform ios)');
const err = async (args) => { try { await demo.demoLogin(args); return null; } catch (e) { return e; } };
ok((await err({ login: 'appreview', password: 'noto‘g‘ri-parol' }))?.status === 401, 'noto‘g‘ri parol → 401');
const e1 = await err({ login: 'mavjud-emas', password: 'ParolBilanDemo123' }); const e2 = await err({ login: 'appreview', password: 'xato' });
ok(e1?.status === 401 && e1.message === e2.message, 'mavjud bo‘lmagan login ham 401 va BIR XIL xabar (login mavjudligi bilinmaydi)');
ok((await err({ login: '', password: '' }))?.status === 400, 'bo‘sh login/parol → 400');
const imposter = await User.create({ firstName: 'Admin?', login: 'boshqa', passwordHash: User.hashPassword('Boshqa-parol-123'), role: 'admin' });
ok((await err({ login: 'boshqa', password: 'Boshqa-parol-123' }))?.status === 401, 'demo endpoint orqali haqiqiy (admin) hisobga kirib BO‘LMAYDI');
config.demoLoginEnabled = false;
ok((await err({ login: 'appreview', password: 'ParolBilanDemo123' }))?.status === 404, 'DEMO_LOGIN_ENABLED=false → 404 (kirish yopiq)');
const capOff = await call(demoController.capabilities, {}); ok(capOff.body.demoLogin === false && capOff.body.accountDeletion === true, 'capabilities: demo yopiq → ilovada forma ko‘rinmaydi');
config.demoLoginEnabled = true;
const capOn = await call(demoController.capabilities, {}); ok(capOn.body.demoLogin === true && capOn.body.v === 2, 'capabilities: demo yoqiq');

console.log('\n[3] Parol almashtirish va xavfli sozlamalar');
config.demoPassword = 'YangiParol-98765';
await demo.ensureDemoData(silent);
ok((await err({ login: 'appreview', password: 'ParolBilanDemo123' }))?.status === 401 && (await demo.demoLogin({ login: 'appreview', password: 'YangiParol-98765' })).token, 'parol almashdi: eskisi o‘tmaydi, yangisi ishlaydi');
ok((await Session.countDocuments({ userId: dUser._id, revokedAt: null })) === 1, 'parol almashganda eski sessiyalar bekor qilindi (faqat yangi kirish qoldi)');
config.demoPassword = 'qisqa'; const rs = await demo.ensureDemoData(silent);
ok(rs.reason === 'config' && !demo.isDemoReady(), 'parol 10 belgidan qisqa → demo YOPIQ');
config.demoPassword = 'YangiParol-98765'; config.demoLogin = 'boshqa';
const rc = await demo.ensureDemoData(silent); ok(rc.reason === 'login-taken' && !demo.isDemoReady(), 'DEMO_LOGIN haqiqiy hisobning loginiga teng → demo YOPIQ (hisobni egallab olmaydi)');
config.demoLogin = 'appreview'; ok((await demo.ensureDemoData(silent)).ok && demo.isDemoReady(), 'sozlama tuzatilgach — yana tayyor');
await User.deleteOne({ _id: imposter._id });

console.log('\n[4] Menyu ko‘rinishi: ro‘yxatda YO‘Q, id bo‘yicha BOR');
{
  // Ro'yxat/trending/dishes kontrollerlari AYNAN shu filtrdan foydalanadi (catalog.js: isApproved && isActive && !isBlocked).
  // (Kontrollerning o'zi MongoDB agregatsiyasidan foydalanadi — sinov bazasi (FerretDB) uni qo'llamaydi; ularga tegilmagan.)
  const visible = await Restaurant.find({ isApproved: true, isActive: true, isBlocked: { $ne: true } }).select('name').lean();
  const names = visible.map((r) => r.name);
  ok(names.includes('Haqiqiy TOTLI') && !names.includes('LokmaGo Demo'), `umumiy ro‘yxat filtri: haqiqiy restoran bor, DEMO yo‘q (${names.join(', ')})`);
  ok((await Dish.find({ restaurantId: { $in: visible.map((r) => r._id) } }).lean()).every((d) => String(d.restaurantId) !== String(dRest._id)), 'ro‘yxatlardagi taomlar orasida demo restoran taomlari YO‘Q');
  const one = await call(restaurantController.getOne, { params: { id: String(dRest._id) } });
  ok(one.status === 200 && one.body.name === 'LokmaGo Demo', 'demo restoran sahifasi id bo‘yicha ochiladi');
  const dishes = await call(restaurantController.getDishes, { params: { id: String(dRest._id) } });
  ok(Array.isArray(dishes.body) && dishes.body.length === 8, 'demo restoran menyusi: 8 ta taom');
  const dead = await Restaurant.create({ name: 'Nofaol haqiqiy', cuisine: 'x', category: 'restoran', isActive: false, isApproved: true });
  ok((await call(restaurantController.getOne, { params: { id: String(dead._id) } })).status === 404, 'oddiy NOFAOL restoran avvalgidek 404 (istisno faqat demo uchun)');
}

console.log('\n[5] Demo buyurtma: sandbox, yon ta’sirlarsiz');
const demoDish = dDishes.find((d) => d.name === 'Lagmon');
const mkBody = (rest, dish, over = {}) => ({
  address: 'Toshkent, Demo ko‘cha 1', addressLat: 41.3115, addressLng: 69.241, phone: '+998900000000', paymentMethod: 'cash', paymentLabel: 'Naqd', fulfillment: 'delivery', timingMode: 'asap',
  orders: [{ restaurantId: String(rest._id), restaurantName: rest.name, subtotal: dish.price, deliveryFee: 8000, items: [{ dishId: String(dish._id), name: dish.name, quantity: 1, unitPrice: dish.price }] }], ...over,
});
const place = (userId, body) => call(orderController.create, { userId: String(userId), user: { _id: userId }, body });
let mark = emitted.length;
const d1 = await place(dUser._id, mkBody(dRest, demoDish));
ok(d1.status === 201, `demo foydalanuvchi demo restoranga buyurtma berdi (${d1.status} ${d1.body?.error || ''})`);
const dOrder = await Order.findOne({ userId: dUser._id }).setOptions({ includeDemo: true }).lean();
ok(dOrder?.isDemo === true && dOrder.status === 'pending' && String(dOrder.restaurantId) === String(dRest._id), 'buyurtma isDemo=true, holat pending, demo restoranda');
ok(!roomsOf(mark).some((r) => r.startsWith('restaurant:') || r === 'admin'), `restoran va admin soket xonalariga HECH NARSA yuborilmadi (${roomsOf(mark).join(',') || 'yo‘q'})`);
mark = emitted.length;
const nonCash = await place(dUser._id, mkBody(dRest, demoDish, { paymentMethod: 'click' }));
ok(nonCash.status === 400 && nonCash.body.code === 'DEMO_CASH_ONLY', 'demo: karta/onlayn to‘lov rad etildi (faqat naqd — hech narsa olinmaydi)');
const toReal = await place(dUser._id, mkBody(REAL, REAL_DISH));
ok(toReal.status === 403 && toReal.body.code === 'DEMO_RESTAURANT_ONLY', 'demo foydalanuvchi HAQIQIY restoranga buyurtma bera OLMAYDI');
ok((await Order.countDocuments({ restaurantId: REAL._id })) === 0, 'haqiqiy restoranda hech qanday buyurtma paydo bo‘lmadi');
const realToDemo = await place(realUser._id, mkBody(dRest, demoDish));
ok(realToDemo.status === 400 && realToDemo.body.code === 'RESTAURANT_UNAVAILABLE', 'haqiqiy mijoz demo restoranga buyurtma bera OLMAYDI');
mark = emitted.length;
const real1 = await place(realUser._id, mkBody(REAL, REAL_DISH, { orders: [{ restaurantId: String(REAL._id), restaurantName: REAL.name, subtotal: 50000, deliveryFee: 0, items: [{ dishId: String(REAL_DISH._id), name: 'Pasta', quantity: 1, unitPrice: 50000 }] }] }));
ok(real1.status === 201, `REGRESSIYA: haqiqiy mijoz haqiqiy restoranga avvalgidek buyurtma beradi (${real1.status} ${real1.body?.error || ''})`);
const rOrder = await Order.findOne({ userId: realUser._id }).lean();
ok(rOrder && rOrder.isDemo === undefined, 'haqiqiy buyurtmada isDemo maydoni YO‘Q (eski buyurtmalar bilan bir xil)');
ok(roomsOf(mark).some((r) => r === 'admin') && roomsOf(mark).some((r) => r.startsWith('restaurant:')), 'REGRESSIYA: haqiqiy buyurtma restoran va adminga avvalgidek xabar beradi');

console.log('\n[6] Standart qamrov: demo buyurtma hisobotlarda ko‘rinmaydi');
ok((await Order.find({})).length === 1 && (await Order.countDocuments({})) === 1, 'Order.find({}) va countDocuments — faqat HAQIQIY buyurtma (1 ta)');
const agg = await Order.aggregate([{ $group: { _id: null, n: { $sum: 1 } } }]); ok(agg[0]?.n === 1, 'Order.aggregate — demo chiqarib tashlangan (statistika/daromad toza)');
ok((await Order.find({ restaurantId: dRest._id })).length === 0, 'demo restoran bo‘yicha so‘rov (billing/hisobot kabi) — bo‘sh');
ok((await Order.find({ userId: dUser._id })).length === 1, 'mijozning O‘Z so‘rovi (userId bilan) — demo buyurtmasini ko‘radi (ro‘yxat, kuzatuv)');
ok((await Order.find({}).setOptions({ includeDemo: true })).length === 2, 'includeDemo bilan — ikkalasi ham');
ok((await Order.aggregate([{ $group: { _id: null, n: { $sum: 1 } } }]).option({ includeDemo: true }))[0].n === 2, 'aggregate + includeDemo — ikkalasi ham');
ok((await Order.findById(dOrder._id)) === null && (await Order.findOne({ _id: dOrder._id, userId: dUser._id })) !== null, 'id bo‘yicha (userIdsiz) topilmaydi, mijoz o‘zi (userId bilan) topadi');
await Order.updateMany({ status: 'pending' }, { $set: { cancelReason: 'ommaviy-yangilash' } });
ok((await Order.findOne({ _id: dOrder._id, userId: dUser._id }).lean()).cancelReason !== 'ommaviy-yangilash', 'ommaviy updateMany demo buyurtmaga TEGMADI');
await Order.deleteMany({ status: 'pending' });
ok((await Order.countDocuments({ userId: dUser._id })) === 1, 'ommaviy deleteMany demo buyurtmani o‘chirmadi');
await Order.deleteMany({ userId: realUser._id });

console.log('\n[7] Simulyator: holatlar vaqt bo‘yicha');
{
  const T = (s) => demo.demoStageAt(new Date(0), 'delivery', s * 1000);
  ok([T(0), T(7), T(8), T(22), T(55), T(70), T(100), T(9999)].join() === 'pending,pending,accepted,preparing,ready,delivering,delivered,delivered', 'yetkazish: pending → accepted(8s) → preparing(22s) → ready(55s) → delivering(70s) → delivered(100s)');
  ok([demo.demoStageAt(new Date(0), 'pickup', 49000), demo.demoStageAt(new Date(0), 'pickup', 50000), demo.demoStageAt(new Date(0), 'pickup', 85000)].join() === 'preparing,ready,delivered', 'olib ketish: yetkazish bosqichisiz');
  ok(demo.demoStageAt(new Date(0), 'delivery', 2300, 10) === 'preparing', 'tezlashtirish (DEMO_SIM_SPEED=10): 2.3 s = 23 s → preparing');
}
mark = emitted.length;
const t0 = new Date(dOrder.createdAt).getTime();
let moved = await demo.tickDemoOrders(t0 + 9000, 1);
let cur = await Order.findOne({ _id: dOrder._id, userId: dUser._id }).lean();
ok(moved === 1 && cur.status === 'accepted' && cur.acceptedAt, '9-soniyada: accepted, acceptedAt yozildi');
ok(roomsOf(mark).every((r) => r === `order:${dOrder._id}` || r === `user:${dUser._id}`) && roomsOf(mark).length === 2, `mijozga xabar BORDI (order: va user: xonalari), restoran/adminga YO‘Q (${roomsOf(mark).join(', ')})`);
ok((await demo.tickDemoOrders(t0 + 9000, 1)) === 0, 'xuddi shu vaqtda qayta — hech narsa o‘zgarmaydi (idempotent)');
await demo.tickDemoOrders(t0 + 60000, 1); cur = await Order.findOne({ _id: dOrder._id, userId: dUser._id }).lean(); ok(cur.status === 'ready' && cur.preparingAt && cur.readyAt, '60-soniyada: sakrab ready (oraliq vaqtlar yozildi)');
await demo.tickDemoOrders(t0 + 101000, 1); cur = await Order.findOne({ _id: dOrder._id, userId: dUser._id }).lean(); ok(cur.status === 'delivered' && cur.deliveredAt, '101-soniyada: delivered');
ok((await demo.tickDemoOrders(t0 + 500000, 1)) === 0, 'yakunlangach simulyator unga tegmaydi');
const d2 = await place(dUser._id, mkBody(dRest, demoDish));
const o2 = await Order.findOne({ userId: dUser._id, status: 'pending' }).setOptions({ includeDemo: true });
mark = emitted.length;
const canc = await call(orderController.cancelOrder, { userId: String(dUser._id), params: { id: String(o2._id) } });
ok(canc.status === 200 && (await Order.findOne({ _id: o2._id, userId: dUser._id }).lean()).status === 'cancelled', 'demo buyurtmani mijoz bekor qila oladi');
ok(roomsOf(mark).every((r) => !r.startsWith('restaurant:') && r !== 'admin'), 'bekor qilishda ham restoran/adminga xabar YO‘Q');
await demo.tickDemoOrders(Date.now() + 200000, 1);
ok((await Order.findOne({ _id: o2._id, userId: dUser._id }).lean()).status === 'cancelled', 'bekor qilingan buyurtmani simulyator "tiriltirmaydi"');
await Order.collection.updateOne({ _id: o2._id }, { $set: { createdAt: new Date(Date.now() - 25 * 3600 * 1000) } });   // createdAt o'zgarmas (immutable) — to'g'ridan-to'g'ri
await demo.tickDemoOrders(Date.now() + 11 * 60 * 1000, 1);
ok((await Order.countDocuments({ _id: o2._id, userId: dUser._id })) === 0, '24 soatdan eski demo buyurtma avtomatik o‘chirildi');

console.log('\n[8] Hisobni o‘chirish');
const delUser = await User.create({ firstName: 'Ali', lastName: 'Valiyev', username: 'ali_v', telegramId: '555001', phone: '+998909998877', phoneVerified: true, photoUrl: 'https://x/y.jpg', bonusBalance: 5000,
  addresses: [{ title: 'Uy', address: 'Namangan', lat: 41, lng: 71 }], cards: [{ last4: '4242', brand: 'visa' }] });
await Address.create({ userId: delUser._id, title: 'Uy', address: 'Namangan', lat: 41, lng: 71 });
await AuthIdentity.create({ userId: delUser._id, provider: 'telegram', providerUserId: '555001' });
await PushSubscription.create({ userId: delUser._id, endpoint: 'https://push/1', keys: { p256dh: 'a', auth: 'b' }, role: 'customer' }).catch(() => {});
await Session.create({ userId: delUser._id, refreshTokenHash: 'h1', platform: 'ios', expiresAt: new Date(Date.now() + 1e9) });
const activeOrder = await Order.create({ userId: delUser._id, restaurantId: REAL._id, restaurantName: REAL.name, items: [{ name: 'Pasta', quantity: 1, unitPrice: 50000 }], subtotal: 50000, total: 50000, status: 'preparing', fulfillment: 'pickup', paymentMethod: 'cash' });
let e = null; try { await deleteAccount(delUser._id); } catch (x) { e = x; }
ok(e?.status === 409 && e.code === 'ACTIVE_ORDERS', 'faol buyurtma bor → 409 (o‘chirib bo‘lmaydi)');
await Order.updateOne({ _id: activeOrder._id }, { $set: { status: 'delivered' } });
const del = await deleteAccount(delUser._id);
const after = await User.findById(delUser._id).lean();
ok(del.ok && after.status === 'DELETED' && after.deletedAt, 'hisob o‘chirildi: status DELETED, deletedAt');
ok(after.firstName === 'Foydalanuvchi' && !after.lastName && !after.username && !after.phone && !after.photoUrl && after.addresses.length === 0 && after.cards.length === 0 && after.bonusBalance === 0 && !after.defaultAddressId, 'shaxsiy ma’lumotlar tozalandi (ism, username, telefon, rasm, manzil, karta, bonus)');
ok((await Address.countDocuments({ userId: delUser._id })) === 0 && (await AuthIdentity.countDocuments({ userId: delUser._id })) === 0, 'manzillar (alohida kolleksiya) va Telegram bog‘lanishi o‘chirildi');
ok((await Session.countDocuments({ userId: delUser._id, revokedAt: null })) === 0, 'barcha sessiyalar bekor qilindi');
ok(after.telegramId === undefined, 'telegramId bo‘shatildi');
ok((await Order.countDocuments({ userId: delUser._id })) === 1, 'buyurtma tarixi hisob-kitob uchun SAQLANDI');
const again = await deleteAccount(delUser._id); ok(again.already === true, 'qayta o‘chirish xavfsiz (idempotent)');
const meDeleted = await call(userProfileController.me, { userId: String(delUser._id) }); ok(meDeleted.status === 401 && meDeleted.body.code === 'ACCOUNT_DELETED', 'o‘chirilgan hisobning eski tokeni: /users/me → 401 (ilova mehmon holatiga qaytadi)');
const ordDeleted = await place(delUser._id, mkBody(REAL, REAL_DISH)); ok(ordDeleted.status === 401 && ordDeleted.body.code === 'ACCOUNT_DELETED', 'o‘chirilgan hisob eski token bilan buyurtma bera OLMAYDI');
const fresh = await completeTelegramAuth({ id: 555001, first_name: 'Yangi' }, { platform: 'ios' });
ok(String(fresh.user._id) !== String(delUser._id) && fresh.isNewUser === true && fresh.user.firstName === 'Yangi', 'xuddi shu Telegram bilan qayta kirsa — YANGI bo‘sh hisob (eski ma’lumot tiklanmaydi)');
let ed = null; try { await deleteAccount(dUser._id); } catch (x) { ed = x; } ok(ed?.status === 403 && ed.code === 'DEMO_ACCOUNT', 'demo hisobni o‘chirib bo‘lmaydi');
let ea = null; try { await deleteAccount(imposter._id); } catch (x) { ea = x; } ok(ea?.status === 404, 'mavjud bo‘lmagan hisob → 404');
const adm = await User.create({ firstName: 'Admin', login: 'adm1', passwordHash: User.hashPassword('Parol-12345-x'), role: 'admin' });
let ep = null; try { await deleteAccount(adm._id); } catch (x) { ep = x; } ok(ep?.status === 403, 'panel hisobi (admin/restoran) ilovadan o‘chirilmaydi');
const restricted = await User.create({ firstName: 'Cheklangan', telegramId: '555002', phone: '+998901010101', cashDisabled: { active: true, reason: 'sabab', at: new Date() } });
const rd = await deleteAccount(restricted._id); const ra = await User.findById(restricted._id).lean();
ok(rd.retainedRestriction === true && ra.telegramId === '555002' && ra.cashDisabled.active && ra.status === 'DELETED' && !ra.phone, 'cheklovli mijoz: shaxsiy ma’lumot tozalandi, lekin telegramId (faqat cheklov uchun) saqlandi');
const back = await completeTelegramAuth({ id: 555002, first_name: 'Qaytdi' }, { platform: 'ios' });
ok(String(back.user._id) === String(restricted._id) && back.user.status === 'ACTIVE' && back.user.cashDisabled.active, 'cheklovli mijoz qayta kirdi: hisob tiklandi, naqd cheklovi SAQLANGAN (o‘chirib qutulib bo‘lmaydi)');
const blocked = await User.create({ firstName: 'Bloklangan', telegramId: '555003', status: 'BLOCKED', blockInfo: { reason: 'q', at: new Date() } });
await deleteAccount(blocked._id); ok((await User.findById(blocked._id).lean()).status === 'BLOCKED', 'bloklangan mijoz hisobini o‘chirsa ham BLOKLANGANICHA qoladi');

console.log(fails ? `\n✗ ${fails} ta xato` : '\n✓ Hammasi o‘tdi');
await mongoose.disconnect(); process.exit(fails ? 1 : 0);
