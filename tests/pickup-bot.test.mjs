/*
 * ═══════════════════════════════════════════════════════════
 * RESTORAN BOTI — "O'ZIM OLIB KETAMAN" BUYURTMALARI
 * ═══════════════════════════════════════════════════════════
 *
 * Tekshiriladi:
 *   - olib ketishda "Kuryerga ulashish" YO'Q, "Mijozga topshirildi" BOR
 *   - olib ketish + naqd + to'lanmagan → "💵 To'lov qilindi" BOR
 *   - to'langan / karta / yetkazib berish → to'lov tugmasi YO'Q
 *   - YETKAZIB BERISH oqimi o'zgarmagan (regressiya)
 *   - "To'lov qilindi" atomik: ikki marta bosilsa pul bir marta
 *     yoziladi, boshqa restoran xodimi bosa olmaydi
 *
 * npm run test:pickup
 */
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/lokma_pickup_bot';
// Soxta token: bot "yoqilgan" bo'lsin, lekin so'rovlar pastdagi soxta fetch'ga tushadi
process.env.RESTAURANT_BOT_TOKEN = '1:TEST';

// Telegram'ga haqiqiy so'rov ketmasin — javoblarni yig'amiz
const tgCalls = [];
globalThis.fetch = async (url, init) => {
  tgCalls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
  return { ok: true, json: async () => ({ ok: true, result: {} }) };
};

const mongoose = (await import('mongoose')).default;
await mongoose.connect(process.env.MONGO_URI);
await mongoose.connection.db.dropDatabase();

const { Order } = await import('../src/models/Order.js');
const { Ledger } = await import('../src/models/Ledger.js').catch(() => ({}));
const { buildOrderKeyboard, buildOrderText } = await import('../src/services/restaurantBotOrders.js');
const { handlePickupPaid, needsPickupCashPayment } = await import('../src/services/restaurantBotPickup.js');

let fails = 0;
const ok = (c, m) => { console.log(c ? '  ✓' : '  ✗ FAIL:', m); if (!c) fails++; };

const flat = (kb) => (kb?.inline_keyboard || []).flat();
const labels = (kb) => flat(kb).map((b) => b.text);
const has = (kb, part) => labels(kb).some((t) => t.includes(part));

const base = (over = {}) => ({
  _id: new mongoose.Types.ObjectId(),
  orderNumber: 1,
  items: [{ name: 'Rafaelo «Romantik»', quantity: 1, unitPrice: 150000 }],
  subtotal: 153750, total: 153750, deliveryFee: 0,
  phone: '+79060370050',
  ...over,
});

console.log('\n[1] OLIB KETISH + NAQD + to‘lanmagan — tugmalar');
for (const status of ['accepted', 'preparing']) {
  const o = base({ fulfillment: 'pickup', paymentMethod: 'cash', isPaid: false, status });
  const kb = buildOrderKeyboard(o);
  ok(has(kb, 'To‘lov qilindi'), `${status}: "To‘lov qilindi" bor`);
  ok(!has(kb, 'Kuryerga'), `${status}: kuryer tugmasi YO‘Q`);
  ok(has(kb, 'Tayyor'), `${status}: "Tayyor" bor`);
}
{
  const o = base({ fulfillment: 'pickup', paymentMethod: 'cash', isPaid: false, status: 'ready' });
  const kb = buildOrderKeyboard(o);
  ok(has(kb, 'To‘lov qilindi'), 'ready: "To‘lov qilindi" bor');
  ok(has(kb, 'Mijozga topshirildi'), 'ready: "Mijozga topshirildi" bor');
  ok(!has(kb, 'Kuryerga ulashish') && !has(kb, 'Kuryerga topshirildi'), 'ready: kuryer tugmalari YO‘Q');
  ok(labels(kb)[0].includes('To‘lov'), 'to‘lov tugmasi birinchi qatorda');
  const handover = flat(kb).find((b) => b.text.includes('Mijozga topshirildi'));
  ok(handover?.callback_data === `o:handover:${o._id}`, '"Mijozga topshirildi" → o:handover (yakunlaydi)');
}
{
  const o = base({ fulfillment: 'pickup', paymentMethod: 'cash', isPaid: false, status: 'delivered' });
  const kb = buildOrderKeyboard(o);
  ok(labels(kb).length === 1 && has(kb, 'To‘lov qilindi'),
    'topshirilgach (delivered) to‘lanmagan bo‘lsa — faqat "To‘lov qilindi" qoladi');
}
{
  const o = base({ fulfillment: 'pickup', paymentMethod: 'cash', isPaid: false, status: 'delivering' });
  const kb = buildOrderKeyboard(o);
  ok(has(kb, 'To‘lov qilindi') && has(kb, 'Yakunlash'),
    'eski yo‘l (delivering) — to‘lov + "Yakunlash" bor, osilib qolmaydi');
}

