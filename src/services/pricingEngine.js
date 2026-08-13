/**
 * Narx dvigateli.
 *
 * Zanjir (har foiz FAQAT BIR MARTA qo'llanadi):
 *
 *   BasePrice
 *     → × (1 + DeliveryMarkup%)   = DeliveryPrice
 *     → + DeliveryPrice × CustomerFee%  = CustomerFinalPrice
 *     → bo'linish: restoran / LokmaGo
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
  const billingBase = agreement?.billingBase || 'CUSTOMER_FINAL_PRICE';

  // 1-bosqich: restoran ustamasi
  const deliveryPrice = base + applyPercent(base, markup);

  // 2-bosqich: mijoz xizmat haqi — DeliveryPrice dan (base dan emas)
  const customerFeeAmount = applyPercent(deliveryPrice, custFee);
  const customerFinalPrice = deliveryPrice + customerFeeAmount;

  // 3-bosqich: bo'linish
  const aggregated = restCom + custFee;

  let restaurantPayout;
  if (billingBase === 'DELIVERY_PRICE') {
    /*
     * Zanjirli qoida: restoran o'z narxini oladi, undan faqat
     * O'Z komissiyasi chegiriladi. Mijoz haqi LokmaGo'ga o'tadi.
     * 0% komissiyada restoran hech narsa yo'qotmaydi.
     */
    restaurantPayout = deliveryPrice - applyPercent(deliveryPrice, restCom);
  } else {
    // Yig'ma qoida: umumiy foiz yakuniy summadan
    restaurantPayout = customerFinalPrice - applyPercent(customerFinalPrice, aggregated);
  }

  // LokmaGo — AYIRMA: tiyin yo'qolmaydi, yig'indi doim to'g'ri
  const lokmaGross = customerFinalPrice - restaurantPayout;

  return {
    basePrice: base,
    deliveryMarkupPercent: markup,
    deliveryPrice,
    customerFeePercent: custFee,
    customerFeeAmount,
    customerFinalPrice,
    restaurantCommissionPercent: restCom,
    aggregatedSplitPercent: aggregated,
    billingBase,
    restaurantPayoutAmount: restaurantPayout,
    lokmaGrossRevenue: lokmaGross,
  };
}

/** Buyurtma turiga qarab tanlaydi. */
export function priceOrder({ basePriceTiyin, fulfillment, agreement, deliveryMarkupPercent }) {
  if (fulfillment === 'dinein' || fulfillment === 'reservation') {
    return priceDineIn(basePriceTiyin);
  }
  return priceDelivery(basePriceTiyin, agreement, deliveryMarkupPercent);
}
