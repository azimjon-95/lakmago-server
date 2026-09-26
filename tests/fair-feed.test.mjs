/*
 * ═══════════════════════════════════════════════════════════
 * ADOLATLI TASMA (fair=1) VA «BARCHASI» CURSOR TUZATISHI
 * ═══════════════════════════════════════════════════════════
 *
 * Ma'lumot ataylab muammoli: 1 ta restoran 400 taomni BIR XIL
 * createdAt bilan import qilgan (real holat), yana 9 ta restoran
 * 5 tadan taom bilan.
 *
 * npm run test:fair
 */
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/lokma_fair_feed';
const mongoose = (await import('mongoose')).default;
await mongoose.connect(process.env.MONGO_URI);
await mongoose.connection.db.dropDatabase();

const { Restaurant } = await import('../src/models/Restaurant.js');
const { Dish } = await import('../src/models/Dish.js');
const { dishController } = await import('../src/controllers/catalog.js');
const { fairOrder, parseFairCursor, makeFairCursor } = await import('../src/services/fairFeed.js');

let fails = 0;
const ok = (c, m) => { console.log(c ? '  ✓' : '  ✗ FAIL:', m); if (!c) fails++; };

async function call(query) {
  let body = null;
  let status = 200;
  const res = { status(c) { status = c; return this; }, json(b) { body = b; return this; } };
  let err = null;
  await new Promise((resolve) => {
    dishController.all({ query }, res, (e) => { err = e; resolve(); });
    const t = setInterval(() => { if (body || err) { clearInterval(t); resolve(); } }, 5);
  });
  if (err) throw err;
  return { status, body };
}

/* ═══ Ma'lumot ═══ */
const rests = [];
for (let i = 0; i < 10; i++) {
  rests.push(await Restaurant.create({
    name: `R${i}`, cuisine: 'milliy', category: 'restoran', isActive: true, isApproved: true,
  }));
}
const IMPORT_AT = new Date('2026-09-20T10:00:00.000Z');
const docs = [];
for (let i = 0; i < 400; i++) {
  docs.push({ restaurantId: rests[0]._id, section: 'menu', name: `import-${i}`, price: 20000,
    category: 'osh', isAvailable: true, createdAt: IMPORT_AT, updatedAt: IMPORT_AT });
}
for (let r = 1; r < 10; r++) {
  for (let i = 0; i < 5; i++) {
    const discounted = i === 0; // har restoranda 1 ta chegirmali
    docs.push({ restaurantId: rests[r]._id, section: 'menu', name: `R${r}-${i}`,
      price: 30000, ...(discounted ? { oldPrice: 40000 } : {}),
      category: i < 2 ? 'osh' : 'fastfood', isAvailable: true,
      createdAt: new Date(Date.UTC(2026, 7, 1 + r, i)), updatedAt: new Date() });
  }
}
// ko'rinmasligi kerak: mavjud emas, bloklangan restoran
docs.push({ restaurantId: rests[1]._id, section: 'menu', name: 'yoq', price: 1, isAvailable: false, createdAt: new Date() });
const hidden = await Restaurant.create({ name: 'Blok', cuisine: 'x', category: 'restoran', isActive: true, isApproved: true, isBlocked: true });
docs.push({ restaurantId: hidden._id, section: 'menu', name: 'blok', price: 1, isAvailable: true, createdAt: new Date() });
await Dish.collection.insertMany(docs);
const TOTAL = 445;

async function walk(first, limit) {
  const seen = [];
  let q = { ...first, limit: String(limit) };
  for (let guard = 0; guard < 100; guard++) {
    const { body } = await call(q);
    seen.push(...body.items);
    if (!body.hasMore) return { seen, last: body };
    q = { ...first, limit: String(limit), cursor: body.nextCursor };
  }
  throw new Error('cheksiz sahifalash');
}

console.log('\n[1] Sof funksiyalar');
{
  ok(JSON.stringify(parseFairCursor('fair|123|50')) === '{"seed":123,"offset":50}', 'cursor o‘qiladi');
  ok(parseFairCursor('fair|abc|5') === null && parseFairCursor('fair|1|-3') === null
    && parseFairCursor('2026-01-01|x') === null && parseFairCursor(undefined) === null, 'noto‘g‘ri cursor — null (500 emas)');
  ok(makeFairCursor(7, 30) === 'fair|7|30', 'cursor yasaladi');
  const items = [];
  for (let r = 0; r < 5; r++) for (let i = 0; i < 3; i++) items.push({ _id: `${r}${i}`, restaurantId: `r${r}` });
  const a = fairOrder(items, 42);
  ok(new Set(a.slice(0, 5).map((d) => d.restaurantId)).size === 5, 'birinchi 5 ta — 5 xil restoran');
  ok(JSON.stringify(fairOrder(items, 42)) === JSON.stringify(a), 'bir xil urug‘ — bir xil tartib');
  ok(JSON.stringify(fairOrder(items, 43)) !== JSON.stringify(a), 'boshqa urug‘ — boshqa tartib');
}

