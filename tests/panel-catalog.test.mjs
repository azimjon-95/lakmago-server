/*
 * Restoran/do'kon GURUHLI katalogi (GET /panel/catalog/counts, /panel/catalog/page) — HAQIQIY baza.  npm run test:panel-catalog
 * Biznes qoidasi: restoran FAQAT ichimliklar, do'kon hammasi; nofaol mahsulot yashirin; alreadyAdded to'g'ri; kesh buzilmaydi.
 */
import mongoose from 'mongoose';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(40);
const { CatalogProduct } = await import('../src/models/CatalogProduct.js');
const { Restaurant } = await import('../src/models/Restaurant.js');
const { Dish } = await import('../src/models/Dish.js');
const { catalogProductController: C } = await import('../src/controllers/catalogProducts.js');
const { catalogCache } = await import('../src/services/catalogCache.js');
const { RESTAURANT_VISIBLE_CATEGORIES } = await import('../src/constants/catalogCategories.js');

await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/lokma_panelcat_test');
for (const M of [CatalogProduct, Restaurant, Dish]) await M.deleteMany({});
let fails = 0; const ok = (c, m) => { console.log(c ? '  ✓' : '  ✗ XATO:', m); if (!c) fails++; };
const call = async (fn, restaurantId, query = {}) => {
  let status = 200; let body = null;
  const res = { headers: {}, status(c) { status = c; return this; }, json(b) { body = b; return this; }, set(k, v) { this.headers[k] = v; return this; } };
  await fn({ restaurantId: String(restaurantId), query }, res, (e) => { status = 500; body = { next: e?.message }; });
  await new Promise((r) => setTimeout(r, 40));
  return { status, body, headers: res.headers };
};

// Katalog: 5 ta ichimlik (1 nofaol), 5 ta boshqa
const mk = (name, category, extra = {}) => ({ name, category, volume: '', isActive: true, usageCount: 0, ...extra });
const docs = await CatalogProduct.create([
  mk('Coca-Cola 0.5L', 'gazli_ichimliklar', { usageCount: 30, suggestedPrice: 9000 }),
  mk('Fanta 0.5L', 'gazli_ichimliklar', { usageCount: 20 }),
  mk('Pepsi 1L', 'gazli_ichimliklar', { usageCount: 5, isActive: false }),
  mk('Nestle suv', 'mineral_suv', { usageCount: 10 }),
  mk('Sharbat olma', 'sharbatlar', { usageCount: 1 }),
  mk('Mol go‘shti', 'gosht_mahsulotlari', { usageCount: 99 }),
  mk('Kolbasa doktorskaya', 'kolbasa_sosiska', { usageCount: 50 }),
  mk('Magnum muzqaymoq', 'muzqaymoq', { usageCount: 40 }),
  mk('Sut 1L', 'sut_mahsulotlari', { usageCount: 7 }),
  mk('Coca-Cola kolbasa (qidiruv sinovi)', 'sut_mahsulotlari', { usageCount: 2 }),
]);
const byName = Object.fromEntries(docs.map((d) => [d.name, d]));
const REST = await Restaurant.create({ name: 'Restoran', cuisine: 'x', category: 'restoran', isActive: true, isApproved: true });
const SHOP = await Restaurant.create({ name: 'Do‘kon', cuisine: 'x', category: 'magazin_oziq', kind: 'shop', isActive: true, isApproved: true });
await Dish.create({ restaurantId: REST._id, section: 'Ichimlik', name: 'Fanta 0.5L', price: 9000, catalogProductId: byName['Fanta 0.5L']._id });
await catalogCache.invalidate();

