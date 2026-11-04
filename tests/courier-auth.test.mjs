/*
 * Kirish va ruxsatlar: kuryer PIN/token (services/courierAuth.js, middleware/courierAuth.js), soket xonalari
 * (sockets/panelSocketAuth.js — XAVFSIZLIK TUZATISHI) va pulga ta'sir qiluvchi yo'llarga kim kira oladi (routes/index.js).
 * Baza YO'Q. npm run test:courier-auth
 */
process.env.JWT_SECRET = 'x'.repeat(40);
import test from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { Types } from 'mongoose';
import { bindModel } from './helpers/fakeModel.mjs';

const { courierAuth, signCourierToken } = await import('../src/middleware/courierAuth.js');
const { CourierAccount } = await import('../src/models/CourierAccount.js');
const { config } = await import('../src/config/index.js');
const { canJoinAdmin, canJoinRestaurant, courierRoomsFromToken } = await import('../src/sockets/panelSocketAuth.js');
const { signToken } = await import('../src/middleware/auth.js');
const { router } = await import('../src/routes/index.js');

const sec = process.env.JWT_SECRET;
const verify = (t) => jwt.verify(t, sec);

test('kuryer akkaunti: parol bcrypt hash (xom parol saqlanmaydi), noto\'g\'ri parol rad etiladi', () => {
  const h = CourierAccount.hash('parol12345');
  assert.ok(h.startsWith('$2') && !h.includes('parol12345'));
  const acc = new CourierAccount({ login: 'ali', passwordHash: h, name: 'Ali' });
  assert.equal(acc.checkPassword('parol12345'), true);
  assert.equal(acc.checkPassword('parol12346'), false);
  assert.equal(acc.checkPassword(''), false);
});

const store = bindModel(CourierAccount, { docs: [] });
const res = () => { const r = { code: 200, body: null, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; } }; return r; };
async function runAuth(token) {
  const req = { headers: token ? { authorization: `Bearer ${token}` } : {} };
  const r = res(); let passed = false;
  await courierAuth(req, r, () => { passed = true; });
  return { passed, code: r.code, body: r.body, req };
}

test('kuryer middleware: token yo\'q / eski versiya (parol almashgan) / bloklangan / to\'g\'ri; boshqa tizim tokenlari kirmaydi', async () => {
  const c = { _id: new Types.ObjectId(), name: 'Ali', isActive: true, tokenVersion: 2, workDistricts: ['pop'] };
  store.docs.push(c);
  assert.equal((await runAuth(null)).code, 401);
  assert.equal((await runAuth('buzuq')).code, 401);
  assert.equal((await runAuth(signCourierToken(c._id, 1))).code, 401, 'parol almashgan — eski token darhol ishlamaydi');
  const ok = await runAuth(signCourierToken(c._id, 2));
  assert.equal(ok.passed, true);
  assert.equal(ok.req.courierId, String(c._id));
  assert.deepEqual(ok.req.courier.workDistricts, ['pop']);
  c.isActive = false;
  assert.equal((await runAuth(signCourierToken(c._id, 2))).code, 403, 'bloklangan');
  // asosiy kalit bilan yasalgan "kuryer" tokeni va admin/restoran tokenlari kuryer API'siga kirmaydi
  assert.equal((await runAuth(jwt.sign({ cid: String(c._id), role: 'courier', v: 2 }, sec))).code, 401);
  assert.equal((await runAuth(signToken('a1', 'admin'))).code, 401);
  assert.equal((await runAuth(signToken('r1', 'restaurant', 'R1'))).code, 401);
});

