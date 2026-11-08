/*
 * MARKET BOSH SAHIFASI KATEGORIYALARI (aniq katalog kaliti): jadval to'liqligi, katalogdan/o'zi qo'shilgan mahsulotga kalit yozilishi,
 * eski mahsulotlarga backfill (idempotent), do'konlar ro'yxatida productCatalogCategories, /market/products?catalogCategory=.
 * HAQIQIY MongoDB (yoki FerretDB) kerak. npm run test:market-catalog
 */
process.env.JWT_SECRET = 'x'.repeat(40);
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose, { Types } from 'mongoose';

const URI = process.env.TEST_MONGO_URI || 'mongodb://127.0.0.1:27017/lokma_market_catalog_test';
const { MARKET_CATEGORY_VALUES, MARKET_TO_CATALOG, catalogCategoryFor } = await import('../src/constants/marketCategories.js');
const { CATALOG_CATEGORY_VALUES } = await import('../src/constants/catalogCategories.js');
const { Dish } = await import('../src/models/Dish.js');
const { Restaurant } = await import('../src/models/Restaurant.js');
const { CatalogProduct } = await import('../src/models/CatalogProduct.js');
const { backfillCatalogCategory } = await import('../src/services/catalogCategoryMigration.js');
const { seedMarketCategories } = await import('../src/services/marketCategoryRegistry.js');
const { restaurantController } = await import('../src/controllers/catalog.js');
const { dishController } = await import('../src/controllers/catalog.js');

// Foydalanuvchi so'ragan 21 kalit — hammasi katalogda MAVJUD bo'lishi shart
const HOME_KEYS = 'shaxsiy_gigiyena maishiy_kimyo bolalar_oziq_ovqatlari choy shokolad uy_rozgor_mahsulotlari pechenye konserva_mahsulotlari bolalar_gigiyena konfetlar sut_mahsulotlari shirinliklar gazli_ichimliklar makaron_mahsulotlari chips_snacklar muzqaymoq yangi_meva souslar qahva tozalash_vositalari ichimliklar'.split(' ');

test('21 ta bosh sahifa kaliti katalogda bor; jadval to\'liq va faqat haqiqiy kalitlarga', () => {
  assert.equal(HOME_KEYS.length, 21);
  for (const k of HOME_KEYS) assert.ok(CATALOG_CATEGORY_VALUES.includes(k), `katalogda yo'q: ${k}`);
  for (const v of MARKET_CATEGORY_VALUES) assert.ok(v in MARKET_TO_CATALOG, `marketCategory '${v}' jadvalda yo'q`);
  for (const [m, c] of Object.entries(MARKET_TO_CATALOG)) assert.ok(c === null || CATALOG_CATEGORY_VALUES.includes(c), `${m} → ${c}: katalogda yo'q`);
});

test('catalogCategoryFor: aniq kalit ustun; bo\'lmasa marketCategory dan; mos kalit yo\'q — null', () => {
  assert.equal(catalogCategoryFor({ catalogCategory: 'konfetlar', marketCategory: 'shokolad' }), 'konfetlar');
  assert.equal(catalogCategoryFor({ marketCategory: 'sous' }), 'souslar');
  assert.equal(catalogCategoryFor({ marketCategory: 'uy_kimyo' }), 'maishiy_kimyo');
  assert.equal(catalogCategoryFor({ marketCategory: 'boshqa' }), null);
  assert.equal(catalogCategoryFor({}), null);
  assert.equal(catalogCategoryFor(), null);
});

let shopA; let shopB; let cpChoy; let cpKonfet;
before(async () => {
  await mongoose.connect(URI, { serverSelectionTimeoutMS: 8000 });
  await Promise.all([Dish.deleteMany({}), Restaurant.deleteMany({}), CatalogProduct.deleteMany({})]);
  // Markaziy market ro'yxati (ishga tushishda server ham shunday qiladi)
  await seedMarketCategories();
  const mk = (name) => Restaurant.create({ name, cuisine: 'Do\'kon', kind: 'shop', category: 'dokon', isApproved: true, isActive: true, openTime: '00:00', closeTime: '23:59', lat: 41, lng: 71 }).catch(async () => Restaurant.collection.insertOne({ name, cuisine: 'Do\'kon', kind: 'shop', isApproved: true, isActive: true, isBlocked: false, createdAt: new Date() }).then((r) => ({ _id: r.insertedId })));
  shopA = await mk('Anor market'); shopB = await mk('Pop bozor');
  cpChoy = await CatalogProduct.create({ name: 'Ahmad choy', category: 'choy', isActive: true });
  cpKonfet = await CatalogProduct.create({ name: 'Bonbon', category: 'konfetlar', isActive: true });
});
after(async () => { await mongoose.disconnect(); });

const dish = (over) => ({ restaurantId: shopA._id, name: 'M', category: 'boshqa', section: 'M', price: 5000, isAvailable: true, ...over });

