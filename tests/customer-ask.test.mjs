/*
 * ═══════════════════════════════════════════════════════════
 * MIJOZGA "QABUL QILDINGIZMI?" — qabul qilingan, lekin yakunlanmagan buyurtma
 * ═══════════════════════════════════════════════════════════
 * Baza KERAK EMAS: modellar soxta (stub), vaqt `now` parametri bilan boshqariladi.
 * npm run test:customer-ask
 */
process.env.TELEGRAM_BOT_TOKEN = '1:TEST';
process.env.RESTAURANT_BOT_TOKEN = '2:TEST';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(40);

const tgCalls = [];
let tgOk = true;
globalThis.fetch = async (url, init) => {
  tgCalls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
  return { ok: true, json: async () => (tgOk ? { ok: true, result: { message_id: 1 } } : { ok: false, description: 'Forbidden: bot was blocked' }) };
};

const { Order } = await import('../src/models/Order.js');
const { User } = await import('../src/models/User.js');
const { planCustomerAsk, CUSTOMER_ASK } = await import('../src/services/reminderRules.js');
const { checkDeliveries } = await import('../src/services/deliveryCheck.js');
const { checkRestaurantReminders } = await import('../src/services/restaurantReminders.js');
const { RestaurantBotMessage } = await import('../src/models/RestaurantBotMessage.js');
const { RestaurantTelegramStaff } = await import('../src/models/RestaurantTelegramStaff.js');

let fails = 0;
const ok = (c, m) => { console.log(c ? '  ✓' : '  ✗ FAIL:', m); if (!c) fails++; };
const MIN = 60_000; const HOUR = 60 * MIN;
const T0 = Date.now();
const ago = (ms) => new Date(T0 - ms);
const ahead = (ms) => new Date(T0 + ms);

let seq = 0;
const mk = (over = {}) => ({
  _id: `o${++seq}`.padEnd(24, '0'), userId: 'u1', restaurantId: 'r1', restaurantName: 'Osiyo <kafe>', dailyNumber: 7,
  status: 'ready', fulfillment: 'delivery', acceptedAt: ago(61 * MIN), createdAt: ago(70 * MIN), updatedAt: ago(30 * MIN),
  deliveryCheck: { askedCount: 0, lastAskedAt: null, confirmed: false }, ...over,
});

console.log('\n[1] Sof qoida — planCustomerAsk');
{
  ok(planCustomerAsk(mk(), T0).ask === true, 'qabuldan 61 daq, "Tayyor" — so‘raladi');
  ok(planCustomerAsk(mk({ acceptedAt: ago(59 * MIN) }), T0).ask === false, '59 daq — hali erta');
  ok(planCustomerAsk(mk({ status: 'accepted' }), T0).ask === true, '"accepted" holati ham so‘raladi');
  ok(planCustomerAsk(mk({ status: 'preparing' }), T0).ask === true, '"preparing" holati ham so‘raladi');
  ok(planCustomerAsk(mk({ status: 'delivered' }), T0).ask === false, 'yetkazilgan — so‘ralmaydi');
  ok(planCustomerAsk(mk({ status: 'cancelled' }), T0).ask === false, 'bekor — so‘ralmaydi');
  ok(planCustomerAsk(mk({ status: 'pending' }), T0).ask === false, 'hali qabul qilinmagan — so‘ralmaydi');
  ok(planCustomerAsk(mk({ fulfillment: 'pickup' }), T0).ask === false, 'olib ketish (qabul/tayyor) — mijozdan so‘ralmaydi');
  ok(planCustomerAsk(mk({ fulfillment: 'dinein', userId: null }), T0).ask === false, 'zal buyurtmasi — so‘ralmaydi');
  ok(planCustomerAsk(mk({ userId: null }), T0).ask === false, 'mijoz hisobi yo‘q — so‘ralmaydi');
  ok(planCustomerAsk(mk({ deliveryCheck: { askedCount: 0, confirmed: true } }), T0).ask === false, 'tasdiqlangan — so‘ralmaydi');
  ok(planCustomerAsk(mk({ deliveryCheck: undefined }), T0).ask === true, 'ESKI buyurtma (deliveryCheck yo‘q) — so‘raladi');
  ok(planCustomerAsk(mk({ deliveryCheck: { askedCount: 1, lastAskedAt: ago(5 * MIN) } }), T0).ask === false, '1-so‘rovdan 5 daq — kutadi');
  ok(planCustomerAsk(mk({ deliveryCheck: { askedCount: 1, lastAskedAt: ago(11 * MIN) } }), T0).ask === true, '1-so‘rovdan 11 daq — 2-so‘rov');
  ok(planCustomerAsk(mk({ deliveryCheck: { askedCount: 2, lastAskedAt: ago(20 * MIN) } }), T0).ask === false, '2-so‘rovdan 20 daq — kutadi (30 kerak)');
  ok(planCustomerAsk(mk({ deliveryCheck: { askedCount: 2, lastAskedAt: ago(31 * MIN) } }), T0).ask === true, '2-so‘rovdan 31 daq — 3-so‘rov');
  ok(planCustomerAsk(mk({ deliveryCheck: { askedCount: 3, lastAskedAt: ago(5 * HOUR) } }), T0).ask === false, '3 martadan ortiq so‘ralmaydi');
  ok(planCustomerAsk(mk({ scheduledFor: ahead(2 * HOUR), acceptedAt: ago(3 * HOUR) }), T0).ask === false, 'ertangi/rejalashtirilgan — vaqti kelmaguncha so‘ralmaydi');
  ok(planCustomerAsk(mk({ scheduledFor: ago(61 * MIN), acceptedAt: ago(20 * HOUR) }), T0).ask === true, 'rejalashtirilgan vaqtdan 61 daq — so‘raladi');
  // delivering — AVVALGI xatti-harakat saqlangan
  const dl = { status: 'delivering', acceptedAt: ago(5 * HOUR), updatedAt: ago(25 * MIN), createdAt: ago(5 * HOUR) };
  ok(planCustomerAsk(mk(dl), T0).ask === true, 'yo‘lda: kuryer olib ketganidan 25 daq — so‘raladi (avvalgidek)');
  ok(planCustomerAsk(mk({ ...dl, updatedAt: ago(10 * MIN) }), T0).ask === false, 'yo‘lda: 10 daq — kuryerga vaqt beriladi (qabuldan 5 soat o‘tgan bo‘lsa ham)');
  ok(planCustomerAsk(mk({ ...dl, fulfillment: 'pickup' }), T0).ask === true, 'eski delivering yo‘li (pickup ham) o‘zgarmagan');
  ok(CUSTOMER_ASK.firstAfterAcceptMin === 60, 'birinchi so‘rov — qabuldan 60 daqiqa');
}

