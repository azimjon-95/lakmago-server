/*
 * Qurilma qayerda ↔ yetkazish manzili (services/deviceCheck.js): chegaralar, GPS xatosi, eskirgan nuqta, restoran ko'rinishi, bot xabari.
 * Baza YO'Q. npm run test:device-check
 */
process.env.JWT_SECRET = 'x'.repeat(40);
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assessDevice, deviceCheckView, formatMeters, DEVICE } from '../src/services/deviceCheck.js';
import { toPanelOrder } from '../src/services/panelOrderView.js';

const NOW = Date.parse('2026-11-05T12:00:00Z');
const T = { lat: 40.9983, lng: 71.6726 };                                   // yetkazish manzili
const north = (m) => ({ lat: T.lat + m / 111320, lng: T.lng });              // manzildan m metr shimolda
const dev = (m, acc = 20, ageMs = 60_000) => ({ ...north(m), accuracy: acc, at: new Date(NOW - ageMs).toISOString() });
const as = (device, o = {}) => assessDevice(device, T, { now: NOW, ...o });

test('chegaralar: manzilda / biroz uzoq / uzoq (500 m, xato ayirilgandan keyin)', () => {
  assert.equal(DEVICE.farM, 500); assert.equal(DEVICE.nearM, 150);
  assert.equal(as(dev(30)).status, 'match');
  assert.equal(as(dev(250)).status, 'near', '250 − 20 = 230 → biroz uzoq (ogohlantirilmaydi)');
  assert.equal(as(dev(515)).status, 'near', '515 − 20 = 495 < 500');
  assert.equal(as(dev(521)).status, 'far', '521 − 20 = 501 ≥ 500');
  const far = as(dev(8200, 15));
  assert.equal(far.status, 'far'); assert.ok(Math.abs(far.distanceM - 8200) < 20); assert.equal(far.accuracyM, 15);
});

test('GPS aniqligi past bo\'lsa — xulosa YO\'Q (soxta "uzoq" ham, soxta "manzilda" ham bo\'lmasin)', () => {
  assert.equal(as(dev(900, 150)).status, 'unknown', '900 m, aniqlik 150 m');
  assert.equal(as(dev(10, 300)).status, 'unknown', 'aniqlik yomon — "manzilda" ham deb bo\'lmaydi');
  assert.equal(as(dev(900, 100)).status, 'far', 'aniqlik 100 m — chegarada ruxsat');
  // aniqlik berilmasa o'rtacha taxmin (60 m)
  const noAcc = as({ ...north(1000), at: new Date(NOW - 5000).toISOString() });
  assert.equal(noAcc.status, 'far'); assert.equal(noAcc.accuracyM, 60);
});

test('nuqta eskirgan / kelajakda / yaroqsiz — unknown', () => {
  assert.equal(as(dev(5000, 20, 16 * 60_000)).status, 'unknown', '16 daqiqa oldingi nuqta dalil emas');
  assert.equal(as(dev(5000, 20, -5 * 60_000)).status, 'unknown', 'kelajakdagi vaqt (noto\'g\'ri soat)');
  assert.equal(as(dev(5000, 20, -60_000)).status, 'far', '1 daqiqa oldinda — soat farqi, ruxsat');
  for (const bad of [{}, undefined, { lat: 0, lng: 0, at: new Date(NOW).toISOString() }, { lat: 'x', lng: 1, at: new Date(NOW).toISOString() }, { ...north(900), at: 'kecha' }, { ...north(900) }]) {
    assert.equal(as(bad).status, 'unknown', JSON.stringify(bad));
  }
  assert.equal(assessDevice(dev(900), {}, { now: NOW }).status, 'unknown', 'manzil koordinatasi yo\'q');
});

test('mijoz o\'zi tasdiqlagan (confirmedFar) belgilanadi va natijaga ta\'sir qilmaydi; xom koordinata qaytmaydi', () => {
  const r = as(dev(8200, 15), { confirmedFar: true });
  assert.equal(r.status, 'far'); assert.equal(r.confirmedFar, true);
  assert.equal(as(dev(8200, 15)).confirmedFar, false);
  assert.ok(!('lat' in r) && !('lng' in r) && !JSON.stringify(r).includes('40.99'), 'koordinata saqlanmaydi (maxfiylik)');
  assert.ok(r.fixAt instanceof Date);
});

test('restoran ko\'rinishi: faqat far/near/match holati va masofa — koordinatasiz', () => {
  const o = { deviceCheck: { status: 'far', distanceM: 8200, accuracyM: 15, confirmedFar: false, fixAt: new Date() } };
  assert.deepEqual(deviceCheckView(o), { status: 'far', distanceM: 8200, confirmedFar: false });
  assert.equal(deviceCheckView({}), null);
  const panel = toPanelOrder({ _id: 'o1', status: 'accepted', fulfillment: 'delivery', userId: { _id: 'u' }, ...o });
  assert.deepEqual(panel.deviceCheck, { status: 'far', distanceM: 8200, confirmedFar: false });
  assert.equal(toPanelOrder({ _id: 'o2', status: 'accepted', fulfillment: 'pickup', userId: { _id: 'u' } }).deviceCheck, null);
});

test('formatMeters', () => {
  assert.equal(formatMeters(8200), '8,2 km'); assert.equal(formatMeters(640), '640 m'); assert.equal(formatMeters(1000), '1,0 km'); assert.equal(formatMeters(NaN), '');
});

test('simlar: buyurtma yaratish baholaydi (faqat yetkazish), bot ogohlantiradi, eski ilova (maydonsiz) buzilmaydi', () => {
  const misc = readFileSync(new URL('../src/controllers/misc.js', import.meta.url), 'utf8');
  assert.ok(/deviceLat: z\.number\(\)\.min\(-90\)\.max\(90\)\.optional\(\)/.test(misc) && /addressConfirmedFar: z\.boolean\(\)\.optional\(\)/.test(misc), 'maydonlar ixtiyoriy');
  assert.ok(/const deviceCheck = !isPickup && finalLat != null && finalLng != null/.test(misc), 'faqat yetkazish va manzil koordinatasi bor');
  assert.ok(/\.\.\.\(deviceCheck \? \{ deviceCheck \} : \{\}\)/.test(misc), 'bo\'lmasa maydon yozilmaydi');
  const bot = readFileSync(new URL('../src/services/restaurantBotOrders.js', import.meta.url), 'utf8');
  assert.ok(bot.includes("order.deviceCheck?.status === 'far'") && bot.includes('formatMeters(order.deviceCheck.distanceM)'));
});
