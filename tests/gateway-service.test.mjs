/*
 * ═══════════════════════════════════════════════════════════
 * ANDROID GATEWAY — SERVIS KIRISHI (BFF), TOZA JAVOB, 409, TARIX,
 * STATISTIKA, "YETKAZILDI", HODISALAR (oxirigacha)
 * ═══════════════════════════════════════════════════════════
 * HAQIQIY server (src/index.js) ishga tushiriladi; BFF — soxta HTTP server.
 * npm run test:gateway
 */
import { spawn } from 'node:child_process';
import http from 'node:http';

const PORT = 4192;
const BFF_PORT = 4392;
const MONGO_URI = 'mongodb://127.0.0.1:27017/lokma_gateway_service';
const JWT_SECRET = 'gw-test-secret-gw-test-secret-gw-test-xx';
const KEY = 'k'.repeat(8) + 'service-key-0123456789abcdef'; // >= 24 belgi
const WEBHOOK = 'gw-webhook-secret-777';
process.env.MONGO_URI = MONGO_URI; process.env.JWT_SECRET = JWT_SECRET;

const mongoose = (await import('mongoose')).default;
const jwt = (await import('jsonwebtoken')).default;
const bcrypt = (await import('bcryptjs')).default;
await mongoose.connect(MONGO_URI); await mongoose.connection.db.dropDatabase();

const { Restaurant } = await import('../src/models/Restaurant.js');
const { User } = await import('../src/models/User.js');
const { Dish } = await import('../src/models/Dish.js');
const { Order } = await import('../src/models/Order.js');
const { Ledger } = await import('../src/models/Ledger.js');
const { CommissionAgreement } = await import('../src/models/CommissionAgreement.js');
const { zoneDate, addDaysYmd, zonedToUtc } = await import('../src/services/restaurantTime.js');

let fails = 0;
const ok = (c, m) => { console.log(c ? '  ✓' : '  ✗ FAIL:', m); if (!c) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── soxta BFF ── */
const bffGot = [];
const bff = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => { b += c; });
  req.on('end', () => { try { bffGot.push({ headers: req.headers, url: req.url, json: JSON.parse(b) }); } catch { /* */ } res.end('{}'); });
});
await new Promise((r) => bff.listen(BFF_PORT, '127.0.0.1', r));

/* ── ma'lumot ── */
const TODAY = zoneDate('Asia/Tashkent', new Date()).ymd;
const YESTERDAY = addDaysYmd(TODAY, -1);
const at = (ymd, hhmm) => zonedToUtc(ymd, hhmm);

const mkRest = async (name, extra = {}) => {
  const r = await Restaurant.create({
    name, cuisine: 'milliy', category: 'restoran', lat: 41.3111, lng: 69.2797, address: 'Sang senter', isActive: true, isApproved: true,
    deliveryEnabled: true, pickupEnabled: true, cashEnabled: true, deliveryFee: 0, openTime: '00:00', closeTime: '23:59',
    workingDays: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
    delivery: { maxDistanceKm: 0, pricingMode: 'perKm', freeKm: 1, perKm: 2000, basePrice: 5000 }, ...extra,
  });
  await CommissionAgreement.create({ restaurantId: r._id, restaurantCommissionPercent: 10, customerFeePercent: 0, effectiveFrom: new Date() });
  const dish = await Dish.create({ restaurantId: r._id, section: 'menu', name: 'Pasta', price: 10000 });
  return { r, dish, id: String(r._id) };
};
// A: gateway/PIN SOZLANMAGAN (servis yo'li PIN'siz ishlashi kerak). PINA — PIN yo'li regressiyasi uchun alohida.
const A = await mkRest('TOTLI');
const B = await mkRest('BOSHQA');
const P = await mkRest('PINLI', { androidGateway: { enabled: true, pinHash: await bcrypt.hash('1234', 4), pinSetAt: new Date() } });
const BLK = await mkRest('BLOKLANGAN', { isBlocked: true });
const user = await User.create({
  firstName: 'Azimjon', lastName: 'Karimov', username: 'azim', telegramId: '555001', phone: '+998901112233',
  addresses: [{ label: 'Uy', address: 'Sohil', lat: 41.2856, lng: 69.2034 }, { label: 'Ish', address: 'Yunusobod', lat: 41.3, lng: 69.3 }],
  cards: [{ last4: '4242', brand: 'uzcard' }], bonusBalance: 12345,
});
const userTok = jwt.sign({ userId: String(user._id), role: 'user' }, JWT_SECRET);
const restTok = jwt.sign({ userId: String(new mongoose.Types.ObjectId()), role: 'restaurant', restaurantId: A.id }, JWT_SECRET);

