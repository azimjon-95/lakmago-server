/*
 * APNs (iOS) uzilishlarga bardoshlik — HAQIQIY HTTP/2 yo'l (soxta transportsiz), lokal h2c server bilan:
 *  • Apple 503 / 429 → qayta uriniladi va yetkaziladi
 *  • ulanish o'rtada uzilsa → yangi ulanish ochiladi va yetkaziladi
 *  • eskirgan JWT (ExpiredProviderToken) → qayta imzolanib qayta uriniladi
 *  • BadDeviceToken → qayta urinilmaydi, `dead`
 *  • sozlama xatolari (403 TopicDisallowed) qurilmani «aybdor» qilmaydi
 * npm run test:apns-resilience
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http2 from 'node:http2';
import crypto from 'node:crypto';
import { config } from '../src/config/index.js';

const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });

let script = [];           // har so'rovga javob: { status, reason } | 'drop'
let hits = 0;
let jwts = [];
const server = http2.createServer();
server.on('stream', (stream, headers) => {
  hits += 1; jwts.push(headers.authorization);
  const step = script.shift() || { status: 200 };
  if (step === 'drop') { stream.session.destroy(); return; }
  stream.respond({ ':status': step.status });
  stream.end(step.reason ? JSON.stringify({ reason: step.reason }) : '');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
config.apnsHost = `http://127.0.0.1:${server.address().port}`;
config.apnsKeyBase64 = Buffer.from(pem).toString('base64');
config.apnsKeyId = 'ABCDE12345'; config.apnsTeamId = 'TEAM123456';
config.mobilePushTimeoutMs = 3000;

const { initMobilePush, sendApns } = await import('../src/services/mobilePush.js');
const { isDeviceFault } = await import('../src/services/promoPush.js');
initMobilePush();
const H = { 'apns-push-type': 'alert', 'apns-priority': '10' };
const P = { aps: { alert: { title: 't', body: 'b' } } };
const run = async (steps) => { script = [...steps]; hits = 0; jwts = []; return sendApns('a'.repeat(64), P, H, 'production'); };

after(() => { server.close(); server.closeAllConnections?.(); setTimeout(() => process.exit(0), 50).unref(); });

test('200 — bir urinishda yetkaziladi', async () => {
  const r = await run([{ status: 200 }]);
  assert.equal(r.ok, true); assert.equal(hits, 1);
});

test('Apple 503 → qayta uriniladi va yetkaziladi', async () => {
  const r = await run([{ status: 503, reason: 'ServiceUnavailable' }, { status: 200 }]);
  assert.equal(r.ok, true); assert.equal(hits, 2);
});

test('Apple 429 → qayta uriniladi', async () => {
  const r = await run([{ status: 429, reason: 'TooManyRequests' }, { status: 200 }]);
  assert.equal(r.ok, true); assert.equal(hits, 2);
});

test('ulanish o‘rtada uzildi → yangi ulanish bilan yetkaziladi', async () => {
  const r = await run(['drop', { status: 200 }]);
  assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(hits, 2);
});

test('ulanish ketma-ket ikki marta uzildi → baribir yetkaziladi (3 urinish)', async () => {
  const r = await run(['drop', 'drop', { status: 200 }]);
  assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(hits, 3);
});

test('ExpiredProviderToken → JWT qayta imzolanadi va qayta uriniladi', async () => {
  const r = await run([{ status: 403, reason: 'ExpiredProviderToken' }, { status: 200 }]);
  assert.equal(r.ok, true); assert.equal(hits, 2);
  assert.notEqual(jwts[0], jwts[1], 'ikkinchi urinishda yangi JWT');
});

test('BadDeviceToken → qayta urinilmaydi, o‘lik token', async () => {
  const r = await run([{ status: 400, reason: 'BadDeviceToken' }, { status: 200 }]);
  assert.equal(r.ok, false); assert.equal(r.dead, true); assert.equal(hits, 1);
});

test('410 Unregistered → o‘lik, qayta urinilmaydi', async () => {
  const r = await run([{ status: 410, reason: 'Unregistered' }]);
  assert.equal(r.dead, true); assert.equal(hits, 1);
});

test('doimiy 503 → 3 urinishdan keyin xato (cheksiz kutmaydi)', async () => {
  const r = await run([{ status: 503 }, { status: 503 }, { status: 503 }, { status: 503 }]);
  assert.equal(r.ok, false); assert.equal(hits, 3);
});

test('sozlama/tarmoq xatosi qurilma aybi sanalmaydi; haqiqiy qurilma xatosi sanaladi', () => {
  assert.equal(isDeviceFault({ ok: false, error: 'APNs 403 TopicDisallowed' }), false);
  assert.equal(isDeviceFault({ ok: false, error: 'APNs 403 InvalidProviderToken' }), false);
  assert.equal(isDeviceFault({ ok: false, error: 'APNs timeout', transient: true }), false);
  assert.equal(isDeviceFault({ ok: false, error: 'APNs 503 ', transient: true }), false);
  assert.equal(isDeviceFault({ ok: false, error: 'FCM 503 UNAVAILABLE' }), false);
  assert.equal(isDeviceFault({ ok: false, error: 'APNs 400 PayloadTooLarge' }), true);
});
