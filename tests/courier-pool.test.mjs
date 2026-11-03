/*
 * LokmaGo kuryerlari umumiy qutisi (services/courierPool.js): "kim ulgursa", tumanlar, limitlar, naqd chegarasi,
 * 'both' rejimida restoran tanlovi, kuryer balansiga yozish (takrorlanmaydi). Baza YO'Q — tests/helpers/fakeModel.mjs.
 * npm run test:courier-pool
 */
process.env.JWT_SECRET = 'x'.repeat(40);
import test from 'node:test';
import assert from 'node:assert/strict';
import { Types } from 'mongoose';
import { bindModel } from './helpers/fakeModel.mjs';

const { Order } = await import('../src/models/Order.js');
const { Courier } = await import('../src/models/Courier.js');
const { Ledger } = await import('../src/models/Ledger.js');
const { Restaurant } = await import('../src/models/Restaurant.js');
const { Settings } = await import('../src/models/Settings.js');
const pool = await import('../src/services/courierPool.js');
const { computeOrderFinance, reconcile, somToTiyin } = await import('../src/services/orderFinance.js');
const { applyDeliveryParty } = await import('../src/services/deliveryParty.js');

const id = () => new Types.ObjectId();
const S = somToTiyin;
const settings = { courier: { commissionPercent: 10, debtLimitSom: 500000, maxActiveOrders: 2 } };
Settings.findOne = async () => settings;

const ledgerRows = [];
Ledger.insertMany = async (rows) => { ledgerRows.push(...rows.map((r) => ({ ...r }))); return rows; };
Ledger.aggregate = async ([m]) => {
  const cid = String(m.$match.courierId);
  const total = ledgerRows.filter((r) => String(r.courierId) === cid).reduce((s, r) => s + r.amount, 0);
  return total ? [{ _id: null, total }] : [];
};
Ledger.exists = async (f) => (ledgerRows.some((r) => String(r.courierId) === String(f.courierId)) ? { _id: 1 } : null);

const REST = id();
const fin = (party, cash = true) => applyDeliveryParty(computeOrderFinance({
  foodBaseTiyin: S(100000), deliveryFeeTiyin: S(30000), customerFeePercent: 3, restaurantCommissionPercent: 10, paymentFeePercent: cash ? 0 : 1.5,
}), { party, percent: 10 });

function mkOrder(over = {}) {
  return {
    _id: id(), restaurantId: { _id: REST, name: 'Osh markazi', address: 'Pop, Markaz', lat: 40.87, lng: 71.11 }, status: 'accepted',
    fulfillment: 'delivery', courierParty: 'lokma', district: 'pop', paymentMethod: 'cash', dailyNumber: 12,
    addressLat: 40.88, addressLng: 71.12, address: 'Pop, Navbahor 5', phone: '+998901112233', items: [{ name: 'Osh', quantity: 2 }],
    lokmaCourier: { courierId: null, claimedAt: null, pickedUpAt: null, deliveredAt: null, releasedCount: 0, settledAt: null },
    finance: fin('lokma'), ...over,
  };
}
const orders = bindModel(Order, { docs: [] });
const couriers = bindModel(Courier, { docs: [] });
const rests = bindModel(Restaurant, { docs: [] });
const mkCourier = (over = {}) => { const c = { _id: id(), name: 'Ali', status: 'active', isOnline: true, workDistricts: ['pop'], debtLimitSom: null, tokenVersion: 0, ...over }; couriers.docs.push(c); return c; };
const reset = () => { orders.docs.length = 0; couriers.docs.length = 0; rests.docs.length = 0; ledgerRows.length = 0; };

