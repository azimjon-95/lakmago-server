import { Order } from '../models/Order.js';
import { Dish } from '../models/Dish.js';
import { Restaurant } from '../models/Restaurant.js';
import { DeliveryAssignment } from '../models/DeliveryAssignment.js';
import { haversineMeters } from './courierDispatch.js';

/*
 * ═══ BUYURTMA KUZATUVI (mijoz ilovasi, OrderTrack sahifasi) — HAQIQIY MA'LUMOT ═══
 *
 * GET /api/orders/:id/track bitta javobda beradi: vaqt chizig'i (haqiqiy vaqt
 * belgilari), taxminiy yetib kelish vaqti (HISOBLANGAN, soxta emas), restoran,
 * mijoz nuqtasi, masofa, kuryer (o'zi kiritgan ma'lumot + jonli joylashuv),
 * taomlar (rasmi bilan) va summalar.
 *
 * Soxta/tasodifiy qiymat YO'Q: ma'lumot bo'lmasa maydon null — mijoz ilovasi
 * uni ko'rsatmaydi.
 */
export const TRACK = {
  speedKmh: 24,          // shahar ichida skuter/mashina o'rtacha tezligi
  roadFactor: 1.3,       // to'g'ri chiziq masofasi → yo'l masofasi
  defaultPrepMin: 15,
  courierWaitMin: 5,     // tayyor, lekin kuryer hali olmagan
  locationFreshMs: 3 * 60_000,   // undan eski joylashuv mijozga ko'rsatilmaydi
  minRatingCount: 5,     // reyting shuncha baholangan buyurtmadan keyin ko'rsatiladi
};

const MIN = 60_000;
const t = (d) => (d ? new Date(d).getTime() : null);
const iso = (d) => (d ? new Date(d).toISOString() : null);

export function haversineKm(a, b) {
  return haversineMeters(a, b) / 1000;
}
const isPoint = (p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lng);

/** Yetkazib berish vaqti (daqiqa): masofa bo'yicha */
export function travelMinutes(distanceKm) {
  if (!Number.isFinite(distanceKm) || distanceKm <= 0) return 10;
  return Math.min(90, Math.max(3, Math.ceil((distanceKm * TRACK.roadFactor / TRACK.speedKmh) * 60)));
}

/* ───────────── Vaqt chizig'i ───────────── */
export function buildSteps(o) {
  const delivery = o.fulfillment !== 'pickup';
  const at = {
    // Faqat haqiqatan qabul qilingan bo'lsa (avval yaratilgan vaqt ko'rsatilardi — kutilayotgan buyurtmada ham)
    accepted: t(o.acceptedAt),
    preparing: t(o.preparingAt),
    ready: t(o.readyAt),
    delivering: t(o.deliveringAt),
    arrived: t(o.arrivedAt),
    delivered: t(o.deliveredAt),
  };
  // Qadamlar tartibi va "bosilgan" bo'lish holati
  const order = delivery
    ? ['accepted', 'preparing', 'delivering', 'arrived', 'delivered']
    : ['accepted', 'preparing', 'ready', 'delivered'];
  const rank = {
    pending: -1, accepted: 0, preparing: 1,
    ready: delivery ? 1 : 2,                     // yetkazishda "tayyor" — hali kuryer olmagan: tayyorlanish bosqichi
    delivering: o.arrivedAt ? 3 : 2,
    delivered: order.length - 1,
  }[o.status] ?? -1;
  return {
    steps: order.map((key, i) => ({
      key,
      at: iso(at[key]),
      done: i < rank || (o.status === 'delivered'),
      active: i === rank && o.status !== 'delivered',
    })),
    current: rank >= 0 ? order[Math.min(rank, order.length - 1)] : 'pending',
  };
}

/* ───────────── Taxminiy yetib kelish vaqti ───────────── */
/**
 * @returns {{ minutes: number|null, at: string|null, basis: 'live'|'estimate'|'scheduled'|null }}
 */
