import { config } from '../config/index.js';

/*
 * ═══ GOOGLE MAPS (server tomoni) ═══
 *
 * Yagona joy: masofa/vaqt/yo'l chizig'i (Routes API) va manzil (Geocoding API). Kalit — GOOGLE_MAPS_API_KEY (SERVER kaliti:
 * IP bo'yicha cheklang; brauzerga CHIQMAYDI). Brauzer kaliti alohida (GOOGLE_MAPS_BROWSER_KEY, faqat Maps JavaScript API).
 *
 * MARSHRUT: avval Routes API (routes.googleapis.com — yangi loyihalarda ham yoqiladi), u ishlamasa (masalan faqat eski
 * Directions API yoqilgan) — Directions API (legacy). Ikkalasi ham bo'lmasa null (chaqiruvchi o'z zaxirasiga o'tadi).
 * Javoblar hech qachon "soxta" to'ldirilmaydi: topilmasa — null.
 */
const ROUTES_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';
const DIRECTIONS_URL = 'https://maps.googleapis.com/maps/api/directions/json';
const GEOCODE_URL = 'https://maps.googleapis.com/maps/api/geocode/json';

export const googleKey = () => config.google?.apiKey || '';
export const hasGoogleKey = () => Boolean(googleKey());
const DEFAULT_TIMEOUT = 4000;

/** Til: ru → 'ru', qolgan hammasi (uz, uzc) → 'uz' (Google lotin yozuvida o'zbekcha beradi). */
export const googleLang = (l) => (String(l || '').toLowerCase().startsWith('ru') ? 'ru' : 'uz');

/**
 * Google "Encoded Polyline Algorithm" → [[lat, lng], ...] (client bilan bir xil tartib).
 * Namuna (Google hujjatidan): "_p~iF~ps|U_ulLnnqC_mqNvxq`@" → [[38.5,-120.2],[40.7,-120.95],[43.252,-126.453]]
 */
export function decodePolyline(encoded) {
  const pts = [];
  let index = 0; let lat = 0; let lng = 0;
  const s = String(encoded || '');
  while (index < s.length) {
    let b; let shift = 0; let result = 0;
    do { b = s.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20 && index < s.length);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);
    shift = 0; result = 0;
    do { b = s.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20 && index < s.length);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);
    pts.push([lat / 1e5, lng / 1e5]);
  }
  return pts;
}