test('quti: faqat o\'z tumanidagi, olinmagan, qabul qilingan buyurtmalar; mijoz manzili/telefoni KO\'RINMAYDI', async () => {
  reset();
  const c = mkCourier();
  orders.docs.push(mkOrder(), mkOrder({ district: 'chust' }), mkOrder({ status: 'pending' }), mkOrder({ courierParty: 'restaurant' }),
    mkOrder({ lokmaCourier: { courierId: id() } }), mkOrder({ fulfillment: 'pickup' }), mkOrder({ status: 'ready' }));
  const list = await pool.listPool(c);
  assert.equal(list.length, 2, 'faqat Pop, accepted/ready, LokmaGo, olinmagan, yetkazish');
  const card = list[0];
  assert.equal(card.earningSom, 27000);
  assert.equal(card.cashToCollectSom, 133000, 'naqd: taom 100 000 + xizmat 3% + yetkazish 30 000');
  assert.ok(card.distanceKm > 0);
  const json = JSON.stringify(list);
  assert.ok(!json.includes('+998901112233') && !json.includes('Navbahor'), 'telefon va aniq manzil qutida yo\'q');
  assert.deepEqual(await pool.listPool({ workDistricts: [] }), [], 'tuman tanlanmagan — bo\'sh');
});

test('kim ulgursa: ikkinchi kuryer "boshqa kuryer oldi" oladi; birinchisi takror bossa — xato emas', async () => {
  reset();
  const a = mkCourier({ name: 'A' }); const b = mkCourier({ name: 'B' });
  const o = mkOrder(); orders.docs.push(o);
  const r1 = await pool.claimOrder(a._id, o._id);
  assert.equal(r1.already, false);
  await assert.rejects(pool.claimOrder(b._id, o._id), (e) => e.code === 'RACE_LOST');
  assert.equal((await pool.claimOrder(a._id, o._id)).already, true);
  assert.equal(String(orders.docs[0].lokmaCourier.courierId), String(a._id));
});

test('cheklovlar: oflayn, boshqa tuman, qutida emas, bloklangan', async () => {
  reset();
  const off = mkCourier({ isOnline: false }); const chust = mkCourier({ workDistricts: ['chust'] }); const blocked = mkCourier({ status: 'blocked' });
  const o = mkOrder(); const own = mkOrder({ courierParty: 'restaurant' }); orders.docs.push(o, own);
  await assert.rejects(pool.claimOrder(off._id, o._id), (e) => e.code === 'OFFLINE');
  await assert.rejects(pool.claimOrder(chust._id, o._id), (e) => e.code === 'WRONG_DISTRICT');
  await assert.rejects(pool.claimOrder(blocked._id, o._id), (e) => e.code === 'COURIER_INACTIVE');
  const ok = mkCourier();
  await assert.rejects(pool.claimOrder(ok._id, own._id), (e) => e.code === 'NOT_IN_POOL');
});

test('Chust tumaniga ham: kuryer tumanlarini qo\'shsa — u yerdagi buyurtmani ham oladi', async () => {
  reset();
  const c = mkCourier({ workDistricts: ['pop', 'chust'] });
  const o = mkOrder({ district: 'chust' }); orders.docs.push(o);
  assert.equal((await pool.listPool(c)).length, 1);
  assert.equal((await pool.claimOrder(c._id, o._id)).already, false);
});

test('bir vaqtdagi buyurtmalar limiti (maxActiveOrders = 2)', async () => {
  reset();
  const c = mkCourier();
  const os = [mkOrder({ paymentMethod: 'click', finance: fin('lokma', false) }), mkOrder({ paymentMethod: 'click', finance: fin('lokma', false) }), mkOrder({ paymentMethod: 'click', finance: fin('lokma', false) })];
  orders.docs.push(...os);
  await pool.claimOrder(c._id, os[0]._id);
  await pool.claimOrder(c._id, os[1]._id);
  await assert.rejects(pool.claimOrder(c._id, os[2]._id), (e) => e.code === 'ACTIVE_LIMIT' && e.extra.maxActive === 2);
});

