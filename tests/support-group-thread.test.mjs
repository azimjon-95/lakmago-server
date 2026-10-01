/*
 * ═══════════════════════════════════════════════════════════
 * YORDAM XABARLARI — MIJOZ BO'YICHA POST, TAHRIRLASH, ✅✅ HOLAT
 * ═══════════════════════════════════════════════════════════
 * Haqiqiy controller'lar (mijoz xabari, admin javobi) chaqiriladi;
 * Telegram — soxta (chaqiruvlar yozib olinadi).
 * npm run test:support-thread
 */
process.env.MONGO_URI = 'mongodb://127.0.0.1:27017/lokma_support_thread';
process.env.TELEGRAM_BOT_TOKEN = '1:TEST';
process.env.SUPPORT_GROUP_CHAT_ID = '-100777';
process.env.ADMIN_PANEL_URL = 'https://admin.lokma.uz';
process.env.SUPPORT_GROUP_THREAD_MINUTES = '60';
process.env.JWT_SECRET = 'x'.repeat(40);

const calls = [];
let nextId = 500;
let editMode = 'ok'; // ok | notfound | notmodified | neterr
const reply = (b) => ({ ok: true, status: 200, json: async () => b });
globalThis.fetch = async (url, init) => {
  const method = String(url).split('/').pop();
  const body = init?.body ? JSON.parse(init.body) : {};
  calls.push({ method, body });
  if (method === 'editMessageText') {
    if (editMode === 'neterr') throw new Error('ECONNRESET');
    if (editMode === 'notfound') return reply({ ok: false, error_code: 400, description: 'Bad Request: message to edit not found' });
    if (editMode === 'notmodified') return reply({ ok: false, error_code: 400, description: 'Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message' });
    return reply({ ok: true, result: { message_id: body.message_id } });
  }
  if (method === 'sendMessage') return reply({ ok: true, result: { message_id: ++nextId } });
  return reply({ ok: true, result: {} });
};

const mongoose = (await import('mongoose')).default;
await mongoose.connect(process.env.MONGO_URI);
await mongoose.connection.db.dropDatabase();
const { User } = await import('../src/models/User.js');
const { SupportChat } = await import('../src/models/SupportChat.js');
const { supportController } = await import('../src/controllers/support.js');
const { config } = await import('../src/config/index.js');
const { buildPostText, notifySupportGroup, markSupportGroupReplied } = await import('../src/services/supportGroupNotify.js');