console.log('\n[2] To‘lov tugmasi KERAK BO‘LMAGAN holatlar');
{
  const paid = base({ fulfillment: 'pickup', paymentMethod: 'cash', isPaid: true, status: 'ready' });
  ok(!has(buildOrderKeyboard(paid), 'To‘lov'), 'to‘langan — yo‘q');
  ok(has(buildOrderKeyboard(paid), 'Mijozga topshirildi'), 'to‘langan — "Mijozga topshirildi" hali bor');

  const card = base({ fulfillment: 'pickup', paymentMethod: 'payme', isPaid: false, status: 'ready' });
  ok(!has(buildOrderKeyboard(card), 'To‘lov'), 'karta to‘lovi — yo‘q (onlayn to‘lanadi)');

  const pending = base({ fulfillment: 'pickup', paymentMethod: 'cash', isPaid: false, status: 'pending' });
  ok(!has(buildOrderKeyboard(pending), 'To‘lov'), 'hali qabul qilinmagan — yo‘q');

  const cancelled = base({ fulfillment: 'pickup', paymentMethod: 'cash', isPaid: false, status: 'cancelled' });
  ok(buildOrderKeyboard(cancelled) === null, 'bekor qilingan — tugmasiz');

  const paidDelivered = base({ fulfillment: 'pickup', paymentMethod: 'cash', isPaid: true, status: 'delivered' });
  ok(buildOrderKeyboard(paidDelivered) === null, 'topshirilgan (delivered) va to‘langan — tugmasiz');
  ok(buildOrderText(paidDelivered).includes('Mijozga topshirildi'), 'delivered matni: "Mijozga topshirildi"');

  const cardDelivered = base({ fulfillment: 'pickup', paymentMethod: 'payme', isPaid: true, status: 'delivered' });
  ok(buildOrderKeyboard(cardDelivered) === null, 'karta bilan yakunlangan — tugmasiz');
}

console.log('\n[3] REGRESSIYA: YETKAZIB BERISH oqimi o‘zgarmagan');
{
  const acc = base({ fulfillment: 'delivery', paymentMethod: 'cash', isPaid: false, status: 'accepted' });
  ok(has(buildOrderKeyboard(acc), 'Kuryerga ulashish'), 'accepted: "Kuryerga ulashish" bor');
  ok(!has(buildOrderKeyboard(acc), 'To‘lov'), 'accepted: to‘lov tugmasi YO‘Q (naqdni kuryer oladi)');

  const rdy = base({ fulfillment: 'delivery', paymentMethod: 'cash', isPaid: false, status: 'ready' });
  ok(has(buildOrderKeyboard(rdy), 'Kuryerga topshirildi'), 'ready: "Kuryerga topshirildi" bor');
  ok(!has(buildOrderKeyboard(rdy), 'Mijozga'), 'ready: "Mijozga topshirildi" YO‘Q');

  const dlv = base({ fulfillment: 'delivery', paymentMethod: 'cash', isPaid: false, status: 'delivering' });
  ok(buildOrderKeyboard(dlv) === null, 'delivering: avvalgidek tugmasiz');
  ok(buildOrderText(dlv).includes('Kuryer yo‘lda'), 'delivering matni: "Kuryer yo‘lda"');
}

