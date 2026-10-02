/*
 * ═══════════════════════════════════════════════════════════
 * ERTALABKI OCHILISH TEKSHIRUVI (Morning Open Checklist)
 * ═══════════════════════════════════════════════════════════
 * Vaqt qoidalari (chegaralar, vaqt zonalari, tungi restoran), yuborish, eslatma, bot
 * callback'lari (Barchasi bor / Stopga quyish / taom stop), atomiklik (bir vaqtda ko'p xodim),
 * xavfsizlik (begona restoran), xato izolyatsiyasi, panel/admin API, tezlik (500 restoran).
 * Telegram soxta (fetch ushlanadi), "hozir" — parametr bilan: kutish yo'q.
 * npm run test:morning
 */
process.env.MONGO_URI = 'mongodb://127.0.0.1:27017/lokma_morning';
process.env.JWT_SECRET = 'x'.repeat(40);
process.env.RESTAURANT_BOT_TOKEN = '1:R';
process.env.TELEGRAM_BOT_TOKEN = '';

// ── soxta Telegram ──
const calls = [];
let msgSeq = 1000;
const failChats = new Set();
globalThis.fetch = async (url, opts) => {
  const method = String(url).split('/').pop();
  const body = JSON.parse(opts.body);
  calls.push({ method, body });
  if (method === 'sendMessage') {
    if (failChats.has(String(body.chat_id))) return { ok: true, status: 200, json: async () => ({ ok: false, description: 'Forbidden: bot was blocked by the user' }) };
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: ++msgSeq } }) };
  }
  return { ok: true, status: 200, json: async () => ({ ok: true, result: true }) };
};
const origErr = console.error; const origLog = console.log;
const logs = [];
console.error = (...a) => { logs.push(a.join(' ')); };

const mongoose = (await import('mongoose')).default;
await mongoose.connect(process.env.MONGO_URI);
await mongoose.connection.db.dropDatabase();

const { Restaurant } = await import('../src/models/Restaurant.js');
const { Dish } = await import('../src/models/Dish.js');
const { RestaurantTelegramStaff } = await import('../src/models/RestaurantTelegramStaff.js');
const { RestaurantDailyCheck } = await import('../src/models/RestaurantDailyCheck.js');
const { config } = await import('../src/config/index.js');
const M = await import('../src/services/morningChecklist.js');
const { handleRestaurantBotUpdate } = await import('../src/services/restaurantBot.js');
const { morningCheckController } = await import('../src/controllers/morningCheck.js');

