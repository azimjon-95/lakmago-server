/*
 * Umumiy katalog Redis keshi (services/catalogCache.js): isitish, kategoriya bo'yicha tez berish, versiya bilan
 * bekor qilish, Redis yo'q/xato bo'lganda bazadan. Soxta Redis va soxta model — baza ham, Redis ham KERAK EMAS.
 * npm run test:catalog-cache
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCatalogCache } from '../src/services/catalogCache.js';

/** Soxta Redis: ioredis'ning ishlatilgan buyruqlari (get/set EX/mget/incr/pipeline) + xato/hisoblagich. */
function fakeRedis() {
  const m = new Map(); const stats = { get: 0, mget: 0, set: 0, incr: 0, pipelines: 0 }; let broken = false;
  const guard = () => { if (broken) throw new Error('redis uzildi'); };
  const r = {
    stats, store: m,
    break() { broken = true; }, fix() { broken = false; },
    async get(key) { guard(); stats.get++; return m.get(key) ?? null; },
    async mget(keys) { guard(); stats.mget++; return keys.map((x) => m.get(x) ?? null); },
    async set(key, val) { guard(); stats.set++; m.set(key, val); return 'OK'; },
    async incr(key) { guard(); stats.incr++; const n = Number(m.get(key) || 0) + 1; m.set(key, String(n)); return n; },
    pipeline() { stats.pipelines++; const ops = []; return { set: (...a) => { ops.push(a); return this; }, async exec() { guard(); for (const [key, val] of ops) m.set(key, val); return ops.map(() => [null, 'OK']); } }; },
  };
  return r;
}
/** Soxta model: find(filter).sort().lean() — chaqiruvlar sanaladi, ma'lumot o'zgartirilishi mumkin. */
function fakeModel(docs) {
  const calls = []; const state = { docs: [...docs], delay: 0 };
  return {
    state, calls,
    find(filter = {}) {
      calls.push(filter);
      const run = async () => {
        if (state.delay) await new Promise((r) => setTimeout(r, state.delay));
        let rows = state.docs;
        if (filter.category?.$in) rows = rows.filter((d) => filter.category.$in.includes(d.category));
        else if (typeof filter.category === 'string') rows = rows.filter((d) => d.category === filter.category);
        return [...rows].sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
      };
      return { sort() { return this; }, select() { return this; }, lean: run };
    },
  };
}
const P = (name, category, extra = {}) => ({ _id: name, name, category, isActive: true, imageUrl: '', ...extra });
const DOCS = [
  P('Mol', 'gosht', { imageUrl: 'x' }), P('Qo‘y', 'gosht'), P('Tovuq', 'parranda', { isActive: false }),
  P('Sut', 'sut'), P('Qaymoq', 'sut', { imageUrl: 'y' }), P('Pishloq', 'pishloq'),
  ...Array.from({ length: 600 }, (_, i) => P(`Banan ${String(i).padStart(3, '0')}`, 'meva')),   // 500 dan ko'p
];
const make = (docs = DOCS, over = {}) => { const redis = fakeRedis(); const model = fakeModel(docs); const log = { warn() {} };
  return { redis, model, cache: createCatalogCache({ getRedis: () => redis, model, ttl: 60, log, ...over }) }; };

test('sonlar: aniq (500 da kesilmaydi), faol va rasmli hisoblanadi', async () => {
  const { cache } = make();
  const { data, source } = await cache.counts();
  assert.equal(source, 'miss'); assert.equal(data.total, 606);
  const by = Object.fromEntries(data.counts.map((c) => [c.category, c]));
  assert.deepEqual(by.meva, { category: 'meva', total: 600, active: 600, withImage: 0 });
  assert.deepEqual(by.gosht, { category: 'gosht', total: 2, active: 2, withImage: 1 });
  assert.deepEqual(by.parranda, { category: 'parranda', total: 1, active: 0, withImage: 0 });
});

test('BO‘LIM OCHILGANDA butun katalog Redis ga yuklanadi (isitish): bitta bazaga so‘rov', async () => {
  const { cache, redis, model } = make();
  await cache.counts();
  assert.equal(model.calls.length, 1, 'butun katalog BIR so‘rovda');
  const keys = [...redis.store.keys()];
  for (const c of ['gosht', 'parranda', 'sut', 'pishloq', 'meva']) assert.ok(keys.some((x) => x.endsWith(`:cat:${c}`)), `${c} kaliti yozildi`);
  assert.ok(keys.some((x) => x.endsWith(':counts')) && keys.some((x) => x.endsWith(':warm')));
});

test('KARTOCHKA BOSILGANDA: faqat shu kategoriya Redis dan, BAZAGA O‘TMAYDI', async () => {
  const { cache, model } = make();
  await cache.counts();                      // bo'lim ochildi
  const before = model.calls.length;
  const r = await cache.products(['sut']);
  assert.equal(r.source, 'hit'); assert.deepEqual(r.items.map((p) => p.name), ['Qaymoq', 'Sut']);
  const r2 = await cache.products(['gosht', 'parranda']);
  assert.equal(r2.source, 'hit'); assert.deepEqual(r2.items.map((p) => p.name), ['Mol', 'Qo‘y', 'Tovuq'], 'so‘ralgan tartibda, ichida nom bo‘yicha');
  assert.equal(model.calls.length, before, 'baza o‘qilmadi');
});