console.log('\n[4] Karta matni — olib ketish');
{
  const o = base({ fulfillment: 'pickup', paymentMethod: 'cash', isPaid: false, status: 'delivering', address: 'Uy — улица Сохил' });
  const text = buildOrderText(o);
  ok(text.includes('Mijozga topshirildi'), 'status: "Mijozga topshirildi"');
  ok(!text.includes('Kuryer'), '"Kuryer" so‘zi umuman yo‘q');
  ok(text.includes('Mijoz o‘zi olib ketadi'), '"Mijoz o‘zi olib ketadi" ko‘rsatilgan');
  ok(!text.includes('улица Сохил'), 'manzil ko‘rsatilmaydi');
  ok(text.includes('Naqd · To‘lanmagan'), 'to‘lov holati: "Naqd · To‘lanmagan"');
  ok(buildOrderText({ ...o, isPaid: true }).includes('Naqd · To‘langan'), 'to‘langach: "Naqd · To‘langan"');
}

/* ═══ ATOMIK TO'LOV — bazada ═══ */
const rid = new mongoose.Types.ObjectId();
const otherRid = new mongoose.Types.ObjectId();
const staff = { _id: new mongoose.Types.ObjectId(), restaurantId: rid, firstName: 'Azimjon' };
const stranger = { _id: new mongoose.Types.ObjectId(), restaurantId: otherRid, firstName: 'Begona' };
const cq = () => ({ id: `cq${Math.random()}` });
const alertTexts = () => tgCalls.filter((c) => c.url.endsWith('/answerCallbackQuery')).map((c) => c.body?.text || '');

const mk = (over) => Order.create({
  userId: new mongoose.Types.ObjectId(), restaurantId: rid, restaurantName: 'R',
  items: [{ name: 'Tort', quantity: 1, unitPrice: 150000 }],
  subtotal: 150000, total: 150000, status: 'ready',
  fulfillment: 'pickup', paymentMethod: 'cash', isPaid: false, phone: '+998900000000',
  ...over,
});
const ledgerCount = async (orderId) => (Ledger
  ? Ledger.countDocuments({ orderId, type: 'payment_in' })
  : mongoose.connection.db.collection('ledgers').countDocuments({ orderId, type: 'payment_in' }));

console.log('\n[5] "To‘lov qilindi" — bazada');
{
  const o = await mk();
  ok(needsPickupCashPayment(o.toObject()), 'boshida tugma kerak');

  await handlePickupPaid(cq(), staff, String(o._id));
  const after = await Order.findById(o._id).lean();
  ok(after.isPaid === true && after.paidAt instanceof Date, 'isPaid=true, paidAt yozildi');
  ok(after.status === 'ready', 'status O‘ZGARMADI (to‘lov ≠ topshirish)');
  ok(await ledgerCount(o._id) === 1, 'moliya jurnaliga 1 ta to‘lov yozildi');
  ok(alertTexts().at(-1).includes('To‘lov qabul qilindi'), 'xodimga: "To‘lov qabul qilindi"');

  await handlePickupPaid(cq(), staff, String(o._id));
  ok(await ledgerCount(o._id) === 1, 'IKKINCHI bosish — jurnalda hamon 1 ta (ikki marta yozilmadi)');
  ok(alertTexts().at(-1).includes('allaqachon'), 'ikkinchi bosishda: "allaqachon belgilangan"');
}

console.log('\n[6] Xavfsizlik va chegaralar');
{
  const o = await mk();
  await handlePickupPaid(cq(), stranger, String(o._id));
  ok((await Order.findById(o._id).lean()).isPaid === false, 'BOSHQA restoran xodimi belgilay olmaydi');

  const dlv = await mk({ fulfillment: 'delivery', address: 'Manzil' });
  await handlePickupPaid(cq(), staff, String(dlv._id));
  ok((await Order.findById(dlv._id).lean()).isPaid === false, 'yetkazib berish buyurtmasiga ta‘sir qilmaydi');

  const card = await mk({ paymentMethod: 'payme' });
  await handlePickupPaid(cq(), staff, String(card._id));
  ok((await Order.findById(card._id).lean()).isPaid === false, 'karta buyurtmasiga ta‘sir qilmaydi');

  const cancelled = await mk({ status: 'cancelled' });
  await handlePickupPaid(cq(), staff, String(cancelled._id));
  ok((await Order.findById(cancelled._id).lean()).isPaid === false, 'bekor qilingan buyurtmaga ta‘sir qilmaydi');
}

