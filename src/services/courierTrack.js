import { Types } from 'mongoose';
import { CourierTrackPoint } from '../models/CourierTrackPoint.js';
import { CourierEvent } from '../models/CourierEvent.js';
import { CourierAccount } from '../models/CourierAccount.js';
import { Order } from '../models/Order.js';
import { config } from '../config/index.js';
import { getLocation } from './courierPresence.js';
import { haversineMeters } from './courierDispatch.js';

/*
 * ═══════════════════════════════════════════════════════════════
 * KURYER NAZORATI: qayerda, nima olib ketyapti, olib bo'ldimi, topshirdimi
 * ═══════════════════════════════════════════════════════════════
 *
 *  1. TREK (breadcrumb)  — smena davomida har nuqta (harakatda) yoki har 60 s (turganda) bazaga: "qayerdan o'tdi".
 *  2. VOQEALAR           — claimed / picked_up / delivered / released: har biri kuryerning O'SHA PAYTDAGI joylashuvi
 *                          va maqsadgacha masofa bilan (restoran / mijoz manzili). Chegaradan uzoq yoki joylashuv eskirgan
 *                          bo'lsa `flagged` (adminga ko'rinadi). COURIER_ENFORCE_PROXIMITY=1 bo'lsa uzoqdan bosish BLOKLANADI.
 *  3. JONLI KO'RINISH    — admin: smenadagi kuryerlar, hozirgi joyi, qaysi taomni qayerdan qayerga olib ketyapti.
 *
 * Vaqt har doim SERVERniki (telefon soati noto'g'ri bo'lsa ham). Toza funksiyalar (proximity, shouldStorePoint) bazasiz sinaladi.
 */

const oid = (v) => (v instanceof Types.ObjectId ? v : new Types.ObjectId(String(v)));
const round = (n) => (Number.isFinite(n) ? Math.round(n) : null);
const num = (v) => (v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);

/* ───────────── toza funksiyalar ───────────── */

/**
 * Kuryer maqsadga yaqinmi? loc: { lat, lng, ts } | null; target: { lat, lng } | null.
 * Qaytaradi: { locAgeSec, targetDistanceM, flagged, flagReason }.
 *   no_location     — kuryerning joylashuvi umuman yo'q
 *   stale_location  — oxirgi nuqta staleSec dan eski (telefon o'chgan / tarmoq yo'q)
 *   far_*           — maqsaddan radiusM dan uzoq (flagReason keyin 'restaurant' / 'customer' qo'shimchasini oladi)
 *   no_target       — maqsad koordinatasi noma'lum (tekshirib bo'lmaydi; belgilanMAYDI)
 */
export function proximity({ loc, target, radiusM, staleSec = config.courierStaleSec, now = Date.now() }) {
  const hasLoc = loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lng);
  if (!hasLoc) return { locAgeSec: null, targetDistanceM: null, flagged: true, flagReason: 'no_location' };
  const locAgeSec = Math.max(0, Math.round((now - (Number(loc.ts) || now)) / 1000));
  const hasTarget = target && Number.isFinite(target.lat) && Number.isFinite(target.lng);
  const targetDistanceM = hasTarget ? Math.round(haversineMeters(loc, target)) : null;
  if (locAgeSec > staleSec) return { locAgeSec, targetDistanceM, flagged: true, flagReason: 'stale_location' };
  if (!hasTarget) return { locAgeSec, targetDistanceM: null, flagged: false, flagReason: '' };
  if (targetDistanceM > radiusM) return { locAgeSec, targetDistanceM, flagged: true, flagReason: 'far' };
  return { locAgeSec, targetDistanceM, flagged: false, flagReason: '' };
}

/** Nuqtani bazaga yozish kerakmi: birinchi / 15 m dan ortiq siljigan / 60 s o'tgan. */
export function shouldStorePoint(prev, cur, { minMoveM = 15, maxGapMs = 60_000 } = {}) {
  if (!prev) return true;
  if (cur.at - prev.at >= maxGapMs) return true;
  return haversineMeters(prev, cur) >= minMoveM;
}

