/*
 * ═══════════════════════════════════════════════════════════
 * RESTORANGA ESLATMA — BUYURTMA YAKUNLANMASDAN QOLIB KETMASIN
 * ═══════════════════════════════════════════════════════════
 * Vaqt `now` parametri bilan boshqariladi — soatlab kutilmaydi.
 * npm run test:reminders
 */
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/lokma_reminders';
process.env.RESTAURANT_BOT_TOKEN = '1:TEST';

const tgCalls = [];
globalThis.fetch = async (url, init) => {
  tgCalls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
  return { ok: true, json: async () => ({ ok: true, result: { message_id: Math.floor(Math.random() * 1e9) } }) };
};

const mongoose = (await import('mongoose')).default;
await mongoose.connect(process.env.MONGO_URI);
await mongoose.connection.db.dropDatabase();

const { Order } = await import('../src/models/Order.js');
const { Restaurant } = await import('../src/models/Restaurant.js');
const { RestaurantTelegramStaff } = await import('../src/models/RestaurantTelegramStaff.js');
const { checkRestaurantReminders, handleReminderCallback, planReminder } = await import('../src/services/restaurantReminders.js');
const { confirmOrderDelivered, handleDeliveryResponse } = await import('../src/services/deliveryCheck.js');

let fails = 0;
const ok = (c, m) => { console.log(c ? '  ✓' : '  ✗ FAIL:', m); if (!c) fails++; };
const MIN = 60_000; const HOUR = 60 * MIN;
const T0 = Date.now();
const ago = (ms) => new Date(T0 - ms);

const rid = new mongoose.Types.ObjectId();
await Restaurant.create({ _id: rid, name: 'R', cuisine: 'milliy', category: 'restoran', isActive: true });
await RestaurantTelegramStaff.create({ restaurantId: rid, telegramUserId: '555', firstName: 'Aziz', username: 'aziz', isActive: true, connectedAt: new Date() });
const staff = { _id: new mongoose.Types.ObjectId(), restaurantId: rid, firstName: 'Aziz' };

const cq = () => ({ id: `cq${Math.random()}`, from: { id: 555 }, message: { chat: { id: '555' }, message_id: 1 } });
const lastAlert = () => tgCalls.filter((c) => c.url.endsWith('/answerCallbackQuery')).at(-1)?.body?.text || '';
const remindersFor = (id) => tgCalls.filter((c) => c.url.endsWith('/sendMessage') && c.body?.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data === `o:remyes:${id}`);
const dues = (orderId) => mongoose.connection.db.collection('ledgers').countDocuments({ orderId, type: 'restaurant_due' });
const get = (id) => Order.findById(id).lean();

const base = (over) => ({
  userId: new mongoose.Types.ObjectId(), restaurantId: rid, restaurantName: 'R',
  items: [{ name: 'Osh', quantity: 1, unitPrice: 20000 }], subtotal: 20000, total: 20000,
  phone: '+998900000000', paymentMethod: 'cash', ...over,
});
const mk = (over) => Order.create(base(over));
// ESKI buyurtma: restaurantReminder maydoni UMUMAN yo'q (deploy'dan oldingi)
async function mkLegacy(over) {
  const doc = { _id: new mongoose.Types.ObjectId(), ...base(over), createdAt: ago(2 * HOUR), updatedAt: ago(2 * HOUR) };
  await mongoose.connection.db.collection('orders').insertOne(doc);
  return doc;
}

