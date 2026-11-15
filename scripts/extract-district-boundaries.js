/**
 * Tuman chegaralarini manbadan ajratib olish + audit. FAQAT fayl yozadi (baza va server bilan ishi yo'q).
 *
 *   git clone --depth 1 https://github.com/negeloT/uzbekistan_borders /tmp/ub
 *   node scripts/extract-district-boundaries.js \
 *     --src=/tmp/ub/LVL_3/GEOJSON_LVL_3/UZB_OSM_BORDER_LVL_3.geojson \
 *     --region=/tmp/ub/LVL_2/GEOJSON_LVL_2/UZB_OSM_BORDER_LVL_2.geojson \
 *     --commit=$(git -C /tmp/ub rev-parse HEAD) --version=1
 *
 * Natija:
 *   data/uzbekistan/namangan-districts.geojson        — server yuklaydigan kichik fayl (faqat Namangan, 12 poligon)
 *   data/uzbekistan/namangan-districts.audit.json     — tekshiruv hisoboti (kod/nom moslik, geometriya, overlap/gap)
 *
 * Yangi versiya chiqqanda: skriptni qayta ishga tushirib, testlar (npm run test:district) va hisobotni ko'rib,
 * DISTRICT_BOUNDARIES_VERSION ni oshirib alohida commit qilinadi. Production o'z-o'zidan almashmaydi.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { BOUNDARY_DISTRICTS, BOUNDARY_SOURCE, NO_BOUNDARY_DISTRICTS, normalizeDistrictName } from '../src/constants/districtBoundaryMap.js';
import { DISTRICT_IDS } from '../src/constants/districts.js';
import { validateGeometry, pointInGeometry, bboxOf, inBbox } from '../src/lib/geo.js';

const arg = (n) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split('=').slice(1).join('=') || null;
const SRC = arg('src');
if (!SRC) { console.error('--src=<UZB_OSM_BORDER_LVL_3.geojson> kerak'); process.exit(2); }
const OUT = resolve(arg('out') || 'data/uzbekistan/namangan-districts.geojson');
const AUDIT = OUT.replace(/\.geojson$/, '.audit.json');
const VERSION = arg('version') || '1';
const PRECISION = 6;   // ≈ 0,1 m — fayl hajmi kamayadi, aniqlik yetarli

const raw = readFileSync(SRC);
const sha256 = createHash('sha256').update(raw).digest('hex');
const src = JSON.parse(raw.toString('utf8'));

const audit = {
  source: { ...BOUNDARY_SOURCE, commit: arg('commit') || null, sha256, features: src.features?.length ?? 0, crs: src.crs?.properties?.name || null },
  version: VERSION,
  ok: true,
  problems: [],
  districts: [],
  missing: [],
  noBoundary: NO_BOUNDARY_DISTRICTS,
  coverage: null,
};
const problem = (m) => { audit.ok = false; audit.problems.push(m); };

if (src.type !== 'FeatureCollection') problem(`FeatureCollection emas: ${src.type}`);
const crs = audit.source.crs;
if (crs && !/CRS84|4326/.test(crs)) problem(`CRS WGS84 emas: ${crs}`);

const region = (src.features || []).filter((f) => Number(f.properties?.obl_code) === BOUNDARY_SOURCE.regionCode);
const round = (n) => Math.round(n * 10 ** PRECISION) / 10 ** PRECISION;
const roundGeom = (g) => ({
  type: g.type,
  coordinates: g.type === 'Polygon'
    ? g.coordinates.map((r) => r.map(([x, y]) => [round(x), round(y)]))
    : g.coordinates.map((p) => p.map((r) => r.map(([x, y]) => [round(x), round(y)]))),
});

const out = [];
const seen = new Map();
for (const f of region) {
  const p = f.properties || {};
  const map = BOUNDARY_DISTRICTS.find((m) => m.code === Number(p.code));
  if (!map) { problem(`xaritada yo'q kod: ${p.code} (${p.name_en})`); continue; }
  if (seen.has(map.id)) { problem(`takror: ${map.id} (${p.code})`); continue; }
  // Nom ikkinchi tekshiruv: manbadagi nomlardan kamida bittasi jadvaldagisiga mos kelishi kerak
  const srcNames = [p.name_uz, p.name_ru, p.name_en].map(normalizeDistrictName);
  const okName = map.names.map(normalizeDistrictName).some((n) => srcNames.includes(n));
  if (!okName) problem(`nom mos emas: ${map.id} ↔ ${p.name_uz}/${p.name_ru}/${p.name_en}`);
  if (!DISTRICT_IDS.includes(map.id)) problem(`LokmaGo ro'yxatida yo'q kalit: ${map.id}`);
  const errs = validateGeometry(f.geometry);
  errs.forEach((e) => problem(`${map.id}: ${e}`));
  const g = roundGeom(f.geometry);
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  seen.set(map.id, true);
  audit.districts.push({
    id: map.id, code: Number(p.code), osmId: p.osm_id, name_uz: p.name_uz, name_ru: p.name_ru, name_en: p.name_en,
    type: g.type, polygons: polys.length, holes: polys.reduce((s, x) => s + x.length - 1, 0),
    points: polys.reduce((s, x) => s + x.reduce((t, r) => t + r.length, 0), 0), bbox: bboxOf(g).map(round),
    nameMatched: okName, geometryErrors: errs,
  });
  out.push({ type: 'Feature', properties: { lokmaDistrictId: map.id, code: Number(p.code), osmId: p.osm_id, name_uz: p.name_uz, name_ru: p.name_ru, name_en: p.name_en }, geometry: g });
}
audit.missing = DISTRICT_IDS.filter((id) => !seen.has(id));
const unexpected = audit.missing.filter((id) => !NO_BOUNDARY_DISTRICTS.includes(id));
if (unexpected.length) problem(`poligoni yo'q tumanlar: ${unexpected.join(', ')}`);

/*
 * QAMROV: viloyat (LVL_2) poligoni ichida ~400 m to'r bilan nuqtalar. Har nuqta nechta tuman ichida?
 *   0 — bo'shliq (gap), 2+ — ustma-ust (overlap). Chegara chizig'idagi nuqtalar ray-casting'da tasodifiy bo'lishi mumkin,
 *   shuning uchun kichik sonlar normal; katta son — ma'lumot muammosi.
 */
