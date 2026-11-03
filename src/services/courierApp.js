import { CourierAccount } from '../models/CourierAccount.js';
import { CourierShift } from '../models/CourierShift.js';
import { DeliveryAssignment } from '../models/DeliveryAssignment.js';
import { Order } from '../models/Order.js';
import { config } from '../config/index.js';
import { acceptShare, deliverShare, haversineMeters, applyAssignmentLocation } from './courierDispatch.js';
import { setLocation, getLocation, clearLocation } from './courierPresence.js';

/**
 * KURYER ILOVASI (BOSQICH 2) — biznes mantiq.
 *
 * Buyurtma holati, "birinchi qabul qilgan oladi" va hisob-kitob (settleOrder) uchun MAVJUD, sinalgan funksiyalar ishlatiladi
 * (acceptShare / deliverShare) — bu yerda ularning mantig'i QAYTA YOZILMAGAN. Bu fayl faqat: kimligini (akkaunt), smenani, joylashuvni
 * va ko'rinadigan ma'lumotni boshqaradi.
 */
const OPEN_ORDER = ['accepted', 'preparing', 'ready'];            // acceptShare ham aynan shularni kutadi
const BOUNDS = { lat: [36, 46], lng: [55, 74] };                    // O'zbekiston va qo'shni hududlar (updateCourierLocation bilan bir xil)

/* ───────────── smena ───────────── */

export async function shiftState(accountId) {
  const acc = await CourierAccount.findById(accountId).select('activeShiftId').lean();
  const shift = acc?.activeShiftId ? await CourierShift.findById(acc.activeShiftId).lean() : null;
  const active = await activeAssignment(accountId);
  return { onShift: !!shift, shift: shift && { id: String(shift._id), startedAt: shift.startedAt, deliveries: shift.deliveries, distanceM: Math.round(shift.distanceM) }, activeAssignmentId: active ? String(active._id) : null };
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
  if (reason === 'courier' && await activeAssignment(accountId)) return { ok: false, status: 409, error: 'Avval olingan buyurtmani topshiring' };
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
  const active = await activeAssignment(id);
  if (active) await applyAssignmentLocation(active._id, { lat, lng, accuracy, heading }).catch(() => {});
  return { ok: true, store };
}

/* ───────────── takliflar ───────────── */

/** Kuryerga ko'rinadigan taklif: MIJOZNING manzili / telefoni YO'Q (faqat qabul qilgach). */
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
  return out.sort((x, y) => (x.distanceM ?? 1e9) - (y.distanceM ?? 1e9));
}

/* ───────────── qabul / topshirish ───────────── */

export const activeAssignment = (accountId) => DeliveryAssignment.findOne({ assignedAccountId: accountId, status: 'assigned' }).lean();

/** Qabul qilgach kuryer ko'radigan TO'LIQ ma'lumot (mijoz manzili, telefoni, qancha pul olish). */
export function activeView(a) {
  const s = a.deliverySnapshot || {};
  return {
    id: String(a._id), orderId: String(a.orderId), orderCode: s.orderCode || '', assignedAt: a.assignedAt,
    restaurantName: s.restaurantName || '', restaurantAddress: s.restaurantAddress || '', restaurantPhone: s.restaurantPhone || '', restaurantLat: s.restaurantLat ?? null, restaurantLng: s.restaurantLng ?? null,
    customerName: s.customerName || '', customerPhone: s.customerPhone || '', addressLabel: s.addressLabel || '', addressNote: s.addressNote || '', lat: s.lat ?? null, lng: s.lng ?? null,
    items: (s.items || []).map((i) => ({ name: i.name, quantity: i.quantity })), itemsSummary: s.itemsSummary || '', note: s.note || '',
    deliveryFee: s.deliveryFee || 0, isPaid: !!s.isPaid, collectAmount: s.collectAmount || 0, paymentMethod: s.paymentMethod || '',
  };
}