console.log('\n[1] Sof qaror (planReminder) — vaqt jadvali');
{
  const o = { fulfillment: 'delivery', status: 'ready', readyAt: ago(10 * MIN) };
  ok(planReminder(o, T0).action === 'none', '10 daq — hali erta');
  ok(planReminder({ ...o, readyAt: ago(31 * MIN) }, T0).action === 'ask', '31 daq — 1-eslatma');
  const r1 = { askedCount: 1, lastAskedAt: ago(31 * MIN), forStatus: 'ready' };
  ok(JSON.stringify(planReminder({ ...o, readyAt: ago(HOUR), restaurantReminder: r1 }, T0)) === '{"action":"ask","n":1}', '1-eslatmadan 31 daq — 2-eslatma');
  ok(planReminder({ ...o, readyAt: ago(HOUR), restaurantReminder: { ...r1, lastAskedAt: ago(10 * MIN) } }, T0).action === 'none', '1-eslatmadan 10 daq — kutadi');
  const r2 = { askedCount: 2, lastAskedAt: ago(4 * HOUR), forStatus: 'ready' };
  ok(planReminder({ ...o, readyAt: ago(13 * HOUR), restaurantReminder: r2 }, T0).action === 'auto', '13 soat + 2-eslatmadan 4 soat — avtomatik');
  ok(planReminder({ ...o, readyAt: ago(13 * HOUR), restaurantReminder: { ...r2, lastAskedAt: ago(HOUR) } }, T0).action === 'none', '2-eslatmadan 1 soat — hali javob kutiladi');
  ok(planReminder({ ...o, readyAt: ago(5 * HOUR), restaurantReminder: r2 }, T0).action === 'none', '5 soat — 12 soatgacha yakunlanmaydi');
  ok(planReminder({ fulfillment: 'delivery', status: 'delivering', deliveringAt: ago(20 * HOUR), restaurantReminder: { ...r2, forStatus: 'delivering' } }, T0).action === 'none',
    'yetkazish+delivering — avtomatik bu yerda EMAS (deliveryCheck.js qiladi)');
  ok(planReminder({ ...o, readyAt: ago(31 * MIN), restaurantReminder: { askedCount: 2, lastAskedAt: ago(HOUR), forStatus: 'accepted' } }, T0).action === 'ask',
    'xodim oldinga surdi (accepted→ready) — hisob noldan');
  ok(planReminder({ ...o, readyAt: ago(2 * HOUR), scheduledFor: new Date(T0 + 20 * HOUR) }, T0).action === 'none', 'ertangi rejalashtirilgan — so‘ralmaydi');
  ok(planReminder({ ...o, readyAt: ago(2 * HOUR), scheduledFor: ago(31 * MIN) }, T0).action === 'ask', 'rejalashtirilgan vaqtdan 31 daq — so‘raladi');
  for (const s of ['pending', 'cancelled', 'delivered', 'awaiting_payment']) {
    ok(planReminder({ ...o, status: s, readyAt: ago(20 * HOUR) }, T0).action === 'none', `${s} — tegilmaydi`);
  }
  ok(planReminder({ ...o, fulfillment: 'dinein', readyAt: ago(20 * HOUR) }, T0).action === 'none', 'zal (dinein) — tegilmaydi');
}

console.log('\n[2] ESKI buyurtma (maydon yo‘q), "Tayyor"da qotgan YETKAZIB BERISH — eslatma KELADI');
const legacy = await mkLegacy({ status: 'ready', fulfillment: 'delivery', address: 'X', dailyNumber: 12, readyAt: ago(40 * MIN) });
{
  tgCalls.length = 0;
  const r = await checkRestaurantReminders(T0);
  const msg = remindersFor(legacy._id)[0];
  ok(r.sent >= 1 && msg, 'eslatma yuborildi (avval hech qachon kelmasdi)');
  ok(msg.body.text.includes('#12') && msg.body.text.includes('yetkazildimi'), 'matn: raqam + "yetkazildimi"');
  ok(!msg.body.text.includes('avtomatik'), '1-eslatmada ogohlantirish yo‘q');
  const after = await get(legacy._id);
  ok(after.restaurantReminder.askedCount === 1 && after.restaurantReminder.forStatus === 'ready', 'askedCount=1, forStatus=ready');
  tgCalls.length = 0;
  await checkRestaurantReminders(T0 + 5 * MIN);
  ok(remindersFor(legacy._id).length === 0, '5 daqiqadan keyin takror YUBORILMAYDI');
}

