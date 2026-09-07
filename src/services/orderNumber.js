import { Order } from '../models/Order.js';

/*
 * ═══ KUNLIK BUYURTMA RAQAMI ═══
 *
 * Har restoran uchun har kuni 1 dan boshlanadi: #1, #2, #3…
 *
 * NIMA UCHUN ALOHIDA HISOBLAGICH KOLLEKSIYASI YO'Q
 *
 * Odatda bunday raqam uchun `Counter` kollektsiyasi ochiladi va
 * `findOneAndUpdate({$inc})` bilan olinadi. Bu yerda ataylab
 * boshqacha yo'l tanlandi: raqam Order kollektsiyasining O'ZIDAN
 * hisoblanadi.
 *
 * Sabab: qo'shimcha kollektsiya = qo'shimcha holat. U buyurtmalar
 * bilan sinxrondan chiqishi mumkin (masalan bazadan test
 * buyurtmalari o'chirilsa, hisoblagich baribir oldinga ketaveradi
 * va restoran "bugun 3 ta buyurtma bo'ldi, nega #57?" deb so'raydi).
 * Order'dan hisoblash esa har doim haqiqatga mos keladi.
 *
 * ═══ POYGA HOLATI (race condition) ═══
 *
 * Ikki buyurtma bir vaqtda kelsa, ikkalasi ham bir xil raqam
 * olishi mumkin. Buni oldini olish uchun `dailyNumber` unikal
 * indeks bilan himoyalangan va yozish muvaffaqiyatsiz bo'lsa
 * keyingi raqam bilan qayta urinamiz.
 *
 * Bu yondashuv bir necha marta takrorlanishi mumkin, lekin
 * amalda buyurtmalar soniya sayin kelmaydi — 3 urinish
 * yetarlidan ham ortiq.
 */

function todayKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Buyurtmaga kunlik raqam beradi.
 *
 * Idempotent: raqami bor buyurtmaga qayta berilmaydi.
 *
 * @param {object} order - mongoose hujjati
 * @returns {Promise<number|null>}
 */
export async function assignDailyNumber(order) {
  if (!order || order.dailyNumber) return order?.dailyNumber ?? null;

  const dateKey = todayKey();

  for (let attempt = 0; attempt < 3; attempt++) {
    // Shu restoran, shu kun ichidagi eng katta raqam
    const last = await Order.findOne({
      restaurantId: order.restaurantId,
      dailyNumberDate: dateKey,
    })
      .sort({ dailyNumber: -1 })
      .select('dailyNumber')
      .lean();

    const next = (last?.dailyNumber || 0) + 1 + attempt;

    try {
      const updated = await Order.findOneAndUpdate(
        // `dailyNumber: null` — allaqachon raqam olgan bo'lsa tegilmaydi
        { _id: order._id, dailyNumber: null },
        { dailyNumber: next, dailyNumberDate: dateKey },
        { new: true },
      ).select('dailyNumber').lean();

      if (updated) {
        order.dailyNumber = updated.dailyNumber;
        order.dailyNumberDate = dateKey;
        return updated.dailyNumber;
      }

      // null qaytdi — boshqa jarayon ulgurdi, raqami bor
      return order.dailyNumber ?? null;
    } catch (e) {
      // Unikal indeks buzildi — keyingi raqam bilan urinamiz
      if (e?.code !== 11000) throw e;
    }
  }

  /*
   * Uch urinish ham yiqildi. Buyurtmani BEKOR QILMAYMIZ —
   * raqam qulaylik uchun, buyurtmaning o'zi muhimroq.
   * Bot va panel raqam bo'lmasa _id oxirini ko'rsatadi.
   */
  console.warn('[orderNumber] raqam berib bo‘lmadi:', String(order._id));
  return null;
}

/**
 * Ko'rsatish uchun raqam. Raqam yo'q bo'lsa — _id oxiri.
 * Bot va panel shu funksiyani ishlatadi, shunda ikkalasi
 * bir xil ko'rsatadi.
 */
export function orderLabel(order) {
  if (order?.dailyNumber) return `#${order.dailyNumber}`;
  return `#${String(order?._id || '').slice(-4).toUpperCase()}`;
}
