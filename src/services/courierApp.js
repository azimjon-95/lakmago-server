import { CourierAccount } from '../models/CourierAccount.js';
import { CourierShift } from '../models/CourierShift.js';
import { DeliveryAssignment } from '../models/DeliveryAssignment.js';
import { Order } from '../models/Order.js';
import { config } from '../config/index.js';
import { acceptShare, deliverShare, haversineMeters, applyAssignmentLocation } from './courierDispatch.js';
import { setLocation, getLocation, clearLocation } from './courierPresence.js';
import {
  CourierPoolError, listPool, claimOrder, myActiveOrders, pickupOrder, deliverOrder, courierBalanceSom, openCashExposureSom, debtLimitFor,
  ACTIVE_STATUSES,
} from './courierPool.js';
import { storePoint } from './courierTrack.js';
import { districtLabel } from '../constants/districts.js';
import { tiyinToSom } from './orderFinance.js';

/**
 * KURYER ILOVASI — biznes mantiq. Ikki xil ish manbai YONMA-YON ishlaydi:
 *
 *   1. LOKMAGO QUTISI (asosiy, 2026-11): restoran rejimi 'lokma'/'both' → buyurtma Order sifatida umumiy qutiga tushadi
 *      (services/courierPool.js). Kuryer ro'yxatda ko'radi, "Olaman", "Taomni oldim", "Topshirdim". Pul — kuryer balansiga (Ledger).
 *   2. HAVOLA oqimi (Bosqich 1, eski): restoranning O'Z kuryeri havola orqali (DeliveryAssignment: acceptShare / deliverShare).
 *      LokmaGo kuryeriga bu takliflar FAQAT config.courierLegacyOffers yoqilganda ko'rsatiladi (standart: o'chiq — yetkazish puli
 *      restoranniki bo'lgan buyurtma LokmaGo kuryeriga tushib qolmasin).
 *
 * Bu fayl: kimligini (akkaunt), smenani, joylashuvni va ilovada ko'rinadigan ma'lumotni boshqaradi. Holat o'zgarishi va hisob-kitob
 * MAVJUD, sinalgan funksiyalar orqali (orderFlow.changeOrderStatus, billing.settleOrder) — bu yerda qayta yozilmagan.
 */
const OPEN_ORDER = ['accepted', 'preparing', 'ready'];            // acceptShare ham aynan shularni kutadi
const BOUNDS = { lat: [36, 46], lng: [55, 74] };                    // O'zbekiston va qo'shni hududlar (updateCourierLocation bilan bir xil)
const ARRIVED_M = 150;                                              // mijoz manziliga shuncha qolganda "yetib keldi"

const poolErr = (e) => ({ ok: false, status: e.status || 409, error: e.message, code: e.code, ...e.extra });
const isPool = (id) => Order.exists({ _id: id, courierParty: 'lokma' });

/* ───────────── smena ───────────── */

export async function shiftState(accountId) {
  const acc = await CourierAccount.findById(accountId).select('activeShiftId').lean();
  const shift = acc?.activeShiftId ? await CourierShift.findById(acc.activeShiftId).lean() : null;
  const active = await activeAny(accountId);
  return { onShift: !!shift, shift: shift && { id: String(shift._id), startedAt: shift.startedAt, deliveries: shift.deliveries, distanceM: Math.round(shift.distanceM) }, activeAssignmentId: active ? String(active.id) : null };
}

/** «Ishni boshladim». Idempotent: allaqachon ochiq bo'lsa o'shani qaytaradi. */
export async function startShift(accountId) {
  const cur = await CourierAccount.findById(accountId).select('activeShiftId').lean();
  if (cur?.activeShiftId) return { ok: true, already: true, ...(await shiftState(accountId)) };
  const shift = await CourierShift.create({ accountId, startedAt: new Date() });
  // ATOMIK egallash: ikki qurilma bir vaqtda «boshladim» bossa faqat bittasi smena ochadi
  const claimed = await CourierAccount.findOneAndUpdate({ _id: accountId, activeShiftId: null }, { $set: { activeShiftId: shift._id } }, { new: true });
  if (!claimed) { await CourierShift.deleteOne({ _id: shift._id }); return { ok: true, already: true, ...(await shiftState(accountId)) }; }
  return { ok: true, ...(await shiftState(accountId)) };
}

