/*
 * ═══════════════════════════════════════════════════════════
 * RESTORAN BOTLARI — XABAR TARQATISH TESTI
 * ═══════════════════════════════════════════════════════════
 *
 * Isbotlanadigan da'volar:
 *  1. Xabar barcha / tanlangan restoran xodimlariga boradi;
 *  2. Bloklagan xodim `failed` bo'lib yoziladi, qolganlar ketadi;
 *  3. Tugma bosilishi BIR MARTA sanaladi;
 *  4. Takroriy yuborishda yozuvlar ikkilanmaydi;
 *  5. Bu modul buyurtma/bron oqimiga TEGMAYDI.
 *
 * Ishga tushirish: npm run test:broadcast
 */
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/lokma_bcast';
process.env.RESTAURANT_BOT_TOKEN = '111:BOT';
process.env.JWT_SECRET = 'x'.repeat(40);

const calls = [];
let blockedChat = null;
let rateLimitOnce = false;
globalThis.fetch = async (url, opts = {}) => {
  const [, , method] = String(url).match(/bot([^/]+)\/(\w+)/);
  const body = opts.body ? JSON.parse(opts.body) : {};
  calls.push({ method, body });

  if (method === 'sendMessage' && String(body.chat_id) === String(blockedChat)) {
    return { status: 200, json: async () => ({ ok: false, description: 'Forbidden: bot was blocked by the user' }) };
  }
  if (method === 'sendMessage' && rateLimitOnce) {
    rateLimitOnce = false;
    return { status: 200, json: async () => ({ ok: false, description: 'Too Many Requests', parameters: { retry_after: 0 } }) };
  }
  return { status: 200, json: async () => ({ ok: true, result: { message_id: calls.length } }) };
};

const mongoose = (await import('mongoose')).default;
await mongoose.connect(process.env.MONGO_URI);
await mongoose.connection.db.dropDatabase();

const { Restaurant } = await import('../src/models/Restaurant.js');
const { RestaurantTelegramStaff } = await import('../src/models/RestaurantTelegramStaff.js');
const { BotBroadcast, BotBroadcastDelivery } = await import('../src/models/BotBroadcast.js');
await BotBroadcastDelivery.collection.createIndex(
  { broadcastId: 1, telegramUserId: 1 }, { unique: true },
);
const {
  sendBroadcast, handleBroadcastCallback, getBroadcastStats, listBotRestaurants,
} = await import('../src/services/botBroadcast.js');
const bot = await import('../src/services/restaurantBot.js');

let fails = 0;
const ok = (c, m) => { console.log(c ? '  ✓' : '  ✗ FAIL:', m); if (!c) fails++; };
const take = () => calls.splice(0, calls.length);

// Uch restoran, jami to'rt xodim
const r1 = await Restaurant.create({ name: 'Ziynat', cuisine: 'milliy', category: 'restoran' });
const r2 = await Restaurant.create({ name: 'Osiyo', cuisine: 'milliy', category: 'restoran' });
const r3 = await Restaurant.create({ name: 'Chinor', cuisine: 'milliy', category: 'restoran' });
const mk = (rid, tg, name) => RestaurantTelegramStaff.create({
  restaurantId: rid, username: name, telegramUserId: tg,
  firstName: name, isActive: true, connectedAt: new Date(),
});
await mk(r1._id, '1001', 'Aziz');
await mk(r1._id, '1002', 'Eli');
await mk(r2._id, '2001', 'Bek');
await mk(r3._id, '3001', 'Dil');
// Ulanmagan xodim — u xabar OLMASLIGI kerak
await RestaurantTelegramStaff.create({
  restaurantId: r3._id, username: 'uzilgan', telegramUserId: null, isActive: true,
});