// ── Routes API (yangi) ──
async function viaRoutesApi(a, b, { traffic, timeoutMs }) {
  const res = await fetch(ROUTES_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': googleKey(),
      // Faqat kerakli maydonlar — hajm va narx kamayadi
      'X-Goog-FieldMask': 'routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline',
    },
    body: JSON.stringify({
      origin: { location: { latLng: { latitude: a.lat, longitude: a.lng } } },
      destination: { location: { latLng: { latitude: b.lat, longitude: b.lng } } },
      travelMode: 'DRIVE',
      // Tirbandliksiz — narx uchun barqaror; tirbandlik bilan — mijozga ko'rsatiladigan vaqt uchun
      routingPreference: traffic ? 'TRAFFIC_AWARE' : 'TRAFFIC_UNAWARE',
      units: 'METRIC',
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  // 4xx/5xx — javob tanasini tahlil qilmaymiz (chaqiruvchi zaxiraga o'tadi)
  const data = res.ok ? await res.json() : null;
  const r = data?.routes?.[0];
  const meters = Number(r?.distanceMeters);
  const seconds = parseInt(String(r?.duration || ''), 10);   // "1234s"
  if (!(meters > 0)) return null;
  return { meters, seconds: Number.isFinite(seconds) ? seconds : null, encoded: r?.polyline?.encodedPolyline || '' };
}

// ── Directions API (legacy) — faqat Routes API ishlamasa ──
async function viaDirectionsApi(a, b, { timeoutMs }) {
  const url = new URL(DIRECTIONS_URL);
  url.searchParams.set('origin', `${a.lat},${a.lng}`);
  url.searchParams.set('destination', `${b.lat},${b.lng}`);
  url.searchParams.set('mode', 'driving');
  url.searchParams.set('key', googleKey());
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  const data = res.ok ? await res.json() : null;
  const route = data?.status === 'OK' ? data.routes?.[0] : null;
  const leg = route?.legs?.[0];
  const meters = Number(leg?.distance?.value);
  const seconds = Number(leg?.duration_in_traffic?.value ?? leg?.duration?.value);
  if (!(meters > 0)) return null;
  return { meters, seconds: Number.isFinite(seconds) ? seconds : null, encoded: route?.overview_polyline?.points || '' };
}

/**
 * Avtomobil marshruti A → B. Qaytaradi: { meters, seconds, encoded } yoki null (kalit yo'q / xato / marshrut yo'q).
 * Hech qachon xato otmaydi.
 */
export async function googleRoute(a, b, { traffic = false, timeoutMs = DEFAULT_TIMEOUT } = {}) {
  if (!hasGoogleKey()) return null;
  for (const fn of [viaRoutesApi, viaDirectionsApi]) {
    try {
      const r = await fn(a, b, { traffic, timeoutMs });
      if (r) return r;
    } catch { /* keyingisiga o'tamiz */ }
  }
  return null;
}

// ── Geocoding ──
const geoCache = new Map();
const GEO_TTL = 60 * 60_000;
const GEO_MAX = 2000;
const geoPut = (k, v) => { if (geoCache.size >= GEO_MAX) geoCache.delete(geoCache.keys().next().value); geoCache.set(k, { at: Date.now(), v }); return v; };
const geoGet = (k) => { const h = geoCache.get(k); return h && Date.now() - h.at < GEO_TTL ? h.v : undefined; };

const comp = (list, type) => (list || []).find((c) => c.types?.includes(type))?.long_name || '';

/**
 * Koordinata → manzil: { address, street, city } (street/city — Google tarkibiy qismlaridan, til bo'yicha) yoki null.
 * Natija 1 soat keshlanadi (~1 m aniqlikda yaxlitlanadi) — xarita surilganda bir joy qayta-qayta to'lanmasin.
 */
export async function googleReverse(lat, lng, lang = 'uz') {
  if (!hasGoogleKey()) return null;
  const language = googleLang(lang);
  const key = `r|${language}|${lat.toFixed(5)},${lng.toFixed(5)}`;
  const hit = geoGet(key);
  if (hit !== undefined) return hit;
  try {
    const url = new URL(GEOCODE_URL);
    url.searchParams.set('latlng', `${lat},${lng}`);
    url.searchParams.set('language', language);
    url.searchParams.set('key', googleKey());
    const res = await fetch(url, { signal: AbortSignal.timeout(DEFAULT_TIMEOUT) });
    const data = res.ok ? await res.json() : null;
    if (data?.status !== 'OK' && data?.status !== 'ZERO_RESULTS') return null;       // xato holatlar keshlanmaydi
    // Plus-kod ("Q8WJ+H5") — manzil emas; birinchi haqiqiy natija olinadi
    const r = (data.results || []).find((x) => !x.types?.includes('plus_code')) || null;
    if (!r) return geoPut(key, null);
    const c = r.address_components || [];
    const street = [comp(c, 'route'), comp(c, 'street_number')].filter(Boolean).join(', ')
      || comp(c, 'premise') || comp(c, 'neighborhood') || comp(c, 'sublocality') || comp(c, 'sublocality_level_1');
    const city = comp(c, 'locality') || comp(c, 'administrative_area_level_2') || comp(c, 'administrative_area_level_1');
    return geoPut(key, { address: r.formatted_address || '', street: street || '', city: city || '' });
  } catch {
    return null;
  }
}

/** Manzil bo'yicha qidirish (O'zbekiston bilan cheklangan): [{ name, lat, lng }] (≤ 5) yoki null (xato). */
export async function googleGeocode(q, lang = 'uz') {
  if (!hasGoogleKey()) return null;
  const language = googleLang(lang);
  const text = String(q || '').trim();
  const key = `f|${language}|${text.toLowerCase()}`;
  const hit = geoGet(key);
  if (hit !== undefined) return hit;
  try {
    const url = new URL(GEOCODE_URL);
    url.searchParams.set('address', text);
    url.searchParams.set('components', 'country:UZ');   // faqat O'zbekiston
    url.searchParams.set('region', 'uz');
    url.searchParams.set('language', language);
    url.searchParams.set('key', googleKey());
    const res = await fetch(url, { signal: AbortSignal.timeout(DEFAULT_TIMEOUT) });
    const data = res.ok ? await res.json() : null;
    if (data?.status !== 'OK' && data?.status !== 'ZERO_RESULTS') return null;
    const out = (data.results || []).slice(0, 5).map((r) => ({
      name: r.formatted_address || '', lat: r.geometry?.location?.lat, lng: r.geometry?.location?.lng,
    })).filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lng));
    return geoPut(key, out);
  } catch {
    return null;
  }
}
