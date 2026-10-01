/*
 * ═══════════════════════════════════════════════════════════
 * BAZANING KUNLIK JSON ZAXIRASI → HISOBOT GURUHI
 * ═══════════════════════════════════════════════════════════
 * Vaqt tashqaridan beriladi (soatlab kutilmaydi); Telegram soxta, lekin
 * yuborilgan FAYL HAQIQATAN ochilib tekshiriladi.
 * npm run test:db-backup
 */
process.env.MONGO_URI = 'mongodb://127.0.0.1:27017/lokma_db_backup';
process.env.TELEGRAM_BOT_TOKEN = '1:T';
process.env.BACKUP_GROUP_CHAT_ID = '-100999';
process.env.BACKUP_FILE_LIMIT_BYTES = '30000';
process.env.JWT_SECRET = 'x'.repeat(40);

import fs from 'node:fs';
import os from 'node:os';
import zlib from 'node:zlib';

const calls = [];
const mode = { send: 'ok', failLeft: 0, del: 'ok' };
let nextId = 900;
const resp = (b) => ({ ok: true, status: 200, json: async () => b });
globalThis.fetch = async (url, init) => {
  const method = String(url).split('/').pop();
  if (init?.body instanceof FormData) {
    const f = init.body.get('document');
    const bytes = Buffer.from(await f.arrayBuffer());
    const c = { method, chat_id: init.body.get('chat_id'), caption: init.body.get('caption'), filename: f.name, bytes };
    calls.push(c);
    const fail = mode.send === 'fail' || (mode.failLeft > 0 && mode.failLeft--);
    if (mode.send === 'throw') throw new Error('ECONNRESET');
    if (fail) return resp({ ok: false, error_code: 400, description: 'Bad Request: boom' });
    return resp({ ok: true, result: { message_id: ++nextId } });
  }
  const body = JSON.parse(init.body);
  calls.push({ method, ...body });
  if (method === 'deleteMessage') {
    if (mode.del === 'gone') return resp({ ok: false, error_code: 400, description: 'Bad Request: message to delete not found' });
    if (mode.del === 'err') return resp({ ok: false, error_code: 500, description: 'Internal error' });
  }
  return resp({ ok: true, result: { message_id: ++nextId } });
};

const mongoose = (await import('mongoose')).default;
await mongoose.connect(process.env.MONGO_URI);
await mongoose.connection.db.dropDatabase();
const { EJSON } = mongoose.mongo.BSON;
const { BackupRun } = await import('../src/models/BackupRun.js');
const { config } = await import('../src/config/index.js');
const { zonedToUtc, addDaysYmd } = await import('../src/services/restaurantTime.js');
const B = await import('../src/services/dbBackup.js');

let fails = 0;
const ok = (c, m) => { console.log(c ? '  ✓' : '  ✗ FAIL:', m); if (!c) fails++; };
const db = mongoose.connection.db;
const at = (ymd, hhmm, sec = 0) => new Date(zonedToUtc(ymd, hhmm).getTime() + sec * 1000);
const sends = () => calls.filter((c) => c.method === 'sendDocument');
const dels = () => calls.filter((c) => c.method === 'deleteMessage');
const reset = async () => { calls.length = 0; mode.send = 'ok'; mode.failLeft = 0; mode.del = 'ok'; await BackupRun.deleteMany({}); };
const D1 = '2026-09-29'; const D2 = '2026-09-30'; const D3 = '2026-10-01'; const D4 = '2026-10-02'; const D5 = '2026-10-03';

/* ── ma'lumot: turli BSON turlari, unicode, bo'sh collection ── */
const oid = new mongoose.Types.ObjectId();
await db.collection('users').insertMany([
  { _id: oid, name: 'Aziz "Toshkent"\nikkinchi qator', emoji: '🍽 ўзбек', createdAt: new Date('2026-01-02T03:04:05Z'), nested: { a: [1, 2, { b: null }], n: 12.5 }, big: 9007199254740991 },
  { name: 'Bo‘sh', createdAt: new Date(0), flag: true },
]);
await db.collection('orders').insertMany(Array.from({ length: 30 }, (_, i) => ({ n: i, userId: oid, total: i * 1000 })));
await db.createCollection('emptycol');