// ── Soxta modellar ──
let deliveringList = []; let stuckList = []; let claimResult = true;
const claims = []; const updates = [];
const chain = (result) => { const c = { limit: () => c, select: () => c, sort: () => c, lean: () => c, then: (a, b) => Promise.resolve(result).then(a, b) }; return c; };
Order.find = (f) => {
  if (f.status === 'delivering' && f.createdAt?.$gte) return chain(deliveringList);
  if (f.status?.$in?.includes('accepted')) return chain(stuckList);
  return chain([]); // 12 soatdan oshgan "stale" — bo'sh
};
Order.findOneAndUpdate = async (f, u) => { claims.push({ f, u }); return claimResult ? { _id: f._id } : null; };
Order.updateOne = async (f, u) => { updates.push({ f, u }); return { modifiedCount: 1 }; };
User.findById = () => chain({ telegramId: '777' });
const sent = () => tgCalls.filter((c) => c.url.endsWith('/sendMessage'));
const reset = () => { tgCalls.length = 0; claims.length = 0; updates.length = 0; tgOk = true; claimResult = true; };

console.log('\n[2] checkDeliveries — qabul qilingan, yakunlanmagan buyurtma: mijozga bot xabari');
{
  reset();
  const o = mk(); stuckList = [o]; deliveringList = [];
  const r = await checkDeliveries(T0);
  const m = sent()[0];
  ok(r.sent === 1 && m, 'xabar yuborildi');
  ok(m.body.chat_id === '777', 'mijozning Telegram ID’siga');
  ok(m.body.text.includes('qabul qildingizmi') && m.body.text.includes('#7'), 'matn: "qabul qildingizmi" + buyurtma raqami');
  ok(m.body.text.includes('&lt;kafe&gt;') && !m.body.text.includes('<kafe>'), 'restoran nomi HTML’dan xavfsiz (escape)');
  const kb = m.body.reply_markup.inline_keyboard[0];
  ok(kb[0].text === '✅ Ha, qabul qildim' && kb[0].callback_data === `dlv_got_${o._id}`, 'tugma 1: "Ha, qabul qildim" → dlv_got (mavjud tasdiqlash yo‘li)');
  ok(kb[1].text === '⏳ Kutyapman' && kb[1].callback_data === `dlv_not_${o._id}`, 'tugma 2: "Kutyapman" → dlv_not');
  ok(claims.length === 1 && claims[0].u.$set['deliveryCheck.askedCount'] === 1, 'hisoblagich atomik band qilindi (askedCount=1)');
  ok(claims[0].f['deliveryCheck.askedCount'].$not?.$gte === 1, 'band qilish sharti: hali so‘ralmagan (ikki marta yuborilmaydi)');
}
{
  reset();
  stuckList = [mk({ acceptedAt: ago(50 * MIN) })]; deliveringList = [];
  const r = await checkDeliveries(T0);
  ok(r.sent === 0 && sent().length === 0, '50 daqiqada — xabar YO‘Q');
}
{
  reset();
  stuckList = [mk()]; claimResult = false;
  const r = await checkDeliveries(T0);
  ok(r.sent === 0 && sent().length === 0, 'boshqa jarayon band qilgan (yoki buyurtma orada yakunlangan) — xabar yuborilmaydi');
}
{
  reset();
  stuckList = [mk()]; tgOk = false;
  const r = await checkDeliveries(T0);
  ok(r.sent === 0 && updates.length === 1 && updates[0].u.$set['deliveryCheck.askedCount'] === 0, 'Telegram xatosi — hisoblagich qaytariladi, keyin qayta uriniladi');
}

