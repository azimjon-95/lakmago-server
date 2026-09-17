import { computeOrderFinance, reconcile } from './orderFinance.js';

/*
 * ═══════════════════════════════════════════════════════════
 * REFUND — SNAPSHOT ASOSIDA QAYTARISH
 * ═══════════════════════════════════════════════════════════
 *
 * ASOSIY QOIDA: `Order.finance` HECH QACHON o'zgartirilmaydi.
 * U buyurtma yaratilgandagi holatni abadiy saqlaydi. Qaytarish
 * ALOHIDA teskari yozuv sifatida hisoblanadi.
 *
 *   original Order → Order.finance (o'zgarmas)
 *                         ↓
 *                 refund calculation
 *                         ↓
 *                 refund Ledger yozuvi
 *
 * Audit tarixida uchalasi ham ko'rinadi: asl summa, qaytarilgan
 * summa, qolgan summa.
 *
 * ─── QISMAN QAYTARISH ───
 * 2 ta taomdan bittasi qaytarilsa, BUTUN buyurtma teskari
 * qilinmaydi. Qaytarilayotgan taom ulushi bo'yicha PROPORSIONAL
 * hisoblanadi: komissiya, mijoz haqi, shlyuz taqsimoti — hammasi.
 *
 * Yetkazish haqi faqat HAQIQATAN qaytarilayotgan bo'lsa teskari
 * qilinadi. Faqat taom qaytarilsa `deliveryFee reversal = 0`:
 * kuryer ishini bajargan, uning puli qaytarilmaydi.
 *
 * ─── BONUS ───
 * Bonus/promo tizimi hozircha MAVJUD EMAS va bu hisobga
 * KIRITILMAGAN. Kelajakda alohida feature sifatida qo'shiladi.
 */

/** Buyurtma elementlarining baza summasi (tiyinda). */
export function itemsBaseTiyin(items) {
  return (items || []).reduce(
    (sum, it) => sum + Math.round((Number(it?.unitPrice) || 0) * 100) * (Number(it?.quantity) || 0),
    0,
  );
}

/**
 * Qaytarish hisobini tuzadi.
 *
 * @param {object} finance            Order.finance (o'zgarmas snapshot)
 * @param {object} opts
 * @param {number} [opts.foodBaseRefundTiyin]  qaytarilayotgan taom BAZA summasi.
 *                 Berilmasa — to'liq qaytarish (butun `finance.foodBase`)
 * @param {boolean} [opts.refundDelivery]      yetkazish ham qaytarilsinmi
 * @param {number} [opts.alreadyRefundedFoodBaseTiyin] avval qaytarilgani
 *
 * @returns {{ refund:object, isFull:boolean, remaining:object }}
 *   `refund` — qaytariladigan summalar (musbat, tiyinda)
 */
export function computeRefund(finance, {
  foodBaseRefundTiyin = null,
  refundDelivery = null,
  alreadyRefundedFoodBaseTiyin = 0,
} = {}) {
  if (!finance || finance.model !== 'v2') {
    throw new Error('Refund faqat v2 moliyaviy snapshot bilan ishlaydi');
  }

  const totalFoodBase = Math.round(Number(finance.foodBase) || 0);
  const already = Math.max(0, Math.round(Number(alreadyRefundedFoodBaseTiyin) || 0));
  const available = Math.max(0, totalFoodBase - already);

  // Berilmasa — qolganining HAMMASI
  let refundBase = foodBaseRefundTiyin === null
    ? available
    : Math.round(Number(foodBaseRefundTiyin) || 0);

  if (refundBase < 0) throw new Error('Qaytarish summasi manfiy bo‘lishi mumkin emas');
  if (refundBase > available) {
    throw new Error(
      `Qaytarish summasi qolgan summadan katta: ${refundBase} > ${available} tiyin`,
    );
  }

  const isFull = refundBase === available && already === 0;

  /*
   * Yetkazish: aniq ko'rsatilmagan bo'lsa — faqat TO'LIQ
   * qaytarishda qaytariladi. Qisman qaytarishda kuryer ishini
   * bajargan, uning puli qaytarilmaydi.
   */
  const withDelivery = refundDelivery === null ? isFull : Boolean(refundDelivery);

  /*
   * Chegirma proporsional bo'linadi: 10 000 dan 2 000 chegirma
   * berilgan bo'lsa va yarmi qaytarilsa — 1 000 chegirma ham
   * teskari qilinadi.
   */
  const ratio = totalFoodBase > 0 ? refundBase / totalFoodBase : 0;
  const discountRefund = Math.round((Number(finance.discountAmount) || 0) * ratio);

  /*
   * Qaytariladigan qism uchun hisob AYNAN shu foizlar bilan
   * qayta quriladi — shuning uchun rekonsiliatsiya bu yerda ham
   * ishlaydi va qaytarilgan pul taqsimoti asl taqsimot bilan
   * bir xil mantiqda bo'ladi.
   */
  const refund = computeOrderFinance({
    foodBaseTiyin: refundBase,
    discountTiyin: discountRefund,
    deliveryFeeTiyin: withDelivery ? (Number(finance.deliveryFee) || 0) : 0,
    deliveryMarkupPercent: finance.deliveryMarkupPercent || 0,
    customerFeePercent: finance.customerFeePercent || 0,
    restaurantCommissionPercent: finance.restaurantCommissionPercent || 0,
    paymentFeePercent: finance.clickFeePercent || 0,
    deliveryFeeAbsorbedByLokma: Boolean(finance.deliveryFeeAbsorbedByLokma),
  });

  const refundedFoodBaseAfter = already + refundBase;

  return {
    refund,
    isFull,
    withDelivery,
    remaining: {
      foodBase: totalFoodBase - refundedFoodBaseAfter,
      refundedFoodBase: refundedFoodBaseAfter,
      originalFoodBase: totalFoodBase,
    },
  };
}

/**
 * Qaytarish hisobining yaxlitligini tekshiradi.
 * Qaytarilgan summalar asl snapshotdan OSHIB ketmasligi kerak.
 */
export function validateRefund(finance, refund) {
  const problems = [];

  const check = (field) => {
    const orig = Math.round(Number(finance[field]) || 0);
    const ref = Math.round(Number(refund[field]) || 0);
    if (ref > orig) problems.push(`${field}: qaytarish ${ref} > asl ${orig}`);
  };

  ['totalCharged', 'restaurantPayout', 'lokmaGrossCommission', 'deliveryFee', 'clickFeeAmount']
    .forEach(check);

  const r = reconcile(refund);
  if (!r.ok) problems.push(`rekonsiliatsiya buzilgan: ${r.diff} tiyin`);

  return { ok: problems.length === 0, problems };
}
