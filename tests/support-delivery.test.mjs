/*
 * MIJOZ XABARLARI → ADMINLAR GURUHI: HAR XABAR HAQIQATAN YETIB BORISHI (bildirishnoma bilan).
 * Soxta Telegram serveri (TELEGRAM_API_BASE) + xotiradagi SupportChat. Baza KERAK EMAS.
 * npm run test:support-delivery
 *
 * Telegram qoidasi: faqat sendMessage (yangi xabar) bildirishnoma beradi;
 * editMessageText (tahrir) — JIM. Adminlar xabarni ko'rishi uchun har mijoz xabari
 * kamida bitta NOTIFYING chaqiruv (sendMessage) hosil qilishi kerak.
 */
import http from 'node:http';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(40);

const calls = [];
let mode = 'ok';           // ok | notfound | migrate | parse | ratelimit
let botStatus = 'administrator';
let msgId = 100;
let rlOnce = true;
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const method = req.url.split('/').pop();
    const data = body ? JSON.parse(body) : {};
    calls.push({ method, data });
    const reply = (o) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
    if (mode === 'notfound' && method !== 'getMe') return reply({ ok: false, error_code: 400, description: 'Bad Request: chat not found' });
    if (mode === 'migrate') {
      if (data.chat_id === '-100222') return reply({ ok: true, result: { message_id: ++msgId } });
      return reply({ ok: false, error_code: 400, description: 'Bad Request: group chat was upgraded to a supergroup chat', parameters: { migrate_to_chat_id: -100222 } });
    }
    if (mode === 'parse' && data.parse_mode === 'HTML' && method === 'sendMessage') return reply({ ok: false, error_code: 400, description: "Bad Request: can't parse entities: Unsupported start tag" });
    if (mode === 'ratelimit' && rlOnce && method === 'sendMessage') { rlOnce = false; return reply({ ok: false, error_code: 429, description: 'Too Many Requests: retry after 1', parameters: { retry_after: 1 } }); }
    if (method === 'getMe') return reply({ ok: true, result: { id: 777, username: 'lokmabot' } });
    if (method === 'getChat') return reply({ ok: true, result: { id: Number(data.chat_id), type: 'supergroup', title: 'Adminlar', is_forum: false } });
    if (method === 'getChatMember') return reply({ ok: true, result: { status: botStatus, can_post_messages: true } });
    reply({ ok: true, result: { message_id: ++msgId } });
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
process.env.TELEGRAM_API_BASE = `http://127.0.0.1:${server.address().port}`;
process.env.TELEGRAM_BOT_TOKEN = '1:TEST';
process.env.SUPPORT_GROUP_CHAT_ID = '-100111';

const { SupportChat } = await import('../src/models/SupportChat.js');
const { notifySupportGroup, markSupportGroupReplied, markSupportGroupClosed, supportGroupStatus, sendSupportGroupTest } = await import('../src/services/supportGroupNotify.js');

// Xotiradagi SupportChat
const store = new Map();
const setPath = (o, path, v) => { const k = path.split('.'); let t = o; for (let i = 0; i < k.length - 1; i++) t = t[k[i]] ??= {}; t[k.at(-1)] = v; };
SupportChat.findById = (id) => ({ select() { return this; }, lean: async () => structuredClone(store.get(String(id)) || null) });
SupportChat.updateOne = async (f, u) => { const d = store.get(String(f._id)); if (d && u.$set) for (const [k, v] of Object.entries(u.$set)) setPath(d, k, v); return {}; };
const mkChat = (n) => { const _id = String(n).padStart(24, '0'); store.set(_id, { _id, firstName: 'Azimjon', username: 'azimjon', groupPost: null }); return { _id, firstName: 'Azimjon', username: 'azimjon' }; };

let fails = 0;
const ok = (c, m) => { console.log(c ? '  ✓' : '  ✗ FAIL:', m); if (!c) fails++; };
const reset = () => { calls.length = 0; };
const sends = () => calls.filter((c) => c.method === 'sendMessage');
const edits = () => calls.filter((c) => c.method === 'editMessageText');
const loud = () => sends().filter((c) => c.data.disable_notification !== true);   // bildirishnoma beradiganlar

console.log('\n[1] Birinchi xabar');
const c1 = mkChat(1);
await notifySupportGroup(c1, 'Salom, buyurtmam kech qoldi');
ok(loud().length === 1, 'yangi post — adminlarga BILDIRISHNOMA bilan keldi');

