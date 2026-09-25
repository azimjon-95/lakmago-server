import { Order } from '../models/Order.js';
import { User } from '../models/User.js';
import { getIO } from '../sockets/io.js';
import { notifyUser } from './telegram.js';

/*
 * ═══════════════════════════════════════════════════════════
 * BUYURTMA OQIMI — YAGONA MANBA
 * ═══════════════════════════════════════════════════════════
 *
 * NIMA UCHUN BU FAYL PAYDO BO'LDI
 *
 * Buyurtma statusini o'zgartirish mantig'i restaurantPanel.js
 * kontrolleri ICHIDA edi: `req` dan o'qib, `res` ga yozardi.
 * Telegram bot uchun bu yaramaydi — botda `req`/`res` yo'q.
 *
 * Uni ko'chirib yozish eng oson yo'l bo'lardi, lekin o'shanda
 * ikkita joyda ikkita mantiq paydo bo'lardi: bugun bir xil,
 * ertaga birida tuzatish kiritiladi va ikkinchisi eskirib
 * qoladi. Buyurtma statusi bilan bunday bo'lishi juda qimmat —
 * pul, restoran balansi va mijoz xabarnomalari shunga bog'liq.
 *
 * Shuning uchun mantiq shu yerga ko'chirildi. Kontroller ham,
 * bot ham AYNAN shu funksiyani chaqiradi.
 *
 * ═══ MUHIM: BU YERDA HTTP YO'Q ═══
 * Funksiya `res.status(400)` qaytarmaydi — u xato tashlaydi
 * yoki natija obyektini qaytaradi. HTTP javobini kontroller
 * o'zi hal qiladi, bot esa Telegram xabarini.
 */

/** Restoran o'zgartira oladigan statuslar. */
export const RESTAURANT_STATUSES = ['accepted', 'preparing', 'ready', 'delivering', 'delivered', 'cancelled'];

/*
 * ═══ FAQAT OLIB KETISH UCHUN ═══
 *
 * 'delivered' (yakunlandi) ni restoran FAQAT olib ketish
 * buyurtmasiga qo'ya oladi: mijoz taomni xodimning qo'lidan
 * olgan, bundan ortiq tasdiq kerak emas.
 *
 * Yetkazib berishda bu TAQIQLANGAN — u yerda buyurtmani kuryer
 * ("Topshirdim") yoki mijoz ("Oldim") yakunlaydi. Restoran o'zi
 * yakunlay olsa, kuryer taomni hali yetkazmasdan komissiya
 * hisoblanib ketardi.
 *
 * Avval pickup "Mijoz olib ketdi" bilan 'delivering' da qolib
 * ketardi: mijozga 20 daqiqadan keyin "Buyurtmangizni oldingizmi?"
 * savoli borardi, komissiya esa u javob berguncha (yoki 12 soat)
 * hisoblanmasdi.
 */
const PICKUP_ONLY_STATUSES = new Set(['delivered']);

/*
 * Statusdan OLDIN qanday holatda bo'lishi kerak.
 *
 * NIMA UCHUN KERAK (TZ 18-band): bitta restoranga bir nechta
 * Telegram xodim ulanadi va yangi buyurtma HAMMASIGA boradi.
 * Ikki xodim bir vaqtda "Qabul qilish" bossa, ilgari IKKALASI
 * ham muvaffaqiyat olardi — filtrda status tekshirilmasdi va
 * ikkinchisi birinchisining yozuvini bosib ketardi.
 *
 * Endi filtrga joriy status ham qo'shiladi. Bu BITTA atomik
 * MongoDB amali: birinchi so'rov o'tadi, ikkinchisi `null`
 * oladi va "boshqa xodim allaqachon qabul qilgan" degan
 * javob beriladi. Qo'shimcha qulf yoki tranzaksiya kerak emas.
 */
