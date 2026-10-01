import { Restaurant } from '../models/Restaurant.js';
import { RestaurantPin } from '../models/RestaurantPin.js';

/*
 * ═══════════════════════════════════════════════════════════
 * RESTORAN PINLARI — QOIDALAR, TO'QNASHUV, FAOL PINLAR
 * ═══════════════════════════════════════════════════════════
 * Model: models/RestaurantPin.js. Admin: controllers/restaurantPins.js.
 * Mijoz ro'yxati: controllers/catalog.js (activePins).
 */

export const POSITIONS = [1, 2, 3];
const MAX_DAYS = 400;              // bitta pin ko'pi bilan (yil xatosi: 2099 deb yozib yuborish)
const MAX_AHEAD_DAYS = 730;        // boshlanish ko'pi bilan 2 yil keyin
const MIN_MS = 5 * 60_000;         // kamida 5 daqiqa
const START_GRACE_MS = 10 * 60_000; // "hozirdan" — so'rov yetib kelguncha o'tgan vaqtga toqat
const DAY = 86_400_000;

export class PinError extends Error {
  constructor(code, message, status = 400, extra = {}) {
    super(message);
    this.name = 'PinError';
    this.code = code;
    this.status = status;
    this.extra = extra;
  }
}

const fmt = (d) => new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Asia/Tashkent', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
}).format(new Date(d));

/** Holat: bekor / tugagan / faol / rejalashtirilgan */
export function pinStatus(p, now = Date.now()) {
  if (p.cancelledAt) return 'cancelled';
  if (+new Date(p.endsAt) <= now) return 'ended';
  if (+new Date(p.startsAt) <= now) return 'active';
  return 'scheduled';
}

/** [aStart, aEnd) bilan kesishadigan yozuvlar (chegara teng bo'lsa — kesishmaydi: 12:00 da tugab 12:00 da boshlansa mumkin). */
const overlap = (start, end) => ({ startsAt: { $lt: end }, endsAt: { $gt: start } });

function toDate(v, field) {
  const d = new Date(v);
  if (!v || !Number.isFinite(d.getTime())) throw new PinError('INVALID_DATE', `${field} vaqti noto‘g‘ri`);
  return d;
}

function checkWindow(startsAt, endsAt, now, { startFixed = false } = {}) {
  if (endsAt <= startsAt) throw new PinError('INVALID_RANGE', 'Tugash vaqti boshlanishdan keyin bo‘lishi kerak');
  if (endsAt.getTime() <= now) throw new PinError('ENDS_IN_PAST', 'Tugash vaqti o‘tib ketgan');
  if (endsAt - startsAt < MIN_MS) throw new PinError('TOO_SHORT', 'Pin muddati kamida 5 daqiqa bo‘lsin');
  if (endsAt - startsAt > MAX_DAYS * DAY) throw new PinError('TOO_LONG', `Pin muddati ${MAX_DAYS} kundan oshmasin`);
  if (!startFixed && startsAt.getTime() < now - START_GRACE_MS) throw new PinError('START_IN_PAST', 'Boshlanish vaqti o‘tib ketgan');
  if (startsAt.getTime() > now + MAX_AHEAD_DAYS * DAY) throw new PinError('TOO_FAR', 'Boshlanish vaqti juda uzoq kelajakda');
}

async function findConflicts({ restaurantId, position, startsAt, endsAt, excludeId }) {
  const base = { cancelledAt: null, ...overlap(startsAt, endsAt) };
  if (excludeId) base._id = { $ne: excludeId };
  const [slot, same] = await Promise.all([
    RestaurantPin.findOne({ ...base, position }).sort({ startsAt: 1 }).populate('restaurantId', 'name').lean(),
    RestaurantPin.findOne({ ...base, restaurantId, position: { $ne: position } }).sort({ startsAt: 1 }).populate('restaurantId', 'name').lean(),
  ]);
  return { slot, same };
}

const brief = (p) => ({
  _id: String(p._id),
  position: p.position,
  restaurantName: p.restaurantId?.name || '',
  startsAt: p.startsAt,
  endsAt: p.endsAt,
});