console.log('\n[2] Mijoz yana yozdi (post tahrirlanadi — Telegram bunda JIM)');
reset();
await notifySupportGroup(c1, 'Iltimos tezroq');
ok(edits().length === 1, 'post yangilandi (tahrir)');
ok(loud().length >= 1, 'ADMINLARGA BILDIRISHNOMA ham keldi (tahrir jim bo‘lgani uchun alohida xabar)');
ok(loud().some((c) => /Iltimos tezroq/.test(c.data.text)), 'bildirishnomada mijozning yangi matni bor');
ok(loud().every((c) => c.data.reply_parameters?.message_id || c.data.reply_to_message_id), 'bildirishnoma mijoz postiga JAVOB sifatida (suhbat bir joyda)');

console.log('\n[3] Admin javob berdi, mijoz yana yozdi — eski postga tahrir: ham bildirishnoma kerak');
reset();
await markSupportGroupReplied(c1._id, 'Admin');
reset();
await notifySupportGroup(c1, 'Rahmat, kutaman');
ok(loud().length >= 1 && loud().some((c) => /Rahmat, kutaman/.test(c.data.text)), 'javobdan keyingi xabar ham adminlarga bildirishnoma bilan keldi');

console.log('\n[4] Suhbat yopilgach — yangi post (bildirishnoma bilan)');
await markSupportGroupClosed(c1._id);
reset();
await notifySupportGroup(c1, 'Yana bir savol');
ok(loud().length === 1 && edits().length === 0, 'yopilgandan keyin yangi post, bitta bildirishnoma');

console.log('\n[5] Maxsus belgilar va HTML');
const c2 = mkChat(2);
reset();
await notifySupportGroup(c2, '<b>salom</b> & <script> 5 < 6');
ok(loud().length === 1 && !/<script>/.test(loud()[0].data.text), 'HTML belgilar tozalandi (escape), xabar yetdi');

console.log('\n[6] Telegram HTML’ni rad etsa — oddiy matn bilan qayta yuboriladi');
const c3 = mkChat(3); mode = 'parse'; reset();
const r6 = await notifySupportGroup(c3, 'Test matn');
ok(r6 && sends().length >= 2 && sends().at(-1).data.parse_mode === undefined, 'parse xatosida oddiy matn bilan qayta yuborildi (xabar yo‘qolmadi)');

console.log('\n[7] Guruh supergruppaga aylangan (migrate_to_chat_id) — xabar yo‘qolmasligi kerak');
const c4 = mkChat(4); mode = 'migrate'; reset();
const r7 = await notifySupportGroup(c4, 'Migratsiyadan keyin xabar');
ok(r7 && sends().some((c) => c.data.chat_id === '-100222'), 'yangi guruh ID’siga avtomatik yuborildi');
reset();
await notifySupportGroup(mkChat(5), 'Keyingi mijoz');
ok(sends()[0]?.data.chat_id === '-100222', 'keyingi xabarlar ham yangi ID’ga (qayta xato yo‘q)');

console.log('\n[8] Telegram vaqtincha 429 bersa — qayta uriniladi');
mode = 'ratelimit'; rlOnce = true; reset();
const r8 = await notifySupportGroup(mkChat(6), 'Sekin');
ok(r8 && sends().length >= 2, '429 dan keyin qayta urinib yuborildi');

console.log('\n[9] Chat topilmadi — xabar yo‘qolishi aniq loglanadi, server yiqilmaydi');
mode = 'notfound'; reset();
const r9 = await notifySupportGroup(mkChat(7), 'x');
ok(r9 === null, 'xato yutildi (null) va server ishlashda davom etadi');

console.log('\n[10] Diagnostika: sabab aniq aytiladi');
{
  mode = 'ok';
  let st = await supportGroupStatus();
  ok(st.ok === true && st.chat?.title === 'Adminlar' && st.bot?.username === 'lokmabot', 'to‘g‘ri sozlama: ok, guruh va bot ko‘rinadi');
  const t = await sendSupportGroupTest('Admin');
  ok(t.ok && calls.at(-1).method === 'sendMessage' && /Sinov xabari/.test(calls.at(-1).data.text), 'sinov xabari guruhga yuborildi');
  botStatus = 'kicked';
  st = await supportGroupStatus();
  ok(!st.ok && st.problems.some((p) => /Bot guruhda emas/.test(p)), 'bot guruhdan chiqarilgan — aytiladi');
  botStatus = 'administrator';
  mode = 'notfound';
  st = await supportGroupStatus();
  ok(!st.ok && st.problems.some((p) => /Guruh topilmadi/.test(p)) && st.hints.some((h) => /-100/.test(h)), 'noto‘g‘ri ID / bot qo‘shilmagan — sababi va yechimi aytiladi');
  mode = 'ok';
}

server.close();
console.log(fails ? `\n✗ ${fails} ta xato` : '\n✓ Hammasi o‘tdi');
process.exit(fails ? 1 : 0);