console.log('\n[1] Eksport: BUTUN baza, 100% to‘liq, turlar saqlanadi, fayl to‘g‘ri JSON');
{
  const f = `${os.tmpdir()}/t-export-${process.pid}.json`;
  const r = await B.exportDatabaseToFile(f, { ymd: D1, now: at(D1, '23:59') });
  const doc = JSON.parse(fs.readFileSync(f, 'utf8'));
  const names = (await db.listCollections().toArray()).map((c) => c.name).filter((n) => !n.startsWith('system.')).sort();
  ok(JSON.stringify(Object.keys(doc.collections)) === JSON.stringify(names), `barcha collection’lar bor (${names.length} ta): ${names.join(', ')}`);
  ok(names.every((n) => doc.summary.collections[n] === doc.collections[n].length), 'summary sonlari = haqiqiy hujjatlar');
  let allEq = true;
  for (const n of names) if (doc.collections[n].length !== await db.collection(n).countDocuments()) allEq = false;
  ok(allEq, 'har collection’da bazadagi hujjat soniga AYNAN teng');
  ok(doc.summary.totalDocuments === r.documents && r.bytes === fs.statSync(f).size, 'jami hujjatlar va hajm hisoboti to‘g‘ri');
  ok(doc.collections.emptycol.length === 0, 'bo‘sh collection — bo‘sh massiv (tushib qolmadi)');
  ok(doc.meta.app === 'lokmago' && doc.meta.ymd === D1 && doc.meta.timezone === 'Asia/Tashkent' && doc.meta.database === 'lokma_db_backup', 'meta: ilova, sana, vaqt zonasi, baza nomi');
  const users = EJSON.parse(JSON.stringify(doc.collections.users));
  const u = users.find((x) => x.name.startsWith('Aziz'));
  ok(u._id instanceof mongoose.Types.ObjectId && String(u._id) === String(oid), 'ObjectId turi tiklanadi');
  ok(u.createdAt instanceof Date && u.createdAt.toISOString() === '2026-01-02T03:04:05.000Z', 'Date turi tiklanadi');
  ok(u.name === 'Aziz "Toshkent"\nikkinchi qator' && u.emoji === '🍽 ўзбек', 'qo‘shtirnoq, yangi qator, emoji, kirill buzilmagan');
  ok(u.nested.a[2].b === null && u.nested.n === 12.5 && u.big === 9007199254740991, 'ichma-ich obyekt, null, kasr, katta son');
  ok(!('backupruns' in doc.collections) || Array.isArray(doc.collections.backupruns), 'zaxira yozuvlari collection’i ham massiv');
  fs.rmSync(f);
  ok(r.bytes < 30000, `test ma’lumoti chegaradan kichik (${r.bytes} bayt) — gzip talab qilinmaydi`);
}

console.log('\n[2] Jadval: 23:59 (Toshkent) da BIR MARTA; boshqa daqiqalarda hech narsa');
{
  await reset();
  ok((await B.backupTick(at(D1, '23:58', 30))).started.length === 0 && calls.length === 0, '23:58 — ishga tushmadi');
  ok((await B.backupTick(at(D1, '12:00'))).started.length === 0 && calls.length === 0, '12:00 — ishga tushmadi');
  const r = await B.backupTick(at(D1, '23:59', 10));
  ok(r.started[0] === D1 && sends().length === 1, '23:59:10 — zaxira boshlandi va yuborildi');
  const c = sends()[0];
  ok(c.chat_id === '-100999', 'hisobot guruhiga (BACKUP_GROUP_CHAT_ID)');
  ok(c.filename === 'lokmago-backup-2026-09-29.json', `fayl nomi: ${c.filename}`);
  ok(/Baza zaxirasi/.test(c.caption) && c.caption.includes('29.09.2026') && /\d+ collection · \d+ hujjat/.test(c.caption), `izoh: ${c.caption.replace(/\n/g, ' | ')}`);
  const doc = JSON.parse(c.bytes.toString('utf8'));
  ok(doc.summary.totalDocuments > 30 && doc.collections.users.length === 2, 'yuborilgan fayl haqiqiy JSON va to‘liq (users 2, orders 30)');
  const run = await BackupRun.findOne({ ymd: D1 }).lean();
  ok(run.status === 'sent' && run.messageId === 901 && run.chatId === '-100999' && run.trigger === 'schedule', 'BackupRun: sent, xabar id, guruh');
  await B.backupTick(at(D1, '23:59', 25)); await B.backupTick(at(D1, '23:59', 50));
  ok(sends().length === 1 && await BackupRun.countDocuments({ ymd: D1 }) === 1, 'shu daqiqada yana 2 tick — ikkinchi zaxira YO‘Q (kun bir marta)');
  ok(!fs.readdirSync(os.tmpdir()).some((f) => f.startsWith('lokmago-backup-')), 'vaqtinchalik fayl diskdan o‘chirildi');
}