/** «Ishni yakunladim». Faol buyurtma bo'lsa — rad etiladi (avval topshiring). */
export async function endShift(accountId, reason = 'courier') {
  const acc = await CourierAccount.findById(accountId).select('activeShiftId').lean();
  if (!acc?.activeShiftId) return { ok: true, already: true, onShift: false };
  if (reason === 'courier' && await activeAny(accountId)) return { ok: false, status: 409, error: 'Avval olingan buyurtmani topshiring' };
  await CourierShift.updateOne({ _id: acc.activeShiftId }, { $set: { endedAt: new Date(), endReason: reason } });
  await CourierAccount.updateOne({ _id: accountId }, { $set: { activeShiftId: null } });
  await clearLocation(accountId);
  return { ok: true, onShift: false };
}

/** Unutilgan smenalarni yopadi (timer, ~10 daqiqada bir marta). */
export async function closeStaleShifts(now = Date.now()) {
  const cutoff = new Date(now - config.courierShiftAutoCloseH * 3600_000);
  const stale = await CourierShift.find({ endedAt: null, startedAt: { $lt: cutoff } }).select('_id accountId').lean();
  for (const s of stale) {
    await CourierShift.updateOne({ _id: s._id, endedAt: null }, { $set: { endedAt: new Date(now), endReason: 'auto' } });
    await CourierAccount.updateOne({ _id: s.accountId, activeShiftId: s._id }, { $set: { activeShiftId: null } });
    await clearLocation(s.accountId);
  }
  return stale.length;
}

/* ───────────── joylashuv (har ~5 s) ───────────── */

const lastDbWrite = new Map();      // accountId → ms (smena ma'lumotini bazaga har ~30 s da yozamiz, har 5 s da emas)

export async function recordLocation(account, raw) {
  if (!account.activeShiftId) return { ok: false, status: 409, error: 'Avval «Ishni boshladim» ni bosing' };
  const lat = Number(raw.lat), lng = Number(raw.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < BOUNDS.lat[0] || lat > BOUNDS.lat[1] || lng < BOUNDS.lng[0] || lng > BOUNDS.lng[1]) {
    return { ok: false, status: 400, error: 'Joylashuv noto‘g‘ri' };
  }
  const accuracy = Number.isFinite(Number(raw.accuracy)) ? Math.min(5000, Math.max(0, Number(raw.accuracy))) : undefined;
  const speed = Number.isFinite(Number(raw.speed)) ? Math.max(0, Number(raw.speed)) : undefined;
  const heading = Number.isFinite(Number(raw.heading)) ? ((Number(raw.heading) % 360) + 360) % 360 : undefined;
  const id = String(account._id);
  const prev = await getLocation(id);
  const now = Date.now();                                        // vaqt SERVERniki: telefon soati noto'g'ri bo'lsa ham «eskirgan» bo'lib qolmaydi
  const store = await setLocation(id, { lat, lng, accuracy, speed, heading, ts: now });

  // Bosib o'tilgan masofa: faqat aniq va mantiqli sakrashlar (GPS «sakrashi» yig'indini buzmasin)
  let add = 0;
  if (prev && now - prev.ts <= 60_000 && (accuracy === undefined || accuracy <= 100)) {
    const d = haversineMeters(prev, { lat, lng });
    if (d >= 3 && d <= 800) add = d;
  }
  if (now - (lastDbWrite.get(id) || 0) >= 30_000) {
    lastDbWrite.set(id, now);
    await CourierShift.updateOne({ _id: account.activeShiftId }, { $set: { lastLoc: { lat, lng, at: new Date(now) } }, ...(add ? { $inc: { distanceM: add } } : {}) }).catch(() => {});
  } else if (add) {
    await CourierShift.updateOne({ _id: account.activeShiftId }, { $inc: { distanceM: add } }).catch(() => {});
  }
  // Faol buyurtma: havola oqimi (DeliveryAssignment.location → mijoz kuzatuvi) yoki LokmaGo qutisi (Order)
  const active = await activeAssignment(id);
  if (active) await applyAssignmentLocation(active._id, { lat, lng, accuracy, heading }).catch(() => {});
  const poolOrders = await Order.find({ 'lokmaCourier.courierId': account._id, status: { $in: ACTIVE_STATUSES } }).select('_id status addressLat addressLng arrivedAt').lean();
  const first = poolOrders[0];
  for (const o of poolOrders) {
    // Mijoz manziliga 150 m qolganda "yetib keldi" (faqat yo'lda; bir marta)
    if (o.status === 'delivering' && !o.arrivedAt && Number.isFinite(o.addressLat) && haversineMeters({ lat, lng }, { lat: o.addressLat, lng: o.addressLng }) <= ARRIVED_M) {
      await Order.updateOne({ _id: o._id, arrivedAt: { $exists: false } }, { $set: { arrivedAt: new Date(now) } }).catch(() => {});
    }
  }
  // Trek (breadcrumb): kuryer yo'li bazaga siyraklashtirilib yoziladi — nazorat va nizolar uchun (services/courierTrack.js)
  storePoint({ courierId: id, shiftId: account.activeShiftId, orderId: first?._id || active?.orderId || null, lat, lng, accuracy, speed, at: now }).catch(() => {});
  return { ok: true, store };
}