test('naqd chegarasi: qo\'lidagi LokmaGo puli 500 000 dan oshsa — naqd buyurtma olinmaydi, karta olinadi', async () => {
  reset();
  const c = mkCourier();
  // Avvalgi qarz: 400 000 (topshirilmagan naqd)
  ledgerRows.push({ courierId: c._id, amount: -400000, type: 'courier_cash' });
  const cash = mkOrder(); const card = mkOrder({ paymentMethod: 'click', finance: fin('lokma', false) });
  orders.docs.push(cash, card);
  // naqd: 133 000 − 27 000 = 106 000 qo'shimcha → −506 000 < −500 000
  await assert.rejects(pool.claimOrder(c._id, cash._id), (e) => e.code === 'DEBT_LIMIT' && e.extra.afterSom === -506000 && e.extra.limitSom === 500000);
  assert.equal((await pool.claimOrder(c._id, card._id)).already, false, 'karta buyurtmasi qarzni oshirmaydi');
  // Kuryerga alohida chegara
  c.debtLimitSom = 600000;
  assert.equal((await pool.claimOrder(c._id, cash._id)).already, false);
});

test('qaytarish (release): faqat olishdan oldin; qutiga qaytadi, boshqa kuryer oladi', async () => {
  reset();
  const a = mkCourier(); const b = mkCourier();
  const o = mkOrder(); orders.docs.push(o);
  await pool.claimOrder(a._id, o._id);
  await assert.rejects(pool.releaseOrder(b._id, o._id), (e) => e.code === 'CANNOT_RELEASE', 'begona kuryer qaytara olmaydi');
  await pool.releaseOrder(a._id, o._id);
  assert.equal(orders.docs[0].lokmaCourier.courierId, null);
  assert.equal(orders.docs[0].lokmaCourier.releasedCount, 1);
  await pool.claimOrder(b._id, o._id);
  orders.docs[0].lokmaCourier.pickedUpAt = new Date(); orders.docs[0].status = 'delivering';
  await assert.rejects(pool.releaseOrder(b._id, o._id), (e) => e.code === 'CANNOT_RELEASE', 'olingandan keyin qaytarib bo\'lmaydi');
});

test('"both" rejimi: restoran tanlaydi, moliya qayta hisoblanadi (rekonsiliatsiya), kuryer olgach o\'zgarmaydi', async () => {
  reset();
  rests.docs.push({ _id: REST, courierMode: 'both', lokmaCourierPercent: null });
  const o = mkOrder({ restaurantId: REST, courierParty: null, finance: fin(null) });
  orders.docs.push(o);
  const r = await pool.setOrderParty({ restaurantId: REST, orderId: o._id, party: 'lokma' });
  assert.equal(r.changed, true);
  const f = orders.docs[0].finance;
  assert.equal(f.courierParty, 'lokma');
  assert.equal(f.courierPayout, S(27000));
  assert.equal(f.restaurantDeliveryPayout, 0);
  assert.ok(reconcile(f).ok);
  // qaytadan o'zi yetkazaman
  await pool.setOrderParty({ restaurantId: REST, orderId: o._id, party: 'restaurant' });
  assert.equal(orders.docs[0].finance.restaurantDeliveryPayout, S(30000));
  assert.equal(orders.docs[0].finance.courierPayout, 0);
  // LokmaGo, kuryer oldi → o'zgartirib bo'lmaydi
  await pool.setOrderParty({ restaurantId: REST, orderId: o._id, party: 'lokma' });
  const c = mkCourier(); await pool.claimOrder(c._id, o._id);
  await assert.rejects(pool.setOrderParty({ restaurantId: REST, orderId: o._id, party: 'restaurant' }), (e) => e.code === 'CLAIMED');
});

test('restoran rejimi admin tomonidan qat\'iy (own/lokma) bo\'lsa — restoran tanlay olmaydi', async () => {
  reset();
  rests.docs.push({ _id: REST, courierMode: 'lokma' });
  const o = mkOrder({ restaurantId: REST }); orders.docs.push(o);
  await assert.rejects(pool.setOrderParty({ restaurantId: REST, orderId: o._id, party: 'restaurant' }), (e) => e.code === 'MODE_LOCKED' && e.status === 403);
  await assert.rejects(pool.setOrderParty({ restaurantId: REST, orderId: o._id, party: 'boshqa' }), (e) => e.code === 'INVALID_PARTY');
});

