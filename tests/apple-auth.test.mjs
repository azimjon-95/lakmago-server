/*
 * SIGN IN WITH APPLE (faqat iOS): challenge → identity token (imzo, issuer, audience, exp, nonce) → mavjud/yangi foydalanuvchi.
 * HAQIQIY baza (FerretDB/MongoDB); Apple o'rniga o'zim yaratgan RSA kalit bilan imzolangan tokenlar. npm run test:apple-auth
 * Telegram kirishiga TEGILMAYDI — oxirida shu tasdiqlanadi (marshrutlar va controller'lar o'zgarmagan).
 */
process.env.JWT_SECRET = 'x'.repeat(40);
process.env.APPLE_SIGNIN_ENABLED = 'true';
process.env.APPLE_CLIENT_IDS = 'uz.lokmago.app';
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';

const URI = process.env.TEST_MONGO_URI || 'mongodb://127.0.0.1:27017/lokma_apple_auth_test';
const { AppleAuthChallenge } = await import('../src/models/AppleAuthChallenge.js');
const { User } = await import('../src/models/User.js');
const { AuthIdentity } = await import('../src/models/AuthIdentity.js');
const { Session } = await import('../src/models/Session.js');
const S = await import('../src/services/appleAuth.js');
const { appleAuthController: C } = await import('../src/controllers/appleAuth.js');

