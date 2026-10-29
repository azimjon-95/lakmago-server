import { getRedis as realGetRedis } from './cache.js';
import { CatalogProduct } from '../models/CatalogProduct.js';
import { metaOf, newSeed, queryPage, validSeed } from './catalogPaging.js';

/*
 * ═══ UMUMIY KATALOG (ADMIN) — REDIS KESHI ═══
 *
 * MUAMMO: admin "Katalog" bo'limi har ochilganda butun katalog bazadan o'qilardi, ro'yxat esa 500 tada KESILARDI
 * (katta katalogda kategoriya sonlari noto'g'ri — hammasi "0 ta" ko'rinardi).
 *
 * YECHIM:
 *   • Bo'lim ochilganda (GET /admin/catalog/counts) butun katalog BIR so'rov bilan o'qilib, kategoriyalar bo'yicha
 *     bo'linib Redis'ga yuklanadi ("isitish" — warm): sonlar + har bir kategoriyaning to'liq ro'yxati.
 *   • Kartochka bosilganda (GET /admin/catalog?categories=a,b) faqat shu kategoriyalar Redis'dan (MGET) beriladi —
 *     baza umuman o'qilmaydi. 500 kesish yo'q.
 *   • O'zgarishda (yaratish/tahrirlash/o'chirish/restoranga qo'shilish) kesh VERSIYA hisoblagichini oshirish bilan
 *     bekor qilinadi (INCR): eski kalitlar o'qilmaydi va o'zi eskiradi. Naqsh bo'yicha o'chirish (SCAN) kerak emas.
 *
 * XAVFSIZLIK QOIDALARI:
 *   • Redis MAJBURIY EMAS (services/cache.js). Redis yo'q yoki xato — bazadan to'g'ridan-to'g'ri, javob o'sha.
 *   • Prefiks `pcat:` — mijozdagi restoranlar ro'yxati keshi (`catalog:*`) bilan ARALASHMAYDI.
 *   • Bir vaqtda ko'p so'rov kelsa isitish BIR marta bajariladi (single-flight) — baza bosilmaydi.
 *   • Isitish paytida o'zgarish bo'lsa — eski versiya kaliti ostiga yoziladi va hech kim o'qimaydi (eskirgan ma'lumot
 *     yangi versiyaga HECH QACHON o'tmaydi).
 */
export const CATALOG_CACHE_TTL_S = 3600;
const VER_KEY = 'pcat:ver';
const k = (v, ...parts) => ['pcat', v, ...parts].join(':');