test('kuryer balansi: naqd → −jami +ulush, karta → +ulush; IKKI MARTA yozilmaydi', async () => {
  reset();
  const c = mkCourier();
  const cash = mkOrder({ status: 'delivered', lokmaCourier: { courierId: c._id, settledAt: null } });
  const card = mkOrder({ status: 'delivered', paymentMethod: 'click', finance: fin('lokma', false), lokmaCourier: { courierId: c._id, settledAt: null } });
  orders.docs.push(cash, card);
  assert.equal((await pool.settleCourier(cash._id)).settled, true);
  assert.equal((await pool.settleCourier(cash._id)).settled, false, 'takror chaqiruv yozmaydi');
  await pool.settleCourier(card._id);
  const amounts = ledgerRows.map((r) => [r.type, r.amount]);
  assert.deepEqual(amounts, [['courier_cash', -133000], ['courier_earning', 27000], ['courier_earning', 27000]]);
  assert.equal(await pool.courierBalanceSom(c._id), -79000, 'qo\'lida 106 000 LokmaGo puli, kartadan 27 000 haqi');
  assert.ok(orders.docs.every((o) => o.lokmaCourier.settledAt));
  // Restoran kuryeri buyurtmasi kuryer balansiga tegmaydi
  const own = mkOrder({ status: 'delivered', courierParty: 'restaurant', finance: fin('restaurant'), lokmaCourier: { courierId: c._id, settledAt: null } });
  orders.docs.push(own);
  assert.equal((await pool.settleCourier(own._id)).settled, false);
});

test('ledger yozuvi xato bersa — bayroq qaytariladi (keyinroq qayta yoziladi, pul yo\'qolmaydi)', async () => {
  reset();
  const c = mkCourier();
  const o = mkOrder({ status: 'delivered', lokmaCourier: { courierId: c._id, settledAt: null } }); orders.docs.push(o);
  const orig = Ledger.insertMany;
  Ledger.insertMany = async () => { throw new Error('db yiqildi'); };
  await assert.rejects(pool.settleCourier(o._id), /db yiqildi/);
  assert.equal(orders.docs[0].lokmaCourier.settledAt, null);
  Ledger.insertMany = orig;
  assert.equal((await pool.settleCourier(o._id)).settled, true);
});

test('admin biriktirish va majburiy qaytarish', async () => {
  reset();
  const c = mkCourier({ isOnline: false, workDistricts: [] });   // admin oflayn kuryerga ham bera oladi
  const o = mkOrder(); orders.docs.push(o);
  await pool.adminAssign(o._id, c._id);
  assert.equal(String(orders.docs[0].lokmaCourier.courierId), String(c._id));
  await pool.releaseOrder(null, o._id, { byAdmin: true });
  assert.equal(orders.docs[0].lokmaCourier.courierId, null);
  await assert.rejects(pool.adminAssign(o._id, mkCourier({ status: 'blocked' })._id), (e) => e.code === 'COURIER_INACTIVE');
});

test('BIR VAQTDA: 5 kuryer bir oniyda bossa — faqat BITTASI oladi (atomik filtr)', async () => {
  reset();
  const cs = [1, 2, 3, 4, 5].map((i) => mkCourier({ name: `K${i}` }));
  const o = mkOrder({ paymentMethod: 'click', finance: fin('lokma', false) }); orders.docs.push(o);
  const r = await Promise.allSettled(cs.map((c) => pool.claimOrder(c._id, o._id)));
  const won = r.filter((x) => x.status === 'fulfilled' && !x.value.already);
  assert.equal(won.length, 1, `g'oliblar: ${won.length}`);
  assert.equal(r.filter((x) => x.status === 'rejected' && x.reason.code === 'RACE_LOST').length, 4);
});
