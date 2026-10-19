/*
 * CORS MANBALARI — HTTP (cors) va Socket.IO uchun bitta isAllowedOrigin. Baza KERAK EMAS.
 * Real `cors` kutubxonasi bilan preflight (OPTIONS) so'rovlar sinaladi.
 * npm run test:cors
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(40);
const http = await import('node:http');
const express = (await import('express')).default;
const cors = (await import('cors')).default;
const { isAllowedOrigin } = await import('../src/config/index.js');

let fails = 0;
const ok = (c, m) => { console.log(c ? '  ✓' : '  ✗ FAIL:', m); if (!c) fails++; };

console.log('\n[1] Ruxsat etilgan manbalar');
for (const o of ['capacitor://localhost', 'https://localhost', 'http://localhost', 'https://lokma.uz', 'https://apilokma.poppolizol.uz', 'https://lakmago-admin.vercel.app', 'http://localhost:5173']) {
  ok(isAllowedOrigin(o) === true, o);
}
ok(isAllowedOrigin(undefined) === true, 'Origin yo‘q (server-to-server, Postman) — ruxsat');
ok(isAllowedOrigin('capacitor://localhost/') === true, 'oxiridagi "/" e‘tiborsiz');

console.log('\n[2] Rad etilgan manbalar (yaqin ko‘rinishdagi soxtalar ham)');
for (const o of ['https://evil.com', 'capacitor://evil', 'capacitor://localhost.evil.com', 'http://lokma.uz', 'https://lokma.uz.evil.com', 'https://notlokma.uz', 'https://www.lokma.uz', 'https://apilokma.poppolizol.uz.evil.com', 'file://', 'null']) {
  ok(isAllowedOrigin(o) === false, `${o} — rad`);
}

console.log('\n[3] Haqiqiy cors middleware: preflight (OPTIONS) javoblari — index.js dagi sozlama bilan bir xil');
const app = express();
app.use(cors({ origin: (origin, cb) => cb(null, isAllowedOrigin(origin)), credentials: true }));
app.get('/api/ping', (_q, r) => r.json({ ok: true }));
const server = http.createServer(app);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const preflight = (origin) => fetch(`${base}/api/ping`, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization,content-type' } });
{
  for (const o of ['capacitor://localhost', 'https://lokma.uz', 'https://apilokma.poppolizol.uz']) {
    const r = await preflight(o);
    ok(r.status === 204 && r.headers.get('access-control-allow-origin') === o && /authorization/i.test(r.headers.get('access-control-allow-headers') || ''), `${o}: preflight 204, Allow-Origin = ${o}, Authorization sarlavhasi ruxsat`);
  }
  const bad = await preflight('https://evil.com');
  ok(!bad.headers.get('access-control-allow-origin'), 'https://evil.com: Allow-Origin sarlavhasi YO‘Q (brauzer bloklaydi)');
  const cap = await fetch(`${base}/api/ping`, { headers: { Origin: 'capacitor://localhost' } });
  ok(cap.headers.get('access-control-allow-origin') === 'capacitor://localhost' && (await cap.json()).ok === true, 'oddiy GET: capacitor://localhost uchun javob + CORS sarlavhasi');
}
server.close();
console.log(fails ? `\n✗ ${fails} ta xato` : '\n✓ Hammasi o‘tdi');
process.exit(fails ? 1 : 0);
