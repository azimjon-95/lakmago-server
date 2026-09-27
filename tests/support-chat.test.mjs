/*
 * ═══════════════════════════════════════════════════════════
 * YORDAM XIZMATI — BO'SH YOZISHMALAR YARATILMASIN VA KO'RINMASIN
 * ═══════════════════════════════════════════════════════════
 *
 * MUAMMO: mijoz panelni ochishning o'zida (hech narsa yozmasdan)
 * bazada bo'sh SupportChat yaratilib, admin ro'yxatini to'ldirardi.
 *
 * npm run test:support
 */
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/lokma_support';

const mongoose = (await import('mongoose')).default;
await mongoose.connect(process.env.MONGO_URI);
await mongoose.connection.db.dropDatabase();

const { SupportChat } = await import('../src/models/SupportChat.js');
const { User } = await import('../src/models/User.js');
const { supportController } = await import('../src/controllers/support.js');

let fails = 0;
const ok = (c, m) => { console.log(c ? '  ✓' : '  ✗ FAIL:', m); if (!c) fails++; };
const wait = (ms = 200) => new Promise((r) => setTimeout(r, ms));
function mockRes() {
  return { _c: 200, status(c) { this._c = c; return this; }, json(b) { this._body = b; return this; } };
}

const user = await User.create({ firstName: 'Aziz', telegramId: '111' });

console.log('\n[1] Panelni ochish (myChat) — BAZADA HECH NARSA YARATMAYDI');
{
  const before = await SupportChat.countDocuments();
  const res = mockRes();
  await supportController.myChat({ userId: user._id }, res, () => {});
  await wait();
  ok(res._body?.messages?.length === 0 && res._body?.isResolved === false, 'bo‘sh javob qaytdi');
  const after = await SupportChat.countDocuments();
  ok(after === before, `bazada yozuv yo‘q: oldin ${before}, keyin ${after}`);
}

console.log('\n[2] Yana ochilsa ham — hamon yaratilmaydi (ko‘p marta ochish)');
{
  for (let i = 0; i < 3; i++) await supportController.myChat({ userId: user._id }, mockRes(), () => {});
  await wait();
  ok(await SupportChat.countDocuments() === 0, 'uch marta ochilgach ham 0 ta yozuv');
}

console.log('\n[3] Xabar yozilsa — ENDI yaratiladi va admin ro‘yxatida ko‘rinadi');
{
  const res = mockRes();
  await supportController.sendMessage({ userId: user._id, body: { text: 'Salom, yordam kerak' } }, res, () => {});
  await wait();
  ok(res._c === 201, `xabar qabul qilindi: ${res._c}`);
  ok(await SupportChat.countDocuments() === 1, 'endi 1 ta yozuv bor');

  const listRes = mockRes();
  await supportController.list({ query: {} }, listRes, () => {});
  await wait();
  ok(listRes._body?.chats?.length === 1, `admin ro‘yxatida ko‘rinadi: ${listRes._body?.chats?.length}`);
}

console.log('\n[4] Boshqa mijoz panelni ochadi, keyin ham ochadi, HECH QACHON yozmaydi');
{
  const user2 = await User.create({ firstName: 'Vali', telegramId: '222' });
  await supportController.myChat({ userId: user2._id }, mockRes(), () => {});
  await supportController.myChat({ userId: user2._id }, mockRes(), () => {});
  await wait();
  ok(await SupportChat.countDocuments() === 1, 'hamon faqat 1 ta (Vali uchun yaratilmadi)');

  const listRes = mockRes();
  await supportController.list({ query: {} }, listRes, () => {});
  await wait();
  ok(listRes._body?.chats?.length === 1, 'admin ro‘yxatida hamon faqat Aziz ko‘rinadi, Vali yo‘q');
}

console.log('\n[5] MAVJUD BO‘SH YOZISHMALAR — ro‘yxatda yashirinadi (ma’lumot o‘chirilmasdan)');
{
  // Eski xato tufayli bazada qolib ketgan bo'sh yozishmani simulyatsiya qilamiz
  const ghostUser = await User.create({ firstName: 'Iftixor' });
  await SupportChat.create({ userId: ghostUser._id, firstName: 'Iftixor', messages: [] });

  const listRes = mockRes();
  await supportController.list({ query: {} }, listRes, () => {});
  await wait();
  ok(listRes._body.chats.length === 1 && listRes._body.chats[0].firstName === 'Aziz',
    `bo‘sh (Iftixor) ro‘yxatda yo‘q, faqat xabari bor (Aziz) ko‘rinadi: ${listRes._body.chats.map((c) => c.firstName)}`);
  ok(await SupportChat.countDocuments() === 2, 'lekin bazadan o‘chirilmagan (2 ta hujjat qoldi)');
}

console.log('\n[6] "Yopilgan" (resolved=true) — bo‘sh yozishma u yerda ham ko‘rinmaydi');
{
  await SupportChat.updateOne({ firstName: 'Iftixor' }, { isResolved: true });
  const listRes = mockRes();
  await supportController.list({ query: { resolved: 'true' } }, listRes, () => {});
  await wait();
  ok(listRes._body.chats.length === 0, `bo‘sh + yopilgan ham ko‘rinmaydi: ${listRes._body.chats.length}`);
}

console.log('\n[7] Suhbat yakunlangandan keyin qayta ochilsa — tarix bo‘sh, lekin yozuv o‘chmaydi');
{
  await SupportChat.updateOne({ firstName: 'Aziz' }, { isResolved: true });
  const res = mockRes();
  await supportController.myChat({ userId: user._id }, res, () => {});
  await wait();
  ok(res._body.messages.length === 0 && res._body.isResolved === true, 'toza oyna ko‘rsatiladi');
  const doc = await SupportChat.findOne({ userId: user._id }).lean();
  ok(doc.messages.length === 1, 'lekin xabar tarixi bazada saqlanadi');
}

console.log(fails ? `\n✗ ${fails} ta xato` : '\n✓ HAMMASI O‘TDI');
await mongoose.disconnect();
process.exit(fails ? 1 : 0);