function throwConflict({ slot, same }, position) {
  if (slot) {
    throw new PinError(
      'POSITION_BUSY',
      `${position}-o‘rin ${fmt(slot.startsAt)} — ${fmt(slot.endsAt)} oralig‘ida band: ${slot.restaurantId?.name || 'restoran'}`,
      409,
      { conflict: brief(slot) },
    );
  }
  if (same) {
    throw new PinError(
      'RESTAURANT_ALREADY_PINNED',
      `Bu restoran shu vaqtda ${same.position}-o‘rinda pin qilingan (${fmt(same.startsAt)} — ${fmt(same.endsAt)})`,
      409,
      { conflict: brief(same) },
    );
  }
}

/*
 * POYGA HIMOYASI. "Tekshir → yoz" ikki admin bir vaqtda bossa ikkalasi ham
 * o'tib ketadi (MongoDB'da bunday cheklov yo'q). Shuning uchun yozgandan
 * KEYIN qayta tekshiriladi: kesishadigan pinlar ichida ENG KICHIK _id
 * g'olib; yutqazgan o'zini o'chirib 409 qaytaradi. Ikkala tomon ham bir xil
 * tartibni hisoblaydi — aynan bittasi qoladi. (Zanjirli kesishishda ortiqcha
 * rad etilishi mumkin — xavfsiz tomon: admin qayta urinadi.)
 */
async function resolveRace(pin) {
  const rivals = await RestaurantPin.find({
    _id: { $ne: pin._id },
    cancelledAt: null,
    ...overlap(pin.startsAt, pin.endsAt),
    $or: [{ position: pin.position }, { restaurantId: pin.restaurantId }],
  }).sort({ _id: 1 }).populate('restaurantId', 'name').lean();
  const winner = rivals.find((r) => String(r._id) < String(pin._id));
  if (!winner) return;
  await RestaurantPin.deleteOne({ _id: pin._id });
  throw new PinError(
    winner.position === pin.position ? 'POSITION_BUSY' : 'RESTAURANT_ALREADY_PINNED',
    'Shu onda boshqa admin shu o‘rinni band qildi — qayta urinib ko‘ring',
    409,
    { conflict: brief(winner) },
  );
}

// ── Faol pinlar: kichik xotira keshi (10 s). Faollik so'rov vaqtida aniqlanadi, shuning uchun
//    muddat tugashi/boshlanishi keshga bog'liq emas; admin o'zgartirsa kesh darhol tozalanadi. ──
// PINS_CACHE_MS — FAQAT testlar uchun (admin o'zgartirishi keshni baribir darhol tozalaydi)
const CACHE_MS = Number(process.env.PINS_CACHE_MS) || 10_000;
let cache = { at: 0, pins: [] };
export const invalidatePinsCache = () => { cache = { at: 0, pins: [] }; };

/** Hozir faol pinlar: [{ restaurantId, position, startsAt, endsAt }] — o'rin bo'yicha tartiblangan. */
export async function activePins(now = Date.now()) {
  if (now - cache.at > CACHE_MS || now < cache.at) {
    cache = {
      at: now,
      pins: await RestaurantPin.find({ cancelledAt: null, endsAt: { $gt: new Date(now) } })
        .select('restaurantId position startsAt endsAt').lean(),
    };
  }
  return cache.pins
    .filter((p) => +new Date(p.startsAt) <= now && +new Date(p.endsAt) > now)
    .sort((a, b) => a.position - b.position);
}

async function loadRestaurant(id) {
  const r = await Restaurant.findById(id).select('name isApproved isActive isBlocked').lean();
  if (!r) throw new PinError('RESTAURANT_NOT_FOUND', 'Restoran topilmadi', 404);
  return r;
}

export const isListed = (r) => Boolean(r?.isApproved && r?.isActive && !r?.isBlocked);

export async function createPin({ restaurantId, position, startsAt, endsAt, note = '', actor = {} }, now = Date.now()) {
  if (!POSITIONS.includes(position)) throw new PinError('INVALID_POSITION', 'O‘rin 1, 2 yoki 3 bo‘lishi kerak');
  const s = toDate(startsAt, 'Boshlanish');
  const e = toDate(endsAt, 'Tugash');
  checkWindow(s, e, now);

  const restaurant = await loadRestaurant(restaurantId);
  if (!isListed(restaurant)) {
    throw new PinError('RESTAURANT_NOT_LISTED', 'Restoran mijozlarga ko‘rinmaydi (tasdiqlanmagan, faol emas yoki bloklangan) — pin ma’nosiz', 400);
  }

  throwConflict(await findConflicts({ restaurantId, position, startsAt: s, endsAt: e }), position);

  const pin = await RestaurantPin.create({
    restaurantId, position, startsAt: s, endsAt: e, note: String(note || '').trim().slice(0, 200),
    createdBy: actor.id || null, createdByName: actor.name || '',
  });
  await resolveRace(pin);
  invalidatePinsCache();
  return pin;
}

