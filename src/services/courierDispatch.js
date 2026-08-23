import crypto from 'crypto';
import { DeliveryAssignment } from '../models/DeliveryAssignment.js';
import { Order } from '../models/Order.js';
import { config } from '../config/index.js';
import { getIO } from '../sockets/io.js';

/**
 * Kuryer ulashish xizmati — BOSQICH 1 (2026-08).
 *
 * LokmaGo'da hali ro'yxatdan o'tgan ishchi kuryerlar yo'q.
 * Shuning uchun bot orqali avtomatik yuborish o'rniga: restoran/
 * admin BITTA havola oladi va uni o'zining shaxsiy Telegram/
 * WhatsApp akkaunti orqali xohlagan odam(lar)ga yuboradi.
 *
 * Xavfsizlik modeli — LOGIN YO'Q, lekin XATOLARGA CHIDAMLI:
 *   1) Havoladagi `token` — barcha oluvchilarda BIR XIL (forward
 *      qilinishi mumkin). Bu orqali FAQAT umumiy/taxminiy
 *      ma'lumot (restoran, mijoz mahallasi) ko'rinadi.
 *   2) Kimdir "Qabul qilaman" bossa — server unga ALOHIDA,
 *      TASODIFIY `acceptanceSecret` qaytaradi (javobda, URL'da
 *      EMAS). Bu qurilma shu maxfiy qiymatni localStorage'da
 *      saqlaydi va keyingi so'rovlarida yuboradi.
 *   3) Shu maxfiy qiymatga ega qurilma GINA to'liq manzil/
 *      telefon ko'radi va "Topshirdim" bosa oladi. Boshqa hech
 *      kim (hatto asl havolani yana ochsa ham) bu qila olmaydi.
 */

function randomToken() {
  return crypto.randomBytes(24).toString('base64url');
}

/**
 * Buyurtma uchun ulashish havolasini yaratadi.
 *
 * @returns {{ token, assignmentId }}
 */
export async function createShareLink(orderId) {
  const order = await Order.findById(orderId)
    .populate('restaurantId', 'name address lat lng')
    .lean();
  if (!order) throw new Error('Buyurtma topilmadi');

  const restaurant = order.restaurantId || {};
  const itemsSummary = (order.items || [])
    .map((i) => `${i.quantity}x ${i.name}`)
    .join(', ');

  const assignment = await DeliveryAssignment.create({
    orderId: order._id,
    restaurantId: restaurant._id || order.restaurantId,
    status: 'searching',
    token: randomToken(),
    deliverySnapshot: {
      addressLabel: order.address || '',
      lat: order.addressLat ?? null,
      lng: order.addressLng ?? null,
      addressNote: order.addressNote || '',
      customerPhone: order.phone || '',
      restaurantName: restaurant.name || '',
      restaurantAddress: restaurant.address || '',
      restaurantLat: restaurant.lat ?? null,
      restaurantLng: restaurant.lng ?? null,
      itemsSummary,
      total: order.total || 0,
    },
  });

  return { token: assignment.token, assignmentId: assignment._id };
}

/**
 * TOKEN (+ ixtiyoriy `secret`) bo'yicha ko'rsatiladigan holatni
 * aniqlaydi.
 *
 * `secret` berilmagan yoki mos kelmagan bo'lsa, hatto shu
 * qurilma AVVAL qabul qilgan bo'lsa ham, u "begona" deb
 * hisoblanadi — bu ATAYLAB shunday: maxfiy kalitni yo'qotgan
 * qurilma xavfsizlik nuqtai nazaridan oddiy yangi tashrifchidan
 * farq qilmaydi.
 */
export async function getShareView(token, secret) {
  const assignment = await DeliveryAssignment.findOne({ token }).lean();
  if (!assignment) return { view: 'not_found' };

  const isOwner = !!secret && !!assignment.acceptanceSecret && secret === assignment.acceptanceSecret;

  if (assignment.status === 'delivered') {
    return { view: isOwner ? 'delivered' : 'closed', assignment };
  }
  if (assignment.status === 'assigned') {
    return { view: isOwner ? 'mine' : 'taken', assignment };
  }
  return { view: 'offer', assignment };
}

/**
 * "Qabul qilaman" bosilganda.
 *
 * ATOMIK YOZUV — POYGA HOLATI YECHIMI: bir nechta odam bir xil
 * havolani (forward qilingan) AYNI PAYTDA ochib "qabul qilaman"
 * bossa, MongoDB `findOneAndUpdate` FAQAT status:'searching'
 * shartiga mos kelgan BIRINCHI so'rovni qabul qiladi — qolganlari
 * uchun natija `null` bo'ladi (chunki ular so'rov yuborgan payt
 * status allaqachon 'assigned'ga o'zgargan bo'ladi).
 *
 * @returns {{ ok, secret? , error? }}
 */
export async function acceptShare(token) {
  const secret = randomToken();

  const won = await DeliveryAssignment.findOneAndUpdate(
    { token, status: 'searching' },   // ATOMIK SHART
    { status: 'assigned', assignedAt: new Date(), acceptanceSecret: secret },
    { new: true },
  );

  if (!won) {
    return { ok: false, error: 'Bu buyurtmani boshqa kuryer allaqachon oldi' };
  }

  await Order.findByIdAndUpdate(won.orderId, { status: 'delivering' });

  getIO()?.to('admin').emit('order:update', { _id: won.orderId, status: 'delivering' });
  getIO()?.to(`restaurant:${won.restaurantId}`).emit('order:update', { _id: won.orderId, status: 'delivering' });

  return { ok: true, secret };
}

/** "Topshirdim" tasdiqlanganda — FAQAT to'g'ri `secret` bilan. */
export async function deliverShare(token, secret) {
  const assignment = await DeliveryAssignment.findOne({ token }).lean();
  if (!assignment) return { ok: false, error: 'Havola topilmadi' };

  if (assignment.status === 'delivered') {
    return { ok: secret === assignment.acceptanceSecret, alreadyDelivered: true };
  }
  if (assignment.status !== 'assigned' || secret !== assignment.acceptanceSecret) {
    return { ok: false, error: 'Bu buyurtma sizga tegishli emas' };
  }

  const updated = await DeliveryAssignment.findOneAndUpdate(
    { _id: assignment._id, status: 'assigned' },
    { status: 'delivered', deliveredAt: new Date() },
    { new: true },
  );
  if (!updated) return { ok: false, error: 'Holat allaqachon o\u2018zgargan' };

  await Order.findByIdAndUpdate(assignment.orderId, { status: 'delivered', deliveredAt: new Date() });

  getIO()?.to('admin').emit('order:update', { _id: assignment.orderId, status: 'delivered' });
  getIO()?.to(`restaurant:${assignment.restaurantId}`).emit('order:update', { _id: assignment.orderId, status: 'delivered' });

  return { ok: true };
}

/** Havola manzillari — ulashish tugmalari uchun. */
export function buildShareUrls(token) {
  const link = `${config.courierAppUrl}/k/${token}`;
  const text = `\ud83d\udce6 Yangi yetkazish buyurtmasi. Qabul qilish uchun havolani oching:`;
  return {
    link,
    telegram: `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(text)}`,
    whatsapp: `https://wa.me/?text=${encodeURIComponent(`${text} ${link}`)}`,
  };
}