export async function acceptOffer(account, assignmentId) {
  if (!account.activeShiftId) return { ok: false, status: 409, error: 'Avval «Ishni boshladim» ni bosing' };
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

export async function deliverActive(account) {
  const a = await DeliveryAssignment.findOne({ assignedAccountId: account._id, status: 'assigned' }).select('token acceptanceSecret').lean();
  if (!a) return { ok: false, status: 404, error: 'Faol buyurtma yo‘q' };
  const res = await deliverShare(a.token, a.acceptanceSecret);   // holat → delivered + hisob-kitob (settleOrder) mavjud mantiq bilan
  if (!res.ok) return { ok: false, status: 409, error: res.error };
  if (account.activeShiftId) await CourierShift.updateOne({ _id: account.activeShiftId }, { $inc: { deliveries: 1 } });
  return { ok: true };
}

/* ───────────── tarix va hisobot ───────────── */

export async function history(accountId, { limit = 30, before } = {}) {
  const q = { assignedAccountId: accountId, status: 'delivered', ...(before ? { deliveredAt: { $lt: new Date(before) } } : {}) };
  const rows = await DeliveryAssignment.find(q).sort({ deliveredAt: -1 }).limit(Math.min(Math.max(limit, 1), 100)).lean();
  return rows.map((a) => {
    const s = a.deliverySnapshot || {};
    return { id: String(a._id), orderCode: s.orderCode || '', restaurantName: s.restaurantName || '', addressLabel: s.addressLabel || '', deliveryFee: s.deliveryFee || 0,
      collectAmount: s.collectAmount || 0, isPaid: !!s.isPaid, assignedAt: a.assignedAt, deliveredAt: a.deliveredAt,
      minutes: a.assignedAt && a.deliveredAt ? Math.max(1, Math.round((new Date(a.deliveredAt) - new Date(a.assignedAt)) / 60000)) : null };
  });
}

const startOfDayTashkent = (ms) => { const t = new Date(ms + 5 * 3600_000); t.setUTCHours(0, 0, 0, 0); return t.getTime() - 5 * 3600_000; };

/** Bugun / 7 kun / 30 kun: yetkazishlar soni, yetkazish haqi yig'indisi (faqat ma'lumot uchun), ish vaqti, masofa. */
export async function stats(accountId, now = Date.now()) {
  const today = startOfDayTashkent(now);
  const periods = { today, week: today - 6 * 86400_000, month: today - 29 * 86400_000 };
  const [deliveries, shifts] = await Promise.all([
    DeliveryAssignment.find({ assignedAccountId: accountId, status: 'delivered', deliveredAt: { $gte: new Date(periods.month) } }).select('deliveredAt deliverySnapshot.deliveryFee').lean(),
    CourierShift.find({ accountId, startedAt: { $gte: new Date(periods.month - 86400_000) } }).select('startedAt endedAt distanceM').lean(),
  ]);
  const out = {};
  for (const [name, from] of Object.entries(periods)) {
    const d = deliveries.filter((x) => new Date(x.deliveredAt).getTime() >= from);
    const sh = shifts.filter((x) => new Date(x.startedAt).getTime() >= from);
    out[name] = {
      deliveries: d.length, deliveryFees: d.reduce((n, x) => n + (x.deliverySnapshot?.deliveryFee || 0), 0),
      shifts: sh.length, workedMinutes: Math.round(sh.reduce((n, x) => n + ((x.endedAt ? new Date(x.endedAt).getTime() : now) - new Date(x.startedAt).getTime()) / 60000, 0)),
      distanceKm: Math.round(sh.reduce((n, x) => n + (x.distanceM || 0), 0) / 100) / 10,
    };
  }
  return out;
}

export const shiftHistory = async (accountId, limit = 30) =>
  (await CourierShift.find({ accountId }).sort({ startedAt: -1 }).limit(Math.min(limit, 100)).lean())
    .map((s) => ({ id: String(s._id), startedAt: s.startedAt, endedAt: s.endedAt, endReason: s.endReason, deliveries: s.deliveries, distanceKm: Math.round((s.distanceM || 0) / 100) / 10 }));