test('BACKFILL: katalogdan → aniq (konfetlar≠shokolad); o\'zi yaratgan → eng yaqin; mos kalit yo\'q → tegilmaydi; restoran taomi tegilmaydi; takror — o\'zgarmaydi', async () => {
  await Dish.deleteMany({});
  const [fromCatalog, custom, none, restaurantDish, already] = await Dish.insertMany([
    dish({ name: 'Bonbon', marketCategory: 'shokolad', catalogProductId: cpKonfet._id }),       // marketCategory 'shokolad' (keng), katalog 'konfetlar' (aniq)
    dish({ name: 'Ketchup', marketCategory: 'sous' }),
    dish({ name: 'Boshqa narsa', marketCategory: 'boshqa' }),
    dish({ name: 'Osh', marketCategory: null, category: 'milliy' }),
    dish({ name: 'Choy', marketCategory: 'choy', catalogProductId: cpChoy._id, catalogCategory: 'choy' }),
  ]);
  const r1 = await backfillCatalogCategory({ log() {}, batch: 2 });                              // kichik partiya — sikl ham sinaladi
  const get = (d) => Dish.findById(d._id).lean();
  assert.equal((await get(fromCatalog)).catalogCategory, 'konfetlar', 'katalog mahsuloti aniq kalitni beradi');
  assert.equal((await get(custom)).catalogCategory, 'souslar');
  assert.equal((await get(none)).catalogCategory ?? null, null, "'boshqa' — kalit yo'q");
  assert.equal((await get(restaurantDish)).catalogCategory ?? null, null, 'restoran taomi tegilmadi');
  assert.equal((await get(already)).catalogCategory, 'choy');
  assert.deepEqual(r1, { fromCatalog: 1, fromMarket: 1, skipped: 1 });
  const r2 = await backfillCatalogCategory({ log() {} });
  assert.deepEqual({ a: r2.fromCatalog, b: r2.fromMarket }, { a: 0, b: 0 }, 'takror ishga tushish hech narsani o\'zgartirmaydi');
});

const call = async (handler, req) => {
  const out = { code: 200, body: null }; const res = { status: (c) => { out.code = c; return res; }, json: (b) => { out.body = b; return res; }, set: () => res, setHeader() {} };
  handler({ query: {}, headers: {}, ...req }, res, (e) => { throw e; });
  for (let i = 0; i < 400 && out.body === null; i++) await new Promise((x) => setTimeout(x, 10));
  return out;
};

// FerretDB (sinov muhiti) `$group/$addToSet` ni qo'llamaydi — haqiqiy MongoDB'da (CI, VPS) ishlaydi. Bu yerda o'tkazib yuboriladi.
const seedMarket = async () => {
  await Dish.deleteMany({});
  await Dish.insertMany([
    dish({ name: 'Ahmad', marketCategory: 'choy', catalogCategory: 'choy' }),
    dish({ name: 'Bonbon', marketCategory: 'shokolad', catalogCategory: 'konfetlar' }),
    dish({ restaurantId: shopB._id, name: 'Kola', marketCategory: 'gazli', catalogCategory: 'gazli_ichimliklar' }),
    dish({ restaurantId: shopB._id, name: 'Eski', marketCategory: 'sut' }),             // backfill'dan oldingi (catalogCategory yo'q)
  ]);
};
const supportsAddToSet = async () => {
  try { await Dish.aggregate([{ $limit: 1 }, { $group: { _id: null, x: { $addToSet: '$name' } } }]); return true; } catch { return false; }
};

test('DO\'KONLAR RO\'YXATI: productCatalogCategories (aniq kalitlar) va eski productCategories birga', async (t) => {
  if (!(await supportsAddToSet())) return t.skip('bu baza $addToSet ni qo\'llamaydi (FerretDB) — haqiqiy MongoDB\'da ishlaydi');
  await seedMarket();
  const r = await call(restaurantController.list, { marketMode: true, query: { limit: '50' } });
  const items = Array.isArray(r.body) ? r.body : r.body.items;
  const a = items.find((s) => s.name === 'Anor market'); const b = items.find((s) => s.name === 'Pop bozor');
  assert.deepEqual([...a.productCatalogCategories].sort(), ['choy', 'konfetlar']);
  assert.deepEqual([...a.productCategories].sort(), ['choy', 'shokolad'], 'eski maydon o\'zgarmadi');
  assert.deepEqual(b.productCatalogCategories, ['gazli_ichimliklar'], "catalogCategory'siz mahsulot qo'shilmaydi (backfill kerak)");
  assert.deepEqual([...b.productCategories].sort(), ['gazli', 'sut']);
});

