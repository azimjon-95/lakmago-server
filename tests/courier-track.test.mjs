/*
 * KURYER NAZORATI (services/courierTrack.js): joylashuv tekshiruvi, trek siyraklashtirish, masofa, jonli ko'rinish, buyurtma izi.
 * Baza YO'Q — tests/helpers/fakeModel.mjs. npm run test:courier-track
 */
process.env.JWT_SECRET = 'x'.repeat(40);
import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose, { Types } from 'mongoose';
import { bindModel } from './helpers/fakeModel.mjs';
mongoose.set('bufferCommands', false);

const { CourierAccount } = await import('../src/models/CourierAccount.js');
const { CourierTrackPoint } = await import('../src/models/CourierTrackPoint.js');
const { CourierEvent } = await import('../src/models/CourierEvent.js');
const { Order } = await import('../src/models/Order.js');
const presence = await import('../src/services/courierPresence.js');
presence._useRedisForTest(false);
const T = await import('../src/services/courierTrack.js');

const id = () => new Types.ObjectId();
const REST = { lat: 40.87, lng: 71.11 }; const CUST = { lat: 40.88, lng: 71.12 };
const at = (p, dLat = 0) => ({ lat: p.lat + dLat, lng: p.lng });

test('proximity: yaqin / uzoq / eskirgan / joylashuvsiz / maqsad noma\'lum', () => {
  const now = Date.now();
  const mk = (p, ageSec = 5) => ({ ...p, ts: now - ageSec * 1000 });
  assert.deepEqual({ ...T.proximity({ loc: mk(at(REST, 0.0003)), target: REST, radiusM: 250, now }) }, { locAgeSec: 5, targetDistanceM: 33, flagged: false, flagReason: '' });
  const far = T.proximity({ loc: mk(at(REST, 0.02)), target: REST, radiusM: 250, now });
  assert.equal(far.flagged, true); assert.equal(far.flagReason, 'far'); assert.ok(far.targetDistanceM > 2000);
  assert.equal(T.proximity({ loc: mk(at(REST), 200), target: REST, radiusM: 250, now }).flagReason, 'stale_location');
  assert.equal(T.proximity({ loc: null, target: REST, radiusM: 250, now }).flagReason, 'no_location');
  const noTarget = T.proximity({ loc: mk(at(REST)), target: null, radiusM: 250, now });
  assert.equal(noTarget.flagged, false, 'maqsad koordinatasi yo\'q — tekshirib bo\'lmaydi, kuryer aybdor emas');
});

test('trek siyraklashtirish: turganda har 60 s, harakatda har ≥15 m (baza to\'lib ketmasin)', () => {
  const t0 = 1_700_000_000_000;
  const p = (dLat, sec) => ({ ...at(REST, dLat), at: t0 + sec * 1000 });
  assert.equal(T.shouldStorePoint(null, p(0, 0)), true, 'birinchi nuqta');
  assert.equal(T.shouldStorePoint(p(0, 0), p(0.00002, 5)), false, '2 m, 5 s — yozilmaydi');
  assert.equal(T.shouldStorePoint(p(0, 0), p(0.00002, 61)), true, '61 s o\'tdi — turgan bo\'lsa ham "tirikligi" yoziladi');
  assert.equal(T.shouldStorePoint(p(0, 0), p(0.0002, 5)), true, '22 m siljidi');
});

test('trek masofasi: mantiqli qadamlar yig\'iladi, GPS sakrashi (1 km 1 s ichida) hisobga olinmaydi', () => {
  const t0 = Date.parse('2026-11-05T08:00:00Z');
  const pts = [0, 0.001, 0.002, 0.2 /* sakrash */, 0.2005].map((d, i) => ({ ...at(REST, d), at: new Date(t0 + i * 10_000) }));
  const d = T.trackDistanceM(pts);
  assert.ok(d > 270 && d < 290, `111 + 111 + 55 m ≈ 277 (sakrash hisobga olinmaydi): ${d}`);
});

test('storePoint: bazaga yoziladi (siyraklashtirilgan), orderId bilan', async () => {
  T._resetTrackCache();
  const store = bindModel(CourierTrackPoint, { docs: [] });
  CourierTrackPoint.create = async (d) => { store.docs.push(d); return d; };
  const c = id(); const o = id(); const base = Date.now();
  assert.equal(await T.storePoint({ courierId: c, orderId: o, ...at(REST), at: base }), true);
  assert.equal(await T.storePoint({ courierId: c, orderId: o, ...at(REST, 0.00002), at: base + 5000 }), false);
  assert.equal(await T.storePoint({ courierId: c, orderId: o, ...at(REST, 0.001), at: base + 10_000 }), true);
  assert.equal(store.docs.length, 2);
  assert.equal(String(store.docs[0].orderId), String(o));
});

