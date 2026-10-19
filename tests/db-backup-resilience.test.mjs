/*
 * BAZA ZAXIRASI ISHONCHLILIGI: kunlik jadval, guruh supergruppaga ko'chishi, xatolar va ogohlantirish, KECHIKKAN yetib olish,
 * holat (admin panel). Soxta Telegram + xotiradagi BackupRun + soxta baza. Baza KERAK EMAS.
 * npm run test:backup-resilience
 */
import http from 'node:http';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(40);

// ── soxta Telegram ──
const calls = []; let mode = 'ok'; let msgId = 900;
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    const method = req.url.split('/').pop();
    let data = {};
    if ((req.headers['content-type'] || '').includes('json')) { try { data = JSON.parse(raw); } catch { /* */ } }
    else { const m = raw.match(/name="chat_id"\r\n\r\n(-?\d+)/); data = { chat_id: m?.[1], _raw: raw }; }
    calls.push({ method, data });
    const reply = (o, st = 200) => { res.statusCode = st; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
    const chat = String(data.chat_id);
    if (mode === 'notfound') return reply({ ok: false, error_code: 400, description: 'Bad Request: chat not found' }, 400);
    if (mode === 'migrate' && chat === '-100111') return reply({ ok: false, error_code: 400, description: 'Bad Request: group chat was upgraded to a supergroup chat', parameters: { migrate_to_chat_id: -100777 } }, 400);
    if (mode === 'adminonly' && chat !== '-100222') return reply({ ok: false, error_code: 403, description: 'Forbidden: bot was kicked from the group chat' }, 403);
    reply({ ok: true, result: { message_id: ++msgId, true: true } });
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
process.env.TELEGRAM_API_BASE = `http://127.0.0.1:${server.address().port}`;
process.env.TELEGRAM_BOT_TOKEN = '1:TEST';
process.env.BACKUP_GROUP_CHAT_ID = '-100111';
process.env.ADMIN_ALERTS_CHAT_ID = '-100222';

const mongoose = (await import('mongoose')).default;
const { BackupRun } = await import('../src/models/BackupRun.js');
const B = await import('../src/services/dbBackup.js');
const { config } = await import('../src/config/index.js');

// ── soxta baza (collection'lar: users, orders + view) ──
const docs = { users: [{ _id: new mongoose.Types.ObjectId(), name: 'Ali', createdAt: new Date('2026-10-01') }], orders: [{ _id: new mongoose.Types.ObjectId(), total: 150000 }, { _id: new mongoose.Types.ObjectId(), total: 99000 }] };
const fakeDb = {
  databaseName: 'testdb',
  listCollections: () => ({ toArray: async () => [{ name: 'users', type: 'collection' }, { name: 'orders', type: 'collection' }, { name: 'v_summary', type: 'view' }, { name: 'system.profile', type: 'collection' }] }),
  collection: (n) => ({ find: () => ({ async *[Symbol.asyncIterator]() { for (const d of docs[n] || []) yield d; } }) }),
};
Object.defineProperty(mongoose.connection, 'db', { get: () => fakeDb, configurable: true });

// ── xotiradagi BackupRun ──
let runs = []; let seq = 1;
const val = (r, k) => r[k];
const ts = (x) => (x instanceof Date ? x.getTime() : x);
function match(r, f) {
  return Object.entries(f).every(([k, v]) => {
    if (k === '$or') return v.some((s) => match(r, s));
    const a = ts(val(r, k));
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      return Object.entries(v).every(([op, x]) => {
        const b = ts(x);
        if (op === '$ne') return b === null ? a != null : a !== b;
        if (op === '$lt') return a != null && a < b;
        if (op === '$lte') return a != null && a <= b;
        if (op === '$gt') return a != null && a > b;
        if (op === '$gte') return a != null && a >= b;
        return false;
      });
    }
    if (v === null) return a == null;
    return a === ts(v);
  });
}
function apply(r, u) {
  const set = u.$set || Object.fromEntries(Object.entries(u).filter(([k]) => !k.startsWith('$')));
  Object.assign(r, set);
  for (const [k, n] of Object.entries(u.$inc || {})) r[k] = (r[k] || 0) + n;
}
const chain = (arr) => { let a = arr; const c = { sort(s) { const [k, d] = Object.entries(s)[0]; a = [...a].sort((x, y) => (ts(x[k]) > ts(y[k]) ? 1 : -1) * d); return c; }, limit(n) { a = a.slice(0, n); return c; }, select() { return c; }, lean: async () => structuredClone(a), then: (res, rej) => Promise.resolve(a).then(res, rej) }; return c; };
BackupRun.create = async (d) => {
  if (runs.some((r) => r.ymd === d.ymd)) throw Object.assign(new Error('dup'), { code: 11000 });
  const r = { _id: `r${seq++}`, status: 'running', attempts: 0, nextAttemptAt: null, lockedUntil: null, error: '', deletedAt: null, deleteAt: null, deleteAttempts: 0, createdAt: new Date(), ...d };
  runs.push(r); return r;
};
BackupRun.updateOne = async (f, u) => { const r = runs.find((x) => match(x, f)); if (r) apply(r, u); return {}; };
BackupRun.updateMany = async (f, u) => { runs.filter((x) => match(x, f)).forEach((r) => apply(r, u)); return {}; };
BackupRun.find = (f = {}) => chain(runs.filter((r) => match(r, f)));
BackupRun.findOne = (f = {}) => { const c = chain(runs.filter((r) => match(r, f))); const lean = c.lean; c.lean = async () => (await lean())[0] || null; return c; };
BackupRun.findOneAndUpdate = async (f, u) => { const r = runs.find((x) => match(x, f)); if (!r) return null; apply(r, u); return r; };
BackupRun.exists = async (f) => (runs.find((r) => match(r, f)) ? { _id: 1 } : null);

