/*
 * Reklama videosi o'z o'lchamida: admin panel bergan eni/bo'yi/davomiyligi Telegram sendVideo'ga uzatiladi
 * (bo'lmasa iPhone MOV kabi videolar guruhda ezilgan ko'rinadi). Telegram SOXTA. npm run test:video-dimensions
 */
process.env.JWT_SECRET = 'x'.repeat(40);
process.env.TELEGRAM_BOT_TOKEN = 'TEST';
import test from 'node:test';
import assert from 'node:assert/strict';
import { bindModel } from './helpers/fakeModel.mjs';

const { GroupChat } = await import('../src/models/GroupChat.js');
bindModel(GroupChat, { docs: [] });
const { sendCustomBroadcast } = await import('../src/services/telegramGroup.js');
const { adminController } = await import('../src/controllers/admin.js');

const sent = [];
globalThis.fetch = async (url, opts = {}) => {
  const method = String(url).split('/').pop();
  let fields = {};
  if (opts.body instanceof FormData) for (const [k, v] of opts.body.entries()) fields[k] = typeof v === 'string' ? v : '[fayl]';
  else if (typeof opts.body === 'string') fields = JSON.parse(opts.body);
  sent.push({ method, fields });
  return new Response(JSON.stringify({ ok: true, result: { message_id: 7, video: { file_id: 'FILE1' } } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
const video = { buffer: Buffer.from('fake-mp4'), mimetype: 'video/mp4', filename: 'reklama.mp4' };

test('yuklashda (multipart) eni, bo\'yi va davomiyligi Telegram\'ga ketadi', async () => {
  sent.length = 0;
  await sendCustomBroadcast({ chatId: '-1', text: 'Aksiya', video, width: 1080, height: 1920, duration: 15 });
  const f = sent.find((s) => s.method === 'sendVideo').fields;
  assert.equal(f.width, '1080'); assert.equal(f.height, '1920'); assert.equal(f.duration, '15');
  assert.equal(f.supports_streaming, 'true'); assert.equal(f.video, '[fayl]');
});

test('keyingi guruhlarga (file_id) ham o\'lcham bilan', async () => {
  sent.length = 0;
  await sendCustomBroadcast({ chatId: '-2', text: 'x', videoFileId: 'FILE1', videoMethod: 'sendVideo', width: 720, height: 1280, duration: 9 });
  const f = sent.find((s) => s.method === 'sendVideo').fields;
  assert.equal(f.video, 'FILE1'); assert.equal(f.width, 720); assert.equal(f.height, 1280); assert.equal(f.duration, 9);
});

test('o\'lcham noma\'lum yoki chala — yuborilmaydi (Telegram o\'zi aniqlaydi, chalg\'itilmaydi)', async () => {
  sent.length = 0;
  await sendCustomBroadcast({ chatId: '-3', text: 'x', video });
  await sendCustomBroadcast({ chatId: '-3', text: 'x', video, width: 1080 });            // bo'yi yo'q
  await sendCustomBroadcast({ chatId: '-3', text: 'x', video, width: 0, height: 0, duration: 0 });
  for (const s of sent.filter((x) => x.method === 'sendVideo')) {
    assert.ok(!('width' in s.fields) && !('height' in s.fields) && !('duration' in s.fields), JSON.stringify(s.fields));
  }
});

const run = async (h, req) => {
  const r = { code: 200, body: null }; r.status = (c) => { r.code = c; return r; }; r.json = (b) => { r.body = b; return r; };
  h(req, r, (e) => { throw e; });
  for (let i = 0; i < 300 && r.body === null; i++) await new Promise((x) => setTimeout(x, 10));
  return r;
};

test('API: multipart\'dagi satr qiymatlar sonlarga aylanadi; yaroqsiz o\'lcham — 400', async () => {
  sent.length = 0;
  let r = await run(adminController.broadcast, { params: { chatId: '-9' }, body: { text: 'x', width: '1080', height: '1920', duration: '15' }, file: { buffer: Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]), mimetype: 'video/mp4' } });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  const f = sent.find((s) => s.method === 'sendVideo').fields;
  assert.equal(f.width, '1080'); assert.equal(f.height, '1920');
  r = await run(adminController.broadcast, { params: { chatId: '-9' }, body: { text: 'x', width: '-5', height: '1920' } });
  assert.equal(r.code, 400);
  r = await run(adminController.broadcast, { params: { chatId: '-9' }, body: { text: 'x', width: 'katta' } });
  assert.equal(r.code, 400);
});
