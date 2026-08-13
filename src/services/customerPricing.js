import { activeAgreement } from '../models/CommissionAgreement.js';

/**
 * Mijozga ko'rsatiladigan narx.
 *
 * Restoran taom uchun BAZA narxni kiritadi. Mijoz ko'radigan narx
 * shundan hosil bo'ladi:
 *
 *   Baza 10 000
 *     + yetkazish ustamasi 5%   → 10 500   (restoran belgilaydi)
 *     + mijoz xizmat haqi 5%    → 11 025   (shartnomadan)
 *
 * Dine-in va bronda ikkalasi ham QO'LLANMAYDI — zal narxi qoladi.
 * Shuning uchun bir taom mijozga ikki xil narxda ko'rinadi va bu
 * to'g'ri: yetkazishda qo'shimcha xarajat bor.
 *
 * Foizlar bazaga bir marta va ketma-ket qo'llanadi — ustama ustiga
 * haq, haq ustiga yana ustama emas.
 */

/** Foizni butun songa qo'llash (tiyin yoki so'm — birlik muhim emas). */
function addPercent(amount, percent) {
  const p = Number(percent) || 0;
  if (p <= 0) return Math.round(amount);
  // Bazis punkt orqali — Float bo'linish yo'q
  const bp = Math.round(p * 100);
  return Math.round(amount) + Math.floor((Math.round(amount) * bp) / 10000);
}

/**
 * Restoran uchun narx koeffitsientlarini bir marta oladi.
 * Menyu ro'yxatida har taomga qayta so'rov ketmasligi uchun.
 */
export async function priceContext(restaurant) {
  const agreement = await activeAgreement(restaurant._id);
  return {
    deliveryMarkupPercent: Number(restaurant.deliveryMarkupPercent) || 0,
    customerFeePercent: Number(agreement?.customerFeePercent) || 0,
    restaurantCommissionPercent: Number(agreement?.restaurantCommissionPercent) || 0,
    totalSplitPercent: Number(agreement?.totalSplitPercent) || 0,
    agreementId: agreement?._id || null,
  };
}

/** Yetkazish/olib ketish uchun mijoz narxi. */
export function customerPrice(basePrice, ctx) {
  const base = Math.round(Number(basePrice) || 0);
  if (base <= 0) return 0;
  const withMarkup = addPercent(base, ctx.deliveryMarkupPercent);
  return addPercent(withMarkup, ctx.customerFeePercent);
}

/** Zal va bron: narx o'zgarmaydi. */
export function dineInPrice(basePrice) {
  return Math.round(Number(basePrice) || 0);
}

/**
 * Taom obyektiga mijoz narxini qo'yadi.
 *
 * Asl baza narx `basePrice` da saqlanadi — hisob-kitob va
 * restoran paneli uchun kerak.
 */
export function applyPricing(dish, ctx, { dineIn = false } = {}) {
  const base = Number(dish.price) || 0;
  const price = dineIn ? dineInPrice(base) : customerPrice(base, ctx);

  const out = { ...dish, price, basePrice: base };

  // Chegirma narxi bo'lsa u ham bir xil qoidaga bo'ysunadi
  if (dish.oldPrice > 0) {
    out.oldPrice = dineIn ? dineInPrice(dish.oldPrice) : customerPrice(dish.oldPrice, ctx);
  }

  // Variantlar narxi ham (masalan "katta porsiya +5000")
  if (Array.isArray(dish.optionGroups) && dish.optionGroups.length) {
    out.optionGroups = dish.optionGroups.map((g) => ({
      ...g,
      options: (g.options || []).map((o) => ({
        ...o,
        price: o.price > 0
          ? (dineIn ? dineInPrice(o.price) : customerPrice(o.price, ctx))
          : o.price,
      })),
    }));
  }

  return out;
}

/** Ro'yxat uchun qulay yordamchi. */
export function applyPricingToList(dishes, ctx, opts) {
  return dishes.map((d) => applyPricing(d, ctx, opts));
}
