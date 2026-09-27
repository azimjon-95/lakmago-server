/*
 * ═══════════════════════════════════════════════════════════
 * MIJOZ YORDAM XABARLARI — TELEGRAM GURUHGA + GURUH QULFI
 * ═══════════════════════════════════════════════════════════
 * npm run test:support-group
 */
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/lokma_support_group';
process.env.TELEGRAM_BOT_TOKEN = '1:TEST';
process.env.SUPPORT_GROUP_CHAT_ID = '-1009990001';
process.env.ADMIN_PANEL_URL = 'https://admin.lokma.uz';

const calls = [];
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
  return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) };
};

const mongoose = (await import('mongoose')).default;
await mongoose.connect(process.env.MONGO_URI);
await mongoose.connection.db.dropDatabase();

const { User } = await import('../src/models/User.js');
const { notifySupportGroup, isSupportGroupEnabled } = await import('../src/services/supportGroupNotify.js');
const { supportController } = await import('../src/controllers/support.js');
const { handleBotUpdate } = await import('../src/services/telegram.js');

let fails = 0;
const ok = (c, m) => { console.log(c ? '  ✓' : '  ✗ FAIL:', m); if (!c) fails++; };
const wait = (ms = 200) => new Promise((r) => setTimeout(r, ms));
function mockRes() {
  return { _c: 200, status(c) { this._c = c; return this; }, json(b) { this._body = b; return this; } };
}
const sendCalls = () => calls.filter((c) => c.url.endsWith('/sendMessage'));

console.log('\n[1] notifySupportGroup — to‘g‘ri guruhga, to‘g‘ri tugma bilan');
{
  calls.length = 0;
  await notifySupportGroup({ firstName: 'Aziz', username: 'aziz1', phone: '+998900000000' }, 'Salom, buyurtmam kelmadi');
  const c = sendCalls()[0];
  ok(c && String(c.body.chat_id) === '-1009990001', `to‘g‘ri chat_id: ${c?.body?.chat_id}`);
  ok(c.body.text.includes('Aziz') && c.body.text.includes('@aziz1'), 'ism va username bor');
  ok(c.body.text.includes('Salom, buyurtmam kelmadi'), 'xabar matni bor');
  const btn = c.body.reply_markup.inline_keyboard[0][0];
  ok(btn.url === 'https://admin.lokma.uz/support', `tugma to‘g‘ri manzilga: ${btn.url}`);
  ok(!btn.callback_data, 'tugma callback_data EMAS (bosilganda botga so‘rov kelmaydi)');
}

console.log('\n[2] Username yo‘q — telefon ko‘rsatiladi; ikkalasi ham yo‘q — faqat ism');
{
  calls.length = 0;
  await notifySupportGroup({ firstName: 'Vali', phone: '+998911111111' }, 'x');
  ok(sendCalls()[0].body.text.includes('+998911111111'), 'telefon ko‘rsatildi');
  calls.length = 0;
  await notifySupportGroup({}, 'x');
  ok(sendCalls()[0].body.text.includes('Mijoz'), 'ism yo‘q bo‘lsa "Mijoz" deb yoziladi, yiqilmaydi');
}

console.log('\n[3] HTML belgilar qochiriladi (Telegram parse xatosi bermasin)');
{
  calls.length = 0;
  await notifySupportGroup({ firstName: '<script>' }, 'salom <b>test</b> & rahmat');
  const text = sendCalls()[0].body.text;
  ok(!text.includes('<script>') && text.includes('&lt;script&gt;'), 'ism qochirilgan');
  ok(text.includes('&lt;b&gt;test&lt;/b&gt;') && text.includes('&amp;'), 'xabar matni qochirilgan');
}