/** Trek bo'yicha bosib o'tilgan masofa (m): faqat mantiqli qadamlar (GPS sakrashi yig'indini buzmasin). */
export function trackDistanceM(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]; const b = points[i];
    const dt = (new Date(b.at) - new Date(a.at)) / 1000;
    const d = haversineMeters(a, b);
    if (d >= 3 && d <= 800 && dt > 0 && d / dt <= 45) total += d;      // 45 m/s (~160 km/soat) dan tez — sakrash, hisobga olinmaydi
  }
  return Math.round(total);
}

/* ───────────── trek nuqtalarini saqlash ───────────── */

const lastStored = new Map();          // courierId → { lat, lng, at } (jarayon xotirasi; ko'p nusxada takror yozuv bo'lishi mumkin — zararsiz)

/** Smenadagi har nuqtani (siyraklashtirib) bazaga yozadi. Xato bo'lsa jim — joylashuv oqimini to'xtatmaydi. */
export async function storePoint({ courierId, shiftId = null, orderId = null, lat, lng, accuracy, speed, at = Date.now() }) {
  const id = String(courierId);
  const cur = { lat, lng, at };
  if (!shouldStorePoint(lastStored.get(id), cur)) return false;
  lastStored.set(id, cur);
  try {
    await CourierTrackPoint.create({
      courierId: oid(courierId), shiftId: shiftId ? oid(shiftId) : null, orderId: orderId ? oid(orderId) : null,
      lat, lng, acc: num(accuracy) ?? undefined, spd: num(speed) ?? undefined, at: new Date(at),
    });
    return true;
  } catch { return false; }
}
export const _resetTrackCache = () => lastStored.clear();

/* ───────────── voqealar ───────────── */

/**
 * Voqeani yozadi va tekshiruv natijasini qaytaradi. `override` — ilova yuborgan aniq joylashuv ({lat,lng,accuracy}),
 * bo'lmasa serverdagi oxirgi nuqta (Redis) ishlatiladi.
 * `radiusM` berilsa (picked_up / delivered) — maqsadga masofa tekshiriladi.
 */
export async function recordEvent({ order, courierId, type, target = null, radiusM = null, override = null, by = '', now = Date.now() }) {
  let loc = null;
  if (override && Number.isFinite(Number(override.lat)) && Number.isFinite(Number(override.lng))) {
    loc = { lat: Number(override.lat), lng: Number(override.lng), ts: now, accuracy: num(override.accuracy) };
  } else if (courierId) {
    loc = await getLocation(String(courierId)).catch(() => null);
  }
  const p = radiusM ? proximity({ loc, target, radiusM, now }) : { locAgeSec: loc ? Math.max(0, Math.round((now - loc.ts) / 1000)) : null, targetDistanceM: null, flagged: false, flagReason: '' };
  let flagReason = p.flagReason;
  if (flagReason === 'far') flagReason = type === 'picked_up' ? 'far_from_restaurant' : 'far_from_customer';
  const doc = {
    orderId: order._id, courierId: courierId ? oid(courierId) : null, restaurantId: order.restaurantId?._id || order.restaurantId || null,
    type, at: new Date(now), lat: loc?.lat, lng: loc?.lng, accuracy: loc?.accuracy ?? undefined,
    locAgeSec: p.locAgeSec ?? undefined, targetDistanceM: p.targetDistanceM ?? undefined, flagged: p.flagged, flagReason, by,
  };
  await CourierEvent.create(doc).catch((e) => console.error('[courierTrack] voqea yozilmadi:', e.message));
  return { ...p, flagReason };
}

/* ───────────── admin: jonli ko'rinish ───────────── */

const itemsLine = (items = []) => items.map((i) => `${i.quantity}× ${i.name}`).join(', ');

