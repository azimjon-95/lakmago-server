import { Types } from 'mongoose';
import { Order } from '../models/Order.js';
import { CourierAccount } from '../models/CourierAccount.js';
import { Ledger } from '../models/Ledger.js';
import { Restaurant } from '../models/Restaurant.js';
import { getSettings } from '../models/Settings.js';
import { config } from '../config/index.js';
import { getIO } from '../sockets/io.js';
import { applyDeliveryParty, courierSettlement, cashExposure, courierPercentFor, courierModeOf, PARTIES } from './deliveryParty.js';
import { reconcile, tiyinToSom } from './orderFinance.js';
import { haversineMeters } from './courierDispatch.js';
import { getLocation } from './courierPresence.js';
import { recordEvent, proximity } from './courierTrack.js';

/*
 * ═══════════════════════════════════════════════════════════════
 * LOKMAGO KURYERLARI: UMUMIY QUTI ("kim ulgursa — o'sha oladi")
 * ═══════════════════════════════════════════════════════════════
 *
 * Kuryer = CourierAccount (mobil ilovaga login/parol bilan kiradigan akkaunt, services/courierApp.js). "Ishdaman" = ochiq SMENA.
 *
 * Buyurtma qutiga tushadi: courierParty = 'lokma', kuryer YO'Q, holat accepted|preparing|ready (restoran qabul qilgan), yetkazib berish.
 *
 * KIM KO'RADI (visibility):
 *   • restoranga kuryer BIRIKTIRILGAN bo'lsa (Restaurant.exclusiveCouriers) — buyurtmani FAQAT shu kuryerlar ko'radi va oladi;
 *     biriktirilgan kuryer uchun tuman cheklovi yo'q (qayerda bo'lsa ham o'z restoranini oladi);
 *   • biriktirilmagan restoranning buyurtmasini — ish tumanlari (workDistricts) mos hamma smenadagi kuryer.
 *
 * OLISH (claim) — BITTA atomik MongoDB amali: filtrda "kuryer hali yo'q" sharti bor. Ikki kuryer bir oniyda bossa faqat
 * birinchisi o'tadi. Cheklovlar: smenada bo'lish, bir vaqtdagi buyurtmalar ≤ maxActiveOrders, NAQD buyurtmada qo'lidagi LokmaGo puli chegarasi.
 *
 * NAZORAT (services/courierTrack.js): olish / "taomni oldim" / "topshirdim" — har biri kuryerning o'sha paytdagi joylashuvi va
 * maqsadgacha masofa bilan yoziladi; uzoqdan bosilsa belgilanadi (yoki COURIER_ENFORCE_PROXIMITY=1 da bloklanadi).
 * Mijoz manzili/telefoni qutida KO'RINMAYDI — faqat olgandan keyin.
 *
 * Holat o'zgarishi (oldim/topshirdim) — services/orderFlow.changeOrderStatus({ courierId }) orqali: mijoz xabari, restoran boti,
 * admin paneli va hisob-kitob (billing.settleOrder → settleCourier) BIR joydan ishlaydi.
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
const onShift = (c) => Boolean(c?.activeShiftId);

/* ───────────── ko'rinish (kim qaysi buyurtmani ko'radi) ───────────── */

/**
 * Kuryer uchun restoran filtri: { bound: [kuryer biriktirilgan restoranlar], excluded: [boshqa kuryerlarga biriktirilganlar] }.
 * Bitta yengil so'rov (faqat biriktirilgan restoranlar).
 */
export async function restaurantVisibility(courierId) {
  const cid = String(courierId);
  const rows = await Restaurant.find({ 'exclusiveCouriers.0': { $exists: true } }).select('exclusiveCouriers').lean();
  const bound = []; const excluded = [];
  for (const r of rows) {
    if ((r.exclusiveCouriers || []).some((x) => String(x) === cid)) bound.push(r._id); else excluded.push(r._id);
  }
  return { bound, excluded };
}

/** Qutidagi buyurtmalar filtri (sof): kuryerning tumanlari + biriktirilgan restoranlar − boshqaga biriktirilganlar. */
export function poolQuery({ districts = [], bound = [], excluded = [] } = {}) {
  const q = {
    courierParty: 'lokma',
    'lokmaCourier.courierId': null,
    fulfillment: 'delivery',
    status: { $in: POOL_STATUSES },
    $or: [{ district: { $in: districts } }, ...(bound.length ? [{ restaurantId: { $in: bound } }] : [])],
  };
  if (excluded.length) q.restaurantId = { $nin: excluded };
  return q;
}