// ── Apple o'rniga: o'z kalitlarim ──
const mkKey = (kid) => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { kid, privateKey, jwk: { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' } };
};
const K1 = mkKey('kid-1');
const EVIL = mkKey('kid-1');           // boshqa kalit, lekin xuddi shu kid (soxta imzo)
S.setAppleKeyProvider(async (kid) => (kid === K1.kid ? K1.jwk : null));

const now = () => Math.floor(Date.now() / 1000);
const mkToken = (o = {}) => jwt.sign(
  { iss: 'https://appleid.apple.com', aud: 'uz.lokmago.app', sub: 'apple-sub-1', iat: now(), exp: now() + 600, nonce: o.nonce, email: o.email, ...(o.claims || {}) },
  (o.key || K1).privateKey,
  { algorithm: o.alg || 'RS256', header: { kid: (o.key || K1).kid } },   // iat/exp payload'dan (noTimestamp iat'ni ham o'chirib yuboradi)
);

const call = async (handler, req) => {
  const out = { code: 200, body: null, headers: {} };
  const res = { status: (c) => { out.code = c; return res; }, json: (b) => { out.body = b; return res; }, set: (k, v) => { out.headers[k] = v; return res; }, setHeader() {} };
  handler({ query: {}, params: {}, headers: {}, ...req }, res, (e) => { throw e; });
  for (let i = 0; i < 500 && out.body === null; i++) await new Promise((x) => setTimeout(x, 10));
  return out;
};
const DEV = 'device-aaa';
const challenge = async (deviceId = DEV) => (await call(C.challenge, { body: { platform: 'ios', deviceId } })).body;
const login = (b) => call(C.login, { body: { platform: 'ios', deviceId: DEV, ...b } });
/** Toza oqim: challenge → token(nonce) → kirish */
const fullLogin = async (o = {}) => {
  const ch = await challenge(o.deviceId);
  const token = mkToken({ nonce: ch.nonce, ...o });
  return login({ challengeId: ch.challengeId, identityToken: token, deviceId: o.deviceId || DEV, givenName: o.givenName, familyName: o.familyName });
};

before(async () => { await mongoose.connect(URI, { serverSelectionTimeoutMS: 8000 }); });
after(async () => { await mongoose.connection.dropDatabase().catch(() => {}); await mongoose.disconnect(); });
beforeEach(async () => {
  process.env.APPLE_SIGNIN_ENABLED = 'true';
  await Promise.all([AppleAuthChallenge.deleteMany({}), User.deleteMany({}), AuthIdentity.deleteMany({}), Session.deleteMany({})]);
  await AuthIdentity.init(); await User.init();                                   // noyob indekslar (poyga testi uchun shart)
  await AppleAuthChallenge.init().catch(() => {});                                // FerretDB TTL indeksni bilmaydi; haqiqiy MongoDB'da ishlaydi
});

test('yoqilmagan (standart): tugma ko\'rinmaydi, challenge va kirish 404', async () => {
  process.env.APPLE_SIGNIN_ENABLED = 'false';
  assert.equal((await call(C.config, {})).body.enabled, false);
  assert.equal((await call(C.challenge, { body: { platform: 'ios' } })).code, 404);
  assert.equal((await call(C.login, { body: { platform: 'ios' } })).code, 404);
  process.env.APPLE_SIGNIN_ENABLED = 'true';
  assert.equal((await call(C.config, {})).body.enabled, true);
});

test('faqat iOS: android/web uchun challenge ham, kirish ham rad etiladi', async () => {
  for (const platform of ['android', 'web', 'telegram', undefined]) {
    const r = await call(C.challenge, { body: { platform, deviceId: DEV } });
    assert.equal(r.code, 400, String(platform)); assert.equal(r.body.code, 'PLATFORM_NOT_SUPPORTED');
  }
  const ch = await challenge();
  const r = await call(C.login, { body: { platform: 'android', challengeId: ch.challengeId, identityToken: mkToken({ nonce: ch.nonce }), deviceId: DEV } });
  assert.equal(r.code, 400); assert.equal(r.body.code, 'PLATFORM_NOT_SUPPORTED');
  assert.equal(await Session.countDocuments(), 0);
});

test('challenge: tasodifiy nonce (≥43 belgi), 5 daqiqa, bazada saqlanadi, har safar yangi', async () => {
  const a = await challenge(); const b = await challenge();
  assert.ok(a.nonce.length >= 43 && a.nonce !== b.nonce && a.challengeId !== b.challengeId);
  assert.equal(a.expiresIn, 300);
  const doc = await AppleAuthChallenge.findById(a.challengeId).lean();
  assert.equal(doc.usedAt, null); assert.equal(doc.deviceId, DEV);
  assert.ok(Math.abs(doc.expiresAt.getTime() - Date.now() - 300_000) < 5000);
});

test('YANGI foydalanuvchi: yaratiladi, provider=apple identity, telegramId YO\'Q, sessiya ios, Telegram bilan bir xil javob shakli', async () => {
  const r = await fullLogin({ sub: 'S-new', givenName: '  Ali ', familyName: 'Valiyev', claims: { sub: 'S-new' } });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  const b = r.body;
  assert.equal(b.isNewUser, true);
  for (const k of ['token', 'accessToken', 'refreshToken', 'user', 'isNewUser']) assert.ok(k in b, k);   // completeTelegramAuth shakli
  assert.equal(b.user.firstName, 'Ali'); assert.equal(b.user.lastName, 'Valiyev');
  assert.ok(!b.user.telegramId);
  const u = await User.findById(b.user._id).lean();
  assert.equal(u.role, 'customer'); assert.equal(u.status, 'ACTIVE'); assert.equal(u.telegramId, undefined);
  const ids = await AuthIdentity.find({ userId: u._id }).lean();
  assert.equal(ids.length, 1); assert.equal(ids[0].provider, 'apple'); assert.equal(ids[0].providerUserId, 'S-new');
  const sess = await Session.findOne({ userId: u._id }).lean();
  assert.equal(sess.platform, 'ios'); assert.equal(sess.deviceId, DEV); assert.ok(!sess.revokedAt);
  assert.equal(sess.refreshTokenHash, crypto.createHash('sha256').update(b.refreshToken).digest('hex'));   // xom token saqlanmaydi
  const dec = jwt.verify(b.accessToken, process.env.JWT_SECRET);
  assert.equal(String(dec.userId || dec.sub || dec.id), String(u._id));
});

test('ism yo\'q bo\'lsa standart nom; tozalash (nazorat belgilari, uzunlik)', async () => {
  const r1 = await fullLogin({ sub: 'S-noname', claims: { sub: 'S-noname' } });
  assert.equal(r1.body.user.firstName, 'Mijoz');
  const r2 = await fullLogin({ sub: 'S-x', givenName: 'A\u0000B\n' + 'z'.repeat(100), claims: { sub: 'S-x' } });
  assert.ok(r2.body.user.firstName.length <= 40 && !/[\u0000-\u001f]/.test(r2.body.user.firstName));
});

test('ISM KEYIN KELSA: hisob standart "Mijoz" bo\'lsa to\'ldiriladi; mijoz o\'zi yozgan ism almashtirilmaydi', async () => {
  const sub = 'apple-sub-name-late';
  let c = await challenge();
  let r = await login({ challengeId: c.challengeId, identityToken: mkToken({ nonce: c.nonce, claims: { sub } }) });   // ism yo'q (birinchi urinish ismsiz ketgan)
  assert.equal(r.code, 200);
  assert.equal(r.body.user.firstName, 'Mijoz');
  c = await challenge();
  r = await login({ challengeId: c.challengeId, identityToken: mkToken({ nonce: c.nonce, claims: { sub } }), givenName: 'Azimjon', familyName: 'Aliyev' });
  assert.equal(r.code, 200);
  assert.equal(r.body.isNewUser, false);
  assert.equal(r.body.user.firstName, 'Azimjon');
  assert.equal(r.body.user.lastName, 'Aliyev');
  assert.equal((await User.findById(r.body.user._id)).firstName, 'Azimjon');
  // Mijoz ismni o'zi o'zgartirgan — keyingi Apple ismi uni bosib ketmasin
  await User.updateOne({ _id: r.body.user._id }, { $set: { firstName: 'Aziz', lastName: 'Karimov' } });
  c = await challenge();
  r = await login({ challengeId: c.challengeId, identityToken: mkToken({ nonce: c.nonce, claims: { sub } }), givenName: 'Boshqa', familyName: 'Nom' });
  assert.equal(r.body.user.firstName, 'Aziz');
  assert.equal(r.body.user.lastName, 'Karimov');
});

test('MAVJUD foydalanuvchi: xuddi shu sub → o\'sha hisob (dublikat yo\'q), yangi sessiya', async () => {
  const a = await fullLogin({ claims: { sub: 'S-same' }, givenName: 'Ali' });
  const b = await fullLogin({ claims: { sub: 'S-same' }, givenName: 'Boshqa nom' });
  assert.equal(b.code, 200);
  assert.equal(b.body.isNewUser, false);
  assert.equal(String(b.body.user._id), String(a.body.user._id));
  assert.equal(b.body.user.firstName, 'Ali');                     // mavjud profil o'zgarmaydi
  assert.equal(await User.countDocuments(), 1); assert.equal(await AuthIdentity.countDocuments({ provider: 'apple' }), 1);
  assert.equal(await Session.countDocuments(), 2);
});

test('NOTO\'G\'RI TOKEN: soxta imzo, begona audience, begona issuer, HS256 va "none" qalbaki — barchasi 401', async () => {
  const cases = {
    'soxta imzo': (n) => mkToken({ nonce: n, key: EVIL }),
    'begona audience': (n) => mkToken({ nonce: n, claims: { aud: 'com.evil.app' } }),
    'web Services ID (aud)': (n) => mkToken({ nonce: n, claims: { aud: 'uz.lokmago.web' } }),
    'begona issuer': (n) => mkToken({ nonce: n, claims: { iss: 'https://evil.example' } }),
    'HS256 (kalit sifatida public)': (n) => jwt.sign({ iss: 'https://appleid.apple.com', aud: 'uz.lokmago.app', sub: 'x', iat: now(), exp: now() + 60, nonce: n }, 'secret', { algorithm: 'HS256', header: { kid: 'kid-1' } }),
    'alg none': (n) => `${Buffer.from(JSON.stringify({ alg: 'none', kid: 'kid-1' })).toString('base64url')}.${Buffer.from(JSON.stringify({ iss: 'https://appleid.apple.com', aud: 'uz.lokmago.app', sub: 'x', nonce: n, exp: now() + 60, iat: now() })).toString('base64url')}.`,
    'noma\'lum kid': (n) => mkToken({ nonce: n, key: { ...K1, kid: 'kid-yoq' } }),
    'axlat': () => 'not-a-jwt',
  };
  for (const [name, make] of Object.entries(cases)) {
    const ch = await challenge();
    const r = await login({ challengeId: ch.challengeId, identityToken: make(ch.nonce) });
    assert.equal(r.code, 401, `${name}: ${JSON.stringify(r.body)}`);
  }
  assert.equal(await Session.countDocuments(), 0); assert.equal(await User.countDocuments(), 0);
});

test('MUDDATI O\'TGAN token (exp) va juda eski token (iat) — 401', async () => {
  let ch = await challenge();
  let r = await login({ challengeId: ch.challengeId, identityToken: mkToken({ nonce: ch.nonce, claims: { iat: now() - 7200, exp: now() - 3600 } }) });
  assert.equal(r.code, 401); assert.equal(r.body.code, 'TOKEN_EXPIRED');
  ch = await challenge();
  r = await login({ challengeId: ch.challengeId, identityToken: mkToken({ nonce: ch.nonce, claims: { iat: now() - 3600, exp: now() + 600 } }) });   // exp hali yaroqli, lekin iat 1 soat oldin
  assert.equal(r.code, 401); assert.equal(r.body.code, 'TOKEN_EXPIRED');
});

test('NOTO\'G\'RI NONCE (boshqa challenge nonce\'i, bo\'sh, yo\'q) — 401 NONCE_MISMATCH', async () => {
  const other = await challenge();
  for (const nonce of [other.nonce, '', undefined, 'tasodifiy']) {
    const ch = await challenge();
    const r = await login({ challengeId: ch.challengeId, identityToken: mkToken({ nonce }) });
    assert.equal(r.code, 401, String(nonce)); assert.equal(r.body.code, 'NONCE_MISMATCH');
  }
});

test('nonce SHA-256 hex ko\'rinishida kelsa ham qabul (Apple/plugin variantlari uchun), lekin faqat shu challenge uchun', async () => {
  const ch = await challenge();
  const hex = crypto.createHash('sha256').update(ch.nonce).digest('hex');
  const r = await login({ challengeId: ch.challengeId, identityToken: mkToken({ nonce: hex, claims: { sub: 'S-hex' } }) });
  assert.equal(r.code, 200, JSON.stringify(r.body));
});

test('MUDDATI O\'TGAN challenge — 410 CHALLENGE_EXPIRED, sessiya yaratilmaydi', async () => {
  const ch = await challenge();
  await AppleAuthChallenge.updateOne({ _id: ch.challengeId }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  const r = await login({ challengeId: ch.challengeId, identityToken: mkToken({ nonce: ch.nonce }) });
  assert.equal(r.code, 410); assert.equal(r.body.code, 'CHALLENGE_EXPIRED');
  assert.equal(await Session.countDocuments(), 0);
});

test('TAKRORIY challenge (replay) — ikkinchi marta 409; o\'sha token yangi challenge bilan ham o\'tmaydi', async () => {
  const ch = await challenge();
  const token = mkToken({ nonce: ch.nonce, claims: { sub: 'S-replay' } });
  const first = await login({ challengeId: ch.challengeId, identityToken: token });
  assert.equal(first.code, 200);
  const again = await login({ challengeId: ch.challengeId, identityToken: token });
  assert.equal(again.code, 409); assert.equal(again.body.code, 'CHALLENGE_USED');
  const ch2 = await challenge();
  const stolen = await login({ challengeId: ch2.challengeId, identityToken: token });     // o'g'irlangan token + yangi challenge
  assert.equal(stolen.code, 401); assert.equal(stolen.body.code, 'NONCE_MISMATCH');
  assert.equal(await Session.countDocuments(), 1);
});

test('xato token ham challenge\'ni sarflaydi (brute-force qilib bo\'lmaydi); yaroqsiz/noma\'lum challengeId — 400', async () => {
  const ch = await challenge();
  await login({ challengeId: ch.challengeId, identityToken: mkToken({ nonce: 'x' }) });
  const retry = await login({ challengeId: ch.challengeId, identityToken: mkToken({ nonce: ch.nonce }) });
  assert.equal(retry.code, 409);
  for (const id of ['nomalum', String(new mongoose.Types.ObjectId())]) {
    const r = await login({ challengeId: id, identityToken: mkToken({ nonce: 'x' }) });
    assert.equal(r.code, 400, id); assert.equal(r.body.code, 'CHALLENGE_INVALID');
  }
});

test('challenge boshqa QURILMA bilan bog\'langan — mos kelmasa 400', async () => {
  const ch = await challenge('device-A');
  const r = await login({ challengeId: ch.challengeId, identityToken: mkToken({ nonce: ch.nonce }), deviceId: 'device-B' });
  assert.equal(r.code, 400); assert.equal(r.body.code, 'CHALLENGE_DEVICE_MISMATCH');
});

test('EMAIL bo\'yicha BIRLASHTIRISH YO\'Q: bir xil email bilan ikki xil Apple sub → ikki alohida hisob; Telegram foydalanuvchisiga tegilmaydi', async () => {
  const tg = await User.create({ telegramId: '777', firstName: 'Tg', role: 'customer', status: 'ACTIVE' });
  await AuthIdentity.create({ userId: tg._id, provider: 'telegram', providerUserId: '777' });
  const a = await fullLogin({ email: 'same@example.com', claims: { sub: 'S-a', email: 'same@example.com' } });
  const b = await fullLogin({ email: 'same@example.com', claims: { sub: 'S-b', email: 'same@example.com' } });
  assert.notEqual(String(a.body.user._id), String(b.body.user._id));
  assert.notEqual(String(a.body.user._id), String(tg._id));
  assert.equal(await User.countDocuments(), 3);
  const tg2 = await User.findById(tg._id).lean();
  assert.equal(tg2.telegramId, '777'); assert.equal(tg2.firstName, 'Tg');
  assert.equal(await AuthIdentity.countDocuments({ userId: tg._id }), 1);                       // Telegram identity o'zgarmagan
  assert.equal(await AuthIdentity.countDocuments({ provider: 'apple' }), 2);
  assert.ok(!JSON.stringify(a.body.user).includes('same@example.com'));                         // email saqlanmaydi
});

test('BLOKLANGAN hisob — 403, sessiya yaratilmaydi', async () => {
  const a = await fullLogin({ claims: { sub: 'S-blk' } });
  await User.updateOne({ _id: a.body.user._id }, { $set: { status: 'BLOCKED' } });
  const sessionsBefore = await Session.countDocuments();
  const r = await fullLogin({ claims: { sub: 'S-blk' } });
  assert.equal(r.code, 403);
  assert.equal(await Session.countDocuments(), sessionsBefore);
});

test('O\'CHIRILGAN (cheklov tufayli identity saqlangan) hisob — Telegramdagidek qayta ACTIVE', async () => {
  const a = await fullLogin({ claims: { sub: 'S-del' } });
  await User.updateOne({ _id: a.body.user._id }, { $set: { status: 'DELETED', deletedAt: new Date() } });
  const r = await fullLogin({ claims: { sub: 'S-del' } });
  assert.equal(r.code, 200);
  assert.equal((await User.findById(a.body.user._id).lean()).status, 'ACTIVE');
});

test('POYGA: bir vaqtda 6 ta kirish (bir sub) — bitta hisob, bitta identity, hammasi muvaffaqiyatli', async () => {
  const rs = await Promise.all(Array.from({ length: 6 }, () => fullLogin({ claims: { sub: 'S-race' } })));
  assert.ok(rs.every((r) => r.code === 200), JSON.stringify(rs.map((r) => r.code)));
  assert.equal(new Set(rs.map((r) => String(r.body.user._id))).size, 1);
  assert.equal(await User.countDocuments(), 1); assert.equal(await AuthIdentity.countDocuments({ provider: 'apple' }), 1);
  assert.equal(rs.filter((r) => r.body.isNewUser).length >= 1, true);
  assert.equal(await Session.countDocuments(), 6);
});

test('Apple kalitlari (JWKS): HTTP orqali yuklanadi, keshlanadi, noma\'lum kid chastotasi cheklangan', async () => {
  let hits = 0; const jwks = { keys: [K1.jwk] };
  const srv = http.createServer((_q, res) => { hits++; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(jwks)); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  process.env.APPLE_JWKS_URL = `http://127.0.0.1:${srv.address().port}/keys`;
  S.setAppleKeyProvider(null); S.resetAppleKeyCache();
  try {
    assert.equal((await fullLogin({ claims: { sub: 'S-j1' } })).code, 200);
    assert.equal((await fullLogin({ claims: { sub: 'S-j2' } })).code, 200);
    assert.equal(hits, 1, 'ikkinchi kirishda kesh ishlatilishi kerak');
    const bad = await fullLogin({ key: { ...K1, kid: 'kid-yoq' } });
    assert.equal(bad.code, 401);
    await fullLogin({ key: { ...K1, kid: 'kid-yoq-2' } });
    assert.ok(hits <= 2, `noma'lum kid Apple'ni bombardimon qilmasligi kerak (hits=${hits})`);
  } finally {
    delete process.env.APPLE_JWKS_URL; srv.close(); S.setAppleKeyProvider(async (kid) => (kid === K1.kid ? K1.jwk : null)); S.resetAppleKeyCache();
  }
});

test('Apple kalitlariga ulanib bo\'lmasa — 503 (Telegram kirishiga ta\'sir qilmaydi)', async () => {
  process.env.APPLE_JWKS_URL = 'http://127.0.0.1:1/keys';
  S.setAppleKeyProvider(null); S.resetAppleKeyCache();
  try {
    const r = await fullLogin({ claims: { sub: 'S-down' } });
    assert.equal(r.code, 503); assert.equal(r.body.code, 'APPLE_KEYS_UNAVAILABLE');
  } finally { delete process.env.APPLE_JWKS_URL; S.setAppleKeyProvider(async (kid) => (kid === K1.kid ? K1.jwk : null)); S.resetAppleKeyCache(); }
});

test('ESKI BAZA (MongoDB E11000): Telegram ID\'siz foydalanuvchi yaratilmasa → 500 USER_CREATE_DUPLICATE, yetim identity/sessiya yo\'q', async () => {
  // MongoDB'da sparse BO'LMAGAN unique telegramId indeksi Telegram ID'siz ikkinchi hujjatni E11000 bilan rad etadi.
  // FerretDB bu xatti-harakatni takrorlamaydi — shuning uchun MongoDB'ning aynan shu xatosini simulyatsiya qilamiz.
  const orig = User.create;
  User.create = async () => {
    const e = new Error('E11000 duplicate key error collection: lokma.users index: telegramId_1 dup key: { telegramId: null }');
    e.code = 11000; e.keyPattern = { telegramId: 1 }; throw e;
  };
  try {
    const r = await fullLogin({ claims: { sub: 'S-oldidx' } });
    assert.equal(r.code, 500, JSON.stringify(r.body)); assert.equal(r.body.code, 'USER_CREATE_DUPLICATE');
    assert.equal(await AuthIdentity.countDocuments({ provider: 'apple' }), 0);
    assert.equal(await Session.countDocuments(), 0);
  } finally { User.create = orig; }
  const ok = await fullLogin({ claims: { sub: 'S-oldidx' } });          // indeks tuzatilgach (create ishlaydi) — kirish muvaffaqiyatli
  assert.equal(ok.code, 200);
});

test('kutilmagan server xatosi — 500 SERVER_ERROR (stack/tafsilot javobga chiqmaydi)', async () => {
  const orig = Session.create;
  Session.create = async () => { throw new Error('ichki xato tafsiloti'); };
  try {
    const r = await fullLogin({ claims: { sub: 'S-500' } });
    assert.equal(r.code, 500); assert.equal(r.body.code, 'SERVER_ERROR'); assert.ok(!JSON.stringify(r.body).includes('ichki xato'));
  } finally { Session.create = orig; }
});

test('TELEGRAM kirishi O\'ZGARMAGAN: marshrutlar, controller\'lar va umumiy token kodi (statik tekshiruv)', () => {
  const src = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
  const routes = src('src/routes/index.js');
  for (const line of [
    "router.post('/auth/telegram', loginLimiter, authController.telegram);",
    "router.post('/auth/telegram-web', loginLimiter, authController.telegramWeb);",
    "router.post('/auth/demo-login', loginLimiter, demoController.login);",
    "router.post('/auth/tg-link/start', tgLinkStartLimiter, tgLinkAuthController.start);",
    "router.post('/auth/tg-link/poll', tgLinkPollLimiter, tgLinkAuthController.poll);",
    "router.post('/auth/refresh', loginLimiter, authController.refresh);",
    "router.post('/auth/logout', authController.logout);",
  ]) assert.ok(routes.includes(line), `marshrut o'zgargan: ${line}`);
  assert.ok(routes.includes("router.post('/auth/apple', loginLimiter, appleAuthController.login);"));
  // Apple moduli Telegram fayllarini import qilmaydi (bog'liqlik yo'q)
  const imports = [...(src('src/services/appleAuth.js') + src('src/controllers/appleAuth.js')).matchAll(/^import .*? from '([^']+)'/gm)].map((m) => m[1]);
  assert.ok(imports.length >= 8, 'importlar topilmadi');
  for (const spec of imports) for (const bad of ['controllers/misc', 'tgLinkLogin', 'tgLinkAuth', 'services/telegram', 'demoAccount']) assert.ok(!spec.includes(bad), `Apple moduli ${bad} ga bog'liq: ${spec}`);
  // ruxsat etilgan umumiy primitivlar
  assert.ok(imports.includes('../middleware/auth.js') && imports.includes('./authIdentity.js') && imports.includes('../models/Session.js'));
});
