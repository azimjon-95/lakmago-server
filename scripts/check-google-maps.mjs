#!/usr/bin/env node
/*
 * GOOGLE MAPS DIAGNOSTIKASI — serverda ishga tushiring:   node scripts/check-google-maps.mjs
 *
 * Nima qiladi (hech narsani o'zgartirmaydi, bazaga ulanmaydi):
 *   1) .env dagi ikkala kalitni tekshiradi (borligi, shakli, bir-biridan farqi) — kalitlarni TO'LIQ chiqarmaydi;
 *   2) serverning tashqi IP manzilini (IPv4 va IPv6) ko'rsatadi — server kalitining "IP addresses" cheklovida shular bo'lishi kerak;
 *   3) Geocoding, Routes, Directions API'ni server kaliti bilan chaqiradi va Google'ning ANIQ xato matnini chiqaradi
 *      (ilova ichida bu xatolar jim yutiladi va zaxiraga o'tiladi — shuning uchun alohida skript);
 *   4) brauzer kaliti uchun HTTP referrer ro'yxatiga qo'shilishi kerak bo'lgan manzillarni chiqaradi.
 */
import https from 'node:https';
const { config } = await import('../src/config/index.js');

const mask = (k) => (k ? `${k.slice(0, 6)}…${k.slice(-4)} (${k.length} belgi)` : '— YO‘Q —');
const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => console.log(`  ✗ ${m}`);
const info = (m) => console.log(`    ${m}`);
let problems = 0;
const fail = (m) => { problems += 1; bad(m); };

/** Google xato matnini tushunarli tavsiyaga aylantiradi */
function hint(text = '') {
  const t = String(text);
  if (/ip address|IP_ADDRESS|not authorized.*ip/i.test(t)) return 'IP cheklovi: serverning tashqi IP\'si (yuqoridagi IPv4 VA IPv6) kalitning "IP addresses" ro‘yxatida yo‘q.';
  if (/referer/i.test(t)) return 'Referrer cheklovi: server kaliti "HTTP referrers" bilan cheklangan — server kalitida "IP addresses" bo‘lishi kerak.';
  if (/billing/i.test(t)) return 'Loyihada BILLING (to‘lov kartasi) ulanmagan.';
  if (/has not been used|is disabled|not enabled|SERVICE_DISABLED|accessNotConfigured/i.test(t)) return 'Bu API loyihada YOQILMAGAN (APIs & Services → Library).';
  if (/API key not valid|API_KEY_INVALID|invalid key/i.test(t)) return 'Kalit noto‘g‘ri (.env da probel/uzilish bormi? boshqa loyiha kalitimi?).';
  if (/API restrict|API_KEY_SERVICE_BLOCKED|not authorized to use this API|blocked/i.test(t)) return 'Kalitning "API restrictions" ro‘yxatida bu API tanlanmagan.';
  if (/quota|OVER_QUERY_LIMIT|RESOURCE_EXHAUSTED/i.test(t)) return 'Kvota/limit tugagan.';
  return '';
}

/** IPv4/IPv6 bo'yicha tashqi manzil */
const myIp = (family) => new Promise((resolve) => {
  const req = https.get({ host: family === 6 ? 'api6.ipify.org' : 'api.ipify.org', path: '/', family, timeout: 5000 }, (res) => {
    let s = ''; res.on('data', (d) => { s += d; }); res.on('end', () => resolve(s.trim() || null));
  });
  req.on('error', () => resolve(null)); req.on('timeout', () => { req.destroy(); resolve(null); });
});

async function call(url, init) {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(8000) });
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  } catch (e) { return { status: 0, body: null, error: e.message }; }
}

console.log('\n[1] Kalitlar (.env)');
const sk = config.google?.apiKey || ''; const bk = config.google?.browserKey || '';
if (!sk) fail('GOOGLE_MAPS_API_KEY yozilmagan (server kaliti) — masofa/manzil/yo‘l ishlamaydi'); else ok(`GOOGLE_MAPS_API_KEY: ${mask(sk)}`);
if (!bk) fail('GOOGLE_MAPS_BROWSER_KEY yozilmagan (brauzer kaliti) — xarita ochilmaydi'); else ok(`GOOGLE_MAPS_BROWSER_KEY: ${mask(bk)}`);
if (sk && bk && sk === bk) fail('Ikkala kalit BIR XIL. Alohida kalitlar bo‘lishi kerak (server: IP cheklov, brauzer: referrer cheklov) — bittasi albatta noto‘g‘ri cheklangan bo‘ladi.');
for (const [n, k] of [['server', sk], ['brauzer', bk]]) if (k && (!/^AIza[\w-]{35}$/.test(k))) fail(`${n} kaliti odatiy shaklda emas (AIza… + 35 belgi). Probel yoki uzilish bo‘lishi mumkin.`);