export const itemsSummary = (items = []) => items.map((i) => `${i.quantity}× ${i.name}`).join(', ');

/** Qutidagi karta (sof): mijozning aniq manzili/telefoni YO'Q — faqat tuman. */
export function poolCard(o, courierLoc = null) {
  const r = o.restaurantId && typeof o.restaurantId === 'object' ? o.restaurantId : {};
  const f = o.finance || {};
  const hasRest = Number.isFinite(r.lat) && Number.isFinite(r.lng);
  const distanceKm = hasRest && Number.isFinite(o.addressLat)
    ? Math.round((haversineMeters({ lat: r.lat, lng: r.lng }, { lat: o.addressLat, lng: o.addressLng }) / 1000) * 10) / 10
    : null;
  return {
    id: String(o._id),
    number: o.dailyNumber ?? null,
    status: o.status,
    district: o.district,
    restaurant: { name: r.name || o.restaurantName || '', address: r.address || '', lat: r.lat ?? null, lng: r.lng ?? null },
    distanceKm,                                                     // restorandan mijozgacha (to'g'ri chiziq)
    distanceToRestaurantM: courierLoc && hasRest ? Math.round(haversineMeters(courierLoc, { lat: r.lat, lng: r.lng })) : null,
    paymentMethod: o.paymentMethod,
    cashToCollectSom: o.paymentMethod === 'cash' ? tiyinToSom(f.totalCharged) : 0,
    earningSom: tiyinToSom(f.courierPayout),
    freeDelivery: Boolean(f.freeDeliveryByLokma),
    itemsCount: (o.items || []).reduce((s, it) => s + (Number(it.quantity) || 0), 0),
    itemsSummary: itemsSummary(o.items),
    readyAt: o.readyAt || null,
    acceptedAt: o.acceptedAt || null,
    createdAt: o.createdAt || null,
  };
}

/* ───────────── balans (Ledger) ───────────── */

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

/* ───────────── quti ro'yxati va faol buyurtmalar ───────────── */

const POOL_SELECT = 'dailyNumber status district restaurantId restaurantName paymentMethod finance items addressLat addressLng readyAt acceptedAt createdAt';

/** Kuryer ko'ra oladigan quti (tuman + biriktirilgan restoranlar). Eng yaqin restoran birinchi. */
export async function listPool(courier, { limit = 50 } = {}) {
  const vis = await restaurantVisibility(courier._id);
  const districts = courier?.workDistricts || [];
  if (!districts.length && !vis.bound.length) return [];
  const rows = await Order.find(poolQuery({ districts, bound: vis.bound, excluded: vis.excluded }))
    .sort({ readyAt: -1, acceptedAt: 1, createdAt: 1 })
    .limit(Math.min(100, Math.max(1, limit)))
    .select(POOL_SELECT)
    .populate('restaurantId', 'name address lat lng')
    .lean();
  const loc = courier?._id ? await getLocation(String(courier._id)).catch(() => null) : null;
  return rows.map((o) => poolCard(o, loc)).sort((a, b) => (a.distanceToRestaurantM ?? 1e9) - (b.distanceToRestaurantM ?? 1e9));
}

/** Admin: qutidagi (hali olinmagan) BARCHA LokmaGo buyurtmalari, ixtiyoriy tuman bo'yicha. */
export async function listPoolForAdmin({ districts = null, limit = 100 } = {}) {
  const q = {
    courierParty: 'lokma', 'lokmaCourier.courierId': null, fulfillment: 'delivery', status: { $in: POOL_STATUSES },
    ...(Array.isArray(districts) && districts.length ? { district: { $in: districts } } : {}),
  };
  const rows = await Order.find(q).sort({ acceptedAt: 1, createdAt: 1 }).limit(Math.min(200, limit)).select(POOL_SELECT)
    .populate('restaurantId', 'name address lat lng').lean();
  return rows.map((o) => poolCard(o));
}

