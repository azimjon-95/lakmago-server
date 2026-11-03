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

const { hashPin, verifyPin, isPinAcceptable, signCourierToken, readCourierToken } = await import('../src/services/courierAuth.js');
const { courierAuth } = await import('../src/middleware/courierAuth.js');
const { Courier } = await import('../src/models/Courier.js');
const { canJoinAdmin, canJoinRestaurant, courierRoomsFromToken } = await import('../src/sockets/panelSocketAuth.js');
const { signToken } = await import('../src/middleware/auth.js');
const { router } = await import('../src/routes/index.js');

const sec = process.env.JWT_SECRET;
const verify = (t) => jwt.verify(t, sec);

test('PIN: hash/tekshirish, oddiy PIN rad etiladi, xom PIN saqlanmaydi', () => {
  const h = hashPin('5827');
  assert.ok(h.startsWith('scrypt$') && !h.includes('5827'));
  assert.equal(verifyPin('5827', h), true);
  assert.equal(verifyPin('5826', h), false);
  assert.equal(verifyPin('5827', 'buzuq'), false);
  assert.notEqual(hashPin('5827'), h, 'har safar yangi tuz');
  for (const bad of ['1111', '1234', '4321', '0000', '123', 'abcd', '123456789', '98765']) assert.equal(isPinAcceptable(bad), false, bad);
  for (const ok of ['5827', '90517', '384920']) assert.equal(isPinAcceptable(ok), true, ok);
});

const store = bindModel(Courier, { docs: [] });
const res = () => { const r = { code: 200, body: null, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; } }; return r; };
async function runAuth(token) {
  const req = { headers: token ? { authorization: `Bearer ${token}` } : {} };
  const r = res(); let passed = false;
  await courierAuth(req, r, () => { passed = true; });
  return { passed, code: r.code, body: r.body, req };
}

test('kuryer middleware: token yo\'q / eski versiya / bloklangan / kutilmoqda / to\'g\'ri', async () => {
  const c = { _id: new Types.ObjectId(), name: 'Ali', status: 'active', tokenVersion: 2, workDistricts: ['pop'] };
  store.docs.push(c);
  assert.equal((await runAuth(null)).code, 401);
  assert.equal((await runAuth('buzuq')).code, 401);
  assert.equal((await runAuth(signCourierToken({ ...c, tokenVersion: 1 }))).code, 401, 'PIN almashgan — eski token ishlamaydi');
  const ok = await runAuth(signCourierToken(c));
  assert.equal(ok.passed, true);
  assert.equal(ok.req.courierId, String(c._id));
  c.status = 'blocked';
  const b = await runAuth(signCourierToken(c));
  assert.equal(b.code, 403); assert.equal(b.body.code, 'COURIER_BLOCKED');
  c.status = 'pending';
  assert.equal((await runAuth(signCourierToken(c))).body.code, 'COURIER_PENDING');
  // admin/restoran tokeni kuryer API'siga kirmaydi
  assert.equal(readCourierToken(signToken('u1', 'admin')), null);
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

test('SOKET kuryer xonalari: o\'z xonasi + ish tumanlari; bloklangan/eski token — hech narsa', async () => {
  const c = { _id: new Types.ObjectId(), status: 'active', tokenVersion: 0, workDistricts: ['pop', 'chust'] };
  const deps = { verify, findCourier: async () => c };
  assert.deepEqual(await courierRoomsFromToken(signCourierToken(c), deps), [`courier:${c._id}`, 'courier-district:pop', 'courier-district:chust']);
  assert.deepEqual(await courierRoomsFromToken(signToken('a1', 'admin'), deps), []);
  c.tokenVersion = 1;
  assert.deepEqual(await courierRoomsFromToken(signCourierToken({ ...c, tokenVersion: 0 }), deps), []);
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
  assert.equal((await reaches('post', '/admin/couriers/:id/ledger', tok.acc)).ok, true, 'buxgalter');
  assert.equal((await reaches('post', '/admin/couriers/:id/ledger', tok.orders)).ok, false, 'buyurtmalar bo\'limi pulni yozmaydi');
  assert.equal((await reaches('get', '/admin/couriers', tok.orders)).ok, true);
  assert.equal((await reaches('get', '/admin/couriers', tok.ops)).ok, false);
  assert.equal((await reaches('post', '/panel/orders/:id/courier-party', tok.rest)).ok, true);
  assert.equal((await reaches('post', '/panel/orders/:id/courier-party', tok.admin)).ok, false, 'panel yo\'li faqat restoran');
});
