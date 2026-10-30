/*
 * roadDistanceKm — Google Routes API (`distanceMeters`) ni to'g'ri o'qish va BARCHA xato holatlarida zaxira (haversine × 1.3).
 * Zaxira: Routes API ishlamasa — eski Directions API; ikkalasi ham bo'lmasa — to'g'ri chiziq × 1.3.
 * Soxta fetch; baza KERAK EMAS.   npm run test:road-distance
 */
process.env.JWT_SECRET = 'x'.repeat(40); process.env.NODE_ENV = 'development';
const { config } = await import('../src/config/index.js');
const { roadDistanceKm, haversineKm, calcDeliveryPrice, quoteDelivery } = await import('../src/services/deliveryEngine.js');

let fails = 0;
const ok = (c, m) => { console.log(c ? '  ✓' : '  ✗ XATO:', m); if (!c) fails++; };
const realFetch = globalThis.fetch;
const KEY = 'test-server-key';
const setKey = (k) => { config.google.apiKey = k; };
const fallback = (a, b) => Math.round(haversineKm(a, b) * 1.3 * 10) / 10;   // zaxira formulasi (o'zgarmagan)

// Har sinov uchun BOSHQA koordinata (marshrut keshi koordinata bo'yicha ishlaydi)
let seq = 0;
const pair = (straightDeg = 0.0087) => { seq += 1; const lat = 41.30 + seq * 0.01; return [{ lat, lng: 69.24 }, { lat: lat + straightDeg, lng: 69.24 }]; };

/**
 * Google javoblarini soxtalashtiradi. routes — Routes API (POST), directions — eski Directions API (GET).
 * Qaytaradi: { calls: [{ url, method, headers, body }], jsonCalled }
 */
function mock({ routes = null, directions = null }) {
  const st = { calls: [], jsonCalled: false };
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    st.calls.push({ url: u, method: init.method || 'GET', headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : null });
    const spec = u.includes('routes.googleapis.com') ? routes : directions;
    if (!spec) return { ok: false, status: 403, json: async () => { st.jsonCalled = true; return { error: { status: 'PERMISSION_DENIED' } }; } };
    if (spec.rejects) throw spec.rejects;
    const status = spec.status ?? 200;
    return { ok: status >= 200 && status < 300, status, json: async () => { st.jsonCalled = true; if (spec.jsonThrows) throw new SyntaxError('Unexpected token <'); return spec.body ?? {}; } };
  };
  return st;
}
const routesBody = (meters, dur = '206s', enc = 'abc') => ({ routes: [{ distanceMeters: meters, duration: dur, polyline: { encodedPolyline: enc } }] });
const dirBody = (meters, secs = 200, status = 'OK') => ({ status, routes: [{ legs: [{ distance: { value: meters }, duration: { value: secs } }], overview_polyline: { points: 'abc' } }] });

console.log('\n[1] Routes API: distanceMeters — SON (metr)');
setKey(KEY);
{
  const [a, b] = pair(0.0087);            // to'g'ri chiziq ~0.97 km → zaxira 1.3 km
  const st = mock({ routes: { body: routesBody(1116) } });
  const km = await roadDistanceKm(a, b);
  ok(km === 1.1, `1116 m → ${km} km (yo'l masofasi, round(km*10)/10)`);
  ok(km !== fallback(a, b), `zaxira (${fallback(a, b)} km) ISHLATILMADI — Google qiymati olindi`);
  const c = st.calls[0];
  ok(st.calls.length === 1 && c.method === 'POST' && c.url === 'https://routes.googleapis.com/directions/v2:computeRoutes', 'Routes API ga BITTA POST so‘rov');
  ok(c.headers['X-Goog-Api-Key'] === KEY && /distanceMeters/.test(c.headers['X-Goog-FieldMask']), 'kalit sarlavhada, FieldMask: faqat kerakli maydonlar');
  ok(c.body.origin.location.latLng.latitude === a.lat && c.body.destination.location.latLng.longitude === b.lng && c.body.travelMode === 'DRIVE', 'boshlanish/oxirgi nuqta va DRIVE rejimi');
  ok(c.body.routingPreference === 'TRAFFIC_UNAWARE', 'narx uchun TIRBANDLIKSIZ (barqaror masofa)');
  ok(!c.url.includes('key='), 'kalit URL ga yozilmadi (jurnal/proksilarda ko‘rinmasin)');
  await roadDistanceKm(a, b);
  ok(st.calls.length === 1, 'kesh ishlaydi: ikkinchi chaqiruv Google ga bormadi');
}
{
  const [a, b] = pair(0.0087);
  mock({ routes: { body: routesBody(3883) } });
  ok(await roadDistanceKm(a, b) === 3.9, '3883 m → 3.9 km');
}