/** Vaqtni o'zgartirish (odatda uzaytirish). Boshlangan pinning boshlanishi o'zgarmaydi. */
export async function updatePin(id, { startsAt, endsAt, note }, now = Date.now()) {
  const pin = await RestaurantPin.findById(id);
  if (!pin) throw new PinError('PIN_NOT_FOUND', 'Pin topilmadi', 404);
  const st = pinStatus(pin, now);
  if (st === 'cancelled' || st === 'ended') throw new PinError('PIN_ENDED', 'Tugagan yoki bekor qilingan pinni o‘zgartirib bo‘lmaydi', 400);

  const started = st === 'active';
  const s = startsAt !== undefined ? toDate(startsAt, 'Boshlanish') : pin.startsAt;
  const e = endsAt !== undefined ? toDate(endsAt, 'Tugash') : pin.endsAt;
  if (started && +s !== +pin.startsAt) throw new PinError('PIN_STARTED', 'Boshlangan pinning boshlanish vaqtini o‘zgartirib bo‘lmaydi', 400);
  checkWindow(s, e, now, { startFixed: started || startsAt === undefined });

  throwConflict(await findConflicts({ restaurantId: pin.restaurantId, position: pin.position, startsAt: s, endsAt: e, excludeId: pin._id }), pin.position);

  const before = { startsAt: pin.startsAt, endsAt: pin.endsAt };
  pin.startsAt = s; pin.endsAt = e;
  if (note !== undefined) pin.note = String(note || '').trim().slice(0, 200);
  await pin.save();
  try {
    await resolveRace(pin);
  } catch (err) {
    // yangilanish poygada yutqazdi — eski vaqtni tiklaymiz (pin o'chirilmasligi kerak, u oldin ham bor edi)
    await RestaurantPin.updateOne({ _id: pin._id }, before);
    throw err;
  }
  invalidatePinsCache();
  return pin;
}

/** Pindan chiqarish: faol bo'lsa — darhol; rejalashtirilgan bo'lsa — bekor (o'rin bo'shaydi). Takrorlash xavfsiz. */
export async function cancelPin(id, now = Date.now()) {
  const pin = await RestaurantPin.findById(id);
  if (!pin) throw new PinError('PIN_NOT_FOUND', 'Pin topilmadi', 404);
  if (!pin.cancelledAt && +pin.endsAt > now) {
    pin.cancelledAt = new Date(now);
    await pin.save();
    invalidatePinsCache();
  }
  return pin;
}

/** Admin ro'yxati: faol + rejalashtirilgan (history=true bo'lsa — oxirgi 60 kunda tugagan/bekor qilinganlar ham). */
export async function listPins({ history = false } = {}, now = Date.now()) {
  const since = new Date(now - 60 * DAY);
  const filter = history
    ? { $or: [{ cancelledAt: null, endsAt: { $gt: new Date(now) } }, { endsAt: { $gt: since } }, { cancelledAt: { $gt: since } }] }
    : { cancelledAt: null, endsAt: { $gt: new Date(now) } };
  const rows = await RestaurantPin.find(filter)
    .populate('restaurantId', 'name imageUrl images isApproved isActive isBlocked')
    .sort({ position: 1, startsAt: 1 })
    .limit(300)
    .lean();
  return rows.map((p) => ({
    _id: String(p._id),
    restaurantId: String(p.restaurantId?._id || p.restaurantId),
    restaurant: p.restaurantId?._id
      ? { _id: String(p.restaurantId._id), name: p.restaurantId.name, imageUrl: p.restaurantId.imageUrl || '', visible: isListed(p.restaurantId) }
      : null,
    position: p.position,
    startsAt: p.startsAt,
    endsAt: p.endsAt,
    cancelledAt: p.cancelledAt,
    status: pinStatus(p, now),
    note: p.note || '',
    createdByName: p.createdByName || '',
    createdAt: p.createdAt,
  }));
}
