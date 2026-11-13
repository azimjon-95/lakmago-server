/*
 * KATTA DO'KON MENYUSI: GET /restaurants/:id/menu/index va /menu/items (bo'lim bo'yicha kursor-sahifalash).
 * 2000+ mahsulot: hammasi aniq bir marta chiqishi, bo'lim sonlari to'g'riligi, chegirma bo'limi, bloklangan do'kon bo'sh.
 * HAQIQIY MongoDB (yoki FerretDB) kerak. npm run test:store-menu
 */
process.env.JWT_SECRET = 'x'.repeat(40);
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

const URI = process.env.TEST_MONGO_URI || 'mongodb://127.0.0.1:27017/lokma_store_menu_test';
const { Dish } = await import('../src/models/Dish.js');
const { Restaurant } = await import('../src/models/Restaurant.js');
const { restaurantController } = await import('../src/controllers/catalog.js');

const call = (handler, params = {}, query = {}) => new Promise((resolve, reject) => {
  const res = { json: resolve, status() { return this; } };
  handler({ params, query }, res, reject);
});

let shop; let blocked;
// FerretDB `$expr`/`$gt` ni qo'llamaydi (haqiqiy MongoDB'da ishlaydi) — chegirma testlari o'sha muhitda ochiq o'tkazib yuboriladi
let exprOk = true;
const CATS = ['meva', 'sut', 'non', 'go_sht'];
const N = 2100;

before(async () => {
  await mongoose.connect(URI, { serverSelectionTimeoutMS: 8000 });
  await Promise.all([Dish.deleteMany({}), Restaurant.deleteMany({})]);
  const mk = (name, extra = {}) => Restaurant.collection.insertOne({
    name, kind: 'shop', category: 'magazin', isApproved: true, isActive: true, isBlocked: false, createdAt: new Date(), ...extra,
  }).then((r) => r.insertedId);
  shop = await mk('Katta market'); blocked = await mk('Bloklangan', { isBlocked: true });

  const docs = [];
  for (let i = 0; i < N; i += 1) {
    const cat = i % 7 === 6 ? null : CATS[i % CATS.length]; // har 7-chisi kategoriyasiz
    docs.push({
      restaurantId: shop, name: `Mahsulot ${i}`, price: 10000 + i, oldPrice: i % 10 === 0 ? 15000 + i : null,
      marketCategory: cat, isAvailable: i % 50 !== 0, section: 'x', category: 'milliy', createdAt: new Date(),
    });
  }
  await Dish.collection.insertMany(docs);
  exprOk = await Dish.countDocuments({ restaurantId: shop, $expr: { $gt: ['$oldPrice', '$price'] } }).then(() => true, () => false);
  if (!exprOk) console.warn('[store-menu] bu bazada $expr/$gt yo\'q (FerretDB) — chegirma testlari o\'tkazib yuboriladi');
  await Dish.collection.insertOne({ restaurantId: blocked, name: 'Yashirin', price: 1, marketCategory: 'meva', isAvailable: true, category: 'milliy' });
});

after(async () => { await Promise.all([Dish.deleteMany({}), Restaurant.deleteMany({})]); await mongoose.disconnect(); });

const expectedCount = (pred) => { let n = 0; for (let i = 0; i < N; i += 1) if (i % 50 !== 0 && pred(i)) n += 1; return n; };

test('menu/index: bo\'lim sonlari va jami to\'g\'ri (mavjud bo\'lmaganlar hisobga olinmaydi)', async () => {
  const idx = await call(restaurantController.menuIndex, { id: String(shop) });
  assert.equal(idx.total, expectedCount(() => true));
  const by = Object.fromEntries(idx.sections.map((s) => [s.key, s.count]));
  assert.equal(by.meva, expectedCount((i) => i % 7 !== 6 && CATS[i % 4] === 'meva'));
  assert.equal(by.__other__, expectedCount((i) => i % 7 === 6));
  if (exprOk) assert.equal(idx.sale, expectedCount((i) => i % 10 === 0));
  assert.equal(idx.sections.reduce((s, x) => s + x.count, 0), idx.total);
});

async function drain(section, limit) {
  const seen = []; let cursor = ''; let pages = 0;
  do {
    const r = await call(restaurantController.menuItems, { id: String(shop) }, { section, limit: String(limit), cursor });
    assert.ok(r.items.length <= limit);
    seen.push(...r.items.map((d) => String(d._id)));
    cursor = r.nextCursor || ''; pages += 1;
    assert.ok(pages < 500, 'cheksiz sikl');
    if (!r.hasMore) assert.equal(r.nextCursor, null);
  } while (cursor);
  return seen;
}

test('menu/items: bo\'lim bo\'yicha hammasi aniq bir marta, takrorsiz va tushib qolmasdan', async () => {
  const all = await drain('', 24);
  assert.equal(all.length, expectedCount(() => true));
  assert.equal(new Set(all).size, all.length);
  const meva = await drain('meva', 24);
  assert.equal(meva.length, expectedCount((i) => i % 7 !== 6 && CATS[i % 4] === 'meva'));
  assert.equal(new Set(meva).size, meva.length);
  const other = await drain('__other__', 48);
  assert.equal(other.length, expectedCount((i) => i % 7 === 6));
});

test('menu/items: chegirma bo\'limi faqat oldPrice > price', async (t) => {
  if (!exprOk) return t.skip('bazada $expr yo\'q (FerretDB)');
  const sale = await call(restaurantController.menuItems, { id: String(shop) }, { section: '__sale__', limit: '48' });
  assert.ok(sale.items.length > 0);
  for (const d of sale.items) assert.ok(d.oldPrice > d.price);
  const ids = await drain('__sale__', 30);
  assert.equal(ids.length, expectedCount((i) => i % 10 === 0));
});

test('menu: limit chegaralanadi, noto\'g\'ri id/kursor/bloklangan do\'kon 500 bermaydi', async () => {
  const big = await call(restaurantController.menuItems, { id: String(shop) }, { limit: '99999' });
  assert.equal(big.items.length, 48);
  const tiny = await call(restaurantController.menuItems, { id: String(shop) }, { limit: '-5' });
  assert.equal(tiny.items.length, 1);
  assert.deepEqual(await call(restaurantController.menuItems, { id: 'r1' }, {}), { items: [], hasMore: false, nextCursor: null });
  const badCursor = await call(restaurantController.menuItems, { id: String(shop) }, { cursor: 'zzz', limit: '5' });
  assert.equal(badCursor.items.length, 5); // yaroqsiz kursor — birinchi sahifa
  assert.deepEqual(await call(restaurantController.menuItems, { id: String(blocked) }, { section: 'meva' }), { items: [], hasMore: false, nextCursor: null });
  assert.deepEqual(await call(restaurantController.menuIndex, { id: String(blocked) }), { total: 0, sale: 0, sections: [] });
  // Operator-ineksiyasi: section satr bo'lmasa e'tiborga olinmaydi
  const inj = await call(restaurantController.menuItems, { id: String(shop) }, { section: { $ne: 'x' }, limit: '3' });
  assert.equal(inj.items.length, 3);
});

test('menu/items: birinchi sahifa tez (2000+ mahsulotda ham)', async () => {
  const t0 = Date.now();
  await call(restaurantController.menuItems, { id: String(shop) }, { section: 'sut', limit: '24' });
  assert.ok(Date.now() - t0 < 1500, `sekin: ${Date.now() - t0}ms`);
});
