import { Types } from 'mongoose';
import { Order } from '../models/Order.js';
import { Courier } from '../models/Courier.js';
import { Ledger } from '../models/Ledger.js';
import { Restaurant } from '../models/Restaurant.js';
import { getSettings } from '../models/Settings.js';
import { getIO } from '../sockets/io.js';
import { applyDeliveryParty, courierSettlement, cashExposure, courierPercentFor, courierModeOf, PARTIES } from './deliveryParty.js';
import { reconcile, tiyinToSom } from './orderFinance.js';
import { haversineKm } from './deliveryEngine.js';

/*
 * ═══════════════════════════════════════════════════════════════
 * LOKMAGO KURYERLARI: UMUMIY QUTI ("kim ulgursa — o'sha oladi")
 * ═══════════════════════════════════════════════════════════════
 *
 * Buyurtma qutiga tushadi: courierParty = 'lokma', kuryer YO'Q, holat accepted|preparing|ready (restoran qabul qilgan),
 * yetkazib berish. Kuryer faqat O'Z TUMANLARIDAGI (workDistricts) buyurtmalarni ko'radi.
 *
 * OLISH (claim) — BITTA atomik MongoDB amali: filtrda "kuryer hali yo'q" sharti bor. Ikki kuryer bir oniyda bossa,
 * faqat birinchisi o'tadi, ikkinchisi "boshqa kuryer oldi" javobini oladi (qulf/tranzaksiya kerak emas).
 *
 * Cheklovlar (claim'dan oldin):
 *   • kuryer "Ishdaman" (isOnline) holatida;
 *   • bir vaqtda faol buyurtmalar ≤ Settings.courier.maxActiveOrders (poyga holatida ham — keyin qayta tekshiriladi);
 *   • NAQD buyurtma: qo'lidagi LokmaGo puli (qarz) chegaradan oshmasin (Courier.debtLimitSom ?? Settings.courier.debtLimitSom).
 *
 * Mijoz manzili va telefoni QUTIDA KO'RINMAYDI — faqat olgandan keyin (havola oqimidagi qoida bilan bir xil).
 * Holat o'zgarishlari (oldim/topshirdim) — services/orderFlow.changeOrderStatus({ courierId }) orqali: mijoz xabari,
 * restoran boti, admin paneli va hisob-kitob (billing.settleOrder → settleCourier) BIR joydan ishlaydi.
 */

export const POOL_STATUSES = ['accepted', 'preparing', 'ready'];
export const ACTIVE_STATUSES = ['accepted', 'preparing', 'ready', 'delivering'];

export class CourierPoolError extends Error {
  constructor(code, message, status = 409, extra = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.extra = extra;
  }
}

const oid = (v) => (v instanceof Types.ObjectId ? v : new Types.ObjectId(String(v)));
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** Qutidagi buyurtmalar filtri (sof). districts bo'sh → hech narsa (kuryer avval tuman tanlaydi). */
export function poolQuery(districts) {
  return {
    courierParty: 'lokma',
    'lokmaCourier.courierId': null,
    fulfillment: 'delivery',
    status: { $in: POOL_STATUSES },
    district: { $in: Array.isArray(districts) ? districts : [] },
  };
}

/** Qutidagi karta (sof): mijozning aniq manzili/telefoni YO'Q. */
export function poolCard(o) {
  const r = o.restaurantId && typeof o.restaurantId === 'object' ? o.restaurantId : {};
  const f = o.finance || {};
  const distanceKm = Number.isFinite(r.lat) && Number.isFinite(o.addressLat)
    ? Math.round(haversineKm({ lat: r.lat, lng: r.lng }, { lat: o.addressLat, lng: o.addressLng }) * 10) / 10
    : null;
  return {
    id: String(o._id),
    number: o.dailyNumber ?? null,
    status: o.status,
    district: o.district,
    restaurant: { name: r.name || '', address: r.address || '', lat: r.lat ?? null, lng: r.lng ?? null },
    distanceKm,                                                     // restorandan mijozgacha (to'g'ri chiziq)
    paymentMethod: o.paymentMethod,
    cashToCollectSom: o.paymentMethod === 'cash' ? tiyinToSom(f.totalCharged) : 0,
    earningSom: tiyinToSom(f.courierPayout),
    freeDelivery: Boolean(f.freeDeliveryByLokma),
    itemsCount: (o.items || []).reduce((s, it) => s + (Number(it.quantity) || 0), 0),
    readyAt: o.readyAt || null,
    acceptedAt: o.acceptedAt || null,
  };
}