export function estimateEta(o, { prepMinutes, distanceKm, courierPoint, customerPoint, now = Date.now() }) {
  if (['delivered', 'cancelled'].includes(o.status)) return { minutes: null, at: null, basis: null };
  const mk = (minutes, basis) => ({ minutes, at: new Date(now + minutes * MIN).toISOString(), basis });

  // Rejalashtirilgan buyurtma (kelajak vaqtga) — aynan shu vaqt
  if (o.timingMode === 'scheduled' && o.scheduledFor && t(o.scheduledFor) > now) {
    return { minutes: Math.ceil((t(o.scheduledFor) - now) / MIN), at: iso(o.scheduledFor), basis: 'scheduled' };
  }

  const prep = Number.isFinite(prepMinutes) && prepMinutes > 0 ? Math.min(prepMinutes, 120) : TRACK.defaultPrepMin;
  const travel = travelMinutes(distanceKm);
  const delivery = o.fulfillment !== 'pickup';
  const since = (d) => (d ? Math.max(0, (now - t(d)) / MIN) : 0);

  if (o.arrivedAt) return mk(0, 'live');

  switch (o.status) {
    case 'pending':
      return mk(Math.round(prep + (delivery ? travel : 0)), 'estimate');
    case 'accepted':
    case 'preparing': {
      const left = Math.max(2, Math.ceil(prep - since(o.acceptedAt)));
      return mk(left + (delivery ? travel : 0), 'estimate');
    }
    case 'ready':
      return mk(delivery ? travel + TRACK.courierWaitMin : 0, 'estimate');
    case 'delivering': {
      // Kuryerning haqiqiy joylashuvi bor — qolgan masofa bo'yicha (jonli)
      if (isPoint(courierPoint) && isPoint(customerPoint)) {
        const km = haversineKm(courierPoint, customerPoint);
        return mk(Math.max(1, Math.ceil((km * TRACK.roadFactor / TRACK.speedKmh) * 60)), 'live');
      }
      return mk(Math.max(1, Math.ceil(travel - since(o.deliveringAt))), 'estimate');
    }
    default:
      return { minutes: null, at: null, basis: null };
  }
}

/* ───────────── "Qabul qildingizmi?" (mijoz ilovasi) ───────────── */
/**
 * Buyurtma qabul qilinganidan 1 soat o'tib hali yakunlanmagan bo'lsa, ilovada pastda
 * [Ha, oldim] [Kutyapman] ko'rinadi (telegram bot bilan bir xil qoida: reminderRules.CUSTOMER_ASK).
 * "Kutyapman" — 15 daqiqaga yashiradi. Rejalashtirilgan buyurtma vaqti kelmaguncha so'ralmaydi.
 */
export const CONFIRM_AFTER_MIN = 60;
export function confirmPrompt(o, now = Date.now()) {
  const open = ['accepted', 'preparing', 'ready', 'delivering'].includes(o.status);
  const delivery = o.fulfillment !== 'pickup' && o.fulfillment !== 'dinein';
  if (!open || !delivery || !o.acceptedAt || o.deliveryCheck?.confirmed) return { available: false, since: null };
  const base = o.scheduledFor ? Math.max(t(o.acceptedAt), t(o.scheduledFor)) : t(o.acceptedAt);
  const dueAt = base + CONFIRM_AFTER_MIN * MIN;
  const snooze = t(o.deliveryCheck?.snoozeUntil);
  const available = now >= dueAt && !(snooze && now < snooze);
  return { available, since: iso(dueAt), snoozeUntil: snooze && now < snooze ? iso(snooze) : null };
}

/* ───────────── Kuryer (mijozga ko'rinadigan qism) ───────────── */
const VEHICLE_LABEL = { scooter: 'Skuter', bike: 'Velosiped', car: 'Mashina', foot: 'Piyoda' };

export function courierView(assignment, order, stats, now = Date.now()) {
  if (!assignment || assignment.status === 'searching' || !assignment.courier?.name) return null;
  const onTheWay = order.status === 'delivering';
  const loc = assignment.location;
  const fresh = loc && Number.isFinite(loc.lat) && t(loc.at) && now - t(loc.at) <= TRACK.locationFreshMs;
  return {
    name: assignment.courier.name,
    // Telefon FAQAT kuryer yo'lda bo'lganda (mijoz bog'lana olishi uchun)
    phone: onTheWay ? assignment.courier.phone || null : null,
    vehicle: assignment.courier.vehicle || null,
    vehicleLabel: VEHICLE_LABEL[assignment.courier.vehicle] || null,
    deliveries: stats?.deliveries ?? 0,
    rating: stats && stats.ratingCount >= TRACK.minRatingCount ? Math.round(stats.rating * 10) / 10 : null,
    ratingCount: stats?.ratingCount ?? 0,
    // Joylashuv — faqat yo'lda va yangi bo'lsa (yakunlangach/eskirgach berilmaydi)
    location: onTheWay && fresh ? { lat: loc.lat, lng: loc.lng, heading: loc.heading ?? null, at: iso(loc.at) } : null,
  };
}

