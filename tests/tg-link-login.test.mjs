/*
 * TELEGRAM BOT HAVOLASI ORQALI KIRISH: boshlash → botda tasdiqlash (telefon bilan/siz) → so'rash (poll) → tokenlar.
 * Soxta Telegram + xotiradagi model; bot ulanishi HAQIQIY handleBotUpdate orqali. Baza KERAK EMAS.
 * npm run test:tg-link
 */
import http from 'node:http';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(40);

const calls = [];
const server = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => { b += c; });
  req.on('end', () => { calls.push({ method: req.url.split('/').pop(), data: b ? JSON.parse(b) : {} }); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, result: { message_id: 1 } })); });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
process.env.TELEGRAM_API_BASE = `http://127.0.0.1:${server.address().port}`;
process.env.TELEGRAM_BOT_TOKEN = '1:TEST';
process.env.BOT_USERNAME = 'lokmaGobot';

const { TgLoginRequest } = await import('../src/models/TgLoginRequest.js');
const L = await import('../src/services/tgLinkLogin.js');
const { handleBotUpdate } = await import('../src/services/telegram.js');
const { tgLinkAuthController: C } = await import('../src/controllers/tgLinkAuth.js');

// ── xotiradagi model ──
let rows = []; let seq = 1;
const get = (o, path) => path.split('.').reduce((x, k) => x?.[k], o);
const ts = (v) => (v instanceof Date ? v.getTime() : v);
const match = (r, f) => Object.entries(f).every(([k, v]) => {
  const a = ts(get(r, k));
  if (v && typeof v === 'object' && !(v instanceof Date)) return Object.entries(v).every(([op, x]) => (op === '$gt' ? a > ts(x) : op === '$lte' ? a <= ts(x) : false));
  return a === ts(v);
});
const setDeep = (r, path, val) => { const ks = path.split('.'); let o = r; ks.slice(0, -1).forEach((k) => { o[k] = o[k] || {}; o = o[k]; }); o[ks.at(-1)] = val; };
const apply = (r, u) => { for (const [k, v] of Object.entries(u.$set || {})) setDeep(r, k, v); };
TgLoginRequest.create = async (d) => { const r = { _id: `q${seq++}`, status: 'pending', phone: '', tgUser: undefined, createdAt: new Date(), ...d }; rows.push(r); return r; };
TgLoginRequest.findOne = (f) => { let a = rows.filter((r) => match(r, f)); const c = { sort() { a = [...a].reverse(); return c; }, // Haqiqiy baza kabi NUSXA qaytaradi (aks holda parallel so'rovlar bir obyektni bo'lishib, poyga holati ko'rinmaydi)
  then: (res, rej) => Promise.resolve(a[0] ? structuredClone(a[0]) : null).then(res, rej) }; return c; };
TgLoginRequest.findOneAndUpdate = async (f, u) => { const r = rows.find((x) => match(x, f)); if (!r) return null; apply(r, u); return r; };
TgLoginRequest.updateOne = async (f, u) => { const r = rows.find((x) => match(x, f)); if (r) { apply(r, u); return { modifiedCount: 1 }; } return { modifiedCount: 0 }; };

let fails = 0;
const ok = (c, m) => { console.log(c ? '  ✓' : '  ✗ FAIL:', m); if (!c) fails++; };
const sent = () => calls.filter((c) => c.method === 'sendMessage');
const reset = () => { rows = []; seq = 1; calls.length = 0; };
let completed = []; let completeImpl = null;
const complete = async (tg, opts) => { completed.push({ tg, opts }); if (completeImpl) return completeImpl(tg, opts); const user = { _id: 'u1', phone: undefined, phoneVerified: false, saved: 0, async save() { this.saved++; } }; return { token: 'T', accessToken: 'A', refreshToken: 'R', user, isNewUser: true }; };
const FROM = { id: 777, first_name: 'Ali', last_name: 'Valiyev', username: 'ali', language_code: 'uz' };
const startMsg = (code, from = FROM) => ({ message: { chat: { id: from.id, type: 'private' }, from, text: `/start login_${code}` } });
const NOW = new Date('2026-10-19T10:00:00Z');

