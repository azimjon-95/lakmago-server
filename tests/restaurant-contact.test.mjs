/*
 * RESTORAN BILAN BOG'LANISH — telefon formati va Telegram kontakt kartasi.
 * Baza KERAK EMAS (modellar va fetch stub). npm run test:contact
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(40);
const { config } = await import('../src/config/index.js');
config.telegramBotToken = '1:TEST';
const { Order } = await import('../src/models/Order.js');
const { Restaurant } = await import('../src/models/Restaurant.js');
const { normalizeUzPhone, sendRestaurantContact } = await import('../src/services/restaurantContact.js');

let fails = 0;
const ok = (c, m) => { console.log(c ? '  ✓' : '  ✗ FAIL:', m); if (!c) fails++; };
const chain = (v) => ({ select() { return this; }, lean: async () => v });
const sent = [];
let tgOk = true;
globalThis.fetch = async (url, init) => { sent.push({ url: String(url), body: JSON.parse(init.body) }); return { json: async () => ({ ok: tgOk }) }; };
let order = { restaurantId: 'r1', status: 'accepted' };
let rest = { name: 'TOTLI Tortlari', phone: '+998 77 737 77 40' };
Order.findOne = (f) => chain(f.userId === 'u1' ? order : null);
Restaurant.findById = () => chain(rest);

console.log('\n[1] Telefon formati');
for (const [i, o] of [['+998 77 737 77 40', '+998777377740'], ['77 737 77 40', '+998777377740'], ['+998 (77) 737-77-40', '+998777377740'], ['998777377740', '+998777377740'], ['', ''], ['12', '']]) {
  ok(normalizeUzPhone(i) === o, `${JSON.stringify(i)} → ${JSON.stringify(normalizeUzPhone(i))}`);
}

console.log('\n[2] Kontakt kartasi yuborish');
{
  let r = await sendRestaurantContact('o1', 'u1', '555');
  const c = sent[0];
  ok(r.ok && c.url.endsWith('/sendContact') && c.body.chat_id === '555', 'accepted: kontakt mijozning Telegram ID’siga yuborildi');
  ok(c.body.phone_number === '+998777377740' && c.body.first_name === 'TOTLI Tortlari', 'raqam normallashtirilgan, nom — restoran nomi');
  ok((await sendRestaurantContact('o1', 'BOSHQA', '555')).code === 'NOT_FOUND', 'boshqa mijoz buyurtmasi — NOT_FOUND (egalik tekshiriladi)');
  order = { ...order, status: 'pending' };
  ok((await sendRestaurantContact('o1', 'u1', '555')).code === 'NOT_ALLOWED', 'restoran hali qabul qilmagan — NOT_ALLOWED');
  order = { ...order, status: 'delivered' };
  ok((await sendRestaurantContact('o1', 'u1', '555')).code === 'NOT_ALLOWED', 'yakunlangan — NOT_ALLOWED');
  order = { ...order, status: 'delivering' };
  rest = { name: 'X', phone: '' };
  ok((await sendRestaurantContact('o1', 'u1', '555')).code === 'NO_PHONE', 'raqam yo‘q — NO_PHONE');
  rest = { name: 'X', phone: '+998901112233' };
  ok((await sendRestaurantContact('o1', 'u1', null)).code === 'NO_TELEGRAM', 'Telegram ID yo‘q — NO_TELEGRAM');
  tgOk = false;
  ok((await sendRestaurantContact('o1', 'u1', '555')).code === 'SEND_FAILED', 'Telegram xatosi — SEND_FAILED');
  tgOk = true;
  const n = sent.length;
  await sendRestaurantContact('o1', 'u1', '555');
  ok(sent.length === n + 1 && !JSON.stringify(sent.at(-1)).includes('token'), 'so‘rovda token ma’lumoti oshkor emas');
}

console.log(fails ? `\n✗ ${fails} ta xato` : '\n✓ Hammasi o‘tdi');
process.exit(fails ? 1 : 0);
