/*
 * MARKAZIY MARKET KATEGORIYALARI (registr): seed (21 ta, idempotent), admin CRUD, ishlatilgan kalitni o'chirish taqiqi,
 * admin qo'shgan yangi kalit bilan mahsulot filtri. HAQIQIY baza (FerretDB/MongoDB). npm run test:market-registry
 */
process.env.JWT_SECRET = 'x'.repeat(40);
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose, { Types } from 'mongoose';

const URI = process.env.TEST_MONGO_URI || 'mongodb://127.0.0.1:27017/lokma_market_registry_test';
const { MarketCategory } = await import('../src/models/MarketCategory.js');
const { Dish } = await import('../src/models/Dish.js');
const { Restaurant } = await import('../src/models/Restaurant.js');
const reg = await import('../src/services/marketCategoryRegistry.js');
const { MARKET_HOME_SEED } = await import('../src/constants/marketHomeSeed.js');
const { marketCategoryAdminController: adm } = await import('../src/controllers/marketCategoryAdmin.js');
const { dishController } = await import('../src/controllers/catalog.js');
const { slugifyKey } = await import('../src/controllers/marketCategoryAdmin.js');

const call = async (handler, req) => {
  const out = { code: 200, body: null };
  const res = { status: (c) => { out.code = c; return res; }, json: (b) => { out.body = b; return res; }, set: () => res, setHeader() {} };
  handler({ query: {}, params: {}, headers: {}, ...req }, res, (e) => { throw e; });
  for (let i = 0; i < 400 && out.body === null; i++) await new Promise((x) => setTimeout(x, 10));
  return out;
};

before(async () => {
  await mongoose.connect(URI, { serverSelectionTimeoutMS: 8000 });
  await Promise.all([MarketCategory.deleteMany({}), Dish.deleteMany({}), Restaurant.deleteMany({})]);
});
after(async () => { await mongoose.disconnect(); });

test('SEED: 21 ta boshlang‘ich kalit, tartib saqlanadi; ikki marta ishga tushsa ham nusxa yo‘q', async () => {
  await reg.seedMarketCategories();
  await reg.seedMarketCategories();
  const all = await reg.listMarketCategories({ onlyActive: false });
  assert.equal(all.length, 21);
  assert.deepEqual(all.map((c) => c.key), MARKET_HOME_SEED.map((c) => c.key), 'tartib — berilgan ro‘yxat bilan bir xil');
  assert.ok(all.every((c) => c.uz && c.uzc && c.ru && c.emoji && c.isActive));
});

test('SEED admin o‘zgarishlarini bosib ketmaydi (mavjud kalitga $setOnInsert)', async () => {
  await MarketCategory.updateOne({ key: 'choy' }, { $set: { nameUz: 'Yashil choy' } });
  await reg.seedMarketCategories();
  const choy = (await reg.listMarketCategories({ onlyActive: false })).find((c) => c.key === 'choy');
  assert.equal(choy.uz, 'Yashil choy', 'admin nomi saqlandi');
});

test('ADMIN CREATE: yangi kalit; dublikat — 409; noto‘g‘ri kalit — 400; https bo‘lmagan rasm — 400', async () => {
  let r = await call(adm.create, { body: { key: 'yangi_kategoriya', nameUz: 'Yangi' } });
  assert.equal(r.code, 201); assert.equal(r.body.key, 'yangi_kategoriya');
  r = await call(adm.create, { body: { key: 'choy', nameUz: 'Dublikat' } });
  assert.equal(r.code, 409); assert.equal(r.body.code, 'KEY_TAKEN');
  r = await call(adm.create, { body: { key: 'Bad Key!', nameUz: 'X' } });
  assert.equal(r.code, 400);
  r = await call(adm.create, { body: { key: 'rasmli_test', nameUz: 'R', imageUrl: 'http://insecure.uz/a.png' } });
  assert.equal(r.code, 400);
});

test('ADMIN UPDATE: nom/tartib/faollik o‘zgaradi; kalit o‘zgarmaydi; mavjud bo‘lmagan — 404', async () => {
  let r = await call(adm.update, { params: { key: 'yangi_kategoriya' }, body: { nameUz: 'Yangilangan', order: 5, isActive: false } });
  assert.equal(r.code, 200); assert.equal(r.body.nameUz, 'Yangilangan');
  const inactive = (await reg.listMarketCategories()).some((c) => c.key === 'yangi_kategoriya');
  assert.equal(inactive, false, 'nofaol — mijoz ro‘yxatida yo‘q');
  assert.equal(await reg.isMarketCategoryKey('yangi_kategoriya'), true, 'lekin nofaol kalit mahsulotda bo‘la oladi (tarix)');
  r = await call(adm.update, { params: { key: 'yo_q_kalit' }, body: { nameUz: 'X' } });
  assert.equal(r.code, 404);
  r = await call(adm.update, { params: { key: 'choy' }, body: { key: 'boshqa' } });
  assert.equal(r.code, 400, 'kalit PATCH orqali o‘zgartirilmaydi (strict schema)');
});

