/*
 * Buyurtma oqimi va LokmaGo kuryeri (services/orderFlow.changeOrderStatus({ courierId })):
 *  • "Oldim"/"Topshirdim" faqat BIRIKTIRILGAN kuryerga; kuryer yetkazishni yakunlay oladi, restoran — yo'q;
 *  • restoran LokmaGo buyurtmasini "Yo'lda" qila olmaydi (aks holda u qutidan chiqib, hech kim ololmay qolardi).
 * Baza YO'Q. npm run test:courier-flow
 */
process.env.JWT_SECRET = 'x'.repeat(40);
import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose, { Types } from 'mongoose';
// Yon ta'sirlar (bot/admin monitori) bazaga so'rov yuboradi — ulanishni 10 s kutmasin, darhol xato (ular .catch bilan ushlanadi)
mongoose.set('bufferCommands', false);
import { bindModel } from './helpers/fakeModel.mjs';

const { Order } = await import('../src/models/Order.js');
const { changeOrderStatus } = await import('../src/services/orderFlow.js');
const store = bindModel(Order, { docs: [] });
const R = new Types.ObjectId();
const K = new Types.ObjectId();
const mk = (over = {}) => {
  const o = { _id: new Types.ObjectId(), restaurantId: R, status: 'ready', fulfillment: 'delivery', courierParty: 'lokma', userId: null,
    lokmaCourier: { courierId: K, pickedUpAt: null, deliveredAt: null }, ...over };
  store.docs.push(o); return o;
};

test('begona kuryer "oldim/topshirdim" qila olmaydi; kuryer faqat delivering/delivered', async () => {
  const o = mk();
  await assert.rejects(changeOrderStatus({ orderId: o._id, restaurantId: R, status: 'delivering', courierId: new Types.ObjectId() }), (e) => e.code === 'NOT_YOURS');
  await assert.rejects(changeOrderStatus({ orderId: o._id, restaurantId: R, status: 'cancelled', courierId: K }), (e) => e.code === 'INVALID_STATUS');
  const own = mk({ courierParty: 'restaurant' });
  await assert.rejects(changeOrderStatus({ orderId: own._id, restaurantId: R, status: 'delivering', courierId: K }), (e) => e.code === 'NOT_YOURS');
});

test('restoran LokmaGo buyurtmasini "Yo\'lda" qila olmaydi (qutidan yo\'qolmasin)', async () => {
  const o = mk({ lokmaCourier: { courierId: null } });
  await assert.rejects(changeOrderStatus({ orderId: o._id, restaurantId: R, status: 'delivering' }), (e) => e.code === 'COURIER_PICKUP');
  // restoran kuryeri buyurtmasida — avvalgidek ruxsat
  const own = mk({ courierParty: 'restaurant', lokmaCourier: { courierId: null } });
  const r = await changeOrderStatus({ orderId: own._id, restaurantId: R, status: 'delivering' });
  assert.equal(r.changed, true);
});

test('biriktirilgan kuryer: oldim → delivering (+pickedUpAt), topshirdim → delivered (+deliveredAt); restoran yakunlay olmaydi', async () => {
  const o = mk();
  await assert.rejects(changeOrderStatus({ orderId: o._id, restaurantId: R, status: 'delivered' }), (e) => e.code === 'WRONG_STATE', 'restoran yetkazishni yakunlamaydi');
  const a = await changeOrderStatus({ orderId: o._id, restaurantId: R, status: 'delivering', courierId: K });
  assert.equal(a.changed, true);
  const d = store.docs.find((x) => String(x._id) === String(o._id));
  assert.equal(d.status, 'delivering');
  assert.ok(d.lokmaCourier.pickedUpAt instanceof Date);
  const b = await changeOrderStatus({ orderId: o._id, restaurantId: R, status: 'delivered', courierId: K });
  assert.equal(b.changed, true);
  assert.equal(d.status, 'delivered');
  assert.ok(d.lokmaCourier.deliveredAt instanceof Date);
  const again = await changeOrderStatus({ orderId: o._id, restaurantId: R, status: 'delivered', courierId: K });
  assert.equal(again.changed, false, 'takror bosish — xato emas, o\'zgarmaydi');
});