/* ───────────── takliflar ───────────── */

/** Ilovadagi taklif ko'rinishi (quti buyurtmasi): MIJOZNING manzili/telefoni YO'Q — faqat tuman. `deliveryFee` = KURYER HAQI. */
export function poolOfferView(c) {
  return {
    id: c.id, kind: 'pool', orderCode: c.number ? `#${c.number}` : '', createdAt: c.acceptedAt || c.createdAt, status: c.status,
    restaurantName: c.restaurant.name, restaurantAddress: c.restaurant.address, restaurantLat: c.restaurant.lat, restaurantLng: c.restaurant.lng,
    addressLabel: districtLabel(c.district), itemsSummary: c.itemsSummary, itemsCount: c.itemsCount,
    deliveryFee: c.earningSom, earningSom: c.earningSom, freeDelivery: c.freeDelivery,
    isPaid: c.paymentMethod !== 'cash', collectAmount: c.cashToCollectSom, paymentMethod: c.paymentMethod,
    distanceM: c.distanceToRestaurantM, distanceKm: c.distanceKm,
  };
}

/** HAVOLA oqimi (eski): kuryerga ko'rinadigan taklif — MIJOZNING manzili / telefoni YO'Q. */
export function offerView(a, distanceM = null) {
  const s = a.deliverySnapshot || {};
  return {
    id: String(a._id), orderCode: s.orderCode || '', createdAt: a.createdAt,
    restaurantName: s.restaurantName || '', restaurantAddress: s.restaurantAddress || '', restaurantLat: s.restaurantLat ?? null, restaurantLng: s.restaurantLng ?? null,
    addressLabel: s.addressLabel || '', itemsSummary: s.itemsSummary || '',
    deliveryFee: s.deliveryFee || 0, isPaid: !!s.isPaid, collectAmount: s.collectAmount || 0, paymentMethod: s.paymentMethod || '',
    distanceM,
  };
}

async function validOpenOrderIds(assignments) {
  const rows = await Order.find({ _id: { $in: assignments.map((a) => a.orderId) }, status: { $in: OPEN_ORDER } }).select('_id').lean();
  return new Set(rows.map((r) => String(r._id)));
}