console.log('\n[3] Eski fayl: yangisi kelgach 1 daqiqadan KEYIN o‘chiriladi (ertaroq emas, yangisi hech qachon)');
{
  calls.length = 0;
  const t0 = at(D2, '23:59', 10);
  await B.backupTick(t0);
  ok(sends().length === 1 && dels().length === 0, '2-kun zaxirasi yuborildi; eski fayl HALI o‘chirilmadi');
  const old = await BackupRun.findOne({ ymd: D1 }).lean();
  ok(old.deleteAt && Math.abs(new Date(old.deleteAt).getTime() - (t0.getTime() + 60_000)) < 2000, 'eski faylga o‘chirish vaqti = yangi kelgandan +1 daqiqa');
  await B.backupTick(new Date(t0.getTime() + 30_000));
  ok(dels().length === 0, '+30 soniya — hali o‘chirilmadi');
  const r = await B.backupTick(new Date(t0.getTime() + 61_000));
  ok(r.deleted === 1 && dels().length === 1, '+61 soniya — o‘chirildi');
  ok(dels()[0].chat_id === '-100999' && dels()[0].message_id === 901, 'aynan ESKI xabar (901), to‘g‘ri guruh');
  ok((await BackupRun.findOne({ ymd: D1 }).lean()).deletedAt, 'eski yozuvda deletedAt');
  await B.backupTick(new Date(t0.getTime() + 300_000)); await B.backupTick(new Date(t0.getTime() + 3_600_000));
  ok(dels().length === 1 && !(await BackupRun.findOne({ ymd: D2 }).lean()).deleteAt, 'YANGI fayl hech qachon o‘chirilmaydi (keyingi tick’larda ham)');
}