console.log('\n[1] Botga ulangan restoranlar ro‘yxati');
{
  const list = await listBotRestaurants();
  ok(list.length === 3, `3 ta restoran (${list.length})`);
  const ziynat = list.find((x) => x.name === 'Ziynat');
  ok(ziynat.staffCount === 2, `Ziynatda 2 xodim (${ziynat.staffCount})`);
  ok(list.every((x) => Array.isArray(x.staff)), 'har birida xodimlar ro‘yxati bor');
}

console.log('\n[2] BARCHAGA yuborish + tugmalar');
let bc;
{
  bc = await BotBroadcast.create({
    title: 'Test', text: 'Ertaga <b>yig‘ilish</b> soat 10:00 da', format: 'html',
    target: 'all',
    buttons: [
      { text: '✅ Tasdiqlayman', kind: 'callback', key: 'b1' },
      { text: '❌ Kela olmayman', kind: 'callback', key: 'b2' },
    ],
  });
  const stats = await sendBroadcast(bc._id);
  const sends = take().filter((c) => c.method === 'sendMessage');

  ok(sends.length === 4, `4 xodimga yuborildi (${sends.length}) — ulanmagani olmadi`);
  ok(stats.sent === 4 && stats.failed === 0, `sent ${stats.sent}, failed ${stats.failed}`);
  ok(stats.restaurants === 3, `3 restoran qamrandi (${stats.restaurants})`);
  ok(sends[0].body.text.includes('<b>yig‘ilish</b>'), 'HTML formatlash saqlandi');

  const kb = sends[0].body.reply_markup?.inline_keyboard || [];
  ok(kb.length === 2, `2 qator tugma (${kb.length})`);
  ok(kb[0][0].callback_data === `b:${bc._id}:b1`, 'tugma kaliti to‘g‘ri');

  const fresh = await BotBroadcast.findById(bc._id).lean();
  ok(fresh.status === 'sent', `holat: ${fresh.status}`);
}

console.log('\n[3] Tugma bosilishi — BIR MARTA sanaladi');
{
  const cq = (from, key) => ({ id: `q${Math.random()}`, from: { id: from }, data: `b:${bc._id}:${key}` });
  await handleBroadcastCallback(cq(1001, 'b1'));
  await handleBroadcastCallback(cq(1001, 'b1'));   // takroriy bosish
  await handleBroadcastCallback(cq(2001, 'b2'));
  take();

  const after = await BotBroadcast.findById(bc._id).lean();
  ok(after.stats.clicked === 2, `noyob bosganlar: ${after.stats.clicked} (kutilgan 2)`);

  const stats = await getBroadcastStats(bc._id);
  ok(stats.summary.clicked === 2, `statistikada ham 2 (${stats.summary.clicked})`);
  const b1 = stats.byButton.find((b) => b.key === 'b1');
  const b2 = stats.byButton.find((b) => b.key === 'b2');
  ok(b1.count === 1 && b2.count === 1, `tugmalar bo‘yicha: ${b1.text}=${b1.count}, ${b2.text}=${b2.count}`);
  ok(stats.deliveries.length === 4, `har oluvchi uchun yozuv: ${stats.deliveries.length}`);
}

console.log('\n[4] Bloklagan xodim — qolganlar baribir oladi');
{
  blockedChat = '2001';
  const b = await BotBroadcast.create({ text: 'Ikkinchi xabar', target: 'all' });
  const stats = await sendBroadcast(b._id);
  take();
  ok(stats.sent === 3 && stats.failed === 1, `sent ${stats.sent}, failed ${stats.failed}`);

  const failed = await BotBroadcastDelivery.findOne({ broadcastId: b._id, status: 'failed' }).lean();
  ok(/blocked/i.test(failed.error), `sabab yozildi: ${failed.error.slice(0, 40)}`);
  const doc = await BotBroadcast.findById(b._id).lean();
  ok(doc.status === 'sent', 'bittasi yiqilsa ham umumiy holat: sent');
  blockedChat = null;
}