console.log('\n[3] 2-eslatma — avtomatik yakunlash ogohlantirishi bilan');
{
  tgCalls.length = 0;
  await checkRestaurantReminders(T0 + 31 * MIN);
  const msg = remindersFor(legacy._id)[0];
  ok(msg && msg.body.text.includes('avtomatik'), '2-eslatmada ogohlantirish bor');
  ok((await get(legacy._id)).restaurantReminder.askedCount === 2, 'askedCount=2');
  tgCalls.length = 0;
  await checkRestaurantReminders(T0 + 2 * HOUR);
  ok(remindersFor(legacy._id).length === 0, '3-eslatma YO‘Q (faqat 2 marta)');
}

console.log('\n[4] Javob bo‘lmadi — 12 soat + 3 soat → AVTOMATIK yakunlanadi');
{
  await checkRestaurantReminders(T0 + 5 * HOUR);
  ok((await get(legacy._id)).status === 'ready', '5 soatda hali yakunlanmaydi');
  tgCalls.length = 0;
  const r = await checkRestaurantReminders(T0 + 13 * HOUR);
  const after = await get(legacy._id);
  ok(r.autoCompleted === 1 && after.status === 'delivered', `avtomatik yakunlandi: ${after.status}`);
  ok(after.deliveryCheck.confirmedBy === 'auto', 'confirmedBy=auto (manba aniq)');
  ok(await dues(legacy._id) === 1, 'komissiya hisoblandi');
  const cleared = tgCalls.filter((c) => c.url.endsWith('/editMessageReplyMarkup'));
  ok(cleared.length === 2, `ikkala eslatma nusxasidan tugmalar olindi (${cleared.length})`);
}

console.log('\n[5] "✅ Yakunlandi" — YETKAZIB BERISH ("Tayyor"dan)');
{
  const o = await mk({ status: 'ready', fulfillment: 'delivery', address: 'X', readyAt: ago(40 * MIN) });
  await checkRestaurantReminders(T0);
  tgCalls.length = 0;
  await handleReminderCallback(cq(), staff, 'remyes', String(o._id));
  const after = await get(o._id);
  ok(after.status === 'delivered' && after.deliveryCheck.confirmedBy === 'restaurant', `${after.status}/${after.deliveryCheck.confirmedBy}`);
  ok(after.deliveredAt instanceof Date, 'deliveredAt yozildi');
  ok(await dues(o._id) === 1, 'komissiya hisoblandi');
  ok(lastAlert().includes('Yakunlandi'), `xodimga: "${lastAlert()}"`);
}

console.log('\n[6] "✅ Yakunlandi" — OLIB KETISH "qabul qilindi" holatidan (avval xato berardi)');
{
  const o = await mk({ status: 'accepted', fulfillment: 'pickup', acceptedAt: ago(40 * MIN) });
  await handleReminderCallback(cq(), staff, 'remyes', String(o._id));
  ok((await get(o._id)).status === 'delivered' && await dues(o._id) === 1, 'yakunlandi, komissiya hisoblandi');
}

console.log('\n[7] "⏳ Jarayonda" — hech narsa o‘zgarmaydi');
{
  const o = await mk({ status: 'delivering', fulfillment: 'delivery', address: 'X', deliveringAt: ago(40 * MIN) });
  await handleReminderCallback(cq(), staff, 'remno', String(o._id));
  ok((await get(o._id)).status === 'delivering' && await dues(o._id) === 0, 'holat va pul o‘zgarmadi');
  ok(lastAlert().includes('Tushunarli'), `javob: "${lastAlert()}"`);
}

