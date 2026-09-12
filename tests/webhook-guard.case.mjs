/*
 * Webhook qulflari testi — BITTA HOLAT.
 *
 * Alohida jarayonda ishlaydi: config moduli env'ni bir marta
 * o'qiydi, shuning uchun holatlar bir jarayonda aralashib
 * ketardi (birinchi holatdagi APP_ENV keyingilariga ham
 * qolib ketardi — buni sinov paytida aniqladik).
 *
 * Telegram API soxtalashtiriladi: haqiqiy tarmoqqa CHIQILMAYDI
 * va haqiqiy token ishlatilmaydi.
 */
const calls = [];
const logs = [];
for (const k of ['log', 'error', 'warn']) {
  const orig = console[k];
  console[k] = (...a) => { logs.push(a.join(' ')); if (process.env.SHOW_LOGS) orig(...a); };
}
globalThis.fetch = async (url, opts) => {
  const [, token, method] = String(url).match(/bot([^/]+)\/(\w+)/);
  const who = token === process.env.TELEGRAM_BOT_TOKEN ? 'customer' : 'restaurant';
  const body = opts?.body ? JSON.parse(opts.body) : {};
  calls.push({ who, method, url: body.url });
  if (method === 'getMe') {
    return { status: 200, json: async () => ({ ok: true, result: { username: who === 'customer' ? process.env.T_CUST_NAME : process.env.T_REST_NAME } }) };
  }
  if (method === 'getWebhookInfo') {
    return { status: 200, json: async () => ({ ok: true, result: { url: process.env.T_EXISTING || '', allowed_updates: [] } }) };
  }
  return { status: 200, json: async () => ({ ok: true, result: true }) };
};
const wh = await import(new URL('../src/services/webhookSetup.js', import.meta.url).href);
await wh.ensureWebhook();
await wh.ensureRestaurantWebhook();
process.stdout.write(`@@${JSON.stringify({ set: calls.filter((c) => c.method === 'setWebhook'), logs })}@@`);
