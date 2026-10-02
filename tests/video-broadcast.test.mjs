/*
 * ═══════════════════════════════════════════════════════════
 * REKLAMAGA VIDEO — HAQIQIY server + soxta Telegram
 * ═══════════════════════════════════════════════════════════
 * Soxta Telegram multipart'ni HAQIQIY parse qiladi (busboy): yuborilgan
 * fayl baytlari, izoh, tugma, pin tartibi tekshiriladi.
 * npm run test:video-ad
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import crypto from 'node:crypto';
import os from 'node:os';
import fs from 'node:fs';

const PORT = 4197;
const TG_PORT = 4397;
const MONGO_URI = 'mongodb://127.0.0.1:27017/lokma_video_ad';
const JWT_SECRET = 'video-ad-secret-video-ad-secret-video-ad-x';
process.env.MONGO_URI = MONGO_URI;

const mongoose = (await import('mongoose')).default;
const jwt = (await import('jsonwebtoken')).default;
const { default: busboy } = await import('busboy');
await mongoose.connect(MONGO_URI); await mongoose.connection.db.dropDatabase();
const { GroupChat } = await import('../src/models/GroupChat.js');

let fails = 0;
const ok = (c, m) => { console.log(c ? '  ✓' : '  ✗ FAIL:', m); if (!c) fails++; };
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

/* ── soxta Telegram ── */
const calls = [];       // { method, fields, file?: {field, filename, bytes(sha), size, mime} }
let msgId = 100;
let failChat = null;    // shu chat_id ga yuborishda xato qaytaradi
const tg = http.createServer((req, res) => {
  const method = req.url.split('/').pop();
  const done = (fields, file) => {
    calls.push({ method, fields, file });
    if (failChat && String(fields.chat_id) === String(failChat)) {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: chat not found' }));
    }
    const result = { message_id: ++msgId };
    if (method === 'sendVideo') result.video = { file_id: `FID-${msgId}` };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, result }));
  };
  if ((req.headers['content-type'] || '').startsWith('multipart/')) {
    const fields = {}; let file = null;
    const bb = busboy({ headers: req.headers });
    bb.on('field', (k, v) => { fields[k] = v; });
    bb.on('file', (k, stream, info) => {
      const chunks = [];
      stream.on('data', (c) => chunks.push(c));
      stream.on('end', () => { const buf = Buffer.concat(chunks); file = { field: k, filename: info.filename, mime: info.mimeType, size: buf.length, sha: sha(buf) }; });
    });
    bb.on('close', () => done(fields, file));
    req.pipe(bb);
  } else {
    let b = ''; req.on('data', (c) => { b += c; });
    req.on('end', () => done(JSON.parse(b || '{}'), null));
  }
});
await new Promise((r) => tg.listen(TG_PORT, '127.0.0.1', r));

/* ── server ── */
const srv = spawn('node', ['src/index.js'], {
  env: { ...process.env, PORT: '4197', NODE_ENV: 'development', MONGO_URI, JWT_SECRET, TELEGRAM_BOT_TOKEN: '1:T', TELEGRAM_API_BASE: `http://127.0.0.1:${TG_PORT}`, RESTAURANT_BOT_TOKEN: '', J_ROUTE_HOSTS: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
srv.stdout.on('data', () => {}); srv.stderr.on('data', () => {});
process.on('exit', () => { try { srv.kill('SIGKILL'); } catch { /* */ } });
for (let i = 0; i < 80; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break; } catch { /* */ } await new Promise((r) => setTimeout(r, 300)); }

const ADMIN = jwt.sign({ userId: String(new mongoose.Types.ObjectId()), role: 'admin' }, JWT_SECRET);
const RESTO = jwt.sign({ userId: String(new mongoose.Types.ObjectId()), role: 'restaurant', restaurantId: String(new mongoose.Types.ObjectId()) }, JWT_SECRET);

// Haqiqiy mp4 sarlavhasi ("ftyp") + tasodifiy baytlar
const mp4 = (size = 200_000) => Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.from([0, 0, 2, 0]), Buffer.from('isomiso2'), crypto.randomBytes(size)]);

