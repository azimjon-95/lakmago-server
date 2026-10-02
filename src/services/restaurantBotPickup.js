import { Order } from '../models/Order.js';
import { answerCallback } from './restaurantBotApi.js';

/*
 * ═══════════════════════════════════════════════════════════
 * RESTORAN BOTI — "O'ZIM OLIB KETAMAN" BUYURTMALARI
 * ═══════════════════════════════════════════════════════════
 *
 * Olib ketish (pickup) buyurtmasida kuryer YO'Q: mijoz taomni restorandan
 * o'zi oladi. Xodimga kuryer tugmalari o'rniga "🤝 Mijozga topshirildi"
 * ko'rsatiladi (restaurantBotOrders.js) — u buyurtmani YAKUNLAYDI.
 *
 * ─── "💵 TO'LOV QILINDI" TUGMASI OLIB TASHLANDI ───
 * Naqd to'lov endi buyurtma yakunlanganda AVTOMATIK "to'langan" bo'ladi
 * (services/billing.js finalizeCashPayment: isPaid + paidAt + moliya jurnali).
 * Qo'lda belgilash kerak emas: u unutilar, ortiqcha tugma edi, asl muammo esa
 * boshqada — naqd buyurtmani restoran MIJOZ BILAN GAPLASHMASDAN qabul qilib,
 * mijoz topilmay qolishi (buyurtma matnidagi ogohlantirish shuni hal qiladi).
 *
 * Eski xabarlarda tugma hamon turgan bo'lishi mumkin: bosilsa HECH NARSA
 * o'zgarmaydi, xodimga sababi tushuntiriladi va karta yangilanadi (tugma yo'qoladi).
 */

/**
 * Eski "💵 To'lov qilindi" (o:paid) tugmasi bosildi. Hech narsa yozilmaydi.
 * restaurantId xodimning BAZADAGI bog'lanishidan olinadi: callback_data ni
 * o'zgartirib boshqa restoran buyurtmasining kartasini yangilatib bo'lmaydi.
 */
export async function handlePickupPaid(cq, staff, orderId) {
  await answerCallback(
    cq.id,
    'To‘lov endi avtomatik: buyurtma yakunlanganda (mijozga topshirilganda) “to‘langan” bo‘ladi',
    { alert: true },
  );

  const own = await Order.exists({ _id: orderId, restaurantId: staff.restaurantId }).catch(() => null);
  if (!own) return;
  const { refreshOrderMessages } = await import('./restaurantBotOrders.js');
  await refreshOrderMessages(orderId);
}