test('SOKET admin xonasi: faqat faol admin/xodim (avval tekshiruvsiz edi)', async () => {
  const users = { a1: { role: 'admin', isActive: true }, a2: { role: 'admin', isActive: false }, c1: { role: 'customer', isActive: true } };
  const staff = { s1: { isActive: true }, s2: { isActive: false } };
  const deps = { verify, findUser: async (id) => users[id] || null, findStaff: async (id) => staff[id] || null };
  assert.equal(await canJoinAdmin(signToken('a1', 'admin'), deps), true);
  assert.equal(await canJoinAdmin(signToken('a2', 'admin'), deps), false, 'bloklangan admin');
  assert.equal(await canJoinAdmin(signToken('s1', 'staff', null, 'order_control'), deps), true);
  assert.equal(await canJoinAdmin(signToken('s2', 'staff', null, 'marketing'), deps), false);
  assert.equal(await canJoinAdmin(signToken('c1', 'customer'), deps), false, 'mijoz');
  assert.equal(await canJoinAdmin(signToken('r1', 'restaurant', 'R1'), deps), false, 'restoran');
  assert.equal(await canJoinAdmin(undefined, deps), false, 'tokensiz (eski hujum yo\'li)');
  assert.equal(await canJoinAdmin(jwt.sign({ userId: 'a1', role: 'admin' }, 'boshqa-kalit'), deps), false, 'soxta imzo');
});

test('SOKET restoran xonasi: faqat o\'z restorani (yoki admin)', async () => {
  const users = { r1: { role: 'restaurant', isActive: true, restaurantId: 'R1' }, a1: { role: 'admin', isActive: true } };
  const deps = { verify, findUser: async (id) => users[id] || null, findRestaurantUser: async (id) => users[id] || null, findStaff: async () => null };
  assert.equal(await canJoinRestaurant(signToken('r1', 'restaurant', 'R1'), 'R1', deps), true);
  assert.equal(await canJoinRestaurant(signToken('r1', 'restaurant', 'R1'), 'R2', deps), false, 'boshqa restoran');
  assert.equal(await canJoinRestaurant(signToken('a1', 'admin'), 'R2', deps), true, 'admin');
  assert.equal(await canJoinRestaurant(undefined, 'R1', deps), false);
});

test('SOKET kuryer xonalari: o\'z xonasi + ish tumanlari; bloklangan / eski token / boshqa kalit — hech narsa', async () => {
  const c = { _id: new Types.ObjectId(), isActive: true, tokenVersion: 0, workDistricts: ['pop', 'chust'] };
  const deps = { verifyCourier: (t) => jwt.verify(t, config.courierJwtSecret), findCourier: async () => c };
  assert.deepEqual(await courierRoomsFromToken(signCourierToken(c._id, 0), deps), [`courier:${c._id}`, 'courier-district:pop', 'courier-district:chust']);
  assert.deepEqual(await courierRoomsFromToken(signToken('a1', 'admin'), deps), [], 'admin tokeni kuryer xonasiga kirmaydi');
  assert.deepEqual(await courierRoomsFromToken(jwt.sign({ cid: String(c._id), role: 'courier' }, sec), deps), [], 'asosiy kalit bilan yasalgan');
  c.tokenVersion = 1;
  assert.deepEqual(await courierRoomsFromToken(signCourierToken(c._id, 0), deps), [], 'parol almashgan');
  c.tokenVersion = 0; c.isActive = false;
  assert.deepEqual(await courierRoomsFromToken(signCourierToken(c._id, 0), deps), [], 'bloklangan');
});

/* ── Yo'l ruxsatlari: middleware zanjirini soxta so'rov bilan yuritamiz (controller'gacha yetdimi?) ── */
async function reaches(method, path, token) {
  const layer = router.stack.find((l) => l.route?.path === path && l.route.methods[method]);
  assert.ok(layer, `${method.toUpperCase()} ${path} yo'q`);
  const chain = layer.route.stack.map((s) => s.handle);
  const req = { headers: token ? { authorization: `Bearer ${token}` } : {}, params: {}, body: {}, query: {}, ip: '127.0.0.1', app: { get: () => false } };
  for (let i = 0; i < chain.length - 1; i++) {
    const r = res(); let nextCalled = false;
    await chain[i](req, r, () => { nextCalled = true; });
    if (!nextCalled) return { ok: false, code: r.code };
  }
  return { ok: true };
}
const tok = { admin: signToken('a1', 'admin'), ops: signToken('s1', 'staff', null, 'restaurant_ops'), orders: signToken('s2', 'staff', null, 'order_control'), acc: signToken('s3', 'staff', null, 'accountant'), rest: signToken('r1', 'restaurant', 'R1') };
const nonLimiter = (fn) => fn; void nonLimiter;