async function postForm(path, { video, mime = 'video/mp4', fields = {}, token = ADMIN }) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, String(v));
  if (video) fd.append('video', new Blob([video], { type: mime }), 'x.mp4');
  const res = await fetch(`http://127.0.0.1:${PORT}/api${path}`, { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {}, body: fd });
  let json = null; try { json = await res.json(); } catch { /* */ }
  return { status: res.status, json };
}
async function postJson(path, body, token = ADMIN) {
  const res = await fetch(`http://127.0.0.1:${PORT}/api${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  let json = null; try { json = await res.json(); } catch { /* */ }
  return { status: res.status, json };
}
const CHAT = '-1001111';
const last = (m) => [...calls].reverse().find((c) => c.method === m);
const reset = () => { calls.length = 0; failChat = null; };

console.log('\n[1] VIDEO + matn + tugma + pin: Media → Matn → Tugma → Pin');
{
  reset();
  const buf = mp4();
  const before = (await mongoose.connection.db.listCollections().toArray()).map((c) => c.name).sort().join();
  const tmpBefore = fs.readdirSync(os.tmpdir()).length;
  const r = await postForm(`/admin/groups/${CHAT}/broadcast`, {
    video: buf,
    fields: { text: '<b>Yangi taom!</b> 🔥', buttonText: '🍽 Buyurtma berish', buttonUrl: 'https://t.me/lokmago_bot/app', pin: 'true' },
  });
  ok(r.status === 200 && r.json.ok === true && r.json.pinned === true && r.json.messageId, `200, pinned:true, messageId: ${JSON.stringify(r.json)}`);
  ok(!('videoFileId' in r.json), 'ichki file_id mijozga qaytarilmadi');
  ok(calls.length === 2 && calls[0].method === 'sendVideo' && calls[1].method === 'pinChatMessage', `tartib: ${calls.map((c) => c.method).join(' → ')}`);
  const v = calls[0];
  ok(v.file?.field === 'video' && v.file.size === buf.length && v.file.sha === sha(buf), `fayl BAYT-BAYT bir xil (${v.file?.size} bayt, sha mos)`);
  ok(v.fields.chat_id === CHAT && v.fields.caption === '<b>Yangi taom!</b> 🔥' && v.fields.parse_mode === 'HTML', 'chat_id, HTML izoh, parse_mode');
  ok(v.fields.supports_streaming === 'true', 'supports_streaming: true (Telegram’da oqim bilan ko‘rinadi)');
  const km = JSON.parse(v.fields.reply_markup);
  ok(km.inline_keyboard[0][0].text === '🍽 Buyurtma berish' && km.inline_keyboard[0][0].url === 'https://t.me/lokmago_bot/app', 'tugma matni va havolasi (reply_markup JSON)');
  ok(calls[1].fields.message_id === r.json.messageId && calls[1].fields.chat_id === CHAT, 'pin — aynan yuborilgan xabarga');
  /*
   * Maqsad: video bazaga YOZILMAGAN. Server fon jarayonlari (zaxira, BFF navbati va h.k.) shu
   * orada o'z collection'ini lazy yaratishi mumkin — shuning uchun "ro'yxat aynan bir xil"
   * deb tekshirilmaydi (oraliq-barqaror edi). Qo'shilganlar orasida fayl/video/GridFS
   * bilan bog'liq collection YO'Q ekani va hech bir hujjatda video baytlari yo'qligi tekshiriladi.
   */
  const afterList = (await mongoose.connection.db.listCollections().toArray()).map((c) => c.name);
  const added = afterList.filter((n) => !before.split(',').includes(n));
  ok(!added.some((n) => /video|upload|file|media|blob|gridfs|^fs\./i.test(n)), `bazada video/fayl collection'i YO‘Q (video hech qayerga saqlanmadi); qo‘shilganlar: [${added}]`);
  ok(fs.readdirSync(os.tmpdir()).length === tmpBefore, 'diskka (tmp) ham yozilmadi');
}

console.log('\n[2] pin belgilanmasa — pin QILINMAYDI; faqat video (matnsiz)');
{
  reset();
  const r = await postForm(`/admin/groups/${CHAT}/broadcast`, { video: mp4(5000), fields: { pin: 'false' } });
  ok(r.status === 200 && r.json.pinned === false && calls.length === 1 && calls[0].method === 'sendVideo', 'faqat sendVideo, pinChatMessage yo‘q');
  ok(calls[0].fields.caption === undefined && calls[0].fields.reply_markup === undefined, 'matnsiz va tugmasiz video');
}

console.log('\n[3] UZUN matn (>1024) + video: media izohsiz, matn va tugma keyingi xabarda; pin — media');
{
  reset();
  const longText = `<b>Aksiya</b> ${'a'.repeat(1100)}`;
  const r = await postForm(`/admin/groups/${CHAT}/broadcast`, { video: mp4(5000), fields: { text: longText, buttonText: 'Kirish', buttonUrl: 'https://x.uz', pin: 'true' } });
  ok(r.status === 200 && r.json.captionSplit === true && r.json.textMessageId, `captionSplit:true, textMessageId: ${r.json.textMessageId}`);
  ok(calls.map((c) => c.method).join() === 'sendVideo,sendMessage,pinChatMessage', `tartib: ${calls.map((c) => c.method).join(' → ')}`);
  ok(calls[0].fields.caption === undefined && calls[0].fields.reply_markup === undefined, 'video izohsiz va tugmasiz');
  ok(calls[1].fields.text === longText && JSON.parse(JSON.stringify(calls[1].fields.reply_markup)).inline_keyboard[0][0].url === 'https://x.uz', 'matn to‘liq va tugma shu xabarda');
  ok(calls[2].fields.message_id === r.json.messageId, 'pin — birinchi xabar (media)');

  // Teglar uzunlikka kirmaydi: 1000 belgi + teglar — bo'linmaydi
  reset();
  const tagged = `<b>${'b'.repeat(500)}</b><i>${'c'.repeat(500)}</i>`;
  const r2 = await postForm(`/admin/groups/${CHAT}/broadcast`, { video: mp4(5000), fields: { text: tagged } });
  ok(r2.json.captionSplit === false && calls.length === 1 && calls[0].fields.caption === tagged, 'ko‘rinadigan uzunlik 1000 — teglar hisobga olinmaydi, bo‘linmadi');
}

console.log('\n[4] RASM yo‘li avvalgidek (regressiya) va uzun izoh endi xato bermaydi');
{
  reset();
  const r = await postJson(`/admin/groups/${CHAT}/broadcast`, { text: 'Salom', imageUrl: 'https://cdn.example/x.jpg', buttonText: 'Ochish', buttonUrl: 'https://y.uz', pin: true });
  ok(r.status === 200 && calls[0].method === 'sendPhoto' && calls[0].fields.photo === 'https://cdn.example/x.jpg' && calls[0].fields.caption === 'Salom', 'JSON + rasm → sendPhoto (izoh bilan)');
  ok(calls[1].method === 'pinChatMessage', 'rasm + pin');
  reset();
  const r2 = await postJson(`/admin/groups/${CHAT}/broadcast`, { text: 'x'.repeat(1300), imageUrl: 'https://cdn.example/x.jpg' });
  ok(r2.status === 200 && r2.json.captionSplit === true && calls.map((c) => c.method).join() === 'sendPhoto,sendMessage', 'uzun izoh + rasm: avval 500 xato bergan edi, endi bo‘linadi');
  reset();
  const r3 = await postJson(`/admin/groups/${CHAT}/broadcast`, { text: 'Faqat matn' });
  ok(r3.status === 200 && calls[0].method === 'sendMessage', 'faqat matn — sendMessage');
  ok((await postJson(`/admin/groups/${CHAT}/broadcast`, {})).status === 400, 'bo‘sh so‘rov → 400');
  const multi = await postForm(`/admin/groups/${CHAT}/broadcast`, { fields: { text: 'Matn (multipart, videosiz)', pin: 'false' } });
  ok(multi.status === 200, 'multipart, lekin video yo‘q — matn reklama ham ishlaydi');
}

console.log('\n[5] Tekshiruvlar: rasm+video, soxta/noto‘g‘ri fayl, hajm, ruxsat');
{
  reset();
  const both = await postForm(`/admin/groups/${CHAT}/broadcast`, { video: mp4(1000), fields: { imageUrl: 'https://cdn.example/x.jpg' } });
  ok(both.status === 400 && both.json.code === 'IMAGE_AND_VIDEO', 'rasm va video birga → 400 IMAGE_AND_VIDEO');
  const fake = await postForm(`/admin/groups/${CHAT}/broadcast`, { video: Buffer.from('bu video emas, oddiy matn fayl'.repeat(10)), fields: { text: 'x' } });
  ok(fake.status === 415 && fake.json.code === 'UNSUPPORTED_VIDEO', 'mime "video/mp4", baytlar esa video EMAS → 415');
  const wrongMime = await postForm(`/admin/groups/${CHAT}/broadcast`, { video: mp4(1000), mime: 'application/pdf', fields: { text: 'x' } });
  ok(wrongMime.status === 415, 'noto‘g‘ri mime (application/pdf) → 415');
  ok(calls.length === 0, 'rad etilganlar Telegram’ga UMUMAN yuborilmadi');
  const big = await postForm(`/admin/groups/${CHAT}/broadcast`, { video: mp4(50 * 1024 * 1024 + 10), fields: { text: 'x' } });
  ok(big.status === 413 && big.json.code === 'VIDEO_TOO_LARGE', '50 MB dan katta → 413 VIDEO_TOO_LARGE');
  ok(calls.length === 0, 'katta fayl yuborilmadi');
  ok((await postForm(`/admin/groups/${CHAT}/broadcast`, { video: mp4(1000), token: null })).status === 401, 'tokensiz → 401');
  ok((await postForm(`/admin/groups/${CHAT}/broadcast`, { video: mp4(1000), token: RESTO })).status === 403, 'restoran roli → 403');
  const webm = await postForm(`/admin/groups/${CHAT}/broadcast`, { video: Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), crypto.randomBytes(500)]), mime: 'video/webm', fields: { text: 'w' } });
  ok(webm.status === 200, 'WEBM (EBML sarlavha) qabul qilinadi');
  const mov = await postForm(`/admin/groups/${CHAT}/broadcast`, { video: mp4(1000), mime: 'video/quicktime', fields: { text: 'm' } });
  ok(mov.status === 200 && last('sendVideo').file.filename === 'reklama.mov', 'MOV (iPhone) qabul qilinadi');
}