export async function listOffers(accountId) {
  const acc = await CourierAccount.findById(accountId).select('activeShiftId workDistricts').lean();
  const out = [];
  // 1) LokmaGo qutisi — faqat smenadagi kuryerga; tuman + biriktirilgan restoranlar (courierPool.listPool)
  if (acc?.activeShiftId) out.push(...(await listPool({ _id: accountId, workDistricts: acc.workDistricts })).map(poolOfferView));
  // 2) Havola oqimi (eski) — faqat yoqilgan bo'lsa
  if (config.courierLegacyOffers) out.push(...(await listLegacyOffers(accountId)));
  return out.sort((x, y) => (x.distanceM ?? 1e9) - (y.distanceM ?? 1e9));
}

async function listLegacyOffers(accountId) {
  const loc = await getLocation(accountId);
  const open = await DeliveryAssignment.find({ status: 'searching' }).sort({ createdAt: -1 }).limit(50).lean();
  const valid = await validOpenOrderIds(open);
  const out = [];
  for (const a of open) {
    if (!valid.has(String(a.orderId))) continue;
    const s = a.deliverySnapshot || {};
    let d = null;
    if (loc && Number.isFinite(s.restaurantLat) && Number.isFinite(s.restaurantLng)) d = Math.round(haversineMeters(loc, { lat: s.restaurantLat, lng: s.restaurantLng }));
    if (d !== null && d > config.courierOfferRadiusM) continue;
    out.push(offerView(a, d));
  }
  return out;
}

/* ───────────── faol buyurtma, qabul / olish / topshirish ───────────── */

export const activeAssignment = (accountId) => DeliveryAssignment.findOne({ assignedAccountId: accountId, status: 'assigned' }).lean();

/** Qabul qilgach kuryer ko'radigan TO'LIQ ma'lumot (HAVOLA oqimi). */
export function activeView(a) {
  const s = a.deliverySnapshot || {};
  return {
    id: String(a._id), orderId: String(a.orderId), kind: 'link', orderCode: s.orderCode || '', assignedAt: a.assignedAt,
    stage: 'to_customer', pickedUp: true, canPickup: false, canDeliver: true,
    restaurantName: s.restaurantName || '', restaurantAddress: s.restaurantAddress || '', restaurantPhone: s.restaurantPhone || '', restaurantLat: s.restaurantLat ?? null, restaurantLng: s.restaurantLng ?? null,
    customerName: s.customerName || '', customerPhone: s.customerPhone || '', addressLabel: s.addressLabel || '', addressNote: s.addressNote || '', lat: s.lat ?? null, lng: s.lng ?? null,
    items: (s.items || []).map((i) => ({ name: i.name, quantity: i.quantity })), itemsSummary: s.itemsSummary || '', note: s.note || '',
    deliveryFee: s.deliveryFee || 0, isPaid: !!s.isPaid, collectAmount: s.collectAmount || 0, paymentMethod: s.paymentMethod || '',
  };
}

/**
 * Qabul qilgach kuryer ko'radigan TO'LIQ ma'lumot (LOKMAGO QUTISI): restoran, mijoz manzili va telefoni, taomlar, qancha pul olish.
 *   stage: 'to_restaurant' (taomni olishga boryapti) → 'to_customer' (taom qo'lida, mijozga boryapti)
 *   canPickup / canDeliver — ilovadagi tugmalar: «Taomni oldim» → «Topshirdim».
 */