/** Kuryer balansi (so'm): musbat — LokmaGo qarzdor, manfiy — kuryer qo'lidagi LokmaGo puli. Yagona manba — Ledger. */
export async function courierBalanceSom(courierId) {
  const [row] = await Ledger.aggregate([
    { $match: { courierId: oid(courierId) } },
    { $group: { _id: null, total: { $sum: '$amount' } } },
  ]);
  return round2(row?.total);
}

/** Olingan, lekin hali topshirilmagan NAQD buyurtmalar bo'yicha kuryer qo'liga tushadigan LokmaGo puli (so'm). */
export async function openCashExposureSom(courierId) {
  const open = await Order.find({ 'lokmaCourier.courierId': oid(courierId), status: { $in: ACTIVE_STATUSES }, paymentMethod: 'cash' })
    .select('finance paymentMethod').lean();
  return round2(open.reduce((s, o) => s + tiyinToSom(cashExposure(o.finance, 'cash')), 0));
}

export async function debtLimitFor(courier) {
  if (courier?.debtLimitSom !== null && courier?.debtLimitSom !== undefined) return Number(courier.debtLimitSom) || 0;
  const s = await getSettings();
  return Number(s?.courier?.debtLimitSom ?? 500000);
}

export async function listPool(courier, { limit = 50 } = {}) {
  const districts = courier?.workDistricts || [];
  if (!districts.length) return [];
  const rows = await Order.find(poolQuery(districts))
    .sort({ readyAt: -1, acceptedAt: 1, createdAt: 1 })
    .limit(Math.min(100, Math.max(1, limit)))
    .select('dailyNumber status district restaurantId paymentMethod finance items addressLat addressLng readyAt acceptedAt')
    .populate('restaurantId', 'name address lat lng')
    .lean();
  return rows.map(poolCard);
}

/** Kuryerning faol buyurtmalari — TO'LIQ ma'lumot (olgani uchun): manzil, telefon, izoh. */
export async function myActiveOrders(courierId) {
  return Order.find({ 'lokmaCourier.courierId': oid(courierId), status: { $in: ACTIVE_STATUSES } })
    .sort({ 'lokmaCourier.claimedAt': 1 })
    .select('dailyNumber status district restaurantId paymentMethod finance items address addressLat addressLng addressNote phone comment readyAt acceptedAt lokmaCourier userId')
    .populate('restaurantId', 'name address lat lng phone')
    .populate('userId', 'firstName phone')
    .lean();
}

function emitPool(district, event, payload) {
  if (!district) return;
  getIO()?.to(`courier-district:${district}`).emit(event, payload);
}
function emitOrder(order, patch) {
  const io = getIO();
  if (!io) return;
  io.to(`restaurant:${order.restaurantId}`).emit('order:update', patch);
  io.to('admin').emit('order:update', patch);
  const cid = order.lokmaCourier?.courierId;
  if (cid) io.to(`courier:${cid}`).emit('courier:order', patch);
}

