/*
 * ILOVA KANALI, KANAL SHARTLI SOVG'A, AKSIYA AUDITORIYASI, ILOVA VERSIYASI (2026-11-24)
 * npm run test:app-channel   (DB qismi: TEST_MONGO_URI, standart mongodb://127.0.0.1:27018/)
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { readClient, channelMatches, compareVersions, deviceFingerprint, normalizeVersion } from '../src/services/clientChannel.js';
import { audienceMatches, sanitizePromo, publicView } from '../src/services/promoModals.js';
import { sanitizeGift, scopeMatches, limitsBlock, resolveGifts, quoteGifts, invalidateGiftCache } from '../src/services/giftBonus.js';
import { sanitizeAppConfig, publicAppConfig } from '../src/controllers/appConfig.js';

const req = (h = {}) => ({ get: (n) => h[n.toLowerCase()] });

test('readClient: kanal, versiya, qurilma izi; header yo‘q — noma‘lum', () => {
  const ios = readClient(req({ 'x-lokma-client': 'iOS', 'x-lokma-app-version': '1.4.0', 'x-lokma-device': 'ABCDEF12-3456-7890' }));
  assert.equal(ios.channel, 'ios');
  assert.equal(ios.appVersion, '1.4.0');
  assert.match(ios.deviceId, /^[a-f0-9]{32}$/, 'xom ID emas — sha256 izi');
  assert.notEqual(ios.deviceId, 'ABCDEF12-3456-7890');
  assert.equal(ios.deviceId, readClient(req({ 'x-lokma-client': 'ios', 'x-lokma-device': 'ABCDEF12-3456-7890' })).deviceId, 'barqaror');

  const web = readClient(req({ 'x-lokma-client': 'web', 'x-lokma-app-version': '9.9', 'x-lokma-device': 'ABCDEF12-3456-7890' }));
  assert.deepEqual(web, { channel: 'web', appVersion: '', deviceId: '' }, 'saytda versiya/qurilma olinmaydi');
  assert.deepEqual(readClient(req({})), { channel: null, appVersion: '', deviceId: '' }, 'eski ilova — noma‘lum');
  assert.equal(readClient(req({ 'x-lokma-client': 'hacker' })).channel, null);
  assert.equal(readClient(req({ 'x-lokma-client': 'android', 'x-lokma-device': '<script>' })).deviceId, '', 'yaroqsiz ID — bo‘sh');
  assert.equal(normalizeVersion('1.2.3-beta'), '');
  assert.equal(deviceFingerprint('short'), '');
});

test('channelMatches / compareVersions', () => {
  assert.ok(channelMatches([], null), 'bo‘sh ro‘yxat — hamma, noma‘lum ham');
  assert.ok(channelMatches(['app'], 'ios') && channelMatches(['app'], 'android'));
  assert.ok(!channelMatches(['app'], 'web') && !channelMatches(['app'], 'telegram') && !channelMatches(['app'], null));
  assert.ok(channelMatches(['telegram', 'web'], 'web'));
  assert.equal(compareVersions('1.10.0', '1.9'), 1);
  assert.equal(compareVersions('1.2', '1.2.0'), 0);
  assert.equal(compareVersions('1.0.9', '1.1'), -1);
});

test('Aksiya oynasi auditoriyasi: "ilovani yuklab oling" ilova ichida chiqmaydi', () => {
  assert.ok(audienceMatches('all', null));
  assert.ok(audienceMatches('not_app', 'web') && audienceMatches('not_app', 'telegram'));
  assert.ok(!audienceMatches('not_app', 'ios') && !audienceMatches('not_app', 'android'));
  assert.ok(!audienceMatches('not_app', null), 'eski native ilova (header yo‘q) — taklif ko‘rmaydi');
  assert.ok(audienceMatches('app', 'android') && !audienceMatches('app', 'web'));
  const ok = sanitizePromo({ title: 'Ilovada Cola tekin', audience: 'not_app', cta: 'install_app' });
  assert.equal(ok.error, undefined);
  assert.equal(ok.data.audience, 'not_app');
  assert.equal(ok.data.cta, 'install_app');
  assert.ok(sanitizePromo({ title: 'Salom dunyo', audience: 'app', cta: 'install_app' }).error, 'ilovaga ilovani taklif qilib bo‘lmaydi');
  assert.equal(sanitizePromo({ title: 'Salom dunyo', audience: 'xxx', cta: 'zzz' }).data.audience, 'all');
  const v = publicView({ _id: 'a', title: 't', template: 'brush', audience: 'not_app', cta: 'install_app' });
  assert.equal(v.cta, 'install_app');
});

test('Sovg‘a: kanal va qurilma sharti', () => {
  const { data, error } = sanitizeGift({ name: 'Ilova Cola', itemName: '1 l Coca-Cola', channels: ['app', 'zzz'], perDeviceTotal: 1, perCustomerTotal: 1 });
  assert.equal(error, undefined);
  assert.deepEqual(data.channels, ['app']);
  assert.equal(data.perDeviceTotal, 1);

  const rule = { scope: 'all', kinds: ['restaurant'], fulfillments: ['delivery', 'pickup'], paymentMethods: [], channels: ['app'], perDeviceTotal: 1 };
  const base = { restaurantId: 'r', restaurantKind: 'restaurant', fulfillment: 'delivery' };
  assert.ok(scopeMatches(rule, { ...base, channel: 'ios', deviceId: 'd1' }));
  assert.ok(!scopeMatches(rule, { ...base, channel: 'web', deviceId: '' }), 'sayt — yo‘q');
  assert.ok(!scopeMatches(rule, { ...base, channel: null, deviceId: '' }), 'eski ilova — yo‘q');
  assert.ok(!scopeMatches(rule, { ...base, channel: 'android', deviceId: '' }), 'qurilma ID siz — yo‘q');
  assert.equal(limitsBlock(rule, { deviceTotal: 1 }), 'device_total');
  assert.equal(limitsBlock(rule, { deviceTotal: 0 }), null);
  assert.ok(scopeMatches({ ...rule, channels: [], perDeviceTotal: 0 }, { ...base, channel: null }), 'kanalsiz qoida — avvalgidek hammaga');
});

test('Ilova versiyasi sozlamasi', () => {
  assert.ok(sanitizeAppConfig({ iosMinVersion: '1.x' }).error);
  assert.ok(sanitizeAppConfig({ iosStoreUrl: 'https://evil.com/app' }).error, 'faqat apps.apple.com');
  assert.ok(sanitizeAppConfig({ androidStoreUrl: 'http://play.google.com/store/apps/details?id=lokma.uz' }).error, 'faqat https');
  const ok = sanitizeAppConfig({ iosMinVersion: '1.2.0', androidMinVersion: '', iosStoreUrl: 'https://apps.apple.com/uz/app/lokma-go/id1234567890', updatePromptDays: 99 });
  assert.equal(ok.error, undefined);
  assert.equal(ok.data.updatePromptDays, 30);
  const pub = publicAppConfig({ iosMinVersion: '1.2.0', iosStoreUrl: 'https://apps.apple.com/uz/app/x/id1' });
  assert.equal(pub.ios.minVersion, '1.2.0');
  assert.equal(pub.android.minVersion, '');
  assert.match(pub.android.storeUrl, /id=lokma\.uz$/);
});

/* ─── Bazada: haqiqiy sovg'a hisobi ─── */
const URI = process.env.TEST_MONGO_URI || 'mongodb://127.0.0.1:27018/';
let GiftBonus; let Order; let R;
before(async () => {
  await mongoose.connect(URI, { dbName: 'test_app_channel' });
  await mongoose.connection.db.dropDatabase();
  ({ GiftBonus } = await import('../src/models/GiftBonus.js'));
  ({ Order } = await import('../src/models/Order.js'));
  R = { _id: new mongoose.Types.ObjectId(), kind: 'restaurant' };
  await GiftBonus.create({
    name: 'Ilovada birinchi buyurtma', itemName: '1 l Coca-Cola', quantity: 1, reimburse: 12000, minAmount: 50000,
    active: true, channels: ['app'], perCustomerTotal: 1, perDeviceTotal: 1,
  });
  invalidateGiftCache();
});
after(async () => { await mongoose.connection.db.dropDatabase(); await mongoose.disconnect(); });

