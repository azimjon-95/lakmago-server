/*
 * RESTORAN ILOVASI — admin panel akkaunti bilan to'g'ridan-to'g'ri ulanish (gateway'siz).
 *  [1] Soket: handshake JWT → faqat O'Z restoran xonasi (haqiqiy Socket.IO server + client)
 *  [2] Yetkazish eslatmasi ilovaga soket orqali yetadi
 *  [3] Sessiyani yangilash (sliding): faqat faol restoran akkaunti
 *  [4] Marshrutlar: auth/rol himoyasi, tartib (/orders/history `/:id` dan oldin), eski gateway yo'q
 * Baza KERAK EMAS (User modeli soxtalashtiriladi). npm run test:restaurant-app
 */
import http from 'node:http';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(40);
const jwt = (await import('jsonwebtoken')).default;
const { config } = await import('../src/config/index.js');
const { User } = await import('../src/models/User.js');
const { initSocket, getIO } = await import('../src/sockets/io.js');
const { restaurantRoomFromToken } = await import('../src/sockets/restaurantSocketAuth.js');
const { notifyRestaurantApp } = await import('../src/services/restaurantReminders.js');
const { restaurantAppController: C } = await import('../src/controllers/restaurantApp.js');
const { io: ioc } = await import('socket.io-client');

let fails = 0;
const ok = (c, m) => { console.log(c ? '  ✓' : '  ✗ FAIL:', m); if (!c) fails++; };
const R1 = 'a'.repeat(24); const R2 = 'b'.repeat(24);
const users = {
  u1: { _id: 'u1', role: 'restaurant', isActive: true, restaurantId: R1 },
  u2: { _id: 'u2', role: 'restaurant', isActive: true, restaurantId: R2 },
  off: { _id: 'off', role: 'restaurant', isActive: false, restaurantId: R1 },
  moved: { _id: 'moved', role: 'restaurant', isActive: true, restaurantId: R2 },
  adm: { _id: 'adm', role: 'admin', isActive: true, restaurantId: null },
};
User.findById = (id) => ({ select: () => ({ lean: async () => users[id] || null }) });
const tok = (userId, role, restaurantId) => jwt.sign({ userId, role, restaurantId }, config.jwtSecret, { expiresIn: '30d' });

console.log('\n[1a] Tokendan xona (birlik)');
ok(await restaurantRoomFromToken(tok('u1', 'restaurant', R1)) === `restaurant:${R1}`, 'faol restoran → o‘z xonasi');
ok(await restaurantRoomFromToken(tok('off', 'restaurant', R1)) === null, 'bloklangan akkaunt → xona yo‘q');
ok(await restaurantRoomFromToken(tok('moved', 'restaurant', R1)) === null, 'boshqa restoranga ko‘chirilgan (eski token) → xona yo‘q');
ok(await restaurantRoomFromToken(tok('adm', 'admin', null)) === null, 'admin tokeni → restoran xonasi yo‘q');
ok(await restaurantRoomFromToken(jwt.sign({ userId: 'u1', role: 'restaurant', restaurantId: R1 }, 'boshqa-kalit-'.repeat(4))) === null, 'soxta imzo → rad');
ok(await restaurantRoomFromToken('') === null && await restaurantRoomFromToken(undefined) === null, 'token yo‘q → rad');

