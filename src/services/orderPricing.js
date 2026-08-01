/**
 * Buyurtma hisob-kitobi — YAGONA manba.
 *
 * Bu mantiq client'da ham takrorlanadi (lib/pricing.js). Ikkalasi
 * bir xil natija berishi shart, aks holda mijoz bir summani ko'rib
 * boshqasini to'laydi.
 *
 * Server bu hisobni QAYTA bajaradi va client yuborganini tekshiradi —
 * frontendga ishonib bo'lmaydi.
 */

/**
 * Yetkazish haqini hisoblaydi.
 *
 * @param {number} subtotal - taomlar summasi
 * @param {object} restaurant - { deliveryFee, freeDeliveryThreshold }
 * @param {boolean} isPickup - o'zi olib ketadimi
 */
export function calcDeliveryFee(subtotal, restaurant, isPickup) {
  // O'zi olib ketsa yetkazish yo'q
  if (isPickup) return 0;

  const fee = Number(restaurant?.deliveryFee) || 0;
  if (fee <= 0) return 0;

  // Bepul yetkazish chegarasi (0 yoki yo'q = doim pullik)
  const threshold = Number(restaurant?.freeDeliveryThreshold) || 0;
  if (threshold > 0 && subtotal >= threshold) return 0;

  return fee;
}

/**
 * Xizmat haqi — foiz, min/max bilan cheklanadi.
 */
export function calcServiceFee(subtotal, restaurant) {
  const percent = Number(restaurant?.serviceFeePercent) || 0;
  if (percent <= 0) return 0;

  let fee = Math.round(subtotal * percent / 100);

  const min = Number(restaurant?.serviceFeeMin) || 0;
  const max = Number(restaurant?.serviceFeeMax) || 0;
  if (min > 0 && fee < min) fee = min;
  if (max > 0 && fee > max) fee = max;

  return fee;
}

/**
 * Minimal summa tekshiruvi.
 * Olib ketishda qo'llanilmaydi — u yerda yetkazish xarajati yo'q.
 */
export function checkMinOrder(subtotal, restaurant, isPickup) {
  if (isPickup) return { ok: true, missing: 0, min: 0 };

  const min = Number(restaurant?.minOrderAmount) || 0;
  if (min <= 0 || subtotal >= min) return { ok: true, missing: 0, min };

  return { ok: false, missing: min - subtotal, min };
}

/**
 * Bepul yetkazishgacha qancha qolgani.
 * null qaytsa — ko'rsatiladigan narsa yo'q.
 */
export function freeDeliveryGap(subtotal, restaurant, isPickup) {
  if (isPickup) return null;

  const fee = Number(restaurant?.deliveryFee) || 0;
  const threshold = Number(restaurant?.freeDeliveryThreshold) || 0;

  // Yetkazish allaqachon bepul yoki chegara belgilanmagan
  if (fee <= 0 || threshold <= 0) return null;
  if (subtotal >= threshold) return 0;

  return threshold - subtotal;
}

/**
 * To'liq hisob — bitta restoran uchun.
 */
export function calcOrderTotals(subtotal, restaurant, isPickup, bonusUsed = 0) {
  const deliveryFee = calcDeliveryFee(subtotal, restaurant, isPickup);
  const serviceFee = calcServiceFee(subtotal, restaurant);
  const total = Math.max(0, subtotal + deliveryFee + serviceFee - bonusUsed);

  return { subtotal, deliveryFee, serviceFee, bonusUsed, total };
}


/**
 * Restoran hozir ochiqmi.
 *
 * openTime/closeTime "HH:MM" ko'rinishida. Yarim tundan
 * oshadigan vaqt ham to'g'ri hisoblanadi (10:00–02:00).
 * Vaqt belgilanmagan bo'lsa — doim ochiq.
 *
 * MUHIM: bu mantiq client'da ham bor (lib/workHours.js).
 */
function toMinutes(hhmm) {
  if (typeof hhmm !== 'string') return null;
  const m = hhmm.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

export function isRestaurantOpen(restaurant, now = new Date()) {
  const open = toMinutes(restaurant?.openTime);
  const close = toMinutes(restaurant?.closeTime);

  if (open === null || close === null) return true;
  if (open === close) return true;

  const cur = now.getHours() * 60 + now.getMinutes();

  if (open < close) return cur >= open && cur < close;
  return cur >= open || cur < close;
}
