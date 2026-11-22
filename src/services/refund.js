import { reconcile } from './orderFinance.js';

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
 * @param {number} [opts.alreadyRefundedFoodBaseTiyin] avval qaytarilgan taom
 * @param {boolean} [opts.deliveryAlreadyRefunded] yetkazish avval qaytarilganmi
 *
 * @returns {{ refund:object, isFull:boolean, remaining:object }}
 *   `refund` — qaytariladigan summalar (musbat, tiyinda)
 */
export function computeRefund(finance, {
  foodBaseRefundTiyin = null,
  refundDelivery = null,
  alreadyRefundedFoodBaseTiyin = 0,
  deliveryAlreadyRefunded = false,
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
  let withDelivery = refundDelivery === null ? isFull : Boolean(refundDelivery);

  /*
   * ═══ YETKAZISH IKKI MARTA QAYTARILMASIN ═══
   *
   * Taom summasi qismlarga bo'linadi va har qismi alohida
   * kuzatiladi, yetkazish esa BO'LINMAYDI — u bir butun.
   * Ikki marta `refundDelivery: true` bilan chaqirilsa, tekshiruvsiz
   * 5 000 so'mlik yetkazish 10 000 bo'lib qaytarilardi.
   *
   * Shuning uchun u alohida bayroq bilan nazorat qilinadi:
   * bir marta qaytarilgan bo'lsa, keyingi qaytarishlarda
   * yetkazish summasi 0 bo'ladi.
   */
  if (withDelivery && deliveryAlreadyRefunded) {
    withDelivery = false;
  }

  /*
   * ═══ TELESKOPIK PROPORSIYA (audit F-04, F-10) ═══
   *
   * Ilgari qaytariladigan qism foizlar bilan QAYTADAN hisoblanardi (computeOrderFinance). Ikki muammo bor edi:
   *   1) yetkazuvchi hisobga olinmasdi — LokmaGo kuryeri yetkazgan buyurtmada yetkazish restoran ulushiga
   *      qo'shilib, tekshiruv yiqilar va qaytarish JURNALGA UMUMAN YOZILMASDI;
   *   2) ketma-ket qisman qaytarishlar yaxlitlash sabab asl summadan 1–2 tiyin farq qilardi.
   *
   * Endi har bir asosiy bo'lak ASL snapshot'dan olinadi:
   *     qism = round(asl × kumulyativ_keyin / jami) − round(asl × kumulyativ_oldin / jami)
   * Barcha qismlar yig'indisi asl summaga ANIQ teng (teleskopik), oxirgi qism qoldiqni o'zi oladi.
   * Qolgan maydonlar shu bo'laklardan keltirib chiqariladi — shuning uchun reconcile() har qismda aniq.
   * Yetkazish bo'linmaydi: qaytarilsa asl snapshot'dagi taqsimot (restoran / kuryer / LokmaGo) to'liq teskari.
   */
  const n = (v) => Math.round(Number(v) || 0);
  const cumShare = (orig, cum) => {
    if (!totalFoodBase) return 0;
    const o = BigInt(n(orig));
    const neg = o < 0n;
    const num = (neg ? -o : o) * BigInt(cum) * 2n + BigInt(totalFoodBase);
    const v = num / (BigInt(totalFoodBase) * 2n);          // yaqin butun songa (half-up)
    return Number(neg ? -v : v);
  };
  const before = already;
  const after = already + refundBase;
  const part = (orig) => cumShare(orig, after) - cumShare(orig, before);

  const discountAmount = part(finance.discountAmount);
  const deliveryMarkupAmount = part(finance.deliveryMarkupAmount);
  const customerFeeAmount = part(finance.customerFeeAmount);
  const restaurantCommissionAmount = part(finance.restaurantCommissionAmount);
  const clickFoodFeeAmount = part(finance.clickFoodFeeAmount);
  const clickNonDelivery = part(n(finance.clickFeeAmount) - n(finance.clickDeliveryFeeAmount));

  const foodSubtotal = refundBase - discountAmount + deliveryMarkupAmount;
  const customerFoodTotal = foodSubtotal + customerFeeAmount;
  const restaurantFoodPayout = foodSubtotal - restaurantCommissionAmount;
  const lokmaGrossCommission = customerFeeAmount + restaurantCommissionAmount;

  const d = (field) => (withDelivery ? n(finance[field]) : 0);
  const deliveryFee = d('deliveryFee');
  // Eski snapshot'larda restaurantDeliveryPayout bo'lmasa — yetkazish restoranniki edi
  const restaurantDeliveryPayout = withDelivery
    ? (finance.restaurantDeliveryPayout === undefined || finance.restaurantDeliveryPayout === null
      ? n(finance.deliveryFee) : n(finance.restaurantDeliveryPayout))
    : 0;
  const courierPayout = d('courierPayout');
  const lokmaDeliveryCommission = d('lokmaDeliveryCommission');
  const deliverySubsidy = d('deliverySubsidy');
  const clickDeliveryFeeAmount = d('clickDeliveryFeeAmount');

  const clickFeeAmount = clickNonDelivery + clickDeliveryFeeAmount;
  const totalCharged = customerFoodTotal + deliveryFee;
  const restaurantPayout = restaurantFoodPayout + restaurantDeliveryPayout;
  const lokmaNetCommission = lokmaGrossCommission - clickFeeAmount + lokmaDeliveryCommission - deliverySubsidy;

  const refund = {
    model: finance.model,
    currency: finance.currency || 'UZS',
    unit: 'tiyin',
    foodBase: refundBase,
    discountAmount,
    deliveryMarkupPercent: Number(finance.deliveryMarkupPercent) || 0,
    deliveryMarkupAmount,
    foodSubtotal,
    deliveryFee,
    customerFeePercent: Number(finance.customerFeePercent) || 0,
    customerFeeAmount,
    restaurantCommissionPercent: Number(finance.restaurantCommissionPercent) || 0,
    restaurantCommissionAmount,
    customerFoodTotal,
    totalCharged,
    clickFeePercent: Number(finance.clickFeePercent) || 0,
    clickFeeAmount,
    clickFoodFeeAmount,
    clickDeliveryFeeAmount,
    clickResidualAmount: clickNonDelivery - clickFoodFeeAmount,
    restaurantFoodPayout,
    restaurantDeliveryPayout,
    restaurantPayout,
    lokmaGrossCommission,
    lokmaFoodPaymentFee: clickFeeAmount,
    lokmaNetCommission,
    lokmaCashNet: totalCharged - restaurantPayout - courierPayout - clickFeeAmount,
    deliveryPayout: restaurantDeliveryPayout,
    courierParty: finance.courierParty ?? null,
    courierPayout,
    lokmaDeliveryCommission,
    deliverySubsidy,
    nominalDeliveryFee: d('nominalDeliveryFee'),
    deliveryFeeAbsorbedByLokma: Boolean(finance.deliveryFeeAbsorbedByLokma),
    calculatedAt: new Date(),
  };

  const refundedFoodBaseAfter = already + refundBase;

  return {
    refund,
    isFull,
    withDelivery,
    deliveryRefunded: withDelivery,
    remaining: {
      foodBase: totalFoodBase - refundedFoodBaseAfter,
      refundedFoodBase: refundedFoodBaseAfter,
      originalFoodBase: totalFoodBase,
      deliveryRefunded: Boolean(deliveryAlreadyRefunded) || withDelivery,
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

  ['totalCharged', 'restaurantPayout', 'lokmaGrossCommission', 'deliveryFee', 'clickFeeAmount', 'courierPayout']
    .forEach(check);

  const r = reconcile(refund);
  if (!r.ok) problems.push(`rekonsiliatsiya buzilgan: ${r.diff} tiyin`);

  return { ok: problems.length === 0, problems };
}
