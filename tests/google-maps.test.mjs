/*
 * Google Maps (server): polyline dekoder, Routes/Directions, Geocoding (+kesh), /api/maps/* kontrollerlari.
 * Soxta fetch; baza KERAK EMAS.   npm run test:google-maps
 */
process.env.JWT_SECRET = 'x'.repeat(40); process.env.NODE_ENV = 'development';
const { config } = await import('../src/config/index.js');
const G = await import('../src/services/googleMaps.js');
const { mapsController } = await import('../src/controllers/maps.js');
const { routeBetween } = await import('../src/services/routeGeometry.js');
let fails = 0;
const ok = (c, m) => { console.log(c ? '  ✓' : '  ✗ XATO:', m); if (!c) fails++; };
const realFetch = globalThis.fetch;
const KEY = 'srv-key-123';
const close = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
const same = (p, q) => p.length === q.length && p.every((x, i) => close(x[0], q[i][0]) && close(x[1], q[i][1]));

/** Sinov uchun enkoder (Google "Encoded Polyline Algorithm") — dekoderni ikki tomonlama tekshiradi */
function encode(pts) {
  let pl = 0; let pg = 0; let out = '';
  const e = (v) => { let n = v < 0 ? ~(v << 1) : v << 1; let s = ''; while (n >= 0x20) { s += String.fromCharCode((0x20 | (n & 0x1f)) + 63); n >>= 5; } return s + String.fromCharCode(n + 63); };
  for (const [la, lo] of pts) { const a = Math.round(la * 1e5); const b = Math.round(lo * 1e5); out += e(a - pl) + e(b - pg); pl = a; pg = b; }
  return out;
}
let calls = [];
const fetchWith = (fn) => { calls = []; globalThis.fetch = async (url, init = {}) => { calls.push({ url: String(url), init }); return fn(String(url), init); }; };
const resp = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const call = async (handler, query) => {
  let status = 200; let body = null;
  const res = { status(c) { status = c; return this; }, json(b) { body = b; return this; } };
  await handler({ query }, res, (e) => { status = 500; body = { next: e?.message }; });
  await new Promise((r) => setTimeout(r, 30));   // asyncHandler promise qaytarmaydi — javob kelishini kutamiz
  return { status, body };
};

