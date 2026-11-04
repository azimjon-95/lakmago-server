/*
 * KURYER ILOVASI ↔ LOKMAGO QUTISI (services/courierApp.js): ilova ko'radigan takliflar, qabul qilish, faol buyurtma,
 * "Taomni oldim" → "Topshirdim", tarix/hisobot, smena himoyasi, joylashuv → trek. Mobil ilova shu API bilan ishlaydi.
 * Baza YO'Q — tests/helpers/fakeModel.mjs. npm run test:courier-app-pool
 */
process.env.JWT_SECRET = 'x'.repeat(40);
import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose, { Types } from 'mongoose';
import { bindModel } from './helpers/fakeModel.mjs';
mongoose.set('bufferCommands', false);

const M = (n) => import(`../src/models/${n}.js`);
const { Order } = await M('Order'); const { CourierAccount } = await M('CourierAccount'); const { CourierShift } = await M('CourierShift');
const { DeliveryAssignment } = await M('DeliveryAssignment'); const { Restaurant } = await M('Restaurant'); const { Ledger } = await M('Ledger');
const { CourierEvent } = await M('CourierEvent'); const { CourierTrackPoint } = await M('CourierTrackPoint'); const { Settings } = await M('Settings');
const presence = await import('../src/services/courierPresence.js'); presence._useRedisForTest(false);
const app = await import('../src/services/courierApp.js');
const { config } = await import('../src/config/index.js');
const { computeOrderFinance, somToTiyin } = await import('../src/services/orderFinance.js');
const { applyDeliveryParty } = await import('../src/services/deliveryParty.js');
const T = await import('../src/services/courierTrack.js');

Settings.findOne = async () => ({ courier: { commissionPercent: 10, debtLimitSom: 500000, maxActiveOrders: 1 } });
const orders = bindModel(Order, { docs: [] }); const accs = bindModel(CourierAccount, { docs: [] }); const shifts = bindModel(CourierShift, { docs: [] });
const assigns = bindModel(DeliveryAssignment, { docs: [] }); const rests = bindModel(Restaurant, { docs: [] });
const ledgerRows = []; Ledger.insertMany = async (r) => { ledgerRows.push(...r); return r; };
Ledger.aggregate = async ([m]) => { const t = ledgerRows.filter((r) => String(r.courierId) === String(m.$match.courierId)).reduce((s, r) => s + r.amount, 0); return t ? [{ _id: null, total: t }] : []; };
const events = []; CourierEvent.create = async (d) => { events.push(d); return d; };
const track = []; CourierTrackPoint.create = async (d) => { track.push(d); return d; };

const id = () => new Types.ObjectId();
const R = id();
const REST = { lat: 40.87, lng: 71.11 }; const CUST = { lat: 40.88, lng: 71.12 };
const fin = (cash = true) => applyDeliveryParty(computeOrderFinance({ foodBaseTiyin: somToTiyin(100000), deliveryFeeTiyin: somToTiyin(30000), customerFeePercent: 3, restaurantCommissionPercent: 10, paymentFeePercent: cash ? 0 : 1.5 }), { party: 'lokma', percent: 10 });
const mkOrder = (over = {}) => { const o = { _id: id(), restaurantId: R, restaurantName: 'Osh markazi', status: 'ready', fulfillment: 'delivery', courierParty: 'lokma', district: 'pop', paymentMethod: 'cash', dailyNumber: 21,
  address: 'Pop, Navbahor 5', addressNote: '2-qavat', phone: '+998901112233', comment: 'Ziravorsiz', addressLat: CUST.lat, addressLng: CUST.lng, userId: null,
  items: [{ name: 'Osh', quantity: 2 }, { name: 'Choy', quantity: 1 }], finance: fin(true), lokmaCourier: { courierId: null, claimedAt: null, pickedUpAt: null, settledAt: null }, ...over }; orders.docs.push(o); return o; };
const mkAcc = (over = {}) => { const a = { _id: id(), name: 'Ali', phone: '+998901', vehicle: 'moto', isActive: true, activeShiftId: null, workDistricts: ['pop'], debtLimitSom: null, tokenVersion: 0, ...over }; accs.docs.push(a); return a; };
const reset = () => { for (const s of [orders, accs, shifts, assigns, rests]) s.docs.length = 0; ledgerRows.length = 0; events.length = 0; track.length = 0; };
const setup = () => { reset(); rests.docs.push({ _id: R, name: 'Osh markazi', address: 'Pop, Markaz', phone: '+998712', lat: REST.lat, lng: REST.lng, courierMode: 'lokma' }); };
const startShift = async (a) => { const sh = { _id: id(), accountId: a._id, startedAt: new Date(), deliveries: 0, distanceM: 0 }; shifts.docs.push(sh); a.activeShiftId = sh._id; return sh; };
const at = (p, d = 0) => ({ lat: p.lat + d, lng: p.lng });
const put = (a, p) => presence.setLocation(String(a._id), { ...p, ts: Date.now() });

