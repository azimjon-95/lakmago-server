import { Notification, nextSeq } from '../models/Notification.js';
import { getIO } from '../sockets/io.js';
import { sendPush } from './push.js';

/**
 * Markaziy bildirishnoma xizmati.
 *
 * Yagona oqim:
 *   Biznes hodisa → notify() → bazaga yozish → Socket.IO → UI + ovoz
 *
 * Avval har sahifa o'zi socket hodisasini eshitib, o'zi ovoz
 * chalardi. Natijada: bir hodisa ikki joyda ovoz berardi, socket
 * uzilsa hodisa butunlay yo'qolardi, panel yangilansa bajarilmagan
 * ish esdan chiqardi. Endi hammasi shu yerdan o'tadi.
 */

/** Har tur uchun muhimlik — bitta joyda belgilanadi. */
const PRIORITY_BY_TYPE = {
  waiter_call: 'CRITICAL',   // mijoz stolda kutib turibdi
  bill_request: 'CRITICAL',
  hall_order: 'HIGH',
  order: 'HIGH',
  reservation: 'NORMAL',
  support: 'NORMAL',
};

/** Har tur uchun ovoz — bitta joyda belgilanadi. */
const SOUND_BY_TYPE = {
  order: 'orders',
  hall_order: 'hall-orders',
  reservation: 'reservations',
  waiter_call: 'hall-orders',
  bill_request: 'hall-orders',
  support: 'none',
};

/**
 * Bildirishnoma yaratadi va tarqatadi.
 *
 * @param {string} notificationId  takrorlanmas kalit ("order:<id>")
 * @param {string} audience        'admin' | 'restaurant'
 * @param {string} type            order | hall_order | reservation | ...
 * @returns {object|null} yaratilgan yozuv, dublikat bo'lsa null
 */
export async function notify({
  notificationId, audience, restaurantId, branchId, type,
  title, body = '', refType = '', refId = '', meta = {}, priority,
}) {
  if (!notificationId || !type || !title) return null;

  // Bazada bor bo'lsa — bu takroriy hodisa, hech narsa qilmaymiz.
  // (Masalan retry yoki ikki marta emit qilingan.)
  const exists = await Notification.exists({ notificationId });
  if (exists) return null;

  let doc;
  try {
    doc = await Notification.create({
      notificationId,
      audience,
      restaurantId: restaurantId || undefined,
      branchId: branchId || undefined,
      type,
      priority: priority || PRIORITY_BY_TYPE[type] || 'NORMAL',
      title,
      body,
      sound: SOUND_BY_TYPE[type] ?? 'orders',
      refType,
      refId: refId ? String(refId) : '',
      status: 'NEW',
      seq: await nextSeq(),
      meta,
    });
  } catch (err) {
    // Ikki so'rov bir vaqtda kelsa unique indeks ushlaydi —
    // bu xato emas, kutilgan holat
    if (err?.code === 11000) return null;
    throw err;
  }

  emitNotification(doc);

  // Brauzer yopiq bo'lsa ham yetib borsin. Push xatosi asosiy
  // oqimni to'xtatmasligi kerak — shuning uchun kutilmaydi.
  sendPush(toPayload(doc)).catch((e) => console.error('[push]', e.message));

  return doc.toObject();
}

/** Socket orqali tegishli xonaga yuborish. */
function emitNotification(doc) {
  const io = getIO();
  if (!io) return;

  const payload = toPayload(doc);
  const room = doc.audience === 'admin' ? 'admin' : `restaurant:${doc.restaurantId}`;
  io.to(room).emit('notification:new', payload);

  // Admin zalni ham kuzatadi — restoran hodisalari unga ham boradi
  if (doc.audience === 'restaurant') {
    io.to('admin').emit('notification:new', { ...payload, mirrored: true });
  }
}

export function toPayload(doc) {
  return {
    notificationId: doc.notificationId,
    seq: doc.seq,
    audience: doc.audience,
    restaurantId: doc.restaurantId ? String(doc.restaurantId) : null,
    branchId: doc.branchId ? String(doc.branchId) : null,
    type: doc.type,
    priority: doc.priority || 'NORMAL',
    title: doc.title,
    body: doc.body,
    sound: doc.sound,
    refType: doc.refType,
    refId: doc.refId,
    status: doc.status,
    meta: doc.meta || {},
    createdAt: doc.createdAt,
  };
}

/**
 * Uzilishdan keyin yo'qolganlarini olib kelish.
 * Mijoz oxirgi ko'rgan seq'ini yuboradi.
 */
export async function listSince({ audience, restaurantId, afterSeq = 0, limit = 100 }) {
  const filter = { audience, seq: { $gt: Number(afterSeq) || 0 } };
  if (audience === 'restaurant') filter.restaurantId = restaurantId;

  const docs = await Notification.find(filter)
    .sort({ seq: 1 })
    .limit(Math.min(Number(limit) || 100, 200))
    .lean();

  return docs.map(toPayload);
}

/** Hali javob berilmagan bildirishnomalar (panel qayta yuklanganda). */
export async function listPending({ audience, restaurantId, limit = 50 }) {
  const filter = { audience, status: { $in: ['NEW', 'DELIVERED', 'SEEN'] } };
  if (audience === 'restaurant') filter.restaurantId = restaurantId;

  const docs = await Notification.find(filter)
    .sort({ seq: -1 })
    .limit(Math.min(Number(limit) || 50, 100))
    .lean();

  return docs.reverse().map(toPayload);
}

const ALLOWED = ['DELIVERED', 'SEEN', 'ACCEPTED', 'CANCELLED', 'MUTED'];

/** Holatni o'zgartirish. Orqaga qaytmaydi: ACCEPTED → SEEN bo'lmaydi. */
const RANK = { NEW: 0, DELIVERED: 1, SEEN: 2, MUTED: 3, ACCEPTED: 4, CANCELLED: 4 };

export async function setStatus(notificationId, status) {
  if (!ALLOWED.includes(status)) return null;

  const doc = await Notification.findOne({ notificationId });
  if (!doc) return null;

  // Yakuniy holatdan orqaga qaytarmaymiz
  if (RANK[status] <= RANK[doc.status] && doc.status !== 'NEW') {
    return toPayload(doc);
  }

  doc.status = status;
  await doc.save();

  const io = getIO();
  const room = doc.audience === 'admin' ? 'admin' : `restaurant:${doc.restaurantId}`;
  io?.to(room).emit('notification:status', {
    notificationId: doc.notificationId,
    status: doc.status,
  });

  return toPayload(doc);
}