test('RUXSAT: rejim/foiz/tekin yetkazish va global sozlama — FAQAT bosh admin', async () => {
  for (const [m, p] of [['patch', '/admin/restaurants/:id/courier-settings'], ['patch', '/admin/courier-settings'], ['get', '/admin/courier-settings']]) {
    assert.equal((await reaches(m, p, tok.admin)).ok, true, `${p} admin`);
    for (const who of ['ops', 'orders', 'acc', 'rest']) assert.equal((await reaches(m, p, tok[who])).ok, false, `${p} ${who} kira olmasin`);
    assert.equal((await reaches(m, p, null)).ok, false);
  }
});

test('RUXSAT: tuman — restoranlar bo\'limi; kuryer kassasi — moliya bo\'limi; kuryerlar — buyurtmalar bo\'limi', async () => {
  assert.equal((await reaches('patch', '/admin/restaurants/:id/district', tok.ops)).ok, true);
  assert.equal((await reaches('patch', '/admin/restaurants/:id/district', tok.orders)).ok, false);
  assert.equal((await reaches('post', '/admin/courier-accounts/:id/ledger', tok.acc)).ok, true, 'buxgalter');
  assert.equal((await reaches('post', '/admin/courier-accounts/:id/ledger', tok.orders)).ok, false, 'buyurtmalar bo\'limi pulni yozmaydi');
  assert.equal((await reaches('get', '/admin/courier-accounts', tok.orders)).ok, true);
  assert.equal((await reaches('get', '/admin/courier-accounts', tok.ops)).ok, false);
  assert.equal((await reaches('post', '/panel/orders/:id/courier-party', tok.rest)).ok, true);
  assert.equal((await reaches('post', '/panel/orders/:id/courier-party', tok.admin)).ok, false, 'panel yo\'li faqat restoran');
});

test('RUXSAT: kuryer nazorati (jonli, trek, voqealar, biriktirish) — "kuryerlar" bo\'limi; kuryer ilovasi — faqat kuryer tokeni', async () => {
  for (const [m, p] of [['get', '/admin/courier-accounts/live'], ['get', '/admin/courier-accounts/:id/track'], ['get', '/admin/orders/:id/courier-trace'], ['get', '/admin/courier-events'], ['put', '/admin/restaurants/:id/couriers']]) {
    assert.equal((await reaches(m, p, tok.orders)).ok, true, `${p} kuryerlar bo'limi`);
    assert.equal((await reaches(m, p, tok.admin)).ok, true, `${p} admin`);
    assert.equal((await reaches(m, p, tok.ops)).ok, false, `${p} restoranlar bo'limi kira olmaydi`);
    assert.equal((await reaches(m, p, tok.rest)).ok, false, `${p} restoran`);
    assert.equal((await reaches(m, p, null)).ok, false);
  }
  const c = new Types.ObjectId(); store.docs.length = 0; store.docs.push({ _id: c, name: 'Ali', isActive: true, tokenVersion: 0, workDistricts: [] });
  const courierTok = signCourierToken(c, 0);
  for (const [m, p] of [['get', '/courier-app/me'], ['get', '/courier-app/offers'], ['post', '/courier-app/active/pickup'], ['post', '/courier-app/active/deliver'], ['post', '/courier-app/location'], ['patch', '/courier-app/me']]) {
    assert.equal((await reaches(m, p, courierTok)).ok, true, `${p} kuryer`);
    assert.equal((await reaches(m, p, tok.admin)).ok, false, `${p} admin kira olmaydi`);
    assert.equal((await reaches(m, p, tok.rest)).ok, false, `${p} restoran kira olmaydi`);
  }
});