console.log('\n[5] TANLANGAN restoranlarga');
{
  const b = await BotBroadcast.create({
    text: 'Faqat Ziynatga', target: 'selected', restaurantIds: [r1._id],
  });
  const stats = await sendBroadcast(b._id);
  const sends = take().filter((c) => c.method === 'sendMessage');
  const chats = sends.map((c) => String(c.body.chat_id)).sort();
  ok(chats.join() === '1001,1002', `faqat Ziynat xodimlari: ${chats.join(', ')}`);
  ok(stats.sent === 2, `2 ta yuborildi (${stats.sent})`);
}

console.log('\n[6] Takroriy yuborish rad etiladi, yozuvlar ikkilanmaydi');
{
  let threw = false;
  try { await sendBroadcast(bc._id); } catch { threw = true; }
  ok(threw, 'yuborilgan xabarni qayta yuborib bo‘lmaydi');
  const count = await BotBroadcastDelivery.countDocuments({ broadcastId: bc._id });
  ok(count === 4, `yozuvlar soni o‘zgarmadi: ${count}`);
}

console.log('\n[7] Telegram "sekinlang" desa — kutib qayta yuboradi');
{
  rateLimitOnce = true;
  const b = await BotBroadcast.create({ text: '429 sinovi', target: 'selected', restaurantIds: [r2._id] });
  const stats = await sendBroadcast(b._id);
  take();
  ok(stats.sent === 1 && stats.failed === 0, `429 dan keyin yetkazildi (sent ${stats.sent})`);
}

console.log('\n[8] IZOLYATSIYA — boshqa oqimlarga tegmaydi');
{
  // Buyurtma tugmasi broadcast moduliga tushmasligi kerak
  const before = await BotBroadcastDelivery.countDocuments();
  await bot.handleRestaurantBotUpdate({
    callback_query: { id: 'x', from: { id: 1001 }, data: 'o:accept:507f1f77bcf86cd799439011', message: { message_id: 1 } },
  });
  await bot.handleRestaurantBotUpdate({
    callback_query: { id: 'y', from: { id: 1001 }, data: 'r:confirm:507f1f77bcf86cd799439011', message: { message_id: 1 } },
  });
  take();
  const after = await BotBroadcastDelivery.countDocuments();
  ok(before === after, 'buyurtma/bron tugmalari broadcast yozuvlariga tegmadi');

  // Broadcast tugmasi esa aynan shu modulga boradi
  const b = await BotBroadcast.create({
    text: 'Yo‘naltirish sinovi', target: 'selected', restaurantIds: [r1._id],
    buttons: [{ text: 'OK', kind: 'callback', key: 'b1' }],
  });
  await sendBroadcast(b._id); take();
  await bot.handleRestaurantBotUpdate({
    callback_query: { id: 'z', from: { id: 1001 }, data: `b:${b._id}:b1`, message: { message_id: 1 } },
  });
  const clicked = await BotBroadcastDelivery.findOne({ broadcastId: b._id, telegramUserId: '1001' }).lean();
  ok(clicked?.clickedAt, 'broadcast tugmasi to‘g‘ri modulga yo‘naltirildi');
}

console.log('\n[9] Chekka holatlar');
{
  let threw = false;
  try {
    const b = await BotBroadcast.create({ text: 'x', target: 'selected', restaurantIds: [] });
    await sendBroadcast(b._id);
  } catch { threw = true; }
  ok(threw, 'restoran tanlanmasa rad etiladi');

  // Oddiy matn rejimi — HTML belgilari ekranlanadi
  const b = await BotBroadcast.create({
    text: 'Narx < 5000 & "chegirma"', format: 'none',
    target: 'selected', restaurantIds: [r3._id],
  });
  await sendBroadcast(b._id);
  const sent = take().find((c) => c.method === 'sendMessage');
  ok(sent.body.text.includes('&lt; 5000 &amp;'), 'belgilar ekranlandi — xabar buzilmaydi');
}

await mongoose.disconnect();
console.log(fails ? `\n✗ ${fails} ta xato` : '\n✓ HAMMASI O‘TDI');
process.exit(fails ? 1 : 0);