function liveOrder(o, loc) {
  const r = o.restaurantId && typeof o.restaurantId === 'object' ? o.restaurantId : {};
  const pickedUp = Boolean(o.lokmaCourier?.pickedUpAt);
  const target = pickedUp ? { lat: o.addressLat, lng: o.addressLng } : { lat: r.lat, lng: r.lng };
  const d = loc && Number.isFinite(target.lat) && Number.isFinite(target.lng) ? Math.round(haversineMeters(loc, target)) : null;
  return {
    id: String(o._id), number: o.dailyNumber ?? null, status: o.status,
    stage: pickedUp ? 'to_customer' : 'to_restaurant',                // restoranga ketyapti / taomni olib mijozga ketyapti
    items: (o.items || []).map((i) => ({ name: i.name, quantity: i.quantity })), itemsLine: itemsLine(o.items),
    restaurant: { id: String(r._id || o.restaurantId), name: r.name || o.restaurantName || '', address: r.address || '', lat: r.lat ?? null, lng: r.lng ?? null },
    customer: { address: o.address || '', lat: o.addressLat ?? null, lng: o.addressLng ?? null },
    paymentMethod: o.paymentMethod, cashToCollect: o.paymentMethod === 'cash' ? Math.round((o.finance?.totalCharged || 0) / 100) : 0,
    claimedAt: o.lokmaCourier?.claimedAt || null, pickedUpAt: o.lokmaCourier?.pickedUpAt || null,
    distanceToTargetM: d,
  };
}

/** Smenadagi kuryerlar: joyi, signal holati va qo'lidagi buyurtmalar (qayerdan qayerga, qanday taom). */
export async function liveCouriers({ now = Date.now() } = {}) {
  const accounts = await CourierAccount.find({ activeShiftId: { $ne: null }, isActive: true })
    .select('name phone vehicle activeShiftId workDistricts').lean();
  if (!accounts.length) return [];
  const ids = accounts.map((a) => a._id);
  const orders = await Order.find({ 'lokmaCourier.courierId': { $in: ids }, status: { $in: ['accepted', 'preparing', 'ready', 'delivering'] } })
    .select('dailyNumber status restaurantId restaurantName items address addressLat addressLng paymentMethod finance lokmaCourier')
    .populate('restaurantId', 'name address lat lng').lean();
  const byCourier = new Map();
  for (const o of orders) {
    const k = String(o.lokmaCourier.courierId);
    if (!byCourier.has(k)) byCourier.set(k, []);
    byCourier.get(k).push(o);
  }
  const out = [];
  for (const a of accounts) {
    const loc = await getLocation(String(a._id)).catch(() => null);
    const ageSec = loc ? Math.max(0, Math.round((now - loc.ts) / 1000)) : null;
    out.push({
      id: String(a._id), name: a.name, phone: a.phone || '', vehicle: a.vehicle || '', workDistricts: a.workDistricts || [],
      shiftId: String(a.activeShiftId),
      location: loc ? { lat: loc.lat, lng: loc.lng, speed: loc.speed ?? null, heading: loc.heading ?? null, accuracy: loc.accuracy ?? null, at: new Date(loc.ts).toISOString(), ageSec } : null,
      signal: ageSec === null ? 'none' : ageSec > config.courierStaleSec ? 'stale' : 'ok',
      orders: (byCourier.get(String(a._id)) || []).map((o) => liveOrder(o, loc)),
    });
  }
  // Muammolilar tepada: signal yo'q → eskirgan → buyurtmali → qolganlari
  const rank = (c) => (c.signal === 'none' ? 0 : c.signal === 'stale' ? 1 : c.orders.length ? 2 : 3);
  return out.sort((x, y) => rank(x) - rank(y) || x.name.localeCompare(y.name));
}

/* ───────────── admin: trek va buyurtma tarixi ───────────── */