const REQUIRED_PREVIOUS = {
  accepted: ['pending'],
  preparing: ['accepted'],
  /*
   * 'accepted' dan ham — admin panel ("Taom tayyor") va bot
   * ("✅ Tayyor") qabul qilingan buyurtmani TO'G'RIDAN-TO'G'RI
   * tayyorga o'tkazadi. Avval faqat 'preparing' ruxsat etilgani
   * uchun paneldagi tugma "allaqachon accepted holatida" xatosini
   * berardi. Eski buyurtmalar uchun 'preparing' ham qoladi.
   */
  ready: ['accepted', 'preparing'],
  delivering: ['ready'],
  // Olib ketish: 'delivering' — eski yo'l (panel yoki yangilanishdan
  // oldingi buyurtmalar) orqali kelganlarni ham yakunlash uchun
  delivered: ['ready', 'delivering'],
  // Bekor qilish yakunlanmagan har qanday holatdan mumkin
  cancelled: ['pending', 'accepted', 'preparing', 'ready'],
};

export class OrderFlowError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const STATUS_TEXT = {
  accepted: '✅ Buyurtmangiz qabul qilindi',
  preparing: '👨‍🍳 Buyurtmangiz tayyorlanmoqda',
  ready: '🍽 Buyurtmangiz tayyor',
  delivering: '🚴 Buyurtmangiz yo‘lga chiqdi, tez orada yetib keladi',
  delivered: '✅ Buyurtmangiz yetkazildi. Yoqimli ishtaha!',
  cancelled: '❌ Buyurtmangiz bekor qilindi',
};

/**
 * Buyurtma statusini o'zgartirish.
 *
 * @param {object} p
 * @param {string} p.orderId
 * @param {string} p.restaurantId - EGALIK tekshiruvi. Telegram
 *   botda bu xodimning bog'langan restorani bo'ladi, ya'ni
 *   boshqa restoran buyurtmasiga tegib bo'lmaydi (TZ 20-band).
 * @param {string} p.status
 * @param {string} [p.actorName] - kim o'zgartirdi (Telegram
 *   xodimi ismi). Xabarlarda ko'rsatiladi.
 * @returns {Promise<{order: object, changed: boolean}>}
 */