console.log('\n[1] counts: restoran FAQAT ichimliklar, faqat faol');
{
  const r = await call(C.panelCounts, REST._id);
  const cats = r.body.counts.map((c) => c.category).sort();
  ok(r.status === 200 && r.body.scope === 'restaurant', `scope: ${r.body.scope}`);
  ok(JSON.stringify(cats) === JSON.stringify(['gazli_ichimliklar', 'mineral_suv', 'sharbatlar']), `faqat ichimlik kategoriyalari: ${cats.join(', ')}`);
  const gaz = r.body.counts.find((c) => c.category === 'gazli_ichimliklar');
  ok(gaz.total === 2 && gaz.active === 2, `gazli: 3 ta ichida nofaoli (Pepsi) hisobga olinmadi → ${gaz.total}`);
  ok(r.body.counts.every((c) => RESTAURANT_VISIBLE_CATEGORIES.includes(c.category)), 'ruxsat etilmagan kategoriya YO‘Q (go‘sht, kolbasa, muzqaymoq, sut)');
  ok(r.headers['Cache-Control'] === 'no-store', 'no-store');
}
console.log('\n[2] counts: do‘kon hammasini ko‘radi');
{
  const r = await call(C.panelCounts, SHOP._id);
  const cats = r.body.counts.map((c) => c.category);
  ok(r.body.scope === 'shop' && ['gosht_mahsulotlari', 'kolbasa_sosiska', 'muzqaymoq', 'sut_mahsulotlari', 'gazli_ichimliklar'].every((c) => cats.includes(c)), `do‘kon: ${cats.length} ta kategoriya (ichimlik + oziq-ovqat)`);
  ok(r.body.counts.find((c) => c.category === 'sut_mahsulotlari').total === 2, 'sut: 2 ta faol');
}
console.log('\n[3] page: restoran — faqat ichimliklar, nofaol yo‘q, alreadyAdded');
{
  const r = await call(C.panelPage, REST._id, {});
  const names = r.body.items.map((p) => p.name);
  ok(r.status === 200 && r.body.total === 4 && names.length === 4, `jami ${r.body.total}: ${names.join(' | ')}`);
  ok(!names.some((n) => /go‘sht|Kolbasa|Magnum|Sut 1L/.test(n)) && !names.includes('Pepsi 1L'), 'oziq-ovqat va nofaol mahsulot chiqmadi');
  ok(names[0] === 'Coca-Cola 0.5L' && names[1] === 'Fanta 0.5L', 'standart tartib: eng ko‘p ishlatilgani birinchi (usage)');
  ok(r.body.items.find((p) => p.name === 'Fanta 0.5L').alreadyAdded === true && r.body.items.find((p) => p.name === 'Coca-Cola 0.5L').alreadyAdded === false, 'alreadyAdded: Fanta bor, Coca-Cola yo‘q');
  ok(r.body.items.every((p) => !('market' in p)), 'restoranga market maydoni berilmaydi');
}
console.log('\n[4] page: restoran so‘rov orqali oziq-ovqatni OCHIB OLA OLMAYDI (biznes qoidasi)');
{
  let r = await call(C.panelPage, REST._id, { categories: 'gosht_mahsulotlari' });
  ok(r.body.items.every((p) => RESTAURANT_VISIBLE_CATEGORIES.includes(p.category)) && r.body.total === 4, `go‘sht so‘rovi: go‘sht chiqmadi, ruxsat etilganlar (${r.body.total})`);
  r = await call(C.panelPage, REST._id, { categories: 'gazli_ichimliklar,gosht_mahsulotlari,muzqaymoq' });
  ok(r.body.total === 2 && r.body.items.every((p) => p.category === 'gazli_ichimliklar'), 'aralash so‘rov: faqat ruxsat etilgani (gazli) qoldi');
  r = await call(C.panelPage, REST._id, { q: 'kolbasa' });
  ok(r.body.total === 0, 'qidiruv butun katalog bo‘yicha emas — restoran "kolbasa" topa olmaydi');
  r = await call(C.panelPage, REST._id, { q: 'coca' });
  ok(r.body.total === 1 && r.body.items[0].name === 'Coca-Cola 0.5L', 'qidiruv ichimliklar ichida ishlaydi (sut guruhidagi "Coca-Cola kolbasa" yashirin)');
}
console.log('\n[5] page: do‘kon — hamma kategoriya, filtr, market takliflari, kesh buzilmagan');
{
  let r = await call(C.panelPage, SHOP._id, {});
  ok(r.body.total === 9, `do‘kon: 9 ta faol (nofaol Pepsi yo‘q) → ${r.body.total}`);
  ok(r.body.items[0].name === 'Mol go‘shti', 'usage tartibi: go‘sht (99) birinchi');
  ok(r.body.items.every((p) => p.market && p.market.marketCategory), 'har mahsulotda market takliflari');
  ok(r.body.items.every((p) => p.alreadyAdded === false), 'do‘konda alreadyAdded=false: restoranning Fanta belgisi SIZMADI (keshdagi obyekt o‘zgartirilmagan)');
  r = await call(C.panelPage, SHOP._id, { categories: 'muzqaymoq' });
  ok(r.body.total === 1 && r.body.items[0].name === 'Magnum muzqaymoq', 'kategoriya filtri');
  r = await call(C.panelPage, REST._id, {});
  ok(r.body.items.find((p) => p.name === 'Fanta 0.5L').alreadyAdded === true, 'restoran belgisi hali ham to‘g‘ri');
}
console.log('\n[6] sahifalash va tartib');
{
  const a = await call(C.panelPage, SHOP._id, { limit: '4', offset: '0' });
  const b = await call(C.panelPage, SHOP._id, { limit: '4', offset: '4' });
  const c = await call(C.panelPage, SHOP._id, { limit: '4', offset: '8' });
  const all = [...a.body.items, ...b.body.items, ...c.body.items].map((p) => p._id);
  ok(a.body.hasMore === true && b.body.hasMore === true && c.body.hasMore === false && a.body.total === 9, 'hasMore: true, true, false; total 9');
  ok(all.length === 9 && new Set(all).size === 9, '3 sahifa = 9 noyob mahsulot (takrorsiz)');
  const n = await call(C.panelPage, SHOP._id, { sort: 'name' });
  const names = n.body.items.map((p) => p.name);
  ok(names.join('|') === [...names].sort((x, y) => x.localeCompare(y, 'uz')).join('|') || names[0].localeCompare(names[1]) <= 0, 'name tartibi');
  const lim = await call(C.panelPage, SHOP._id, { limit: '99999' });
  ok(lim.body.limit <= 100 && lim.body.items.length <= 100, `limit chegaralangan (${lim.body.limit})`);
  const bad = await call(C.panelPage, SHOP._id, { sort: '$where', offset: '-5', limit: 'abc' });
  ok(bad.status === 200 && bad.body.items.length > 0, 'noto‘g‘ri sort/offset/limit — xavfsiz standartga');
}
console.log('\n[7] Umumiy kesh obyektlari O‘ZGARTIRILMAYDI (ishlab chiqarishda Redis/xotira keshi umumiy)');
{
  // Keshdan qaytgan obyektlar bir nechta restoran uchun UMUMIY bo'lishi mumkin: muzlatib qo'yamiz — o'zgartirishga urinish xato beradi
  const real = catalogCache.page.bind(catalogCache);
  const warm = JSON.parse(JSON.stringify(await real({ cats: [], q: '', status: 'active', image: 'all', sort: 'usage', seed: '', limit: 100, offset: 0 })));   // oddiy obyektlar (ObjectId muzlamaydi)
  const deepFreeze = (o) => { Object.values(o).forEach((v) => { if (v && typeof v === 'object') deepFreeze(v); }); return Object.freeze(o); };
  deepFreeze(warm);
  catalogCache.page = async () => warm;
  try {
    const a = await call(C.panelPage, REST._id, {});
    const b = await call(C.panelPage, SHOP._id, {});
    ok(a.status === 200 && b.status === 200, `muzlatilgan umumiy keshda ham ishlaydi (${a.status}, ${b.status}) — obyektlar o‘zgartirilmagan`);
    ok(b.body.items.every((p) => p.alreadyAdded === false), 'do‘kon javobida restoran belgisi YO‘Q');
  } finally { catalogCache.page = real; }
}
console.log(fails ? `\n✗ ${fails} ta xato` : '\n✓ Hammasi o‘tdi');
await mongoose.disconnect(); process.exit(fails ? 1 : 0);
