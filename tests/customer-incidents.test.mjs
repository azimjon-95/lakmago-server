/*
 * "MIJOZ RAD ETDI" — admin tasdig'i bilan bekor qilish, naqd o'chirish, bloklash.
 * Baza KERAK EMAS (modellar soxta). npm run test:incidents
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(40);
globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) });

const { Order } = await import('../src/models/Order.js');
const { changeOrderStatus, OrderFlowError } = await import('../src/services/orderFlow.js');
const { buildOrderKeyboard } = await import('../src/services/restaurantBotOrders.js');
const { createCancelRequest, IncidentError, REFUSAL_REASONS, REFUSABLE_STATUSES, defaultCustomerMessage } = await import('../src/services/customerIncidents.js');
const { blockedPayload } = await import('../src/services/customerBlock.js');

let fails = 0;
const ok = (c, m) => { console.log(c ? '  ✓' : '  ✗ FAIL:', m); if (!c) fails++; };
const id = 'a'.repeat(24);
const datas = (kb) => (kb?.inline_keyboard || []).flat().map((b) => b.callback_data);

console.log('\n[1] Restoran boti tugmalari');
{
  const base = { _id: id, fulfillment: 'delivery' };
  ok(!datas(buildOrderKeyboard({ ...base, status: 'pending' })).some((d) => d.startsWith('o:refuse')), 'kutilayotgan buyurtma: "Mijoz rad etdi" yo‘q (oddiy "Rad etish" bor)');
  for (const status of ['accepted', 'preparing', 'ready', 'delivering']) {
    ok(datas(buildOrderKeyboard({ ...base, status })).includes(`o:refusemenu:${id}`), `${status}: "🚫 Mijoz rad etdi" bor`);
  }
  ok(datas(buildOrderKeyboard({ ...base, status: 'ready', fulfillment: 'pickup' })).includes(`o:refusemenu:${id}`), 'olib ketish (tayyor): ham bor');
  const waiting = datas(buildOrderKeyboard({ ...base, status: 'accepted', cancelRequest: { status: 'pending' } }));
  ok(waiting.includes(`o:refusewait:${id}`) && !waiting.includes(`o:refusemenu:${id}`), 'so‘rov yuborilgan: "admin qarori kutilmoqda", qayta yuborib bo‘lmaydi');
  ok(datas(buildOrderKeyboard({ ...base, status: 'accepted', cancelRequest: { status: 'rejected' } })).includes(`o:refusemenu:${id}`), 'admin rad etgan: qayta so‘rash mumkin');
  ok(buildOrderKeyboard({ ...base, status: 'delivered' }) === null, 'yakunlangan: tugma yo‘q');
  ok(datas(buildOrderKeyboard({ ...base, status: 'accepted' })).every((d) => Buffer.byteLength(d) <= 64), 'callback_data ≤ 64 bayt');
  const longest = Object.keys(REFUSAL_REASONS).map((k) => `o:refuse:${id}:${k}`).sort((a, b) => b.length - a.length)[0];
  ok(Buffer.byteLength(longest) <= 64, `eng uzun sabab tugmasi ≤ 64 bayt (${Buffer.byteLength(longest)})`);
}

console.log('\n[2] Restoran qabul qilingan buyurtmani O‘ZI bekor qila olmaydi');
{
  const lean = (v) => ({ select: () => ({ lean: async () => v }) });
  Order.findOne = () => lean({ status: 'accepted', fulfillment: 'delivery' });
  let err = null;
  try { await changeOrderStatus({ orderId: id, restaurantId: id, status: 'cancelled' }); } catch (e) { err = e; }
  ok(err instanceof OrderFlowError && err.code === 'NEEDS_ADMIN_APPROVAL', 'qabul qilingan → bekor qilish: NEEDS_ADMIN_APPROVAL');
  for (const s of ['preparing', 'ready']) {
    Order.findOne = () => lean({ status: s, fulfillment: 'delivery' });
    err = null;
    try { await changeOrderStatus({ orderId: id, restaurantId: id, status: 'cancelled' }); } catch (e) { err = e; }
    ok(err?.code === 'NEEDS_ADMIN_APPROVAL', `${s} → ham admin tasdig'isiz bekor qilinmaydi`);
  }
  // pending — rad etish avvalgidek (shlyuzdan o'tadi; yozuv soxtada topilmaydi → RACE_LOST)
  Order.findOne = () => lean({ status: 'pending', fulfillment: 'delivery' });
  Order.findOneAndUpdate = () => ({ populate: async () => null });
  err = null;
  try { await changeOrderStatus({ orderId: id, restaurantId: id, status: 'cancelled' }); } catch (e) { err = e; }
  ok(err?.code === 'RACE_LOST', 'kutilayotgan buyurtmani rad etish — avvalgidek ruxsat (tekshiruvdan o‘tdi)');
  // admin tasdig'i bilan — yo'lda ham mumkin
  Order.findOne = () => lean({ status: 'delivering', fulfillment: 'delivery' });
  let filter = null;
  Order.findOneAndUpdate = (f) => { filter = f; return { populate: async () => null }; };
  err = null;
  try { await changeOrderStatus({ orderId: id, restaurantId: id, status: 'cancelled', approvedByAdmin: true }); } catch (e) { err = e; }
  ok(err?.code === 'RACE_LOST' && filter.status.$in.includes('delivering') && !filter.status.$in.includes('delivered'), 'admin tasdig‘i: yo‘ldagi buyurtma ham bekor qilinadi, yakunlangan — yo‘q');
}

console.log('\n[3] So‘rov tekshiruvlari');
{
  let e = null;
  try { await createCancelRequest({ orderId: id, restaurantId: id, reasonCode: 'nonsense' }); } catch (x) { e = x; }
  ok(e instanceof IncidentError && e.code === 'BAD_REASON', 'noma’lum sabab rad etiladi');
  e = null;
  try { await createCancelRequest({ orderId: id, restaurantId: id, reasonCode: 'other', note: '' }); } catch (x) { e = x; }
  ok(e?.code === 'NOTE_REQUIRED', '"Boshqa sabab" — izoh majburiy');
  const chainPop = (v) => ({ populate() { return { populate: async () => v }; } });
  Order.findOne = () => chainPop({ status: 'pending' });
  e = null;
  try { await createCancelRequest({ orderId: id, restaurantId: id, reasonCode: 'not_needed' }); } catch (x) { e = x; }
  ok(e?.code === 'WRONG_STATE', 'hali qabul qilinmagan — "Rad etish" bilan (so‘rov emas)');
  Order.findOne = () => chainPop({ status: 'delivered' });
  e = null;
  try { await createCancelRequest({ orderId: id, restaurantId: id, reasonCode: 'not_needed' }); } catch (x) { e = x; }
  ok(e?.code === 'WRONG_STATE', 'yakunlangan buyurtma — so‘rov yo‘q');
  Order.findOne = () => chainPop({ status: 'accepted', cancelRequest: { status: 'pending' } });
  e = null;
  try { await createCancelRequest({ orderId: id, restaurantId: id, reasonCode: 'not_needed' }); } catch (x) { e = x; }
  ok(e?.code === 'ALREADY_PENDING', 'ikkinchi marta yuborib bo‘lmaydi');
  ok(REFUSABLE_STATUSES.join() === 'accepted,preparing,ready,delivering', 'so‘rov mumkin bo‘lgan holatlar');
}

console.log('\n[4] Mijozga ko‘rsatiladigan matnlar');
{
  const msg = defaultCustomerMessage({ restaurantName: 'Osiyo kafe', createdAt: new Date('2026-10-12T10:00:00Z'), order: { items: [{ name: 'Osh' }, { name: 'Manti' }] } });
  ok(msg.includes('12.10.2026') && msg.includes('Osiyo kafe') && msg.includes('Osh, Manti'), `standart sabab: sana + restoran + taomlar ("${msg.slice(0, 70)}…")`);
  const p = blockedPayload({ blockInfo: { reason: 'Buyurtmadan 3 marta voz kechgan', at: new Date() } });
  ok(p.code === 'USER_BLOCKED' && p.reason.includes('3 marta') && p.error.includes('3 marta'), 'blok javobi: kod + sabab');
  ok(blockedPayload(null).code === 'USER_BLOCKED', 'sababsiz blok ham to‘g‘ri javob');
}

console.log('\n[5] Rad etish sabablari (qabul qilinmagan buyurtma) — "javob bermadi" / "tasdiqlamadi"');
{
  const { REJECT_REASONS } = await import('../src/constants/rejectReasons.js');
  ok(REJECT_REASONS.no_answer && REJECT_REASONS.not_confirmed, 'yangi sabablar bor');
  ok(['out', 'busy', 'far', 'closing', 'other'].every((k) => REJECT_REASONS[k]), 'eski sabablar o‘zgarmagan (eski tugmalar ishlaydi)');
  const longest = Object.keys(REJECT_REASONS).map((k) => `o:reject:${id}:${k}`).sort((a, b) => b.length - a.length)[0];
  ok(Buffer.byteLength(longest) <= 64, `bot tugmasi ≤ 64 bayt (${Buffer.byteLength(longest)})`);
  // Kod buyurtmaga yoziladi (atomik yangilash ichida)
  Order.findOne = () => ({ select: () => ({ lean: async () => ({ status: 'pending', fulfillment: 'delivery' }) }) });
  let upd = null;
  Order.findOneAndUpdate = (f, u) => { upd = u; return { populate: async () => null }; };
  try { await changeOrderStatus({ orderId: id, restaurantId: id, status: 'cancelled', cancelReason: REJECT_REASONS.no_answer, cancelReasonCode: 'no_answer' }); } catch { /* RACE_LOST soxtada */ }
  const set = upd?.$set || upd;
  ok(set?.cancelReasonCode === 'no_answer' && set?.cancelReason === 'Mijoz telefonga javob bermadi', 'sabab matni va kodi buyurtmaga yoziladi');
  upd = null;
  try { await changeOrderStatus({ orderId: id, restaurantId: id, status: 'cancelled', cancelReasonCode: 'DROP TABLE' }); } catch { /* */ }
  ok(!(upd?.$set || upd)?.cancelReasonCode, 'noto‘g‘ri kod yozilmaydi');
}

console.log(fails ? `\n✗ ${fails} ta xato` : '\n✓ Hammasi o‘tdi');
process.exit(fails ? 1 : 0);