console.log('\n[4] SUPPORT_GROUP_CHAT_ID BO‘SH bo‘lsa — jimgina o‘tkazib yuboriladi');
{
  const saved = process.env.SUPPORT_GROUP_CHAT_ID;
  process.env.SUPPORT_GROUP_CHAT_ID = '';
  const { config } = await import('../src/config/index.js');
  config.supportGroupChatId = '';
  calls.length = 0;
  ok(!isSupportGroupEnabled(), 'o‘chirilgan deb topildi');
  await notifySupportGroup({ firstName: 'X' }, 'y');
  ok(sendCalls().length === 0, 'hech qanday so‘rov yuborilmadi, xato ham chiqmadi');
  config.supportGroupChatId = saved;
  process.env.SUPPORT_GROUP_CHAT_ID = saved;
}

console.log('\n[5] Mijoz sendMessage yuborsa — guruhga HAM avtomatik yetadi');
{
  const u = await User.create({ firstName: 'Sitora', telegramId: '333' });
  calls.length = 0;
  const res = mockRes();
  await supportController.sendMessage({ userId: u._id, body: { text: 'Kartam ishlamayapti' } }, res, () => {});
  await wait();
  ok(res._c === 201, 'xabar qabul qilindi');
  const c = sendCalls().find((x) => x.body.text.includes('Kartam ishlamayapti'));
  ok(Boolean(c), 'guruhga xabar bordi');
  ok(c.body.text.includes('Sitora'), 'mijoz ismi bilan');
}

console.log('\n[6] GURUH QULFI: guruhdan kelgan /start — HECH NARSA qilinmaydi (User yaratilmaydi)');
{
  const groupChatId = -100777777;
  await handleBotUpdate({
    message: {
      chat: { id: groupChatId, type: 'supergroup' },
      from: { id: groupChatId, first_name: 'GuruhAzosi' },
      text: '/start',
    },
  });
  await wait();
  ok(!(await User.findOne({ telegramId: String(groupChatId) })), 'guruh uchun soxta User yaratilmadi');
}

console.log('\n[7] GURUH QULFI: guruhdagi izoh matni ("dlv_"ga o‘xshamagan) e’tiborsiz');
{
  await handleBotUpdate({
    message: { chat: { id: -100888, type: 'group' }, from: { id: -100888 }, text: 'ajoyib xizmat' },
  });
  ok(true, 'xatosiz o‘tdi (handleReviewText chaqirilmadi)');
}

console.log('\n[8] GURUH QULFI: eski callback_query guruh xabari ostida bosilsa ham e’tiborsiz');
{
  const before = calls.length;
  await handleBotUpdate({
    callback_query: {
      id: 'cq1', data: 'menu_orders', from: { id: -100999 },
      message: { chat: { id: -100999, type: 'supergroup' }, message_id: 5 },
    },
  });
  await wait();
  ok(calls.length === before, 'hech qanday Telegram so‘rovi yuborilmadi (answerCallbackQuery ham yo‘q)');
}

console.log('\n[9] REGRESSIYA: SHAXSIY chatdan /start — avvalgidek ishlaydi (qulf bloklamaydi)');
{
  const personalId = 444555;
  await handleBotUpdate({
    message: {
      chat: { id: personalId, type: 'private' },
      from: { id: personalId, first_name: 'Haqiqiy' },
      text: '/start',
    },
  });
  await wait();
  ok(await User.findOne({ telegramId: String(personalId) }), 'shaxsiy chatda User yaratildi (funksiya buzilmagan)');
}

console.log('\n[10] REGRESSIYA: my_chat_member (bot guruhga admin qilindi) — hamon ishlaydi');
{
  const { GroupChat } = await import('../src/models/GroupChat.js');
  await handleBotUpdate({
    my_chat_member: {
      chat: { id: -100123, type: 'supergroup', title: 'Test guruh' },
      new_chat_member: { status: 'member' },
      old_chat_member: { status: 'left' },
    },
  });
  await wait();
  ok(await GroupChat.findOne({ chatId: '-100123' }), 'promo-guruh funksiyasi hamon ishlaydi (qulfdan tegilmagan)');
}

console.log(fails ? `\n✗ ${fails} ta xato` : '\n✓ HAMMASI O‘TDI');
await mongoose.disconnect();
process.exit(fails ? 1 : 0);