console.log('\n[4] MUHIM SHART: yangi fayl kelmasa/xato bo‘lsa — eski fayl O‘CHIRILMAYDI');
{
  calls.length = 0; mode.send = 'fail';
  const t = at(D3, '23:59', 10);
  await B.backupTick(t);
  let run = await BackupRun.findOne({ ymd: D3 }).lean();
  ok(run.status === 'failed' && run.attempts === 1 && /boom/.test(run.error), `1-urinish xato: "${run.error}"`);
  ok(Math.abs(new Date(run.nextAttemptAt).getTime() - (t.getTime() + 120_000)) < 2000, 'qayta urinish +2 daqiqadan keyin');
  // 1-QATLAM: jadval xato urinishdan ZAHOTI hali qo'yilmagan (2-qatlam — o'chirish paytidagi tekshiruv — buni yashirmasin)
  ok((await BackupRun.findOne({ ymd: D2 }).lean()).deleteAt === null, '1-qatlam: xato urinishdan zahoti eski faylga o‘chirish jadvali QO‘YILMAGAN');
  await B.backupTick(new Date(t.getTime() + 61_000)); await B.backupTick(new Date(t.getTime() + 100_000));
  ok(dels().length === 0 && !(await BackupRun.findOne({ ymd: D2 }).lean()).deleteAt, '1 daqiqadan keyin ham eski (2-kun) fayl O‘CHIRILMADI, jadval ham qo‘yilmadi');
  await B.backupTick(new Date(t.getTime() + 125_000));
  run = await BackupRun.findOne({ ymd: D3 }).lean();
  ok(run.attempts === 2 && run.status === 'failed', '2-urinish (yana xato)');
  await B.backupTick(new Date(t.getTime() + 125_000 + 601_000));
  run = await BackupRun.findOne({ ymd: D3 }).lean();
  ok(run.attempts === 3, '3-urinish (+10 daqiqa)');
  ok(calls.filter((c) => c.method === 'sendMessage').length === 0, 'oxirgi urinishgacha ogohlantirish yo‘q');
  await B.backupTick(new Date(t.getTime() + 125_000 + 601_000 + 1_801_000));
  run = await BackupRun.findOne({ ymd: D3 }).lean();
  ok(run.attempts === 4 && run.nextAttemptAt === null, '4-urinish (+30 daqiqa) — oxirgisi, boshqa urinish yo‘q');
  const alert = calls.find((c) => c.method === 'sendMessage');
  ok(alert && alert.chat_id === '-100999' && /Baza zaxirasi olinmadi/.test(alert.text) && /O‘CHIRILMADI/.test(alert.text), 'guruhga ogohlantirish: zaxira olinmadi, eski fayl saqlandi');
  const before = calls.length;
  await B.backupTick(new Date(t.getTime() + 10 * 3_600_000));
  ok(calls.length === before && dels().length === 0, 'shundan keyin qayta urinish ham, o‘chirish ham YO‘Q');
  ok(!(await BackupRun.findOne({ ymd: D2 }).lean()).deletedAt, '2-kun fayli hamon guruhda');
}

console.log('\n[5] Keyingi kun muvaffaqiyatli → faqat YUBORILGAN eski fayl o‘chiriladi (xato bo‘lgan kun emas)');
{
  calls.length = 0; mode.send = 'ok';
  const t = at(D4, '23:59', 10);
  await B.backupTick(t);
  await B.backupTick(new Date(t.getTime() + 61_000));
  ok(dels().length === 1 && dels()[0].message_id === 902, `2-kun fayli (902) o‘chirildi; xato bo‘lgan 3-kun uchun o‘chirish yo‘q (${dels().length} ta)`);
}

console.log('\n[6] Xato → qayta urinish MUVAFFAQIYATLI: eski fayl faqat SHUNDAN keyin 1 daqiqada o‘chiriladi');
{
  calls.length = 0; mode.failLeft = 1;
  const t = at(D5, '23:59', 10);
  await B.backupTick(t);
  ok((await BackupRun.findOne({ ymd: D5 }).lean()).status === 'failed', '1-urinish xato');
  await B.backupTick(new Date(t.getTime() + 90_000));
  ok(dels().length === 0, '90 soniya: eski fayl hali o‘chirilmagan');
  const t2 = new Date(t.getTime() + 125_000);
  await B.backupTick(t2);
  const run = await BackupRun.findOne({ ymd: D5 }).lean();
  ok(run.status === 'sent' && run.attempts === 2, '2-urinishda yuborildi');
  ok(dels().length === 0, 'yuborilgan zahoti o‘chirilmaydi');
  await B.backupTick(new Date(t2.getTime() + 61_000));
  ok(dels().length === 1, 'yangi kelgandan 1 daqiqa keyin eski o‘chirildi');
}

console.log('\n[7] Tarmoq xatosi (fetch tashlaydi) ham xato hisoblanadi; eski fayl saqlanadi');
{
  await reset();
  await B.backupTick(at(D1, '23:59', 5));           // sent
  calls.length = 0; mode.send = 'throw';
  const t = at(D2, '23:59', 5);
  await B.backupTick(t);
  const run = await BackupRun.findOne({ ymd: D2 }).lean();
  ok(run.status === 'failed' && /ECONNRESET/.test(run.error), `xato: ${run.error}`);
  await B.backupTick(new Date(t.getTime() + 70_000));
  ok(dels().length === 0, 'eski fayl o‘chirilmadi');
  mode.send = 'ok';
}