export function activeViewFromOrder(o) {
  const r = o.restaurantId && typeof o.restaurantId === 'object' ? o.restaurantId : {};
  const u = o.userId && typeof o.userId === 'object' ? o.userId : {};
  const f = o.finance || {};
  const pickedUp = o.status === 'delivering';
  return {
    id: String(o._id), orderId: String(o._id), kind: 'pool', orderCode: o.dailyNumber ? `#${o.dailyNumber}` : '', assignedAt: o.lokmaCourier?.claimedAt || null, status: o.status,
    stage: pickedUp ? 'to_customer' : 'to_restaurant', pickedUp, canPickup: !pickedUp, canDeliver: pickedUp,
    restaurantName: r.name || o.restaurantName || '', restaurantAddress: r.address || '', restaurantPhone: r.phone || '', restaurantLat: r.lat ?? null, restaurantLng: r.lng ?? null,
    customerName: u.firstName || '', customerPhone: o.phone || u.phone || '', addressLabel: o.address || '', addressNote: o.addressNote || '', lat: o.addressLat ?? null, lng: o.addressLng ?? null,
    items: (o.items || []).map((i) => ({ name: i.name, quantity: i.quantity })), itemsSummary: (o.items || []).map((i) => `${i.quantity}× ${i.name}`).join(', '), note: o.comment || '',
    deliveryFee: tiyinToSom(f.courierPayout), earningSom: tiyinToSom(f.courierPayout), freeDelivery: Boolean(f.freeDeliveryByLokma),
    isPaid: o.paymentMethod !== 'cash', collectAmount: o.paymentMethod === 'cash' ? tiyinToSom(f.totalCharged) : 0, paymentMethod: o.paymentMethod || '',
  };
}

/** Kuryerdagi faol buyurtma (qutidan yoki havoladan): { id, view } | null. Qutidagi (eng avval olingan) birinchi. */
export async function activeAny(accountId) {
  const [o] = await myActiveOrders(accountId);
  if (o) return { id: String(o._id), view: activeViewFromOrder(o), pool: true };
  const a = await activeAssignment(accountId);
  return a ? { id: String(a._id), view: activeView(a), pool: false, assignment: a } : null;
}

export const activeNow = async (accountId) => (await activeAny(accountId))?.view || null;

export async function acceptOffer(account, assignmentId) {
  if (!account.activeShiftId) return { ok: false, status: 409, error: 'Avval «Ishni boshladim» ni bosing' };
  // ── LokmaGo qutisi ──
  if (await isPool(assignmentId)) {
    try {
      await claimOrder(account._id, assignmentId);
    } catch (e) {
      if (e instanceof CourierPoolError) return poolErr(e);
      throw e;
    }
    await Order.updateOne({ _id: assignmentId }, { $set: { courierName: account.name } });        // restoran/admin panelida «Kuryer: …»
    const act = await activeAny(account._id);
    return { ok: true, active: act?.view || null };
  }
  // ── HAVOLA oqimi (eski) ──
  const busy = await DeliveryAssignment.countDocuments({ assignedAccountId: account._id, status: 'assigned' });
  if (busy >= config.courierMaxActive) return { ok: false, status: 409, error: 'Avval olingan buyurtmani topshiring' };
  const a = await DeliveryAssignment.findById(assignmentId).select('token status').lean();
  if (!a) return { ok: false, status: 404, error: 'Taklif topilmadi' };
  const res = await acceptShare(a.token);                        // ATOMIK: birinchi qabul qilgan oladi; buyurtma holati va botlar shu yerda
  if (!res.ok) return { ok: false, status: 409, error: res.error };
  await DeliveryAssignment.updateOne({ _id: assignmentId, status: 'assigned' }, { $set: { assignedAccountId: account._id, courier: { name: account.name, phone: account.phone || '', vehicle: account.vehicle || '' } } });
  const won = await DeliveryAssignment.findById(assignmentId).lean();
  if (won) await Order.updateOne({ _id: won.orderId }, { $set: { courierName: account.name } });         // restoran/admin panelida «Kuryer: …» (setCourierProfile kabi)
  return { ok: true, active: won ? activeView(won) : null };
}