let fails = 0;
const ok = (c, m) => { console.log(c ? '  ✓' : '  ✗ FAIL:', m); if (!c) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function call(fn, req) {
  let status = 200; let body = null;
  const res = { status(c) { status = c; return this; }, json(b) { body = b; return this; } };
  await fn(req, res, (e) => { body = { next: e?.message }; status = 500; });
  await sleep(350); // asyncHandler promise qaytarmaydi
  return { status, body };
}
const A = await User.create({ firstName: 'Murodbek', lastName: 'Amanov', username: 'muq', telegramId: '111', phone: '+998900000001' });
const B = await User.create({ firstName: 'Sitora', telegramId: '222', phone: '+998900000002' });
const adminU = await User.create({ firstName: 'Bahrom', login: 'bahrom' });

const say = (u, text) => call(supportController.sendMessage, { userId: u._id, body: { text } });
const chatOf = (u) => SupportChat.findOne({ userId: u._id }).lean();
// FAQAT guruhga (manfiy chat_id) ketgan xabarlar. Admin javobida mijozning SHAXSIY chatiga ham
// bildirishnoma ketadi (notifyUser) — u guruh postlariga kirmaydi.
const inGroup = (c) => String(c.body.chat_id).startsWith('-');
const sends = () => calls.filter((c) => c.method === 'sendMessage' && inGroup(c));
const edits = () => calls.filter((c) => c.method === 'editMessageText' && inGroup(c));
const lastText = () => [...calls].reverse().find((c) => (c.method === 'sendMessage' || c.method === 'editMessageText') && inGroup(c))?.body.text || '';
const reset = () => { calls.length = 0; editMode = 'ok'; };
const adminReply = (u, text = 'Javob') => call(supportController.reply, { userId: adminU._id, params: { id: String(u._chatId) }, body: { text } });

console.log('\n[1] 1-xabar: yangi post (sarlavha, mijoz, satr, holat, tugma)');
{
  reset();
  await say(A, 'Hop');
  const cA = await chatOf(A); A._chatId = cA._id;
  ok(sends().length === 1 && edits().length === 0, 'faqat 1 ta sendMessage');
  const t = sends()[0].body.text;
  ok(t.includes('🆘 <b>Yangi mijoz xabari</b>') && t.includes('👤 <b>Murodbek Amanov</b> · @muq') && t.includes('«Hop»'), 'sarlavha, mijoz va xabar');
  ok(/«Hop» · <i>\d\d:\d\d<\/i>/.test(t), 'xabar vaqti (HH:MM) ko‘rsatilgan');
  ok(t.includes('⏳ <i>Javob kutilmoqda</i>'), 'holat: ⏳ Javob kutilmoqda');
  ok(sends()[0].body.reply_markup.inline_keyboard[0][0].url === 'https://admin.lokma.uz/support', 'tugma: admin /support');
  ok(cA.groupPost?.messageId === 501 && cA.groupPost.lines.length === 1 && String(cA.groupPost.chatId) === '-100777', 'post bazada saqlandi (messageId, satrlar, guruh)');
}

console.log('\n[2] Qayta-qayta yozsa — YANGI xabar YO‘Q, o‘sha post tahrirlanadi, satrlar pastdan qo‘shiladi');
{
  reset();
  await say(A, 'Qanday krtsma buladi');
  await say(A, 'Yana bir savol');
  ok(sends().length === 0 && edits().length === 2, `sendMessage 0 ta, editMessageText 2 ta (${sends().length}/${edits().length})`);
  ok(edits().every((e) => e.body.chat_id === '-100777' && e.body.message_id === 501), 'ikkalasi ham 501-xabarni tahrirlaydi');
  const t = lastText();
  const i1 = t.indexOf('«Hop»'); const i2 = t.indexOf('«Qanday krtsma buladi»'); const i3 = t.indexOf('«Yana bir savol»');
  ok(i1 > 0 && i2 > i1 && i3 > i2, 'uchala satr tartib bilan (yangisi pastda)');
  ok(t.startsWith('🆘 <b>Yangi mijoz xabari</b>') && t.includes('⏳') && (t.match(/🆘/g) || []).length === 1, 'sarlavha bitta, holat ⏳');
  ok(edits()[1].body.reply_markup.inline_keyboard[0][0].url === 'https://admin.lokma.uz/support', 'tahrirda tugma saqlanib qoldi');
  ok(edits()[0].body.parse_mode === 'HTML', 'parse_mode HTML');
}

console.log('\n[3] BOSHQA mijoz — alohida post; xabarlar aralashsa ham har biri o‘z postiga');
{
  reset();
  await say(B, 'Salom, men Sitora');
  const cB = await chatOf(B); B._chatId = cB._id;
  ok(sends().length === 1 && sends()[0].body.text.includes('Sitora') && !sends()[0].body.text.includes('Murodbek'), 'Sitora — alohida yangi post');
  const idB = cB.groupPost.messageId;
  ok(idB !== 501, `boshqa xabar id (${idB})`);
  reset();
  await say(A, 'Men yana yozdim');          // A → B posti orasida ham A ning postiga
  ok(sends().length === 0 && edits().length === 1 && edits()[0].body.message_id === 501, 'A yana yozdi (orada B yozgan) — A ning eski posti tahrirlandi');
  ok(!lastText().includes('Sitora'), 'A ning postida B ning xabari YO‘Q');
  reset();
  await say(B, 'Men ham');
  ok(edits().length === 1 && edits()[0].body.message_id === idB && !lastText().includes('Murodbek'), 'B ning keyingi xabari — B ning postiga');
}

console.log('\n[3b] HTML belgilar qochiriladi');
{
  reset();
  const X = await User.create({ firstName: 'A<b>', telegramId: '333' });
  await say(X, '<script>alert(1)</script> & <b>qalin</b>');
  const t = sends()[0].body.text;
  ok(t.includes('A&lt;b&gt;') && t.includes('&lt;script&gt;') && t.includes('&amp;') && !t.includes('<script>'), 'ism va xabar qochirilgan (Telegram parse xatosi bermaydi)');
}

console.log('\n[4] ADMIN JAVOBI: o‘sha post tahrirlanadi — ✅✅ Javob berildi');
{
  reset();
  const r = await adminReply(A, 'Hozir yordam beraman');
  ok(r.status === 201, 'admin javobi qabul qilindi (201)');
  ok(edits().length === 1 && edits()[0].body.message_id === 501 && sends().length === 0, 'A ning posti tahrirlandi (yangi xabar YO‘Q)');
  const t = edits()[0].body.text;
  ok(t.includes('✅✅ <b>Javob berildi</b> · Bahrom') && !t.includes('⏳'), 'holat: ✅✅ Javob berildi · Bahrom (⏳ yo‘qoldi)');
  ok(t.includes('«Hop»') && t.includes('«Men yana yozdim»') && t.includes('🆘'), 'mijoz satrlari va sarlavha joyida');
  ok(/✅✅ <b>Javob berildi<\/b> · Bahrom · <i>\d\d:\d\d<\/i>/.test(t), 'javob vaqti ham bor');
  ok(edits()[0].body.reply_markup.inline_keyboard[0][0].text.includes('Xabarlar'), 'tugma joyida');
  const cA = await chatOf(A);
  ok(cA.groupPost.repliedAt && cA.groupPost.repliedBy === 'Bahrom', 'holat bazada (repliedAt, repliedBy)');
  ok(!edits().some((e) => e.body.message_id !== 501), 'boshqa mijozlar postiga TEGILMADI');

  reset();
  await adminReply(A, 'Yana bir javob');
  ok(edits().length === 0, 'ikkinchi javob — qayta tahrir yo‘q (holat allaqachon ✅✅)');
}

console.log('\n[5] Javobdan keyin mijoz yana yozsa — YANGI post (bildirishnoma), eskisi ✅✅ qoladi');
{
  reset();
  await say(A, 'Rahmat, yana savol bor');
  ok(sends().length === 1 && edits().length === 0, 'yangi post yuborildi (eskisi tahrirlanmadi)');
  const t = sends()[0].body.text;
  ok(t.includes('Yangi mijoz xabari') && t.includes('«Rahmat, yana savol bor»') && !t.includes('«Hop»') && t.includes('⏳'), 'yangi post: faqat yangi xabar, ⏳');
  const cA = await chatOf(A);
  ok(cA.groupPost.messageId !== 501 && !cA.groupPost.repliedAt && cA.groupPost.lines.length === 1, 'joriy post yangisiga almashdi');
  const newId = cA.groupPost.messageId;
  reset();
  await say(A, 'Yana');
  ok(edits().length === 1 && edits()[0].body.message_id === newId, 'keyingi xabar — yangi postni tahrirlaydi');
}

console.log('\n[6] Vaqt chegarasi: uzoq jimlikdan keyin yangi post; 0 — cheklovsiz');
{
  reset();
  const cB = await chatOf(B);
  await SupportChat.updateOne({ _id: cB._id }, { 'groupPost.lastLineAt': new Date(Date.now() - 61 * 60_000) });
  await say(B, 'Soat o‘tdi');
  ok(sends().length === 1 && edits().length === 0, '61 daqiqa jimlikdan keyin — YANGI post (tahrir bildirishnoma bermaydi)');
  reset();
  const cB2 = await chatOf(B);
  await SupportChat.updateOne({ _id: cB2._id }, { 'groupPost.lastLineAt': new Date(Date.now() - 59 * 60_000) });
  await say(B, 'Hali erta');
  ok(edits().length === 1 && sends().length === 0, '59 daqiqa — hali o‘sha post');
  reset();
  config.supportGroupThreadMinutes = 0;
  const cB3 = await chatOf(B);
  await SupportChat.updateOne({ _id: cB3._id }, { 'groupPost.lastLineAt': new Date(Date.now() - 48 * 3_600_000) });
  await say(B, 'Ikki kundan keyin');
  ok(edits().length === 1 && sends().length === 0, 'THREAD_MINUTES=0: 48 soatdan keyin ham (javobgacha) o‘sha post');
  config.supportGroupThreadMinutes = 60;
}

console.log('\n[7] POYGA: bir mijozning 5 ta xabari BIR VAQTDA — bitta post, 5 satr');
{
  reset();
  const C = await User.create({ firstName: 'Poyga', telegramId: '444' });
  const cC0 = await SupportChat.create({ userId: C._id, firstName: 'Poyga', messages: [] });
  await Promise.all(['1', '2', '3', '4', '5'].map((n) => notifySupportGroup(cC0, `parallel ${n}`)));
  const cC = await chatOf(C);
  ok(sends().length === 1, `faqat 1 ta post yaratildi (${sends().length})`);
  ok(edits().length === 4, `4 ta tahrir (${edits().length})`);
  ok(cC.groupPost.lines.length === 5, `bazada 5 satr: ${cC.groupPost.lines.length}`);
  const t = lastText();
  ok(['1', '2', '3', '4', '5'].every((n) => t.includes(`«parallel ${n}»`)), 'oxirgi post matnida 5 ta xabarning hammasi bor (birortasi yo‘qolmagan)');

  // Qo'sh bosish, suhbat allaqachon bor (HAQIQIY controller): ikkalasi xatosiz, guruhda 1 post
  reset();
  const D2 = await User.create({ firstName: 'QoshBosish', telegramId: '4441' });
  await SupportChat.create({ userId: D2._id, firstName: 'QoshBosish', telegramId: '4441', messages: [] });
  const [r1, r2] = await Promise.all([say(D2, 'bir'), say(D2, 'bir')]);
  ok(r1.status === 201 && r2.status === 201, `qo‘sh bosish: ikkala so‘rov 201 (${r1.status}/${r2.status})`);
  const cD2 = await chatOf(D2);
  // Suhbat tarixidagi xabarlar SONI tekshirilmaydi: FerretDB (faqat test bazasi) parallel $push ni atomik
  // bajarmaydi — real MongoDB'da yo'q. Guruh posti esa bizning qulfimiz bilan deterministik.
  ok(cD2.groupPost?.lines?.length === 2 && sends().length === 1 && edits().length === 1, `guruhda 1 post 2 satr bilan (satr ${cD2.groupPost?.lines?.length}, post ${sends().length}, tahrir ${edits().length})`);

  // ensureChat poygasi: ikkinchi so'rov "suhbat yo'q" deb ko'rdi, lekin birinchisi yaratib ulgurdi (E11000)
  reset();
  const D3 = await User.create({ firstName: 'Poyga2', telegramId: '4442' });
  await SupportChat.create({ userId: D3._id, firstName: 'Poyga2', telegramId: '4442', messages: [] });
  const origFind = SupportChat.findOne.bind(SupportChat);
  let firstFind = true;
  SupportChat.findOne = (...a) => { if (firstFind) { firstFind = false; return Promise.resolve(null); } return origFind(...a); };
  const r3 = await say(D3, 'poyga');
  SupportChat.findOne = origFind;
  ok(r3.status === 201, `yaratishda unique indeks to‘qnashuvi (E11000) — mijozga 500 EMAS, xabar qabul qilindi (${r3.status})`);
  ok((await chatOf(D3)).messages.length === 1, 'xabar mavjud suhbatga qo‘shildi');
}

console.log('\n[8] TAHRIR XATOLARI: xabar yo‘qolmasin');
{
  reset();
  const D = await User.create({ firstName: 'Xato', telegramId: '555' });
  await say(D, 'birinchi');
  const first = (await chatOf(D)).groupPost.messageId;

  reset(); editMode = 'notfound'; // post guruhdan o'chirilgan
  await say(D, 'ikkinchi');
  ok(edits().length === 1 && sends().length === 1, 'post o‘chirilgan: tahrir urinildi → mijoz xabari YANGI postda yuborildi');
  ok(sends()[0].body.text.includes('«ikkinchi»') && !sends()[0].body.text.includes('«birinchi»'), 'yangi post faqat yangi xabar bilan');
  const cur = (await chatOf(D)).groupPost.messageId;
  ok(cur !== first, 'joriy post yangilandi');

  reset(); editMode = 'neterr';
  await say(D, 'uchinchi');
  ok(sends().length === 1 && sends()[0].body.text.includes('«uchinchi»'), 'tarmoq xatosi (tahrirda) — xabar baribir yangi postda yuborildi');

  reset(); editMode = 'notmodified';
  await say(D, 'to‘rtinchi');
  ok(sends().length === 0 && (await chatOf(D)).groupPost.lines.some((l) => l.text === 'to‘rtinchi'), '"message is not modified" — xato emas: yangi post yo‘q, satr saqlandi');
  editMode = 'ok';
}

console.log('\n[9] JAVOB belgisida xato bo‘lsa ham javob qayd etiladi; post yo‘q bo‘lsa jim');
{
  reset();
  const E = await User.create({ firstName: 'Javob', telegramId: '666' });
  await say(E, 'savol'); E._chatId = (await chatOf(E))._id;
  reset(); editMode = 'notfound';
  const r = await adminReply(E);
  ok(r.status === 201, 'admin javobi baribir yuborildi (201)');
  ok((await chatOf(E)).groupPost.repliedAt, 'repliedAt qayd etildi (post o‘chirilgan bo‘lsa ham)');
  editMode = 'ok'; reset();
  await say(E, 'yana');
  ok(sends().length === 1, 'shundan keyingi xabar — yangi post');

  // Guruh sozlanmagan paytdagi eski suhbat: post yo'q
  reset();
  const F = await User.create({ firstName: 'Eski', telegramId: '777' });
  const cF = await SupportChat.create({ userId: F._id, firstName: 'Eski', messages: [{ from: 'user', text: 'eski xabar' }] });
  const res = await call(supportController.reply, { userId: adminU._id, params: { id: String(cF._id) }, body: { text: 'j' } });
  ok(res.status === 201 && calls.filter(inGroup).length === 0, 'post bo‘lmagan suhbatga javob — guruhga hech narsa yuborilmadi, xato yo‘q');
}

console.log('\n[10] Uzun suhbat: post to‘lsa davomi yangi postda; Telegram chegarasidan oshmaydi');
{
  reset();
  const G = await User.create({ firstName: 'Uzun', telegramId: '888' });
  const big = 'x'.repeat(1400);
  await say(G, `1 ${big}`); await say(G, `2 ${big}`); await say(G, `3 ${big}`);
  ok(calls.every((c) => (c.body.text || '').length <= 4096), `hech bir xabar 4096 dan oshmadi (eng katta ${Math.max(...calls.map((c) => (c.body.text || '').length))})`);
  ok(sends().length === 2, `3 ta katta xabar: 2 ta post (${sends().length})`);
  ok(sends()[1].body.text.includes('(davomi)') && sends()[1].body.text.includes(`«3 x`), 'ikkinchi post "(davomi)" belgisi bilan');
  const cG = await chatOf(G);
  ok(cG.groupPost.continued === true && cG.groupPost.lines.length === 1, 'joriy post — davomi');
  reset();
  await say(G, 'z'.repeat(2000));
  ok(calls.every((c) => (c.body.text || '').length <= 4096), '2000 belgilik xabar ham chegaradan oshirmaydi (satr 1500 gacha qisqartiriladi)');
}

console.log('\n[11] Sozlama: o‘chiq bo‘lsa jim; guruh almashsa eski post tahrirlanmaydi');
{
  reset();
  const saved = config.supportGroupChatId;
  config.supportGroupChatId = '';
  const H = await User.create({ firstName: 'Jim', telegramId: '999' });
  await say(H, 'salom');
  await adminReply({ _chatId: (await chatOf(H))._id }, 'j');
  ok(calls.filter(inGroup).length === 0, 'SUPPORT_GROUP_CHAT_ID bo‘sh — GURUHGA hech narsa yuborilmadi/tahrirlanmadi (mijoz va admin yo‘llari)');
  config.supportGroupChatId = saved;

  reset();
  await say(H, 'guruh yoqildi'); // post yaratiladi (-100777)
  const first = (await chatOf(H)).groupPost;
  reset();
  config.supportGroupChatId = '-100888'; // boshqa guruh
  await say(H, 'guruh almashdi');
  ok(sends().length === 1 && sends()[0].body.chat_id === '-100888' && edits().length === 0, 'guruh almashdi — eski guruhdagi post tahrirlanmadi, yangi guruhda YANGI post');
  ok(String((await chatOf(H)).groupPost.chatId) === '-100888' && first.chatId === '-100777', 'joriy post yangi guruhga bog‘landi');
  config.supportGroupChatId = saved;
}

console.log('\n[12] Eski shakl: `_id`siz oddiy obyekt — bitta post (test:support-group bilan mos)');
{
  reset();
  await notifySupportGroup({ firstName: 'Oddiy', username: 'odd' }, 'salom');
  ok(sends().length === 1 && sends()[0].body.text.includes('@odd') && sends()[0].body.text.includes('«salom»'), 'bitta post, mijoz va matn bor');
  ok((await markSupportGroupReplied(null, 'x')) === null, 'markSupportGroupReplied(null) — jim');
}

console.log('\n[13] buildPostText (sof funksiya)');
{
  const at = new Date('2026-09-29T03:38:00Z'); // Toshkent 08:38
  const t = buildPostText({ firstName: 'Ali', username: 'ali' }, { lines: [{ text: 'Hop', at }], repliedAt: new Date('2026-09-29T03:41:00Z'), repliedBy: 'Admin' });
  ok(t.includes('«Hop» · <i>08:38</i>') && t.includes('✅✅ <b>Javob berildi</b> · Admin · <i>08:41</i>'), 'vaqt Toshkent bo‘yicha (UTC+5): 08:38 / 08:41');
  ok(buildPostText({ firstName: 'Ali' }, { lines: [{ text: 'x', at }], continued: true }).includes('(davomi)'), 'continued → "(davomi)"');
  ok(buildPostText({}, { lines: [{ text: 'x', at }] }).includes('<b>Mijoz</b>'), 'ismsiz mijoz → "Mijoz"');
}

console.log(fails ? `\n✗ ${fails} ta xato` : '\n✓ HAMMASI O‘TDI');
await mongoose.disconnect();
process.exit(fails ? 1 : 0);
