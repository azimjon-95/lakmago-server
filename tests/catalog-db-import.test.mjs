/*
 * DO'KON KATALOGI DB IMPORT: 70 kategoriya, 20 guruh, rasmlar; ikkinchi marta 0 (idempotent); o'qish endpointlari.
 * HAQIQIY baza. npm run test:catalog-db
 */
process.env.JWT_SECRET = 'x'.repeat(40);
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

const URI = process.env.TEST_MONGO_URI || 'mongodb://127.0.0.1:27017/lokma_catalog_db_test';
const { CatalogSeedCategory } = await import('../src/models/CatalogSeedCategory.js');
const { CatalogSeedGroup } = await import('../src/models/CatalogSeedGroup.js');
const { CatalogAsset } = await import('../src/models/CatalogAsset.js');
const { importCatalogToDb } = await import('../src/services/catalogDbImport.js');
const { catalogDbController: c } = await import('../src/controllers/catalogDb.js');

const call = async (handler, req) => {
  const out = { code: 200, body: null, buf: null };
  const res = { status: (x) => { out.code = x; return res; }, json: (b) => { out.body = b; return res; }, set: () => res, setHeader() {}, send: (b) => { out.buf = b; return res; } };
  handler({ query: {}, params: {}, headers: {}, ...req }, res, (e) => { throw e; });
  for (let i = 0; i < 400 && out.body === null && out.buf === null; i++) await new Promise((x) => setTimeout(x, 10));
  return out;
};

before(async () => {
  await mongoose.connect(URI, { serverSelectionTimeoutMS: 8000 });
  await Promise.all([CatalogSeedCategory.deleteMany({}), CatalogSeedGroup.deleteMany({}), CatalogAsset.deleteMany({})]);
});
after(async () => { await mongoose.disconnect(); });

test('IMPORT: 70 kategoriya, 20 guruh, 60 rasm DB ga yuklanadi', async () => {
  const r = await importCatalogToDb();
  assert.deepEqual(r, { categories: 70, groups: 20, assets: 60 });
  assert.equal(await CatalogSeedCategory.countDocuments({}), 70);
  assert.equal(await CatalogSeedGroup.countDocuments({}), 20);
  assert.equal(await CatalogAsset.countDocuments({}), 60);
});

test('IMPORT idempotent: ikkinchi marta hech narsa qo‘shmaydi; admin o‘zgartirgan nom saqlanadi', async () => {
  await CatalogSeedCategory.updateOne({ key: 'choy' }, { $set: { nameUz: 'Yashil choy' } });
  const r = await importCatalogToDb();
  assert.deepEqual(r, { categories: 0, groups: 0, assets: 0 });
  assert.equal((await CatalogSeedCategory.findOne({ key: 'choy' }).lean()).nameUz, 'Yashil choy');
});

test('O‘QISH: /market/catalog-categories — guruhlar va faol kategoriyalar, muqova havolasi bilan', async () => {
  const r = await call(c.list, {});
  assert.equal(r.body.categories.length, 70);
  assert.equal(r.body.groups.length, 20);
  const gosht = r.body.groups.find((g) => g.id === 'gosht');
  assert.equal(gosht.cover, '/api/catalog/assets/gosht@720.webp');
  assert.ok(r.body.categories.every((x) => x.key && x.uz && x.group));
});

test('RASM: /catalog/assets/:name — bayt qaytaradi; noto‘g‘ri nom — 400; yo‘q — 404', async () => {
  const ok = await call(c.asset, { params: { name: 'gosht@720.webp' } });
  assert.ok(Buffer.isBuffer(ok.buf) && ok.buf.length > 100, 'webp baytlari');
  const bad = await call(c.asset, { params: { name: '../etc/passwd' } });
  assert.equal(bad.code, 400);
  const miss = await call(c.asset, { params: { name: 'yoq_rasm@480.webp' } });
  assert.equal(miss.code, 404);
});