test('resolveGifts: faqat ilovada, mijozga 1 marta, QURILMAGA 1 marta', async () => {
  const u1 = new mongoose.Types.ObjectId();
  const u2 = new mongoose.Types.ObjectId();
  const dev = deviceFingerprint('IOS-DEVICE-0001');
  const args = { restaurant: R, menuAmount: 80000, paidAmount: 80000, fulfillment: 'delivery', paymentMethod: 'cash' };

  assert.equal((await resolveGifts({ ...args, userId: u1, channel: 'web' })).items.length, 0, 'sayt — sovg‘a yo‘q');
  assert.equal((await resolveGifts({ ...args, userId: u1, channel: 'telegram' })).items.length, 0, 'Telegram — yo‘q');
  assert.equal((await resolveGifts({ ...args, userId: u1, channel: null })).items.length, 0, 'eski ilova — yo‘q');

  const first = await resolveGifts({ ...args, userId: u1, channel: 'ios', deviceId: dev });
  assert.equal(first.items.length, 1, 'ilovada — Cola');
  assert.equal(first.cost, 12000, 'LokmaGo restoranga qoplaydi');
  await Order.collection.insertOne({ userId: u1, restaurantId: R._id, status: 'pending', bonusItems: first.items, bonusCost: first.cost, clientChannel: 'ios', clientDevice: dev, createdAt: new Date() });

  assert.equal((await resolveGifts({ ...args, userId: u1, channel: 'ios', deviceId: deviceFingerprint('OTHER-DEVICE-02') })).items.length, 0, 'shu mijoz boshqa telefonda — yo‘q (mijozga 1 marta)');
  assert.equal((await resolveGifts({ ...args, userId: u2, channel: 'ios', deviceId: dev })).items.length, 0, 'shu telefonda boshqa akkaunt — yo‘q (qurilmaga 1 marta)');
  assert.equal((await resolveGifts({ ...args, userId: u2, channel: 'android', deviceId: deviceFingerprint('ANDROID-DEV-03') })).items.length, 1, 'yangi mijoz yangi telefonda — bor');

  const q = await quoteGifts({ groups: [{ restaurantId: R._id, restaurantKind: 'restaurant', menuAmount: 30000, paidAmount: 30000 }], userId: u2, fulfillment: 'delivery', paymentMethod: 'cash', channel: 'android', deviceId: deviceFingerprint('ANDROID-DEV-03') });
  assert.equal(q[0].next?.missing, 20000, 'savatda: "yana 20 000 so‘m — Cola tekin"');
  const qWeb = await quoteGifts({ groups: [{ restaurantId: R._id, restaurantKind: 'restaurant', menuAmount: 30000, paidAmount: 30000 }], userId: u2, fulfillment: 'delivery', paymentMethod: 'cash', channel: 'web' });
  assert.equal(qWeb[0].next, null, 'saytda ilova sovg‘asi va’dasi ko‘rsatilmaydi');
});