const regionPath = arg('region');
if (regionPath) {
  const l2 = JSON.parse(readFileSync(regionPath, 'utf8'));
  const reg = l2.features.find((f) => Number(f.properties?.code) === BOUNDARY_SOURCE.regionCode);
  if (!reg) problem('LVL_2 da viloyat topilmadi');
  else {
    const b = bboxOf(reg.geometry);
    const step = 0.004;   // ≈ 400 m
    const boxes = out.map((f) => ({ id: f.properties.lokmaDistrictId, g: f.geometry, b: bboxOf(f.geometry) }));
    let total = 0; let gaps = 0; let overlaps = 0;
    const overlapPairs = {}; const gapSamples = [];
    for (let y = b[1]; y <= b[3]; y += step) {
      for (let x = b[0]; x <= b[2]; x += step) {
        if (!pointInGeometry(x, y, reg.geometry)) continue;
        total += 1;
        const hits = boxes.filter((d) => inBbox(x, y, d.b) && pointInGeometry(x, y, d.g)).map((d) => d.id);
        if (!hits.length) { gaps += 1; if (gapSamples.length < 10) gapSamples.push([round(y), round(x)]); }
        if (hits.length > 1) { overlaps += 1; const k = hits.sort().join('+'); overlapPairs[k] = (overlapPairs[k] || 0) + 1; }
      }
    }
    audit.coverage = { gridMeters: 400, regionPoints: total, gaps, overlaps, overlapPairs, gapSamplesLatLng: gapSamples, gapPercent: total ? +(100 * gaps / total).toFixed(3) : null };
    if (total && gaps / total > 0.005) problem(`qamrovda bo'shliq ${audit.coverage.gapPercent}% (> 0,5%)`);
    if (overlaps > 0) problem(`ustma-ust hududlar: ${JSON.stringify(overlapPairs)}`);
  }
}

mkdirSync(dirname(OUT), { recursive: true });
const fc = {
  type: 'FeatureCollection',
  name: 'namangan-districts',
  crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:OGC:1.3:CRS84' } },
  metadata: { version: VERSION, source: BOUNDARY_SOURCE.repo, sourcePath: BOUNDARY_SOURCE.path, sourceCommit: audit.source.commit, sourceSha256: sha256, license: BOUNDARY_SOURCE.license, noBoundary: NO_BOUNDARY_DISTRICTS },
  features: out.sort((a, b) => a.properties.code - b.properties.code),
};
writeFileSync(OUT, `${JSON.stringify(fc)}\n`);
writeFileSync(AUDIT, `${JSON.stringify(audit, null, 2)}\n`);
console.log(`Yozildi: ${OUT} (${out.length} tuman), audit: ${AUDIT}`);
console.log(`Muammolar: ${audit.problems.length ? audit.problems.join(' | ') : "yo'q"}`);
if (audit.coverage) console.log(`Qamrov: ${audit.coverage.regionPoints} nuqta, bo'shliq ${audit.coverage.gaps} (${audit.coverage.gapPercent}%), ustma-ust ${audit.coverage.overlaps}`);
process.exit(audit.ok ? 0 : 1);
