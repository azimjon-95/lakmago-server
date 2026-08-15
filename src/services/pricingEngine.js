/**
 * Narx dvigateli — buyurtma yaratish va pul bo'linishi uchun.
 *
 * QOIDA (customerPricing.js bilan BIR XIL — bu ikkalasi doim
 * mos kelishi SHART, aks holda mijoz ko'rgan narx va haqiqatda
 * hisoblangan/bo'lingan summa bir-biriga to'g'ri kelmay qoladi):
 *
 *   BasePrice = 10 000
 *     DeliveryMarkupAmount = BasePrice × DeliveryMarkup%     (masalan 5% → 500)
 *     CustomerFeeAmount    = BasePrice × CustomerFee%        (masalan 5% → 500)
 *     CustomerFinalPrice   = BasePrice + DeliveryMarkupAmount + CustomerFeeAmount
 *                          = 11 000
 *
 * Ikkala foiz ham MUSTAQIL ravishda BASE'dan hisoblanadi va
 * qo'shiladi — biri ikkinchisining natijasiga qo'llanmaydi
 * (5% ustiga yana 5% emas).
 *
 * Bo'linish xuddi shu bazadan:
 *   RestaurantPayout = BasePrice + DeliveryMarkupAmount − RestaurantCommissionAmount
 *                     = 10 000 + 500 − 500 = 10 000
 *   LokmaGoRevenue    = RestaurantCommissionAmount + CustomerFeeAmount
 *                     = 500 + 500 = 1 000
 *
 * Tekshiruv: RestaurantPayout + LokmaGoRevenue === CustomerFinalPrice
 * har doim rost bo'ladi (10 000 + 1 000 = 11 000) — chunki
 * ikkalasi ham bir xil ikkita miqdordan (ustama, komissiya/haq)
 * tuziladi, faqat ishorasi teskari.
 *
 * Dine-in va bron: faqat BasePrice. Ustama ham, mijoz haqi ham
 * qo'llanmaydi, bo'linish 0% — mijoz zalda o'tirib to'laydi.
 *
 * Barcha summalar TIYINDA, butun son. Float ishlatilmaydi.
 */

/** Foizni tiyinga qo'llash. Bazis punkt orqali — Float bo'linish yo'q. */
function applyPercent(amountTiyin, percent) {
  const bp = Math.round(Number(percent || 0) * 100);   // 5.25% → 525
  return Math.floor((amountTiyin * bp) / 10000);
}

/** Zal va bron uchun: narx o'zgarmaydi, bo'linish yo'q. */
export function priceDineIn(basePriceTiyin) {
  const base = Math.round(Number(basePriceTiyin) || 0);
  return {
    basePrice: base,
    deliveryMarkupPercent: 0,
    deliveryPrice: base,
    customerFeePercent: 0,
    customerFeeAmount: 0,
    customerFinalPrice: base,
    restaurantCommissionPercent: 0,
    aggregatedSplitPercent: 0,
    billingBase: 'BASE_PRICE',
    restaurantPayoutAmount: base,
    lokmaGrossRevenue: 0,
  };
}

/**
 * Yetkazish/olib ketish uchun to'liq hisob.
 *
 * @param basePriceTiyin  taomlar summasi (restoran narxi)
 * @param agreement       CommissionAgreement yoki null
 * @param deliveryMarkupPercent  restoran belgilagan ustama
 */
export function priceDelivery(basePriceTiyin, agreement, deliveryMarkupPercent = 0) {
  const base = Math.round(Number(basePriceTiyin) || 0);
  if (base < 0) throw new Error('Narx manfiy bo\u2018lishi mumkin emas');

  const markup = Number(deliveryMarkupPercent || 0);
  const restCom = Number(agreement?.restaurantCommissionPercent || 0);
  const custFee = Number(agreement?.customerFeePercent || 0);

  // Ikkala miqdor ham MUSTAQIL, bazadan hisoblanadi
  const markupAmount = applyPercent(base, markup);
  const customerFeeAmount = applyPercent(base, custFee);
  const restaurantCommissionAmount = applyPercent(base, restCom);

  const deliveryPrice = base + markupAmount;               // faqat ko'rsatish uchun
  const customerFinalPrice = base + markupAmount + customerFeeAmount;

  const restaurantPayoutAmount = base + markupAmount - restaurantCommissionAmount;
  const lokmaGrossRevenue = restaurantCommissionAmount + customerFeeAmount;

  return {
    basePrice: base,
    deliveryMarkupPercent: markup,
    deliveryPrice,
    customerFeePercent: custFee,
    customerFeeAmount,
    customerFinalPrice,
    restaurantCommissionPercent: restCom,
    aggregatedSplitPercent: restCom + custFee,
    billingBase: 'BASE_ADDITIVE',
    restaurantPayoutAmount,
    lokmaGrossRevenue,
  };
}

/** Buyurtma turiga qarab tanlaydi. */
export function priceOrder({ basePriceTiyin, fulfillment, agreement, deliveryMarkupPercent }) {
  if (fulfillment === 'dinein' || fulfillment === 'reservation') {
    return priceDineIn(basePriceTiyin);
  }
  return priceDelivery(basePriceTiyin, agreement, deliveryMarkupPercent);
}
