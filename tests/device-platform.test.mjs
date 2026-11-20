/*
 * Android push ro'yxati: platform maydoni yo'q bo'lsa ham qabul (eski APK'lar standart qiymatni yubormagan). npm run test:device-platform
 * Bazasiz: controllerlar haqiqiy, faqat yozuv soxtalashtirilgan (tekshiruv yozuvdan OLDIN).
 */
// Calls the REAL controllers with the exact bodies the Android app sends; the DB write is stubbed (validation happens before it).
process.env.JWT_SECRET = 'x'.repeat(40);
const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const { MobileDevice } = await import(root + '/src/models/MobileDevice.js');
const { CourierDevice } = await import(root + '/src/models/CourierDevice.js');
const writes = [];
MobileDevice.findOneAndUpdate = async (q, u) => { writes.push(['restaurant', u.$set.platform]); return null; };
CourierDevice.findOneAndUpdate = async (q, u) => { writes.push(['courier', u.$set.platform]); return null; };
const { mobileDevicesController } = await import(root + '/src/controllers/mobileDevices.js');
const { courierAppController } = await import(root + '/src/controllers/courierApp.js');
const call = (fn, req) => new Promise((resolve, reject) => {
  const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; resolve(this); return this; }, end() { resolve(this); return this; } };
  fn(req, res, (e) => (e ? reject(e) : resolve(res)));
});
const T = 'fcmTokenXXXXXXXXXXXXXXXXXXXX:C4DXdl';
const cases = [
  ['restaurant, app body BEFORE fix (no platform)', mobileDevicesController.register, { restaurantId: 'r1', body: { token: T, deviceId: 'uuid-1', appVersion: '1.0.0', notificationsEnabled: true } }],
  ['restaurant, app body AFTER fix', mobileDevicesController.register, { restaurantId: 'r1', body: { token: T, platform: 'android', deviceId: 'uuid-1', appVersion: '1.0.0', notificationsEnabled: true } }],
  ['restaurant, iOS body', mobileDevicesController.register, { restaurantId: 'r1', body: { token: 'a'.repeat(64), platform: 'ios', environment: 'production' } }],
  ['restaurant, bad platform', mobileDevicesController.register, { restaurantId: 'r1', body: { token: T, platform: 'windows' } }],
  ['courier, app body BEFORE fix (no platform)', courierAppController.registerDevice, { courierId: 'c1', body: { token: T, appVersion: '1.0.0' } }],
];
const expect = [204, 204, 204, 400, 204];
let fails = 0;
for (const [i, [name, fn, req]] of cases.entries()) {
  const r = await call(fn, req);
  const ok = r.statusCode === expect[i];
  if (!ok) fails++;
  console.log(`${ok ? '  ✓' : '  ✗ FAIL:'} ${r.statusCode} ${name}${r.body?.error ? '  → ' + r.body.error + ' ' + JSON.stringify(r.body.fields || []) : ''}`);
}
const stored = JSON.stringify(writes);
const okStored = stored === JSON.stringify([['restaurant', 'android'], ['restaurant', 'android'], ['restaurant', 'ios'], ['courier', 'android']]);
if (!okStored) fails++;
console.log(`${okStored ? '  ✓' : '  ✗ FAIL:'} platform yo'q bo'lsa 'android' saqlanadi, iOS o'zgarmaydi: ${stored}`);
console.log(fails ? `\n✗ ${fails} ta xato` : '\n✓ hammasi o\'tdi');
process.exit(fails ? 1 : 0);