let fails = 0;
const ok = (c, m) => { console.log(c ? '  ✓' : '  ✗ FAIL:', m); if (!c) fails++; };
const logs = []; const origErr = console.error; console.error = (...a) => logs.push(a.join(' '));
const docsSent = () => calls.filter((c) => c.method === 'sendDocument');
const msgs = () => calls.filter((c) => c.method === 'sendMessage');
const reset = () => { calls.length = 0; logs.length = 0; runs = []; seq = 1; mode = 'ok'; B._resetBackupChat(); config.backupGroupChatId = '-100111'; };
// Toshkent = UTC+5: 23:59 Toshkent = 18:59 UTC
const Z = (iso) => new Date(iso);
const sentRun = (ymd, sentAt) => runs.push({ _id: `r${seq++}`, ymd, status: 'sent', trigger: 'schedule', attempts: 1, sentAt: Z(sentAt), startedAt: Z(sentAt), createdAt: Z(sentAt), messageId: 500 + seq, chatId: '-100111', deletedAt: null, deleteAt: null, deleteAttempts: 0, error: '', documents: 3, bytes: 1000, sentBytes: 1000 });

console.log('\n[1] Kunlik zaxira 23:59 (Toshkent) — guruhga keladi');
reset();
let r = await B.backupTick(Z('2026-10-19T18:59:10Z'));
ok(r.started.join() === '2026-10-19' && docsSent().length === 1 && docsSent()[0].data.chat_id === '-100111', '23:59 da zaxira guruhga yuborildi');
const raw = docsSent()[0]?.data._raw || '';
ok(/"users":\[/.test(raw) && /"orders":\[/.test(raw) && !/v_summary|system\.profile/.test(raw) && /\$oid/.test(raw), 'faylda barcha collection (view va system.* siz), ObjectId turi saqlangan');
ok(/Baza zaxirasi/.test(raw) && /19\.10\.2026/.test(raw) && /3 hujjat|3 hujjat/.test(raw), 'izohda sana va hujjatlar soni');
ok(runs[0].status === 'sent' && runs[0].trigger === 'schedule' && runs[0].messageId > 0, 'BackupRun: sent, schedule, xabar ID saqlandi');
calls.length = 0; r = await B.backupTick(Z('2026-10-19T18:59:40Z'));
ok(docsSent().length === 0, 'shu daqiqada ikkinchi marta YUBORILMAYDI (bir kun — bir zaxira)');

console.log('\n[2] Yangisi kelgach eskisi guruhdan o‘chiriladi');
r = await B.backupTick(Z('2026-10-20T18:59:10Z'));
ok(r.started.join() === '2026-10-20' && runs.length === 2, 'ertasi kuni yangi zaxira yuborildi');
calls.length = 0; await B.backupTick(Z('2026-10-20T19:00:20Z'));
ok(calls.some((c) => c.method === 'deleteMessage') && runs[0].deletedAt, '1 daqiqadan keyin eski zaxira o‘chirildi');

console.log('\n[3] Guruh SUPERGRUPPAGA aylangan — zaxira jimgina to‘xtab qolmaydi');
reset(); mode = 'migrate';
r = await B.backupTick(Z('2026-10-19T18:59:10Z'));
ok(docsSent().length === 2 && docsSent()[1].data.chat_id === '-100777', 'avval eski ID (-100111) ga urildi, keyin YANGI ID (-100777) ga yuborildi');
ok(runs[0].status === 'sent' && runs[0].chatId === '-100777' && B.backupChatId() === '-100777', 'zaxira yuborildi, yangi ID saqlandi');
ok(logs.some((l) => /supergruppaga aylangan/.test(l) && /-100777/.test(l)), 'logda: yangi ID va .env ni yangilash buyrug‘i');
calls.length = 0; await B.backupTick(Z('2026-10-20T18:59:10Z'));
ok(docsSent().length === 1 && docsSent()[0].data.chat_id === '-100777', 'ertasi kuni to‘g‘ridan-to‘g‘ri yangi ID ga');

console.log('\n[4] Guruhga yetib bormasa: qayta urinishlar va ADMIN guruhiga ogohlantirish');
reset(); mode = 'adminonly';
const t0 = Z('2026-10-19T18:59:10Z');
await B.backupTick(t0);
ok(runs[0].status === 'failed' && /kicked/.test(runs[0].error) && runs[0].nextAttemptAt, '1-urinish yiqildi: sababi yozildi, qayta urinish rejalashtirildi');
ok(msgs().length === 0, 'oraliq urinishlarda hali ogohlantirish yo‘q');
await B.backupTick(new Date(t0.getTime() + 2.1 * 60_000));
await B.backupTick(new Date(t0.getTime() + 13 * 60_000));
await B.backupTick(new Date(t0.getTime() + 44 * 60_000));
ok(runs[0].attempts === 4 && runs[0].nextAttemptAt === null, '4 urinishdan keyin to‘xtadi');
const adminMsg = msgs().filter((m) => m.data.chat_id === '-100222' || String(m.data.chat_id) === '-100222');
ok(adminMsg.length === 1 && /Baza zaxirasi olinmadi/.test(adminMsg[0].data.text) && /kicked/.test(adminMsg[0].data.text), 'ADMIN guruhiga ogohlantirish yetdi (zaxira guruhi ishlamasa ham) — sababi bilan');
ok(logs.some((l) => /ogohlantirish zaxira guruhiga yuborilmadi/.test(l)), 'zaxira guruhiga yuborilmagani logda');

console.log('\n[5] KECHIKKAN yetib olish (server kunlab o‘chiq bo‘lgan)');
reset(); sentRun('2026-10-15', '2026-10-15T18:59:30Z');
r = await B.backupTick(Z('2026-10-19T09:00:00Z')); // 14:00 Toshkent — 23:59 ham, 00:00–01:00 oynasi ham emas
ok(r.started.join() === '2026-10-19' && runs.find((x) => x.ymd === '2026-10-19')?.trigger === 'late' && docsSent().length === 1, 'so‘nggi zaxira 4 kun oldin → server tushgan zahoti (14:00 da) zaxira olindi');
calls.length = 0; r = await B.backupTick(Z('2026-10-19T09:05:00Z'));
ok(r.started.length === 0 && docsSent().length === 0, 'qayta-qayta urinmaydi (bugungi zaxira bor)');
reset(); sentRun('2026-10-18', '2026-10-18T18:59:30Z');
r = await B.backupTick(Z('2026-10-19T09:00:00Z'));
ok(r.started.length === 0 && docsSent().length === 0, 'kecha zaxira bor → ortiqcha zaxira olinmaydi');
reset(); sentRun('2026-10-15', '2026-10-15T18:59:30Z');
r = await B.backupTick(Z('2026-10-19T18:55:00Z')); // 23:55 Toshkent
ok(r.started.length === 0, '23:54 dan keyin kunlik 23:59 ga yo‘l beriladi (kechikkan zaxira olinmaydi)');
r = await B.backupTick(Z('2026-10-19T18:59:10Z'));
ok(r.started.join() === '2026-10-19' && runs.find((x) => x.ymd === '2026-10-19').trigger === 'schedule', '23:59 da odatdagi zaxira');
reset(); sentRun('2026-10-17', '2026-10-17T18:59:30Z');
r = await B.backupTick(Z('2026-10-19T19:30:00Z')); // 00:30 Toshkent, 20-oktabr
ok(r.started.join() === '2026-10-19' && runs[runs.length - 1].trigger === 'catchup' && docsSent().length === 1, '00:30 da kechagi zaxira (catch-up) olindi va ortiqcha "late" qo‘shilmadi');

console.log('\n[6] Qo‘lda zaxira ("Hozir zaxira olish")');
reset();
const res1 = await B.runBackupNow(Z('2026-10-19T10:00:00Z'));
ok(res1.ok === true && docsSent().length === 1, 'qo‘lda zaxira olindi va yuborildi');
const [p1, p2] = await Promise.allSettled([B.runBackupNow(Z('2026-10-19T10:00:05Z')), B.runBackupNow(Z('2026-10-19T10:00:06Z'))]);
ok([p1, p2].filter((p) => p.status === 'rejected' && /allaqachon/.test(p.reason.message)).length === 1, 'bir vaqtda ikkinchi bosish rad etiladi (ikki marta yuborilmaydi)');
reset(); mode = 'notfound';
const bad = await B.runBackupNow(Z('2026-10-19T10:00:00Z'));
ok(bad.ok === false && /chat not found/.test(bad.error), 'xatoda sababi qaytariladi: "chat not found"');
config.backupGroupChatId = ''; let thrown = '';
try { await B.runBackupNow(); } catch (e) { thrown = e.message; }
ok(/BACKUP_GROUP_CHAT_ID/.test(thrown), 'guruh ID sozlanmagan — aniq xabar');

console.log('\n[7] Holat (admin panel kartasi)');
reset(); sentRun('2026-10-19', '2026-10-19T18:59:30Z');
let st = await B.getBackupStatus(Z('2026-10-19T20:00:00Z'));
ok(st.enabled && st.chat === '…00111' && st.last?.ymd === '2026-10-19' && st.recent.length === 1 && st.problem === '', 'hammasi joyida: yoqilgan, guruh ID yashirilgan (…00111), muammo yo‘q');
ok(!JSON.stringify(st).includes('1:TEST') && !JSON.stringify(st).includes('-100111'), 'bot tokeni va to‘liq guruh ID javobda YO‘Q');
st = await B.getBackupStatus(Z('2026-10-24T20:00:00Z'));
ok(/5 kun oldin/.test(st.problem), 'zaxira eskirsa: "5 kun oldin" ogohlantirishi');
config.backupGroupChatId = ''; st = await B.getBackupStatus();
ok(st.enabled === false && /BACKUP_GROUP_CHAT_ID/.test(st.problem), 'guruh ID yo‘q: aniq sabab ko‘rsatiladi');
reset(); st = await B.getBackupStatus(); ok(/Hali birorta/.test(st.problem), 'zaxira umuman yo‘q: tushunarli xabar');

console.error = origErr; server.close();
console.log(fails ? `\n✗ ${fails} ta xato` : '\n✓ Hammasi o‘tdi');
process.exit(fails ? 1 : 0);