console.log('\n[8] Catch-up: server 23:59 da o‘chiq edi — ertasi kuni 00:00–01:00 orasida olinadi');
{
  await reset();
  const day = '2026-11-01';
  const r = await B.backupTick(at(addDaysYmd(day, 1), '00:20'));
  ok(r.started[0] === day && sends().length === 1, 'kecha zaxirasi 00:20 da olindi');
  const run = await BackupRun.findOne({ ymd: day }).lean();
  ok(run.trigger === 'catchup' && run.status === 'sent', 'trigger: catchup');
  await B.backupTick(at(addDaysYmd(day, 1), '00:40'));
  ok(sends().length === 1, 'shu kun uchun qayta olinmadi');
  calls.length = 0; await BackupRun.deleteMany({});
  await B.backupTick(at(addDaysYmd(day, 1), '01:10'));
  ok(sends().length === 0, '01:00 dan keyin catch-up YO‘Q');
  await B.backupTick(at(addDaysYmd(day, 1), '00:59'));
  ok(sends().length === 1, '00:59 — hali oyna ichida');
}

console.log('\n[9] Qotib qolgan ("running", lease tugagan) yozuv qayta band qilinadi');
{
  await reset();
  await BackupRun.create({ ymd: '2026-12-01', status: 'running', attempts: 1, lockedUntil: new Date(Date.now() - 60_000) });
  const r = await B.backupTick(new Date());
  const run = await BackupRun.findOne({ ymd: '2026-12-01' }).lean();
  ok(r.retried.includes('2026-12-01') && run.status === 'sent' && run.attempts === 2, 'server yiqilgan urinish qayta bajarildi');
}

console.log('\n[10] O‘chirish xatolari: xabar yo‘q / vaqtinchalik xato / himoya');
{
  await reset();
  const mk = (ymd, extra) => BackupRun.create({ ymd, status: 'sent', chatId: '-100999', messageId: 1, ...extra });
  const past = new Date(Date.now() - 5000);
  await mk('2027-01-01', { messageId: 11, deleteAt: past });
  await mk('2027-01-02', { messageId: 12 });
  mode.del = 'gone';
  const r = await B.backupTick(new Date());
  const a = await BackupRun.findOne({ ymd: '2027-01-01' }).lean();
  ok(r.deleted === 0 && a.deletedAt && /not found/.test(a.deleteError), '"xabar topilmadi" — qayta urinilmaydi, deletedAt qo‘yildi');
  mode.del = 'err';
  await BackupRun.updateOne({ ymd: '2027-01-01' }, { deletedAt: null, deleteAt: past, deleteAttempts: 0 });
  await B.backupTick(new Date());
  let b = await BackupRun.findOne({ ymd: '2027-01-01' }).lean();
  ok(!b.deletedAt && b.deleteAttempts === 1 && new Date(b.deleteAt).getTime() > Date.now() + 240_000, 'vaqtinchalik xato — 5 daqiqadan keyin qayta uriniladi');
  await BackupRun.updateOne({ ymd: '2027-01-01' }, { deleteAttempts: 4, deleteAt: past });
  await B.backupTick(new Date());
  b = await BackupRun.findOne({ ymd: '2027-01-01' }).lean();
  ok(b.deletedAt && b.deleteAttempts === 5, '5 urinishdan keyin taslim (abadiy takrorlanmaydi)');
  mode.del = 'ok'; calls.length = 0;
  await BackupRun.deleteMany({});
  await mk('2027-02-01', { messageId: 21, deleteAt: past }); // YAGONA yuborilgan — yangiroq yo'q
  await B.backupTick(new Date());
  const only = await BackupRun.findOne({ ymd: '2027-02-01' }).lean();
  ok(dels().length === 0 && !only.deletedAt && only.deleteAt === null, 'HIMOYA: yangiroq zaxira bo‘lmasa, jadval noto‘g‘ri qo‘yilgan bo‘lsa ham fayl o‘chirilmaydi');
}