export async function claimOrder(courierId, orderId) {
  const courier = await Courier.findById(courierId).select('status isOnline workDistricts debtLimitSom').lean();
  if (!courier || courier.status !== 'active') throw new CourierPoolError('COURIER_INACTIVE', 'Akkaunt faol emas', 403);
  if (!courier.isOnline) throw new CourierPoolError('OFFLINE', 'Avval «Ishdaman» tugmasini yoqing');

  const order = await Order.findById(orderId)
    .select('status district courierParty lokmaCourier fulfillment paymentMethod finance restaurantId').lean();
  if (!order) throw new CourierPoolError('NOT_FOUND', 'Buyurtma topilmadi', 404);
  if (order.lokmaCourier?.courierId) {
    if (String(order.lokmaCourier.courierId) === String(courierId)) return { order, already: true };
    throw new CourierPoolError('RACE_LOST', 'Bu buyurtmani boshqa kuryer oldi');
  }
  if (order.courierParty !== 'lokma' || order.fulfillment !== 'delivery' || !POOL_STATUSES.includes(order.status)) {
    throw new CourierPoolError('NOT_IN_POOL', 'Buyurtma qutida emas');
  }
  if (!(courier.workDistricts || []).includes(order.district)) {
    throw new CourierPoolError('WRONG_DISTRICT', 'Bu buyurtma siz tanlagan tumanlarda emas — tumanlaringizni yangilang');
  }

  const s = await getSettings();
  const maxActive = Number(s?.courier?.maxActiveOrders) || 3;
  const active = await Order.countDocuments({ 'lokmaCourier.courierId': oid(courierId), status: { $in: ACTIVE_STATUSES } });
  if (active >= maxActive) {
    throw new CourierPoolError('ACTIVE_LIMIT', `Bir vaqtda ${maxActive} tadan ortiq buyurtma olib bo‘lmaydi`, 409, { maxActive });
  }

  if (order.paymentMethod === 'cash') {
    const [balance, open, limit] = await Promise.all([courierBalanceSom(courierId), openCashExposureSom(courierId), debtLimitFor(courier)]);
    const after = round2(balance - open - tiyinToSom(cashExposure(order.finance, 'cash')));
    if (after < -limit) {
      throw new CourierPoolError('DEBT_LIMIT', 'Qo‘lingizdagi naqd chegaradan oshadi — avval pulni topshiring', 409, {
        balanceSom: balance, openCashSom: open, limitSom: limit, afterSom: after,
      });
    }
  }

  const now = new Date();
  const won = await Order.findOneAndUpdate(
    { _id: order._id, ...poolQuery([order.district]) },
    { $set: { 'lokmaCourier.courierId': oid(courierId), 'lokmaCourier.claimedAt': now } },
    { new: true },
  ).lean();
  if (!won) throw new CourierPoolError('RACE_LOST', 'Bu buyurtmani boshqa kuryer oldi');

  // Poyga: bir kuryer bir oniyda bir nechta buyurtmani bossa — limitdan oshgani qaytariladi
  const after = await Order.countDocuments({ 'lokmaCourier.courierId': oid(courierId), status: { $in: ACTIVE_STATUSES } });
  if (after > maxActive) {
    await Order.updateOne({ _id: won._id, 'lokmaCourier.courierId': oid(courierId), 'lokmaCourier.pickedUpAt': null },
      { $set: { 'lokmaCourier.courierId': null, 'lokmaCourier.claimedAt': null } });
    throw new CourierPoolError('ACTIVE_LIMIT', `Bir vaqtda ${maxActive} tadan ortiq buyurtma olib bo‘lmaydi`, 409, { maxActive });
  }

  emitPool(won.district, 'pool:taken', { orderId: String(won._id) });
  emitOrder(won, { _id: won._id, lokmaCourier: won.lokmaCourier, courierParty: 'lokma' });
  return { order: won, already: false };
}