let fails = 0;
const ok = (c, m) => { origLog(c ? '  ✓' : '  ✗ FAIL:', m); if (!c) fails++; };
const section = (t) => origLog(`\n${t}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sent = () => calls.filter((c) => c.method === 'sendMessage');
const edits = () => calls.filter((c) => c.method === 'editMessageText');
const answers = () => calls.filter((c) => c.method === 'answerCallbackQuery');
const lastAnswer = () => answers().at(-1)?.body.text || '';
const reset = () => { calls.length = 0; };
const MIN = 60_000; const HOUR = 3_600_000;

// 2026-10-05 — DUSHANBA. Toshkent UTC+5; Nyu-York (EDT) UTC-4.
const OPEN_TASH = Date.UTC(2026, 9, 5, 5, 0, 0);          // 10:00 Toshkent
const OPEN_NY = Date.UTC(2026, 9, 5, 13, 0, 0);           // 09:00 Nyu-York
const OPEN_NIGHT = Date.UTC(2026, 9, 5, 17, 0, 0);        // 22:00 Toshkent
const ALL = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

const mkRest = (name, over = {}) => Restaurant.create({
  name, cuisine: 'x', category: 'restoran', isActive: true, isApproved: true,
  openTime: '10:00', closeTime: '23:00', timezone: 'Asia/Tashkent', workingDays: ALL, ...over,
});
let tg = 7000;
const mkStaff = (r, over = {}) => { tg += 1; return RestaurantTelegramStaff.create({ restaurantId: r._id, username: `u${tg}`, telegramUserId: String(tg), firstName: `Xodim${tg}`, isActive: true, ...over }); };
let cbSeq = 0;
const cq = (staff, data, messageId = 555) => ({ id: `cb${++cbSeq}`, from: { id: Number(staff.telegramUserId) }, data, message: { message_id: messageId, chat: { id: Number(staff.telegramUserId) } } });
const press = (staff, data, messageId) => M.handleMorningChecklistCallback(cq(staff, data, messageId));

/* ── restoranlar ── */
const A = await mkRest('A Toshkent');
const B = await mkRest('B Nyu-York', { openTime: '09:00', closeTime: '18:00', timezone: 'America/New_York' });
const C = await mkRest('C Tungi', { openTime: '22:00', closeTime: '02:00' });
const D = await mkRest('D Nofaol', { isActive: false });
const E = await mkRest('E Bloklangan', { isBlocked: true });
const F = await mkRest('F Tasdiqlanmagan', { isApproved: false });
const G = await mkRest('G Bo‘sh kunlar', { workingDays: [] });
const H = await mkRest('H Vaqtsiz', { openTime: '', closeTime: '' });
const I = await mkRest('I 24 soat', { openTime: '00:00', closeTime: '00:00' });
const J = await mkRest('J Dushanba dam', { workingDays: ['tue', 'wed', 'thu', 'fri', 'sat', 'sun'] });
const K = await mkRest('K Boshqa restoran');
const aStaff = [await mkStaff(A), await mkStaff(A), await mkStaff(A)];
await mkStaff(A, { isActive: false });               // nofaol xodim
await mkStaff(A, { telegramUserId: null });          // ulanmagan xodim
for (const r of [B, C, D, E, F, G, H, I, J]) await mkStaff(r);
const plain = (r) => r.toObject();

section('[1] MATN va TUGMALAR — TZ dagi AYNAN');
{
  ok(M.MORNING_TEXT === 'Retoran ochilishi bilan taomlarizni rekshirib oling ish boshlashdan oldin Stopdagi taomlarizni Stop listga qushib quying esizdan chiqmasin mijizlarni hurmat qilaylik bugungi boshlagan ishizni olloh barokatli qilsin', 'xabar matni so‘zma-so‘z (imlo xatolari ham o‘zgarmagan)');
  const kb = M.morningKeyboard('RID', '2026-10-05').inline_keyboard;
  ok(kb.length === 1 && kb[0].length === 2 && kb[0][0].text === '🛑 Stopga quyish' && kb[0][0].callback_data === 'mc:stop:RID:2026-10-05' && kb[0][1].text === '✅ Barchasi bor' && kb[0][1].callback_data === 'mc:all:RID:2026-10-05', 'ikki tugma: "🛑 Stopga quyish" va "✅ Barchasi bor", callback_data mc:stop/mc:all:{rid}:{date}');
  ok(`mc:stop:${'a'.repeat(24)}:2026-10-05`.length <= 64 && `mc:set:${'a'.repeat(24)}:1:99`.length <= 64, 'callback_data 64 baytdan oshmaydi (Telegram chegarasi)');
}

section('[2] VAQT QOIDALARI (sof funksiyalar)');
{
  ok(M.getTodayYmd(plain(A), OPEN_TASH) === '2026-10-05' && M.getTodayYmd(plain(A), Date.UTC(2026, 9, 5, 19, 30)) === '2026-10-06', 'sana restoran zonasida: 19:30 UTC = Toshkentda ERTASI KUN (06.10)');
  ok(M.getTodayYmd(plain(B), Date.UTC(2026, 9, 5, 2, 0)) === '2026-10-04', 'Nyu-York: 02:00 UTC = hali 04.10');
  ok(M.hasOpeningTime(plain(A)) && !M.hasOpeningTime(plain(H)) && !M.hasOpeningTime(plain(I)), 'ochilish vaqti bor / vaqtsiz / 24 soat (open=close) — oxirgi ikkisida "ochilish" yo‘q');
  ok(M.isWorkday(plain(A), '2026-10-05') && !M.isWorkday(plain(G), '2026-10-05') && !M.isWorkday(plain(J), '2026-10-05') && M.isWorkday(plain(J), '2026-10-06'), 'ish kuni: bo‘sh workingDays = ish kuni EMAS; dushanba dam restoranda yo‘q, seshanba bor');
  ok(M.openingInstant(plain(A), '2026-10-05').getTime() === OPEN_TASH && M.openingInstant(plain(B), '2026-10-05').getTime() === OPEN_NY, 'ochilish paytining haqiqiy vaqti (Toshkent UTC+5, Nyu-York yozgi vaqt UTC-4)');

  const first = (r, t, check = null) => M.shouldSendFirstMessage(plain(r), t, check);
  ok(!first(A, OPEN_TASH - 1000), '09:59:59 — hali erta');
  ok(first(A, OPEN_TASH), '10:00:00 — aynan ochilish: YUBORILADI');
  ok(first(A, OPEN_TASH + 10 * MIN + 59_000), '10:10:59 — oyna ichida (10 daqiqagacha kechikish)');
  ok(!first(A, OPEN_TASH + 11 * MIN), '10:11:00 — oyna tugadi');
  ok(first(A, OPEN_TASH, { status: 'pending', firstSentAt: null }), 'yozuv bor, pending va birinchi xabar ketmagan — yuboriladi');
  ok(!first(A, OPEN_TASH, { status: 'pending', firstSentAt: new Date() }) && !first(A, OPEN_TASH, { status: 'checked_all_ok', firstSentAt: null }), 'birinchi xabar ketgan yoki javob berilgan — qayta yuborilmaydi');
  ok(!first(G, OPEN_TASH) && !first(H, OPEN_TASH) && !first(I, OPEN_TASH) && !first(J, OPEN_TASH), 'workingDays bo‘sh / vaqtsiz / 24 soat / dam kuni — YUBORILMAYDI');
  ok(!first(B, OPEN_TASH) && first(B, OPEN_NY) && !first(B, OPEN_NY - 1000) && first(B, OPEN_NY + 10 * MIN), 'VAQT ZONASI: Nyu-York restorani o‘z 09:00 sida (13:00 UTC); Toshkent soati 10:00 unga mos emas');
  ok(first(C, OPEN_NIGHT) && !first(C, OPEN_NIGHT - 1000) && !first(C, OPEN_NIGHT + 11 * MIN), 'tungi restoran (22:00–02:00): 22:00 da yuboriladi');
  const sess = (utc) => M.sessionYmd(plain(C), utc);
  ok(sess(Date.UTC(2026, 9, 5, 17, 30)) === '2026-10-05', 'tungi restoran: dushanba 22:30 (Toshkent) — seans dushanba');
  ok(sess(Date.UTC(2026, 9, 5, 20, 30)) === '2026-10-05', 'tungi restoran: seshanba 01:30 — seans hali DUSHANBA (ochilgan kun)');
  ok(sess(Date.UTC(2026, 9, 5, 21, 0)) === '2026-10-06', 'tungi restoran: seshanba 02:00 (yopilish) — yangi kun');
  ok(M.sessionYmd(plain(A), Date.UTC(2026, 9, 5, 20, 30)) === '2026-10-06', 'oddiy restoran: yarim tundan keyin — yangi kun (kechagisiga qaytmaydi)');

  const chk = (over = {}) => ({ date: '2026-10-05', status: 'pending', firstSentAt: new Date(OPEN_TASH), lastReminderAt: new Date(OPEN_TASH), ...over });
  const rem = (t, c = chk()) => M.shouldSendReminder(plain(A), c, t);
  ok(!rem(OPEN_TASH + 59 * MIN + 59_000), 'eslatma: 59:59 — hali erta');
  ok(rem(OPEN_TASH + 60 * MIN), 'eslatma: aynan 60 daqiqa — yuboriladi');
  ok(!rem(OPEN_TASH + 60 * MIN, chk({ lastReminderAt: new Date(OPEN_TASH + 30 * MIN) })), 'oxirgi eslatmadan boshlab hisoblanadi (lastReminderAt), birinchi xabardan emas');
  ok(rem(OPEN_TASH + 90 * MIN, chk({ lastReminderAt: new Date(OPEN_TASH + 30 * MIN) })), '…30 daqiqada eslatma bo‘lgan bo‘lsa, 90 da yana');
  ok(rem(OPEN_TASH + 60 * MIN, chk({ lastReminderAt: null })), 'lastReminderAt yo‘q — birinchi xabardan hisoblanadi');
  ok(!rem(OPEN_TASH + 60 * MIN, chk({ status: 'checked_all_ok' })) && !rem(OPEN_TASH + 60 * MIN, chk({ status: 'checked_with_stop' })), 'javob berilgan — eslatma YO‘Q');
  ok(!rem(OPEN_TASH + 60 * MIN, chk({ firstSentAt: null })), 'birinchi xabar ketmagan — bu eslatma emas');
  ok(!rem(OPEN_TASH + 60 * MIN, chk({ date: '2026-10-04' })), 'kechagi yozuv — bugun eslatma yo‘q');
  ok(!M.shouldSendReminder(plain(A), chk({ lastReminderAt: new Date(OPEN_TASH) }), Date.UTC(2026, 9, 5, 18, 0)) && !M.shouldSendReminder(plain(A), chk({ lastReminderAt: new Date(OPEN_TASH) }), Date.UTC(2026, 9, 5, 19, 0)), 'yopilish (23:00 = 18:00 UTC) dan keyin eslatma YO‘Q');
  ok(M.shouldSendReminder(plain(A), chk({ lastReminderAt: new Date(OPEN_TASH) }), Date.UTC(2026, 9, 5, 17, 59)), '22:59 (yopilishdan 1 daqiqa oldin) — hali eslatadi');
}

section('[3] CRON: ochilishda xabar — barcha FAOL xodimlarga, aynan bir marta');
let check1;
{
  reset();
  const r = await M.checkMorningChecklists(OPEN_TASH);
  const s = sent();
  const toA = s.filter((c) => aStaff.some((x) => String(c.body.chat_id) === x.telegramUserId));
  ok(toA.length === 3, `A restorani: 3 ta faol ulangan xodimga ${toA.length} xabar (nofaol va ulanmagan xodimga yo‘q)`);
  ok(toA.every((c) => c.body.text === M.MORNING_TEXT && c.body.reply_markup.inline_keyboard[0].length === 2), 'har birida aynan TZ matni va 2 tugma');
  ok(toA.every((c) => c.body.reply_markup.inline_keyboard[0][0].callback_data === `mc:stop:${A._id}:2026-10-05` && c.body.reply_markup.inline_keyboard[0][1].callback_data === `mc:all:${A._id}:2026-10-05`), 'callback_data da restoran id va sana');
  check1 = await RestaurantDailyCheck.findOne({ restaurantId: A._id, date: '2026-10-05' }).lean();
  ok(check1 && check1.status === 'pending' && check1.firstSentAt && check1.reminderCount === 0 && check1.messages.length === 3, 'yozuv: pending, firstSentAt, reminderCount 0, 3 ta xabar id si saqlandi');
  const others = s.filter((c) => ![...aStaff].some((x) => String(c.body.chat_id) === x.telegramUserId));
  ok(others.length === 0, `boshqa restoranlarga (B-K: nofaol, bloklangan, tasdiqlanmagan, ish kuni emas, vaqtsiz, 24 soat, boshqa zona) HECH QANDAY xabar yo‘q (${others.length})`);
  ok(r.first === 1 && r.errors === 0, `natija: ${JSON.stringify(r)}`);
}
{
  reset();
  await M.checkMorningChecklists(OPEN_TASH);
  await M.checkMorningChecklists(OPEN_TASH + MIN);
  await M.checkMorningChecklists(OPEN_TASH + 10 * MIN);
  ok(sent().length === 0, 'keyingi tick’lar (bir daqiqadan keyin, oyna ichida ham) — takror YUBORMAYDI');
  ok(await RestaurantDailyCheck.countDocuments({ restaurantId: A._id }) === 1, 'yozuv bitta (unique)');
}

section('[4] ESLATMA: har soatda, javob bo‘lmasa; yopilgach to‘xtaydi');
{
  reset();
  await M.checkMorningChecklists(OPEN_TASH + 59 * MIN);
  ok(sent().filter((c) => aStaff.some((x) => String(c.body.chat_id) === x.telegramUserId)).length === 0, '59 daqiqa — eslatma yo‘q');
  await M.checkMorningChecklists(OPEN_TASH + 60 * MIN);
  const rem1 = sent().filter((c) => aStaff.some((x) => String(c.body.chat_id) === x.telegramUserId));
  ok(rem1.length === 3 && rem1.every((c) => c.body.text === M.MORNING_TEXT), '60 daqiqada: 3 xodimga eslatma (matn o‘sha)');
  const c1 = await RestaurantDailyCheck.findOne({ restaurantId: A._id, date: '2026-10-05' }).lean();
  ok(c1.reminderCount === 1 && c1.messages.length === 6 && c1.messages.filter((m) => m.kind === 'reminder').length === 3, 'reminderCount 1, xabarlar 6 ta (3 birinchi + 3 eslatma)');
  reset();
  await M.checkMorningChecklists(OPEN_TASH + 61 * MIN);
  ok(sent().filter((c) => aStaff.some((x) => String(c.body.chat_id) === x.telegramUserId)).length === 0, '61 daqiqa — takror yo‘q');
  await M.checkMorningChecklists(OPEN_TASH + 120 * MIN);
  const c2 = await RestaurantDailyCheck.findOne({ restaurantId: A._id, date: '2026-10-05' }).lean();
  ok(c2.reminderCount === 2, '120 daqiqada ikkinchi eslatma (reminderCount 2)');
  reset();
  await M.checkMorningChecklists(Date.UTC(2026, 9, 5, 18, 5));    // 23:05 Toshkent — yopiq
  await M.checkMorningChecklists(Date.UTC(2026, 9, 5, 20, 0));
  ok(sent().filter((c) => aStaff.some((x) => String(c.body.chat_id) === x.telegramUserId)).length === 0, 'yopilgandan keyin (23:05, 01:00) eslatma YO‘Q');
}

section('[5] "BARCHASI BOR" — atomik, hamma xodimdagi tugmalar olinadi, eslatma to‘xtaydi');
{
  reset();
  const msgs = (await RestaurantDailyCheck.findOne({ restaurantId: A._id, date: '2026-10-05' }).lean()).messages;
  await press(aStaff[0], `mc:all:${A._id}:2026-10-05`, msgs[0].messageId);
  const c = await RestaurantDailyCheck.findOne({ restaurantId: A._id, date: '2026-10-05' }).lean();
  ok(c.status === 'checked_all_ok' && c.respondedBy === aStaff[0].telegramUserId && c.respondedVia === 'bot' && c.respondedAt && c.respondedByName.startsWith('Xodim'), `holat checked_all_ok, respondedBy=${c.respondedBy}, via=${c.respondedVia}, ism=${c.respondedByName}`);
  ok(/Rahmat/.test(lastAnswer()), `xodimga javob: "${lastAnswer()}"`);
  const closed = edits().filter((e) => /Tekshirildi/.test(e.body.text) && !e.body.reply_markup);
  ok(closed.length === msgs.length && new Set(closed.map((e) => e.body.message_id)).size === msgs.length, `barcha ${msgs.length} ta xabar (birinchi + eslatmalar, hamma xodimda) tugmasiz va "✅ Tekshirildi" bilan tahrirlandi`);
  reset();
  await M.checkMorningChecklists(OPEN_TASH + 180 * MIN);
  ok(sent().filter((c2) => aStaff.some((x) => String(c2.body.chat_id) === x.telegramUserId)).length === 0, 'javobdan keyin eslatma kelmaydi');

  reset();
  await press(aStaff[1], `mc:all:${A._id}:2026-10-05`, msgs[1].messageId);
  const c2 = await RestaurantDailyCheck.findOne({ restaurantId: A._id, date: '2026-10-05' }).lean();
  ok(lastAnswer() === 'Allaqachon tekshirilgan' && c2.respondedBy === aStaff[0].telegramUserId && edits().length === 0, 'ikkinchi xodim bossa: "Allaqachon tekshirilgan", birinchisining yozuvi O‘ZGARMADI, qayta tahrir yo‘q');
  await press(aStaff[0], `mc:all:${A._id}:2026-10-05`, msgs[0].messageId);
  ok(lastAnswer() === 'Allaqachon tekshirilgan', 'bir xodim ikki marta bossa ham xato yo‘q (idempotent)');
}
{
  // BIR VAQTDA ko'p xodim: aynan bittasi yutadi
  const R = await mkRest('Poyga');
  const st = [await mkStaff(R), await mkStaff(R), await mkStaff(R)];
  await M.checkMorningChecklists(OPEN_TASH + 5_000);
  reset();
  await Promise.all([...st, ...st].map((s) => press(s, `mc:all:${R._id}:2026-10-05`, 1)));
  const rows = await RestaurantDailyCheck.find({ restaurantId: R._id }).lean();
  const won = answers().filter((a) => /Rahmat/.test(a.body.text || '')).length;
  const dup = answers().filter((a) => /Allaqachon/.test(a.body.text || '')).length;
  ok(rows.length === 1 && rows[0].status === 'checked_all_ok' && won === 1 && dup === 5, `6 ta bir vaqtdagi bosish: 1 ta "Rahmat", 5 ta "Allaqachon" (${won}/${dup}); yozuv bitta`);
}

section('[5b] BOSHQA VAQT ZONALARI va TUNGI RESTORAN (har biri o‘z ochilish paytida)');
{
  const own = async (r) => (await RestaurantTelegramStaff.find({ restaurantId: r._id }).lean()).map((x) => x.telegramUserId);
  reset();
  const r = await M.checkMorningChecklists(OPEN_NY + MIN);
  const bIds = await own(B);
  ok(sent().filter((c) => bIds.includes(String(c.body.chat_id))).length === 1 && r.first >= 1, 'Nyu-York restorani o‘z ochilish vaqtida (13:01 UTC = 09:01 Nyu-York) xabar oldi');
  const bDoc = await RestaurantDailyCheck.findOne({ restaurantId: B._id }).lean();
  ok(bDoc.date === '2026-10-05', 'yozuv sanasi — restoran zonasidagi kun');
  reset();
  await M.checkMorningChecklists(OPEN_NIGHT + MIN);
  const cIds = await own(C);
  ok(sent().filter((c) => cIds.includes(String(c.body.chat_id))).length === 1, 'tungi restoran (22:00–02:00) 22:01 da xabar oldi');
  reset();
  await M.checkMorningChecklists(Date.UTC(2026, 9, 5, 20, 30));     // seshanba 01:30 Toshkent — tungi restoran hali ochiq
  ok(sent().filter((c) => cIds.includes(String(c.body.chat_id))).length === 1, 'tungi restoran 01:30 da (hamon ochiq, javob yo‘q, 3.5 soat o‘tdi) — eslatma KELADI');
  const cDoc = await RestaurantDailyCheck.findOne({ restaurantId: C._id }).lean();
  ok(await RestaurantDailyCheck.countDocuments({ restaurantId: C._id }) === 1 && cDoc.date === '2026-10-05' && cDoc.reminderCount === 1, 'yarim tundan keyin ham yozuv BITTA va sanasi ochilgan kun (2026-10-05), reminderCount 1');
  reset();
  await M.checkMorningChecklists(Date.UTC(2026, 9, 5, 21, 30));      // 02:30 — yopilgan
  ok(sent().filter((c) => cIds.includes(String(c.body.chat_id))).length === 0, 'tungi restoran yopilgach (02:30) — eslatma YO‘Q');
}

section('[6] "STOPGA QUYISH": ro‘yxat ochiladi, taom stop/qaytarish (panel bilan bir xil)');
let stopStaff; let stopRest;
{
  stopRest = await mkRest('Stop sinovi', { openTime: '11:00' });
  stopStaff = [await mkStaff(stopRest), await mkStaff(stopRest)];
  for (let i = 1; i <= 20; i++) await Dish.create({ restaurantId: stopRest._id, section: i <= 12 ? 'a-menu' : 'b-ichimlik', name: `Taom ${String(i).padStart(2, '0')}`, price: 1000 * i });
  const foreignDish = await Dish.create({ restaurantId: A._id, section: 'menu', name: 'Begona taom', price: 1 });
  await M.checkMorningChecklists(Date.UTC(2026, 9, 5, 6, 1));     // 11:01 Toshkent
  reset();
  const first = await RestaurantDailyCheck.findOne({ restaurantId: stopRest._id, date: '2026-10-05' }).lean();
  ok(first && first.messages.length === 2, 'tayyorgarlik: 2 xodimga xabar ketgan');
  const mine = first.messages.find((m) => m.chatId === stopStaff[0].telegramUserId);
  const theirs = first.messages.find((m) => m.chatId === stopStaff[1].telegramUserId);

  await press(stopStaff[0], `mc:stop:${stopRest._id}:2026-10-05`, mine.messageId);
  const doc = await RestaurantDailyCheck.findOne({ restaurantId: stopRest._id, date: '2026-10-05' }).lean();
  ok(doc.status === 'checked_with_stop' && doc.respondedVia === 'bot' && doc.respondedBy === stopStaff[0].telegramUserId, 'holat checked_with_stop');
  const menu = edits().find((e) => e.body.message_id === mine.messageId);
  const rows = menu.body.reply_markup.inline_keyboard;
  ok(/Stop-list/.test(menu.body.text) && /Stopda: <b>0<\/b> ta · Sahifa 1\/3/.test(menu.body.text), 'xodimning xabari taomlar ro‘yxatiga aylandi: "Stopda: 0 ta · Sahifa 1/3"');
  ok(rows.filter((r) => r[0].callback_data.startsWith('mc:set:')).length === 8 && rows.at(-2)[0].callback_data === `mc:menu:${stopRest._id}:1` && rows.at(-1)[0].callback_data === `mc:done:${stopRest._id}`, '8 ta taom + "▶️" (keyingi sahifa) + "✅ Tayyor"');
  ok(rows[0][0].text === '✅ Taom 01' && rows[0][0].callback_data.endsWith(':0:0'), 'tugma: "✅ Taom 01" — hozir bor; bossangiz STOPga (…:0:0)');
  const other = edits().find((e) => e.body.message_id === theirs.messageId);
  ok(other && /Stop-list yangilandi/.test(other.body.text) && !other.body.reply_markup, 'boshqa xodimning xabari yopildi (tugmasiz, "Stop-list yangilandi")');

  // taomni stopga qo'yish
  reset();
  const dish1 = await Dish.findOne({ restaurantId: stopRest._id, name: 'Taom 01' });
  await press(stopStaff[0], `mc:set:${dish1._id}:0:0`, mine.messageId);
  ok((await Dish.findById(dish1._id)).isAvailable === false, 'Dish.isAvailable = false (STOPda)');
  ok(/stopga qo‘yildi/.test(lastAnswer()), `xodimga: "${lastAnswer()}"`);
  const re = edits().at(-1).body;
  ok(/Stopda: <b>1<\/b> ta/.test(re.text) && re.reply_markup.inline_keyboard[0][0].text === '🛑 Taom 01' && re.reply_markup.inline_keyboard[0][0].callback_data.endsWith(':1:0'), 'ro‘yxat joyida yangilandi: "🛑 Taom 01" (bossangiz qaytadi …:1:0), Stopda: 1');
  ok(re.reply_markup.inline_keyboard[1][0].text === '✅ Taom 02', 'tartib barqaror — taom sakrab ketmadi');
  // qaytarish
  await press(stopStaff[0], `mc:set:${dish1._id}:1:0`, mine.messageId);
  ok((await Dish.findById(dish1._id)).isAvailable === true && /stopdan chiqdi/.test(lastAnswer()), 'qaytarish: isAvailable = true');
  // idempotent
  await press(stopStaff[0], `mc:set:${dish1._id}:1:0`, mine.messageId);
  ok((await Dish.findById(dish1._id)).isAvailable === true, 'takroriy bosish — holat o‘zgarmaydi (ANIQ holat yuboriladi, "teskarisi" emas)');

  // sahifalash
  reset();
  await press(stopStaff[0], `mc:menu:${stopRest._id}:2`, mine.messageId);
  const p3 = edits().at(-1).body;
  ok(/Sahifa 3\/3/.test(p3.text) && p3.reply_markup.inline_keyboard.filter((r) => r[0].callback_data.startsWith('mc:set:')).length === 4 && p3.reply_markup.inline_keyboard.some((r) => r[0].text === '◀️') && !p3.reply_markup.inline_keyboard.some((r) => r.some((b) => b.text === '▶️')), '3-sahifa: 4 ta taom, faqat "◀️" (oxirgi sahifa)');
  await press(stopStaff[0], `mc:menu:${stopRest._id}:99`, mine.messageId);
  ok(/Sahifa 3\/3/.test(edits().at(-1).body.text), 'sahifa chegaradan oshsa — oxirgisiga qisqartiriladi');

  // BEGONA taom (boshqa restoran)
  reset();
  await press(stopStaff[0], `mc:set:${foreignDish._id}:0:0`, mine.messageId);
  ok((await Dish.findById(foreignDish._id)).isAvailable !== false && /Taom topilmadi/.test(lastAnswer()), 'BEGONA restoran taomini stop qilib BO‘LMAYDI (taom o‘zgarmadi)');
  await press(stopStaff[0], 'mc:set:xyz:0:0', mine.messageId);
  ok(/Taom topilmadi/.test(lastAnswer()), 'yaroqsiz taom id — jim xato emas, "Taom topilmadi"');

  // Tayyor
  await press(stopStaff[0], `mc:set:${dish1._id}:0:0`, mine.messageId);
  reset();
  await press(stopStaff[0], `mc:done:${stopRest._id}`, mine.messageId);
  ok(/Stop-list yangilandi/.test(edits().at(-1).body.text) && /stopda: <b>1<\/b> ta/.test(edits().at(-1).body.text) && !edits().at(-1).body.reply_markup, '"✅ Tayyor": ro‘yxat yopildi, "Hozir stopda: 1 ta"');

  // allaqachon tekshirilgan, keyin yana "Stopga quyish" — ro'yxat baribir ochiladi
  reset();
  await press(stopStaff[1], `mc:stop:${stopRest._id}:2026-10-05`, theirs.messageId);
  ok(/Allaqachon tekshirilgan/.test(lastAnswer()) && edits().some((e) => e.body.message_id === theirs.messageId && /Stop-list/.test(e.body.text) && e.body.reply_markup), 'allaqachon tekshirilgan bo‘lsa ham "Stopga quyish" ro‘yxatni ochadi (xodim stop qilmoqchi)');
  ok((await RestaurantDailyCheck.findOne({ restaurantId: stopRest._id, date: '2026-10-05' }).lean()).respondedBy === stopStaff[0].telegramUserId, 'lekin birinchi javobning yozuvi o‘zgarmadi');
}

section('[7] XAVFSIZLIK: begona restoran / begona odam / eskirgan tugma');
{
  const ghost = { telegramUserId: '999999' };
  reset();
  await press(ghost, `mc:all:${A._id}:2026-10-05`);
  ok(/ulanmagan/.test(lastAnswer()) && edits().length === 0, 'ulanmagan odam: "akkauntingiz ulanmagan", hech narsa o‘zgarmadi');
  const inactive = await mkStaff(A, { isActive: false });
  await press(inactive, `mc:all:${A._id}:2026-10-05`);
  ok(/ulanmagan/.test(lastAnswer()), 'nofaol xodim — rad etiladi');

  const kStaff = await mkStaff(K);
  const R = await mkRest('Himoya', { openTime: '12:00' });
  const rs = await mkStaff(R);
  await M.checkMorningChecklists(Date.UTC(2026, 9, 5, 7, 1));     // 12:01
  reset();
  for (const act of ['all', 'stop']) {
    await press(kStaff, `mc:${act}:${R._id}:2026-10-05`);
    ok(/tegishli emas/.test(lastAnswer()), `begona restoran xodimi mc:${act} bossa — rad etildi`);
  }
  await press(kStaff, `mc:menu:${R._id}:0`);
  ok(/tegishli emas/.test(lastAnswer()) && edits().length === 0, 'begona restoran menyusiga kirib BO‘LMAYDI (menyu ochilmadi)');
  const stillPending = await RestaurantDailyCheck.findOne({ restaurantId: R._id, date: '2026-10-05' }).lean();
  ok(stillPending.status === 'pending', 'hujjat pending qoldi (begona xodim o‘zgartira olmadi)');

  reset();
  await press(rs, `mc:all:${R._id}:kecha`);
  ok(/Eskirgan/.test(lastAnswer()), 'sana formati noto‘g‘ri — "Eskirgan eslatma"');
  await press(rs, `mc:all:${R._id}:2026-09-01`);
  ok(/Eskirgan/.test(lastAnswer()) && !(await RestaurantDailyCheck.findOne({ restaurantId: R._id, date: '2026-09-01' })), 'yozuvi yo‘q eski sana — "Eskirgan eslatma", YANGI yozuv yaratilmaydi');
  await press(rs, 'mc:noma:lum');
  ok(answers().length === 3, 'noma’lum amal — callback javobsiz qolmaydi (soat belgisi qotmaydi)');
}

section('[8] BOT YO‘NALISHI: mc: yangi prefiks, mavjud prefikslar buzilmagan');
{
  reset();
  const R = await mkRest('Yo‘nalish', { openTime: '13:00' });
  const s = await mkStaff(R);
  await M.checkMorningChecklists(Date.UTC(2026, 9, 5, 8, 1));
  await handleRestaurantBotUpdate({ callback_query: cq(s, `mc:all:${R._id}:2026-10-05`) });
  ok((await RestaurantDailyCheck.findOne({ restaurantId: R._id, date: '2026-10-05' }).lean()).status === 'checked_all_ok', 'handleRestaurantBotUpdate → mc: tugmasi ishladi');
  reset();
  await handleRestaurantBotUpdate({ callback_query: cq(s, 'zz:nomalum') });
  ok(answers().length === 1, 'noma’lum prefiks avvalgidek: javob beriladi');
  await handleRestaurantBotUpdate({ callback_query: cq(s, 'm:resv') });
  ok(answers().length === 2, 'mavjud "m:" (bron ro‘yxati) hamon ishlaydi');
  await handleRestaurantBotUpdate({ callback_query: cq(s, 'o:accept:6abc00000000000000000000') });
  ok(answers().length >= 3, 'mavjud "o:" (buyurtma) hamon ishlaydi (javob beradi, yiqilmaydi)');
}

section('[9] XATO IZOLYATSIYASI va ATOMIK EGALLASH');
{
  reset(); logs.length = 0;
  const X = await mkRest('Xato X', { openTime: '14:00' });
  const Y = await mkRest('Xato Y', { openTime: '14:00' });
  const Z = await mkRest('Noto‘g‘ri zona', { openTime: '14:00', timezone: 'Foo/Bar' });
  const xs = [await mkStaff(X), await mkStaff(X)];
  const ys = [await mkStaff(Y)];
  await mkStaff(Z);
  failChats.add(xs[0].telegramUserId);                 // X ning bitta xodimi botni bloklagan
  const t = Date.UTC(2026, 9, 5, 9, 1);                // 14:01 Toshkent
  let threw = null; let res;
  try { res = await M.checkMorningChecklists(t); } catch (e) { threw = e; }
  failChats.clear();
  ok(!threw, 'checkMorningChecklists hech qachon tashlamaydi');
  const sx = sent().filter((c) => xs.some((x) => String(c.body.chat_id) === x.telegramUserId));
  const sy = sent().filter((c) => ys.some((x) => String(c.body.chat_id) === x.telegramUserId));
  ok(sx.length === 2 && sy.length === 1, 'X ning bitta xodimi bloklagan — X ning ikkinchisiga va Y ga baribir yuborildi');
  const cx = await RestaurantDailyCheck.findOne({ restaurantId: X._id, date: '2026-10-05' }).lean();
  ok(cx.messages.length === 1 && cx.messages[0].chatId === xs[1].telegramUserId, 'yetkazilgan xabargina saqlandi (bloklaganniki — yo‘q)');
  ok(res.errors === 0, `noto‘g‘ri vaqt zonasi ("Foo/Bar") xato bermadi: ${JSON.stringify(res)}`);

  // egallash: bir vaqtda ikki jarayon
  const W = await mkRest('Egallash', { openTime: '15:00' });
  const wOpen = Date.UTC(2026, 9, 5, 10, 0, 0);                    // 15:00 Toshkent — simulyatsiya vaqti
  const claims = await Promise.all([1, 2, 3, 4, 5].map(() => M.claimFirst(plain(W), '2026-10-05', wOpen)));
  ok(claims.filter(Boolean).length === 1 && await RestaurantDailyCheck.countDocuments({ restaurantId: W._id }) === 1, '5 ta bir vaqtdagi egallash: aynan BITTASI yutdi, yozuv bitta');
  const again = await M.claimFirst(plain(W), '2026-10-05', wOpen);
  ok(again === null, 'allaqachon egallangan — null (ikkinchi jarayon yubormaydi)');
  // boshqa jarayon allaqachon yuborgan (yozuvda firstSentAt bor) — hech narsa yuborilmaydi
  reset();
  await mkStaff(W);
  await M.checkMorningChecklists(Date.UTC(2026, 9, 5, 10, 1));    // 15:01
  const wIds = (await RestaurantTelegramStaff.find({ restaurantId: W._id }).lean()).map((x) => x.telegramUserId);
  ok(sent().filter((c) => wIds.includes(String(c.body.chat_id))).length === 0, 'boshqa jarayon egallagan yozuv bor — bu jarayon QAYTA yubormaydi');

  // bir vaqtda ikkita tick (bir jarayonda)
  const V = await mkRest('Ikki tick', { openTime: '16:00' });
  const vs = await mkStaff(V);
  reset();
  const [r1, r2] = await Promise.all([M.checkMorningChecklists(Date.UTC(2026, 9, 5, 11, 1)), M.checkMorningChecklists(Date.UTC(2026, 9, 5, 11, 1))]);
  ok(sent().filter((c) => String(c.body.chat_id) === vs.telegramUserId).length === 1 && (r1.skipped === 'running' || r2.skipped === 'running'), 'bir vaqtda ikkita tick — bittasi o‘tkazib yuboriladi, xodimga xabar BITTA');

  // bot o'chiq
  const saved = config.restaurantBotToken;
  config.restaurantBotToken = '';
  const off = await M.checkMorningChecklists(OPEN_TASH);
  config.restaurantBotToken = saved;
  ok(off.skipped === 'bot-off', 'bot sozlanmagan — hech narsa qilmaydi (panel banner o‘zi ishlaydi)');
}

section('[10] PANEL API: GET / POST all-ok');
{
  const call = async (fn, req) => {
    let status = 200; let body = null;
    const res = { status(c) { status = c; return this; }, json(b) { body = b; return this; } };
    await fn(req, res, (e) => { body = { next: e?.message }; status = 500; });
    await sleep(60);
    return { status, body };
  };
  const P = await mkRest('Panel', { openTime: '10:00', closeTime: '23:00' });
  const ps = await mkStaff(P);
  const get = (t) => { const real = Date.now; Date.now = () => t; return call(morningCheckController.panelGet, { restaurantId: String(P._id) }).finally(() => { Date.now = real; }); };
  const post = (t) => { const real = Date.now; Date.now = () => t; return call(morningCheckController.panelAllOk, { restaurantId: String(P._id), userId: 'panel-user-1' }).finally(() => { Date.now = real; }); };

  let r = await get(OPEN_TASH - 5 * MIN);
  ok(r.status === 200 && r.body.status === null, 'ochilishdan OLDIN: status null (banner ko‘rinmaydi)');
  r = await get(OPEN_TASH + MIN);
  ok(r.body.status === 'pending' && r.body.firstSentAt === null && r.body.reminderCount === 0 && r.body.date === '2026-10-05', 'ochilgandan keyin, yozuv hali yo‘q: "pending" (bot/xodim bo‘lmasa ham banner ishlaydi)');
  r = await get(Date.UTC(2026, 9, 5, 18, 5));
  ok(r.body.status === null, 'yopilgandan keyin: null');
  await M.checkMorningChecklists(OPEN_TASH);
  r = await get(OPEN_TASH + 3 * MIN);
  ok(r.body.status === 'pending' && r.body.firstSentAt && r.body.reminderCount === 0, 'xabar ketgach: pending + firstSentAt');
  await M.checkMorningChecklists(OPEN_TASH + 60 * MIN);
  r = await get(OPEN_TASH + 61 * MIN);
  ok(r.body.reminderCount === 1, 'reminderCount 1');

  reset();
  r = await post(OPEN_TASH + 62 * MIN);
  ok(r.status === 200 && r.body.ok === true && r.body.already === false, 'POST all-ok: { ok: true }');
  const pd = await RestaurantDailyCheck.findOne({ restaurantId: P._id, date: '2026-10-05' }).lean();
  ok(pd.status === 'checked_all_ok' && pd.respondedVia === 'panel' && pd.respondedBy === 'panel-user-1', 'status checked_all_ok, respondedVia panel');
  ok(edits().filter((e) => /Tekshirildi/.test(e.body.text)).length === 2, 'botdagi xabarlarning tugmalari ham olib tashlandi (panel javob berdi)');
  r = await post(OPEN_TASH + 63 * MIN);
  ok(r.status === 200 && r.body.ok === true && r.body.already === true && (await RestaurantDailyCheck.findOne({ restaurantId: P._id, date: '2026-10-05' }).lean()).respondedAt.getTime() === pd.respondedAt.getTime(), 'qayta bosilsa — xato yo‘q (already: true), yozuv o‘zgarmadi (idempotent)');
  r = await get(OPEN_TASH + 64 * MIN);
  ok(r.body.status === 'checked_all_ok', 'GET: checked_all_ok');
  reset();
  await M.checkMorningChecklists(OPEN_TASH + 180 * MIN);
  ok(sent().filter((c) => String(c.body.chat_id) === ps.telegramUserId).length === 0, 'panel javobidan keyin bot eslatmasi to‘xtadi');

  // yozuv yo'q, ochilishdan oldin panelda "Barchasi bor" → keyin ochilishda xabar KETMAYDI
  const Q = await mkRest('Oldindan', { openTime: '10:00' });
  await mkStaff(Q);
  const realNow = Date.now; Date.now = () => OPEN_TASH - 30 * MIN;
  const pre = await call(morningCheckController.panelAllOk, { restaurantId: String(Q._id), userId: 'u2' });
  Date.now = realNow;
  ok(pre.body.ok && (await RestaurantDailyCheck.findOne({ restaurantId: Q._id, date: '2026-10-05' })).status === 'checked_all_ok', 'yozuv yo‘q holatda ham "Barchasi bor" yozuv yaratadi');
  reset();
  await M.checkMorningChecklists(OPEN_TASH + MIN);
  const qStaff = await RestaurantTelegramStaff.findOne({ restaurantId: Q._id });
  ok(sent().filter((c) => String(c.body.chat_id) === qStaff.telegramUserId).length === 0, 'oldindan "Barchasi bor" bosilgan — ochilishda xabar yuborilmaydi');

  // dam kuni / bloklangan
  const realNow2 = Date.now; Date.now = () => OPEN_TASH + MIN;
  const offDay = (await call(morningCheckController.panelGet, { restaurantId: String(J._id) })).body;
  const blocked = (await call(morningCheckController.panelGet, { restaurantId: String(E._id) })).body;
  const noHours = (await call(morningCheckController.panelGet, { restaurantId: String(H._id) })).body;
  const h24 = (await call(morningCheckController.panelGet, { restaurantId: String(I._id) })).body;
  Date.now = realNow2;
  ok(offDay.status === null && blocked.status === null && noHours.status === null && h24.status === null, 'dam kuni / bloklangan / vaqtsiz / 24 soatli restoranda banner YO‘Q (status null)');
  const missing = await call(morningCheckController.panelGet, { restaurantId: String(new mongoose.Types.ObjectId()) });
  ok(missing.status === 404, 'mavjud bo‘lmagan restoran — 404');
}

section('[11] ADMIN JADVALI');
{
  const call = async (fn, req) => { let body = null; const res = { status() { return this; }, json(b) { body = b; return this; } }; await fn(req, res, () => {}); await sleep(80); return body; };
  const out = await call(morningCheckController.adminList, { query: { date: '2026-10-05' } });
  const names = out.rows.map((r) => r.name);
  ok(out.date === '2026-10-05' && !names.includes('D Nofaol') && !names.includes('E Bloklangan') && !names.includes('F Tasdiqlanmagan'), 'faqat faol, tasdiqlangan, bloklanmagan restoranlar');
  const rowA = out.rows.find((r) => r.name === 'A Toshkent');
  ok(rowA.status === 'checked_all_ok' && rowA.reminderCount === 2 && rowA.respondedVia === 'bot' && /^Xodim/.test(rowA.respondedBy), `A: ${rowA.status}, eslatma ${rowA.reminderCount}, javob bergan: ${rowA.respondedBy}`);
  ok(out.rows.find((r) => r.name === 'G Bo‘sh kunlar').status === 'not_sent', 'xabar ketmagan restoran: "not_sent"');
  ok(out.rows.find((r) => r.name === 'Panel').respondedBy === 'Panel' && out.rows.find((r) => r.name === 'Panel').respondedVia === 'panel', 'panel orqali javob: "Panel"');
  ok(out.counts.checked_all_ok >= 3 && out.counts.checked_with_stop === 1 && out.counts.not_sent >= 1, `hisob: ${JSON.stringify(out.counts)}`);
  const bad = await call(morningCheckController.adminList, { query: { date: 'abc' } });
  ok(/^\d{4}-\d{2}-\d{2}$/.test(bad.date), 'noto‘g‘ri sana — bugunga qaytadi (xato yo‘q)');
  ok((await call(morningCheckController.adminList, { query: { date: '2020-01-01' } })).rows.every((r) => r.status === 'not_sent'), 'boshqa kun — hammasi "not_sent"');
}

section('[12] TEZLIK: 500 restoran < 2 soniya');
{
  const docs = [];
  for (let i = 0; i < 500; i++) {
    const h = String(3 + (i % 18)).padStart(2, '0'); const m = String((i * 7) % 60).padStart(2, '0');
    docs.push({ name: `Ommaviy ${i}`, cuisine: 'x', category: 'restoran', isActive: true, isApproved: true, openTime: `${h}:${m}`, closeTime: '23:59', timezone: 'Asia/Tashkent', workingDays: ALL });
  }
  await Restaurant.insertMany(docs);
  reset();
  const t0 = Date.now();
  const res = await M.checkMorningChecklists(Date.UTC(2026, 9, 5, 4, 3));   // 09:03 Toshkent
  const ms = Date.now() - t0;
  ok(ms < 2000, `500+ restoran tekshirildi: ${ms} ms (< 2000)`);
  ok(res.errors === 0, `xatosiz: ${JSON.stringify(res)}`);
}

console.error = origErr;
origLog(fails ? `\n✗ ${fails} ta xato` : '\n✓ HAMMASI O‘TDI');
await mongoose.disconnect();
process.exit(fails ? 1 : 0);