console.log('\n[2] Routes API ishlamasa — eski Directions API zaxirasi; keyin to‘g‘ri chiziq');
{
  const [a, b] = pair(0.0087);
  const st = mock({ routes: { status: 403, body: { error: { status: 'PERMISSION_DENIED' } } }, directions: { body: dirBody(2500) } });
  const km = await roadDistanceKm(a, b);
  ok(km === 2.5, `Routes API yoqilmagan (403) → Directions API: ${km} km`);
  ok(st.calls.length === 2 && st.calls[1].url.includes('maps.googleapis.com/maps/api/directions/json') && st.calls[1].url.includes('key=' + KEY) && st.calls[1].url.includes('mode=driving'), 'ikkinchi so‘rov Directions API ga (origin/destination/mode/key)');
}
{
  const [a, b] = pair();
  mock({ routes: { status: 403, body: {} }, directions: { body: dirBody(1000, 100, 'REQUEST_DENIED') } });
  ok(await roadDistanceKm(a, b) === fallback(a, b), 'Directions status != OK (REQUEST_DENIED) → zaxira');
}

console.log('\n[3] Noto‘g‘ri/bo‘sh javoblar — xavfsiz zaxira, xato otilmaydi');
{
  const cases = [
    ['marshrutlar bo‘sh', { routes: { body: { routes: [] } } }],
    ['distanceMeters yo‘q', { routes: { body: { routes: [{ duration: '10s' }] } } }],
    ['distanceMeters = 0', { routes: { body: routesBody(0) } }],
    ['distanceMeters matn emas', { routes: { body: { routes: [{ distanceMeters: 'abc' }] } } }],
    ['bo‘sh javob ({})', { routes: { body: {} } }],
  ];
  for (const [name, spec] of cases) {
    const [a, b] = pair(); mock(spec);
    let km; let threw = false;
    try { km = await roadDistanceKm(a, b); } catch { threw = true; }
    ok(!threw && km === fallback(a, b), `${name} → zaxira ${km} km`);
  }
}

console.log("\n[4] Kalit yo'q / 401 / 429 / 5xx / timeout / buzuq JSON — zaxira o'zgarmagan");
{
  setKey('');
  const [a, b] = pair(); const st = mock({ routes: { body: routesBody(5000) } });
  ok(await roadDistanceKm(a, b) === fallback(a, b) && st.calls.length === 0, "kalit yo'q: so'rov UMUMAN yuborilmaydi, haversine*1.3");
  setKey(KEY);
}
{
  const [a, b] = pair(); const st = mock({ routes: { status: 401, body: { error: 'Invalid key' } }, directions: { status: 401, body: {} } });
  ok(await roadDistanceKm(a, b) === fallback(a, b), '401 → zaxira');
  ok(st.jsonCalled === false, "401: javob tanasi tahlil QILINMADI (res.ok = false)");
}
for (const code of [403, 429, 500, 503]) {
  const [a, b] = pair(); mock({ routes: { status: code, body: {} }, directions: { status: code, body: {} } });
  ok(await roadDistanceKm(a, b) === fallback(a, b), `${code} → zaxira`);
}
{
  const to = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  const [a, b] = pair(); mock({ routes: { rejects: to }, directions: { rejects: to } });
  ok(await roadDistanceKm(a, b) === fallback(a, b), 'timeout → zaxira');
  const [c, d] = pair(); mock({ routes: { rejects: new TypeError('fetch failed') }, directions: { rejects: new TypeError('fetch failed') } });
  ok(await roadDistanceKm(c, d) === fallback(c, d), 'tarmoq xatosi → zaxira');
  const [e, f] = pair(); mock({ routes: { jsonThrows: true }, directions: { jsonThrows: true } });
  ok(await roadDistanceKm(e, f) === fallback(e, f), '200, lekin JSON emas (HTML) → zaxira, xato otilmaydi');
}

console.log('\n[5] Yetkazish narxi qaytgan masofadan hisoblanadi (perKm rejimi)');
{
  const totli = { deliveryEnabled: true, deliveryFee: 15000, freeDeliveryThreshold: 300000, delivery: { maxDistanceKm: 20, pricingMode: 'perKm', freeKm: 1, perKm: 2000, basePrice: 5000 } };
  const [a, b] = pair(0.0087);
  mock({ routes: { body: routesBody(5000) } });                                       // 5000 m
  const q = await quoteDelivery({ ...totli, lat: a.lat, lng: a.lng }, { lat: b.lat, lng: b.lng }, 100000);
  ok(q.price === 13000 && q.price === calcDeliveryPrice(5, totli, 100000).price, `Google 5.0 km → narx ${q.price} (TOTLI: 5 km = 13 000; calcDeliveryPrice(5) bilan bir xil)`);
  const [c, d] = pair(0.0087);
  mock({ routes: { body: routesBody(3000) } });
  const q3 = await quoteDelivery({ ...totli, lat: c.lat, lng: c.lng }, { lat: d.lat, lng: d.lng }, 100000);
  ok(q3.price === 9000, `Google 3.0 km → narx ${q3.price} (TOTLI: 3 km = 9 000)`);
}

globalThis.fetch = realFetch;
console.log(fails ? `\n✗ ${fails} ta xato` : '\n✓ Hammasi o‘tdi');
process.exit(fails ? 1 : 0);