export async function changeOrderStatus({ orderId, restaurantId, status, actorName = '', cancelReason }) {
  if (!RESTAURANT_STATUSES.includes(status)) {
    throw new OrderFlowError('INVALID_STATUS', 'Noto‘g‘ri status');
  }

  const before = await Order.findOne({ _id: orderId, restaurantId })
    .select('status fulfillment').lean();
  if (!before) throw new OrderFlowError('NOT_FOUND', 'Buyurtma topilmadi');

  const pickupOnly = PICKUP_ONLY_STATUSES.has(status);
  if (pickupOnly && before.fulfillment !== 'pickup') {
    throw new OrderFlowError(
      'WRONG_STATE',
      'Yetkazib berish buyurtmasini kuryer yoki mijoz yakunlaydi',
    );
  }

  // Allaqachon shu holatda — hech narsa qilmaymiz, lekin xato ham emas.
  // Tugma ikki marta bosilgan bo'lishi mumkin.
  if (before.status === status) {
    const order = await Order.findById(orderId).populate('userId');
    return { order, changed: false };
  }

  const allowedFrom = REQUIRED_PREVIOUS[status] || [];
  if (!allowedFrom.includes(before.status)) {
    throw new OrderFlowError(
      'WRONG_STATE',
      `Bu buyurtma allaqachon "${before.status}" holatida`,
    );
  }

  const update = { status };
  if (status === 'accepted') update.acceptedAt = new Date();
  if (status === 'ready') update.readyAt = new Date();
  if (status === 'cancelled') update.cancelledAt = new Date();
  if (status === 'delivered') update.deliveredAt = new Date();
  /*
   * Rad etish sababi status bilan BITTA atomik yozuvda — avval
   * alohida updateOne bilan keyin yozilardi va xodimlarning
   * Telegram xabari sababsiz yangilanib qolardi.
   */
  if (status === 'cancelled' && typeof cancelReason === 'string' && cancelReason.trim()) {
    update.cancelReason = cancelReason.trim().slice(0, 200);
  }
  /*
   * actorName ATAYLAB bazaga yozilmaydi — Order modelida bunday
   * maydon yo'q va uni faqat log uchun qo'shish sxemani
   * kengaytirishga arzimaydi. U qaytariladi, chaqiruvchi
   * (bot) uni xabar matnida ishlatadi: "Eldorbek qabul qildi".
   */

  /*
   * ATOMIK: filtrda `status: { $in: allowedFrom }` bor.
   * Shu qator TZ 18-bandini ta'minlaydi.
   */
  const order = await Order.findOneAndUpdate(
    // pickupOnly: turi ham filtrda — tekshiruv bilan yozuv orasida
    // hech narsa o'zgarib qololmaydi
    { _id: orderId, restaurantId, status: { $in: allowedFrom }, ...(pickupOnly ? { fulfillment: 'pickup' } : {}) },
    update,
    { new: true },
  ).populate('userId');

  if (!order) {
    // Boshqa xodim (yoki panel) shu oniyda o'zgartirib ulgurdi
    throw new OrderFlowError('RACE_LOST', 'Buyurtmani boshqa xodim allaqachon o‘zgartirdi');
  }

  // Bekor qilinsa — ishlatilgan bonus mijozga qaytariladi
  if (status === 'cancelled' && order.bonusUsed > 0) {
    await User.updateOne(
      { _id: order.userId?._id || order.userId },
      { $inc: { bonusBalance: order.bonusUsed } },
    );
  }

  await runSideEffects(order, status);
  broadcast(order);

  /*
   * ═══ TELEGRAM XABARLARINI YANGILASH ═══
   *
   * TZ 12-band: status QAYERDAN o'zgarishidan qat'i nazar,
   * boshqa interfeys ham yangilanishi kerak.
   *
   * Bu chaqiruv aynan shu joyda turgani uchun ikki yo'nalish
   * ham avtomatik ishlaydi:
   *   • paneldan o'zgartirilsa -> xodimlarning Telegram
   *     xabaridagi tugmalar yangilanadi
   *   • botdan o'zgartirilsa -> broadcast() panelni yangilaydi
   *     va shu qator qolgan xodimlarning xabarini yangilaydi
   *
   * Dinamik import — aylanma bog'liqlikning oldini oladi
   * (restaurantBotOrders o'z navbatida shu faylni chaqiradi).
   *
   * `await` YO'Q: Telegram sekin javob bersa, panel javobi
   * kutib qolmasligi kerak. Xato bo'lsa ham status o'zgarishi
   * bekor qilinmaydi.
   */
  import('./restaurantBotOrders.js')
    .then((m) => m.refreshOrderMessages(order._id, actorName))
    .catch((e) => console.error('[restaurantBot] refresh:', e.message));

  /*
   * Panel bildirishnomasi yopiladi — buyurtma botda qabul qilinsa
   * ham paneldagi ovoz darhol to'xtaydi va keyingi kirishda
   * "javobsiz" bo'lib chiqmaydi.
   */
  import('./notifications.js')
    .then((m) => m.resolveNotification(`order:${order._id}`, status === 'cancelled' ? 'CANCELLED' : 'ACCEPTED'))
    .catch(() => {});

  return { order, changed: true };
}

/*
 * Moliyaviy va xabarnoma yon ta'sirlari.
 *
 * ATAYLAB `await` bilan emas, `.catch()` bilan: ulardan biri
 * yiqilsa ham status o'zgarishi bekor qilinmaydi. Buyurtma
 * allaqachon o'zgargan, uni orqaga qaytarish mijoz uchun
 * yanada chalkash bo'lardi.
 */
