/*
 * ═══════════════════════════════════════════════════════════
 * RESTORAN PINI (1/2/3-o'rin, muddat bilan) — HAQIQIY server
 * ═══════════════════════════════════════════════════════════
 * Admin API (ruxsat, tekshiruv, to'qnashuv, o'zgartirish, bekor qilish) va
 * mijoz ro'yxati (/restaurants) HTTP orqali; vaqt chegaralari va poyga —
 * xizmat darajasida (soxta "hozir" bilan, kutmasdan).
 * npm run test:pins
 */
import { spawn } from 'node:child_process';

const PORT = 4198;
const MONGO_URI = 'mongodb://127.0.0.1:27017/lokma_pins';
const JWT_SECRET = 'pins-test-secret-pins-test-secret-pins-x';
process.env.MONGO_URI = MONGO_URI; process.env.JWT_SECRET = JWT_SECRET;

const mongoose = (await import('mongoose')).default;
const jwt = (await import('jsonwebtoken')).default;
await mongoose.connect(MONGO_URI); await mongoose.connection.db.dropDatabase();
const { Restaurant } = await import('../src/models/Restaurant.js');
const { RestaurantPin } = await import('../src/models/RestaurantPin.js');
const { User } = await import('../src/models/User.js');
const Pins = await import('../src/services/restaurantPins.js');

let fails = 0;
const ok = (c, m) => { console.log(c ? '  ✓' : '  ✗ FAIL:', m); if (!c) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIN = 60_000; const HOUR = 3_600_000; const DAY = 86_400_000;
const T = Date.now();
const at = (ms) => new Date(T + ms).toISOString();

/* ── restoranlar (createdAt o'sish tartibida: R1 eng eski … R5 eng yangi) ── */
const mk = async (name, extra = {}) => {
  const r = await Restaurant.create({ name, cuisine: 'milliy', category: 'restoran', isApproved: true, isActive: true, openTime: '00:00', closeTime: '23:59', workingDays: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], ...extra });
  await sleep(8);
  return r;
};
const R = [];
for (const n of ['R1 eng eski', 'R2', 'R3', 'R4', 'R5 eng yangi']) R.push(await mk(n));
const CAFE = await mk('KAFE', { category: 'kafe' });
const BLOCKED = await mk('BLOKLANGAN', { isBlocked: true });
const PENDING = await mk('TASDIQLANMAGAN', { isApproved: false });
const INACTIVE = await mk('FAOL EMAS', { isActive: false });
const id = (r) => String(r._id);

const admin = await User.create({ firstName: 'Bahrom', login: 'bahrom', role: 'admin' });
const tok = (role, extra = {}) => jwt.sign({ userId: String(admin._id), role, ...extra }, JWT_SECRET);
const ADMIN = tok('admin'); const MKT = tok('staff', { department: 'marketing' }); const ACC = tok('staff', { department: 'accountant' });
const RESTO = tok('restaurant', { restaurantId: id(R[0]) });

