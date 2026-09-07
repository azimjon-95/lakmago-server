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
export const RESTAURANT_STATUSES = ['accepted', 'preparing', 'ready', 'delivering', 'cancelled'];

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
  ready: ['preparing'],
  delivering: ['ready'],
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
export async function changeOrderStatus({ orderId, restaurantId, status, actorName = '' }) {
  if (!RESTAURANT_STATUSES.includes(status)) {
    throw new OrderFlowError('INVALID_STATUS', 'Noto‘g‘ri status');
  }

  const before = await Order.findOne({ _id: orderId, restaurantId })
    .select('status').lean();
  if (!before) throw new OrderFlowError('NOT_FOUND', 'Buyurtma topilmadi');

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
    { _id: orderId, restaurantId, status: { $in: allowedFrom } },
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
  if (tgId && STATUS_TEXT[status]) notifyUser(tgId, STATUS_TEXT[status]);
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

  // Mijoz — buyurtma kuzatuvi sahifasi
  io.to(`order:${order._id}`).emit('order:status', {
    orderId: String(order._id),
    status: order.status,
  });

  // Restoran paneli
  io.to(`restaurant:${order.restaurantId}`).emit('order:update', order);

  // LokmaGo admin
  io.to('admin').emit('order:update', order);
}
