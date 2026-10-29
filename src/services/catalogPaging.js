/*
 * ═══ KATALOG: SAHIFALASH, QIDIRUV, SARALASH (toza mantiq — Redis/baza kerak emas) ═══
 *
 * Admin katalogida bir guruhda minglab mahsulot bo'lishi mumkin. Hammasini bir yo'la yuborish o'rniga:
 *   • har so'rovda `limit` (100) ta beriladi, keyingisi `offset` bilan (pastga aylantirilganda);
 *   • birinchi 100 ta HAR SAFAR TASODIFIY (`sort=random`): `seed` bilan — bir ochilish davomida tartib BARQAROR
 *     (sahifalar takrorlanmaydi/yo'qolmaydi), yangi ochilishda yangi seed → boshqa 100 ta;
 *   • qidiruv va filtrlar butun to'plam bo'yicha (faqat yuklangan 100 ta emas).
 * Bu fayl `lakmago-admin/src/lib/catalogPaging.js` bilan BIR XIL natija beradi (eski serverda admin o'zi shuni ishlatadi):
 * ikkala tomonda bir xil sinov fixture'i bor.
 */
export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 200;
export const SORTS = ['random', 'name', 'name_desc', 'usage', 'new', 'relevance'];

/** Qidiruv uchun matnni tekislash: kichik harf, apostrof variantlari (’ ‘ ʻ ʼ ` ´) → ', ortiqcha bo'shliqlar yo'q. */
export const norm = (s) => String(s ?? '').toLowerCase().replace(/[’‘ʻʼ`´]/g, "'").replace(/\s+/g, ' ').trim();

/** FNV-1a (32 bit) + yakuniy aralashtirish: tez va yaxshi tarqaladigan deterministik xesh. */
export function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return h >>> 0;
}
export const seededRank = (seed, id) => hash32(`${seed}:${id}`);

/** meta: { n: normallashgan nom, b: nom+tavsif+hajm (qidiruv bloki) } — har mahsulot uchun bir marta hisoblanadi. */
export const metaOf = (p) => ({ n: norm(p.name), b: norm(`${p.name} ${p.description || ''} ${p.volume || ''}`) });

/** Filtr (holat, rasm, qidiruv). Qaytaradi: o'tgan indekslar. */
export function filterIndexes(items, metas, { status = 'all', image = 'all', q = '' } = {}) {
  const needle = norm(q);
  const out = [];
  for (let i = 0; i < items.length; i += 1) {
    const p = items[i];
    if (status === 'active' && p.isActive === false) continue;
    if (status === 'inactive' && p.isActive !== false) continue;
    if (image === 'with' && !p.imageUrl) continue;
    if (image === 'without' && p.imageUrl) continue;
    if (needle && !metas[i].b.includes(needle)) continue;
    out.push(i);
  }
  return out;
}

const collator = new Intl.Collator('uz', { numeric: true, sensitivity: 'base' });
const byName = (a, b) => collator.compare(String(a.name), String(b.name)) || String(a._id).localeCompare(String(b._id));

/** Qidiruv mosligi (kichik = yaxshiroq): nom boshidan (0) · so'z boshidan (1) · nomda (2) · faqat tavsif/hajmda (3). */
function relevance(meta, needle) {
  if (meta.n.startsWith(needle)) return 0;
  if (meta.n.includes(` ${needle}`)) return 1;
  if (meta.n.includes(needle)) return 2;
  return 3;
}

/** idx — filtrdan o'tgan indekslar. Tartiblangan indekslarni qaytaradi. */
export function sortIndexes(items, metas, idx, { sort = 'name', seed = '', q = '' } = {}) {
  const arr = [...idx];
  const needle = norm(q);
  const tie = (a, b) => byName(items[a], items[b]);
  if (sort === 'random') {
    const rank = new Map(arr.map((i) => [i, seededRank(seed, items[i]._id)]));
    return arr.sort((a, b) => rank.get(a) - rank.get(b) || String(items[a]._id).localeCompare(String(items[b]._id)));
  }
  if (sort === 'relevance' && needle) {
    const score = new Map(arr.map((i) => [i, relevance(metas[i], needle)]));
    return arr.sort((a, b) => score.get(a) - score.get(b) || tie(a, b));
  }
  if (sort === 'name_desc') return arr.sort((a, b) => tie(b, a));
  if (sort === 'usage') return arr.sort((a, b) => (items[b].usageCount || 0) - (items[a].usageCount || 0) || tie(a, b));
  if (sort === 'new') return arr.sort((a, b) => String(items[b].createdAt || '').localeCompare(String(items[a].createdAt || '')) || tie(a, b));
  return arr.sort(tie);
}

/** To'liq so'rov: filtr → saralash → bo'lak. */
export function queryPage(items, metas, params = {}) {
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(params.limit) || DEFAULT_LIMIT));
  const offset = Math.min(1_000_000, Math.max(0, Number(params.offset) || 0));
  const q = params.q || '';
  const sort = SORTS.includes(params.sort) ? params.sort : (norm(q) ? 'relevance' : 'name');
  const idx = filterIndexes(items, metas, params);
  const sorted = sortIndexes(items, metas, idx, { sort, seed: params.seed || '', q });
  const slice = sorted.slice(offset, offset + limit).map((i) => items[i]);
  return { items: slice, total: sorted.length, offset, limit, hasMore: offset + slice.length < sorted.length, sort };
}

/** Yangi tasodifiy seed (server — mijoz bermasa). */
export const newSeed = () => Math.random().toString(36).slice(2, 10);
export const validSeed = (s) => (typeof s === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(s) ? s : null);
