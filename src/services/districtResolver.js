/*
 * ═══ TUMAN ANIQLOVCHI (district resolver) ═══
 *
 * Koordinata → LokmaGo tuman kaliti (pop, chust, namangan_sh ...). Manba: data/uzbekistan/namangan-districts.geojson
 * (scripts/extract-district-boundaries.js; OpenStreetMap, CC BY 4.0). Yandex/tashqi API kerak emas.
 *
 * Qoidalar (TZ 5, 11):
 *   • GeoJSON server ishga tushganda (yoki birinchi murojaatda) BIR MARTA o'qiladi, tekshiriladi va xotirada turadi.
 *   • Fayl yo'q/buzuq/flag o'chiq → resolver "unavailable": mavjud API'lar ishlashda davom etadi, yangi funksiya o'chiq.
 *   • Topilmasa — `matched:false, reason:'OUTSIDE_COVERAGE'`. Hech qachon "Pop" deb taxmin qilinmaydi.
 *   • Chegaradan `boundaryBufferMeters` ichida, yonida boshqa tuman ham bo'lsa — `BOUNDARY_UNCERTAIN` (mijoz oxirgi
 *     ishonchli tumanni saqlaydi; chegarada Pop/Chust tez-tez almashmaydi). Viloyatning tashqi chekkasi (yonida boshqa
 *     tuman yo'q) noaniq hisoblanmaydi.
 *   • Bir nechta poligonga tushsa (ustma-ust) — `BOUNDARY_UNCERTAIN`.
 *   • GPS koordinatalari LOGGA YOZILMAYDI: faqat agregat hisoblagichlar (stats()).
 */
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { config } from '../config/index.js';
import { districtLabel, isDistrict } from '../constants/districts.js';
import { NO_BOUNDARY_DISTRICTS } from '../constants/districtBoundaryMap.js';
import { pointInGeometry, distanceToBoundaryMeters, bboxOf, expandBbox, inBbox, validateGeometry } from '../lib/geo.js';

let state = null;   // { ok, reason, version, features[], loadedAt, loadMs, bytes }
const counters = { matched: 0, outside: 0, uncertain: 0, invalid: 0, unavailable: 0, totalMs: 0, calls: 0 };

/** Faylni o'qib tekshiradi. Xato bo'lsa throw qilmaydi — holatni "unavailable" qiladi. */
export function loadBoundaries({ path = config.district.boundariesPath, version = config.district.boundariesVersion, enabled = config.district.boundariesEnabled } = {}) {
  const t0 = Date.now();
  if (!enabled) { state = { ok: false, reason: 'DISABLED', version }; return state; }
  try {
    const raw = readFileSync(resolvePath(path));
    const fc = JSON.parse(raw.toString('utf8'));
    if (fc?.type !== 'FeatureCollection' || !Array.isArray(fc.features) || !fc.features.length) throw new Error('FeatureCollection emas yoki bo\'sh');
    const seen = new Set();
    const features = fc.features.map((f, i) => {
      const id = f?.properties?.lokmaDistrictId;
      if (!isDistrict(id)) throw new Error(`feature ${i}: noma'lum lokmaDistrictId "${id}"`);
      if (seen.has(id)) throw new Error(`takror tuman: ${id}`);
      seen.add(id);
      const errs = validateGeometry(f.geometry);
      if (errs.length) throw new Error(`${id}: ${errs[0]}`);
      return { id, geometry: f.geometry, bbox: bboxOf(f.geometry) };
    });
    state = {
      ok: true, reason: null, version: String(fc.metadata?.version || version), configuredVersion: version,
      features, loadedAt: new Date(), loadMs: Date.now() - t0, bytes: raw.length,
      sourceCommit: fc.metadata?.sourceCommit || null, sourceSha256: fc.metadata?.sourceSha256 || null,
    };
    if (state.version !== String(version)) {
      // Fayl versiyasi sozlamadan farq qilsa — xavfsiz tomonga: ishlatilmaydi (production o'z-o'zidan almashmasin)
      state = { ok: false, reason: `VERSION_MISMATCH (fayl ${state.version}, sozlama ${version})`, version };
    }
  } catch (e) {
    state = { ok: false, reason: `LOAD_FAILED: ${e.message}`, version };
  }
  console.log(state.ok
    ? `✓ Tuman chegaralari yuklandi: ${state.features.length} ta, versiya ${state.version}, ${state.loadMs} ms`
    : `• Tuman chegaralari o'chiq: ${state.reason}`);
  return state;
}