/** Olib ketishdan OLDIN qaytarish — buyurtma qutiga qaytadi. */
export async function releaseOrder(courierId, orderId, { byAdmin = false } = {}) {
  const filter = { _id: orderId, 'lokmaCourier.pickedUpAt': null, status: { $in: POOL_STATUSES } };
  if (!byAdmin) filter['lokmaCourier.courierId'] = oid(courierId);
  else filter['lokmaCourier.courierId'] = { $ne: null };
  const prev = await Order.findOneAndUpdate(
    filter,
    { $set: { 'lokmaCourier.courierId': null, 'lokmaCourier.claimedAt': null }, $inc: { 'lokmaCourier.releasedCount': 1 } },
    { new: false },
  ).lean();
  if (!prev) throw new CourierPoolError('CANNOT_RELEASE', 'Buyurtmani qaytarib bo‘lmaydi (olingan yoki yakunlangan)');
  emitPool(prev.district, 'pool:new', { orderId: String(prev._id) });
  emitOrder(prev, { _id: prev._id, lokmaCourier: { ...prev.lokmaCourier, courierId: null, claimedAt: null } });
  getIO()?.to(`courier:${prev.lokmaCourier.courierId}`).emit('courier:order', { _id: prev._id, released: true, byAdmin });
  return { ok: true };
}

/** Admin: buyurtmani aniq kuryerga biriktirish (cheklovlarsiz emas — tuman va faollik tekshiriladi). */
export async function adminAssign(orderId, courierId) {
  const courier = await Courier.findById(courierId).select('status').lean();
  if (!courier || courier.status !== 'active') throw new CourierPoolError('COURIER_INACTIVE', 'Kuryer faol emas', 400);
  const won = await Order.findOneAndUpdate(
    { _id: orderId, courierParty: 'lokma', fulfillment: 'delivery', status: { $in: POOL_STATUSES }, 'lokmaCourier.courierId': null },
    { $set: { 'lokmaCourier.courierId': oid(courierId), 'lokmaCourier.claimedAt': new Date() } },
    { new: true },
  ).lean();
  if (!won) throw new CourierPoolError('NOT_IN_POOL', 'Buyurtma qutida emas yoki allaqachon olingan');
  emitPool(won.district, 'pool:taken', { orderId: String(won._id) });
  emitOrder(won, { _id: won._id, lokmaCourier: won.lokmaCourier });
  return won;
}

/**
 * 'both' rejimidagi restoran buyurtma uchun kim yetkazishini tanlaydi. Moliya snapshot'i shunga moslab QAYTA hisoblanadi
 * (mijoz to'lovi o'zgarmaydi — faqat yetkazish puli restoran ↔ kuryer o'rtasida). Kuryer olgach o'zgartirib bo'lmaydi.
 */
export async function setOrderParty({ restaurantId, orderId, party, actor = '' }) {
  if (!PARTIES.includes(party)) throw new CourierPoolError('INVALID_PARTY', 'Noto‘g‘ri tanlov', 400);
  const rest = await Restaurant.findById(restaurantId).select('courierMode lokmaCourierPercent').lean();
  if (!rest) throw new CourierPoolError('NOT_FOUND', 'Restoran topilmadi', 404);
  if (courierModeOf(rest) !== 'both') {
    throw new CourierPoolError('MODE_LOCKED', 'Yetkazish usulini LokmaGo belgilagan — bu restoranda tanlov yo‘q', 403);
  }
  const order = await Order.findOne({ _id: orderId, restaurantId })
    .select('status fulfillment courierParty lokmaCourier finance district').lean();
  if (!order) throw new CourierPoolError('NOT_FOUND', 'Buyurtma topilmadi', 404);
  if (order.fulfillment !== 'delivery') throw new CourierPoolError('NOT_DELIVERY', 'Bu yetkazib berish buyurtmasi emas', 400);
  if (!['pending', ...POOL_STATUSES].includes(order.status)) throw new CourierPoolError('WRONG_STATE', 'Buyurtma allaqachon yo‘lda yoki yakunlangan');
  if (order.lokmaCourier?.courierId) throw new CourierPoolError('CLAIMED', 'LokmaGo kuryeri allaqachon oldi — o‘zgartirib bo‘lmaydi');
  if (order.courierParty === party) return { order, changed: false };

  let finance = order.finance;
  if (finance?.model === 'v2') {
    const s = await getSettings();
    finance = applyDeliveryParty(finance, {
      party,
      nominalDeliveryFeeTiyin: finance.nominalDeliveryFee ?? finance.deliveryFee,
      percent: courierPercentFor(rest, s),
    });
    const r = reconcile(finance);
    if (!r.ok) throw new CourierPoolError('FINANCE', `Hisob mos kelmadi (${r.diff} tiyin)`, 500);
  }
  const now = new Date();
  const updated = await Order.findOneAndUpdate(
    { _id: order._id, restaurantId, 'lokmaCourier.courierId': null, status: { $in: ['pending', ...POOL_STATUSES] } },
    { $set: { courierParty: party, finance, 'lokmaCourier.poolAt': party === 'lokma' ? now : null } },
    { new: true },
  ).lean();
  if (!updated) throw new CourierPoolError('RACE_LOST', 'Buyurtma shu oniyda o‘zgardi — qayta urinib ko‘ring');
  if (party === 'lokma' && POOL_STATUSES.includes(updated.status)) emitPool(updated.district, 'pool:new', { orderId: String(updated._id) });
  if (party === 'restaurant') emitPool(updated.district, 'pool:removed', { orderId: String(updated._id) });
  emitOrder(updated, { _id: updated._id, courierParty: party });
  console.log(`[courierPool] ${orderId}: yetkazuvchi → ${party}${actor ? ` (${actor})` : ''}`);
  return { order: updated, changed: true };
}

