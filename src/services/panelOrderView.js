/*
 * ═══════════════════════════════════════════════════════════
 * BUYURTMANING RESTORANGA / GATEWAY'GA KO'RINADIGAN SHAKLI
 * ═══════════════════════════════════════════════════════════
 *
 * Restoran paneli (`/api/panel/orders`) VA Android gateway (`/app/...`)
 * — ikkalasi ham buyurtmani FAQAT shu funksiyalar orqali qaytaradi:
 * ro'yxat, bitta buyurtma, status o'zgartirish, tarix, "Yetkazildi".
 *
 * NEGA ALOHIDA MODUL: avval bu funksiyalar restaurantPanel.js ichida
 * edi va `updateOrderStatus` ularni ISHLATMASDI — status javobi xom
 * Mongoose hujjatini qaytarardi: finance.lokmaNetCommission (LokmaGo
 * netto daromadi), clickFeeAmount va populate qilingan BUTUN mijoz
 * hujjati (saqlangan manzillar, kartalar, bonus balansi). Bitta
 * ko'rinish bitta joyda bo'lsa, yangi endpoint uni chetlab o'tolmaydi.
 */
import { confirmEligibility, COMPLETABLE_STATUSES } from './reminderRules.js';

/**
 * Restoran ko'radigan moliyaviy tasvir.
 *
 * Faqat restoranga tegishli raqamlar: taom summasi, ushlangan
 * komissiya va qo'lga tegadigan summa. LokmaGo daromadi, shlyuz
 * residuali va mijoz xizmat haqining taqsimoti KO'RSATILMAYDI.
 *
 * Summalar so'mda (snapshot tiyinda saqlanadi).
 */
export function restaurantFinanceView(f) {
  const som = (t) => Math.round(Number(t) || 0) / 100;
  return {
    model: f.model,
    currency: f.currency,
    foodSubtotal: som(f.foodSubtotal),
    discountAmount: som(f.discountAmount),
    restaurantCommissionPercent: f.restaurantCommissionPercent,
    restaurantCommissionAmount: som(f.restaurantCommissionAmount),
    restaurantPayout: som(f.restaurantPayout),
    deliveryFee: som(f.deliveryFee),
    totalCharged: som(f.totalCharged),
  };
}

/*
 * Buyurtmani panelga (va Android gateway'ga) qulay ko'rinishga
 * keltiradi — mijoz ma'lumotini bitta obyektga yig'adi.
 * `orders()` va `orderDetail()` IKKALASI ham shu funksiyadan
 * foydalanadi — mijoz ko'rinishi ikki joyda alohida yozilib,
 * bir joyda tuzatilib ikkinchisida unutilib qolmasin.
 *
 * `finance` bu yerda ALLAQACHON restaurantFinanceView bilan
 * qisqartirilgan bo'lishi kerak — chaqiruvchi javobgar.
 */
export function shapeOrderForPanel(o) {
  const u = o.userId || {};
  return {
    ...o,
    userId: u._id ? String(u._id) : null,
    customer: {
      name: [u.firstName, u.lastName].filter(Boolean).join(' ') || 'Mijoz',
      username: u.username || '',
      telegramId: u.telegramId || '',
      phone: o.phone || u.phone || '',
      photoUrl: u.photoUrl || '',
    },
  };
}

/**
 * BUYURTMANING TO'LIQ, XAVFSIZ KO'RINISHI — chaqiruvchilar FAQAT shuni ishlatadi.
 *
 * Mongoose hujjati (populate qilingan bo'lishi mumkin) ham, `.lean()` obyekt
 * ham qabul qilinadi. Bu funksiya hammasini o'zi qiladi (chaqiruvchi
 * "finance'ni qisqartirishni unutib qo'yishi" mumkin emas):
 *   1. toObject — Mongoose ichki maydonlarisiz oddiy obyekt;
 *   2. finance → restaurantFinanceView (so'mda; LokmaGo netto, Click haqi YO'Q);
 *   3. shapeOrderForPanel — `userId` matnga, mijoz `customer` obyektiga
 *      (populate qilingan hujjatning qolgan maydonlari — manzillar, kartalar,
 *      bonus — CHIQMAYDI);
 *   4. restaurantConfirm — restoran "Yetkazildi"ni tasdiqlay oladimi.
 */
export function toPanelOrder(order, now = Date.now()) {
  const o = typeof order?.toObject === 'function' ? order.toObject() : { ...order };
  if (o.finance) o.finance = restaurantFinanceView(o.finance);
  const shaped = shapeOrderForPanel(o);

  /*
   * eligible/eligibleAt — server hisoblaydi, ilova qoidani qayta yozmasin.
   * Faqat hali ochiq buyurtmalar uchun; boshqasida null.
   */
  const open = ['delivery', 'pickup'].includes(o.fulfillment) && COMPLETABLE_STATUSES.includes(o.status);
  shaped.restaurantConfirm = open
    ? (({ eligible, eligibleAt }) => ({ eligible, eligibleAt }))(confirmEligibility(o, now))
    : null;
  return shaped;
}