console.log('\n[11] Qo‘lda zaxira: alohida kalit, oldingilarni almashtiradi; bir soniyada ikkinchisi rad');
{
  await reset();
  await B.backupTick(at(D1, '23:59', 5));
  const now = at(D2, '10:15', 30);
  const r = await B.runBackupNow(now);
  ok(r.ok && /^2026-09-30\+manual-\d{6}$/.test(r.ymd), `kalit: ${r.ymd}`);
  const first = await BackupRun.findOne({ ymd: D1 }).lean();
  ok(first.deleteAt && Math.abs(new Date(first.deleteAt).getTime() - (now.getTime() + 60_000)) < 2000, 'oldingi zaxira 1 daqiqadan keyin o‘chirishga qo‘yildi');
  let err = null; try { await B.runBackupNow(now); } catch (e) { err = e; }
  ok(err && /allaqachon/.test(err.message), 'bir soniyada ikkinchi qo‘lda zaxira — rad');
  await B.backupTick(at(D2, '23:59', 5));
  ok((await BackupRun.findOne({ ymd: D2 }).lean()).status === 'sent', 'kunlik zaxira qo‘lda zaxiradan mustaqil ishladi');
}

console.log('\n[12] Sozlanmagan: hech narsa qilmaydi');
{
  await reset();
  const saved = config.backupGroupChatId;
  config.backupGroupChatId = '';
  const r = await B.backupTick(at(D1, '23:59', 10));
  ok(r.started.length === 0 && calls.length === 0 && await BackupRun.countDocuments() === 0, 'BACKUP_GROUP_CHAT_ID bo‘sh — na yuborish, na yozuv');
  ok(!B.isBackupEnabled() && B.startBackupScheduler() === null, 'rejalashtiruvchi ishga tushmaydi');
  let e2 = null; try { await B.runBackupNow(); } catch (e) { e2 = e; }
  ok(Boolean(e2), 'qo‘lda zaxira ham aniq xato bilan');
  config.backupGroupChatId = saved;
}

console.log('\n[13] HAJM: 30 000 bayt (test chegarasi) dan katta JSON → gzip; siqilgach ham sig‘masa → xato + ogohlantirish');
{
  await reset();
  await db.collection('bulk').insertMany(Array.from({ length: 400 }, (_, i) => ({ i, text: 'abc'.repeat(60) })));
  await B.backupTick(at(D1, '23:59', 5));
  const c = sends()[0];
  ok(c && c.filename === 'lokmago-backup-2026-09-29.json.gz' && /\(gzip\)/.test(c.caption), `gzip yuborildi: ${c?.filename}`);
  const doc = JSON.parse(zlib.gunzipSync(c.bytes).toString('utf8'));
  ok(doc.collections.bulk.length === 400 && doc.summary.totalDocuments === (await BackupRun.findOne({ ymd: D1 }).lean()).documents, 'siqilgan fayl ochiladi va TO‘LIQ (400 hujjat)');
  const run = await BackupRun.findOne({ ymd: D1 }).lean();
  ok(run.gzip === true && run.sentBytes < 30000 && run.bytes > 30000, `gzip belgisi; ${run.bytes} → ${run.sentBytes} bayt`);

  calls.length = 0;
  const rnd = () => Array.from({ length: 1500 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  await db.collection('random').insertMany(Array.from({ length: 80 }, (_, i) => ({ i, blob: rnd() })));
  await B.backupTick(at(D2, '23:59', 5));
  const bad = await BackupRun.findOne({ ymd: D2 }).lean();
  ok(bad.status === 'failed' && /50 MB/.test(bad.error) && bad.nextAttemptAt === null, 'siqilgach ham sig‘madi → failed, qayta urinish YO‘Q (foydasiz)');
  ok(calls.some((x) => x.method === 'sendMessage' && /olinmadi/.test(x.text)), 'darhol ogohlantirish');
  await B.backupTick(at(D2, '23:59', 5 + 3700));
  ok(dels().length === 0, 'eski (gzip) fayl O‘CHIRILMADI');
}

ok(!fs.readdirSync(os.tmpdir()).some((f) => f.startsWith('lokmago-backup-')), '\nvaqtinchalik fayllar qolmadi (tmp toza)');
console.log(fails ? `\n✗ ${fails} ta xato` : '\n✓ HAMMASI O‘TDI');
await mongoose.disconnect();
process.exit(fails ? 1 : 0);