/** «Taomni oldim» (restorandan oldim → «Yo'lda»). Faqat LokmaGo qutisi buyurtmasi uchun; `orderId` bo'lmasa — birinchi faol. */
export async function pickupActive(account, { orderId, location } = {}) {
  const id = orderId || (await myActiveOrders(account._id))[0]?._id;
  if (!id) return { ok: false, status: 404, error: 'Olinadigan buyurtma yo‘q' };
  try {
    const r = await pickupOrder(account._id, id, { override: location, actorName: account.name });
    return { ok: true, already: Boolean(r.already), check: r.check ? { flagged: r.check.flagged, flagReason: r.check.flagReason, targetDistanceM: r.check.targetDistanceM } : null, active: (await activeAny(account._id))?.view || null };
  } catch (e) {
    if (e instanceof CourierPoolError) return poolErr(e);
    throw e;
  }
}

/** «Topshirdim». LokmaGo qutisi: joylashuv tekshiruvi + hisob-kitob; havola oqimi: eski mantiq. */
export async function deliverActive(account, { orderId, location } = {}) {
  const act = await activeAny(account._id);
  if (!act) return { ok: false, status: 404, error: 'Faol buyurtma yo‘q' };
  if (act.pool) {
    try {
      const r = await deliverOrder(account._id, orderId || act.id, { override: location, actorName: account.name });
      if (r.changed && account.activeShiftId) await CourierShift.updateOne({ _id: account.activeShiftId }, { $inc: { deliveries: 1 } });
      return { ok: true, check: r.check ? { flagged: r.check.flagged, flagReason: r.check.flagReason, targetDistanceM: r.check.targetDistanceM } : null };
    } catch (e) {
      if (e instanceof CourierPoolError) return poolErr(e);
      throw e;
    }
  }
  const a = await DeliveryAssignment.findOne({ assignedAccountId: account._id, status: 'assigned' }).select('token acceptanceSecret').lean();
  if (!a) return { ok: false, status: 404, error: 'Faol buyurtma yo‘q' };
  const res = await deliverShare(a.token, a.acceptanceSecret);   // holat → delivered + hisob-kitob (settleOrder) mavjud mantiq bilan
  if (!res.ok) return { ok: false, status: 409, error: res.error };
  if (account.activeShiftId) await CourierShift.updateOne({ _id: account.activeShiftId }, { $inc: { deliveries: 1 } });
  return { ok: true };
}

/* ───────────── tarix va hisobot ───────────── */

const historyRow = (o) => ({
  id: String(o._id), orderCode: o.dailyNumber ? `#${o.dailyNumber}` : '', restaurantName: o.restaurantName || '', addressLabel: o.address || '',
  deliveryFee: tiyinToSom(o.finance?.courierPayout), collectAmount: o.paymentMethod === 'cash' ? tiyinToSom(o.finance?.totalCharged) : 0, isPaid: o.paymentMethod !== 'cash',
  assignedAt: o.lokmaCourier?.claimedAt || null, deliveredAt: o.deliveredAt || o.lokmaCourier?.deliveredAt || null,
  minutes: o.lokmaCourier?.claimedAt && (o.deliveredAt || o.lokmaCourier?.deliveredAt)
    ? Math.max(1, Math.round((new Date(o.deliveredAt || o.lokmaCourier.deliveredAt) - new Date(o.lokmaCourier.claimedAt)) / 60000)) : null,
});