/** Kuryerning faol buyurtmalari — TO'LIQ ma'lumot (olgani uchun): manzil, telefon, izoh. */
export async function myActiveOrders(courierId) {
  return Order.find({ 'lokmaCourier.courierId': oid(courierId), status: { $in: ACTIVE_STATUSES } })
    .sort({ 'lokmaCourier.claimedAt': 1 })
    .select('dailyNumber status district restaurantId restaurantName paymentMethod finance items address addressLat addressLng addressNote phone comment readyAt acceptedAt lokmaCourier userId')
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

/* ───────────── olish / qaytarish ───────────── */

export async function claimOrder(courierId, orderId) {
  const courier = await CourierAccount.findById(courierId).select('isActive activeShiftId workDistricts debtLimitSom').lean();
  if (!courier || !courier.isActive) throw new CourierPoolError('COURIER_INACTIVE', 'Akkaunt faol emas', 403);
  if (!onShift(courier)) throw new CourierPoolError('OFFLINE', 'Avval «Ishni boshladim» ni bosing');

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

  // Restoranga kuryer biriktirilganmi? Biriktirilgan bo'lsa — faqat shular; biriktirilgan kuryer tumandan qat'i nazar oladi.
  const vis = await restaurantVisibility(courierId);
  const rid = String(order.restaurantId);
  if (vis.excluded.some((x) => String(x) === rid)) {
    throw new CourierPoolError('NOT_YOUR_RESTAURANT', 'Bu restoranning buyurtmalarini faqat unga biriktirilgan kuryerlar tashiydi', 403);
  }
  const isBound = vis.bound.some((x) => String(x) === rid);
  if (!isBound && !(courier.workDistricts || []).includes(order.district)) {
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
  // ATOMIK: filtrda "kuryer hali yo'q" sharti — poyga holatida faqat bittasi o'tadi
  const won = await Order.findOneAndUpdate(
    { _id: order._id, courierParty: 'lokma', 'lokmaCourier.courierId': null, fulfillment: 'delivery', status: { $in: POOL_STATUSES } },
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

  recordEvent({ order: won, courierId, type: 'claimed' }).catch(() => {});
  emitPool(won.district, 'pool:taken', { orderId: String(won._id) });
  emitOrder(won, { _id: won._id, lokmaCourier: won.lokmaCourier, courierParty: 'lokma' });
  return { order: won, already: false };
}

/** Olib ketishdan OLDIN qaytarish — buyurtma qutiga qaytadi. */
export async function releaseOrder(courierId, orderId, { byAdmin = false, adminId = '' } = {}) {
  const filter = { _id: orderId, 'lokmaCourier.pickedUpAt': null, status: { $in: POOL_STATUSES } };
  if (!byAdmin) filter['lokmaCourier.courierId'] = oid(courierId);
  else filter['lokmaCourier.courierId'] = { $ne: null };
  const prev = await Order.findOneAndUpdate(
    filter,
    { $set: { 'lokmaCourier.courierId': null, 'lokmaCourier.claimedAt': null }, $inc: { 'lokmaCourier.releasedCount': 1 } },
    { new: false },
  ).lean();
  if (!prev) throw new CourierPoolError('CANNOT_RELEASE', 'Buyurtmani qaytarib bo‘lmaydi (olingan yoki yakunlangan)');
  recordEvent({ order: prev, courierId: prev.lokmaCourier.courierId, type: byAdmin ? 'admin_released' : 'released', by: String(adminId || '') }).catch(() => {});
  emitPool(prev.district, 'pool:new', { orderId: String(prev._id) });
  emitOrder(prev, { _id: prev._id, lokmaCourier: { ...prev.lokmaCourier, courierId: null, claimedAt: null } });
  getIO()?.to(`courier:${prev.lokmaCourier.courierId}`).emit('courier:order', { _id: prev._id, released: true, byAdmin });
  return { ok: true };
}

/** Admin: buyurtmani aniq kuryerga biriktirish (tuman/restoran cheklovlari admin uchun yo'q; kuryer faol bo'lishi shart). */
export async function adminAssign(orderId, courierId, { adminId = '' } = {}) {
  const courier = await CourierAccount.findById(courierId).select('isActive').lean();
  if (!courier || !courier.isActive) throw new CourierPoolError('COURIER_INACTIVE', 'Kuryer faol emas', 400);
  const won = await Order.findOneAndUpdate(
    { _id: orderId, courierParty: 'lokma', fulfillment: 'delivery', status: { $in: POOL_STATUSES }, 'lokmaCourier.courierId': null },
    { $set: { 'lokmaCourier.courierId': oid(courierId), 'lokmaCourier.claimedAt': new Date() } },
    { new: true },
  ).lean();
  if (!won) throw new CourierPoolError('NOT_IN_POOL', 'Buyurtma qutida emas yoki allaqachon olingan');
  recordEvent({ order: won, courierId, type: 'admin_assigned', by: String(adminId || '') }).catch(() => {});
  emitPool(won.district, 'pool:taken', { orderId: String(won._id) });
  emitOrder(won, { _id: won._id, lokmaCourier: won.lokmaCourier });
  return won;
}

/* ───────────── «Taomni oldim» / «Topshirdim» (joylashuv nazorati bilan) ───────────── */

/** Kuryerga biriktirilgan buyurtma + restoran nuqtasi (alohida so'rov: restoran o'chirilgan/populate bo'lmasa ham yiqilmaydi). */
async function loadOwned(courierId, orderId) {
  const order = await Order.findOne({ _id: orderId, 'lokmaCourier.courierId': oid(courierId) })
    .select('restaurantId status district addressLat addressLng lokmaCourier courierParty paymentMethod finance').lean();
  if (!order) throw new CourierPoolError('NOT_FOUND', 'Buyurtma topilmadi yoki sizga biriktirilmagan', 404);
  order.restaurant = await Restaurant.findById(order.restaurantId).select('name lat lng').lean().catch(() => null);
  return order;
}

function enforce(check, what) {
  if (config.courierEnforceProximity && check.flagged) {
    const msg = check.flagReason === 'no_location' || check.flagReason === 'stale_location'
      ? 'Joylashuvingiz aniqlanmadi — GPS yoqilganini tekshiring'
      : `Siz ${what}dan ${check.targetDistanceM} m uzoqdasiz`;
    throw new CourierPoolError('TOO_FAR', msg, 409, { targetDistanceM: check.targetDistanceM, flagReason: check.flagReason });
  }
}

async function currentLoc(courierId, override) {
  if (override && Number.isFinite(Number(override.lat)) && Number.isFinite(Number(override.lng))) {
    return { lat: Number(override.lat), lng: Number(override.lng), ts: Date.now() };
  }
  return getLocation(String(courierId)).catch(() => null);
}

/**
 * «Taomni oldim»: restoranda ekanini tekshiradi (radius), holatni «Tayyor» → «Yo'lda» ga o'tkazadi (changeOrderStatus), voqeani yozadi.
 * `override` — ilova yuborgan joylashuv {lat,lng,accuracy} (bo'lmasa serverdagi oxirgi nuqta).
 */
export async function pickupOrder(courierId, orderId, { override = null, actorName = '' } = {}) {
  const { changeOrderStatus } = await import('./orderFlow.js');
  const order = await loadOwned(courierId, orderId);
  if (order.lokmaCourier?.pickedUpAt && order.status === 'delivering') return { ok: true, already: true };
  const r = order.restaurant || {};
  const target = Number.isFinite(r.lat) && Number.isFinite(r.lng) ? { lat: r.lat, lng: r.lng } : null;
  enforce(proximity({ loc: await currentLoc(courierId, override), target, radiusM: config.courierPickupRadiusM }), 'restoran');

  const rid = order.restaurantId;
  if (['accepted', 'preparing'].includes(order.status)) {
    await changeOrderStatus({ orderId: order._id, restaurantId: rid, status: 'ready', actorName });
  }
  await changeOrderStatus({ orderId: order._id, restaurantId: rid, status: 'delivering', actorName, courierId });
  const check = await recordEvent({ order, courierId, type: 'picked_up', target, radiusM: config.courierPickupRadiusM, override });
  return { ok: true, already: false, check };
}

/** «Topshirdim»: mijoz manziliga yaqinligini tekshiradi, holat «Yetkazildi» (hisob-kitob shu yerdan), voqeani yozadi. */
export async function deliverOrder(courierId, orderId, { override = null, actorName = '' } = {}) {
  const { changeOrderStatus } = await import('./orderFlow.js');
  const order = await loadOwned(courierId, orderId);
  if (order.status === 'delivered') return { ok: true, changed: false };
  if (order.status !== 'delivering') throw new CourierPoolError('NOT_PICKED_UP', 'Avval «Taomni oldim» ni bosing', 409);
  const target = Number.isFinite(order.addressLat) && Number.isFinite(order.addressLng) ? { lat: order.addressLat, lng: order.addressLng } : null;
  enforce(proximity({ loc: await currentLoc(courierId, override), target, radiusM: config.courierDeliverRadiusM }), 'mijoz manzili');

  const rid = order.restaurantId;
  const { changed } = await changeOrderStatus({ orderId: order._id, restaurantId: rid, status: 'delivered', actorName, courierId });
  const check = await recordEvent({ order, courierId, type: 'delivered', target, radiusM: config.courierDeliverRadiusM, override });
  return { ok: true, changed, check };
}

/* ───────────── 'both' rejimi: restoran tanlovi ───────────── */

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

/* ───────────── hisob-kitob (kuryer balansi) ───────────── */

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