test('JONLI KO\'RINISH: smenadagi kuryer, joyi, signal holati, qaysi taom qayerdan qayerga; muammolilar tepada', async () => {
  const accs = bindModel(CourierAccount, { docs: [] });
  const orders = bindModel(Order, { docs: [] });
  const okC = { _id: id(), name: 'Ali', phone: '+998901', isActive: true, activeShiftId: id(), workDistricts: ['pop'] };
  const lostC = { _id: id(), name: 'Vali', isActive: true, activeShiftId: id(), workDistricts: ['pop'] };
  const offC = { _id: id(), name: 'Sobir', isActive: true, activeShiftId: null };
  accs.docs.push(okC, lostC, offC);
  await presence.setLocation(String(okC._id), { ...at(REST, 0.0005), ts: Date.now() - 4000, speed: 6 });
  await presence.setLocation(String(lostC._id), { ...at(REST, 0.01), ts: Date.now() - 80_000 });
  orders.docs.push({
    _id: id(), dailyNumber: 7, status: 'delivering', restaurantId: { _id: id(), name: 'Osh markazi', address: 'Pop', lat: REST.lat, lng: REST.lng },
    items: [{ name: 'Osh', quantity: 2 }, { name: 'Salat', quantity: 1 }], address: 'Navbahor 5', addressLat: CUST.lat, addressLng: CUST.lng,
    paymentMethod: 'cash', finance: { totalCharged: 13_300_000 }, lokmaCourier: { courierId: okC._id, claimedAt: new Date(), pickedUpAt: new Date() },
  });
  const live = await T.liveCouriers();
  assert.deepEqual(live.map((c) => [c.name, c.signal]), [['Vali', 'stale'], ['Ali', 'ok']], 'o\'chiq smenadagi Sobir yo\'q; signal yo\'qolgan tepada');
  const ali = live[1];
  assert.equal(ali.orders.length, 1);
  assert.equal(ali.orders[0].stage, 'to_customer', 'taom qo\'lida — mijozga ketyapti');
  assert.equal(ali.orders[0].itemsLine, '2× Osh, 1× Salat');
  assert.equal(ali.orders[0].cashToCollect, 133000);
  assert.ok(ali.orders[0].distanceToTargetM > 1300 && ali.orders[0].distanceToTargetM < 1400, `mijozgacha ~1350 m: ${ali.orders[0].distanceToTargetM}`);
  assert.equal(ali.location.speed, 6);
  assert.equal(ali.orders[0].customer.address, 'Navbahor 5', 'admin mijoz manzilini ko\'radi');
});

test('BUYURTMA IZI: voqealar tartibi, trek, masofa, shubhali bayroq', async () => {
  const orders = bindModel(Order, { docs: [] });
  const cid = id(); const oid = id(); const claimed = new Date('2026-11-05T09:00:00Z');
  orders.docs.push({
    _id: oid, dailyNumber: 3, status: 'delivered', courierParty: 'lokma', restaurantId: { _id: id(), name: 'Osh', lat: REST.lat, lng: REST.lng }, items: [{ name: 'Osh', quantity: 1 }],
    address: 'Uy', addressLat: CUST.lat, addressLng: CUST.lng, createdAt: claimed, lokmaCourier: { courierId: cid, claimedAt: claimed, deliveredAt: new Date('2026-11-05T09:30:00Z') },
  });
  bindModel(CourierAccount, { docs: [{ _id: cid, name: 'Ali', phone: '+998901' }] });
  const evs = bindModel(CourierEvent, { docs: [
    { orderId: oid, courierId: cid, type: 'claimed', at: new Date('2026-11-05T09:00:00Z'), flagged: false },
    { orderId: oid, courierId: cid, type: 'picked_up', at: new Date('2026-11-05T09:10:00Z'), flagged: true, flagReason: 'far_from_restaurant', targetDistanceM: 900 },
    { orderId: oid, courierId: cid, type: 'delivered', at: new Date('2026-11-05T09:30:00Z'), flagged: false, targetDistanceM: 40 },
  ] });
  evs.docs.sort = undefined;
  const pts = bindModel(CourierTrackPoint, { docs: [0, 0.001, 0.002].map((d, i) => ({ courierId: cid, ...at(REST, d), at: new Date(claimed.getTime() + i * 60_000) })) });
  void pts;
  const t = await T.orderTrace(oid);
  assert.equal(t.courier.name, 'Ali');
  assert.deepEqual(t.events.map((e) => e.type), ['claimed', 'picked_up', 'delivered']);
  assert.equal(t.events[1].flagReason, 'far_from_restaurant');
  assert.equal(t.flagged, true);
  assert.equal(t.points.length, 3);
  assert.ok(t.distanceM > 200);
  assert.equal(await T.orderTrace(id()), null);
});