/** Kuryerning yetkazib bergan buyurtmalari soni va o'rtacha bahosi (telefon bo'yicha) */
async function courierStats(phone) {
  if (!phone) return { deliveries: 0, rating: 0, ratingCount: 0 };
  const done = await DeliveryAssignment.find({ 'courier.phone': phone, status: 'delivered' }).select('orderId').limit(1000).lean();
  if (!done.length) return { deliveries: 0, rating: 0, ratingCount: 0 };
  const agg = await Order.aggregate([
    { $match: { _id: { $in: done.map((d) => d.orderId) }, rating: { $gte: 1 } } },
    { $group: { _id: null, avg: { $avg: '$rating' }, n: { $sum: 1 } } },
  ]);
  return { deliveries: done.length, rating: agg[0]?.avg ?? 0, ratingCount: agg[0]?.n ?? 0 };
}

/* ───────────── Bitta javob ───────────── */
export async function getOrderTrack(orderId, userId, now = Date.now()) {
  const o = await Order.findOne({ _id: orderId, userId }).lean();
  if (!o) return null;

  const dishIds = (o.items || []).map((i) => i.dishId).filter(Boolean);
  const [rest, dishes, assignment] = await Promise.all([
    Restaurant.findById(o.restaurantId).select('name imageUrl images address phone lat lng').lean(),
    dishIds.length ? Dish.find({ _id: { $in: dishIds } }).select('imageUrl images prepMinutes').lean() : [],
    o.fulfillment !== 'pickup' && o.fulfillment !== 'dinein'
      ? DeliveryAssignment.findOne({ orderId: o._id, status: { $in: ['assigned', 'delivered'] } }).sort({ assignedAt: -1 }).lean()
      : null,
  ]);
  const dishById = new Map(dishes.map((d) => [String(d._id), d]));

  const restPoint = rest && Number.isFinite(rest.lat) && Number.isFinite(rest.lng) ? { lat: rest.lat, lng: rest.lng } : null;
  const custPoint = Number.isFinite(o.addressLat) && Number.isFinite(o.addressLng) ? { lat: o.addressLat, lng: o.addressLng } : null;
  // Masofa: buyurtmada saqlangan (yaratilganda hisoblangan); yo'q bo'lsa — ikki nuqta orasidan
  const distanceKm = Number.isFinite(o.distanceKm) ? o.distanceKm
    : (restPoint && custPoint ? Math.round(haversineKm(restPoint, custPoint) * 10) / 10 : null);

  const stats = assignment?.courier?.phone ? await courierStats(assignment.courier.phone) : null;
  const courier = courierView(assignment, o, stats, now);
  const prepMinutes = dishes.length ? Math.max(...dishes.map((d) => d.prepMinutes || 0)) : null;
  const { steps, current } = buildSteps(o);
  const eta = estimateEta(o, {
    prepMinutes, distanceKm, courierPoint: courier?.location, customerPoint: custPoint, now,
  });

  return {
    id: String(o._id),
    groupId: o.groupId || null,
    label: o.dailyNumber ? `#${o.dailyNumber}` : null,
    status: o.status,
    fulfillment: o.fulfillment || 'delivery',
    isPaid: Boolean(o.isPaid),
    paymentMethod: o.paymentMethod,
    createdAt: iso(o.createdAt),
    steps,
    currentStep: current,
    eta,
    confirm: confirmPrompt(o, now),
    restaurant: rest ? {
      id: String(rest._id),
      name: rest.name,
      imageUrl: rest.imageUrl || rest.images?.[0] || null,
      address: rest.address || null,
      phone: rest.phone || null,
      point: restPoint,
    } : null,
    customer: { address: o.address || null, note: o.addressNote || null, point: custPoint },
    distanceKm,
    courier,
    items: (o.items || []).map((i) => {
      const d = dishById.get(String(i.dishId));
      return {
        name: i.name,
        quantity: i.quantity,
        unitPrice: i.unitPrice,
        total: (i.unitPrice || 0) * (i.quantity || 1),
        imageUrl: d?.imageUrl || d?.images?.[0] || null,
      };
    }),
    subtotal: o.subtotal,
    deliveryFee: o.deliveryFee || 0,
    total: o.total,
    cancelReason: o.status === 'cancelled' ? o.cancelReason || null : null,
    serverTime: new Date(now).toISOString(),
  };
}