console.log('\n[2] Serverning tashqi IP manzili (server kaliti cheklovi uchun)');
const [ip4, ip6] = await Promise.all([myIp(4), myIp(6)]);
ip4 ? ok(`IPv4: ${ip4}`) : info('IPv4 aniqlanmadi');
ip6 ? ok(`IPv6: ${ip6}   ← Google ba’zan IPv6 orqali ulanadi; kalitning IP ro‘yxatiga IPv6 ham qo‘shing`) : info('IPv6 yo‘q (faqat IPv4)');

if (sk) {
  console.log('\n[3] Server kaliti bilan Google API\'lar');
  // Geocoding
  const g = await call(`https://maps.googleapis.com/maps/api/geocode/json?latlng=41.3111,69.2406&language=uz&key=${encodeURIComponent(sk)}`);
  if (g.status === 0) fail(`Geocoding: Google'ga ulanib bo‘lmadi (${g.error})`);
  else if (g.body?.status === 'OK') ok(`Geocoding API ishlaydi: "${g.body.results?.[0]?.formatted_address || ''}"`);
  else { fail(`Geocoding API: ${g.body?.status} — ${g.body?.error_message || ''}`); const h = hint(g.body?.error_message); if (h) info(`→ ${h}`); }

  // Routes
  const r = await call('https://routes.googleapis.com/directions/v2:computeRoutes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': sk, 'X-Goog-FieldMask': 'routes.distanceMeters,routes.duration' },
    body: JSON.stringify({ origin: { location: { latLng: { latitude: 41.3111, longitude: 69.2406 } } }, destination: { location: { latLng: { latitude: 41.3, longitude: 69.25 } } }, travelMode: 'DRIVE' }),
  });
  if (r.status === 0) fail(`Routes: Google'ga ulanib bo‘lmadi (${r.error})`);
  else if (r.status === 200 && r.body?.routes?.[0]?.distanceMeters) ok(`Routes API ishlaydi: ${r.body.routes[0].distanceMeters} m, ${r.body.routes[0].duration}`);
  else { const e = r.body?.error; fail(`Routes API: HTTP ${r.status} ${e?.status || ''} — ${e?.message || ''}`); const h = hint(`${e?.message} ${e?.status}`); if (h) info(`→ ${h}`); }

  // Directions (eski) — faqat ma'lumot uchun
  const d = await call(`https://maps.googleapis.com/maps/api/directions/json?origin=41.3111,69.2406&destination=41.3,69.25&mode=driving&key=${encodeURIComponent(sk)}`);
  if (d.body?.status === 'OK') ok('Directions API (eski) ham ishlaydi — zaxira sifatida');
  else info(`Directions API (eski): ${d.body?.status || d.error} — Routes API ishlasa bu KERAK EMAS`);
}

console.log('\n[4] Brauzer kaliti: "HTTP referrers" ro‘yxatiga QO‘SHILISHI kerak bo‘lgan manzillar');
info('(Brauzer kalitini serverdan tekshirib bo‘lmaydi — xarita brauzerda ochiladi. Ro‘yxat to‘liq bo‘lishi shart.)');
const origins = [config.webappOrigin, ...(Array.isArray(config.adminOrigins) ? config.adminOrigins : [])].filter(Boolean);
for (const o of [...new Set(origins)]) info(`${String(o).replace(/\/+$/, '')}/*`);
if (!origins.length) info('(WEBAPP_URL / CORS_ORIGINS .env da topilmadi)');
info('Native iOS/Android ilova bo‘lsa yana:  capacitor://localhost/*   va   https://localhost/*');
info('Aniq kerakli manzil xarita xatosida yoziladi: brauzer konsolidagi "Your site URL to be authorized: …"');

console.log(problems ? `\n✗ ${problems} ta muammo — yuqoridagi "→" tavsiyalarni bajaring.\n` : '\n✓ Server tomoni to‘liq ishlayapti. Xarita hali ochilmasa — brauzer kaliti (4-bo‘lim) yoki unda Maps JavaScript API/billing.\n');
process.exit(problems ? 1 : 0);