console.log('\n[3] "Yo‘lda" (delivering) — eski yo‘l ishlayveradi, yangi matn/tugmalar bilan');
{
  reset();
  const o = mk({ status: 'delivering', acceptedAt: ago(5 * HOUR), updatedAt: ago(25 * MIN), createdAt: ago(5 * HOUR) });
  deliveringList = [o]; stuckList = [];
  const r = await checkDeliveries(T0);
  ok(r.sent === 1 && sent()[0].body.reply_markup.inline_keyboard[0][0].callback_data === `dlv_got_${o._id}`, 'delivering: so‘rov yuborildi (dlv_got/dlv_not)');
  deliveringList = [mk({ status: 'delivering', updatedAt: ago(5 * MIN) })];
  reset();
  ok((await checkDeliveries(T0)).sent === 0, 'delivering 5 daq — hali erta');
}

console.log('\n[4] RESTORAN BOTI — eslatma buyurtma kartasiga JAVOB (reply) sifatida, "Ha, yetkazildi" / "Jarayonda"');
{
  reset();
  const o = mk({ status: 'ready', readyAt: ago(31 * MIN), restaurantReminder: undefined });
  Order.find = () => chain([o]);
  RestaurantTelegramStaff.find = () => chain([{ telegramUserId: '555' }, { telegramUserId: '556' }]);
  // 555 uchun karta xabari saqlangan (id 4242); 556 uchun karta yo'q (TTL o'tgan)
  RestaurantBotMessage.find = () => chain([{ telegramUserId: '555', messageId: 4242, kind: 'order' }]);
  RestaurantBotMessage.create = async () => ({});
  Order.updateOne = async (f, u) => { updates.push({ f, u }); return {}; };
  const r = await checkRestaurantReminders(T0);
  const calls = tgCalls.filter((c) => c.url.includes('bot2:TEST') && c.url.endsWith('/sendMessage'));
  const to555 = calls.find((c) => String(c.body.chat_id) === '555');
  const to556 = calls.find((c) => String(c.body.chat_id) === '556');
  ok(r.sent === 1 && calls.length === 2, 'ikkala xodimga eslatma yuborildi');
  ok(to555?.body.reply_parameters?.message_id === 4242, 'xodim 555: eslatma buyurtma kartasiga JAVOB sifatida (tanlangan holda)');
  ok(to555?.body.reply_parameters?.allow_sending_without_reply === true, 'karta o‘chirilgan bo‘lsa ham xabar yetkaziladi');
  ok(to556 && !to556.body.reply_parameters, 'karta topilmasa (24 soatdan eski) — oddiy xabar');
  const kb = to555.body.reply_markup.inline_keyboard[0];
  ok(kb[0].text.includes('Ha, yetkazildi') && kb[0].callback_data === `o:remyes:${o._id}`, 'tugma: "Ha, yetkazildi" (callback o:remyes o‘zgarmagan)');
  ok(kb[1].text.includes('Jarayonda') && kb[1].callback_data === `o:remno:${o._id}`, 'tugma: "Jarayonda" (callback o:remno o‘zgarmagan)');
  ok(to555.body.text.includes('yetkazildimi') && to555.body.text.includes('#7'), 'matn: buyurtma raqami + "yetkazildimi"');
}
{
  reset();
  const p = mk({ status: 'ready', fulfillment: 'pickup', readyAt: ago(31 * MIN) });
  Order.find = () => chain([p]);
  RestaurantBotMessage.find = () => chain([]);
  await checkRestaurantReminders(T0);
  const m = tgCalls.find((c) => c.url.includes('bot2:TEST') && c.url.endsWith('/sendMessage'));
  ok(m?.body.reply_markup.inline_keyboard[0][0].text.includes('olib ketildi'), 'olib ketish (pickup): "Ha, olib ketildi"');
}

console.log(fails ? `\n✗ ${fails} ta xato` : '\n✓ Hammasi o‘tdi');
process.exit(fails ? 1 : 0);
