/* GET /admin/catalog/counts: kategoriya bo'yicha aniq sonlar, 500 kesishsiz. Baza kerak emas. npm run test:catalog-counts */
process.env.JWT_SECRET = 'x'.repeat(40);
const { CatalogProduct } = await import('../src/models/CatalogProduct.js');
const { catalogProductController: C } = await import('../src/controllers/catalogProducts.js');
const { router } = await import('../src/routes/index.js');
let fails = 0; const ok = (c, m) => { console.log(c ? '  ✓' : '  ✗ FAIL:', m); if (!c) fails++; };

const rows = [
  ...Array.from({ length: 700 }, (_, i) => ({ category: 'gosht_mahsulotlari', isActive: i % 10 !== 0, imageUrl: i % 2 ? 'https://x/y.jpg' : '' })),
  { category: 'sut_mahsulotlari', isActive: true, imageUrl: 'https://x/s.jpg' },
  { category: 'sut_mahsulotlari' },                                   // isActive yo'q → faol deb hisoblanadi (model default true)
];
let selected = null;
CatalogProduct.find = (f) => ({ select: (s) => { selected = { f, s }; return { lean: async () => rows }; } });

const out = await new Promise((resolve, reject) => {
  const res = { set() { return this; }, json(b) { resolve(b); return this; } };
  C.counts({}, res, reject);
});
const g = out.counts.find((c) => c.category === 'gosht_mahsulotlari'); const s = out.counts.find((c) => c.category === 'sut_mahsulotlari');
console.log('\n[1] Sonlar');
ok(out.total === 702, `jami ${out.total} (700 + 2) — 500 da KESILMAYDI`);
ok(g.total === 700 && g.active === 630 && g.withImage === 350, `go'sht: jami ${g.total}, faol ${g.active}, rasmli ${g.withImage}`);
ok(s.total === 2 && s.active === 2 && s.withImage === 1, `sut: jami ${s.total}, faol ${s.active}, rasmli ${s.withImage}`);
ok(selected.s === 'category isActive imageUrl' && Object.keys(selected.f).length === 0, 'faqat 3 ta maydon o‘qiladi (yengil), filtrsiz');

console.log('\n[2] Marshrut');
const layers = router.stack.filter((l) => l.route).map((l) => ({ p: l.route.path, m: Object.keys(l.route.methods), n: l.route.stack.map((x) => x.name) }));
const r = layers.find((l) => l.p === '/admin/catalog/counts' && l.m.includes('get'));
ok(Boolean(r) && r.n[0] === 'auth' && r.n.length >= 3, 'GET /admin/catalog/counts bor, auth + rol himoyasi bilan');
ok(layers.some((l) => l.p === '/admin/catalog' && l.m.includes('get')), 'eski GET /admin/catalog (ro‘yxat) saqlangan');
console.log(fails ? `\n✗ ${fails} ta xato` : '\n✓ Hammasi o‘tdi'); process.exit(fails ? 1 : 0);
