/*
 * TUMAN CHEGARALARI: resolver, /location/resolve, /districts metadata, restoran hududi, katalog filtri, flag OFF = eski natija.
 * Baza kerak emas (modellar soxta). npm run test:district
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(40);
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { config } = await import('../src/config/index.js');
const R = await import('../src/services/districtResolver.js');
const { pointInGeometry, distanceToBoundaryMeters, bboxOf } = await import('../src/lib/geo.js');
const { computeServiceDistrict, toMongoUpdate } = await import('../src/services/restaurantDistrict.js');
const { catalogDistrict, withDistrict, districtKeySuffix } = await import('../src/services/catalogDistrict.js');
const { locationController } = await import('../src/controllers/location.js');
const { districtsController } = await import('../src/controllers/delivery.js');
const { DISTRICTS } = await import('../src/constants/districts.js');

let fails = 0;
const ok = (c, m) => { console.log(c ? '  ✓' : '  ✗ FAIL:', m); if (!c) fails += 1; };
const REAL = './data/uzbekistan/namangan-districts.geojson';
const enable = (o = {}) => Object.assign(config.district, { boundariesEnabled: true, boundariesPath: REAL, boundariesVersion: '1', catalogFilterEnabled: false, legacyPolicy: 'show', boundaryBufferMeters: 50, ...o });
const reload = () => { R._resetResolverForTests(); return R.loadBoundaries(); };
const call = (h, query) => new Promise((resolve) => {
  const res = { code: 200, headers: {}, status(c) { this.code = c; return this; }, set(k, v) { this.headers[k] = v; return this; }, json(b) { resolve({ code: this.code, body: b, headers: this.headers }); } };
  h({ query }, res, (e) => resolve({ error: e }));
});

console.log('\n[1] Flag O‘CHIQ — hech narsa o‘zgarmaydi');
Object.assign(config.district, { boundariesEnabled: false, catalogFilterEnabled: false });
reload();
ok(!R.isResolverAvailable(), 'resolver o‘chiq (DISABLED)');
{
  const r = await call(districtsController.list, {});
  ok(!('boundaries' in r.body) && r.body.districts === DISTRICTS && r.body.defaultDistrict === 'pop', '/districts javobi eski formatda (boundaries yo‘q)');
  const loc = await call(locationController.resolve, { lat: '40.87', lng: '71.10' });
  ok(loc.code === 503 && loc.body.error === 'DISTRICT_RESOLVER_UNAVAILABLE', '/location/resolve → 503 (boshqa API ishlaydi)');
  ok(catalogDistrict({ query: { district: 'pop' } }) === null, 'katalog: ?district=pop e‘tiborsiz');
  const f = { isActive: true }; ok(withDistrict(f, null) === f && !('$and' in f), 'filtr aynan o‘zgarmaydi');
  ok(districtKeySuffix(null) === '', 'kesh kaliti o‘zgarmaydi');
  ok(computeServiceDistrict({ lat: 40.87, lng: 71.1 }) === null, 'restoran hududi yozilmaydi');
}

console.log('\n[2] Haqiqiy Namangan chegaralari — har tuman ichidagi nuqta o‘z tumanini qaytaradi');
enable(); const st = reload();
ok(st.ok && st.features.length === 12, `yuklandi: ${st.features?.length} ta`);
for (const f of st.features) {
  // Poligon ichida chegaradan eng uzoq nuqta (to'r bo'yicha) — har tuman uchun ishonchli test nuqtasi
  const [x0, y0, x1, y1] = bboxOf(f.geometry);
  let best = null;
  for (let y = y0; y <= y1; y += (y1 - y0) / 40) for (let x = x0; x <= x1; x += (x1 - x0) / 40) {
    if (!pointInGeometry(x, y, f.geometry)) continue;
    const d = distanceToBoundaryMeters(x, y, f.geometry);
    if (!best || d > best.d) best = { x, y, d };
  }
  const r = R.resolveDistrict(best.y, best.x);
  ok(r.matched && r.districtId === f.id && r.boundaryVersion === '1', `${f.id}: ${r.districtId}`);
}
const known = { pop: [40.8736, 71.1085], chust: [41.0035, 71.2378], namangan_sh: [40.9983, 71.6726], kosonsoy: [41.2489, 71.5501] };
for (const [id, [lat, lng]] of Object.entries(known)) ok(R.resolveDistrict(lat, lng).districtId === id, `shahar markazi → ${id}`);
ok(R.resolveDistrict(41.31, 69.28).reason === 'OUTSIDE_COVERAGE', 'Toshkent → OUTSIDE_COVERAGE (Pop emas)');
ok(R.resolveDistrict(0, 0).reason === 'OUTSIDE_COVERAGE', '0,0 → OUTSIDE_COVERAGE');
ok(!R.supportedDistrictIds().includes('davlatobod') && !R.supportedDistrictIds().includes('yangi_namangan'), 'Davlatobod / Yangi Namangan — poligoni yo‘q, qo‘llab-quvvatlanmaydi');

console.log('\n[3] Pop/Chust chegarasi: bufer ichida — BOUNDARY_UNCERTAIN; uzoqda — aniq');
{
  // Chegara nuqtasini topish: Pop markazidan Chust markaziga chiziq bo'ylab, tuman almashadigan joy
  const [a, b] = [known.pop, known.chust];
  let prev = 'pop'; let edge = null;
  for (let i = 1; i <= 2000; i += 1) {
    const t = i / 2000; const lat = a[0] + (b[0] - a[0]) * t; const lng = a[1] + (b[1] - a[1]) * t;
    const r = R.resolveDistrict(lat, lng, { bufferMeters: 0 });
    if (r.districtId && r.districtId !== prev) { edge = { lat, lng }; break; }
    if (r.districtId) prev = r.districtId;
  }
  ok(!!edge, 'Pop→Chust chegarasi topildi');
  const near = R.resolveDistrict(edge.lat, edge.lng, { bufferMeters: 50 });
  ok(near.reason === 'BOUNDARY_UNCERTAIN', `chegarada → ${near.reason || near.districtId}`);
  const deep = R.resolveDistrict(edge.lat + (b[0] - a[0]) * 0.05, edge.lng + (b[1] - a[1]) * 0.05);
  ok(deep.districtId === 'chust', `chegaradan ~1 km ichkarida → ${deep.districtId}`);
  ok(R.resolveRestaurantDistrict(edge.lat + (b[0] - a[0]) * 0.002, edge.lng + (b[1] - a[1]) * 0.002).districtId === 'chust', 'restoran uchun bufer yo‘q (chegara yonida ham aniq tuman)');
}

console.log('\n[4] Sun‘iy poligonlar: teshik (hole), MultiPolygon, ustma-ust, tashqi chekka');
{
  const dir = mkdtempSync(join(tmpdir(), 'dist-'));
  const sq = (x, y, s) => [[x, y], [x + s, y], [x + s, y + s], [x, y + s], [x, y]];
  const fc = { type: 'FeatureCollection', metadata: { version: 't1' }, features: [
    { type: 'Feature', properties: { lokmaDistrictId: 'pop' }, geometry: { type: 'Polygon', coordinates: [sq(0, 0, 1), sq(0.4, 0.4, 0.2)] } },
    { type: 'Feature', properties: { lokmaDistrictId: 'chust' }, geometry: { type: 'Polygon', coordinates: [sq(1, 0, 1)] } },
    { type: 'Feature', properties: { lokmaDistrictId: 'kosonsoy' }, geometry: { type: 'MultiPolygon', coordinates: [[sq(5, 5, 1)], [sq(7, 7, 1)]] } },
    { type: 'Feature', properties: { lokmaDistrictId: 'norin' }, geometry: { type: 'Polygon', coordinates: [sq(10, 10, 1)] } },
    { type: 'Feature', properties: { lokmaDistrictId: 'uychi' }, geometry: { type: 'Polygon', coordinates: [sq(10.5, 10, 1)] } },
  ] };
  const p = join(dir, 'b.geojson'); writeFileSync(p, JSON.stringify(fc));
  enable({ boundariesPath: p, boundariesVersion: 't1' }); reload();
  ok(R.resolveDistrict(0.2, 0.2).districtId === 'pop', 'Polygon ichida');
  ok(R.resolveDistrict(0.5, 0.5).reason === 'OUTSIDE_COVERAGE', 'teshik (hole) ichida → tashqarida');
  ok(R.resolveDistrict(7.5, 7.5).districtId === 'kosonsoy' && R.resolveDistrict(5.5, 5.5).districtId === 'kosonsoy', 'MultiPolygon ikkala qismi');
  ok(R.resolveDistrict(10.5, 10.7).reason === 'BOUNDARY_UNCERTAIN', 'ustma-ust (2 poligon) → BOUNDARY_UNCERTAIN');
  ok(R.resolveDistrict(0.5, 0.99995).reason === 'BOUNDARY_UNCERTAIN', 'Pop|Chust chegarasidan ~5 m → noaniq');
  ok(R.resolveDistrict(0.5, 0.0001).districtId === 'pop', 'tashqi chekka (yonida boshqa tuman yo‘q) → aniq');
  ok(R.resolveDistrict(0.5, -0.0002).reason === 'BOUNDARY_UNCERTAIN', 'qamrovdan ~20 m tashqarida → noaniq (GPS xatosi bo‘lishi mumkin)');
  ok(R.resolveDistrict(3, 3).reason === 'OUTSIDE_COVERAGE', 'uzoqda → OUTSIDE_COVERAGE');

  console.log('\n[5] Buzuq/yo‘q fayl, versiya mos emas — server yiqilmaydi, funksiya o‘chiq');
  writeFileSync(join(dir, 'bad.geojson'), '{"type":"FeatureCollection","features":[{"properties":{"lokmaDistrictId":"zzz"},"geometry":{"type":"Polygon","coordinates":[]}}]}');
  enable({ boundariesPath: join(dir, 'bad.geojson') }); ok(!reload().ok, 'noma‘lum tuman — o‘chiq');
  writeFileSync(join(dir, 'broken.geojson'), '{not json');
  enable({ boundariesPath: join(dir, 'broken.geojson') }); ok(!reload().ok && R.resolveDistrict(1, 1).reason === 'UNAVAILABLE', 'JSON buzuq — UNAVAILABLE');
  enable({ boundariesPath: join(dir, 'nope.geojson') }); ok(!reload().ok, 'fayl yo‘q — o‘chiq');
  enable({ boundariesPath: p, boundariesVersion: '2' }); ok(/VERSION_MISMATCH/.test(reload().reason), 'fayl versiyasi sozlamadan farq qiladi — ishlatilmaydi');
}

console.log('\n[6] /location/resolve — kontrakt va validatsiya');
enable(); reload();
{
  const r = await call(locationController.resolve, { lat: '41.0035', lng: '71.2378' });
  ok(r.code === 200 && r.body.success === true && r.body.data.districtId === 'chust' && r.body.data.matched === true && r.body.data.boundaryVersion === '1' && r.body.data.districtName === 'Chust tumani', 'Chust → kontrakt');
  ok(r.headers['Cache-Control'] === 'no-store', 'keshlanmaydi');
  const out = await call(locationController.resolve, { lat: '41.31', lng: '69.28' });
  ok(out.body.data.matched === false && out.body.data.districtId === null && out.body.data.reason === 'OUTSIDE_COVERAGE', 'tashqarida → OUTSIDE_COVERAGE');
  for (const q of [{ lat: '91', lng: '71' }, { lat: '40', lng: '181' }, { lat: 'abc', lng: '71' }, { lat: '40' }, { lat: ['40'], lng: '71' }, { lat: '1e3', lng: '71' }, { lat: 'Infinity', lng: '1' }]) {
    const x = await call(locationController.resolve, q);
    ok(x.code === 400, `400: ${JSON.stringify(q)}`);
  }
  const ru = await call(locationController.resolve, { lat: '40.8736', lng: '71.1085', lang: 'ru' });
  ok(ru.body.data.districtName === 'Папский район', 'til: ru');
  const d = await call(districtsController.list, {});
  ok(d.body.boundaries?.supported?.length === 12 && d.body.boundaries.autoDetect.minAccuracyMeters === 50 && d.body.districts === DISTRICTS, '/districts: ixtiyoriy metadata qo‘shildi, asosiy maydonlar o‘zgarmagan');
}

console.log('\n[7] Restoran katalog hududi — kuryer tumaniga tegmaydi, Pop‘ga tushirilmaydi');
{
  const rest = { lat: 41.0035, lng: 71.2378, district: 'pop' };
  const r = computeServiceDistrict(rest);
  ok(r.set.serviceDistrictId === 'chust' && JSON.stringify(r.set.serviceAreaDistrictIds) === '["chust"]', 'Chust koordinatasi → serviceDistrictId=chust, hudud [chust]');
  ok(!('district' in r.set) && rest.district === 'pop', 'kuryer tumani (district) o‘zgartirilmaydi');
  const noCoords = computeServiceDistrict({ lat: null, lng: null });
  ok(noCoords.set.serviceDistrictId === null && noCoords.set.districtResolveReason === 'NO_COORDINATES', 'koordinatasiz → null (Pop emas)');
  ok(computeServiceDistrict({ lat: 0, lng: 0 }).set.districtResolveReason === 'NO_COORDINATES', '0,0 — koordinata yo‘q deb hisoblanadi');
  ok(computeServiceDistrict({ lat: 41.31, lng: 69.28 }).set.districtResolveReason === 'OUTSIDE_COVERAGE', 'Toshkent → OUTSIDE_COVERAGE');
  const area = computeServiceDistrict({ lat: 40.8736, lng: 71.1085 }, { area: ['chust', 'zzz', 'davlatobod', 'chust'] });
  ok(JSON.stringify(area.set.serviceAreaDistrictIds) === '["pop","chust"]', `hudud tozalanadi, o‘z tumani doim ichida: ${area.set.serviceAreaDistrictIds}`);
  const moved = computeServiceDistrict({ lat: 40.8736, lng: 71.1085, serviceDistrictId: 'chust', serviceAreaDistrictIds: ['chust', 'kosonsoy'] });
  ok(JSON.stringify(moved.set.serviceAreaDistrictIds) === '["pop","kosonsoy"]', 'koordinata o‘zgarsa: eski avtomatik tuman almashadi, admin qo‘shgani qoladi');
  const ov = computeServiceDistrict({ lat: 40.8736, lng: 71.1085, serviceDistrictOverride: { districtId: 'davlatobod', reason: 'x' } });
  ok(ov.set.serviceDistrictId === 'davlatobod', 'bosh admin override koordinatadan ustun');
  const same = computeServiceDistrict({ lat: 40.8736, lng: 71.1085, serviceDistrictId: 'pop', serviceAreaDistrictIds: ['pop'], districtResolveReason: null });
  ok(same.changed === false && toMongoUpdate(same).$push === undefined, 'o‘zgarmasa audit yozilmaydi');
  ok(toMongoUpdate(r).$push.districtAudit.$slice === -50, 'audit oxirgi 50 ta bilan cheklangan');
}

console.log('\n[8] Katalog filtri — yoqilganda; kesh izolyatsiyasi');
{
  enable({ catalogFilterEnabled: true }); reload();
  ok(catalogDistrict({ query: { district: 'chust' } }) === 'chust', 'yaroqli tuman');
  ok(catalogDistrict({ query: { district: 'davlatobod' } }) === null && catalogDistrict({ query: { district: { $ne: 1 } } }) === null && catalogDistrict({ query: {} }) === null, 'poligonsiz / operator-in‘eksiya / yo‘q → filtrsiz');
  const f = withDistrict({ isActive: true }, 'chust');
  const or = f.$and[0].$or;
  ok(or.some((c) => c.serviceDistrictId === 'chust') && or.some((c) => c.serviceAreaDistrictIds === 'chust') && or.some((c) => c.serviceDistrictId?.$exists === false), 'serviceDistrictId | serviceAreaDistrictIds | eski (show)');
  config.district.legacyPolicy = 'hide';
  ok(!withDistrict({}, 'chust').$and[0].$or.some((c) => c.serviceDistrictId?.$exists === false), 'hide: eski restoranlar chiqmaydi');
  config.district.legacyPolicy = 'show';
  ok(districtKeySuffix('pop') !== districtKeySuffix('chust') && districtKeySuffix('pop') === ':d=pop', 'Pop va Chust kesh kalitlari alohida');

  // Haqiqiy restaurantController.list: soxta Restaurant.find filtrni ushlaydi
  const { Restaurant } = await import('../src/models/Restaurant.js');
  const { restaurantController, dishController } = await import('../src/controllers/catalog.js');
  const seen = [];
  const chain = (rows) => { const c = { select: () => c, sort: () => c, limit: () => c, lean: async () => rows }; return c; };
  Restaurant.find = (filter) => { seen.push(JSON.parse(JSON.stringify(filter))); return chain([]); };
  const run = (h, query) => new Promise((resolve) => h({ query }, { json: resolve, set() { return this; }, status() { return this; } }, resolve));
  await run(restaurantController.list, { limit: '5' });
  const plain = JSON.stringify(seen.at(-1));
  await run(restaurantController.list, { limit: '5', district: 'chust' });
  ok(JSON.stringify(seen.at(-1)).includes('"serviceDistrictId":"chust"') && !plain.includes('serviceDistrictId'), 'restoranlar ro‘yxati: district bo‘lsa filtr, bo‘lmasa eski filtr');
  for (const h of ['trending', 'discounted', 'all']) {
    await run(dishController[h], { district: 'pop' });
    ok(JSON.stringify(seen.at(-1)).includes('"serviceDistrictId":"pop"'), `dishes/${h}: restoran ID'lari tuman bo'yicha`);
    await run(dishController[h], {});
    ok(!JSON.stringify(seen.at(-1)).includes('serviceDistrictId'), `dishes/${h}: districtsiz — eski filtr`);
  }
  Object.assign(config.district, { catalogFilterEnabled: false });
  await run(restaurantController.list, { limit: '5', district: 'chust' });
  ok(JSON.stringify(seen.at(-1)) === plain, 'flag o‘chiq: ?district= bo‘lsa ham filtr eski');
}

console.log(fails ? `\n✗ ${fails} ta xato` : '\n✓ HAMMASI O‘TDI');
process.exit(fails ? 1 : 0);
