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
    .populate('restaurantId', 'name address lat lng phone')
    .populate('userId', 'firstName lastName username telegramId phone')
    .lean();
  if (!order) throw new Error('Buyurtma topilmadi');

  const restaurant = order.restaurantId || {};
  const user = order.userId || {};

  /*
   * Taomlar IKKI shaklda saqlanadi:
   *   items       — ro'yxat sifatida chizish uchun
   *   itemsSummary — Telegram matni va eski ekranlar uchun
   *
   * Ilgari faqat qo'shib yuborilgan satr bor edi va kuryer
   * sahifasida taomlar bir uzun qator bo'lib chiqardi — nechta
   * nima kelayotganini ajratib bo'lmasdi.
   */
  const items = (order.items || []).map((i) => ({
    name: i.name,
    quantity: i.quantity,
    total: (i.unitPrice || 0) * (i.quantity || 1),
  }));
  const itemsSummary = items.map((i) => `${i.quantity}x ${i.name}`).join(', ');

  const customerName = [user.firstName, user.lastName].filter(Boolean).join(' ')
    || order.customerName || '';

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
      customerPhone: order.phone || user.phone || '',

      // Mijoz — kuryer kim bilan uchrashishini bilishi kerak
      customerName,
      customerUsername: user.username || '',
      customerTelegramId: user.telegramId ? String(user.telegramId) : '',

      restaurantName: restaurant.name || '',
      restaurantAddress: restaurant.address || '',
      restaurantLat: restaurant.lat ?? null,
      restaurantLng: restaurant.lng ?? null,
      restaurantPhone: restaurant.phone || '',

      items,
      itemsSummary,
      subtotal: order.subtotal || 0,
      deliveryFee: order.deliveryFee || 0,
      total: order.total || 0,

      /*
       * PUL YIG'ISH — kuryer uchun eng muhim ma'lumot.
       *
       * Ilgari bu UMUMAN yo'q edi: kuryer mijozdan pul olish
       * kerakmi yoki buyurtma allaqachon to'langanmi bilmasdi.
       * Xato ikki tomonga ham qimmat — pulsiz ketish yoki
       * to'langan buyurtma uchun ikkinchi marta so'rash.
       */
      paymentMethod: order.paymentMethod || 'cash',
      isPaid: !!order.isPaid,
      collectAmount: order.isPaid ? 0 : (order.total || 0),

      orderCode: String(order._id).slice(-6),
      note: order.note || '',
    },
  });

  return {
    token: assignment.token,
    assignmentId: assignment._id,
    snapshot: assignment.deliverySnapshot,
  };
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

const money = (n) => Number(n || 0).toLocaleString('ru-RU').replace(/\u00a0/g, ' ');

/**
 * Kuryerga yuboriladigan e'lon matni.
 *
 * ILGARI bitta quruq qator edi: "Yangi yetkazish buyurtmasi".
 * Kuryer havolani ochmasdan turib qabul qilish-qilmaslikni
 * hal qila olmasdi — qayerdan, qayerga, qancha pul, hammasi
 * noma'lum. Bir nechta kuryerga yuborilganda esa har biri
 * havolani ochib ko'rishga majbur bo'lardi va birinchi bo'lib
 * ochgan olib ketardi, eng yaqini emas.
 *
 * Endi asosiy narsa MATNDA: masofa haqida qaror qabul qilish
 * uchun yetarli, lekin MIJOZNING ANIQ MANZILI VA TELEFONI
 * YO'Q — ular faqat qabul qilgandan keyin, sahifada ko'rinadi.
 * Sabab: bu xabar cheksiz forward qilinishi mumkin.
 *
 * Telegram share havolasida markdown ISHLAMAYDI — matn oddiy
 * holda ketadi, shuning uchun tuzilma emoji va bo'sh qatorlar
 * bilan beriladi.
 */
function buildShareText(snap = {}) {
  const lines = [];

  lines.push('\ud83d\udef5 YANGI BUYURTMA');
  if (snap.orderCode) lines.push(`#${snap.orderCode}`);
  lines.push('');

  // Qayerdan
  if (snap.restaurantName) {
    lines.push(`\ud83c\udfea ${snap.restaurantName}`);
    if (snap.restaurantAddress) lines.push(`   ${snap.restaurantAddress}`);
  }

  // Qayerga — faqat tuman/mo'ljal darajasida
  if (snap.addressLabel) {
    lines.push(`\ud83d\udccd ${snap.addressLabel}`);
  }
  lines.push('');

  // Taomlar — ko'pi bilan 4 ta, qolgani "+N"
  const items = snap.items || [];
  if (items.length) {
    items.slice(0, 4).forEach((i) => lines.push(`\u2022 ${i.quantity}x ${i.name}`));
    if (items.length > 4) lines.push(`\u2022 +${items.length - 4} ta boshqa`);
    lines.push('');
  }

  // Pul — kuryer uchun hal qiluvchi
  if (snap.deliveryFee) lines.push(`\ud83d\udcb0 Yetkazish haqi: ${money(snap.deliveryFee)} so'm`);

  if (snap.isPaid) {
    lines.push(`\u2705 To'langan \u2014 mijozdan pul olinmaydi`);
  } else if (snap.collectAmount) {
    lines.push(`\ud83d\udcb5 Mijozdan olinadi: ${money(snap.collectAmount)} so'm (naqd)`);
  }

  lines.push('');
  lines.push('\ud83d\udc47 Qabul qilish uchun havolani oching');
  lines.push('Birinchi qabul qilgan kuryer oladi');

  return lines.join('\n');
}

/** Havola manzillari — ulashish tugmalari uchun. */
export function buildShareUrls(token, snapshot) {
  const link = `${config.courierAppUrl}/k/${token}`;
  const text = buildShareText(snapshot);

  return {
    link,
    text,
    /*
     * Telegram `text` ni havoladan ALOHIDA oladi va havola
     * oldindan ko'rinish (preview) bilan chiqadi.
     * WhatsApp'da esa hammasi bitta matn — havola oxiriga
     * qo'shiladi.
     */
    telegram: `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(text)}`,
    whatsapp: `https://wa.me/?text=${encodeURIComponent(`${text}\n\n${link}`)}`,
  };
}
