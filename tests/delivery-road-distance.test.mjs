/*
 * roadDistanceKm — Yandex Routing `steps[].length` (SON, metr) ni to'g'ri o'qish.
 * Avval `x.length?.value` o'qilardi → doim 0 → har safar haversine * 1.3 zaxirasi ishlardi.
 * Soxta fetch; baza KERAK EMAS.   npm run test:road-distance
 */
process.env.JWT_SECRET = 'x'.repeat(40); process.env.NODE_ENV = 'development';
const { config } = await import('../src/config/index.js');
const { roadDistanceKm, haversineKm, calcDeliveryPrice, quoteDelivery } = await import('../src/services/deliveryEngine.js');

let fails = 0;
const ok = (c, m) => { console.log(c ? '  ✓' : '  ✗ XATO:', m); if (!c) fails++; };
const realFetch = globalThis.fetch;
const KEY = 'test-routing-key';
const setKey = (k) => { config.yandex.routingKey = k; config.yandex.geocoderKey = k; };
const fallback = (a, b) => Math.round(haversineKm(a, b) * 1.3 * 10) / 10;   // zaxira formulasi (o'zgarmagan)

// Har sinov uchun BOSHQA koordinata (marshrut keshi koordinata bo'yicha ishlaydi)
let seq = 0;
const pair = (straightDeg = 0.0087) => { seq += 1; const lat = 41.30 + seq * 0.01; return [{ lat, lng: 69.24 }, { lat: lat + straightDeg, lng: 69.24 }]; };

/** Yandex javobini soxtalashtiradi. Qaytaradi: { calls, jsonCalled } */
function mock({ status = 200, body, jsonThrows = false, rejects = null }) {
  const st = { calls: [], jsonCalled: false };
  globalThis.fetch = async (url) => {
    st.calls.push(String(url));
    if (rejects) throw rejects;
    return { ok: status >= 200 && status < 300, status, json: async () => { st.jsonCalled = true; if (jsonThrows) throw new SyntaxError('Unexpected token <'); return body; } };
  };
  return st;
}
const route = (steps, legStatus = 'OK') => ({ route: { legs: [{ status: legStatus, steps }] } });

console.log('\n[1] Yandex: length — SON (metr)');
setKey(KEY);
{
  const [a, b] = pair(0.0087);            // to'g'ri chiziq ~0.97 km → zaxira 1.3 km
  const st = mock({ body: route([{ length: 1116.15, duration: 206.47 }]) });   // TZ dagi namuna
  const km = await roadDistanceKm(a, b);
  ok(km === 1.1, `1116.15 m → ${km} km (yo'l masofasi, round(km*10)/10)`);
  ok(km !== fallback(a, b), `zaxira (${fallback(a, b)} km) ISHLATILMADI — Yandex qiymati olindi`);
  ok(st.calls.length === 1 && st.calls[0].includes('api.routing.yandex.net/v2/route') && st.calls[0].includes('apikey=' + KEY) && st.calls[0].includes('mode=driving'), "so'rov manzili/parametrlari o'zgarmagan");
  await roadDistanceKm(a, b);
  ok(st.calls.length === 1, 'kesh ishlaydi: ikkinchi chaqiruv Yandex ga bormadi');
}
{
  const [a, b] = pair(0.0087);
  mock({ body: route([{ length: 1000 }, { length: 2000.5 }, { length: '883.35' }, { duration: 5 }]) });
  const km = await roadDistanceKm(a, b);
  ok(km === 3.9, `bir nechta qadam yig'iladi (1000 + 2000.5 + "883.35" + uzunliksiz qadam) = 3883.85 m → ${km} km`);
}

