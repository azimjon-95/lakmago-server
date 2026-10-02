/*
 * ═══════════════════════════════════════════════════════════
 * NAQD TO'LOV: MIJOZ BILAN TASDIQLASH + YAKUNLANGANDA AVTOMATIK "TO'LANGAN"
 * ═══════════════════════════════════════════════════════════
 * 1) Yangi NAQD buyurtmada (bot matni): katta "TO'LOV TURI: NAQD" va "mijoz bilan
 *    gaplashib tasdiqlatib oling"; qabul qilish imkoni saqlanadi.
 * 2) Qo'lda "to'lov qabul qilindi" tugmalari YO'Q.
 * 3) Buyurtma yakunlanganda — QAYSI YO'L bilan bo'lmasin (restoran/bot, kuryer,
 *    mijoz botda, mijoz ilovada, avto-yakunlash) — naqd AVTOMATIK to'langan:
 *    isPaid + paidAt + moliya jurnali (payment_in) bir marta.
 * HAQIQIY funksiyalar chaqiriladi (changeOrderStatus, courierDispatch, deliveryCheck,
 * controller'lar). npm run test:cash
 */
process.env.MONGO_URI = 'mongodb://127.0.0.1:27017/lokma_cash_payment';
process.env.TELEGRAM_BOT_TOKEN = '1:T';
process.env.RESTAURANT_BOT_TOKEN = '1:R';
process.env.JWT_SECRET = 'x'.repeat(40);

globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 1 } }) });

const mongoose = (await import('mongoose')).default;
await mongoose.connect(process.env.MONGO_URI);
await mongoose.connection.db.dropDatabase();

const { Order } = await import('../src/models/Order.js');
const { Ledger } = await import('../src/models/Ledger.js');
const { Restaurant } = await import('../src/models/Restaurant.js');
const { User } = await import('../src/models/User.js');
const { buildOrderText, buildOrderKeyboard } = await import('../src/services/restaurantBotOrders.js');
const { settleOrder, finalizeCashPayment } = await import('../src/services/billing.js');
const { changeOrderStatus } = await import('../src/services/orderFlow.js');
const { createShareLink, acceptShare, deliverShare } = await import('../src/services/courierDispatch.js');
const { confirmOrderDelivered, checkDeliveries } = await import('../src/services/deliveryCheck.js');
const { orderController } = await import('../src/controllers/misc.js');
const { restaurantPanelController } = await import('../src/controllers/restaurantPanel.js');

