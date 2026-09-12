/*
 * ═══════════════════════════════════════════════════════════
 * WEBHOOK QULFLARI — TEST
 * ═══════════════════════════════════════════════════════════
 *
 * Isbotlanadigan asosiy da'vo:
 * TEST server production botlarining webhook'iga HECH QACHON
 * tegolmaydi, .env noto'g'ri to'ldirilgan bo'lsa ham.
 *
 * Ishga tushirish: npm test
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);
const PROD_URL = 'https://apilokma.poppolizol.uz';
const TEST_URL = 'https://test-api.lokmago.uz';
let fails = 0;
const ok = (c, m) => { console.log(c ? '  ✓' : '  ✗ FAIL:', m); if (!c) fails++; };

/** Har holat TOZA jarayonda — modul keshi holatlar orasida o'tmaydi */
async function scenario(env) {
  const { stdout } = await run('node', [new URL('./webhook-guard.case.mjs', import.meta.url).pathname], {
    env: {
      PATH: process.env.PATH, NODE_ENV: 'development',
      TELEGRAM_BOT_TOKEN: 'CUSTOMER_TOKEN', RESTAURANT_BOT_TOKEN: 'RESTAURANT_TOKEN',
      JWT_SECRET: 'x'.repeat(40), MONGO_URI: 'mongodb://127.0.0.1:27017/x', ...env,
    },
  });
  return JSON.parse(stdout.split('@@')[1]);
}

console.log('\n[1] TO‘G‘RI test sozlamasi → webhook FAQAT test domeniga');
let r = await scenario({ APP_ENV: 'test', WEBHOOK_BASE: TEST_URL, T_CUST_NAME: 'LokmaGoTestBot', T_REST_NAME: 'LokmaGoRestoranTestBot' });
ok(r.set.length === 2, `ikkala bot uchun o‘rnatildi (${r.set.length})`);
ok(r.set.every((s) => s.url.startsWith(TEST_URL)), `manzillar: ${r.set.map((s) => s.url).join(', ')}`);

console.log('\n[2] ⚠ TEST muhitiga PRODUCTION tokeni yozildi');
r = await scenario({ APP_ENV: 'test', WEBHOOK_BASE: TEST_URL, T_CUST_NAME: 'lokmaGobot', T_REST_NAME: 'LokmaGoRestoranBot' });
ok(r.set.length === 0, `webhook o‘rnatilmadi (${r.set.length}) — production botlari omon`);
ok(r.logs.some((l) => /TEST MUHITI.*TEST boti emas/s.test(l)), 'sabab logda aniq yozildi');

console.log('\n[3] ⚠ TEST muhitiga PRODUCTION manzili yozildi');
r = await scenario({ APP_ENV: 'test', WEBHOOK_BASE: PROD_URL, T_CUST_NAME: 'LokmaGoTestBot', T_REST_NAME: 'LokmaGoRestoranTestBot' });
ok(r.set.length === 0, `webhook o‘rnatilmadi (${r.set.length}) — production webhook tegilmadi`);
ok(r.logs.some((l) => /ruxsat etilmagan manzil/i.test(l)), 'sabab logda aniq yozildi');

console.log('\n[4] ⚠ TEST: prod token + prod manzil (eng yomon holat)');
r = await scenario({ APP_ENV: 'test', WEBHOOK_BASE: PROD_URL, T_CUST_NAME: 'lokmaGobot', T_REST_NAME: 'LokmaGoRestoranBot' });
ok(r.set.length === 0, `webhook o‘rnatilmadi (${r.set.length})`);

console.log('\n[5] ⚠ TEST: begona "test" domeni');
r = await scenario({ APP_ENV: 'test', WEBHOOK_BASE: 'https://test.boshqa-domen.uz', T_CUST_NAME: 'LokmaGoTestBot', T_REST_NAME: 'LokmaGoRestoranTestBot' });
ok(r.set.length === 0, `faqat ruxsat etilgan ro‘yxat ishlaydi (${r.set.length})`);

console.log('\n[6] PRODUCTION (APP_ENV yo‘q) → xatti-harakat O‘ZGARMADI');
r = await scenario({ WEBHOOK_BASE: PROD_URL, T_CUST_NAME: 'lokmaGobot', T_REST_NAME: 'LokmaGoRestoranBot' });
ok(r.set.length === 2, `ikkala webhook o‘rnatildi (${r.set.length})`);
ok(r.set.every((s) => s.url.startsWith(PROD_URL)), `manzillar: ${r.set.map((s) => s.url).join(', ')}`);

console.log('\n[7] PRODUCTION: mavjud webhook manzili saqlanadi');
r = await scenario({ WEBHOOK_BASE: PROD_URL, T_CUST_NAME: 'lokmaGobot', T_REST_NAME: 'LokmaGoRestoranBot', T_EXISTING: `${PROD_URL}/bot/webhook` });
const cust = r.set.find((s) => s.url?.includes('/bot/webhook') && !s.url.includes('restaurant'));
ok(cust?.url === `${PROD_URL}/bot/webhook`, `mijoz boti mavjud manzilda qoldi: ${cust?.url}`);

console.log('\n[8] PRODUCTION .env ga test tokeni → ogohlantiradi, lekin to‘xtatmaydi');
r = await scenario({ WEBHOOK_BASE: PROD_URL, T_CUST_NAME: 'LokmaGoTestBot', T_REST_NAME: 'LokmaGoRestoranTestBot' });
ok(r.logs.some((l) => /PRODUCTION.*nomida "test" bor/s.test(l)), 'ogohlantirish chiqdi');

console.log('\n[9] Tokenlar loglarga CHIQMAYDI');
r = await scenario({ APP_ENV: 'test', WEBHOOK_BASE: PROD_URL, T_CUST_NAME: 'lokmaGobot', T_REST_NAME: 'LokmaGoRestoranBot' });
ok(!r.logs.some((l) => /CUSTOMER_TOKEN|RESTAURANT_TOKEN/.test(l)), 'loglarda token yo‘q');
ok(r.logs.some((l) => /@lokmaGobot/.test(l)), 'faqat ochiq username yoziladi');

console.log(fails ? `\n✗ ${fails} ta xato` : '\n✓ HAMMASI O‘TDI');
process.exit(fails ? 1 : 0);