export function createCatalogCache({ getRedis = realGetRedis, model = CatalogProduct, ttl = CATALOG_CACHE_TTL_S, log = console } = {}) {
  const inflight = new Map();

  const sortOrder = { category: 1, name: 1 };

  const countsOf = (byCat) => [...byCat].map(([category, list]) => ({
    category,
    total: list.length,
    active: list.filter((p) => p.isActive !== false).length,
    withImage: list.filter((p) => p.imageUrl).length,
  }));

  async function loadAll() {
    const docs = await model.find({}).sort(sortOrder).lean();
    const byCat = new Map();
    for (const d of docs) {
      if (!byCat.has(d.category)) byCat.set(d.category, []);
      byCat.get(d.category).push(d);
    }
    return { byCat, counts: countsOf(byCat), total: docs.length };
  }

  /** Redis yo'q: faqat sonlar kerak — 3 ta maydon yetadi (butun hujjatlarni o'qimaymiz). */
  async function loadCountsOnly() {
    const rows = await model.find({}).select('category isActive imageUrl').lean();
    const byCat = new Map();
    for (const d of rows) {
      if (!byCat.has(d.category)) byCat.set(d.category, []);
      byCat.get(d.category).push(d);
    }
    return { counts: countsOf(byCat), total: rows.length };
  }

  async function version(r) {
    try { return (await r.get(VER_KEY)) || '0'; } catch { return null; }
  }

  /** Butun katalogni o'qib Redis'ga yozadi. Parallel chaqiruvlar BIR ishni kutadi. */
  function warm(r, v) {
    if (inflight.has(v)) return inflight.get(v);
    const p = (async () => {
      const all = await loadAll();
      try {
        const pl = r.pipeline();
        pl.set(k(v, 'counts'), JSON.stringify({ total: all.total, counts: all.counts }), 'EX', ttl);
        for (const [cat, list] of all.byCat) pl.set(k(v, 'cat', cat), JSON.stringify(list), 'EX', ttl);
        pl.set(k(v, 'warm'), String(Date.now()), 'EX', ttl);
        await pl.exec();
      } catch (e) {
        log.warn?.('[catalogCache] Redis ga yozib bo‘lmadi (bazadan javob beriladi):', e.message);
      }
      return all;
    })().finally(() => inflight.delete(v));
    inflight.set(v, p);
    return p;
  }

  const fromDb = (list) => model.find({ category: { $in: list } }).sort(sortOrder).lean();

  /** Redis (yoki isitish/baza) dan kategoriyalar bo'yicha ro'yxatlar. Map(kategoriya → ro'yxat). */
  async function readLists(r, v, cats) {
    let raw;
    try { raw = await r.mget(cats.map((c) => k(v, 'cat', c))); } catch { raw = cats.map(() => null); }
    const lists = new Map();
    const missing = [];
    cats.forEach((c, i) => {
      if (raw[i]) { try { lists.set(c, JSON.parse(raw[i])); return; } catch { /* buzuq — qayta o'qiladi */ } }
      missing.push(c);
    });
    if (!missing.length) return { lists, source: 'hit' };

    let warmed = false;
    try { warmed = Boolean(await r.get(k(v, 'warm'))); } catch { /* */ }
    if (!warmed || missing.length >= 3) {
      // Kesh sovuq (yoki ko'p yetishmayapti): butun katalog bir so'rovda yuklanadi — keyingi bosishlar tez bo'ladi
      const all = await warm(r, v);
      for (const c of missing) lists.set(c, all.byCat.get(c) || []);
    } else {
      // Isigan kesh, 1–2 ta kalit yetishmaydi (masalan Redis o'chirgan): faqat o'shalar bazadan
      const docs = await fromDb(missing);
      for (const c of missing) {
        const list = docs.filter((d) => d.category === c);
        lists.set(c, list);
        try { await r.set(k(v, 'cat', c), JSON.stringify(list), 'EX', ttl); } catch { /* */ }
      }
    }
    return { lists, source: 'miss' };
  }

  /*
   * Jarayon xotirasi: kategoriya → { items, meta } (meta — qidiruv uchun oldindan tekislangan matn). Kesh VERSIYASI
   * o'zgarsa (har qanday yozuvdan keyin) butunlay tashlanadi — eskirgan ro'yxat HECH QACHON berilmaydi.
   */
  let memo = { v: null, lists: new Map() };
  async function memoLists(cats) {
    const r = getRedis();
    const v = r ? await version(r) : null;
    if (!r || v === null) {
      const docs = await fromDb(cats);
      const by = new Map(cats.map((c) => [c, []]));
      for (const d of docs) by.get(d.category)?.push(d);
      return { lists: new Map([...by].map(([c, items]) => [c, { items, meta: items.map(metaOf) }])), source: 'off' };
    }
    if (memo.v !== v || memo.lists.size > 200) memo = { v, lists: new Map() };
    const missing = cats.filter((c) => !memo.lists.has(c));
    if (!missing.length) return { lists: memo.lists, source: 'mem' };
    const got = await readLists(r, v, missing);
    for (const [c, items] of got.lists) memo.lists.set(c, { items, meta: items.map(metaOf) });
    return { lists: memo.lists, source: got.source };
  }

  return {
    /** Kategoriya bo'yicha sonlar. Kesh bo'sh bo'lsa — butun katalog yuklanadi (isitiladi). */
    async counts() {
      const r = getRedis();
      const v = r ? await version(r) : null;
      if (!r || v === null) {
        const light = await loadCountsOnly();
        return { data: { total: light.total, counts: light.counts }, source: 'off' };
      }
      try {
        const hit = await r.get(k(v, 'counts'));
        if (hit) return { data: JSON.parse(hit), source: 'hit' };
      } catch { /* bazaga o'tamiz */ }
      const all = await warm(r, v);
      return { data: { total: all.total, counts: all.counts }, source: 'miss' };
    },

    /** Berilgan kategoriyalarning TO'LIQ ro'yxati (500 kesish yo'q), so'ralgan tartibda, ichida nom bo'yicha. */
    async products(cats) {
      const r = getRedis();
      const v = r ? await version(r) : null;
      if (!r || v === null) {
        const items = await fromDb(cats);
        return { items: orderBy(items, cats), source: 'off' };
      }
      const { lists, source } = await readLists(r, v, cats);
      return { items: cats.flatMap((c) => lists.get(c) || []), source };
    },

    /*
     * SAHIFALASH (admin katalogi): filtr → qidiruv → saralash → bo'lak (limit/offset). Ro'yxatlar jarayon XOTIRASIDA
     * saqlanadi (kesh versiyasi bo'yicha) — har sahifa so'rovi Redis'ga ham bormaydi, faqat xotirada ishlanadi.
     * `cats` bo'sh bo'lsa — BUTUN katalog (umumiy qidiruv). Redis yo'q — har so'rovda bazadan (to'g'ri, lekin sekinroq).
     */
    async page(params = {}) {
      const cats = params.cats?.length
        ? params.cats
        : (await this.counts()).data.counts.map((c) => c.category);
      const { lists, source } = await memoLists(cats);
      const items = []; const metas = [];
      for (const c of cats) {
        const l = lists.get(c);
        if (!l) continue;
        for (let i = 0; i < l.items.length; i += 1) { items.push(l.items[i]); metas.push(l.meta[i]); }
      }
      const seed = validSeed(params.seed) || newSeed();
      return { ...queryPage(items, metas, { ...params, seed }), seed, source };
    },

    /** O'zgarishdan keyin chaqiriladi: kesh versiyasi oshadi — eski ma'lumot endi o'qilmaydi. */
    async invalidate() {
      const r = getRedis();
      if (!r) return false;
      try { await r.incr(VER_KEY); return true; } catch { return false; }
    },
  };
}

// so'ralgan kategoriya tartibida (bazadan kelganda)
function orderBy(items, cats) {
  const pos = new Map(cats.map((c, i) => [c, i]));
  return [...items].sort((a, b) => (pos.get(a.category) ?? 999) - (pos.get(b.category) ?? 999));
}

export const catalogCache = createCatalogCache();