console.log('\n[2] fair=1 — birinchi raundda HAMMA restoran');
{
  // discounted=… chaqirilmaydi: mavjud chegirma filtri $expr/$not ishlatadi,
  // test bazasi (FerretDB) buni qo'llamaydi. Haqiqiy MongoDB'da ishlaydi;
  // fair tarmog'i filtrni o'zgartirmay uzatishi [5] da kategoriya bilan tekshiriladi.
  const { body } = await call({ fair: '1', limit: '50', seed: '123' });
  const first9 = new Set(body.items.slice(0, 9).map((d) => String(d.restaurantId)));
  ok(first9.size === 9, `birinchi 9 karta — 9 xil restoran (400 taomli restoran qatorni egallamadi)`);
  const inPage = new Set(body.items.map((d) => String(d.restaurantId)));
  ok(inPage.size === 10, `1-sahifada barcha 10 restoran bor (${inPage.size})`);
  ok(body.nextCursor === 'fair|123|50' && body.hasMore, `nextCursor: ${body.nextCursor}`);
  ok(body.items.every((d) => d.restaurantName && 'restaurantOpenTime' in d), 'restoran maydonlari biriktirilgan');
}

console.log('\n[3] fair=1 — butun tasma: TAKRORSIZ va HECH NARSA TUSHIB QOLMAYDI');
{
  const { seen } = await walk({ fair: '1', seed: '777' }, 30);
  const ids = seen.map((d) => String(d._id));
  ok(new Set(ids).size === ids.length, `takror yo‘q (${ids.length} ta)`);
  ok(ids.length === TOTAL, `hammasi keldi: ${ids.length}/${TOTAL}`);
  ok(!seen.some((d) => d.name === 'yoq' || d.name === 'blok'), 'mavjud emas / bloklangan chiqmaydi');
}

console.log('\n[4] Barqarorlik — oyna fokusidagi qayta so‘rov qatorni aralashtirmaydi');
{
  const a = (await call({ fair: '1', limit: '50', seed: '555' })).body.items.map((d) => String(d._id));
  const b = (await call({ fair: '1', limit: '50', seed: '555' })).body.items.map((d) => String(d._id));
  ok(JSON.stringify(a) === JSON.stringify(b), 'bir xil ?seed= — aynan bir xil sahifa');
  const c = (await call({ fair: '1', limit: '50', seed: '556' })).body.items.map((d) => String(d._id));
  ok(JSON.stringify(a) !== JSON.stringify(c), 'boshqa sessiya — boshqa tartib');
  const noSeed = (await call({ fair: '1', limit: '10' })).body;
  ok(/^fair\|\d+\|10$/.test(noSeed.nextCursor), `seed berilmasa ham cursor urug‘ni olib yuradi: ${noSeed.nextCursor}`);
}

console.log('\n[5] fair=1 + kategoriya filtri saqlanadi');
{
  const cat = await walk({ fair: '1', category: 'fastfood', seed: '9' }, 50);
  ok(cat.seen.length === 27 && cat.seen.every((d) => d.category === 'fastfood'), `kategoriya: ${cat.seen.length}/27`);
}

console.log('\n[6] «Barchasi» (fair yo‘q) — bir xil createdAt’li 400 taom TUSHIB QOLMAYDI');
{
  const { seen } = await walk({}, 50);
  const ids = seen.map((d) => String(d._id));
  ok(new Set(ids).size === ids.length, 'takror yo‘q');
  ok(ids.length === TOTAL, `hammasi keldi: ${ids.length}/${TOTAL} (avval 1-sahifadan keyin 350 ta tushib qolardi)`);
  const first = (await call({ limit: '50' })).body;
  ok(first.nextCursor.includes('|'), `cursor createdAt|_id: ${first.nextCursor}`);
  const dates = seen.map((d) => new Date(d.createdAt).getTime());
  ok(dates.every((t, i) => !i || t <= dates[i - 1]), 'tartib avvalgidek: eng yangisi birinchi');
  const legacy = (await call({ limit: '5', cursor: '2026-08-11T00:00:00.000Z' })).body;
  ok(Array.isArray(legacy.items), 'eski format (faqat sana) cursor hali qabul qilinadi');
}

console.log(fails ? `\n✗ ${fails} ta xato` : '\n✓ HAMMASI O‘TDI');
await mongoose.disconnect();
process.exit(fails ? 1 : 0);