// --import: FerretDB `$addToSet` ni qo'llamaydi — tests/_ferret-shim.mjs bitta aggregatsiyani JS bilan almashtiradi (mahsulot kodiga tegilmaydi)
const srv = spawn('node', ['--import', './tests/_ferret-shim.mjs', 'src/index.js'], {
  env: { ...process.env, PORT: String(PORT), NODE_ENV: 'development', MONGO_URI, JWT_SECRET, PINS_CACHE_MS: '600000', RESTAURANT_BOT_TOKEN: '', TELEGRAM_BOT_TOKEN: '', J_ROUTE_HOSTS: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let srvLog = ''; srv.stdout.on('data', (d) => { srvLog += d; }); srv.stderr.on('data', (d) => { srvLog += d; });
process.on('exit', () => { try { srv.kill('SIGKILL'); } catch { /* */ } });
for (let i = 0; i < 80; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break; } catch { /* */ } await sleep(300); }

async function api(method, path, { body, token = ADMIN } = {}) {
  const res = await fetch(`http://127.0.0.1:${PORT}/api${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  let json = null; try { json = await res.json(); } catch { /* */ }
  return { status: res.status, json };
}
const post = (b, token) => api('POST', '/admin/pins', { body: b, token });
const pub = async (q = '') => {
  const r = await api('GET', `/restaurants${q}`, { token: null });
  if (!r.json?.items) console.log('  !! /restaurants xato:', r.status, JSON.stringify(r.json), '\n  server log:', srvLog.split('\n').slice(-12).join('\n  '));
  return r.json;
};
const names = (j) => j.items.map((i) => i.name);

// Mijoz ro'yxati — pinsiz ASOSIY holat (keyin "avvalgidek"ligini solishtiramiz)
const baseline = await pub('?limit=50');
const baseline2 = await pub('?limit=2');
const baselineResto2 = await pub('?category=restoran&limit=2');

console.log('\n[1] RUXSAT: faqat admin va marketing bo‘limi');
{
  ok((await api('GET', '/admin/pins', { token: null })).status === 401, 'tokensiz → 401');
  ok((await api('GET', '/admin/pins', { token: RESTO })).status === 403, 'restoran roli → 403 (faqat LokmaGo admin paneli)');
  ok((await api('GET', '/admin/pins', { token: ACC })).status === 403, 'buxgalter (marketing ruxsati yo‘q) → 403');
  ok((await api('GET', '/admin/pins', { token: MKT })).status === 200, 'marketing xodimi → 200');
  ok((await api('GET', '/admin/pins', { token: ADMIN })).status === 200, 'admin → 200');
  ok((await post({ restaurantId: id(R[0]), position: 1, startsAt: at(0), endsAt: at(HOUR) }, ACC)).status === 403, 'buxgalter pin yarata olmaydi');
  ok((await api('DELETE', `/admin/pins/${'a'.repeat(24)}`, { token: RESTO })).status === 403, 'restoran pinni o‘chira olmaydi');
  const e = await api('GET', '/admin/pins');
  ok(e.json.pins.length === 0 && JSON.stringify(e.json.positions) === '[1,2,3]', 'boshida pin yo‘q; o‘rinlar [1,2,3]');
}

console.log('\n[1b] RESTORAN TANLASH ro‘yxati (marketing ruxsati ostida, xavfsiz maydonlar)');
{
  const all = await api('GET', '/admin/pins/restaurants', { token: MKT });
  ok(all.status === 200 && all.json.length === 6 && !all.json.some((x) => ['BLOKLANGAN', 'TASDIQLANMAGAN', 'FAOL EMAS'].includes(x.name)), `marketing xodimi oladi; faqat mijozlarga ko‘rinadiganlar (${all.json.length} ta): bloklangan/tasdiqlanmagan/faol emas YO‘Q`);
  ok(all.json.every((x) => Object.keys(x).sort().join() === 'category,cuisine,imageUrl,name,_id'.split(',').sort().join()), 'faqat nom, rasm, tur (moliya/shartnoma maydonlari chiqmaydi)');
  ok(JSON.stringify(all.json.map((x) => x.name)) === JSON.stringify([...all.json.map((x) => x.name)].sort()), 'nom bo‘yicha tartiblangan');
  const q = await api('GET', '/admin/pins/restaurants?q=kaf', { token: ADMIN });
  ok(q.json.length === 1 && q.json[0].name === 'KAFE', 'qidiruv ("kaf" → KAFE, katta-kichik harfga befarq)');
  ok((await api('GET', '/admin/pins/restaurants?q=.*', { token: ADMIN })).json.length === 0, 'maxsus belgilar (regex) matn sifatida — ".*" hammasini qaytarmaydi');
  ok((await api('GET', '/admin/pins/restaurants', { token: ACC })).status === 403 && (await api('GET', '/admin/pins/restaurants', { token: RESTO })).status === 403, 'buxgalter va restoran roli — 403');
}

console.log('\n[2] YARATISH: 1-o‘rin, hozirdan 1 soatga');
let P1;
{
  const r = await post({ restaurantId: id(R[0]), position: 1, startsAt: at(0), endsAt: at(HOUR), note: 'to‘langan: 500 000' });
  P1 = r.json;
  ok(r.status === 201 && P1.status === 'active' && P1.position === 1 && P1.restaurant.name === 'R1 eng eski', `201, active, 1-o‘rin: ${P1.status}`);
  ok(P1.createdByName === 'Bahrom' && P1.note === 'to‘langan: 500 000', 'kim qo‘ygani va izoh saqlandi (audit)');
  ok(P1.restaurant.visible === true, 'restoran mijozlarga ko‘rinadi (visible)');
}

console.log('\n[3] TEKSHIRUVLAR');
{
  const bad = async (body, code, status = 400, msg) => {
    const r = await post({ restaurantId: id(R[1]), position: 2, startsAt: at(0), endsAt: at(HOUR), ...body });
    ok(r.status === status && r.json.code === code, `${msg}: ${r.status} ${r.json.code}`);
    return r;
  };
  await bad({ position: 0 }, 'INVALID_POSITION', 400, 'o‘rin 0');
  await bad({ position: 4 }, 'INVALID_POSITION', 400, 'o‘rin 4');
  await bad({ position: '2' }, 'INVALID_BODY', 400, 'o‘rin matn');
  await bad({ position: 1.5 }, 'INVALID_BODY', 400, 'o‘rin kasr');
  await bad({ restaurantId: 'xyz' }, 'INVALID_BODY', 400, 'restoran ID formati');
  await bad({ restaurantId: 'a'.repeat(24) }, 'RESTAURANT_NOT_FOUND', 404, 'mavjud emas restoran');
  await bad({ restaurantId: id(BLOCKED) }, 'RESTAURANT_NOT_LISTED', 400, 'bloklangan restoran');
  await bad({ restaurantId: id(PENDING) }, 'RESTAURANT_NOT_LISTED', 400, 'tasdiqlanmagan restoran');
  await bad({ restaurantId: id(INACTIVE) }, 'RESTAURANT_NOT_LISTED', 400, 'faol bo‘lmagan restoran');
  await bad({ endsAt: at(0) }, 'INVALID_RANGE', 400, 'tugash = boshlanish');
  await bad({ startsAt: at(2 * HOUR), endsAt: at(HOUR) }, 'INVALID_RANGE', 400, 'tugash boshlanishdan oldin');
  await bad({ startsAt: at(-3 * HOUR), endsAt: at(-2 * HOUR) }, 'ENDS_IN_PAST', 400, 'butunlay o‘tmishda');
  await bad({ startsAt: at(HOUR), endsAt: at(HOUR + 2 * MIN) }, 'TOO_SHORT', 400, '2 daqiqalik pin');
  await bad({ startsAt: at(0), endsAt: at(401 * DAY) }, 'TOO_LONG', 400, '401 kunlik pin (yil xatosi)');
  await bad({ startsAt: at(-HOUR), endsAt: at(2 * HOUR) }, 'START_IN_PAST', 400, 'boshlanish 1 soat oldin');
  await bad({ startsAt: 'kecha' }, 'INVALID_DATE', 400, 'sana matni');
  await bad({ startsAt: at(800 * DAY), endsAt: at(801 * DAY) }, 'TOO_FAR', 400, 'boshlanish 2 yildan keyin');
  await bad({ note: 'x'.repeat(201) }, 'INVALID_BODY', 400, 'izoh 201 belgi');
  const okSoon = await post({ restaurantId: id(R[1]), position: 2, startsAt: at(-5 * MIN), endsAt: at(HOUR) });
  ok(okSoon.status === 201, '"Hozirdan": 5 daqiqa oldingi boshlanish (so‘rov yetib kelguncha o‘tgan vaqt) qabul qilinadi');
  await api('DELETE', `/admin/pins/${okSoon.json._id}`);
  ok((await api('GET', '/admin/pins')).json.pins.length === 1, 'rad etilganlar hech narsa yozmadi');
}

console.log('\n[4] TO‘QNASHUV: o‘rin band bo‘lsa boshqasini belgilab bo‘lmaydi');
{
  const c = async (body) => post({ restaurantId: id(R[1]), position: 1, ...body });
  let r = await c({ startsAt: at(10 * MIN), endsAt: at(2 * HOUR) });
  ok(r.status === 409 && r.json.code === 'POSITION_BUSY', 'qisman kesishish (oxiri) → 409 POSITION_BUSY');
  ok(r.json.conflict.restaurantName === 'R1 eng eski' && r.json.conflict._id === P1._id && /1-o‘rin/.test(r.json.error) && /R1 eng eski/.test(r.json.error), `kim band qilgani aytiladi: "${r.json.error}"`);
  r = await c({ startsAt: at(-5 * MIN), endsAt: at(30 * MIN) });
  ok(r.status === 409, 'qisman kesishish (boshi) → 409');
  r = await c({ startsAt: at(-5 * MIN), endsAt: at(3 * HOUR) });
  ok(r.status === 409, 'mavjudni ICHIGA OLGAN oraliq → 409');
  r = await c({ startsAt: at(20 * MIN), endsAt: at(40 * MIN) });
  ok(r.status === 409, 'mavjudning ICHIDAGI oraliq → 409');
  r = await c({ startsAt: at(HOUR), endsAt: at(2 * HOUR) });
  ok(r.status === 201, 'aynan tugagan vaqtda boshlansa — MUMKIN (12:00 da tugab 12:00 da boshlanadi)');
  const adj = r.json;
  r = await post({ restaurantId: id(R[1]), position: 2, startsAt: at(0), endsAt: at(HOUR) });
  ok(r.status === 201, 'BOSHQA o‘rin (2) shu vaqtda — mumkin');
  const P2 = r.json;
  r = await post({ restaurantId: id(R[0]), position: 3, startsAt: at(10 * MIN), endsAt: at(50 * MIN) });
  ok(r.status === 409 && r.json.code === 'RESTAURANT_ALREADY_PINNED' && /1-o‘rinda/.test(r.json.error), `bir restoran ikki o‘rinda bir vaqtda — 409: "${r.json.error}"`);
  r = await post({ restaurantId: id(R[0]), position: 3, startsAt: at(5 * HOUR), endsAt: at(6 * HOUR) });
  ok(r.status === 201, 'bir restoran boshqa o‘rinda, lekin KEYINGI vaqtda — mumkin');
  await api('DELETE', `/admin/pins/${r.json._id}`);
  await api('DELETE', `/admin/pins/${adj._id}`);
  await api('DELETE', `/admin/pins/${P2._id}`);
  const list = (await api('GET', '/admin/pins')).json.pins;
  ok(list.length === 1 && list[0]._id === P1._id, 'faqat P1 qoldi (qolganlari bekor qilindi)');
}

console.log('\n[5] REJALASHTIRISH: oldindan belgilash; vaqti kelmaguncha mijozga ko‘rinmaydi');
let P3;
{
  const r = await post({ restaurantId: id(R[2]), position: 3, startsAt: at(2 * HOUR), endsAt: at(4 * HOUR) });
  P3 = r.json;
  ok(r.status === 201 && P3.status === 'scheduled', 'kelajak pin — "scheduled"');
  const j = await pub('?limit=50');
  ok(!j.items.some((i) => i.name === 'R3' && i.pin), 'rejalashtirilgan pin mijoz ro‘yxatida YO‘Q');
  const r2 = await post({ restaurantId: id(R[3]), position: 3, startsAt: at(3 * HOUR), endsAt: at(5 * HOUR) });
  ok(r2.status === 409 && r2.json.code === 'POSITION_BUSY', 'rejalashtirilgan oraliq ham o‘rinni BAND qiladi');
  const r3 = await post({ restaurantId: id(R[3]), position: 3, startsAt: at(4 * HOUR), endsAt: at(5 * HOUR) });
  ok(r3.status === 201, 'rejalashtirilgandan keyingi oraliq — mumkin');
  await api('DELETE', `/admin/pins/${r3.json._id}`);
  const r4 = await post({ restaurantId: id(R[3]), position: 3, startsAt: at(HOUR), endsAt: at(2 * HOUR) });
  ok(r4.status === 201, 'rejalashtirilgan pin BOSHLANGAN vaqtda tugaydigan oraliq — mumkin (chegara teng)');
  await api('DELETE', `/admin/pins/${r4.json._id}`);
}

console.log('\n[6] O‘ZGARTIRISH: uzaytirish, to‘qnashuv, qoidalar');
{
  let r = await api('PATCH', `/admin/pins/${P1._id}`, { body: { endsAt: at(3 * HOUR) } });
  ok(r.status === 200 && Math.abs(new Date(r.json.endsAt) - (T + 3 * HOUR)) < 1000, 'faol pinni UZAYTIRISH — 200');
  const blocker = await post({ restaurantId: id(R[1]), position: 1, startsAt: at(3 * HOUR), endsAt: at(4 * HOUR) });
  r = await api('PATCH', `/admin/pins/${P1._id}`, { body: { endsAt: at(3 * HOUR + 30 * MIN) } });
  ok(r.status === 409 && r.json.code === 'POSITION_BUSY', 'uzaytirish keyingi pin bilan to‘qnashsa — 409');
  r = await api('PATCH', `/admin/pins/${P1._id}`, { body: { endsAt: at(2 * HOUR) } });
  ok(r.status === 200, 'qisqartirish — 200');
  r = await api('PATCH', `/admin/pins/${P1._id}`, { body: { startsAt: at(-HOUR) } });
  ok(r.status === 400 && r.json.code === 'PIN_STARTED', 'BOSHLANGAN pinning boshlanishini o‘zgartirib bo‘lmaydi');
  r = await api('PATCH', `/admin/pins/${P1._id}`, { body: { endsAt: at(-HOUR) } });
  ok(r.status === 400 && ['ENDS_IN_PAST', 'INVALID_RANGE'].includes(r.json.code), 'tugashni o‘tmishga qo‘yib bo‘lmaydi');
  r = await api('PATCH', `/admin/pins/${P3._id}`, { body: { startsAt: at(2 * HOUR + 30 * MIN), endsAt: at(5 * HOUR) } });
  ok(r.status === 200, 'rejalashtirilgan pinning boshlanishini o‘zgartirish mumkin');
  r = await api('PATCH', `/admin/pins/${P1._id}`, { body: { note: 'yangi izoh' } });
  ok(r.status === 200 && r.json.note === 'yangi izoh', 'izohni o‘zgartirish');
  ok((await api('PATCH', `/admin/pins/${'b'.repeat(24)}`, { body: { note: 'x' } })).json.code === 'PIN_NOT_FOUND', 'yo‘q pin → 404');
  ok((await api('PATCH', '/admin/pins/xyz', { body: {} })).status === 404, 'noto‘g‘ri ID → 404');
  await api('DELETE', `/admin/pins/${blocker.json._id}`);
}

console.log('\n[7] BEKOR QILISH: o‘rin bo‘shaydi, takrorlash xavfsiz, tarix saqlanadi');
{
  let r = await api('DELETE', `/admin/pins/${P3._id}`);
  ok(r.status === 200 && r.json.status === 'cancelled', 'rejalashtirilgan pin bekor qilindi');
  const again = await api('DELETE', `/admin/pins/${P3._id}`);
  ok(again.status === 200 && again.json.cancelledAt === r.json.cancelledAt, 'takroriy bekor — 200, vaqt o‘zgarmadi (idempotent)');
  const free = await post({ restaurantId: id(R[4]), position: 3, startsAt: at(2 * HOUR + 30 * MIN), endsAt: at(4 * HOUR) });
  ok(free.status === 201, 'bekor qilingach o‘rin BO‘SH — boshqa restoran qo‘yishi mumkin');
  await api('DELETE', `/admin/pins/${free.json._id}`);
  ok((await api('GET', '/admin/pins')).json.pins.every((p) => p.status !== 'cancelled'), 'asosiy ro‘yxatda bekorlar ko‘rinmaydi');
  const h = (await api('GET', '/admin/pins?history=1')).json.pins;
  ok(h.some((p) => p._id === P3._id && p.status === 'cancelled') && h.some((p) => p._id === free.json._id), 'history=1: bekor qilinganlar tarixda (kim va qachon qo‘ygani yo‘qolmaydi)');
  ok((await api('DELETE', `/admin/pins/${'c'.repeat(24)}`)).status === 404 && (await api('DELETE', '/admin/pins/xyz')).status === 404, 'yo‘q/noto‘g‘ri ID → 404');
}

console.log('\n[8] MIJOZ RO‘YXATI (/restaurants): pin belgisi, tartib, o‘rin');
{
  const p3 = await post({ restaurantId: id(R[2]), position: 3, startsAt: at(0), endsAt: at(HOUR * 5) });
  const p2 = await post({ restaurantId: id(R[3]), position: 2, startsAt: at(0), endsAt: at(HOUR * 5) });
  ok(p3.status === 201 && p2.status === 201, '3-va 2-o‘rinlarga pin qo‘yildi (P1 — 1-o‘rinda faol)');
  const j = await pub('?limit=50');
  ok(JSON.stringify(names(j).slice(0, 3)) === JSON.stringify(['R1 eng eski', 'R4', 'R3']), `birinchi uchtasi o‘rin tartibida: ${names(j).slice(0, 3)}`);
  const pins = j.items.filter((i) => i.pin);
  ok(pins.length === 3 && pins.every((i) => Object.keys(i.pin).sort().join() === 'endsAt,position'), 'pin obyekti faqat {position, endsAt} (ichki maydonlar chiqmaydi)');
  ok(j.items.find((i) => i.name === 'R4').pin.position === 2 && Math.abs(new Date(j.items.find((i) => i.name === 'R4').pin.endsAt) - (T + 5 * HOUR)) < 1000, 'R4 → 2-o‘rin, tugash vaqti to‘g‘ri');
  const rest = names(j).slice(3);
  const baseRest = names(baseline).filter((n) => !['R1 eng eski', 'R4', 'R3'].includes(n));
  ok(JSON.stringify(rest) === JSON.stringify(baseRest), 'pinsizlar o‘z tartibida (avvalgidek) pastda');
  ok(!j.items.some((i) => i.name === 'R2' && i.pin) && j.items.filter((i) => i.pin).length === 3, 'faqat 3 ta restoranda pin bor');
  ok(!JSON.stringify(j).includes('createdBy') && !JSON.stringify(j).includes('note'), 'adminning ichki ma‘lumotlari mijozga chiqmaydi');
  ok(j.items[0].dishCategories !== undefined && typeof j.items[0].isOpen === 'boolean', 'mavjud maydonlar (dishCategories, isOpen) saqlangan');
}

console.log('\n[9] BIRINCHI SAHIFAGA TUSHMAGAN restoran ham qo‘shib beriladi (mijoz faqat 1-sahifani oladi)');
{
  // Pinsiz limit=2 sahifa: eng yangi ikkitasi (KAFE, R5). R1/R4/R3 sahifada YO'Q.
  ok(JSON.stringify(names(baseline2)) === JSON.stringify(['KAFE', 'R5 eng yangi']) && baseline2.hasMore === true, `tayyorgarlik: pinsiz limit=2 → ${names(baseline2)}`);
  const j = await pub('?limit=2');
  ok(JSON.stringify(names(j)) === JSON.stringify(['R1 eng eski', 'R4', 'R3', 'KAFE', 'R5 eng yangi']), `sahifada yo‘q 3 ta pinli restoran QO‘SHILDI, o‘rin tartibida: ${names(j)}`);
  ok(j.items.filter((x) => x.pin).length === 3, 'aynan 3 ta pin');
  ok(j.hasMore === baseline2.hasMore && j.nextCursor === baseline2.nextCursor && j.nextCursor, 'hasMore va nextCursor pin bo‘lsa ham O‘ZGARMADI (sahifalash buzilmaydi)');
  const isoOnly = await api('GET', `/restaurants?limit=2&cursor=${encodeURIComponent(j.nextCursor.split('|')[0])}`, { token: null });
  ok(isoOnly.status === 200 && Array.isArray(isoOnly.json.items), 'ESKI kursor formati (faqat ISO) avvalgidek ishlaydi');
  const page2 = await pub(`?limit=2&cursor=${encodeURIComponent(j.nextCursor)}`);
  ok(page2.items.every((x) => !['KAFE', 'R5 eng yangi'].includes(x.name)), '2-sahifa 1-sahifani takrorlamaydi');
  ok(!page2.items.some((x) => x.pin === undefined && ['R1 eng eski', 'R4', 'R3'].includes(x.name)), '2-sahifada pinli restoran o‘z pin belgisi bilan (qo‘shimcha nusxa YO‘Q — "qo‘shish" faqat 1-sahifada)');

  // Kategoriya filtri: R3 pinini KAFE (kategoriya 'kafe') bilan almashtiramiz
  await api('DELETE', `/admin/pins/${(await api('GET', '/admin/pins')).json.pins.find((p) => p.restaurant.name === 'R3')._id}`);
  const cafe = await post({ restaurantId: id(CAFE), position: 3, startsAt: at(0), endsAt: at(5 * HOUR) });
  ok(cafe.status === 201, 'KAFE 3-o‘ringa pin qilindi');
  const resto = await pub('?category=restoran&limit=2');
  ok(!resto.items.some((x) => x.name === 'KAFE'), 'category=restoran: kategoriyasi mos kelmaydigan pinli KAFE QO‘SHILMAYDI');
  ok(resto.items[0].name === 'R1 eng eski' && resto.items[0].pin.position === 1 && resto.items.some((x) => x.name === 'R4' && x.pin.position === 2), 'mos kelgan pinli restoranlar qo‘shildi (R1, R4)');
  ok(resto.nextCursor === baselineResto2.nextCursor, 'kategoriya bilan ham nextCursor o‘zgarmadi');
  const kafe = await pub('?category=kafe&limit=2');
  ok(names(kafe)[0] === 'KAFE' && kafe.items[0].pin.position === 3 && !kafe.items.some((x) => x.name === 'R1 eng eski'), 'category=kafe: faqat kafeda pin; boshqa kategoriya pinlari qo‘shilmaydi');
  // dublikat yo'q: pinli restoran sahifaning o'zida bor bo'lsa ikki marta chiqmaydi
  const all = await pub('?limit=50');
  ok(new Set(names(all)).size === names(all).length, 'limit=50: hech bir restoran ikki marta chiqmaydi');
}

console.log('\n[10] Bekor qilish MIJOZ ro‘yxatida DARHOL ko‘rinadi (kesh 10 daqiqa bo‘lsa ham)');
{
  const j0 = await pub('?limit=50');
  const p1 = j0.items.find((i) => i.name === 'R1 eng eski');
  ok(p1.pin?.position === 1, 'avval 1-o‘rinda');
  await api('DELETE', `/admin/pins/${P1._id}`);
  const j1 = await pub('?limit=50');
  ok(!j1.items.find((i) => i.name === 'R1 eng eski').pin, 'bekor qilingan zahoti pin yo‘q (admin o‘zgartirishi keshni tozalaydi)');
  ok(names(j1)[0] === 'R4' && j1.items[0].pin.position === 2 && j1.items[1].name === 'KAFE' && j1.items[1].pin.position === 3, 'qolgan pinlar o‘rin tartibida (R4 — 2, KAFE — 3); o‘rin raqami pin ma’lumotida saqlanadi — mijoz 2-o‘ringa qo‘yadi');
  const q = await post({ restaurantId: id(R[1]), position: 1, startsAt: at(0), endsAt: at(2 * HOUR) });
  ok(q.status === 201, 'bo‘shagan 1-o‘ringa darhol yangi restoran');
  const j2 = await pub('?limit=50');
  ok(j2.items[0].name === 'R2' && j2.items[0].pin.position === 1, 'yangi pin mijoz ro‘yxatida darhol');
}

console.log('\n[11] Restoran keyin bloklansa — ro‘yxatda ko‘rinmaydi, admin ogohlantiriladi');
{
  await Restaurant.updateOne({ _id: R[3]._id }, { isBlocked: true });
  const j = await pub('?limit=50');
  ok(!j.items.some((i) => i.name === 'R4'), 'bloklangan restoran pin bo‘lsa ham ro‘yxatda YO‘Q');
  const list = (await api('GET', '/admin/pins')).json.pins;
  ok(list.find((p) => p.restaurant?.name === 'R4').restaurant.visible === false, 'admin panelida visible:false (ogohlantirish uchun)');
  await Restaurant.updateOne({ _id: R[3]._id }, { isBlocked: false });
}

console.log('\n[12] PINSIZ ro‘yxat AVVALGIDEK (eski kodga ta’sir yo‘q)');
{
  for (const p of (await api('GET', '/admin/pins')).json.pins) await api('DELETE', `/admin/pins/${p._id}`);
  const j = await pub('?limit=50');
  ok(JSON.stringify(j) === JSON.stringify(baseline), 'barcha pinlar bekor — javob pin kiritilishidan OLDINGI bilan BAYT-BAYT bir xil');
  ok(!j.items.some((i) => 'pin' in i), 'hech bir restoranda `pin` maydoni yo‘q');
}

console.log('\n[13] VAQT CHEGARALARI (xizmat darajasida, soxta "hozir"): boshlanish kiradi, tugash kirmaydi, kutish yo‘q');
{
  await RestaurantPin.deleteMany({});
  Pins.invalidatePinsCache();
  const t0 = Date.now();
  const mkPin = (position, restaurant, s, e, extra = {}) => RestaurantPin.create({ restaurantId: restaurant._id, position, startsAt: new Date(t0 + s), endsAt: new Date(t0 + e), ...extra });
  await mkPin(1, R[0], 5_000, 8_000);          // 5s da boshlanadi, 8s da tugaydi
  const ids = async (now) => (await Pins.activePins(now)).map((p) => `${p.position}`);
  ok(JSON.stringify(await ids(t0)) === '[]', 't0: hali boshlanmagan');
  ok(JSON.stringify(await ids(t0 + 4_999)) === '[]', 'boshlanishdan 1 ms oldin — yo‘q');
  ok(JSON.stringify(await ids(t0 + 5_000)) === '["1"]', 'aynan boshlanish vaqtida — FAOL (kesh ichida, kutish yo‘q)');
  ok(JSON.stringify(await ids(t0 + 7_999)) === '["1"]', 'tugashdan 1 ms oldin — faol');
  ok(JSON.stringify(await ids(t0 + 8_000)) === '[]', 'aynan tugash vaqtida — YO‘Q (avtomatik pindan chiqdi)');
  ok(JSON.stringify(await ids(t0 + 9_000)) === '[]', 'keyin ham yo‘q (random ichiga qo‘shilib ketdi)');
  // Bekor qilingan va uzoq vaqtdan keyin
  const c = await mkPin(2, R[1], -1_000, 600_000, { cancelledAt: new Date(t0) });
  ok(JSON.stringify(await ids(t0 + 100_000)) === '[]', 'bekor qilingan pin hech qachon faol emas');
  await RestaurantPin.deleteOne({ _id: c._id });
  // tartib: o'rin bo'yicha
  await mkPin(3, R[2], -1_000, 600_000); await mkPin(2, R[3], -1_000, 600_000);
  Pins.invalidatePinsCache();
  const order = (await Pins.activePins(t0 + 200_000)).map((p) => p.position);
  ok(JSON.stringify(order) === '[2,3]', `bir nechta faol pin o‘rin bo‘yicha tartiblanadi: [${order}]`);
  // Server o'chiq turgan paytda tugagan pin — keyingi so'rovda yo'q (cron kerak emas)
  ok(JSON.stringify((await Pins.activePins(t0 + 700_000)).map((p) => p.position)) === '[]', 'server uzoq o‘chiq tursa ham muddat to‘g‘ri hisoblanadi (cron/tozalash kerak emas)');
  // Kesh qiymati: eskirgan kesh orqaga ketgan soatda ham qayta yuklanadi
  ok(Array.isArray(await Pins.activePins(t0 - 10_000_000)), 'soat orqaga ketsa ham xato bermaydi');
  await RestaurantPin.deleteMany({}); Pins.invalidatePinsCache();
}

console.log('\n[14] POYGA: ikki admin bir vaqtda — aynan BITTASI qoladi');
{
  await RestaurantPin.deleteMany({}); Pins.invalidatePinsCache();
  const orig = RestaurantPin.create.bind(RestaurantPin);
  const rivalDoc = (restaurant, oid) => ({ _id: new mongoose.Types.ObjectId(oid), restaurantId: restaurant._id, position: 1, startsAt: new Date(T), endsAt: new Date(T + HOUR), cancelledAt: null });

  // A) Raqib BIZDAN OLDIN yozilgan (kichik _id) — bizniki o'chiriladi
  RestaurantPin.create = async (doc, ...rest) => { const mine = await orig(doc, ...rest); await RestaurantPin.collection.insertOne(rivalDoc(R[1], '000000000000000000000001')); return mine; };
  let err = null;
  try { await Pins.createPin({ restaurantId: R[0]._id, position: 1, startsAt: new Date(T), endsAt: new Date(T + HOUR) }, T); } catch (e) { err = e; }
  RestaurantPin.create = orig;
  ok(err?.code === 'POSITION_BUSY' && err.status === 409 && /qayta urinib/.test(err.message), `yutqazdi: 409 POSITION_BUSY, "${err?.message}"`);
  ok(await RestaurantPin.countDocuments({ position: 1 }) === 1 && (await RestaurantPin.findOne({ position: 1 })).restaurantId.equals(R[1]._id), 'bazada faqat g‘olib (raqib) qoldi; yutqazgan o‘zini o‘chirdi');
  await RestaurantPin.deleteMany({});

  // B) Raqib bizdan KEYIN (katta _id) — biznikida qoladi
  RestaurantPin.create = async (doc, ...rest) => { const mine = await orig(doc, ...rest); await RestaurantPin.collection.insertOne(rivalDoc(R[1], 'ffffffffffffffffffffffff')); return mine; };
  let pin = null; err = null;
  try { pin = await Pins.createPin({ restaurantId: R[0]._id, position: 1, startsAt: new Date(T), endsAt: new Date(T + HOUR) }, T); } catch (e) { err = e; }
  RestaurantPin.create = orig;
  ok(!err && pin && await RestaurantPin.exists({ _id: pin._id }), 'raqib KEYIN yozilgan — bizniki qoldi (raqib o‘z tekshiruvida o‘zini o‘chiradi)');
  await RestaurantPin.deleteMany({}); Pins.invalidatePinsCache();

  // C) Bir restoranning ikki o'ringa bir vaqtda urinishi
  RestaurantPin.create = async (doc, ...rest) => { const mine = await orig(doc, ...rest); await RestaurantPin.collection.insertOne({ _id: new mongoose.Types.ObjectId('000000000000000000000002'), restaurantId: R[0]._id, position: 2, startsAt: new Date(T), endsAt: new Date(T + HOUR), cancelledAt: null }); return mine; };
  err = null;
  try { await Pins.createPin({ restaurantId: R[0]._id, position: 3, startsAt: new Date(T), endsAt: new Date(T + HOUR) }, T); } catch (e) { err = e; }
  RestaurantPin.create = orig;
  ok(err?.code === 'RESTAURANT_ALREADY_PINNED', 'bir restoran ikki o‘ringa poygada — yutqazgani RESTAURANT_ALREADY_PINNED');
  await RestaurantPin.deleteMany({}); Pins.invalidatePinsCache();
}

srv.kill('SIGKILL');
console.log(fails ? `\n✗ ${fails} ta xato` : '\n✓ HAMMASI O‘TDI');
await mongoose.disconnect();
process.exit(fails ? 1 : 0);
