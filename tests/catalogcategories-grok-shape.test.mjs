/*
 * DB KOLLEKSIYASI `catalogcategories` (Grok yuklagan shakl): name, description, imageUrl, i18n{uz,ru,en}, order, isActive.
 * Registry shu hujjatlarni o'qiydi: uz/ru/en nomlar, tavsif, Cloudinary rasm. npm run test:catalogcategories
 */
process.env.JWT_SECRET = 'x'.repeat(40);
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

const URI = process.env.TEST_MONGO_URI || 'mongodb://127.0.0.1:27017/lokma_catalogcategories_test';
const { MarketCategory } = await import('../src/models/MarketCategory.js');
const reg = await import('../src/services/marketCategoryRegistry.js');
const { MARKET_HOME_SEED } = await import('../src/constants/marketHomeSeed.js');

const grokDoc = (c, i) => ({
  key: c.key,
  name: c.nameUz,
  description: `${c.nameUz} — tavsif`,
  imageUrl: `https://res.cloudinary.com/dnq8oy7l8/image/upload/lokmago/catalog-categories/${c.key}.webp`,
  i18n: {
    uz: { name: c.nameUz, description: `${c.nameUz} — tavsif` },
    ru: { name: c.nameRu, description: 'Описание' },
    en: { name: `EN ${c.key}`, description: 'Description' },
  },
  order: (i + 1) * 10,
  isActive: true,
});

before(async () => {
  await mongoose.connect(URI, { serverSelectionTimeoutMS: 8000 });
  await mongoose.connection.collection('catalogcategories').deleteMany({});
  await mongoose.connection.collection('catalogcategories').insertMany(MARKET_HOME_SEED.map(grokDoc));
  reg.invalidateMarketCategories();
});
after(async () => { await mongoose.disconnect(); });

test('21 hujjat o‘qiladi, tartib va kalitlar bazaga mos', async () => {
  const rows = await reg.listMarketCategories();
  assert.equal(rows.length, 21);
  assert.deepEqual(rows.map((r) => r.key), MARKET_HOME_SEED.map((c) => c.key));
});

test('uz/ru/en nomlar, tavsif va Cloudinary rasm API shaklida chiqadi', async () => {
  const choy = (await reg.listMarketCategories()).find((r) => r.key === 'choy');
  assert.equal(choy.uz, 'Choy');
  assert.equal(choy.ru, 'Чай');
  assert.equal(choy.en, 'EN choy');
  assert.equal(choy.description, 'Choy — tavsif');
  assert.ok(choy.imageUrl.startsWith('https://res.cloudinary.com/') && choy.imageUrl.includes('lokmago/catalog-categories/choy.webp'));
});

test('seed mavjud hujjatlarga tegmaydi (Grok ma‘lumoti saqlanadi)', async () => {
  await reg.seedMarketCategories();
  assert.equal(await MarketCategory.countDocuments({}), 21);
  const choy = await mongoose.connection.collection('catalogcategories').findOne({ key: 'choy' });
  assert.equal(choy.description, 'Choy — tavsif');
});

test('admin yozuvi yangi shaklda: i18n.uz/ru/en va name', async () => {
  const { marketCategoryAdminController: adm } = await import('../src/controllers/marketCategoryAdmin.js');
  const out = { code: 200, body: null };
  const res = { status: (c) => { out.code = c; return res; }, json: (b) => { out.body = b; return res; }, set: () => res };
  adm.update({ params: { key: 'choy' }, body: { nameEn: 'Tea', nameRu: 'Чай!', description: 'Yangi' }, headers: {} }, res, (e) => { throw e; });
  for (let i = 0; i < 300 && out.body === null; i++) await new Promise((x) => setTimeout(x, 10));
  assert.equal(out.code, 200);
  const doc = await mongoose.connection.collection('catalogcategories').findOne({ key: 'choy' });
  assert.equal(doc.i18n.en.name, 'Tea');
  assert.equal(doc.i18n.ru.name, 'Чай!');
  assert.equal(doc.description, 'Yangi');
  reg.invalidateMarketCategories();
  const choy = (await reg.listMarketCategories()).find((r) => r.key === 'choy');
  assert.equal(choy.en, 'Tea');
});