test('katta kategoriya (600 ta) TO‘LIQ beriladi — 500 kesish yo‘q', async () => {
  const { cache } = make();
  await cache.counts();
  assert.equal((await cache.products(['meva'])).items.length, 600);
});

test('sovuq kesh: kartochka bosilsa butun katalog yuklanadi, keyingi bosishlar tayyor', async () => {
  const { cache, model } = make();
  const a = await cache.products(['sut']);
  assert.equal(a.source, 'miss'); assert.equal(a.items.length, 2); assert.equal(model.calls.length, 1);
  const b = await cache.products(['gosht']);
  assert.equal(b.source, 'hit'); assert.equal(model.calls.length, 1, 'boshqa kategoriya bazaga bormadi');
});

test('O‘ZGARISHDAN KEYIN: versiya oshadi, eski ma‘lumot HECH QACHON qaytmaydi', async () => {
  const { cache, model, redis } = make();
  await cache.counts();
  assert.equal((await cache.products(['sut'])).items.length, 2);
  model.state.docs.push(P('Smetana', 'sut'));        // admin yangi mahsulot qo'shdi
  assert.equal(await cache.invalidate(), true); assert.equal(redis.stats.incr, 1);
  const after = await cache.products(['sut']);
  assert.equal(after.source, 'miss'); assert.equal(after.items.length, 3, 'yangi mahsulot darhol ko‘rinadi');
  const c = await cache.counts(); assert.equal(c.data.counts.find((x) => x.category === 'sut').total, 3);
});

test('isitish paytida o‘zgarish bo‘lsa — eskirgan ma‘lumot yangi versiyaga o‘tmaydi', async () => {
  const { cache, model } = make();
  model.state.delay = 40;
  const slow = cache.counts();                       // isitish boshlandi (eski versiya)
  await new Promise((r) => setTimeout(r, 10));
  const snapshot = [...model.state.docs];
  model.state.docs.push(P('Yangi', 'sut'));
  await cache.invalidate();                          // isitish tugamasdan o'zgarish
  await slow;
  model.state.delay = 0;
  const now = await cache.products(['sut']);
  assert.ok(now.items.some((p) => p.name === 'Yangi'), 'yangi versiya bazadan qayta yuklandi');
  assert.equal(snapshot.length + 1, model.state.docs.length);
});

test('parallel 20 ta so‘rov → isitish BIR marta (single-flight)', async () => {
  const { cache, model } = make();
  model.state.delay = 20;
  await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? cache.counts() : cache.products(['sut']))));
  assert.equal(model.calls.length, 1, `bazaga ${model.calls.length} marta bordi`);
});

test('Redis YO‘Q: hammasi bazadan, javob bir xil', async () => {
  const model = fakeModel(DOCS);
  const cache = createCatalogCache({ getRedis: () => null, model, log: { warn() {} } });
  const c = await cache.counts(); assert.equal(c.source, 'off'); assert.equal(c.data.total, 606);
  const p = await cache.products(['sut', 'gosht']); assert.equal(p.source, 'off'); assert.deepEqual(p.items.map((x) => x.name), ['Qaymoq', 'Sut', 'Mol', 'Qo‘y']);
  assert.equal(await cache.invalidate(), false);
});

test('Redis XATO beradi (uzildi): javob bazadan, server yiqilmaydi', async () => {
  const { cache, redis } = make();
  await cache.counts(); redis.break();
  const c = await cache.counts(); assert.equal(c.data.total, 606);
  const p = await cache.products(['sut']); assert.equal(p.items.length, 2);
  assert.equal(await cache.invalidate(), false, 'invalidate xatoni yutadi');
});

test('Redis ga yozish xatosi: javob baribir to‘g‘ri', async () => {
  const { cache, redis } = make();
  redis.pipeline = () => ({ set() { return this; }, async exec() { throw new Error('OOM'); } });
  const c = await cache.counts(); assert.equal(c.data.total, 606);
});

test('1–2 ta kalit yo‘qolsa (Redis chiqarib tashladi) — faqat o‘sha kategoriya bazadan', async () => {
  const { cache, model, redis } = make();
  await cache.counts();
  const key = [...redis.store.keys()].find((x) => x.endsWith(':cat:sut')); redis.store.delete(key);
  const before = model.calls.length;
  const r = await cache.products(['sut', 'gosht']);
  assert.equal(r.source, 'miss'); assert.equal(r.items.length, 4);
  assert.equal(model.calls.length, before + 1, 'faqat yo‘qolgan kategoriya uchun bitta so‘rov');
  assert.equal((await cache.products(['sut'])).source, 'hit', 'qayta keshlandi');
});

test('buzuq JSON keshda: e‘tiborsiz, bazadan qayta o‘qiladi', async () => {
  const { cache, redis } = make();
  await cache.counts();
  const key = [...redis.store.keys()].find((x) => x.endsWith(':cat:sut')); redis.store.set(key, '{buzuq');
  const r = await cache.products(['sut']); assert.equal(r.items.length, 2);
});

test('faqat MGET xato beradi (versiya o‘qiladi): javob baribir to‘g‘ri', async () => {
  const { cache, redis } = make();
  await cache.counts();
  redis.mget = async () => { throw new Error('timeout'); };
  const r = await cache.products(['sut']);
  assert.equal(r.items.length, 2);
});