export async function courierTrack(courierId, { from, to, limit = 3000 } = {}) {
  const q = { courierId: oid(courierId) };
  if (from || to) q.at = { ...(from ? { $gte: new Date(from) } : {}), ...(to ? { $lte: new Date(to) } : {}) };
  const rows = await CourierTrackPoint.find(q).sort({ at: 1 }).limit(Math.min(5000, Math.max(1, limit))).select('lat lng acc spd at orderId').lean();
  return { points: rows, distanceM: trackDistanceM(rows) };
}

/** Bitta buyurtma bo'yicha to'liq nazorat: voqealar (olish/oldi/topshirdi + joylashuv) va kuryer yo'li. */
export async function orderTrace(orderId) {
  const o = await Order.findById(orderId)
    .select('dailyNumber status restaurantId restaurantName items address addressLat addressLng paymentMethod courierParty lokmaCourier finance createdAt acceptedAt deliveredAt')
    .populate('restaurantId', 'name address lat lng').lean();
  if (!o) return null;
  const events = await CourierEvent.find({ orderId: o._id }).sort({ at: 1 }).lean();
  const cid = o.lokmaCourier?.courierId;
  const points = cid
    ? await CourierTrackPoint.find({ courierId: cid, at: { $gte: o.lokmaCourier.claimedAt || o.createdAt, ...(o.lokmaCourier.deliveredAt ? { $lte: o.lokmaCourier.deliveredAt } : {}) } })
      .sort({ at: 1 }).limit(3000).select('lat lng at').lean()
    : [];
  const courier = cid ? await CourierAccount.findById(cid).select('name phone').lean() : null;
  const r = o.restaurantId && typeof o.restaurantId === 'object' ? o.restaurantId : {};
  return {
    order: {
      id: String(o._id), number: o.dailyNumber ?? null, status: o.status, courierParty: o.courierParty,
      itemsLine: itemsLine(o.items), restaurant: { name: r.name || o.restaurantName || '', lat: r.lat ?? null, lng: r.lng ?? null },
      customer: { address: o.address || '', lat: o.addressLat ?? null, lng: o.addressLng ?? null },
      claimedAt: o.lokmaCourier?.claimedAt || null, pickedUpAt: o.lokmaCourier?.pickedUpAt || null, deliveredAt: o.lokmaCourier?.deliveredAt || null,
    },
    courier: courier ? { id: String(cid), name: courier.name, phone: courier.phone || '' } : null,
    events: events.map((e) => ({
      type: e.type, at: e.at, lat: e.lat ?? null, lng: e.lng ?? null, targetDistanceM: e.targetDistanceM ?? null,
      locAgeSec: e.locAgeSec ?? null, flagged: e.flagged, flagReason: e.flagReason, by: e.by || '',
    })),
    points, distanceM: trackDistanceM(points),
    flagged: events.some((e) => e.flagged),
  };
}

/** Shubhali voqealar ro'yxati (uzoqdan "oldim/topshirdim", joylashuvsiz). */
export async function flaggedEvents({ limit = 100, since } = {}) {
  const q = { flagged: true, ...(since ? { at: { $gte: new Date(since) } } : {}) };
  const rows = await CourierEvent.find(q).sort({ at: -1 }).limit(Math.min(300, limit)).lean();
  const cids = [...new Set(rows.map((r) => String(r.courierId)).filter((x) => x !== 'null'))];
  const accs = cids.length ? await CourierAccount.find({ _id: { $in: cids } }).select('name').lean() : [];
  const names = new Map(accs.map((a) => [String(a._id), a.name]));
  return rows.map((e) => ({
    id: String(e._id), orderId: String(e.orderId), courierId: e.courierId ? String(e.courierId) : null, courierName: names.get(String(e.courierId)) || '',
    type: e.type, at: e.at, flagReason: e.flagReason, targetDistanceM: e.targetDistanceM ?? null, locAgeSec: e.locAgeSec ?? null,
  }));
}
