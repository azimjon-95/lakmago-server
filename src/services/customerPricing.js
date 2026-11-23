import { activeAgreement } from '../models/CommissionAgreement.js';

/**
 * Mijozga ko'rsatiladigan narx.
 *
 * QOIDA (2026-08-14 da restoran + admin bilan tasdiqlangan):
 * ikkala foiz ham BAZA narxdan hisoblanadi va bir-biriga
 * QO'SHILADI — biri ikkinchisining ustiga qo'yilmaydi.
 *
 *   Baza 10 000
 *     + yetkazish ustamasi 5% (restoran belgilaydi)  → +500
 *     + mijoz xizmat haqi 5%  (LokmaGo shartnomasi)   → +500
 *     ─────────────────────────────────────────────────────
 *     Mijoz ko'radi: 11 000
 *
 * Avval ikkinchi foiz BIRINCHISI qo'shilgan natijaga qo'llanardi
 * (10 000 → 10 500 → 10 500×1.05 = 11 025) — bu noto'g'ri edi:
 * mijoz xizmat haqi asl taom narxidan emas, restoran ustamasi
 * bilan "shishirilgan" summadan olinardi. Endi ikkalasi ham
 * doim BIR XIL baza — 10 000 — dan hisoblanadi, natija esa
 * ularning yig'indisi.
 *
 * Bu formula pul bo'linishi bilan ham (paymentSplit orqali)
 * TO'LIQ MOS: restoran = baza + ustama − restoran komissiyasi,
 * LokmaGo = restoran komissiyasi + mijoz haqi. Ikkalasi
 * yig'ilsa mijoz narxiga teng chiqadi — boshqa formula
 * ishlatilsa bu tenglik buziladi va pul "yo'qolib qoladi".
 *
 * Dine-in va bronda (PreOrderScreen) HECH IKKALASI ham
 * qo'llanmaydi — restoran o'z narxi to'liq ko'rinadi.
 */

/** Foizni butun songa qo'llash (tiyin yoki so'm — birlik muhim emas). */
function pctOf(amount, percent) {
  const p = Number(percent) || 0;
  if (p <= 0) return 0;
  // Bazis punkt orqali — Float bo'linish yo'q
  const bp = Math.round(p * 100);
  return Math.floor((Math.round(amount) * bp) / 10000);
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

/**
 * Yetkazish/olib ketish uchun mijoz narxi.
 *
 * Ikkala foiz BAZADAN, mustaqil hisoblanadi va qo'shiladi.
 */
export function customerPrice(basePrice, ctx) {
  const base = Math.round(Number(basePrice) || 0);
  if (base <= 0) return 0;
  const markupAmt = pctOf(base, ctx.deliveryMarkupPercent);
  const feeAmt = pctOf(base, ctx.customerFeePercent);
  return base + markupAmt + feeAmt;
}

/**
 * Buyurtmadagi bitta pozitsiyaning MIJOZ narxi (1 dona) — mijoz menyuda/savatda ko'rgan narx bilan AYNAN bir xil.
 *
 * Menyuda har bir qism alohida narxlanadi (applyPricing): taom (yoki tanlangan hajm) narxi va har bir qo'shimcha.
 * Shuning uchun bu yerda ham: hajm/asos = unitPrice − Σ qo'shimchalar, keyin har bir qism customerPrice() orqali.
 * `item.unitPrice` — server tekshirgan RESTORAN (baza) narxi (priceVerification.js).
 */
export function itemCustomerUnitPrice(item, ctx) {
  return itemCustomerUnitBreakdown(item, ctx).price;
}

/**
 * Bitta qism (taom/hajm yoki qo'shimcha) narxining bo'laklari — customerPrice() bilan AYNAN bir xil yaxlitlash.
 * { base, markup, fee, price }, price === base + markup + fee.
 */
function partBreakdown(amount, ctx) {
  const base = Math.round(Number(amount) || 0);
  if (base <= 0) return { base, markup: 0, fee: 0, price: base };
  const markup = pctOf(base, ctx.deliveryMarkupPercent);
  const fee = pctOf(base, ctx.customerFeePercent);
  return { base, markup, fee, price: base + markup + fee };
}

/**
 * Pozitsiyaning 1 donasi uchun bo'laklar (so'm, butun son): restoran bazasi, restoran ustamasi, mijoz xizmat haqi.
 * `price` === itemCustomerUnitPrice() — mijoz menyuda ko'rgan narx.
 *
 * NIMA UCHUN (audit F-08/F-09): buyurtma summasi avval butun savatdan bir marta foiz olib hisoblanardi (tiyinda
 * yaxlitlash), menyu esa har qismni alohida so'mda yaxlitlaydi — mijoz menyuda ko'rganidan bir necha so'm ko'p
 * to'lardi va jami kasr so'm (10 849,65) chiqib Paynet summasini buzardi. Endi buyurtma ham shu bo'laklardan
 * yig'iladi (orderFinance: deliveryMarkupLinesTiyin / customerFeeLinesTiyin).
 */
export function itemCustomerUnitBreakdown(item, ctx) {
  const unit = Math.round(Number(item?.unitPrice) || 0);
  const addons = (item?.selectedOptions || []).filter((o) => !o?.variant).map((o) => Math.round(Number(o?.price) || 0));
  const addonSum = addons.reduce((s, x) => s + x, 0);
  const base = unit - addonSum;
  // kutilmagan ma'lumot (qo'shimchalar narxi umumiydan katta) — butun narxga qo'llanadi
  const parts = base < 0 ? [unit] : [base, ...addons];
  const out = { base: 0, markup: 0, fee: 0, price: 0 };
  for (const p of parts) {
    const b = partBreakdown(p, ctx);
    out.base += b.base; out.markup += b.markup; out.fee += b.fee; out.price += b.price;
  }
  return out;
}

/**
 * Buyurtma pozitsiyalari bo'yicha jami (so'm, butun son) — mijoz savatda ko'rgan summa.
 * @returns {{ base:number, markup:number, fee:number, price:number }}
 */
export function itemsCustomerBreakdown(items, ctx) {
  const total = { base: 0, markup: 0, fee: 0, price: 0 };
  for (const it of items || []) {
    const qty = Math.max(0, Math.round(Number(it?.quantity) || 0));
    if (!qty) continue;
    const u = itemCustomerUnitBreakdown(it, ctx);
    total.base += u.base * qty; total.markup += u.markup * qty; total.fee += u.fee * qty; total.price += u.price * qty;
  }
  return total;
}

/** Zal va bron: narx o'zgarmaydi — restoranning o'z narxi. */
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