test('takliflar: smenada emas — bo\'sh; smenada — quti, ilova shaklida; kuryer haqi, naqd, tuman; mijoz ma\'lumoti YO\'Q', async () => {
  setup();
  const a = mkAcc();
  // Haqiqiy bazada listPool restoranni populate qiladi; soxta bazada populate yo'q — shu shaklni o'zimiz beramiz
  mkOrder({ restaurantId: { _id: R, name: 'Osh markazi', address: 'Pop, Markaz', lat: REST.lat, lng: REST.lng } });
  assert.deepEqual(await app.listOffers(a._id), [], 'smenada emas');
  await startShift(a); await put(a, at(REST, 0.0004));
  const offers = await app.listOffers(a._id);
  assert.equal(offers.length, 1);
  const o = offers[0];
  assert.equal(o.kind, 'pool'); assert.equal(o.orderCode, '21', 'ilova o\'zi "#" qo\'yadi — serverda faqat raqam'); assert.equal(o.restaurantName, 'Osh markazi');
  assert.equal(o.deliveryFee, 27000, 'ilovadagi "yetkazish haqi" = KURYER ulushi'); assert.equal(o.collectAmount, 133000); assert.equal(o.isPaid, false);
  assert.equal(o.itemsSummary, '2× Osh, 1× Choy'); assert.equal(o.addressLabel, 'Pop tumani');
  assert.ok(o.distanceM > 0 && o.distanceM < 100);
  const js = JSON.stringify(offers);
  assert.ok(!js.includes('Navbahor') && !js.includes('998901112233') && !js.includes('Ziravorsiz'), 'mijoz manzili/telefoni/izohi taklifda yo\'q');
});

test('HAVOLA oqimi (eski) takliflari LokmaGo kuryeriga standart holda KO\'RINMAYDI; bayroq bilan ko\'rinadi', async () => {
  setup();
  const a = mkAcc(); await startShift(a); await put(a, at(REST));
  const o = mkOrder({ courierParty: 'restaurant' });
  assigns.docs.push({ _id: id(), orderId: o._id, status: 'searching', token: 't', createdAt: new Date(), deliverySnapshot: { restaurantName: 'X', restaurantLat: REST.lat, restaurantLng: REST.lng, deliveryFee: 12000 } });
  assert.equal((await app.listOffers(a._id)).length, 0);
  config.courierLegacyOffers = true;
  try { assert.equal((await app.listOffers(a._id)).length, 1); } finally { config.courierLegacyOffers = false; }
});

test('qabul: to\'liq ma\'lumot (mijoz manzili, telefoni), "taomni olishga boryapti"; ikkinchi kuryer — RACE_LOST; smenasiz — 409', async () => {
  setup();
  const a = mkAcc(); const b = mkAcc({ name: 'Vali' }); const o = mkOrder();
  assert.equal((await app.acceptOffer(a, String(o._id))).status, 409, 'smenasiz');
  await startShift(a); await startShift(b);
  const r = await app.acceptOffer(a, String(o._id));
  assert.equal(r.ok, true);
  assert.equal(r.active.stage, 'to_restaurant'); assert.equal(r.active.canPickup, true); assert.equal(r.active.canDeliver, false);
  assert.equal(r.active.customerPhone, '+998901112233'); assert.equal(r.active.addressLabel, 'Pop, Navbahor 5'); assert.equal(r.active.note, 'Ziravorsiz');
  assert.equal(r.active.collectAmount, 133000); assert.equal(r.active.deliveryFee, 27000);
  assert.equal(o.courierName, 'Ali', 'restoran panelida "Kuryer: Ali"');
  const lost = await app.acceptOffer(b, String(o._id));
  assert.equal(lost.ok, false); assert.equal(lost.status, 409); assert.equal(lost.code, 'RACE_LOST');
});

