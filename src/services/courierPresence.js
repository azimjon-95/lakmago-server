import { getRedis, isCacheReady } from './cache.js';
import { haversineMeters } from './courierDispatch.js';

/**
 * KURYER JOYLASHUVI — «hozir qayerda». Redis'da, har ~5 soniyada yangilanadi, 90 soniya jim bo'lsa o'zi yo'qoladi.
 *
 *   courier:loc:<id>   HASH { lat, lng, acc, spd, hdg, ts }   TTL 90 s   ← oxirgi nuqta
 *   couriers:onshift   SET  <id>…                                        ← smenadagi kuryerlar (yaqinlarni topish uchun)
 *
 * «Yaqin kuryerlar»: SET'dagi har bir kuryerning nuqtasi pipeline bilan o'qiladi va masofa hisoblanadi (yuzlab kuryer uchun yetarli;
 * minglab bo'lsa GEOSEARCH'ga o'tish mumkin). TTL tugagan (jim qolgan / telefoni o'chgan) kuryer ro'yxatdan o'zi tushadi.
 *
 * ENG MUHIM QOIDA (cache.js bilan bir xil): Redis MAJBURIY EMAS. Redis yo'q / uzilgan bo'lsa jarayon xotirasiga yoziladi —
 * kuryer ilovasi ishlayveradi (faqat bitta server nusxasida to'liq; bir nechta nusxada Redis kerak). Hech qachon istisno otmaydi.
 */
const KEY = (id) => `courier:loc:${id}`;
const SET = 'couriers:onshift';
export const LOC_TTL_SEC = 90;

const mem = { loc: new Map(), onshift: new Set() };
let override = null;                                   // faqat testlar uchun
const redis = () => { if (override !== null) return override || null; try { return isCacheReady() ? getRedis() : null; } catch { return null; } };
export function _useRedisForTest(client) { override = client; }                // null = asl holat, false = Redis'siz

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : '');

/** @returns 'redis' | 'memory' — qayerga yozilgani (monitoring / testlar uchun) */
export async function setLocation(id, loc) {
  const rec = { lat: loc.lat, lng: loc.lng, acc: num(loc.accuracy), spd: num(loc.speed), hdg: num(loc.heading), ts: loc.ts ?? Date.now() };
  const r = redis();
  if (r) {
    try { await r.pipeline().hset(KEY(id), rec).expire(KEY(id), LOC_TTL_SEC).sadd(SET, String(id)).exec(); return 'redis'; } catch { /* xotiraga */ }
  }
  mem.loc.set(String(id), { ...rec, exp: Date.now() + LOC_TTL_SEC * 1000 }); mem.onshift.add(String(id));
  return 'memory';
}

const parse = (h) => (h && h.lat !== undefined && h.lat !== '' ? { lat: Number(h.lat), lng: Number(h.lng), accuracy: h.acc === '' ? null : Number(h.acc), speed: h.spd === '' ? null : Number(h.spd), heading: h.hdg === '' ? null : Number(h.hdg), ts: Number(h.ts) } : null);

export async function getLocation(id) {
  const r = redis();
  if (r) { try { const h = await r.hgetall(KEY(id)); const p = parse(h); if (p) return p; } catch { /* xotiraga */ } }
  const m = mem.loc.get(String(id));
  return m && m.exp > Date.now() ? parse(m) : null;
}

export async function clearLocation(id) {
  const r = redis();
  if (r) { try { await r.pipeline().del(KEY(id)).srem(SET, String(id)).exec(); } catch { /* xotiraga */ } }
  mem.loc.delete(String(id)); mem.onshift.delete(String(id));
}

/** Smenadagi kuryerlar, nuqtasi bor va [radiusM] ichidagilar — eng yaqini birinchi. `exclude` — id'lar to'plami. */
export async function nearby(center, radiusM, { limit = 50, exclude = new Set() } = {}) {
  const out = [];
  const consider = (id, p) => {
    if (!p || exclude.has(String(id))) return;
    const d = haversineMeters(center, p);
    if (d <= radiusM) out.push({ id: String(id), ...p, distanceM: Math.round(d) });
  };
  const r = redis();
  if (r) {
    try {
      const ids = await r.smembers(SET);
      if (ids.length) {
        const rows = await ids.reduce((pl, id) => pl.hgetall(KEY(id)), r.pipeline()).exec();
        const dead = [];
        rows.forEach(([err, h], i) => { const p = err ? null : parse(h); if (p) consider(ids[i], p); else dead.push(ids[i]); });
        if (dead.length) r.srem(SET, ...dead).catch(() => {});             // TTL tugagan kuryerlarni ro'yxatdan tozalaymiz
      }
    } catch { /* xotira bilan to'ldiramiz */ }
  }
  const now = Date.now();
  for (const id of mem.onshift) {
    const m = mem.loc.get(id);
    if (!m || m.exp <= now) { mem.onshift.delete(id); mem.loc.delete(id); continue; }
    if (!out.some((o) => o.id === id)) consider(id, parse(m));
  }
  return out.sort((a, b) => a.distanceM - b.distanceM).slice(0, limit);
}

export async function onShiftCount() {
  const r = redis();
  if (r) { try { return await r.scard(SET); } catch { /* xotira */ } }
  return mem.onshift.size;
}