console.log('\n[6] Telegram xatosi adminga ko‘rinadi');
{
  reset(); failChat = CHAT;
  const r = await postForm(`/admin/groups/${CHAT}/broadcast`, { video: mp4(1000), fields: { text: 'x' } });
  ok(r.status === 500 && /chat not found/.test(r.json.error), `500 + sabab: "${r.json.error}"`);
  failChat = null;
}

console.log('\n[7] BARCHA GURUHLARGA: video BIR MARTA yuklanadi, qolganlariga file_id');
{
  reset();
  await GroupChat.create([
    { chatId: '-100501', title: 'G1', isActive: true, isBotAdmin: true },
    { chatId: '-100502', title: 'G2', isActive: true, isBotAdmin: true },
    { chatId: '-100503', title: 'G3', isActive: true, isBotAdmin: true },
    { chatId: '-100504', title: 'O‘chiq', isActive: false, isBotAdmin: true },
    { chatId: '-100505', title: 'Admin emas', isActive: true, isBotAdmin: false },
  ]);
  const buf = mp4(300_000);
  const r = await postForm('/admin/groups/broadcast-all', { video: buf, fields: { text: 'Hammaga', buttonText: 'Ochish', buttonUrl: 'https://z.uz', pin: 'true' } });
  ok(r.status === 200 && r.json.total === 3 && r.json.sent === 3 && r.json.failed === 0, `3 guruh (faol va bot admin): ${JSON.stringify(r.json)}`);
  const sends = calls.filter((c) => c.method === 'sendVideo');
  const uploads = sends.filter((c) => c.file);
  ok(sends.length === 3 && uploads.length === 1, `sendVideo 3 ta, FAYL YUKLASH faqat ${uploads.length} ta`);
  ok(uploads[0].file.sha === sha(buf), 'yuklangan fayl bayt-bayt to‘g‘ri');
  const reuse = sends.filter((c) => !c.file);
  ok(reuse.length === 2 && reuse.every((c) => /^FID-\d+$/.test(c.fields.video)), `qolgan 2 tasi Telegram file_id bilan: ${reuse.map((c) => c.fields.video)}`);
  ok(sends.every((c) => c.fields.caption === 'Hammaga' && JSON.parse(typeof c.fields.reply_markup === 'string' ? c.fields.reply_markup : JSON.stringify(c.fields.reply_markup)).inline_keyboard[0][0].url === 'https://z.uz'), 'hammasida matn va tugma');
  ok(calls.filter((c) => c.method === 'pinChatMessage').length === 3, '3 guruhda ham pin');

  // Bitta guruh xato bersa — qolganlari yuboriladi, sabab ko'rsatiladi
  reset(); failChat = '-100502';
  const r2 = await postForm('/admin/groups/broadcast-all', { video: buf, fields: { text: 'Yana' } });
  ok(r2.json.sent === 2 && r2.json.failed === 1 && r2.json.failures?.[0]?.chatId === '-100502' && /chat not found/.test(r2.json.failures[0].error), `1 ta xato, 2 ta yuborildi: ${JSON.stringify(r2.json.failures)}`);
  failChat = null;

  // Birinchi guruh xato bersa — keyingisi faylni o'zi yuklaydi
  reset(); failChat = '-100501';
  const r3 = await postForm('/admin/groups/broadcast-all', { video: buf, fields: { text: 'Uchinchi' } });
  const up3 = calls.filter((c) => c.method === 'sendVideo' && c.file);
  ok(r3.json.sent === 2 && r3.json.failed === 1 && up3.length === 2, 'birinchi guruh xato — fayl file_id yo‘qligi uchun keyingi guruhga qayta yuklandi');
  failChat = null;

  // Rasm/matn bilan barcha guruhga — avvalgidek
  reset();
  const r4 = await postJson('/admin/groups/broadcast-all', { text: 'Matn hammaga' });
  ok(r4.json.sent === 3 && calls.every((c) => c.method === 'sendMessage'), 'JSON matn — barcha guruhga avvalgidek');
}

srv.kill('SIGKILL'); tg.close();
console.log(fails ? `\n✗ ${fails} ta xato` : '\n✓ HAMMASI O‘TDI');
await mongoose.disconnect();
process.exit(fails ? 1 : 0);
