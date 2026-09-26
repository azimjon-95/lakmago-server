/*
 * ═══════════════════════════════════════════════════════════
 * BOT MENYUSI — ISHLAYOTGANINI TEKSHIRISH
 * ═══════════════════════════════════════════════════════════
 *
 * NIMA UCHUN QO'SHILDI: "Sozlamalar" bo'limi olib tashlanganda
 * u bilan birga ikkita YORDAMCHI funksiya ham o'chib ketdi
 * (`sendOrEdit`, `clip`). Mavjud testlar menyu tugmalarini
 * bosmagani uchun buni ushlamadi — "Faol bronlar" va "Bugungi
 * dostavkalar" ishlamay qolgan edi.
 *
 * Endi har bir menyu bo'limi HAQIQATAN ishga tushiriladi.
 *
 * Ishga tushirish: npm run test:menu
 */
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/lokma_menu';
process.env.RESTAURANT_BOT_TOKEN = '1:X';

const calls = [];
globalThis.fetch = async (u, o) => {
  const [, , m] = String(u).match(/bot([^/]+)\/(\w+)/);
  calls.push({ m, body: o?.body ? JSON.parse(o.body) : {} });
  return { status: 200, json: async () => ({ ok: true, result: { message_id: 7 } }) };
};

const mongoose = (await import('mongoose')).default;
await mongoose.connect(process.env.MONGO_URI);
await mongoose.connection.db.dropDatabase();

const { Restaurant } = await import('../src/models/Restaurant.js');
const { User } = await import('../src/models/User.js');
const { Order } = await import('../src/models/Order.js');
const { Reservation } = await import('../src/models/Reservation.js');
const { RestaurantTelegramStaff } = await import('../src/models/RestaurantTelegramStaff.js');
const bot = await import('../src/services/restaurantBot.js');
const menu = await import('../src/services/restaurantBotMenu.js');

let fails = 0;
const ok = (c, m) => { console.log(c ? '  ✓' : '  ✗ FAIL:', m); if (!c) fails++; };
const tick = () => new Promise((r) => setTimeout(r, 400));
const take = () => calls.splice(0, calls.length);
const msg = (id, text) => bot.handleRestaurantBotUpdate({
  message: { chat: { type: 'private' }, from: { id }, text },
});

const rest = await Restaurant.create({
  name: 'Z', cuisine: 'milliy', category: 'restoran', timezone: 'Asia/Tashkent',
});
const user = await User.create({ firstName: 'A', telegramId: '5' });
await RestaurantTelegramStaff.create({
  restaurantId: rest._id, username: 'a', telegramUserId: '9001',
  firstName: 'Aziz', isActive: true, connectedAt: new Date(),
});
/*
 * Sana NISBIY — Toshkent bo'yicha ertaga. Avval '2026-09-25' qattiq
 * yozilgan edi: o'sha kun o'tgach bron "faol" ro'yxatdan chiqib,
 * test kod o'zgarmasa ham yiqilardi (vaqt bombasi).
 */
const RESERVATION_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tashkent' })
  .format(new Date(Date.now() + 24 * 3600 * 1000));
await Reservation.create({
  userId: user._id, restaurantId: rest._id, restaurantName: 'Z',
  date: RESERVATION_DATE, time: '19:00', guests: 2, name: 'Ali', phone: '1',
});
const order = await Order.create({
  userId: user._id, restaurantId: rest._id, restaurantName: 'Z',
  items: [{ name: 'Pasta', quantity: 1, unitPrice: 10000 }],
  subtotal: 10000, deliveryFee: 15000, total: 25000,
  status: 'pending', fulfillment: 'delivery', address: 'x',
  phone: '+998901112233', paymentMethod: 'click',
});
take();

console.log('\n[1] "Faol bronlar"');
{
  await msg(9001, '📅 Faol bronlar'); await tick();
  const c = take().filter((x) => x.m === 'sendMessage');
  ok(c.length === 1 && /Faol bronlar/.test(c[0].body.text), 'ro‘yxat keldi');
  ok(/Ali/.test(c[0].body.text), 'bron ko‘rinyapti');
}

console.log('\n[2] "Bugungi dostavkalar"');
{
  await msg(9001, '🚴 Bugungi dostavkalar'); await tick();
  const c = take().filter((x) => x.m === 'sendMessage');
  ok(c.length === 1 && /Bugungi dostavkalar/.test(c[0].body.text), 'ro‘yxat keldi');
}

console.log('\n[3] "Yangilash" — joyida tahrir');
{
  await bot.handleRestaurantBotUpdate({
    callback_query: { id: 'q', from: { id: 9001 }, data: 'm:resv', message: { message_id: 5 } },
  });
  await tick();
  ok(take().some((x) => x.m === 'editMessageText' && x.body.message_id === 5), 'joyida yangilandi');
}

console.log('\n[4] Menyu — 2 tugma, Sozlamalar yo‘q');
{
  await msg(9001, 'salom'); await tick();
  const c = take().filter((x) => x.m === 'sendMessage');
  const kb = c[0]?.body.reply_markup?.keyboard;
  ok(kb && kb.flat().length === 2, `menyu: ${kb?.flat().map((b) => b.text).join(' | ')}`);
  ok(!JSON.stringify(kb).includes('Sozlamalar'), 'Sozlamalar olib tashlangan');
  ok(menu.MENU_VERSION === 3, `MENU_VERSION = ${menu.MENU_VERSION}`);
}

console.log('\n[5] Buyurtma tugmasi ishlayapti');
{
  await bot.handleRestaurantBotUpdate({
    callback_query: { id: 'q2', from: { id: 9001 }, data: `o:accept:${order._id}`, message: { message_id: 1 } },
  });
  await tick(); take();
  ok((await Order.findById(order._id)).status === 'accepted', 'buyurtma qabul qilindi');
}

console.log('\n[6] Ovozli xabar HECH QAYERDA yuborilmaydi');
{
  const voice = calls.filter((x) => x.m === 'sendVoice' || x.m === 'sendAudio');
  ok(voice.length === 0, `sendVoice/sendAudio: ${voice.length} ta`);
}

await mongoose.disconnect();
console.log(fails ? `\n✗ ${fails} ta xato` : '\n✓ HAMMASI O‘TDI');
process.exit(fails ? 1 : 0);
