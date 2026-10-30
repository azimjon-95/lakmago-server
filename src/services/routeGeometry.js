import { config } from '../config/index.js';

/*
 * ═══ YO'L CHIZIG'I (haqiqiy ko'chalar bo'ylab) ═══
 * Mijoz kuzatuv xaritasi uchun A → B marshrut nuqtalari.
 *   1) Yandex Router API (kalit bo'lsa — YANDEX_ROUTING_KEY);
 *   2) OSRM (OpenStreetMap yo'l tarmog'i, kalitsiz);
 *   3) bo'lmasa — to'g'ri chiziq (source: 'straight', mijoz ilovasi shunga qarab chizadi).
 * Kesh: koordinata ~11 m aniqlikda yaxlitlanadi, 3 daqiqa — kuryer joyi biroz
 * o'zgarsa ham har 8 soniyada tashqi API chaqirilmaydi.
 */
const cache = new Map();
const TTL = 3 * 60_000;
const MAX = 1000;
const r4 = (n) => Number(n).toFixed(4);

async function fetchJson(url, ms = 4000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(ms) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function viaYandex(a, b) {
  const key = config.yandex?.routingKey;
  if (!key) return null;
  const url = new URL('https://api.routing.yandex.net/v2/route');
  url.searchParams.set('apikey', key);
  url.searchParams.set('waypoints', `${a.lat},${a.lng}|${b.lat},${b.lng}`);
  url.searchParams.set('mode', 'driving');
  const data = await fetchJson(url);
  const leg = data?.route?.legs?.[0];
  if (leg?.status !== 'OK') return null;
  const points = []; let meters = 0; let secs = 0;
  for (const st of leg.steps || []) {
    for (const p of st.polyline?.points || []) points.push([Number(p[0]), Number(p[1])]);
    meters += st.length?.value || 0; secs += st.duration?.value || 0;
  }
  return points.length > 1 ? { points, distanceKm: meters / 1000, durationMin: Math.ceil(secs / 60), source: 'yandex' } : null;
}

async function viaOsrm(a, b) {
  const base = process.env.OSRM_URL || 'https://router.project-osrm.org';
  const data = await fetchJson(`${base}/route/v1/driving/${a.lng},${a.lat};${b.lng},${b.lat}?overview=full&geometries=geojson`);
  const rt = data?.routes?.[0];
  const coords = rt?.geometry?.coordinates;
  if (!coords || coords.length < 2) return null;
  return { points: coords.map(([lng, lat]) => [lat, lng]), distanceKm: rt.distance / 1000, durationMin: Math.ceil(rt.duration / 60), source: 'osrm' };
}

export async function routeBetween(a, b) {
  const key = `${r4(a.lat)},${r4(a.lng)}|${r4(b.lat)},${r4(b.lng)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.value;

  let value = null;
  for (const fn of [viaYandex, viaOsrm]) {
    try { value = await fn(a, b); } catch { value = null; }
    if (value) break;
  }
  if (!value) value = { points: [[a.lat, a.lng], [b.lat, b.lng]], distanceKm: null, durationMin: null, source: 'straight' };

  if (cache.size >= MAX) cache.delete(cache.keys().next().value);
  cache.set(key, { at: Date.now(), value });
  return value;
}