/* ── serverlar ── */
function startServer(port, env) {
  const srv = spawn('node', ['src/index.js'], {
    env: { ...process.env, PORT: String(port), NODE_ENV: 'development', MONGO_URI, JWT_SECRET, RESTAURANT_BOT_TOKEN: '', TELEGRAM_BOT_TOKEN: '', J_ROUTE_HOSTS: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = ''; srv.stdout.on('data', (d) => { log += d; }); srv.stderr.on('data', (d) => { log += d; });
  return { srv, get log() { return log; } };
}
const waitUp = async (port) => { for (let i = 0; i < 80; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return true; } catch { /* */ } await sleep(300); } return false; };
const main = startServer(PORT, {
  GATEWAY_SERVICE_KEY: KEY, GATEWAY_ALLOWED_IPS: '127.0.0.1, 10.20.30.0/24, 2001:db8::/48, 0.0.0.0/0, junk',
  BFF_BASE_URL: `http://127.0.0.1:${BFF_PORT}`, BFF_WEBHOOK_SECRET: WEBHOOK,
});
const servers = [main.srv];
process.on('exit', () => servers.forEach((s) => { try { s.kill('SIGKILL'); } catch { /* */ } }));
ok(await waitUp(PORT), 'asosiy server ishga tushdi');

const BASE = `http://127.0.0.1:${PORT}`;
async function req(method, path, { body, key = KEY, ip, token, headers = {}, base = BASE } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(key ? { 'x-gateway-key': key } : {}), ...(ip ? { 'x-forwarded-for': ip } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let json = null; try { json = await res.json(); } catch { /* */ }
  return { status: res.status, json, headers: Object.fromEntries(res.headers) };
}
const svc = (id, p = '') => `/app/service/${id}${p}`;
const S = (method, id, p, opts) => req(method, svc(id, p), opts);

/* Buyurtma yaratish — HAQIQIY POST /api/orders (finance v2 snapshot bilan) */
async function place(x, fulfillment) {
  const r = await req('POST', '/api/orders', { key: null, token: userTok, body: {
    address: 'Uy — Sohil', phone: '+998901112233', paymentMethod: 'cash', paymentLabel: 'Naqd', fulfillment, timingMode: 'asap',
    ...(fulfillment === 'delivery' ? { addressLat: 41.2856, addressLng: 69.2034 } : {}),
    orders: [{ restaurantId: x.id, restaurantName: x.r.name, subtotal: 20000, items: [{ dishId: String(x.dish._id), name: 'Pasta', quantity: 2, unitPrice: 10000, note: 'achchiq bo‘lmasin' }] }],
  } });
  return r;
}

console.log('\n[1] SERVIS KIRISHI: kalit + IP ro‘yxati (PIN va loginLimiter’siz)');
{
  ok((await S('GET', A.id, '', { key: null })).json?.code === 'SERVICE_KEY_INVALID', 'kalit yo‘q → 401 SERVICE_KEY_INVALID');
  const w = await S('GET', A.id, '', { key: 'x'.repeat(40) });
  ok(w.status === 401 && w.json.code === 'SERVICE_KEY_INVALID', `noto‘g‘ri kalit → ${w.status}`);
  const short = await S('GET', A.id, '', { key: KEY.slice(0, 20) });
  ok(short.status === 401, 'kalitning boshi (prefiks) ham o‘tmaydi');
  const good = await S('GET', A.id, '');
  ok(good.status === 200 && good.json.name === 'TOTLI', `to‘g‘ri kalit → 200 (profil): ${good.json?.name}`);
  ok(good.json.androidGateway === undefined && good.json.pinHash === undefined, 'profilda PIN/gateway maydoni yo‘q');
  ok(A.r.androidGateway?.enabled !== true, 'restoran uchun PIN SOZLANMAGAN — servis yo‘li PIN talab qilmaydi');

  const denied = await S('GET', A.id, '', { ip: '203.0.113.9' });
  ok(denied.status === 403 && denied.json.code === 'SERVICE_IP_DENIED', `to‘g‘ri kalit, RUXSATSIZ IP → 403 (${denied.json?.code})`);
  ok((await S('GET', A.id, '', { ip: '203.0.113.9', key: 'bad' })).status === 403, 'ruxsatsiz IP — kalit tekshirilmasdan 403 (kalit haqida ma’lumot bermaydi)');
  ok((await S('GET', A.id, '', { ip: '10.20.30.44' })).status === 200, 'CIDR 10.20.30.0/24 ichidagi IP → 200');
  ok((await S('GET', A.id, '', { ip: '10.20.31.1' })).status === 403, 'CIDR tashqarisi → 403');
  ok((await S('GET', A.id, '', { ip: '2001:db8::5' })).status === 200, 'IPv6 diapazon (2001:db8::/48) ishlaydi');
  ok((await S('GET', A.id, '', { ip: '198.51.100.7' })).status === 403, '"0.0.0.0/0" yozuvi RAD ETILGAN — hamma IP ochilib ketmadi');
  ok(main.log.includes('yaroqsiz/juda keng'), 'server yaroqsiz yozuvlar haqida log yozdi');

  ok((await S('GET', 'xyz', '')).json?.code === 'INVALID_RESTAURANT_ID', 'restoran ID formati noto‘g‘ri → 400');
  ok((await S('GET', 'a'.repeat(24), '')).json?.code === 'RESTAURANT_NOT_FOUND', 'mavjud emas → 404');
  const blk = await S('GET', BLK.id, '');
  ok(blk.status === 403 && blk.json.code === 'RESTAURANT_BLOCKED', 'bloklangan restoran → 403');
}

console.log('\n[2] BIZNES XATOLARI servis kalitini BLOKLAMAYDI (PIN yo‘lidagi muammo)');
{
  const ip = '10.20.30.77';
  const codes = [];
  for (let i = 0; i < 25; i++) codes.push((await S('PATCH', A.id, `/orders/${'b'.repeat(24)}/status`, { ip, body: { status: 'accepted' } })).status);
  ok(codes.every((c) => c === 404), `25 ta biznes xatosi (404) — hech biri 429 emas: ${[...new Set(codes)]}`);
  const after = await S('GET', A.id, '/orders', { ip });
  ok(after.status === 200, 'shundan keyin ham to‘g‘ri so‘rov 200');

  // Taqqoslash: PIN yo'lida aynan shu holat kanalni o'chiradi
  const pinIp = '10.20.30.78'; const pinCodes = [];
  for (let i = 0; i < 12; i++) pinCodes.push((await req('PATCH', `/app/1234/${P.id}/orders/${'b'.repeat(24)}/status`, { key: null, ip: pinIp, body: { status: 'accepted' } })).status);
  ok(pinCodes[9] === 404 && pinCodes[10] === 429, `PIN yo‘li: 10 xatodan keyin 429 (avvalgidek): ${pinCodes.slice(8)}`);

  // Kalit brute-force: faqat XATO KALIT sanaladi
  const bfIp = '10.20.30.99'; let blocked = null;
  for (let i = 0; i < 40; i++) { const r = await S('GET', A.id, '', { ip: bfIp, key: `guess-${i}-`.padEnd(30, 'z') }); if (r.status === 429) { blocked = { at: i + 1, r }; break; } }
  ok(blocked && blocked.at === 31 && blocked.r.json.code === 'SERVICE_AUTH_BLOCKED' && Number(blocked.r.headers['retry-after']) > 0, `31-noto‘g‘ri kalitdan keyin 429 SERVICE_AUTH_BLOCKED (retry-after ${blocked?.r.headers['retry-after']}s)`);
  ok((await S('GET', A.id, '', { ip: bfIp })).status === 429, 'blok davrida to‘g‘ri kalit ham 429 (kalitni terish davom etmasin)');
  ok((await S('GET', A.id, '', { ip: '10.20.30.100' })).status === 200, 'boshqa IP ta’sirlanmadi');
}

console.log('\n[3] PIN yo‘li va yangi marshrutlar birga; xato yo‘llar');
{
  ok((await req('GET', `/app/1234/${P.id}`, { key: null, ip: '10.20.30.11' })).status === 200, 'PIN bilan kirish avvalgidek ishlaydi');
  ok((await req('GET', `/app/1234/${P.id}/stats`, { key: null, ip: '10.20.30.11' })).status === 200, 'yangi marshrutlar PIN yo‘lida ham bor (/stats)');
  ok((await req('GET', `/app/service/${P.id}`, { key: null })).json?.code === 'SERVICE_KEY_INVALID', '"service" PIN deb o‘qilmaydi');
  ok((await S('POST', A.id, '/accept')).status === 404 && (await S('GET', A.id, '/nomalum')).status === 404, 'mavjud bo‘lmagan yo‘l → 404');
}

/* ── buyurtmalar ── */
const cD = await place(A, 'delivery'); const cP = await place(A, 'pickup'); const cB = await place(B, 'delivery');
ok(cD.status === 201 && cP.status === 201 && cB.status === 201, `buyurtmalar yaratildi (POST /api/orders): ${cD.status}/${cP.status}/${cB.status}`);
const oD = await Order.findOne({ restaurantId: A.r._id, fulfillment: 'delivery' }).lean();
const oB = await Order.findOne({ restaurantId: B.r._id }).lean();
const dId = String(oD._id); const bId = String(oB._id);

console.log('\n[4] Servis yo‘lida ro‘yxat/tafsilot: faqat o‘z restorani');
{
  const list = await S('GET', A.id, '/orders');
  ok(list.status === 200 && list.json.length === 2 && !list.json.some((o) => o._id === bId), 'ro‘yxatda faqat TOTLI buyurtmalari');
  ok((await S('GET', A.id, `/orders/${bId}`)).status === 404, 'boshqa restoran buyurtmasi → 404');
  ok((await S('PATCH', A.id, `/orders/${bId}/status`, { body: { status: 'accepted' } })).status === 404, 'boshqa restoran buyurtmasini o‘zgartirib bo‘lmaydi');
  const d = await S('GET', A.id, `/orders/${dId}`);
  ok(d.json.restaurantConfirm === null, 'pending buyurtmada restaurantConfirm: null (hali qabul qilinmagan — tasdiqlanadigan narsa yo‘q)');
}

console.log('\n[5] PATCH javobi TOZA (avval finance netto va butun mijoz hujjati chiqib ketardi) + changed');
{
  const detailBefore = (await S('GET', A.id, `/orders/${dId}`)).json;
  const r = await S('PATCH', A.id, `/orders/${dId}/status`, { body: { status: 'accepted' } });
  ok(r.status === 200 && r.json.changed === true && r.json.status === 'accepted', `accepted → 200, changed:true`);
  const raw = JSON.stringify(r.json);
  for (const bad of ['lokmaNetCommission', 'clickFeeAmount', 'clickFeePercent', 'lokmaGrossCommission', 'lokmaCashNet', 'clickResidualAmount', '"addresses"', '"cards"', 'bonusBalance', 'referralPoints', '"favorites"', 'isPremium']) {
    ok(!raw.includes(bad), `javobda "${bad}" YO‘Q`);
  }
  ok(typeof r.json.userId === 'string' && r.json.customer?.name === 'Azimjon Karimov' && r.json.customer.telegramId === '555001', 'userId matn, customer obyekti to‘g‘ri');
  ok(r.json.finance.restaurantPayout > 0 && r.json.finance.deliveryFee === r.json.deliveryFee, `finance SO‘MDA (restoran ko‘rinishi): payout ${r.json.finance.restaurantPayout}`);
  ok(Object.keys(r.json.finance).sort().join() === 'currency,deliveryFee,discountAmount,foodSubtotal,model,restaurantCommissionAmount,restaurantCommissionPercent,restaurantPayout,totalCharged', 'finance kalitlari — faqat restoran ko‘rinishi');

  const detailAfter = (await S('GET', A.id, `/orders/${dId}`)).json;
  const patchKeys = Object.keys(r.json).filter((k) => k !== 'changed').sort().join();
  ok(patchKeys === Object.keys(detailAfter).sort().join(), 'PATCH javobining kalitlari GET /orders/:id bilan AYNAN bir xil (+changed)');
  ok(JSON.stringify(r.json.finance) === JSON.stringify(detailAfter.finance) && r.json.customer.name === detailAfter.customer.name, 'finance va customer GET bilan bir xil');
  ok(detailBefore.status === 'pending', 'oldin pending edi');

  const again = await S('PATCH', A.id, `/orders/${dId}/status`, { body: { status: 'accepted' } });
  ok(again.status === 200 && again.json.changed === false, 'ketma-ket ikkinchi accepted → 200, changed:false (xato emas)');

  // Restoran paneli (JWT) yo'li ham tuzatildi
  const pan = await req('PATCH', `/api/panel/orders/${dId}/status`, { key: null, token: restTok, body: { status: 'accepted' } });
  ok(pan.status === 200 && pan.json.changed === false && !JSON.stringify(pan.json).includes('lokmaNet') && !JSON.stringify(pan.json).includes('"cards"'), 'PATCH /api/panel/orders/:id/status ham toza + changed');
}

console.log('\n[6] Xato kodlari: RACE_LOST → 409; boshqalarida ham `code`');
{
  const bad = await S('PATCH', A.id, `/orders/${dId}/status`, { body: { status: 'foo' } });
  ok(bad.status === 400 && bad.json.code === 'INVALID_STATUS', `noto‘g‘ri status → 400 ${bad.json.code}`);
  const wrong = await S('PATCH', A.id, `/orders/${dId}/status`, { body: { status: 'delivering' } });
  ok(wrong.status === 400 && wrong.json.code === 'WRONG_STATE', `mumkin bo‘lmagan o‘tish (accepted→delivering) → 400 ${wrong.json.code}`);
  const nf = await S('PATCH', A.id, `/orders/${'c'.repeat(24)}/status`, { body: { status: 'accepted' } });
  ok(nf.status === 404 && nf.json.code === 'NOT_FOUND', `topilmadi → 404 ${nf.json.code}`);
  const del = await S('PATCH', A.id, `/orders/${dId}/status`, { body: { status: 'delivered' } });
  ok(del.status === 400 && del.json.code === 'WRONG_STATE' && del.json.error.includes('kuryer'), 'yetkazib berishda PATCH delivered hamon rad etiladi (qoida o‘zgarmagan)');
}
{
  // RACE_LOST'ni ANIQ hosil qilish (parallel emas): findOne dan keyin, atomik yozuvdan OLDIN holat boshqa qurilma tomonidan o'zgartiriladi
  const { restaurantPanelController } = await import('../src/controllers/restaurantPanel.js');
  const race = await Order.create({
    userId: user._id, restaurantId: A.r._id, restaurantName: 'TOTLI', items: [{ name: 'Osh', quantity: 1, unitPrice: 20000 }],
    subtotal: 20000, total: 20000, status: 'pending', fulfillment: 'delivery', address: 'X', phone: '+998901112233', paymentMethod: 'cash',
  });
  const orig = Order.findOneAndUpdate.bind(Order);
  let armed = true;
  Order.findOneAndUpdate = (...a) => {
    if (armed && a[1]?.status === 'accepted') {
      armed = false;
      // changeOrderStatus `.populate('userId')` ni zanjirlaydi — shu shaklni saqlaymiz
      return { populate: (p) => Order.collection.updateOne({ _id: race._id }, { $set: { status: 'accepted' } }).then(() => orig(...a).populate(p)) };
    }
    return orig(...a);
  };
  let status = 0; let body = null;
  const res = { status(c) { status = c; return this; }, json(b) { body = b; return this; } };
  await restaurantPanelController.updateOrderStatus({ restaurantId: A.id, params: { id: String(race._id) }, body: { status: 'accepted' } }, res, () => {});
  await sleep(400);
  Order.findOneAndUpdate = orig;
  ok(status === 409 && body?.code === 'RACE_LOST', `yutqazgan qurilma: 409 ${body?.code}`);
  ok(/boshqa xodim/.test(body?.error || ''), 'xabar matni ham bor');
}

console.log('\n[7] TARIX: /orders/history — sana, holat, sahifalash (cursor)');
{
  // Nazorat qilinadigan sanalar — xom yozuv (hook'siz)
  const mkRaw = (over) => ({
    _id: new mongoose.Types.ObjectId(), userId: user._id, restaurantId: A.r._id, restaurantName: 'TOTLI',
    items: [{ name: 'Osh', quantity: 1, unitPrice: 20000 }], subtotal: 20000, total: 20000, deliveryFee: 0,
    status: 'pending', fulfillment: 'pickup', paymentMethod: 'cash', phone: '+998901112233', ...over,
  });
  await Order.deleteMany({ restaurantId: A.r._id }); // toza sahifa
  const sameT = at(YESTERDAY, '12:00');
  const rows = [
    mkRaw({ status: 'delivered', createdAt: at(TODAY, '00:10'), updatedAt: at(TODAY, '00:20') }),     // 0: Toshkent bugun 00:10 (UTC kecha!)
    mkRaw({ status: 'pending', createdAt: at(TODAY, '09:00'), updatedAt: at(TODAY, '09:00') }),
    mkRaw({ status: 'cancelled', createdAt: at(YESTERDAY, '20:00'), updatedAt: at(YESTERDAY, '20:00') }),
    mkRaw({ status: 'delivered', createdAt: sameT, updatedAt: sameT }),                               // 3 va 4: BIR XIL createdAt
    mkRaw({ status: 'accepted', createdAt: sameT, updatedAt: sameT }),
    mkRaw({ status: 'delivered', createdAt: at(addDaysYmd(TODAY, -3), '10:00'), updatedAt: at(addDaysYmd(TODAY, -3), '10:00') }),
    mkRaw({ status: 'ready', createdAt: at(addDaysYmd(TODAY, -5), '10:00'), updatedAt: at(addDaysYmd(TODAY, -5), '10:00') }),
    // ko'rinmaydiganlar
    mkRaw({ status: 'awaiting_payment', paymentMethod: 'click', createdAt: at(TODAY, '10:00') }),
    mkRaw({ status: 'pending', fulfillment: 'dinein', createdAt: at(TODAY, '10:01') }),
    mkRaw({ status: 'pending', restaurantId: B.r._id, createdAt: at(TODAY, '10:02') }),
  ];
  await Order.collection.insertMany(rows);

  const all = await S('GET', A.id, '/orders/history?limit=200');
  ok(all.status === 200 && all.json.items.length === 7 && all.json.hasMore === false && all.json.nextCursor === null, `hammasi: 7 ta (awaiting_payment, zal, boshqa restoran YO‘Q) ${all.json.items.length}`);
  ok(all.json.items.every((o, i, a) => i === 0 || new Date(a[i - 1].createdAt) >= new Date(o.createdAt)), 'yangisi birinchi');
  ok(!JSON.stringify(all.json).includes('lokmaNet') && all.json.items[0].customer?.name === 'Azimjon Karimov', 'tarix ham toza va customer bilan');

  // Sahifalash: 3 tadan, takror/tushib qolishsiz (BIR XIL createdAt li ikki buyurtma ham)
  const seen = []; let cursor = null; let pages = 0; let lastHasMore = null;
  do {
    const r = await S('GET', A.id, `/orders/history?limit=3${cursor ? `&cursor=${cursor}` : ''}`);
    r.json.items.forEach((o) => seen.push(o._id)); cursor = r.json.nextCursor; lastHasMore = r.json.hasMore; pages++;
  } while (cursor && pages < 10);
  ok(seen.length === 7 && new Set(seen).size === 7, `3 tadan sahifalash: ${pages} sahifa, 7 ta noyob (takror va tushib qolish yo‘q)`);
  ok(pages === 3 && lastHasMore === false, 'oxirgi sahifada hasMore:false, nextCursor:null');

  // Sana (Toshkent kuni)
  const day = await S('GET', A.id, `/orders/history?from=${TODAY}&to=${TODAY}`);
  ok(day.json.items.length === 2, `bugun (Toshkent): 2 ta — 00:10 (UTC bo‘yicha kecha) ham shu kunda: ${day.json.items.length}`);
  const y = await S('GET', A.id, `/orders/history?from=${YESTERDAY}&to=${YESTERDAY}`);
  ok(y.json.items.length === 3, `kecha: 3 ta (bittasi 20:00 Toshkent): ${y.json.items.length}`);
  const one = await S('GET', A.id, `/orders/history?from=${YESTERDAY}`);
  ok(one.json.items.length === 3, 'faqat from — o‘sha bir kun');
  const range = await S('GET', A.id, `/orders/history?from=${addDaysYmd(TODAY, -3)}&to=${TODAY}`);
  ok(range.json.items.length === 6, `oraliq (4 kun): 6 ta ${range.json.items.length}`);
  const st = await S('GET', A.id, '/orders/history?status=delivered&limit=50');
  ok(st.json.items.length === 3 && st.json.items.every((o) => o.status === 'delivered'), 'status=delivered: 3 ta');
  const dp = await S('GET', A.id, `/orders/history?status=delivered&from=${TODAY}&to=${TODAY}&limit=1`);
  ok(dp.json.items.length === 1 && dp.json.hasMore === false, 'status + sana birga');

  ok((await S('GET', A.id, '/orders/history?status=bogus')).json?.code === 'INVALID_STATUS_FILTER', 'noto‘g‘ri status filtri → 400');
  ok((await S('GET', A.id, '/orders/history?status=awaiting_payment')).status === 400, 'awaiting_payment filtri ham rad (ko‘rinmaydi)');
  ok((await S('GET', A.id, '/orders/history?cursor=abc')).json?.code === 'INVALID_CURSOR', 'noto‘g‘ri cursor → 400');
  ok((await S('GET', A.id, '/orders/history?from=abc')).status === 400, 'noto‘g‘ri sana → 400 (jimgina e’tiborsiz qoldirilmaydi)');
  ok((await S('GET', A.id, `/orders/history?from=${TODAY}&to=${YESTERDAY}`)).status === 400, 'teskari oraliq → 400');
  ok((await S('GET', A.id, '/orders/history?limit=999')).json.items.length === 7 && (await S('GET', A.id, '/orders/history?limit=0')).json.items.length === 7, 'limit chegaralanadi (1..200), /orders/:id bilan to‘qnashmaydi');
  ok((await S('GET', A.id, '/orders/history')).status === 200, '"history" buyurtma ID si deb o‘qilmadi (CAST xatosi yo‘q)');
}

console.log('\n[8] STATISTIKA: /stats (kunlik, Toshkent)');
{
  await Order.deleteMany({ restaurantId: A.r._id });
  const fin = (payoutSom) => ({ model: 'v2', restaurantPayout: payoutSom * 100, lokmaNetCommission: 99999900, clickFeeAmount: 555500 });
  const mk = (over) => ({
    _id: new mongoose.Types.ObjectId(), userId: user._id, restaurantId: A.r._id, restaurantName: 'TOTLI',
    items: [{ name: 'Osh', quantity: 1, unitPrice: 1 }], subtotal: 20000, deliveryFee: 0, total: 20000,
    status: 'delivered', fulfillment: 'pickup', paymentMethod: 'cash', phone: '1', createdAt: at(TODAY, '09:00'), updatedAt: at(TODAY, '12:00'), deliveredAt: at(TODAY, '12:00'), ...over,
  });
  await Order.collection.insertMany([
    mk({ subtotal: 40000, deliveryFee: 10000, total: 50000, fulfillment: 'delivery', paymentMethod: 'click', finance: fin(45000) }),
    mk({ subtotal: 20000, total: 20000, finance: fin(18000) }),
    mk({ subtotal: 30000, total: 30000 }),                                                      // eski: finance yo'q
    mk({ status: 'delivered', createdAt: at(addDaysYmd(TODAY, -3), '10:00'), subtotal: 10000, total: 10000, finance: fin(9000) }), // 3 kun oldin yaratilgan, BUGUN yetkazilgan
    mk({ status: 'delivered', deliveredAt: at(YESTERDAY, '15:00'), createdAt: at(YESTERDAY, '14:00'), subtotal: 70000, total: 70000, finance: fin(63000) }),
    mk({ status: 'cancelled', deliveredAt: undefined, cancelledAt: at(TODAY, '11:00'), fulfillment: 'delivery' }),
    mk({ status: 'pending', deliveredAt: undefined, fulfillment: 'delivery' }),
    mk({ status: 'awaiting_payment', deliveredAt: undefined, paymentMethod: 'click' }),
    mk({ status: 'delivered', fulfillment: 'dinein' }),
    mk({ status: 'delivered', restaurantId: B.r._id }),
  ]);
  const s = await S('GET', A.id, '/stats');
  ok(s.status === 200 && s.json.period.from === TODAY && s.json.period.to === TODAY && s.json.period.timezone === 'Asia/Tashkent', `davr: bugun (Toshkent) ${s.json.period?.from}`);
  const c = s.json.created; const d = s.json.delivered;
  ok(c.count === 5 && c.byStatus.delivered === 3 && c.byStatus.cancelled === 1 && c.byStatus.pending === 1, `created: 5 ta (delivered 3, cancelled 1, pending 1; awaiting_payment/zal/B yo‘q) — ${JSON.stringify(c.byStatus)}`);
  ok(c.byFulfillment.delivery === 3 && c.byFulfillment.pickup === 2, 'created: yetkazish 3, olib ketish 2');
  ok(d.count === 4, `delivered: bugun yetkazilgan 4 ta (3 kun oldin yaratilgani ham; kecha yetkazilgani, zal va awaiting yo‘q): ${d.count}`);
  ok(d.total === 110000 && d.foodTotal === 100000 && d.deliveryFee === 10000, `summalar: jami ${d.total}, taom ${d.foodTotal}, yetkazish ${d.deliveryFee}`);
  ok(d.restaurantPayout === 72000 && d.legacyOrders === 1, `restoran ulushi 45 000+18 000+9 000 = ${d.restaurantPayout}; finance’siz eski buyurtma ${d.legacyOrders} ta (jimgina 0 deb yig‘ilmadi)`);
  ok(d.byPayment.cash.count === 3 && d.byPayment.cash.total === 60000 && d.byPayment.card.count === 1 && d.byPayment.card.total === 50000, `naqd/karta: ${JSON.stringify(d.byPayment)}`);
  ok(d.byFulfillment.delivery.count === 1 && d.byFulfillment.pickup.count === 3, 'yetkazish 1, olib ketish 3');
  ok(s.json.cancelled.count === 1 && s.json.truncated === false, 'bekor qilingan (cancelledAt bugun) 1 ta; truncated:false');
  ok(!JSON.stringify(s.json).includes('lokmaNet') && !JSON.stringify(s.json).includes('clickFee'), 'LokmaGo ichki ko‘rsatkichlari YO‘Q');

  const y = await S('GET', A.id, `/stats?from=${YESTERDAY}&to=${YESTERDAY}`);
  ok(y.json.delivered.count === 1 && y.json.delivered.total === 70000 && y.json.delivered.restaurantPayout === 63000, 'kecha: 1 ta, 70 000, ulush 63 000');
  const wide = await S('GET', A.id, `/stats?from=${addDaysYmd(TODAY, -5)}&to=${TODAY}`);
  ok(wide.json.delivered.count === 5 && wide.json.delivered.total === 180000, `oraliq: 5 ta / 180 000: ${wide.json.delivered.count}/${wide.json.delivered.total}`);
  const empty = await S('GET', A.id, `/stats?from=${addDaysYmd(TODAY, -30)}&to=${addDaysYmd(TODAY, -29)}`);
  ok(empty.json.delivered.count === 0 && empty.json.delivered.total === 0 && empty.json.created.count === 0, 'bo‘sh davr — nollar (xato emas)');
  ok((await S('GET', A.id, '/stats?from=abc')).status === 400 && (await S('GET', A.id, `/stats?from=${TODAY}&to=${YESTERDAY}`)).status === 400, 'noto‘g‘ri/teskari sana → 400');
  const bS = await S('GET', B.id, '/stats');
  ok(bS.json.delivered.count === 1 && bS.json.delivered.total === 20000, 'boshqa restoran (B) faqat o‘zinikini ko‘radi');
}

console.log('\n[9] "YETKAZILDI" tasdiqlash: POST /orders/:id/confirm-delivered');
{
  await Order.deleteMany({ restaurantId: A.r._id });
  const mkD = (over) => Order.create({
    userId: user._id, restaurantId: A.r._id, restaurantName: 'TOTLI', items: [{ name: 'Osh', quantity: 1, unitPrice: 20000 }],
    subtotal: 20000, deliveryFee: 5000, total: 25000, status: 'delivering', fulfillment: 'delivery', address: 'X', phone: '+998901112233', paymentMethod: 'cash', ...over,
  });
  const backdate = (id, fields) => Order.collection.updateOne({ _id: id }, { $set: fields });
  const dues = (id) => Ledger.countDocuments({ orderId: id, type: 'restaurant_due' });
  const confirm = (id, opts) => S('POST', A.id, `/orders/${id}/confirm-delivered`, opts);

  // erta
  const fresh = await mkD({ deliveringAt: new Date() });
  const early = await confirm(fresh._id);
  ok(early.status === 409 && early.json.code === 'CONFIRM_TOO_EARLY', `yangi topshirilgan → 409 CONFIRM_TOO_EARLY`);
  const eligibleAt = new Date(early.json.eligibleAt).getTime();
  ok(Math.abs(eligibleAt - (Date.now() + 30 * 60_000)) < 15_000, `eligibleAt ≈ hozir + 30 daqiqa: ${early.json.eligibleAt}`);
  ok((await S('GET', A.id, `/orders/${fresh._id}`)).json.restaurantConfirm?.eligible === false, 'buyurtma JSON’ida restaurantConfirm.eligible:false');
  ok((await Order.findById(fresh._id).lean()).status === 'delivering' && await dues(fresh._id) === 0, 'erta urinish hech narsani o‘zgartirmadi, komissiya yozilmadi');

  // vaqti o'tgach
  await backdate(fresh._id, { deliveringAt: new Date(Date.now() - 40 * 60_000) });
  const el = (await S('GET', A.id, `/orders/${fresh._id}`)).json;
  ok(el.restaurantConfirm.eligible === true, '40 daqiqadan keyin restaurantConfirm.eligible:true');
  bffGot.length = 0;
  const done = await confirm(fresh._id);
  ok(done.status === 200 && done.json.changed === true && done.json.status === 'delivered', 'tasdiqlandi → 200, changed:true, delivered');
  ok(done.json.deliveryCheck.confirmedBy === 'restaurant', 'confirmedBy: "restaurant" (manba aniq)');
  ok(!JSON.stringify(done.json).includes('lokmaNet') && !JSON.stringify(done.json).includes('"cards"') && done.json.customer?.name, 'javob toza (PATCH bilan bir xil ko‘rinish)');
  await sleep(300);
  ok(await dues(fresh._id) === 1, 'komissiya 1 marta hisoblandi (deliveryCheck yo‘li)');
  const again = await confirm(fresh._id);
  await sleep(300);
  ok(again.status === 200 && again.json.changed === false && await dues(fresh._id) === 1, 'takroriy chaqiruv → 200 changed:false, komissiya takrorlanmadi');
  ok(done.json.restaurantConfirm === null, 'yakunlangach restaurantConfirm: null');

  // boshqa holatlar
  const pend = await mkD({ status: 'pending' });
  ok((await confirm(pend._id)).json?.code === 'WRONG_STATE', 'pending → 400 WRONG_STATE (hali qabul qilinmagan)');
  const canc = await mkD({ status: 'cancelled' });
  const rc = await confirm(canc._id); ok(rc.status === 409 && rc.json.code === 'ORDER_CANCELLED', 'bekor qilingan → 409 ORDER_CANCELLED');
  ok((await S('POST', A.id, `/orders/${bId}/confirm-delivered`)).status === 404, 'boshqa restoran buyurtmasi → 404');
  const dine = await mkD({ status: 'ready', fulfillment: 'dinein' });
  ok((await confirm(dine._id)).status === 404, 'zal buyurtmasi → 404 (gateway’da yo‘q)');
  ok((await confirm('xyz')).status === 400, 'noto‘g‘ri ID → 400 (CAST)');

  // Eslatma allaqachon yuborilgan bo'lsa — vaqt sharti o'tgan hisoblanadi
  const asked = await mkD({ deliveringAt: new Date(), restaurantReminder: { askedCount: 1, lastAskedAt: new Date(), forStatus: 'delivering' } });
  const ra = await confirm(asked._id);
  ok(ra.status === 200 && ra.json.changed === true, 'eslatma yuborilgan bo‘lsa (askedCount≥1) darhol tasdiqlanadi');
  const askedOld = await mkD({ deliveringAt: new Date(), restaurantReminder: { askedCount: 1, lastAskedAt: new Date(), forStatus: 'ready' } });
  ok((await confirm(askedOld._id)).status === 409, 'ESKI holat uchun yuborilgan eslatma hisobga olinmaydi (forStatus mos emas)');

  // Rejalashtirilgan: vaqti kelmaguncha so'ralmaydi
  const sched = await mkD({ status: 'ready', readyAt: new Date(Date.now() - 3 * 3_600_000), scheduledFor: new Date(Date.now() + 20 * 3_600_000) });
  const rs = await confirm(sched._id);
  ok(rs.status === 409 && new Date(rs.json.eligibleAt).getTime() > Date.now() + 19 * 3_600_000, 'ertangi rejalashtirilgan buyurtma: eligibleAt rejalashtirilgan vaqtdan keyin');

  // Olib ketish: vaqt sharti yo'q
  const pk = await mkD({ status: 'ready', fulfillment: 'pickup', readyAt: new Date() });
  const rp = await confirm(pk._id);
  ok(rp.status === 200 && rp.json.changed === true, 'olib ketish — darhol (vaqt sharti yo‘q)');

  // Bevosita PATCH delivered qoidasi o'zgarmagan
  const p2 = await mkD({ status: 'ready', readyAt: new Date() });
  ok((await S('PATCH', A.id, `/orders/${p2._id}/status`, { body: { status: 'delivered' } })).status === 400, 'yetkazib berishda PATCH delivered hamon rad etiladi');
}

console.log('\n[10] BFF hodisalari — HAQIQIY serverdan soxta BFF ga yetib boradi');
{
  bffGot.length = 0;
  const o = await Order.create({
    userId: user._id, restaurantId: A.r._id, restaurantName: 'TOTLI', items: [{ name: 'Osh', quantity: 1, unitPrice: 20000 }],
    subtotal: 20000, total: 20000, status: 'accepted', fulfillment: 'pickup', phone: '1', paymentMethod: 'cash',
  });
  bffGot.length = 0;
  // Server jarayoni o'zi yuboradi: yozuv gateway orqali (server ichida)
  const r = await S('PATCH', A.id, `/orders/${o._id}/status`, { body: { status: 'ready' } });
  ok(r.status === 200, 'PATCH ready (servis yo‘li)');
  for (let i = 0; i < 30 && !bffGot.some((e) => e.json.event === 'updated' && e.json.orderId === String(o._id)); i++) await sleep(300);
  const ev = bffGot.find((e) => e.json.event === 'updated' && e.json.orderId === String(o._id));
  ok(Boolean(ev), 'server BFF ga "updated" yubordi (ishchi index.js da ishga tushgan)');
  ok(ev?.url === '/internal/orders/events' && ev.headers['x-webhook-secret'] === WEBHOOK && ev.json.restaurantId === A.id && Object.keys(ev.json).length === 3, 'yo‘l, sir, restaurantId, faqat 3 maydon');

  const c = await place(A, 'pickup');
  ok(c.status === 201, 'yangi buyurtma (POST /api/orders)');
  const created = await Order.findOne({ restaurantId: A.r._id, status: 'pending' }).sort({ createdAt: -1 }).lean();
  for (let i = 0; i < 30 && !bffGot.some((e) => e.json.event === 'created' && e.json.orderId === String(created._id)); i++) await sleep(300);
  ok(bffGot.some((e) => e.json.event === 'created' && e.json.orderId === String(created._id)), 'server BFF ga "created" yubordi');

  await S('PATCH', A.id, `/orders/${created._id}/status`, { body: { status: 'cancelled' } });
  for (let i = 0; i < 30 && !bffGot.some((e) => e.json.event === 'cancelled' && e.json.orderId === String(created._id)); i++) await sleep(300);
  ok(bffGot.some((e) => e.json.event === 'cancelled' && e.json.orderId === String(created._id)), 'bekor qilish → "cancelled"');
}

console.log('\n[11] FAIL-CLOSED: sozlama to‘liq bo‘lmasa servis yo‘li YO‘Q (404)');
{
  const cases = [
    ['kalit qisqa (< 24)', { GATEWAY_SERVICE_KEY: 'short-key', GATEWAY_ALLOWED_IPS: '127.0.0.1' }, 4193],
    ['kalit bor, IP ro‘yxati BO‘SH', { GATEWAY_SERVICE_KEY: KEY, GATEWAY_ALLOWED_IPS: '' }, 4194],
    ['IP bor, kalit yo‘q', { GATEWAY_SERVICE_KEY: '', GATEWAY_ALLOWED_IPS: '127.0.0.1' }, 4195],
    ['IP ro‘yxati faqat yaroqsiz yozuvlar', { GATEWAY_SERVICE_KEY: KEY, GATEWAY_ALLOWED_IPS: '0.0.0.0/0, abc' }, 4196],
  ];
  for (const [name, env, port] of cases) {
    const s = startServer(port, env); servers.push(s.srv);
    const up = await waitUp(port);
    const r = up ? await req('GET', svc(A.id, ''), { base: `http://127.0.0.1:${port}` }) : { status: 'server yo‘q' };
    ok(up && r.status === 404, `${name} → 404 (${r.status})`);
    s.srv.kill('SIGKILL');
  }
}

servers.forEach((s) => { try { s.kill('SIGKILL'); } catch { /* */ } });
bff.close();
console.log(fails ? `\n✗ ${fails} ta xato` : '\n✓ HAMMASI O‘TDI');
await mongoose.disconnect();
process.exit(fails ? 1 : 0);