test('ADMIN DELETE: ishlatilgan kalit — 409 (usage), ishlatilmagan — o‘chadi', async () => {
  const rest = await Restaurant.create({ name: 'Do‘kon', cuisine: 'Market', kind: 'shop', category: 'magazin', isApproved: true, isActive: true, openTime: '00:00', closeTime: '23:59', lat: 41, lng: 71 });
  await Dish.create({ restaurantId: rest._id, name: 'Choy 100g', price: 10000, category: 'boshqa', section: 'Choy', isAvailable: true, catalogCategory: 'choy' });
  let r = await call(adm.remove, { params: { key: 'choy' } });
  assert.equal(r.code, 409); assert.equal(r.body.code, 'IN_USE'); assert.equal(r.body.usage, 1);
  r = await call(adm.remove, { params: { key: 'yangi_kategoriya' } });
  assert.equal(r.code, 200);
  assert.equal(await reg.isMarketCategoryKey('yangi_kategoriya'), false, 'o‘chirilgan — ro‘yxatda yo‘q');
});

test('ADMIN LIST: har bir kalit uchun ishlatilish soni', async () => {
  const r = await call(adm.list, {});
  const choy = r.body.find((c) => c.key === 'choy');
  assert.equal(choy.usage, 1);
  assert.equal(r.body.find((c) => c.key === 'qahva').usage, 0);
});

test('YANGI KALIT → MAHSULOT FILTRI: admin qo‘shgan kalit ?category= bilan ishlaydi (qattiq ro‘yxat yo‘q)', async () => {
  await call(adm.create, { body: { key: 'yangi_test_kalit', nameUz: 'Test' } });
  const rest = await Restaurant.findOne({ kind: 'shop' }) || await Restaurant.create({ name: 'Do‘kon 2', cuisine: 'Market', kind: 'shop', category: 'magazin', isApproved: true, isActive: true, openTime: '00:00', closeTime: '23:59', lat: 41, lng: 71 });
  await Dish.create({ restaurantId: rest._id, name: 'Yangi mahsulot', price: 5000, category: 'boshqa', section: 'T', isAvailable: true, catalogCategory: 'yangi_test_kalit' });
  const r = await call(dishController.all, { marketMode: true, query: { limit: '50', category: 'yangi_test_kalit' } });
  const items = Array.isArray(r.body) ? r.body : (r.body.items ?? []);
  assert.deepEqual(items.map((d) => d.name), ['Yangi mahsulot']);
});

test('NOMDAN KALIT: bo‘sh kalit bilan — nomdan yasaladi; tavsif va karta rasmi saqlanadi', async () => {
  assert.equal(slugifyKey('Sut mahsulotlari'), 'sut_mahsulotlari');
  assert.equal(slugifyKey("Uy-ro'zg'or"), 'uy_rozgor');
  assert.equal(slugifyKey('Bolalar oʻquv'), 'bolalar_oquv');
  let r = await call(adm.create, { body: { nameUz: 'Yangi Sut Turi', description: 'Tavsif matni', cardUrl: 'https://res.cloudinary.com/x/c.png' } });
  assert.equal(r.code, 201); assert.equal(r.body.key, 'yangi_sut_turi');
  assert.equal(r.body.description, 'Tavsif matni'); assert.equal(r.body.cardUrl, 'https://res.cloudinary.com/x/c.png');
  const listed = (await reg.listMarketCategories({ onlyActive: false })).find((c) => c.key === 'yangi_sut_turi');
  assert.equal(listed.description, 'Tavsif matni', 'mijoz ro‘yxatida tavsif bor');
  r = await call(adm.create, { body: { nameUz: 'Yangi Sut Turi' } });
  assert.equal(r.code, 409, 'bir xil nom — kalit band (409)');
  r = await call(adm.create, { body: { nameUz: '!!!' } });
  assert.equal(r.code, 400, 'kalit yasab bo‘lmaydigan nom — 400');
  await call(adm.remove, { params: { key: 'yangi_sut_turi' } });
});
