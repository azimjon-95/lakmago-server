/*
 * Katalog SAHIFALASH: tasodifiy-barqaror tartib, takrorlanmaydigan sahifalar, butun to'plam bo'yicha qidiruv/filtr/saralash,
 * kesh bilan to'liq oqim. Soxta Redis/model — baza ham, Redis ham KERAK EMAS.  npm run test:catalog-paging
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCatalogCache } from '../src/services/catalogCache.js';
import { queryPage, metaOf, norm, hash32, seededRank, filterIndexes, DEFAULT_LIMIT } from '../src/services/catalogPaging.js';

const P = (i, extra = {}) => ({ _id: `id${String(i).padStart(5, '0')}`, name: `Mahsulot ${String(i).padStart(4, '0')}`, category: 'meva', isActive: true, imageUrl: '', description: '', volume: '', usageCount: 0, createdAt: `2026-01-${String(1 + (i % 28)).padStart(2, '0')}T00:00:00Z`, ...extra });
const mk = (n, f = () => ({})) => { const items = Array.from({ length: n }, (_, i) => P(i, f(i))); return { items, metas: items.map(metaOf) }; };
const ids = (r) => r.items.map((p) => p._id);

test('FIXTURE: xesh va tasodifiy tartib QOTIRILGAN — admin (eski server uchun zaxira) bilan BIR XIL bo‘lishi shart', () => {
  // Bu qiymatlar admin/tests/catalogGroups.test.mjs dagi bilan AYNAN bir xil. Biri o‘zgarsa — ikkinchisi ham o‘zgarishi kerak.
  assert.equal(hash32('abc'), 482950588);
  assert.equal(seededRank('fixture1', 'id00000'), 2408853168);
  const { items, metas } = mk(12);
  const order = (seed) => ids(queryPage(items, metas, { sort: 'random', seed, limit: 12 })).join(',');
  assert.equal(order('fixture1'), 'id00011,id00001,id00005,id00004,id00000,id00009,id00008,id00002,id00003,id00010,id00006,id00007');
  assert.equal(order('kalit2'), 'id00002,id00011,id00001,id00007,id00000,id00008,id00009,id00010,id00003,id00005,id00004,id00006');
});

test('har sahifa 100 ta, jami to‘liq, TAKRORLANMAYDI va yo‘qolmaydi (2624 ta)', () => {
  const { items, metas } = mk(2624);
  const seen = new Set(); let offset = 0; let pages = 0; let r;
  do {
    r = queryPage(items, metas, { sort: 'random', seed: 'abc123', offset, limit: DEFAULT_LIMIT });
    assert.ok(r.items.length <= 100); r.items.forEach((p) => { assert.ok(!seen.has(p._id), `takror: ${p._id}`); seen.add(p._id); });
    offset += r.items.length; pages += 1;
  } while (r.hasMore);
  assert.equal(seen.size, 2624); assert.equal(pages, 27); assert.equal(r.total, 2624); assert.equal(r.items.length, 24, 'oxirgi sahifa 24 ta');
});

test('TASODIFIY: bir seed — har doim bir xil; boshqa seed — boshqa 100 ta; tartib alifbo emas', () => {
  const { items, metas } = mk(1000);
  const a1 = ids(queryPage(items, metas, { sort: 'random', seed: 'aaa' })); const a2 = ids(queryPage(items, metas, { sort: 'random', seed: 'aaa' }));
  const b = ids(queryPage(items, metas, { sort: 'random', seed: 'bbb' }));
  assert.deepEqual(a1, a2); assert.equal(a1.length, 100);
  const overlap = a1.filter((x) => b.includes(x)).length;
  assert.ok(overlap < 25, `boshqa seed — deyarli boshqa 100 ta (kesishgan: ${overlap})`);
  const sorted = [...a1].sort(); assert.notDeepEqual(a1, sorted, 'alifbo tartibida emas');
  // taqsimot: birinchi 100 ta butun to'plamdan (faqat boshidan emas)
  const idxs = a1.map((x) => Number(x.slice(2))); assert.ok(Math.max(...idxs) > 700 && Math.min(...idxs) < 300, 'butun to‘plamdan olingan');
});

test('QIDIRUV butun to‘plam bo‘yicha (100 tadan tashqarida ham topadi), apostrof variantlari bir xil', () => {
  const { items, metas } = mk(1000, (i) => (i === 913 ? { name: 'Qo‘y go‘shti (yangi)' } : i === 700 ? { description: 'Suyaksiz, toza' } : {}));
  assert.deepEqual(ids(queryPage(items, metas, { q: "qo'y go'shti" })), ['id00913'], 'oddiy apostrof ham ‘ ʻ ’ ni topadi');
  assert.deepEqual(ids(queryPage(items, metas, { q: 'QO‘Y' })), ['id00913'], 'katta-kichik harf farqsiz');
  assert.deepEqual(ids(queryPage(items, metas, { q: 'suyaksiz' })), ['id00700'], 'tavsifdan ham');
  assert.equal(queryPage(items, metas, { q: 'mahsulot 09' }).total, 99, '"mahsulot 09" — 0900–0999, lekin 0913 qayta nomlangan');
  assert.equal(queryPage(items, metas, { q: 'yo‘q-yo‘q' }).total, 0);
  assert.equal(norm("  Qo‘y   GO'SHT "), "qo'y go'sht");
});

test('QIDIRUV tartibi: nom boshidan > so‘z boshidan > nomda > faqat tavsifda', () => {
  const items = [P(1, { name: 'Banan chips' }), P(2, { name: 'Sariq banan' }), P(3, { name: 'Banan' }), P(4, { name: 'Olma', description: 'banan ta’mi' }), P(5, { name: 'Zbanan' })];
  const metas = items.map(metaOf);
  assert.deepEqual(ids(queryPage(items, metas, { q: 'banan' })), ['id00003', 'id00001', 'id00002', 'id00005', 'id00004']);
});

test('FILTRLAR (holat, rasm) va ularning QO‘SHILISHI qidiruv bilan', () => {
  const { items, metas } = mk(300, (i) => ({ isActive: i % 3 !== 0, imageUrl: i % 2 ? 'x' : '' }));
  assert.equal(queryPage(items, metas, { status: 'inactive' }).total, 100);
  assert.equal(queryPage(items, metas, { status: 'active' }).total, 200);
  assert.equal(queryPage(items, metas, { image: 'with' }).total, 150);
  assert.equal(queryPage(items, metas, { image: 'without', status: 'inactive' }).total, 50);
  assert.equal(queryPage(items, metas, { status: 'inactive', q: 'mahsulot 00' }).total, 34);
  assert.equal(filterIndexes(items, metas, {}).length, 300);
});

test('SARALASH: nom (A–Z/Z–A, raqamli), ko‘p ishlatilgan, yangi; limit/offset chegaralari', () => {
  const items = [P(1, { name: 'Banan 10', usageCount: 1 }), P(2, { name: 'Banan 2', usageCount: 9 }), P(3, { name: 'Anor', usageCount: 9, createdAt: '2026-05-01' }), P(4, { name: 'Olma', createdAt: '2026-06-01' })];
  const metas = items.map(metaOf);
  const names = (o) => queryPage(items, metas, o).items.map((p) => p.name);
  assert.deepEqual(names({ sort: 'name' }), ['Anor', 'Banan 2', 'Banan 10', 'Olma'], 'raqamli: 2 < 10');
  assert.deepEqual(names({ sort: 'name_desc' }), ['Olma', 'Banan 10', 'Banan 2', 'Anor']);
  assert.deepEqual(names({ sort: 'usage' }), ['Anor', 'Banan 2', 'Banan 10', 'Olma']);
  assert.deepEqual(names({ sort: 'new' }).slice(0, 2), ['Olma', 'Anor']);
  assert.equal(queryPage(items, metas, { limit: 0 }).limit, 100, 'limit=0 (noto‘g‘ri) — standart 100');
  assert.equal(queryPage(items, metas, { limit: -5 }).limit, 1, 'manfiy limit — kamida 1');
  assert.equal(queryPage(items, metas, { limit: 99999 }).limit, 200, 'limit ≤ 200');
  assert.equal(queryPage(items, metas, { offset: -5 }).offset, 0);
  assert.deepEqual(queryPage(items, metas, { offset: 99 }).items, [], 'chegaradan tashqari — bo‘sh, xato yo‘q');
  assert.equal(queryPage(items, metas, { sort: "'; drop" }).sort, 'name', 'noma’lum saralash — nom bo‘yicha');
});

// ───────── kesh bilan to'liq oqim ─────────
function fakeRedis() {
  const m = new Map(); const st = { get: 0, mget: 0, incr: 0 };
  return { st, store: m,
    async get(k) { st.get++; return m.get(k) ?? null; }, async mget(ks) { st.mget++; return ks.map((x) => m.get(x) ?? null); },
    async set(k, v) { m.set(k, v); return 'OK'; }, async incr(k) { st.incr++; m.set(k, String(Number(m.get(k) || 0) + 1)); },
    pipeline() { const ops = []; return { set: (...a) => { ops.push(a); return this; }, async exec() { for (const [k, v] of ops) m.set(k, v); return []; } }; } };
}
function fakeModel(docs) {
  const calls = []; const state = { docs: [...docs] };
  return { state, calls, find(f = {}) { calls.push(f); const run = async () => { let rows = state.docs; if (f.category?.$in) rows = rows.filter((d) => f.category.$in.includes(d.category)); return [...rows].sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name)); }; return { sort() { return this; }, select() { return this; }, lean: run }; } };
}
const DOCS = [...mk(700).items, ...mk(150).items.map((p) => ({ ...p, _id: 'g' + p._id, category: 'gosht' })), ...mk(40).items.map((p) => ({ ...p, _id: 's' + p._id, category: 'sut' }))];
const make = () => { const redis = fakeRedis(); const model = fakeModel(DOCS); return { redis, model, cache: createCatalogCache({ getRedis: () => redis, model, ttl: 60, log: { warn() {} } }) }; };

test('kesh orqali: guruh (2 kategoriya) birinchi 100 ta tasodifiy, keyingi sahifa davom etadi, jami to‘liq', async () => {
  const { cache } = make();
  const p1 = await cache.page({ cats: ['meva', 'gosht'], sort: 'random', seed: 'zz1', limit: 100 });
  assert.equal(p1.total, 850); assert.equal(p1.items.length, 100); assert.equal(p1.hasMore, true); assert.equal(p1.seed, 'zz1');
  assert.ok(p1.items.some((p) => p.category === 'meva') && p1.items.some((p) => p.category === 'gosht'), 'ikkala kategoriyadan aralash');
  const all = [...p1.items]; let off = 100;
  for (;;) { const r = await cache.page({ cats: ['meva', 'gosht'], sort: 'random', seed: 'zz1', limit: 100, offset: off }); all.push(...r.items); off += r.items.length; if (!r.hasMore) break; }
  assert.equal(new Set(all.map((p) => p._id)).size, 850, 'takrorsiz va to‘liq');
});

test('seed berilmasa server o‘zi yaratadi va qaytaradi (mijoz keyingi sahifalarda ishlatadi)', async () => {
  const { cache } = make();
  const a = await cache.page({ cats: ['sut'], sort: 'random' });
  assert.match(a.seed, /^[a-z0-9]{1,10}$/);
  const b = await cache.page({ cats: ['sut'], sort: 'random', seed: a.seed });
  assert.deepEqual(b.items.map((p) => p._id), a.items.map((p) => p._id));
});

test('XOTIRA: ikkinchi sahifa so‘rovi Redis/bazaga BORMAYDI (faqat versiya o‘qiladi)', async () => {
  const { cache, redis, model } = make();
  await cache.page({ cats: ['meva'], sort: 'name' });
  const m0 = redis.st.mget; const d0 = model.calls.length;
  await cache.page({ cats: ['meva'], sort: 'name', offset: 100 });
  await cache.page({ cats: ['meva'], q: 'mahsulot 05', sort: 'relevance' });
  assert.equal(redis.st.mget, m0, 'mget yo‘q'); assert.equal(model.calls.length, d0, 'baza yo‘q');
});

test('O‘ZGARISH → xotira ham tashlanadi: eski ro‘yxat qaytmaydi', async () => {
  const { cache, model } = make();
  assert.equal((await cache.page({ cats: ['sut'] })).total, 40);
  model.state.docs.push({ ...P(9999), _id: 'sNEW', category: 'sut', name: 'Yangi sut' });
  await cache.invalidate();
  const r = await cache.page({ cats: ['sut'], q: 'yangi sut' });
  assert.equal(r.total, 1); assert.equal(r.items[0]._id, 'sNEW');
});

test('kategoriyasiz (umumiy qidiruv): butun katalogdan topadi', async () => {
  const { cache } = make();
  const r = await cache.page({ q: 'mahsulot 0100', sort: 'relevance' });
  assert.equal(r.total, 2, `${r.total} ta: meva va gosht dan (sut da 0100 yo‘q)`);
  assert.deepEqual(new Set(r.items.map((p) => p.category)), new Set(['meva', 'gosht']));
});

test('Redis YO‘Q: sahifalash baribir ishlaydi (bazadan), natija bir xil', async () => {
  const model = fakeModel(DOCS);
  const cache = createCatalogCache({ getRedis: () => null, model, log: { warn() {} } });
  const r = await cache.page({ cats: ['meva'], sort: 'random', seed: 'q1' });
  assert.equal(r.source, 'off'); assert.equal(r.total, 700); assert.equal(r.items.length, 100);
  const { cache: c2 } = make(); const same = await c2.page({ cats: ['meva'], sort: 'random', seed: 'q1' });
  assert.deepEqual(r.items.map((p) => p._id), same.items.map((p) => p._id), 'Redis bor/yo‘q — tartib bir xil');
});