console.log('\n[1b] Haqiqiy Socket.IO: handshake JWT');
const srv = http.createServer(); initSocket(srv);
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${srv.address().port}`;
const connect = (auth) => new Promise((res) => {
  const s = ioc(url, { transports: ['websocket'], auth, reconnection: false });
  const got = []; s.onAny((ev, data) => got.push([ev, data]));
  s.on('connect', () => setTimeout(() => res({ s, got }), 250));
  s.on('connect_error', () => res({ s, got, err: true }));
});
const a = await connect({ token: tok('u1', 'restaurant', R1) });
const b = await connect({ token: tok('u2', 'restaurant', R2) });
const guest = await connect({});
const bad = await connect({ token: 'yaroqsiz' });
ok(!a.err && a.got.some(([e, d]) => e === 'restaurant:joined' && d.ok === true), 'restoran ilovasi ulandi va o‘z xonasiga qo‘shildi');
ok(!guest.err && !guest.got.some(([e]) => e === 'restaurant:joined'), 'tokensiz (mijoz/panel) ulanish o‘zgarishsiz ishlaydi');
ok(!bad.err && bad.got.some(([e, d]) => e === 'restaurant:joined' && d.ok === false), 'yaroqsiz token: ulanish uzilmaydi, xonaga qo‘shilmaydi');
getIO().to(`restaurant:${R1}`).emit('order:new', { _id: 'o1' });
await new Promise((r) => setTimeout(r, 200));
ok(a.got.some(([e, d]) => e === 'order:new' && d._id === 'o1'), 'R1 buyurtmasi R1 ilovasiga yetdi');
ok(!b.got.some(([e]) => e === 'order:new') && !guest.got.some(([e]) => e === 'order:new') && !bad.got.some(([e]) => e === 'order:new'), 'boshqa restoran, mijoz va yaroqsiz token uni EShITMADI');
const before = a.s.listeners ? null : null;
a.s.emit('join:android:restaurant', { restaurantId: R2, pincode: '0000' });
await new Promise((r) => setTimeout(r, 150));
getIO().to(`restaurant:${R2}`).emit('order:new', { _id: 'o2' });
await new Promise((r) => setTimeout(r, 150));
ok(!a.got.some(([e, d]) => e === 'order:new' && d._id === 'o2'), 'eski PIN gateway hodisasi (join:android:restaurant) endi ishlamaydi');

console.log('\n[2] Yetkazish eslatmasi ilovaga');
const okR1 = await notifyRestaurantApp({ _id: 'ord9', restaurantId: R1 }, 2);
await new Promise((r) => setTimeout(r, 150));
ok(okR1 === true && a.got.some(([e, d]) => e === 'order:delivery-reminder' && d.orderId === 'ord9' && d.reminderCount === 2), 'ulangan ilova eslatmani oldi; "yetkazildi" deb hisoblandi');
ok(!b.got.some(([e]) => e === 'order:delivery-reminder'), 'boshqa restoran eslatmani olmadi');
const okNone = await notifyRestaurantApp({ _id: 'ord8', restaurantId: 'c'.repeat(24) }, 1);
ok(okNone === false, 'ilova ulanmagan restoran: false (Telegram oqimi avvalgidek hal qiladi)');
[a, b, guest, bad].forEach(({ s }) => s.close()); getIO().close(); srv.close();

console.log('\n[3] Sessiyani yangilash');
const call = async (req) => { let code = 200; let body; await C.refreshSession(req, { status(c) { code = c; return this; }, set() { return this; }, json(b) { body = b; return this; } }, (e) => { throw e; }); return { code, body }; };
let r = await call({ userId: 'u1', restaurantId: R1 });
const p = r.body?.token && jwt.verify(r.body.token, config.jwtSecret);
ok(r.code === 200 && p && p.userId === 'u1' && p.role === 'restaurant' && p.restaurantId === R1, 'faol akkaunt: yangi 30 kunlik token (o‘sha restoran)');
ok(p && p.exp - p.iat === 30 * 24 * 3600, 'muddati 30 kun');
ok((await call({ userId: 'off', restaurantId: R1 })).code === 401, 'bloklangan akkaunt: 401 (ilova chiqadi)');
ok((await call({ userId: 'moved', restaurantId: R1 })).code === 401, 'restorani o‘zgargan akkaunt: 401');
ok((await call({ userId: 'nobody', restaurantId: R1 })).code === 401, 'o‘chirilgan akkaunt: 401');

console.log('\n[4] Marshrutlar');
const { default: router } = await import('../src/routes/index.js').then((m) => ({ default: m.router || m.default }));
const layers = router.stack.filter((l) => l.route).map((l) => ({ path: l.route.path, methods: Object.keys(l.route.methods), names: l.route.stack.map((x) => x.name) }));
const find = (m, path) => layers.findIndex((l) => l.path === path && l.methods.includes(m));
for (const [m, path] of [['get', '/panel/orders/history'], ['get', '/panel/stats'], ['get', '/panel/orders/:id'], ['post', '/panel/orders/:id/confirm-delivered'], ['post', '/panel/session/refresh']]) {
  const i = find(m, path);
  ok(i >= 0 && layers[i].names[0] === 'auth' && layers[i].names.length >= 3, `${m.toUpperCase()} ${path} — mavjud, auth + rol himoyasi bilan`);
}
ok(find('get', '/panel/orders/history') < find('get', '/panel/orders/:id'), '/orders/history `/:id` dan OLDIN (tarix ID deb o‘qilmaydi)');
ok(!layers.some((l) => /android-pin/.test(l.path)), 'android-pin marshrutlari yo‘q');

console.log(fails ? `\n✗ ${fails} ta xato` : '\n✓ Hammasi o‘tdi');
process.exit(fails ? 1 : 0);