test('MAHSULOTLAR: ?catalogCategory= aniq kalit bo\'yicha; eski ?category= o\'zgarmadi; noto\'g\'ri kalit — bo\'sh', async () => {
  await seedMarket();
  const names = async (query) => {
    const r = await call(dishController.all, { marketMode: true, query: { limit: '50', ...query } });
    const items = Array.isArray(r.body) ? r.body : (r.body.items ?? []);
    return items.map((d) => d.name).sort();
  };
  assert.deepEqual(await names({ catalogCategory: 'konfetlar' }), ['Bonbon']);
  assert.deepEqual(await names({ catalogCategory: 'choy' }), ['Ahmad']);
  assert.deepEqual(await names({ category: 'shokolad' }), [], "'shokolad' endi katalog kaliti: katalog maydoni 'konfetlar' bo'lgan Bonbon chiqmaydi (kategoriya ro'yxatidagi kalit bo'yicha qidiriladi)");
  assert.deepEqual(await names({ catalogCategory: 'yoq_kalit' }), [], 'noto\'g\'ri kalit — hech narsa (butun ro\'yxat emas)');
  assert.deepEqual(await names({ catalogCategory: "choy'; db.x" }), [], 'in\'ektsiya shaklidagi matn — xavfsiz');
  assert.equal((await names({})).length, 4, 'parametrsiz — hammasi');
});

test('simlar: do\'konlar ro\'yxati aggregate\'i aniq kalitlarni qaytaradi (haqiqiy MongoDB\'da ishlaydi; bu yerda — statik tekshiruv)', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/controllers/catalog.js', import.meta.url), 'utf8');
  assert.ok(src.includes("catalogCategories: { $addToSet: '$catalogCategory' }") && src.includes('productCatalogCategories: catalogCatMap.get'));
  const panel = readFileSync(new URL('../src/controllers/restaurantPanel.js', import.meta.url), 'utf8');
  assert.ok(panel.includes('isMarketCategoryKey(data.catalogCategory)') && panel.includes('catalogCategoryFor({ marketCategory: data.marketCategory })'), 'do\'kon mahsuloti kalitni markaziy ro\'yxatdan oladi (yoki marketCategory dan zaxira)');
  const add = readFileSync(new URL('../src/controllers/catalogProducts.js', import.meta.url), 'utf8');
  assert.ok(add.includes('catalogCategory: product.category'), 'katalogdan qo\'shilganda aniq kalit');
});

test('do\'konlar ro\'yxatida koordinatalar (Sizga yaqin do\'konlar saralashi uchun)', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/controllers/catalog.js', import.meta.url), 'utf8');
  const sel = src.slice(src.indexOf("const LIST_SELECT = '"), src.indexOf("';", src.indexOf("const LIST_SELECT = '")));
  assert.ok(/\blat\b/.test(sel) && /\blng\b/.test(sel));
});

test('ESKI MAHSULOT: katalog maydoni bo\'sh, faqat marketCategory bor — kategoriya filtrida chiqadi; boshqa kalitda chiqmaydi', async () => {
  await Dish.deleteMany({});
  await Dish.insertMany([
    dish({ name: 'Eski choy', marketCategory: 'choy', catalogCategory: null }),          // backfill qilinmagan
    dish({ name: 'Yangi choy', marketCategory: 'choy', catalogCategory: 'choy' }),
    dish({ name: 'Eski sut', marketCategory: 'sut', catalogCategory: null }),
  ]);
  const names = async (query) => {
    const r = await call(dishController.all, { marketMode: true, query: { limit: '50', ...query } });
    const items = Array.isArray(r.body) ? r.body : (r.body.items ?? []);
    return items.map((d) => d.name).sort();
  };
  assert.deepEqual(await names({ catalogCategory: 'choy' }), ['Eski choy', 'Yangi choy'], 'aniq + eski (marketCategory orqali) birga');
  assert.deepEqual(await names({ catalogCategory: 'sut_mahsulotlari' }), ['Eski sut'], 'sut kaliti marketCategory=sut orqali');
  assert.deepEqual(await names({ catalogCategory: 'konfetlar' }), [], 'mos mahsulot yo\'q — bo\'sh');
});

test('KATEGORIYA PARAMETRI: ?category=<katalog kaliti> xuddi catalogCategory kabi ishlaydi (aniq + eski mahsulot)', async () => {
  await Dish.deleteMany({});
  await Dish.insertMany([
    dish({ name: 'Choy A', marketCategory: 'choy', catalogCategory: 'choy' }),
    dish({ name: 'Choy eski', marketCategory: 'choy', catalogCategory: null }),
    dish({ name: 'Sut A', marketCategory: 'sut', catalogCategory: 'sut_mahsulotlari' }),
  ]);
  const names = async (query) => {
    const r = await call(dishController.all, { marketMode: true, query: { limit: '50', ...query } });
    const items = Array.isArray(r.body) ? r.body : (r.body.items ?? []);
    return items.map((d) => d.name).sort();
  };
  assert.deepEqual(await names({ category: 'choy' }), ['Choy A', 'Choy eski'], 'katalog kaliti category orqali');
  assert.deepEqual(await names({ category: 'sut_mahsulotlari' }), ['Sut A'], 'sut kaliti category orqali');
  assert.deepEqual(await names({ category: 'sut' }), ['Sut A'], 'eski marketCategory nomi ham ishlaydi');
  assert.deepEqual(await names({ category: 'all' }), ['Choy A', 'Choy eski', 'Sut A'], 'all — hammasi');
});