console.log("\n[2] Eski shakl (length.value) — xavfsiz zaxira, xato yo'q");
{
  const [a, b] = pair();
  mock({ body: route([{ length: { value: 5000 } }]) });
  let km; let threw = false;
  try { km = await roadDistanceKm(a, b); } catch { threw = true; }
  ok(!threw && km === fallback(a, b), `length.value → Number() = NaN → 0 → zaxira: ${km} km`);
}
{
  const [a, b] = pair();
  mock({ body: route([]) });
  ok(await roadDistanceKm(a, b) === fallback(a, b), "qadamlar bo'sh → zaxira");
  const [c, d] = pair();
  mock({ body: { route: { legs: [{ status: 'OK' }] } } });
  ok(await roadDistanceKm(c, d) === fallback(c, d), "steps yo'q → zaxira (crash yo'q)");
}

console.log("\n[3] Kalit yo'q / 401 / timeout / buzuq javob — zaxira o'zgarmagan");
{
  setKey('');
  const [a, b] = pair(); const st = mock({ body: route([{ length: 5000 }]) });
  ok(await roadDistanceKm(a, b) === fallback(a, b) && st.calls.length === 0, "kalit yo'q: so'rov UMUMAN yuborilmaydi, haversine*1.3");
  setKey(KEY);
}
{
  const [a, b] = pair(); const st = mock({ status: 401, body: { message: 'Invalid key' } });
  ok(await roadDistanceKm(a, b) === fallback(a, b), '401 → zaxira');
  ok(st.jsonCalled === false, "401: javob tanasi tahlil QILINMADI (res.ok = false)");
}
for (const code of [403, 429, 500, 503]) {
  const [a, b] = pair(); mock({ status: code, body: { error: 'x' } });
  ok(await roadDistanceKm(a, b) === fallback(a, b), `${code} → zaxira`);
}
{
  const [a, b] = pair(); mock({ rejects: Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }) });
  ok(await roadDistanceKm(a, b) === fallback(a, b), 'timeout → zaxira');
  const [c, d] = pair(); mock({ rejects: new TypeError('fetch failed') });
  ok(await roadDistanceKm(c, d) === fallback(c, d), 'tarmoq xatosi → zaxira');
  const [e, f] = pair(); mock({ jsonThrows: true });
  ok(await roadDistanceKm(e, f) === fallback(e, f), "200, lekin JSON emas (HTML) → zaxira, xato otilmaydi");
  const [g, h] = pair(); mock({ body: route([{ length: 5000 }], 'NO_ROUTE') });
  ok(await roadDistanceKm(g, h) === fallback(g, h), "leg status != 'OK' → zaxira");
  const [i, j] = pair(); mock({ body: null });
  ok(await roadDistanceKm(i, j) === fallback(i, j), 'bo‘sh javob → zaxira');
}

console.log('\n[4] Yetkazish narxi qaytgan masofadan hisoblanadi (perKm rejimi)');
{
  const totli = { deliveryEnabled: true, deliveryFee: 15000, freeDeliveryThreshold: 300000, delivery: { maxDistanceKm: 20, pricingMode: 'perKm', freeKm: 1, perKm: 2000, basePrice: 5000 } };
  const [a, b] = pair(0.0087);
  mock({ body: route([{ length: 2500 }, { length: 2500 }]) });                  // 5000 m
  const q = await quoteDelivery({ ...totli, lat: a.lat, lng: a.lng }, { lat: b.lat, lng: b.lng }, 100000);
  ok(q.price === 13000 && q.price === calcDeliveryPrice(5, totli, 100000).price, `Yandex 5.0 km → narx ${q.price} (TOTLI: 5 km = 13 000; calcDeliveryPrice(5) bilan bir xil)`);
  const [c, d] = pair(0.0087);
  mock({ body: route([{ length: 3000 }]) });
  const q3 = await quoteDelivery({ ...totli, lat: c.lat, lng: c.lng }, { lat: d.lat, lng: d.lng }, 100000);
  ok(q3.price === 9000, `Yandex 3.0 km → narx ${q3.price} (TOTLI: 3 km = 9 000)`);
}

globalThis.fetch = realFetch;
console.log(fails ? `\n✗ ${fails} ta xato` : '\n✓ Hammasi o‘tdi');
process.exit(fails ? 1 : 0);