/**
 * Yetkazilgan LokmaGo kuryeri buyurtmasi bo'yicha kuryer balansiga yozish (billing.settleOrder ichidan chaqiriladi).
 * TAKRORLANMAYDI: `lokmaCourier.settledAt` atomik bayroq — birinchi chaqiruvchigina yozadi; xato bo'lsa bayroq qaytariladi.
 */
export async function settleCourier(orderId) {
  const o = await Order.findOneAndUpdate(
    { _id: orderId, status: 'delivered', courierParty: 'lokma', 'lokmaCourier.courierId': { $ne: null }, 'lokmaCourier.settledAt': null },
    { $set: { 'lokmaCourier.settledAt': new Date() } },
    { new: true },
  ).lean();
  if (!o) return { settled: false };
  const entries = courierSettlement(o.finance, { paymentMethod: o.paymentMethod });
  try {
    if (entries.length) {
      await Ledger.insertMany(entries.map((e) => ({
        type: e.type,
        amount: tiyinToSom(e.amount),
        orderId: o._id,
        restaurantId: o.restaurantId,
        courierId: o.lokmaCourier.courierId,
        provider: o.paymentMethod || null,
        isCash: o.paymentMethod === 'cash',
        meta: {
          note: e.type === 'courier_cash' ? 'Mijozdan naqd olindi (LokmaGo puli)' : 'Yetkazish ulushi',
          courierCommissionPercent: o.finance?.courierCommissionPercent ?? null,
          nominalDeliveryFee: tiyinToSom(o.finance?.nominalDeliveryFee),
          freeDeliveryByLokma: Boolean(o.finance?.freeDeliveryByLokma),
        },
      })));
    }
    await Courier.updateOne({ _id: o.lokmaCourier.courierId }, { $inc: { totalDeliveries: 1 } });
    return { settled: true, entries };
  } catch (e) {
    await Order.updateOne({ _id: o._id }, { $set: { 'lokmaCourier.settledAt': null } }).catch(() => {});
    throw e;
  }
}

/** orderFlow.changeOrderStatus'dan: qutiga tushish/chiqish va kuryerga xabar (await qilinmaydi). */
export function onOrderStatusChanged(order, status) {
  if (order?.courierParty !== 'lokma') return;
  const cid = order.lokmaCourier?.courierId;
  if (!cid && POOL_STATUSES.includes(status)) emitPool(order.district, 'pool:new', { orderId: String(order._id) });
  if (!cid && status === 'cancelled') emitPool(order.district, 'pool:removed', { orderId: String(order._id) });
  if (cid) getIO()?.to(`courier:${cid}`).emit('courier:order', { _id: order._id, status });
}