/* ═══ YAKUNLASH — orderFlow.changeOrderStatus (bazada) ═══ */
const { changeOrderStatus } = await import('../src/services/orderFlow.js');
const { Restaurant } = await import('../src/models/Restaurant.js');
await Restaurant.create({ _id: rid, name: 'R', cuisine: 'milliy', category: 'restoran', isActive: true });
const dueCount = async (orderId) => mongoose.connection.db.collection('ledgers')
  .countDocuments({ orderId, type: 'restaurant_due' });
const wait = (ms = 300) => new Promise((r) => setTimeout(r, ms));

console.log('\n[7] Olib ketish: "Mijozga topshirildi" buyurtmani YAKUNLAYDI');
{
  const o = await mk();
  const { order, changed } = await changeOrderStatus({ orderId: o._id, restaurantId: rid, status: 'delivered' });
  ok(changed && order.status === 'delivered', `ready → delivered: ${order.status}`);
  ok(order.deliveredAt instanceof Date, 'deliveredAt yozildi');
  await wait();
  ok(await dueCount(o._id) === 1, 'komissiya DARHOL hisoblandi (restaurant_due yozuvi bor)');

  // Yakunlangandan KEYIN pul olindi — to'lov baribir qayd qilinadi
  await handlePickupPaid(cq(), staff, String(o._id));
  const after = await Order.findById(o._id).lean();
  ok(after.isPaid === true && after.status === 'delivered', 'yakunlangach ham "To‘lov qilindi" ishlaydi');
  ok(await ledgerCount(o._id) === 1, 'to‘lov jurnalga 1 marta tushdi');
  ok(await dueCount(o._id) === 1, 'komissiya QAYTA hisoblanmadi');
}
{
  const o = await mk({ status: 'delivering' });
  const { order } = await changeOrderStatus({ orderId: o._id, restaurantId: rid, status: 'delivered' });
  ok(order.status === 'delivered', 'eski yo‘l: delivering → delivered ham ishlaydi');
}

console.log('\n[8] XAVFSIZLIK: yetkazib berishni restoran YAKUNLAY OLMAYDI');
{
  const o = await mk({ fulfillment: 'delivery', address: 'Manzil' });
  let err = null;
  try { await changeOrderStatus({ orderId: o._id, restaurantId: rid, status: 'delivered' }); } catch (e) { err = e; }
  ok(err?.code === 'WRONG_STATE', `rad etildi: ${err?.code}`);
  const after = await Order.findById(o._id).lean();
  ok(after.status === 'ready' && !after.deliveredAt, 'buyurtma o‘zgarmagan');
  await wait();
  ok(await dueCount(o._id) === 0, 'komissiya hisoblanmagan');

  const d = await mk({ fulfillment: 'delivery', address: 'Manzil', status: 'delivering' });
  err = null;
  try { await changeOrderStatus({ orderId: d._id, restaurantId: rid, status: 'delivered' }); } catch (e) { err = e; }
  ok(err?.code === 'WRONG_STATE', 'kuryer yo‘ldagi buyurtmani ham yakunlab bo‘lmaydi');

  const early = await mk({ status: 'accepted' });
  err = null;
  try { await changeOrderStatus({ orderId: early._id, restaurantId: rid, status: 'delivered' }); } catch (e) { err = e; }
  ok(err?.code === 'WRONG_STATE', 'pickup ham TAYYOR bo‘lmasdan yakunlanmaydi');

  const other = await mk();
  err = null;
  try { await changeOrderStatus({ orderId: other._id, restaurantId: otherRid, status: 'delivered' }); } catch (e) { err = e; }
  ok(err?.code === 'NOT_FOUND', 'boshqa restoran yakunlay olmaydi');
}

console.log(fails ? `\n✗ ${fails} ta xato` : '\n✓ HAMMASI O‘TDI');
await mongoose.disconnect();
process.exit(fails ? 1 : 0);