const ensure = () => state || loadBoundaries();

export const isResolverAvailable = () => !!ensure().ok;
export const boundaryVersion = () => ensure().version || null;

/** Tumanlar ro'yxati (poligoni borlari) — mijoz/admin tanlagichi uchun. */
export function supportedDistrictIds() {
  const s = ensure();
  return s.ok ? s.features.map((f) => f.id) : [];
}

/**
 * Nuqtani aniqlaydi. Qaytaradi: { districtId, districtName, matched, reason?, boundaryVersion }.
 * Faqat raqamlarni qabul qiladi; diapazon tekshiruvi controller'da (400), bu yerda — himoya uchun yana.
 */
export function resolveDistrict(lat, lng, { bufferMeters = config.district.boundaryBufferMeters, lang = 'uz' } = {}) {
  const t0 = performance.now();
  const s = ensure();
  const out = (r) => {
    counters.calls += 1; counters.totalMs += performance.now() - t0;
    return { boundaryVersion: s.version || null, ...r };
  };
  if (!s.ok) { counters.unavailable += 1; return out({ districtId: null, districtName: null, matched: false, reason: 'UNAVAILABLE' }); }
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    counters.invalid += 1; return out({ districtId: null, districtName: null, matched: false, reason: 'INVALID_COORDINATES' });
  }

  const hits = [];
  const near = [];   // bufer ichidagi (chegarasi yaqin) tumanlar
  for (const f of s.features) {
    const bb = bufferMeters > 0 ? expandBbox(f.bbox, bufferMeters) : f.bbox;
    if (!inBbox(lng, lat, bb)) continue;
    const inside = inBbox(lng, lat, f.bbox) && pointInGeometry(lng, lat, f.geometry);
    const dist = bufferMeters > 0 ? distanceToBoundaryMeters(lng, lat, f.geometry) : Infinity;
    if (inside) hits.push({ id: f.id, dist });
    else if (dist <= bufferMeters) near.push({ id: f.id, dist });
  }

  if (hits.length > 1) { counters.uncertain += 1; return out({ districtId: null, districtName: null, matched: false, reason: 'BOUNDARY_UNCERTAIN' }); }
  if (!hits.length) {
    // Tashqarida, lekin biror tumanning chegarasiga juda yaqin — GPS xatosi bo'lishi mumkin: noaniq (oxirgisi saqlansin)
    if (near.length) { counters.uncertain += 1; return out({ districtId: null, districtName: null, matched: false, reason: 'BOUNDARY_UNCERTAIN' }); }
    counters.outside += 1; return out({ districtId: null, districtName: null, matched: false, reason: 'OUTSIDE_COVERAGE' });
  }
  const [hit] = hits;
  // O'z chegarasiga yaqin VA chegaraning narigi tomonida boshqa tuman bor — noaniq
  if (hit.dist <= bufferMeters && near.length) {
    counters.uncertain += 1; return out({ districtId: null, districtName: null, matched: false, reason: 'BOUNDARY_UNCERTAIN' });
  }
  counters.matched += 1;
  return out({ districtId: hit.id, districtName: districtLabel(hit.id, lang), matched: true });
}

/**
 * Restoran uchun (admin saqlaganda / migratsiya): bufer qo'llanmaydi — restoran nuqtasi qat'iy, chegara yonida bo'lsa ham
 * u qaysi poligon ichida bo'lsa o'sha. Ustma-ust yoki tashqarida bo'lsa — null (sababi bilan), Pop'ga tushirilmaydi.
 */
export function resolveRestaurantDistrict(lat, lng) {
  return resolveDistrict(Number(lat), Number(lng), { bufferMeters: 0 });
}

/** Monitoring: agregat hisoblagichlar (koordinatasiz). */
export function resolverStats() {
  const s = ensure();
  return {
    available: !!s.ok, reason: s.reason || null, version: s.version || null, features: s.features?.length || 0,
    loadMs: s.loadMs ?? null, bytes: s.bytes ?? null, sourceCommit: s.sourceCommit || null,
    noBoundary: NO_BOUNDARY_DISTRICTS,
    counters: { ...counters, avgMs: counters.calls ? +(counters.totalMs / counters.calls).toFixed(3) : 0 },
  };
}

/** Faqat testlar uchun: holatni tozalash. */
export function _resetResolverForTests() {
  state = null;
  Object.keys(counters).forEach((k) => { counters[k] = 0; });
}