console.log('\n[1] Polyline dekoder');
ok(same(G.decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@'), [[38.5, -120.2], [40.7, -120.95], [43.252, -126.453]]), 'Google hujjatidagi rasmiy namuna: 3 nuqta (manfiy uzunlik ham)');
ok(G.decodePolyline('').length === 0 && G.decodePolyline(null).length === 0 && G.decodePolyline(undefined).length === 0, 'bo‘sh/null → bo‘sh ro‘yxat, xato yo‘q');
{
  const pts = [[41.311081, 69.240562], [41.31102, 69.24101], [41.3087, 69.2466], [41.2995, 69.2401], [-33.86785, 151.20732], [0, 0], [-0.00001, -0.00001]];
  const back = G.decodePolyline(encode(pts));
  ok(same(back.map((p) => p.map((v) => Math.round(v * 1e5) / 1e5)), pts.map((p) => p.map((v) => Math.round(v * 1e5) / 1e5))), 'enkoder → dekoder aylanishi: Toshkent, Sidney (janub/sharq), nol, kichik manfiy — aynan qaytadi');
  const long = Array.from({ length: 3000 }, (_, i) => [41 + i * 0.0001, 69 + Math.sin(i / 50) * 0.01]);
  ok(G.decodePolyline(encode(long)).length === 3000, '3000 nuqtali uzun yo‘l buzilmaydi');
}

console.log('\n[2] Kalit va til');
config.google.apiKey = '';
ok(G.hasGoogleKey() === false, 'kalit yo‘q → hasGoogleKey false');
ok(G.googleLang('ru') === 'ru' && G.googleLang('ru-RU') === 'ru' && G.googleLang('uz') === 'uz' && G.googleLang('uzc') === 'uz' && G.googleLang(undefined) === 'uz' && G.googleLang('en') === 'uz', 'til: ru → ru, qolgani → uz (lotin)');
{
  fetchWith(() => resp({}));
  ok(await G.googleRoute({ lat: 1, lng: 1 }, { lat: 2, lng: 2 }) === null && calls.length === 0, 'kalit yo‘q: googleRoute null va hech qanday so‘rov yo‘q');
  ok(await G.googleReverse(41.3, 69.2) === null && await G.googleGeocode('Toshkent') === null && calls.length === 0, 'kalit yo‘q: reverse/geocode null, so‘rov yo‘q');
}
config.google.apiKey = KEY;

console.log('\n[3] googleRoute: tirbandlik rejimi va javob tahlili');
{
  fetchWith(() => resp({ routes: [{ distanceMeters: 4200, duration: '615s', polyline: { encodedPolyline: 'abc' } }] }));
  const withTraffic = await G.googleRoute({ lat: 41.3, lng: 69.2 }, { lat: 41.31, lng: 69.25 }, { traffic: true });
  ok(JSON.parse(calls[0].init.body).routingPreference === 'TRAFFIC_AWARE', 'traffic:true → TRAFFIC_AWARE (mijozga vaqt tirbandlik bilan)');
  ok(withTraffic.meters === 4200 && withTraffic.seconds === 615 && withTraffic.encoded === 'abc', 'metr, soniya ("615s"), polyline');
  await G.googleRoute({ lat: 41.3, lng: 69.2 }, { lat: 41.31, lng: 69.25 });
  ok(JSON.parse(calls[1].init.body).routingPreference === 'TRAFFIC_UNAWARE', 'standart → TRAFFIC_UNAWARE');
  fetchWith(() => resp({ routes: [{ distanceMeters: 100 }] }));
  const noDur = await G.googleRoute({ lat: 1, lng: 1 }, { lat: 1.001, lng: 1 });
  ok(noDur.meters === 100 && noDur.seconds === null && noDur.encoded === '', 'duration/polyline yo‘q: masofa bor, vaqt null (to‘qib chiqarilmaydi)');
  fetchWith((u) => (u.includes('routes.googleapis.com') ? resp({}, 403) : resp({ status: 'OK', routes: [{ legs: [{ distance: { value: 900 }, duration: { value: 120 }, duration_in_traffic: { value: 150 } }], overview_polyline: { points: 'xyz' } }] })));
  const legacy = await G.googleRoute({ lat: 1, lng: 1 }, { lat: 1.001, lng: 1 });
  ok(legacy.meters === 900 && legacy.seconds === 150 && legacy.encoded === 'xyz', 'Routes 403 → Directions (legacy): masofa, tirbandlikli vaqt, polyline');
  fetchWith(() => { throw new TypeError('fetch failed'); });
  ok(await G.googleRoute({ lat: 1, lng: 1 }, { lat: 2, lng: 2 }) === null, 'tarmoq xatosi → null (xato otilmaydi)');
}

console.log('\n[4] Reverse geocode');
const rev = (over = {}) => ({ status: 'OK', results: [{ formatted_address: 'Chilonzor ko‘chasi 5, Toshkent, Oʻzbekiston', types: ['street_address'], address_components: [
  { long_name: '5', types: ['street_number'] }, { long_name: 'Chilonzor ko‘chasi', types: ['route'] }, { long_name: 'Toshkent', types: ['locality', 'political'] }, { long_name: 'Oʻzbekiston', types: ['country'] }] }], ...over });
{
  fetchWith(() => resp(rev()));
  const r = await G.googleReverse(41.2995, 69.2401, 'uz');
  ok(r.street === 'Chilonzor ko‘chasi, 5' && r.city === 'Toshkent' && r.address.startsWith('Chilonzor'), `tarkibiy qismlar: street="${r.street}", city="${r.city}"`);
  const u = new URL(calls[0].url);
  ok(u.origin + u.pathname === 'https://maps.googleapis.com/maps/api/geocode/json' && u.searchParams.get('latlng') === '41.2995,69.2401' && u.searchParams.get('language') === 'uz' && u.searchParams.get('key') === KEY, 'URL: latlng, language=uz, key');
  await G.googleReverse(41.2995, 69.2401, 'uz');
  ok(calls.length === 1, 'kesh: bir xil nuqta ikkinchi marta Google ga bormadi (pul tejaladi)');
  await G.googleReverse(41.2995, 69.2401, 'ru');
  ok(calls.length === 2 && new URL(calls[1].url).searchParams.get('language') === 'ru', 'til boshqa — alohida so‘rov (ru)');
}
{
  fetchWith(() => resp({ status: 'OK', results: [{ formatted_address: 'Q8WJ+H5 Toshkent', types: ['plus_code'], address_components: [] }, ...rev().results] }));
  const r = await G.googleReverse(41.1, 69.1);
  ok(r.street === 'Chilonzor ko‘chasi, 5', 'plus-kod ("Q8WJ+H5") manzil sifatida olinmaydi — keyingi haqiqiy natija');
  fetchWith(() => resp({ status: 'OK', results: [{ formatted_address: 'Yunusobod, Toshkent', types: ['sublocality'], address_components: [{ long_name: 'Yunusobod tumani', types: ['sublocality_level_1'] }, { long_name: 'Toshkent', types: ['administrative_area_level_1'] }] }] }));
  const r2 = await G.googleReverse(41.4, 69.4);
  ok(r2.street === 'Yunusobod tumani' && r2.city === 'Toshkent', 'ko‘cha yo‘q: mahalla/tuman va viloyat/shahar zaxirasi');
  fetchWith(() => resp({ status: 'ZERO_RESULTS', results: [] }));
  ok(await G.googleReverse(10, 10) === null, 'ZERO_RESULTS → null');
  await G.googleReverse(10, 10); ok(calls.length === 1, 'ZERO_RESULTS keshlanadi (bo‘sh joy qayta-qayta to‘lanmaydi)');
  fetchWith(() => resp({ status: 'REQUEST_DENIED', results: [] }));
  ok(await G.googleReverse(20, 20) === null, 'REQUEST_DENIED (kalit/ruxsat xatosi) → null');
  await G.googleReverse(20, 20); ok(calls.length === 2, 'xato javoblar KESHLANMAYDI (kalit tuzatilgach darhol ishlaydi)');
  fetchWith(() => resp({}, 500)); ok(await G.googleReverse(30, 30) === null, '500 → null');
  fetchWith(() => { throw new Error('timeout'); }); ok(await G.googleReverse(31, 31) === null, 'timeout → null');
}

console.log('\n[5] Forward geocode (O‘zbekiston bilan cheklangan)');
{
  fetchWith(() => resp({ status: 'OK', results: [
    { formatted_address: 'Amir Temur ko‘chasi, Toshkent', geometry: { location: { lat: 41.31, lng: 69.28 } } },
    { formatted_address: 'Noto‘g‘ri nuqta', geometry: {} },
    ...Array.from({ length: 6 }, (_, i) => ({ formatted_address: `Joy ${i}`, geometry: { location: { lat: 41 + i, lng: 69 } } })),
  ] }));
  const out = await G.googleGeocode('Amir Temur', 'uz');
  const u = new URL(calls[0].url);
  ok(u.searchParams.get('components') === 'country:UZ' && u.searchParams.get('region') === 'uz' && u.searchParams.get('address') === 'Amir Temur', 'components=country:UZ, region=uz, address');
  ok(out.length <= 5 && out[0].name.startsWith('Amir Temur') && out[0].lat === 41.31 && out.every((r) => Number.isFinite(r.lat) && Number.isFinite(r.lng)), `${out.length} ta natija, koordinatasizlari tashlandi, ≤ 5`);
  await G.googleGeocode('amir temur', 'uz'); ok(calls.length === 1, 'kesh (katta-kichik harf farqsiz)');
  fetchWith(() => resp({ status: 'OVER_QUERY_LIMIT' })); ok(await G.googleGeocode('boshqa joy') === null, 'OVER_QUERY_LIMIT → null (502 beriladi)');
}

console.log('\n[6] Kontrollerlar: /maps/config, /geocode, /reverse, /route');
{
  config.google.browserKey = '';
  let r = await call(mapsController.config, {});
  ok(r.body.provider === 'google' && r.body.enabled === false && r.body.mapsKey === '', 'brauzer kaliti yo‘q → enabled:false (server kaliti SIZMAYDI)');
  config.google.browserKey = 'browser-key-xyz';
  r = await call(mapsController.config, {});
  ok(r.body.enabled === true && r.body.mapsKey === 'browser-key-xyz' && !JSON.stringify(r.body).includes(KEY), 'brauzer kaliti beriladi, SERVER kaliti hech qachon');

  config.google.apiKey = '';
  r = await call(mapsController.geocode, { q: 'Toshkent' }); ok(r.status === 503, 'geocode: server kaliti yo‘q → 503');
  r = await call(mapsController.reverse, { lat: '41.3', lng: '69.2' }); ok(r.status === 200 && r.body.address === '' && r.body.street === '', 'reverse: kalit yo‘q → bo‘sh manzil (xarita baribir ishlaydi)');
  config.google.apiKey = KEY;
  r = await call(mapsController.geocode, { q: '  ' }); ok(r.status === 400, 'geocode: bo‘sh so‘rov → 400');
  fetchWith(() => resp({ status: 'REQUEST_DENIED' })); r = await call(mapsController.geocode, { q: 'x' }); ok(r.status === 502, 'geocode: Google xatosi → 502');
  r = await call(mapsController.reverse, { lat: 'abc', lng: '1' }); ok(r.status === 400, 'reverse: noto‘g‘ri koordinata → 400');
  fetchWith(() => resp(rev())); r = await call(mapsController.reverse, { lat: '41.5', lng: '69.5', lang: 'uz' });
  ok(r.body.street === 'Chilonzor ko‘chasi, 5' && r.body.city === 'Toshkent' && r.body.address, 'reverse: { address, street, city }');

  const q = (o = {}) => ({ fromLat: '41.31', fromLng: '69.24', toLat: '41.304', toLng: '69.25', ...o });
  r = await call(mapsController.route, q({ fromLat: 'x' })); ok(r.status === 400, 'route: noto‘g‘ri koordinata → 400');
  r = await call(mapsController.route, q({ toLat: '55', toLng: '37' })); ok(r.status === 400, 'route: hududdan tashqari (Moskva) → 400 (pullik so‘rov suiiste’molidan himoya)');
  r = await call(mapsController.route, q({ fromLat: '37.33', fromLng: '-122.03' })); ok(r.status === 400, 'route: AQSH → 400');
  const gp = [[41.31, 69.24], [41.307, 69.245], [41.304, 69.25]];
  fetchWith(() => resp({ routes: [{ distanceMeters: 1850, duration: '372s', polyline: { encodedPolyline: encode(gp) } }] }));
  r = await call(mapsController.route, q({ fromLat: '41.3101', fromLng: '69.2401' }));
  ok(r.status === 200 && r.body.source === 'google' && r.body.points.length === 3 && r.body.distanceM === 1850 && r.body.distanceKm === 1.85 && r.body.durationMin === 7 && r.body.durationS === 372, 'route: Google — nuqtalar, 1.85 km, 372 s (7 daqiqa)');
  fetchWith(() => { throw new Error('net'); });
  r = await call(mapsController.route, q({ fromLat: '41.5', fromLng: '69.5' }));
  ok(r.status === 200 && r.body.source === 'straight' && r.body.distanceKm === null && r.body.durationMin === null, 'route: hech narsa ishlamasa — source:"straight", raqamlar null (mijoz soxta ma’lumot ko‘rsatmaydi)');
}

console.log('\n[7] routeBetween: Google > OSRM, kesh');
{
  let n = 0;
  fetchWith((u) => { n++; return u.includes('routes.googleapis.com') ? resp({ routes: [{ distanceMeters: 1000, duration: '100s', polyline: { encodedPolyline: encode(gp2()) } }] }) : resp({}, 500); });
  function gp2() { return [[41.2, 69.1], [41.21, 69.11]]; }
  const a = { lat: 41.2, lng: 69.1 }; const b = { lat: 41.21, lng: 69.11 };
  const x = await routeBetween(a, b); const y = await routeBetween(a, b);
  ok(x.source === 'google' && y === x && n === 1, 'Google natijasi keshlandi (3 daqiqa), ikkinchi so‘rov tashqariga chiqmadi');
}

globalThis.fetch = realFetch;
console.log(fails ? `\n✗ ${fails} ta xato` : '\n✓ Hammasi o‘tdi');
process.exit(fails ? 1 : 0);