console.log('\n[1] Boshlash');
reset();
const s = await L.startLogin({ platform: 'android', deviceId: 'dev1', lang: 'ru', ref: 'ref_abc123', ip: '1.2.3.4', userAgent: 'UA' }, NOW);
ok(/^[A-Za-z0-9]{16}$/.test(s.code) && s.pollSecret.length >= 40, 'code (16 belgi) va pollSecret (kuchli) qaytdi');
ok(s.appLink === `tg://resolve?domain=lokmaGobot&start=login_${s.code}` && s.deepLink === `https://t.me/lokmaGobot?start=login_${s.code}`, 'Telegram ilova havolasi va https zaxira havolasi to‘g‘ri');
ok(rows[0].pollHash !== s.pollSecret && rows[0].pollHash.length === 64 && !JSON.stringify(rows[0]).includes(s.pollSecret), 'bazada pollSecret EMAS, faqat sha256 i');
ok(rows[0].platform === 'android' && rows[0].lang === 'ru' && rows[0].startParam === 'ref_abc123' && rows[0].expiresAt - NOW === 300_000, 'platforma, til, referal saqlandi; 5 daqiqada eskiradi');
const s2 = await L.startLogin({ platform: 'hack', ref: '<script>' }, NOW);
ok(rows[1].platform === 'web' && rows[1].startParam === '', 'noma’lum platforma web ga, noto‘g‘ri referal tashlab yuboriladi');
ok(new Set(Array.from({ length: 200 }, () => L.makeCode())).size === 200, '200 ta kod — takrorlanmaydi');

