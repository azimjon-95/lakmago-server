/*
 * RESTORAN GURUHI / KANALI (services/telegramGroup.js): biriktirish → restoran pini (tugma SHU restoran sahifasini ochadi),
 * umumiy promo bu yerga pin qilinmaydi, reklama o'chiriladi, ajratish, kunlik tekshiruv, kanallar, reklama uchun chat tanlash.
 * Telegram API SOXTA (fetch ushlanadi — qaysi so'rov ketgani tekshiriladi). Baza YO'Q. npm run test:group-restaurant
 */
process.env.JWT_SECRET = 'x'.repeat(40);
process.env.TELEGRAM_BOT_TOKEN = 'TEST';
process.env.BOT_USERNAME = 'lokmagobot';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Types } from 'mongoose';
import { bindModel } from './helpers/fakeModel.mjs';

const { GroupChat } = await import('../src/models/GroupChat.js');
const { Restaurant } = await import('../src/models/Restaurant.js');
const G = await import('../src/services/telegramGroup.js');
const { adminController } = await import('../src/controllers/admin.js');

/* ── Soxta Telegram ── */
const tgState = { calls: [], msgSeq: 100, pinned: new Map(), deleted: new Set(), failPhoto: false, noPinRights: false };
const pinnedOf = (chat) => { if (!tgState.pinned.has(chat)) tgState.pinned.set(chat, []); return tgState.pinned.get(chat); };
globalThis.fetch = async (url, opts = {}) => {
  const method = String(url).split('/').pop();
  const body = opts.body && typeof opts.body === 'string' ? JSON.parse(opts.body) : {};
  tgState.calls.push({ method, body });
  const ok = (result) => new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const err = (description) => new Response(JSON.stringify({ ok: false, description }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  const chat = String(body.chat_id);
  if (method === 'getMe') return ok({ id: 1, username: 'lokmagobot' });
  if (method === 'sendPhoto') { if (tgState.failPhoto) return err('Bad Request: wrong file identifier/HTTP URL specified'); return ok({ message_id: ++tgState.msgSeq }); }
  if (method === 'sendMessage') return ok({ message_id: ++tgState.msgSeq });
  if (method === 'pinChatMessage') {
    if (tgState.noPinRights) return err('Bad Request: not enough rights to manage pinned messages in the chat');
    if (tgState.deleted.has(body.message_id)) return err('Bad Request: message to pin not found');
    const p = pinnedOf(chat).filter((m) => m !== body.message_id); p.unshift(body.message_id); tgState.pinned.set(chat, p); return ok(true);
  }
  if (method === 'unpinChatMessage') { tgState.pinned.set(chat, pinnedOf(chat).filter((m) => m !== body.message_id)); return ok(true); }
  if (method === 'getChat') return ok({ id: chat, pinned_message: pinnedOf(chat)[0] ? { message_id: pinnedOf(chat)[0] } : undefined });
  if (method === 'getChatMember') return ok({ status: 'administrator' });
  return ok(true);
};
const calls = (m) => tgState.calls.filter((c) => c.method === m);

/* ── Soxta baza ── */
const groups = bindModel(GroupChat, { docs: [] });
const rests = bindModel(Restaurant, { docs: [] });
const R1 = new Types.ObjectId(); const R2 = new Types.ObjectId(); const R_OFF = new Types.ObjectId();
const reset = () => {
  groups.docs.length = 0; rests.docs.length = 0; tgState.calls.length = 0; tgState.pinned.clear(); tgState.deleted.clear();
  tgState.failPhoto = false; tgState.noPinRights = false;
  rests.docs.push(
    { _id: R1, name: 'Ziynat Restoran', cuisine: 'Milliy taomlar', imageUrl: 'https://res.cloudinary.com/x/ziynat.jpg', isActive: true },
    { _id: R2, name: 'TOTLI <Tortlari>', cuisine: 'Tortlar', imageUrl: '', images: [], isActive: true },
    { _id: R_OFF, name: 'Yopilgan', cuisine: '-', isActive: false },
  );
};
const mkGroup = (over = {}) => {
  const g = { chatId: String(-1000 - groups.docs.length), title: 'Guruh', type: 'supergroup', kind: 'group', isBotAdmin: true, isActive: true, promoMessageId: 50, isPinned: true, adsEnabled: true, restaurantId: null, restaurantPin: { messageId: null, isPinned: false, pinnedAt: null, error: '' }, ...over };
  groups.docs.push(g); pinnedOf(g.chatId); if (g.promoMessageId && g.isPinned) pinnedOf(g.chatId).unshift(g.promoMessageId);
  return g;
};

test('pin mazmuni: restoran nomi (HTML xavfsiz), tugma SHU restoran sahifasini ochadi, rasm faqat https', () => {
  const c = G.restaurantPinContent({ name: 'TOTLI <b>', cuisine: 'Tort & shirinlik', imageUrl: 'javascript:x' }, 'https://t.me/lokmagobot?startapp=rest_abc&mode=fullscreen');
  assert.ok(c.text.includes('🍽 <b>TOTLI &lt;b&gt;</b>') && c.text.includes('Tort &amp; shirinlik'));
  assert.equal(c.photo, '', 'faqat http(s) rasm');
  assert.equal(c.keyboard.inline_keyboard[0][0].url, 'https://t.me/lokmagobot?startapp=rest_abc&mode=fullscreen');
  assert.ok(c.keyboard.inline_keyboard[0][0].text.includes('TOTLI') && c.keyboard.inline_keyboard[0][0].text.includes('buyurtma berish'));
  assert.equal(G.restaurantStartParam(R1), `rest_${R1}`);
  assert.equal(G.restaurantPinContent({ name: 'A', images: ['', 'https://x/a.jpg'] }, 'l').photo, 'https://x/a.jpg');
});

test('BIRIKTIRISH: rasm + matn yuboriladi, TEPAGA pin, umumiy promo pindan olinadi, reklama o\'chiriladi', async () => {
  reset();
  const g = mkGroup({ title: 'Ziynat mijozlari' });
  const out = await G.bindGroupRestaurant(g.chatId, String(R1), { adminId: 'a1' });
  const photo = calls('sendPhoto')[0];
  assert.ok(photo, 'rasm bilan yuborildi');
  assert.ok(photo.body.caption.includes('Ziynat Restoran'));
  assert.ok(photo.body.reply_markup.inline_keyboard[0][0].url.includes(`startapp=rest_${R1}`), 'tugma restoran sahifasini ochadi');
  assert.equal(pinnedOf(g.chatId)[0], out.restaurantPin.messageId, 'restoran xabari TEPADA');
  assert.ok(!pinnedOf(g.chatId).includes(50), 'umumiy LokmaGo promo pindan olindi');
  assert.equal(String(out.restaurantId), String(R1));
  assert.equal(out.adsEnabled, false, 'restoran guruhiga reklama standart holda o\'chiq');
  assert.equal(out.restaurantPin.isPinned, true); assert.equal(out.boundBy, 'a1');
  assert.equal(calls('sendMessage').length, 0, 'umumiy promo YUBORILMADI');
});

test('rasm yuborilmasa — matn bilan; pin huquqi bo\'lmasa — aniq xato saqlanadi', async () => {
  reset();
  tgState.failPhoto = true; tgState.noPinRights = true;
  const g = mkGroup();
  const out = await G.bindGroupRestaurant(g.chatId, String(R1));
  assert.equal(calls('sendMessage').length, 1, 'rasm o\'rniga matn');
  assert.equal(out.restaurantPin.isPinned, false);
  assert.ok(out.restaurantPin.error.includes('Pin messages'));
});

test('tekshiruvlar: bot admin emas / restoran yo\'q / restoran faol emas / guruh yo\'q', async () => {
  reset();
  const g = mkGroup({ isBotAdmin: false });
  await assert.rejects(G.bindGroupRestaurant(g.chatId, String(R1)), (e) => e.code === 'NOT_ADMIN');
  const g2 = mkGroup();
  await assert.rejects(G.bindGroupRestaurant(g2.chatId, String(new Types.ObjectId())), (e) => e.code === 'RESTAURANT_NOT_FOUND' && e.status === 404);
  await assert.rejects(G.bindGroupRestaurant(g2.chatId, String(R_OFF)), (e) => e.code === 'RESTAURANT_INACTIVE');
  await assert.rejects(G.bindGroupRestaurant('-999', String(R1)), (e) => e.status === 404);
  assert.equal(tgState.calls.filter((c) => c.method.startsWith('send')).length, 0, 'xato holatda hech narsa yuborilmadi');
});

test('boshqa restoranga almashtirish: eski restoran xabari pindan olinadi; admin yoqqan reklama sozlamasi saqlanadi', async () => {
  reset();
  const g = mkGroup();
  const first = await G.bindGroupRestaurant(g.chatId, String(R1));
  groups.docs[0].adsEnabled = true;                      // admin reklamani qo'lda yoqdi
  const second = await G.bindGroupRestaurant(g.chatId, String(R2));
  assert.ok(!pinnedOf(g.chatId).includes(first.restaurantPin.messageId), 'eski restoran pini olindi');
  assert.equal(pinnedOf(g.chatId)[0], second.restaurantPin.messageId);
  assert.equal(second.adsEnabled, true, 'qayta biriktirishda admin sozlamasi buzilmaydi');
  assert.ok(calls('sendMessage').at(-1).body.text.includes('TOTLI &lt;Tortlari&gt;'), 'rasmsiz restoran — matn, nom xavfsiz');
});

test('AJRATISH: restoran pini olinadi, umumiy LokmaGo promo tepaga qaytadi', async () => {
  reset();
  const g = mkGroup();
  const b = await G.bindGroupRestaurant(g.chatId, String(R1));
  const out = await G.bindGroupRestaurant(g.chatId, null);
  assert.equal(out.restaurantId, null);
  assert.ok(!pinnedOf(g.chatId).includes(b.restaurantPin.messageId));
  assert.equal(pinnedOf(g.chatId)[0], 50, 'umumiy promo qaytdi');
});

test('KUNLIK TEKSHIRUV: restoran guruhida pin yo\'qolsa RESTORAN xabari qayta pin; o\'chirilgan bo\'lsa yangisi; umumiy promo yuborilmaydi', async () => {
  reset();
  const g = mkGroup();
  const b = await G.bindGroupRestaurant(g.chatId, String(R1));
  const doc = groups.docs[0]; doc.save = async () => {};
  tgState.pinned.set(g.chatId, []);                       // kimdir pinni olib tashladi
  tgState.calls.length = 0;
  let r = await G.dailyGroupCheck();
  assert.equal(r.fixed, 1);
  assert.equal(pinnedOf(g.chatId)[0], b.restaurantPin.messageId, 'o\'sha restoran xabari qayta pin');
  assert.equal(calls('sendMessage').length + calls('sendPhoto').length, 0, 'yangi xabar kerak bo\'lmadi');
  // xabar o'chirilgan
  tgState.pinned.set(g.chatId, []); tgState.deleted.add(b.restaurantPin.messageId); tgState.calls.length = 0;
  r = await G.dailyGroupCheck();
  assert.equal(calls('sendPhoto').length, 1, 'yangi restoran xabari yuborildi');
  assert.ok(calls('sendPhoto')[0].body.reply_markup.inline_keyboard[0][0].url.includes(`rest_${R1}`));
  assert.equal(calls('sendMessage').length, 0, 'umumiy LokmaGo promo YUBORILMADI');
  // joyida bo'lsa — hech narsa qilinmaydi
  tgState.calls.length = 0;
  r = await G.dailyGroupCheck();
  assert.equal(r.fixed, 0); assert.equal(calls('pinChatMessage').length, 0);
});

test('KANAL: qo\'shilganda umumiy promo YUBORILMAYDI va reklama standart o\'chiq; restoran biriktirilsa pin ishlaydi', async () => {
  reset();
  // registerGroup upsert ($setOnInsert) — soxta modelda qo'lda (test oxirida asl holiga qaytariladi)
  const original = GroupChat.findOneAndUpdate;
  GroupChat.findOneAndUpdate = async (q, u) => {
    let d = groups.docs.find((x) => x.chatId === q.chatId);
    if (!d) { d = { chatId: q.chatId, promoMessageId: null, restaurantId: null, restaurantPin: {}, ...(u.$setOnInsert || {}) }; groups.docs.push(d); }
    Object.assign(d, u.$set || {});
    return { ...d, save: async () => {} };
  };
  const ch = await G.onBotPromotedToAdmin({ id: -100777, title: 'Ziynat kanali', type: 'channel' });
  assert.equal(ch.kind, 'channel'); assert.equal(ch.adsEnabled, false);
  assert.equal(tgState.calls.filter((c) => c.method.startsWith('send')).length, 0, 'kanalga hech narsa yuborilmadi');
  const gr = await G.onBotPromotedToAdmin({ id: -100888, title: 'Oddiy guruh', type: 'supergroup' });
  assert.equal(gr.adsEnabled, true);
  assert.equal(calls('sendMessage').length, 1, 'oddiy guruh — umumiy promo avvalgidek');
  GroupChat.findOneAndUpdate = original;
  const out = await G.bindGroupRestaurant('-100777', String(R1));
  assert.equal(out.restaurantPin.isPinned, true, 'kanalda restoran pini');
});

test('REKLAMA TANLASH: standart — faqat reklamasi yoqilgan faol admin chatlar; tanlov — faqat tanlanganlar, o\'tkazilganlar sababi bilan', () => {
  const list = [
    { chatId: '1', title: 'A', isActive: true, isBotAdmin: true, adsEnabled: true },
    { chatId: '2', title: 'Restoran guruhi', isActive: true, isBotAdmin: true, adsEnabled: false },
    { chatId: '3', title: 'Admin emas', isActive: true, isBotAdmin: false, adsEnabled: true },
    { chatId: '4', title: 'Chiqarilgan', isActive: false, isBotAdmin: false, adsEnabled: true },
    { chatId: '5', title: 'B', isActive: true, isBotAdmin: true },                 // eski yozuv (maydonsiz) — yoqilgan
  ];
  let r = G.selectBroadcastTargets(list);
  assert.deepEqual(r.targets.map((g) => g.chatId), ['1', '5']); assert.deepEqual(r.skipped, []);
  r = G.selectBroadcastTargets(list, ['5', '2', '3']);
  assert.deepEqual(r.targets.map((g) => g.chatId), ['5']);
  assert.deepEqual(r.skipped.map((s) => [s.chatId, s.reason]), [['2', 'ads_disabled'], ['3', 'not_admin']]);
});

/* ── Kontrollerlar (HTTP qatlami) ── */
const res = () => { const r = { code: 200, body: null }; r.status = (c) => { r.code = c; return r; }; r.json = (b) => { r.body = b; return r; }; r.set = () => r; return r; };
// asyncHandler va'dani qaytarmaydi — javob yozilguncha kutamiz (3 s gacha)
const run = async (h, req) => {
  const r = res(); let error = null;
  h(req, r, (e) => { error = e; });
  for (let i = 0; i < 300 && r.body === null && !error; i++) await new Promise((x) => setTimeout(x, 10));
  if (error) throw error;
  return r;
};

test('API: reklama yuborish — tanlov (JSON va multipart matn), o\'chirilgan chatga yagona reklama 409, restoran guruhiga umumiy promo 409', async () => {
  reset();
  const a = mkGroup({ title: 'A' }); const b = mkGroup({ title: 'B' }); const rest = mkGroup({ title: 'Restoran', adsEnabled: false, restaurantId: R1 });
  tgState.calls.length = 0;
  let r = await run(adminController.broadcastAll, { body: { text: 'Aksiya!' } });
  assert.equal(r.body.total, 2, 'standart: restoran guruhi chetda'); assert.equal(calls('sendMessage').length, 2);
  tgState.calls.length = 0;
  r = await run(adminController.broadcastAll, { body: { text: 'Faqat A', chatIds: JSON.stringify([a.chatId, rest.chatId]) } });
  assert.equal(r.body.sent, 1); assert.equal(calls('sendMessage')[0].body.chat_id, a.chatId);
  assert.deepEqual(r.body.skipped.map((s) => s.reason), ['ads_disabled']);
  r = await run(adminController.broadcastAll, { body: { text: 'x', chatIds: `${b.chatId}` } });
  assert.equal(r.body.sent, 1, 'vergulli ro\'yxat (multipart)');
  r = await run(adminController.broadcastAll, { body: { text: 'x', chatIds: ['abc'] } });
  assert.equal(r.code, 400, 'yaroqsiz chat ID');
  r = await run(adminController.broadcast, { params: { chatId: rest.chatId }, body: { text: 'x' } });
  assert.equal(r.code, 409); assert.equal(r.body.code, 'ADS_DISABLED');
  r = await run(adminController.resendPromo, { params: { chatId: rest.chatId }, body: {} });
  assert.equal(r.code, 409); assert.equal(r.body.code, 'RESTAURANT_GROUP');
});

test('API: biriktirish / reklama yoqish / pinni yangilash — kirish tekshiruvi', async () => {
  reset();
  const g = mkGroup();
  let r = await run(adminController.setGroupRestaurant, { params: { chatId: g.chatId }, body: { restaurantId: 'yomon' }, userId: 'a' });
  assert.equal(r.code, 400);
  r = await run(adminController.setGroupRestaurant, { params: { chatId: g.chatId }, body: { restaurantId: String(R1) }, userId: 'a' });
  assert.equal(r.code, 200); assert.equal(String(r.body.restaurantId), String(R1));
  r = await run(adminController.setGroupAds, { params: { chatId: g.chatId }, body: { adsEnabled: true } });
  assert.deepEqual(r.body, { chatId: g.chatId, adsEnabled: true });
  r = await run(adminController.setGroupAds, { params: { chatId: g.chatId }, body: { adsEnabled: 'ha' } });
  assert.equal(r.code, 400);
  r = await run(adminController.repinGroupRestaurant, { params: { chatId: g.chatId }, userId: 'a' });
  assert.equal(r.code, 200);
  const g2 = mkGroup();
  r = await run(adminController.repinGroupRestaurant, { params: { chatId: g2.chatId }, userId: 'a' });
  assert.equal(r.code, 409);
});
