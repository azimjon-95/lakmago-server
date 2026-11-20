import assert from 'node:assert/strict';
process.env.APP_ENV = 'test'; process.env.TELEGRAM_BOT_TOKEN = '000000:TEST'; process.env.ADMIN_ALERTS_CHAT_ID = '-100999';
const { cleanCoords, mapsUrl, customerTelegramButton, fulfillmentLine } = await import('../src/lib/orderContactLinks.js');
const { _buildForTest } = await import('../src/services/adminOrderMonitor.js');
let n = 0; const t = (name, fn) => { fn(); n += 1; console.log('  ✓', name); };

t('koordinata: 6 xonaga yaxlitlanadi, string ham qabul', () => {
  assert.deepEqual(cleanCoords(40.99834567, 71.67261234), { lat: 40.998346, lng: 71.672612 });
  assert.deepEqual(cleanCoords('40.9983', '71.6726'), { lat: 40.9983, lng: 71.6726 });
});
t('koordinata: null/0,0/diapazondan tashqari/NaN rad', () => {
  for (const [a, b] of [[null, 71], [0, 0], [95, 71], [40, 200], [NaN, 1], ['', ''], [undefined, undefined]]) assert.equal(cleanCoords(a, b), null);
});
t('koordinata: lat/lng almashib qolsa (O\'zbekiston) to\'g\'rilanadi', () => assert.deepEqual(cleanCoords(71.6726, 40.9983), { lat: 40.9983, lng: 71.6726 }));
t('Google Maps: koordinata bo\'lsa pin', () => assert.equal(mapsUrl({ lat: 40.9983, lng: 71.6726, address: 'x' }), 'https://www.google.com/maps/search/?api=1&query=40.9983,71.6726'));
t('Google Maps: koordinata yo\'q — manzil matni, u ham yo\'q — null', () => {
  assert.match(mapsUrl({ address: "Tinchlik ko'chasi 67 uy" }), /query=Tinchlik%20ko'chasi%2067%20uy$/);
  assert.equal(mapsUrl({ address: ' ' }), null);
});
t('mijoz tugmasi: username → t.me; username yo\'q → tg://user?id; ikkisi yo\'q → null', () => {
  assert.equal(customerTelegramButton({ username: '@G_1905', telegramId: '5' }).url, 'https://t.me/G_1905');
  assert.deepEqual(customerTelegramButton({ telegramId: '8187045123' }), { text: '👤 Mijoz profili (Telegram)', url: 'tg://user?id=8187045123', kind: 'id' });
  assert.equal(customerTelegramButton({ username: 'a b', telegramId: 'abc' }), null);
  assert.equal(customerTelegramButton(null), null);
});
t('buyurtma turi', () => {
  assert.match(fulfillmentLine({ fulfillment: 'pickup' }), /O‘zi olib ketadi/);
  assert.match(fulfillmentLine({ fulfillment: 'delivery' }), /Yetkazib berish/);
});
const base = { _id: 'o1', status: 'accepted', restaurantName: 'Osiyo kafe', items: [], subtotal: 1000, createdAt: new Date(), userId: { firstName: 'A', telegramId: '8187045123' }, phone: '+998901112233' };
t('post: yetkazish — manzil ko\'k havola (koordinata bilan), & ekranlangan, profil tugmasi', () => {
  const { text, markup } = _buildForTest({ ...base, fulfillment: 'delivery', address: "Tinchlik <67> & uy", addressLat: 40.99834567, addressLng: 71.67261234 });
  assert.match(text, /🛵 <b>Yetkazib berish<\/b>/);
  assert.match(text, /📍 <a href="https:\/\/www\.google\.com\/maps\/search\/\?api=1&amp;query=40\.998346,71\.672612">Tinchlik &lt;67&gt; &amp; uy<\/a>/);
  assert.ok(markup.inline_keyboard.flat().some((b) => b.url === 'tg://user?id=8187045123'));
});
t('post: o\'zi olib ketadi — yozuv bor, manzil/xarita havolasi YO\'Q', () => {
  const { text } = _buildForTest({ ...base, fulfillment: 'pickup', address: 'eski manzil', addressLat: 40.9, addressLng: 71.6 });
  assert.match(text, /O‘zi olib ketadi/); assert.ok(!text.includes('google.com/maps')); assert.ok(!text.includes('📍'));
});
t('post: koordinatasiz manzil — matn bo\'yicha qidiruv havolasi; manzilsiz — havolasiz', () => {
  assert.match(_buildForTest({ ...base, address: 'Namangan, Tinchlik 67' }).text, /<a href="https:\/\/www\.google\.com\/maps\/search\/\?api=1&amp;query=Namangan%2C%20Tinchlik%2067">/);
  assert.ok(!_buildForTest({ ...base }).text.includes('📍'));
});
t('post: username bor — t.me tugmasi, ID tugmasi yo\'q', () => {
  const { markup } = _buildForTest({ ...base, userId: { username: 'G_1905', telegramId: '5555' } });
  const urls = markup.inline_keyboard.flat().map((b) => b.url).filter(Boolean);
  assert.ok(urls.includes('https://t.me/G_1905')); assert.ok(!urls.some((u) => u.startsWith('tg://user')));
});
console.log(`order-contact-links: ${n} ta test o'tdi`);

// Telegram tg://user?id tugmasini maxfiylik tufayli rad etsa — post YO'QOLMAYDI: profil tugmasiz qayta yuboriladi
const { _tgRetryForTest } = await import('../src/services/adminOrderMonitor.js');
const sent = []; const realFetch = globalThis.fetch;
globalThis.fetch = async (_u, init) => {
  const body = JSON.parse(init.body); sent.push(body);
  const hasId = (body.reply_markup?.inline_keyboard || []).flat().some((b) => b.url?.startsWith('tg://user?id='));
  const json = hasId ? { ok: false, error_code: 400, description: 'Bad Request: BUTTON_USER_PRIVACY_RESTRICTED' } : { ok: true, result: { message_id: 7 } };
  return { json: async () => json };
};
const origErr = console.error; const origWarn = console.warn; console.error = () => {}; console.warn = () => {};
const res = await _tgRetryForTest('sendMessage', { chat_id: '-100999', text: 'x', reply_markup: { inline_keyboard: [[{ text: '👤', url: 'tg://user?id=123456' }], [{ text: '✅', callback_data: 'aom_done:1' }]] } });
console.error = origErr; console.warn = origWarn; globalThis.fetch = realFetch;
assert.equal(res.ok, true); assert.equal(sent.length, 2);
assert.deepEqual(sent[1].reply_markup.inline_keyboard, [[{ text: '✅', callback_data: 'aom_done:1' }]]);
console.log('  ✓ maxfiylik rad etsa: ikkinchi urinish profil tugmasiz, amal tugmalari saqlanadi');
