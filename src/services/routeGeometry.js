import { googleRoute, decodePolyline } from './googleMaps.js';

/*
 * ═══ YO'L CHIZIG'I (haqiqiy ko'chalar bo'ylab) ═══
 * Xarita uchun A → B marshrut nuqtalari + masofa + vaqt (mijoz kuzatuvi, yetkazish tasdiqlash xaritasi).
 *   1) Google Routes API (kalit bo'lsa — GOOGLE_MAPS_API_KEY; tirbandlik hisobga olinadi);
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

const shape = (points, meters, seconds, source) => ({
  points,
  distanceKm: meters != null ? meters / 1000 : null,
  distanceM: meters != null ? Math.round(meters) : null,
  durationMin: seconds != null ? Math.ceil(seconds / 60) : null,
  durationS: seconds != null ? Math.round(seconds) : null,
  source,
});

async function viaGoogle(a, b) {
  const r = await googleRoute(a, b, { traffic: true });
  if (!r) return null;
  const points = decodePolyline(r.encoded);
  return points.length > 1 ? shape(points, r.meters, r.seconds, 'google') : null;
}

async function viaOsrm(a, b) {
  const base = process.env.OSRM_URL || 'https://router.project-osrm.org';
  const data = await fetchJson(`${base}/route/v1/driving/${a.lng},${a.lat};${b.lng},${b.lat}?overview=full&geometries=geojson`);
  const rt = data?.routes?.[0];
  const coords = rt?.geometry?.coordinates;
  if (!coords || coords.length < 2) return null;
  return shape(coords.map(([lng, lat]) => [lat, lng]), rt.distance, rt.duration, 'osrm');
}

export async function routeBetween(a, b) {
  const key = `${r4(a.lat)},${r4(a.lng)}|${r4(b.lat)},${r4(b.lng)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.value;

  let value = null;
  for (const fn of [viaGoogle, viaOsrm]) {
    try { value = await fn(a, b); } catch { value = null; }
    if (value) break;
  }
  if (!value) value = { points: [[a.lat, a.lng], [b.lat, b.lng]], distanceKm: null, distanceM: null, durationMin: null, durationS: null, source: 'straight' };

  if (cache.size >= MAX) cache.delete(cache.keys().next().value);
  cache.set(key, { at: Date.now(), value });
  return value;
}