export async function history(accountId, { limit = 30, before } = {}) {
  const n = Math.min(Math.max(limit, 1), 100);
  const cut = before ? { $lt: new Date(before) } : null;
  const [pool, legacy] = await Promise.all([
    Order.find({ 'lokmaCourier.courierId': accountId, status: 'delivered', ...(cut ? { deliveredAt: cut } : {}) })
      .sort({ deliveredAt: -1 }).limit(n).select('dailyNumber restaurantName address finance paymentMethod lokmaCourier deliveredAt').lean(),
    DeliveryAssignment.find({ assignedAccountId: accountId, status: 'delivered', ...(cut ? { deliveredAt: cut } : {}) }).sort({ deliveredAt: -1 }).limit(n).lean(),
  ]);
  const rows = [
    ...pool.map(historyRow),
    ...legacy.map((a) => {
      const s = a.deliverySnapshot || {};
      return { id: String(a._id), orderCode: s.orderCode || '', restaurantName: s.restaurantName || '', addressLabel: s.addressLabel || '', deliveryFee: s.deliveryFee || 0,
        collectAmount: s.collectAmount || 0, isPaid: !!s.isPaid, assignedAt: a.assignedAt, deliveredAt: a.deliveredAt,
        minutes: a.assignedAt && a.deliveredAt ? Math.max(1, Math.round((new Date(a.deliveredAt) - new Date(a.assignedAt)) / 60000)) : null };
    }),
  ];
  return rows.sort((x, y) => new Date(y.deliveredAt) - new Date(x.deliveredAt)).slice(0, n);
}

const startOfDayTashkent = (ms) => { const t = new Date(ms + 5 * 3600_000); t.setUTCHours(0, 0, 0, 0); return t.getTime() - 5 * 3600_000; };

/** Bugun / 7 kun / 30 kun: yetkazishlar soni, kuryer haqi yig'indisi, ish vaqti, masofa. */
export async function stats(accountId, now = Date.now()) {
  const today = startOfDayTashkent(now);
  const periods = { today, week: today - 6 * 86400_000, month: today - 29 * 86400_000 };
  const [legacy, pool, shifts] = await Promise.all([
    DeliveryAssignment.find({ assignedAccountId: accountId, status: 'delivered', deliveredAt: { $gte: new Date(periods.month) } }).select('deliveredAt deliverySnapshot.deliveryFee').lean(),
    Order.find({ 'lokmaCourier.courierId': accountId, status: 'delivered', deliveredAt: { $gte: new Date(periods.month) } }).select('deliveredAt finance').lean(),
    CourierShift.find({ accountId, startedAt: { $gte: new Date(periods.month - 86400_000) } }).select('startedAt endedAt distanceM').lean(),
  ]);
  const deliveries = [
    ...legacy.map((x) => ({ at: x.deliveredAt, fee: x.deliverySnapshot?.deliveryFee || 0 })),
    ...pool.map((x) => ({ at: x.deliveredAt, fee: tiyinToSom(x.finance?.courierPayout) })),
  ];
  const out = {};
  for (const [name, from] of Object.entries(periods)) {
    const d = deliveries.filter((x) => new Date(x.at).getTime() >= from);
    const sh = shifts.filter((x) => new Date(x.startedAt).getTime() >= from);
    out[name] = {
      deliveries: d.length, deliveryFees: d.reduce((n, x) => n + x.fee, 0),
      shifts: sh.length, workedMinutes: Math.round(sh.reduce((n, x) => n + ((x.endedAt ? new Date(x.endedAt).getTime() : now) - new Date(x.startedAt).getTime()) / 60000, 0)),
      distanceKm: Math.round(sh.reduce((n, x) => n + (x.distanceM || 0), 0) / 100) / 10,
    };
  }
  return out;
}

export const shiftHistory = async (accountId, limit = 30) =>
  (await CourierShift.find({ accountId }).sort({ startedAt: -1 }).limit(Math.min(limit, 100)).lean())
    .map((s) => ({ id: String(s._id), startedAt: s.startedAt, endedAt: s.endedAt, endReason: s.endReason, deliveries: s.deliveries, distanceKm: Math.round((s.distanceM || 0) / 100) / 10 }));

/** Kuryerning pul holati (balans, naqd chegarasi) — ilova profilida ko'rsatiladi. */
export async function walletOf(account) {
  const [balanceSom, openCashSom, limit] = await Promise.all([courierBalanceSom(account._id), openCashExposureSom(account._id), debtLimitFor(account)]);
  return { balanceSom, openCashSom, debtLimitSom: limit, cashRoomSom: Math.round((limit + balanceSom - openCashSom) * 100) / 100 };
}