console.log('\n[8] XAVFSIZLIK: bekor qilingan buyurtma YAKUNLANMAYDI');
{
  const o = await mk({ status: 'cancelled', fulfillment: 'delivery', address: 'X' });
  await handleReminderCallback(cq(), staff, 'remyes', String(o._id));
  ok((await get(o._id)).status === 'cancelled' && await dues(o._id) === 0, 'bekor qilingan qoldi, pul yozilmadi');
  ok(lastAlert().includes('bekor'), `javob: "${lastAlert()}"`);

  const d = await mk({ status: 'delivered', fulfillment: 'delivery', address: 'X' });
  await handleReminderCallback(cq(), staff, 'remyes', String(d._id));
  ok(await dues(d._id) === 0, 'allaqachon yakunlanganga eski tugma — qayta hisoblanmadi');
}

console.log('\n[9] XAVFSIZLIK: boshqa restoran xodimi');
{
  const o = await mk({ status: 'ready', fulfillment: 'delivery', address: 'X' });
  await handleReminderCallback(cq(), { ...staff, restaurantId: new mongoose.Types.ObjectId() }, 'remyes', String(o._id));
  ok((await get(o._id)).status === 'ready', 'ta’sir qilolmadi');
  ok(lastAlert().includes('topilmadi'), `javob: "${lastAlert()}"`);
}

console.log('\n[10] MAVJUD XATO TUZATILDI: mijoz bekor qilingan buyurtmada "Oldim" bossa');
{
  const o = await mk({ status: 'cancelled', fulfillment: 'delivery', address: 'X' });
  await handleDeliveryResponse({ id: 'x', data: `dlv_got_${o._id}`, from: { id: 1 }, message: { chat: { id: 1 }, message_id: 1 } });
  ok((await get(o._id)).status === 'cancelled' && await dues(o._id) === 0, 'yetkazildi bo‘lmadi, komissiya hisoblanmadi');
  const g = await mk({ status: 'delivering', fulfillment: 'delivery', address: 'X' });
  await handleDeliveryResponse({ id: 'y', data: `dlv_got_${g._id}`, from: { id: 1 }, message: { chat: { id: 1 }, message_id: 1 } });
  const ga = await get(g._id);
  ok(ga.status === 'delivered' && ga.deliveryCheck.confirmedBy === 'customer' && await dues(g._id) === 1, 'odatiy "Oldim" avvalgidek ishlaydi');
}

console.log('\n[11] Mijoz VA restoran ikkalasi — pul BIR marta');
{
  const o = await mk({ status: 'delivering', fulfillment: 'delivery', address: 'X' });
  const [a, b] = await Promise.all([
    confirmOrderDelivered(o._id, 'customer'),
    confirmOrderDelivered(o._id, 'restaurant', { restaurantId: rid }),
  ]);
  ok(Boolean(a) !== Boolean(b), 'bir vaqtda — faqat BITTASI yakunladi');
  ok(await dues(o._id) === 1, 'komissiya 1 marta');
}

console.log('\n[12] Deploy: kunlar oldin qotib qolgan buyurtma — DARHOL yakunlanmaydi, avval so‘raladi');
{
  const old = await mkLegacy({ status: 'ready', fulfillment: 'pickup', readyAt: ago(3 * 24 * HOUR) });
  tgCalls.length = 0;
  const r = await checkRestaurantReminders(T0);
  ok(remindersFor(old._id).length === 1 && r.autoCompleted === 0, '1-tekshiruvda: eslatma, yakunlash YO‘Q');
  await checkRestaurantReminders(T0 + 31 * MIN);
  await checkRestaurantReminders(T0 + 2 * HOUR);
  ok((await get(old._id)).status === 'ready', '2-eslatmadan 1.5 soat — hali javob kutiladi');
  await checkRestaurantReminders(T0 + 31 * MIN + 3 * HOUR + MIN);
  ok((await get(old._id)).status === 'delivered', '2-eslatmadan 3 soat o‘tgach — yakunlandi');
}

console.log(fails ? `\n✗ ${fails} ta xato` : '\n✓ HAMMASI O‘TDI');
await mongoose.disconnect();
process.exit(fails ? 1 : 0);