async function runSideEffects(order, status) {
  if (status === 'delivered') {
    const { settleOrder } = await import('./billing.js');
    await settleOrder(order._id).catch((e) => console.error('[billing] settleOrder:', e.message));

    const { askRatingForOrder } = await import('./deliveryCheck.js');
    askRatingForOrder(order).catch((e) => console.error('[rating]', e.message));
  }

  if (status === 'cancelled' && order.isPaid) {
    const { recordRefund } = await import('./billing.js');
    await recordRefund(order, order.paymentMethod)
      .catch((e) => console.error('[billing] recordRefund:', e.message));
  }

  const tgId = order.userId?.telegramId;
  const text = customerStatusText(order, status);
  if (tgId && text) notifyUser(tgId, text);
}

/*
 * Olib ketish buyurtmasida kuryer yo'q — "yo'lga chiqdi, tez orada
 * yetib keladi" mijozni chalg'itardi: u taomni restoranda qo'lida
 * ushlab turgan bo'ladi. Faqat pickup uchun ikki matn almashtiriladi,
 * yetkazib berish xabarlari o'zgarmaydi.
 */
const PICKUP_STATUS_TEXT = {
  ready: '🍽 Buyurtmangiz tayyor — restorandan olib ketishingiz mumkin',
  delivering: '🤝 Buyurtmangiz sizga topshirildi. Yoqimli ishtaha!',
  delivered: '🤝 Buyurtmangiz sizga topshirildi. Yoqimli ishtaha!',
};

function customerStatusText(order, status) {
  if (order?.fulfillment === 'pickup' && PICKUP_STATUS_TEXT[status]) {
    return PICKUP_STATUS_TEXT[status];
  }
  return STATUS_TEXT[status];
}

/*
 * Real-time tarqatish.
 *
 * TZ 12 va 24-bandlar: status QAYERDAN o'zgartirilishidan
 * qat'i nazar, boshqa interfeys yangilanishi kerak. Shu
 * funksiya bitta joyda turgani uchun bot orqali qilingan
 * o'zgarish ham avtomatik panelга boradi — qo'shimcha kod
 * yozish shart emas.
 */
function broadcast(order) {
  const io = getIO();
  if (!io) return;

  const payload = {
    orderId: String(order._id),
    status: order.status,
    restaurantId: String(order.restaurantId || ''),
  };

  // Mijoz — buyurtma kuzatuvi sahifasi (bitta buyurtma ochiq)
  io.to(`order:${order._id}`).emit('order:status', payload);

  /*
   * Mijoz — BUYURTMALAR RO'YXATI.
   *
   * XATO TUZATILDI: holat faqat `order:<id>` xonasiga ketardi,
   * unga esa faqat kuzatuv sahifasi qo'shilardi. Ro'yxat sahifasi
   * `user:<id>` xonasida turardi va hech narsa olmasdi — mijoz
   * buyurtma qabul qilinganini ko'rish uchun sahifani qo'lda
   * yangilashi kerak edi.
   *
   * Endi holat foydalanuvchi xonasiga ham boradi. Ro'yxat sahifasi
   * allaqachon shu hodisani tinglaydi — qo'shimcha o'zgarish
   * shart emas.
   */
  /*
   * DIQQAT: `userId` `populate()` qilingan bo'lishi mumkin —
   * u holda bu butun User hujjati, ObjectId emas. To'g'ridan
   * to'g'ri satrga aylantirilsa xona nomi butunlay boshqa
   * chiqadi va xabar hech kimga bormaydi.
   */
  const uid = order.userId?._id || order.userId;
  if (uid) {
    io.to(`user:${uid}`).emit('order:status', payload);
  }

  // Restoran paneli
  io.to(`restaurant:${order.restaurantId}`).emit('order:update', order);

  // LokmaGo admin
  io.to('admin').emit('order:update', order);
}