test('TO\'LIQ OQIM: olish → taomni oldim → topshirdim; smenani faol buyurtmada yakunlab bo\'lmaydi; hisob-kitob, tarix, hisobot', async () => {
  setup();
  const a = mkAcc(); const sh = await startShift(a); const o = mkOrder();
  await put(a, at(REST, 0.0003));
  await app.acceptOffer(a, String(o._id));
  assert.equal((await app.endShift(a._id)).status, 409, 'faol buyurtma bor — smenani yakunlab bo\'lmaydi');
  assert.equal((await app.deliverActive(a)).ok, false, '"oldim"siz topshirib bo\'lmaydi');

  const pk = await app.pickupActive(a);
  assert.equal(pk.ok, true); assert.equal(pk.active.stage, 'to_customer'); assert.equal(pk.active.canDeliver, true);
  assert.equal(pk.check.flagged, false);
  assert.equal((await app.pickupActive(a)).already, true);

  await put(a, at(CUST, 0.0004));
  const dv = await app.deliverActive(a);
  assert.equal(dv.ok, true); assert.equal(dv.check.flagged, false);
  assert.equal(orders.docs[0].status, 'delivered');
  assert.equal(shifts.docs.find((x) => x._id === sh._id).deliveries, 1, 'smenadagi yetkazishlar soni');
  assert.equal(await app.activeNow(a._id), null);

  // Kuryer balansi (Ledger): naqd → −jami + ulush
  assert.deepEqual(ledgerRows.map((r) => [r.type, r.amount]), [['courier_cash', -133000], ['courier_earning', 27000]]);
  const w = await app.walletOf(a);
  assert.equal(w.balanceSom, -106000, 'qo\'lida 106 000 LokmaGo puli');
  assert.equal(w.cashRoomSom, 394000);

  const h = await app.history(a._id);
  assert.equal(h.length, 1); assert.equal(h[0].deliveryFee, 27000); assert.equal(h[0].collectAmount, 133000); assert.equal(h[0].orderCode, '21');
  const st = await app.stats(a._id);
  assert.equal(st.today.deliveries, 1); assert.equal(st.today.deliveryFees, 27000);
  assert.equal((await app.endShift(a._id)).onShift, false, 'topshirgach smenani yakunlash mumkin');
  assert.deepEqual(events.map((e) => e.type), ['claimed', 'picked_up', 'delivered']);
});

test('birinchi faol buyurtma bor ekan, yana qabul qilib bo\'lmaydi (bir vaqtda 1 ta — ilova hozircha bitta ko\'rsatadi)', async () => {
  setup();
  const a = mkAcc(); await startShift(a);
  const o1 = mkOrder(); const o2 = mkOrder({ dailyNumber: 22 });
  assert.equal((await app.acceptOffer(a, String(o1._id))).ok, true);
  const r = await app.acceptOffer(a, String(o2._id));
  assert.equal(r.ok, false); assert.equal(r.code, 'ACTIVE_LIMIT');
});

test('naqd chegarasi: ilova tushunarli xato oladi (DEBT_LIMIT + summalar)', async () => {
  setup();
  const a = mkAcc({ debtLimitSom: 50000 }); await startShift(a); const o = mkOrder();
  const r = await app.acceptOffer(a, String(o._id));
  assert.equal(r.ok, false); assert.equal(r.code, 'DEBT_LIMIT'); assert.equal(r.limitSom, 50000); assert.equal(r.afterSom, -106000);
});

test('JOYLASHUV: smenasiz rad etiladi; smenada trekka yoziladi (faol buyurtma ID si bilan); mijozga 150 m qolganda "yetib keldi"', async () => {
  setup(); T._resetTrackCache();
  const a = mkAcc();
  assert.equal((await app.recordLocation(a, { ...REST })).ok, false, 'smenasiz');
  await startShift(a); a.activeShiftId = shifts.docs[0]._id;
  const o = mkOrder({ status: 'delivering', lokmaCourier: { courierId: a._id, claimedAt: new Date(), pickedUpAt: new Date(), settledAt: null } });
  assert.equal((await app.recordLocation(a, { ...at(REST, 0.001), accuracy: 10 })).ok, true);
  assert.equal(await presence.getLocation(String(a._id)).then((l) => Boolean(l)), true, 'Redis/xotira: oxirgi nuqta');
  await new Promise((r) => setImmediate(r));
  assert.ok(track.length >= 1 && String(track[0].orderId) === String(o._id), 'trek nuqtasi buyurtma bilan bog\'langan');
  assert.equal(o.arrivedAt, undefined, 'hali uzoq');
  await app.recordLocation(a, { ...at(CUST, 0.0004) });
  assert.ok(o.arrivedAt instanceof Date, 'mijozga ~40 m — "yetib keldi"');
});

test('bloklangan kuryer akkaunti: smena yopiladi (controller) — xizmat darajasida endShift auto', async () => {
  setup();
  const a = mkAcc(); await startShift(a); await put(a, at(REST));
  const r = await app.endShift(a._id, 'auto');          // faol buyurtma bo'lsa ham "auto" yopadi (bloklash)
  assert.equal(r.onShift, false);
  assert.equal(await presence.getLocation(String(a._id)), null, 'joylashuv tozalandi');
});
