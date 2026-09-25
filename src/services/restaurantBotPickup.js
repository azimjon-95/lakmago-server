import { Order } from '../models/Order.js';
import { RestaurantTelegramStaff } from '../models/RestaurantTelegramStaff.js';
import { getIO } from '../sockets/io.js';
import { answerCallback, btn } from './restaurantBotApi.js';

/*
 * ═══════════════════════════════════════════════════════════
 * RESTORAN BOTI — "O'ZIM OLIB KETAMAN" BUYURTMALARI
 * ═══════════════════════════════════════════════════════════
 *
 * Olib ketish (pickup) buyurtmasida kuryer YO'Q, mijoz taomni
 * restorandan o'zi oladi va naqd bo'lsa pulni o'sha yerda
 * xodimga beradi. Shuning uchun xodimga kuryer tugmalari
 * o'rniga shu ikki amal kerak:
 *
 *   💵 To'lov qilindi     — naqd pul qo'lga olindi
 *   🤝 Mijozga topshirildi — taom mijozga berildi
 *                            (restaurantBotOrders.js)
 *
 * ─── NEGA ALOHIDA FAYL ───
 * Yetkazib berish oqimiga (kuryer, ulashish) umuman tegmaslik
 * uchun. restaurantBotOrders.js faqat shu fayldan ikkita
 * funksiyani chaqiradi; bu yerdagi mantiq faqat
 * `fulfillment === 'pickup'` VA naqd buyurtmaga ta'sir qiladi.
 *
 * ─── PUL — PANEL BILAN AYNAN BIR XIL ───
 * Restoran panelidagi "To'landi" (restaurantPanel.markPaid)
 * isPaid/paidAt ni yozadi va billing.recordPayment(order, 'cash')
 * orqali to'lovni moliya jurnaliga tushiradi. Bot ham AYNAN
 * shuni qiladi — aks holda botdan belgilangan to'lov jurnalda
 * ko'rinmasdi.
 */

/** To'lov tugmasi qaysi holatlarda ko'rinadi. */
const PAYABLE_STATUSES = ['accepted', 'preparing', 'ready', 'delivering'];

/** Buyurtmaga "To'lov qilindi" tugmasi kerakmi. */
export function needsPickupCashPayment(order) {
  return Boolean(order)
    && order.fulfillment === 'pickup'
    && order.paymentMethod === 'cash'
    && !order.isPaid
    && PAYABLE_STATUSES.includes(order.status);
}

/**
 * Klaviatura qatori — kerak bo'lmasa `null` (kb() uni tashlab
 * yuboradi). Taom mijozga topshirilgandan keyin ham (delivering)
 * ko'rinib turadi: xodim avval taomni berib, pulni keyin olgan
 * bo'lishi mumkin — to'lovni belgilash imkoni yo'qolmasligi kerak.
 */
export function pickupPaymentRow(order) {
  if (!needsPickupCashPayment(order)) return null;
  return [btn('💵 To‘lov qilindi', `o:paid:${order._id}`, 'primary')];
}

/**
 * "💵 To'lov qilindi" bosildi.
 *
 * ATOMIK: shartlar (egalik, pickup, naqd, hali to'lanmagan,
 * faol holat) BITTA findOneAndUpdate filtrida. Ikki xodim bir
 * vaqtda bossa, faqat bittasi o'tadi — ikkinchisi `null` oladi
 * va "allaqachon belgilangan" javobini ko'radi. recordPayment
 * ham takroriy yozuvdan o'zi himoyalangan (ikki qavat himoya).
 *
 * restaurantId Telegram xabaridan emas, xodimning BAZADAGI
 * bog'lanishidan olinadi — callback_data ni o'zgartirib boshqa
 * restoran buyurtmasiga tegib bo'lmaydi.
 */
export async function handlePickupPaid(cq, staff, orderId) {
  const { refreshOrderMessages } = await import('./restaurantBotOrders.js');

  const order = await Order.findOneAndUpdate(
    {
      _id: orderId,
      restaurantId: staff.restaurantId,
      fulfillment: 'pickup',
      paymentMethod: 'cash',
      isPaid: { $ne: true },
      status: { $in: PAYABLE_STATUSES },
    },
    { isPaid: true, paidAt: new Date() },
    { new: true },
  );

  if (!order) {
    await answerCallback(cq.id, 'To‘lov allaqachon belgilangan yoki buyurtma holati o‘zgargan', { alert: true });
    await refreshOrderMessages(orderId);
    return;
  }

  await answerCallback(cq.id, '💵 To‘lov qabul qilindi');

  // Moliya jurnali — panel bilan bir xil. Xato bo'lsa ham
  // isPaid qaytarilmaydi: pul haqiqatan olingan.
  const { recordPayment } = await import('./billing.js');
  await recordPayment(order, 'cash')
    .catch((e) => console.error('[restaurantBot] pickup recordPayment:', e.message));

  await RestaurantTelegramStaff.updateOne({ _id: staff._id }, { lastActionAt: new Date() }).catch(() => {});

  getIO()?.to('admin').emit('order:update', order);
  getIO()?.to(`restaurant:${order.restaurantId}`).emit('order:update', order);

  /*
   * Barcha xodimlardagi karta yangilanadi: "Naqd · To'langan",
   * to'lov tugmasi yo'qoladi. Xodim ismi UZATILMAYDI — u status
   * qatoriga ("📦 Tayyor · Ism") yoziladi va to'lovni belgilagan
   * xodimni statusni o'zgartirgandek ko'rsatib qo'yardi.
   */
  await refreshOrderMessages(orderId);
}