let fails = 0;
const ok = (c, m) => { console.log(c ? '  ✓' : '  ✗ FAIL:', m); if (!c) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const call = async (fn, req) => {
  let status = 200; let body = null;
  const res = { status(c) { status = c; return this; }, json(b) { body = b; return this; } };
  await fn(req, res, (e) => { body = { next: e?.message }; status = 500; });
  await sleep(500); // asyncHandler promise qaytarmaydi; settleOrder fonda
  return { status, body };
};

const R = await Restaurant.create({ name: 'TOTLI', cuisine: 'x', category: 'restoran', isActive: true, isApproved: true });
const user = await User.create({ firstName: 'Azim', telegramId: '9001', phone: '+998901112233' });
const other = await User.create({ firstName: 'Begona', telegramId: '9002' });

const mk = (over = {}) => Order.create({
  userId: user._id, restaurantId: R._id, restaurantName: 'TOTLI', items: [{ name: 'Pasta', quantity: 1, unitPrice: 10000 }],
  subtotal: 10000, total: 10250, deliveryFee: 0, status: 'ready', fulfillment: 'delivery', address: 'Uy', phone: '+998901112233',
  paymentMethod: 'cash', isPaid: false, ...over,
});
const state = async (id) => {
  const o = await Order.findById(id).lean();
  return {
    o,
    payIn: await Ledger.countDocuments({ orderId: id, type: 'payment_in' }),
    due: await Ledger.countDocuments({ orderId: id, type: 'restaurant_due' }),
  };
};
const aged = (id, hours) => Order.collection.updateOne({ _id: id }, { $set: { createdAt: new Date(Date.now() - hours * 3_600_000), updatedAt: new Date(Date.now() - hours * 3_600_000) } });

const flat = (kb) => (kb?.inline_keyboard || []).flat();
const labels = (kb) => flat(kb).map((b) => b.text);
const textOf = (o) => buildOrderText(o.toObject ? o.toObject() : o).replace(/<\/?b>|<\/?i>/g, '');

console.log('\n[1] BOT MATNI: yangi NAQD buyurtma — katta "NAQD" va mijoz bilan tasdiqlash ogohlantirishi');
{
  for (const fulfillment of ['delivery', 'pickup']) {
    const o = await mk({ status: 'pending', fulfillment });
    const t = textOf(o);
    const lines = t.split('\n');
    ok(lines[0].startsWith('🔔 BUYURTMA') && lines[1] === '💵 TO‘LOV TURI: NAQD', `${fulfillment}: 2-qator (sarlavha tagida) — "💵 TO‘LOV TURI: NAQD"`);
    ok(/mijoz bilan gaplashib, buyurtmani tasdiqlatib oling/.test(t) && /To‘lov turi: NAQD\./.test(t), `${fulfillment}: "mijoz bilan gaplashib, buyurtmani tasdiqlatib oling" ogohlantirishi bor`);
    ok(/qabul qiling/.test(t), `${fulfillment}: "keyin qabul qiling" — qabul qilish imkoni aytilgan`);
    const iPhone = t.indexOf('📞'); const iWarn = t.indexOf('⚠️');
    ok(iWarn > iPhone && iWarn === t.lastIndexOf('⚠️') && t.slice(iWarn).split('\n').length <= 2, `${fulfillment}: ogohlantirish matnning OXIRIDA — "Qabul qilish" tugmasi tepasida`);
    ok((t.match(/NAQD/g) || []).length === 2, `${fulfillment}: "NAQD" tepada va pastda (ortiqcha takror yo‘q)`);
    const kb = buildOrderKeyboard(o.toObject());
    ok(labels(kb).length === 2 && labels(kb)[0].includes('Qabul qilish') && labels(kb)[1].includes('Rad etish'), `${fulfillment}: tugmalar — "Qabul qilish" va "Rad etish" (xohlasa qabul qiladi)`);
  }
  const card = textOf(await mk({ status: 'pending', paymentMethod: 'payme', isPaid: true }));
  ok(!card.includes('NAQD') && !card.includes('⚠️') && card.includes('💳 Karta · To‘langan'), 'KARTA buyurtmada ogohlantirish YO‘Q ("💳 Karta · To‘langan")');
  const acc = textOf(await mk({ status: 'accepted' }));
  ok(!acc.includes('NAQD') && !acc.includes('⚠️') && acc.includes('💵 Naqd · to‘lov topshirilganda'), 'qabul qilingandan keyin ogohlantirish yo‘q; "Naqd · to‘lov topshirilganda"');
  ok(!acc.includes('To‘lanmagan'), '"To‘lanmagan" deb qo‘rqitilmaydi');
  const done = textOf(await mk({ status: 'delivered', isPaid: true }));
  ok(done.includes('💵 Naqd · To‘langan') && !done.includes('⚠️'), 'yakunlangan: "Naqd · To‘langan"');
  const sched = textOf(await mk({ status: 'pending', timingMode: 'scheduled', scheduledFor: new Date(Date.now() + 86_400_000) }));
  ok(sched.includes('TO‘LOV TURI: NAQD') && sched.includes('Belgilangan vaqt'), 'rejalashtirilgan naqd buyurtmada ham');
  const html = buildOrderText((await mk({ status: 'pending', address: '<b>x</b>' })).toObject());
  ok(html.includes('&lt;b&gt;x&lt;/b&gt;') && (html.match(/<b>/g) || []).length === (html.match(/<\/b>/g) || []).length, 'HTML to‘g‘ri (teglar juft; manzil qochirilgan)');
}

console.log('\n[2] QO‘LDA "to‘lov" tugmalari YO‘Q (barcha holat va usullarda)');
{
  let any = false;
  for (const method of ['cash', 'payme', 'click']) for (const isPaid of [true, false]) {
    for (const status of ['pending', 'accepted', 'preparing', 'ready', 'delivering', 'delivered', 'cancelled']) {
      for (const fulfillment of ['pickup', 'delivery']) {
        const kb = buildOrderKeyboard({ _id: new mongoose.Types.ObjectId(), status, fulfillment, paymentMethod: method, isPaid });
        if (labels(kb).some((l) => /to‘lov|To‘lov|pul/i.test(l)) || flat(kb).some((b) => String(b.callback_data).startsWith('o:paid'))) any = true;
      }
    }
  }
  ok(!any, '84 holat: hech qaysi tugmada "to‘lov" / o:paid yo‘q');
}

console.log('\n[3] YAKUNLASH YO‘LLARI: naqd buyurtma AVTOMATIK to‘langan (isPaid + paidAt + jurnal), komissiya ham');
const expectPaid = async (id, label) => {
  const s = await state(id);
  ok(s.o.status === 'delivered' && s.o.isPaid === true && s.o.paidAt instanceof Date, `${label}: delivered + isPaid + paidAt`);
  ok(s.payIn === 1 && s.due === 1, `${label}: jurnalda to‘lov 1 ta, komissiya 1 ta`);
  const row = await Ledger.findOne({ orderId: id, type: 'payment_in' }).lean();
  ok(row.isCash === true && row.provider === 'cash' && row.amount === 10250, `${label}: jurnal yozuvi — naqd, 10 250`);
};
{
  // A) olib ketish — restoran/bot "Mijozga topshirildi"
  const a = await mk({ fulfillment: 'pickup' });
  await changeOrderStatus({ orderId: a._id, restaurantId: R._id, status: 'delivered' }); await sleep(400);
  await expectPaid(a._id, 'olib ketish (restoran/bot)');

  // B) KURYER: qabul → "Topshirdim"
  const b = await mk();
  const link = await createShareLink(b._id);
  const acc = await acceptShare(link.token);
  ok(acc.ok, 'kuryer qabul qildi');
  ok((await state(b._id)).o.isPaid === false, 'kuryer yo‘lda: hali to‘lanmagan (pul kuryerda)');
  const del = await deliverShare(link.token, acc.secret); await sleep(500);
  ok(del.ok, 'kuryer "Topshirdim" bosdi');
  await expectPaid(b._id, 'kuryer');
  await deliverShare(link.token, acc.secret); await sleep(300);
  ok((await state(b._id)).payIn === 1, 'kuryer ikkinchi marta bossa — jurnal takrorlanmadi');

  // C) MIJOZ botda "Oldim"
  const c = await mk({ status: 'delivering' });
  await confirmOrderDelivered(c._id, 'customer'); await sleep(300);
  await expectPaid(c._id, 'mijoz (bot "Oldim")');

  // D) RESTORAN eslatma orqali
  const d = await mk({ status: 'delivering' });
  await confirmOrderDelivered(d._id, 'restaurant', { restaurantId: R._id }); await sleep(300);
  await expectPaid(d._id, 'restoran (tasdiqlash)');

  // E) AVTO-YAKUNLASH: 12 soatdan oshgan (updateMany)
  const e = await mk({ status: 'delivering' }); await aged(e._id, 13);
  await checkDeliveries(); await sleep(500);
  await expectPaid(e._id, 'avto-yakunlash (12 soat)');
}

console.log('\n[4] KARTA buyurtmaga TA‘SIR YO‘Q (to‘lov vaqti o‘zgarmaydi, naqd yozuvi yo‘q)');
{
  const t0 = new Date('2026-01-01T10:00:00Z');
  const k1 = await mk({ fulfillment: 'pickup', paymentMethod: 'click', isPaid: true, paidAt: t0 });
  await changeOrderStatus({ orderId: k1._id, restaurantId: R._id, status: 'delivered' }); await sleep(400);
  const s1 = await state(k1._id);
  ok(s1.o.isPaid && s1.o.paidAt.getTime() === t0.getTime() && s1.payIn === 0 && s1.due === 1, 'olib ketish + Click: paidAt o‘zgarmadi; naqd to‘lov yozuvi YO‘Q; komissiya bor');
  const k2 = await mk({ paymentMethod: 'payme', isPaid: true, paidAt: t0 });
  const l2 = await createShareLink(k2._id); const a2 = await acceptShare(l2.token); await deliverShare(l2.token, a2.secret); await sleep(500);
  const s2 = await state(k2._id);
  ok(s2.o.paidAt.getTime() === t0.getTime() && s2.payIn === 0, 'kuryer + Payme: o‘zgarmadi');
  ok((await finalizeCashPayment(k2._id)) === null, 'finalizeCashPayment karta uchun hech narsa qilmaydi');
}

console.log('\n[5] YAKUNLANMAGAN buyurtma — to‘lov yozilmaydi');
{
  for (const status of ['pending', 'accepted', 'preparing', 'ready', 'delivering', 'cancelled']) {
    const o = await mk({ status });
    ok((await finalizeCashPayment(o._id)) === null && (await state(o._id)).o.isPaid === false && (await state(o._id)).payIn === 0, `${status}: finalizeCashPayment — hech narsa`);
  }
  ok((await finalizeCashPayment(new mongoose.Types.ObjectId())) === null, 'mavjud bo‘lmagan buyurtma — null (yiqilmaydi)');
}

console.log('\n[6] TAKRORIY chaqiruv xavfsiz va ESKI buyurtmalar "davolanadi"');
{
  const o = await mk({ fulfillment: 'pickup' });
  await changeOrderStatus({ orderId: o._id, restaurantId: R._id, status: 'delivered' }); await sleep(400);
  const first = (await state(o._id)).o.paidAt;
  const r1 = await finalizeCashPayment(o._id); const r2 = await settleOrder(o._id);
  const s = await state(o._id);
  ok(r1.changed === false && r2 === null && s.payIn === 1 && s.due === 1 && s.o.paidAt.getTime() === first.getTime(), 'qayta finalize/settle: jurnal va to‘lov vaqti O‘ZGARMADI');

  // Eski: yakunlangan, lekin hech qachon to'langan deb belgilanmagan naqd buyurtma
  const legacy = await mk({ status: 'delivered', deliveredAt: new Date('2026-02-02T12:00:00Z') });
  const h = await finalizeCashPayment(legacy._id);
  const sl = await state(legacy._id);
  ok(h.changed === true && sl.o.isPaid && sl.o.paidAt.toISOString() === '2026-02-02T12:00:00.000Z' && sl.payIn === 1, 'eski yakunlangan naqd buyurtma: to‘langan (to‘lov vaqti = yetkazilgan vaqt), jurnalga tushdi');
  ok((await finalizeCashPayment(legacy._id)).changed === false && (await state(legacy._id)).payIn === 1, 'ikkinchi chaqiruv — o‘zgarishsiz');
}

console.log('\n[7] ESKI qo‘lda yo‘l (panel API, eski ilova versiyalari) buzilmagan va ikki marta yozmaydi');
{
  const o = await mk({ fulfillment: 'pickup' });
  const m = await call(restaurantPanelController.markPaid, { restaurantId: String(R._id), params: { id: String(o._id) }, body: {} });
  ok(m.status === 200 && (await state(o._id)).o.isPaid && (await state(o._id)).payIn === 1, 'eski PATCH /panel/orders/:id/paid hamon ishlaydi (isPaid + jurnal)');
  const manualAt = (await state(o._id)).o.paidAt;
  await changeOrderStatus({ orderId: o._id, restaurantId: R._id, status: 'delivered' }); await sleep(400);
  const s = await state(o._id);
  ok(s.payIn === 1 && s.o.paidAt.getTime() === manualAt.getTime() && s.due === 1, 'keyin yakunlansa: jurnal 1 ta, qo‘lda belgilangan vaqt saqlandi');
}

console.log('\n[8] MIJOZ ILOVASI "Ha, oldim" (PATCH /orders/:id/confirm): holat tekshiruvi + hisob-kitob + avtomatik to‘lov');
{
  const confirm = (id, body = {}, userId = user._id) => call(orderController.confirmDelivery, { userId, params: { id: String(id) }, body });

  const o = await mk({ status: 'delivering' });
  const r = await confirm(o._id, { rating: 5, comment: 'zo‘r' });
  ok(r.status === 200 && r.body.status === 'delivered', 'yo‘ldagi buyurtma yakunlandi (200)');
  const s = await state(o._id);
  ok(s.o.rating === 5 && s.o.comment === 'zo‘r' && s.o.ratedAt, 'baho saqlandi');
  ok(s.o.deliveryCheck?.confirmed === true && s.o.deliveryCheck.confirmedBy === 'customer', 'deliveryCheck.confirmedBy: "customer"');
  ok(s.o.isPaid === true && s.payIn === 1 && s.due === 1, 'KOMISSIYA hisoblandi va naqd AVTOMATIK to‘langan (avval hisob-kitob umuman chaqirilmasdi)');

  const deliveredAt = s.o.deliveredAt.getTime();
  const again = await confirm(o._id, { rating: 3, comment: 'o‘zgardi' });
  const s2 = await state(o._id);
  ok(again.status === 200 && s2.o.deliveredAt.getTime() === deliveredAt && s2.o.rating === 3 && s2.due === 1 && s2.payIn === 1, 'qo‘sh bosish/qayta: yetkazilgan vaqt o‘zgarmadi, faqat baho; hisob takrorlanmadi');

  for (const status of ['pending', 'cancelled', 'awaiting_payment']) {
    const bad = await mk({ status });
    const rb = await confirm(bad._id, { rating: 5 });
    const sb = await state(bad._id);
    ok(rb.status === 400 && rb.body.code === 'WRONG_STATE' && sb.o.status === status && !sb.o.deliveredAt && !sb.o.rating && sb.due === 0, `${status}: 400 WRONG_STATE, buyurtma o‘zgarmadi (avval "yetkazildi" qilib yuborardi)`);
  }
  const foreign = await mk({ status: 'delivering' });
  const rf = await confirm(foreign._id, {}, other._id);
  ok(rf.status === 404 && (await state(foreign._id)).o.status === 'delivering', 'BEGONA mijozning buyurtmasi — 404, o‘zgarmadi');

  // Kuryer allaqachon yakunlagan, mijoz keyin bahosini yuboradi
  const c = await mk({ status: 'ready' });
  const lk = await createShareLink(c._id); const ac = await acceptShare(lk.token); await deliverShare(lk.token, ac.secret); await sleep(500);
  const before = await state(c._id);
  const late = await confirm(c._id, { rating: 4, comment: 'ok' });
  const after = await state(c._id);
  ok(late.status === 200 && after.o.rating === 4 && after.o.deliveredAt.getTime() === before.o.deliveredAt.getTime() && after.due === 1 && after.payIn === 1, 'kuryer yakunlagach mijoz baho yuboradi: baho yozildi, hisob/vaqt o‘zgarmadi');
  const noRating = await confirm(c._id, {});
  ok(noRating.status === 200 && noRating.body.status === 'delivered', 'bahosiz tasdiq — 200, buyurtma qaytadi');
}

console.log(fails ? `\n✗ ${fails} ta xato` : '\n✓ HAMMASI O‘TDI');
await mongoose.disconnect();
process.exit(fails ? 1 : 0);