console.log('\n[2] Bot: havola ochildi (HAQIQIY handleBotUpdate)');
reset(); const a = await L.startLogin({ platform: 'ios', lang: 'uz' }, new Date());
await handleBotUpdate(startMsg(a.code));
const m1 = sent()[0];
ok(m1 && m1.data.chat_id === 777 && /Lokma Go/.test(m1.data.text) && /iPhone ilovasi/.test(m1.data.text), 'bot qurilma (iPhone ilovasi) va vaqt bilan javob berdi');
const kb = m1?.data.reply_markup?.keyboard || [];
ok(kb[0]?.[0]?.request_contact === true && kb[1]?.length === 2, 'tugmalar: 📱 kontakt ulashish (request_contact), ✅ raqamsiz, ❌ bekor');
ok(/Bu siz bo‘lmasangiz|Bu siz bo'lmasangiz/.test(m1?.data.text), 'ogohlantirish: "Bu siz bo‘lmasangiz — Bekor qilish"');
ok(rows[0].tgUser?.id === '777' && rows[0].status === 'pending', 'havolani ochgan foydalanuvchi yozildi, hali TASDIQLANMAGAN');
let p = await L.pollLogin({ code: a.code, pollSecret: a.pollSecret }, { complete });
ok(p.body.status === 'pending' && p.body.awaiting === true && completed.length === 0, 'poll: kutilmoqda, "botni ochdi" (awaiting) — tokenlar YO‘Q');

console.log('\n[3] Tasdiqlash: telefon ulashib');
calls.length = 0;
await handleBotUpdate({ message: { chat: { id: 777 }, from: FROM, contact: { phone_number: '998901112233', user_id: 777, first_name: 'Ali' } } });
ok(rows[0].status === 'confirmed' && rows[0].phone === '+998901112233', 'tasdiqlandi, telefon +998901112233 ko‘rinishiga keltirildi');
ok(sent()[0]?.data.reply_markup?.remove_keyboard === true && /Tayyor/.test(sent()[0].data.text), 'bot "Tayyor" dedi va tugmalarni olib tashladi');
p = await L.pollLogin({ code: a.code, pollSecret: a.pollSecret }, { complete });
ok(p.http === 200 && p.body.status === 'ok' && p.body.accessToken === 'A' && p.body.refreshToken === 'R', 'poll: tokenlar berildi');
ok(completed.at(-1).opts.platform === 'ios' && completed.at(-1).tg.id === '777', 'kirish iOS platformasi va to‘g‘ri Telegram foydalanuvchisi bilan yakunlandi');
ok(p.body.user.phone === '+998901112233' && p.body.user.phoneVerified === true && p.body.user.saved === 1, 'Telegram tasdiqlagan telefon foydalanuvchiga yozildi');
const before = completed.length;
p = await L.pollLogin({ code: a.code, pollSecret: a.pollSecret }, { complete });
ok(p.body.status === 'used' && !p.body.accessToken && completed.length === before, 'ikkinchi poll: tokenlar QAYTA BERILMAYDI (bir martalik)');

console.log('\n[3b] Parallel so‘rovlar (ikkita poll BIR VAQTDA) — tokenlar faqat BIR MARTA');
reset(); const cc = await L.startLogin({}, new Date()); await handleBotUpdate(startMsg(cc.code)); await handleBotUpdate({ message: { chat: { id: 777 }, from: FROM, text: '✅ Raqamsiz kirish' } });
const c0 = completed.length;
const [pa, pb] = await Promise.all([L.pollLogin({ code: cc.code, pollSecret: cc.pollSecret }, { complete }), L.pollLogin({ code: cc.code, pollSecret: cc.pollSecret }, { complete })]);
ok([pa, pb].filter((x) => x.body.status === 'ok').length === 1 && completed.length === c0 + 1, 'ikkita parallel poll: tokenlar FAQAT bittasiga berildi, sessiya bir marta yaratildi');

console.log('\n[4] Tasdiqlash: raqamsiz, bekor qilish, begona kontakt');
reset(); let b1 = await L.startLogin({}, new Date()); await handleBotUpdate(startMsg(b1.code)); calls.length = 0;
await handleBotUpdate({ message: { chat: { id: 777 }, from: FROM, text: '✅ Raqamsiz kirish' } });
ok(rows[0].status === 'confirmed' && rows[0].phone === '', '"Raqamsiz kirish": tasdiqlandi, telefon yo‘q');
reset(); b1 = await L.startLogin({}, new Date()); await handleBotUpdate(startMsg(b1.code)); calls.length = 0;
await handleBotUpdate({ message: { chat: { id: 777 }, from: FROM, text: '❌ Bekor qilish' } });
ok(rows[0].status === 'cancelled', '"Bekor qilish": so‘rov bekor qilindi');
p = await L.pollLogin({ code: b1.code, pollSecret: b1.pollSecret }, { complete });
ok(p.body.status === 'cancelled' && !p.body.accessToken, 'poll: "cancelled", tokenlar yo‘q');
reset(); b1 = await L.startLogin({}, new Date()); await handleBotUpdate(startMsg(b1.code)); calls.length = 0;
await handleBotUpdate({ message: { chat: { id: 777 }, from: FROM, contact: { phone_number: '998909998877', user_id: 12345 } } });
ok(rows[0].status === 'pending' && /o‘zingizning raqamingizni|o'zingizning raqamingizni/.test(sent()[0]?.data.text || ''), 'BEGONA odamning kontakti rad etildi (tasdiqlanmadi)');

console.log('\n[5] Xavfsizlik');
reset(); const v = await L.startLogin({}, new Date()); await handleBotUpdate(startMsg(v.code)); calls.length = 0;
// boshqa Telegram foydalanuvchisi "tasdiqlay" olmaydi
await handleBotUpdate({ message: { chat: { id: 999 }, from: { id: 999, first_name: 'Hacker' }, text: '✅ Raqamsiz kirish' } });
ok(rows[0].status === 'pending', 'havolani OCHMAGAN boshqa foydalanuvchi tasdiqlay olmaydi');
await handleBotUpdate({ message: { chat: { id: 777 }, from: FROM, text: '✅ Raqamsiz kirish' } });
p = await L.pollLogin({ code: v.code, pollSecret: 'x'.repeat(43) }, { complete });
ok(p.http === 404 && p.body.status === 'invalid' && !p.body.accessToken, 'noto‘g‘ri pollSecret: tokenlar BERILMAYDI (havolani ko‘rgan odam o‘g‘irlay olmaydi)');
p = await L.pollLogin({ code: 'ZZZZZZZZZZZZZZZZ', pollSecret: v.pollSecret }, { complete });
ok(p.http === 404, 'mavjud bo‘lmagan kod: 404 (qaysi biri noto‘g‘riligi oshkor qilinmaydi)');
ok((await L.pollLogin({ code: "'; drop", pollSecret: 1 }, { complete })).http === 400, 'noto‘g‘ri shakl: 400');
// eskirgan
reset(); const e1 = await L.startLogin({}, new Date('2026-01-01T00:00:00Z')); calls.length = 0;
await handleBotUpdate(startMsg(e1.code));
ok(/eskirgan/.test(sent()[0]?.data.text || '') && rows[0].status === 'pending' && !rows[0].tgUser, 'eskirgan havola: bot "eskirgan" dedi, tasdiqlashga yo‘l bermadi');
p = await L.pollLogin({ code: e1.code, pollSecret: e1.pollSecret }, { complete });
ok(p.body.status === 'expired', 'poll: "expired"');
await handleBotUpdate(startMsg('short')); await handleBotUpdate({ message: { chat: { id: 5 }, from: { id: 5 }, text: '/start login_' } });
ok(sent().length >= 3, 'noto‘g‘ri/bo‘sh kod: bot jim qolmaydi, "eskirgan" deydi');

console.log('\n[6] Bloklangan mijoz va kutilmagan xato');
reset(); const bl = await L.startLogin({}, new Date()); await handleBotUpdate(startMsg(bl.code)); await handleBotUpdate({ message: { chat: { id: 777 }, from: FROM, text: '✅ Raqamsiz kirish' } });
completeImpl = async () => { throw Object.assign(new Error('blocked'), { status: 403, payload: { error: 'Akkaunt bloklangan', code: 'BLOCKED' } }); };
p = await L.pollLogin({ code: bl.code, pollSecret: bl.pollSecret }, { complete });
ok(p.http === 403 && p.body.code === 'BLOCKED', 'bloklangan mijoz: 403 va sabab qaytdi');
reset(); const er = await L.startLogin({}, new Date()); await handleBotUpdate(startMsg(er.code)); await handleBotUpdate({ message: { chat: { id: 777 }, from: FROM, text: '✅ Raqamsiz kirish' } });
completeImpl = async () => { throw new Error('baza uzildi'); };
const oe = console.error; console.error = () => {};
p = await L.pollLogin({ code: er.code, pollSecret: er.pollSecret }, { complete });
console.error = oe;
ok(p.http === 500 && rows[0].status === 'confirmed', 'kutilmagan xato: 500, lekin so‘rov "confirmed" holatiga QAYTARILDI — mijoz qayta urinishi mumkin');
completeImpl = null;
p = await L.pollLogin({ code: er.code, pollSecret: er.pollSecret }, { complete });
ok(p.body.status === 'ok', 'qayta urinishda kirish muvaffaqiyatli bo‘ldi');

console.log('\n[7] Mavjud oqimlar buzilmaydi');
reset(); calls.length = 0;
let referralCalled = false;
await handleBotUpdate({ message: { chat: { id: 5 }, from: { id: 5, first_name: 'X' }, text: '/start ref_abc' } }).catch(() => {});
ok(sent().every((c) => !/Lokma Go.*ga kirish/.test(c.data.text || '')), '/start ref_… (referal) kirish oqimini ishga tushirmaydi');
await handleBotUpdate({ message: { chat: { id: 5 }, from: { id: 5 }, contact: { phone_number: '1', user_id: 5 } } });
ok(true, 'bizning oqimdan tashqari kontakt jim e‘tiborsiz qoldiriladi (xato tashlamaydi)');

server.close();
console.log(fails ? `\n✗ ${fails} ta xato` : '\n✓ Hammasi o‘tdi');
process.exit(fails ? 1 : 0);
