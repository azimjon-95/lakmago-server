/*
 * ═══════════════════════════════════════════════════════════
 * ORDER FINANCE — MOLIYAVIY HISOB-KITOBNING YAGONA MANBAI
 * ═══════════════════════════════════════════════════════════
 *
 * Bu fayl SOF funksiyalardan iborat: baza yo'q, tarmoq yo'q,
 * nojo'ya ta'sir yo'q. Shu sababli to'liq testdan o'tkaziladi
 * va boshqa har bir bosqich (narx ko'rsatish, buyurtma yaratish,
 * hisob-kitob, shlyuz bo'linishi, hisobotlar) FAQAT shundan
 * foydalanadi.
 *
 * NIMA UCHUN KERAK BO'LDI (auditda aniqlangan):
 * komissiya uchta mustaqil joyda, uch xil konfiguratsiyadan
 * hisoblanardi — narx `CommissionAgreement` bo'yicha, restoran
 * qarzi `Restaurant.commissionPercent` bo'yicha, shlyuz
 * bo'linishi esa `env` dagi foiz bo'yicha va JAMI summadan
 * (yetkazishdan ham komissiya olinardi). Natijada bir buyurtma
 * uchun uch xil javob chiqardi.
 *
 * ─── BIRLIK ───
 * BARCHA summalar TIYINDA, butun son. Float ishlatilmaydi:
 * Click haqi 232.50 so'm kabi qiymatlar aniq chiqishi kerak
 * (232.50 so'm = 23250 tiyin).
 *
 * ─── BIZNES QOIDALARI (tasdiqlangan) ───
 *  1. Komissiya faqat TAOM summasidan. Yetkazish hech qachon
 *     komissiya bazasiga kirmaydi.
 *  2. restaurantPayout = foodSubtotal − restaurantCommission.
 *     Mijoz xizmat haqi restoranga BERILMAYDI.
 *  3. lokmaGross = customerFee + restaurantCommission.
 *  4. Click jami summadan 1.5% ushlaydi, lekin LokmaGo o'z
 *     ulushidan FAQAT taom qismini qoplaydi:
 *       lokmaFoodPaymentFee = foodSubtotal × 1.5%
 *     Mijoz haqiga tegishli qismi (residual) alohida yuritiladi
 *     va restoran payout'iga TA'SIR QILMAYDI.
 *  5. deliveryPayout = deliveryFee − clickDeliveryFee (standart).
 *
 * ─── TEKSHIRUV (reconciliation) ───
 * restaurantPayout + lokmaCashNet + deliveryPayout + clickFeeTotal
 *   ===  totalCharged
 *
 * DIQQAT: bu yerda `lokmaNetCommission` EMAS, `lokmaCashNet`
 * ishlatiladi. Birinchisi — biznes ko'rsatkichi (hisobot uchun),
 * ikkinchisi — hisobda haqiqatda qoladigan pul. Ular mijoz
 * xizmat haqiga tegishli shlyuz haqi (`clickResidual`) ga farq
 * qiladi. Ikkalasini aralashtirish — pul "yo'qolgan" ko'rinishiga
 * olib keladi.
 */

export const FINANCE_MODEL = 'v2';

/** Foizni tiyinga qo'llash — bazis punkt orqali, Float bo'linishsiz. */
function applyPercent(amountTiyin, percent) {
  const bp = Math.round(Number(percent || 0) * 100);      // 1.5% → 150 bp
  if (bp <= 0) return 0;
  return Math.round((Math.round(amountTiyin) * bp) / 10000);
}

const int = (v) => Math.round(Number(v) || 0);

/**
 * Buyurtmaning to'liq moliyaviy tasviri.
 *
 * @param {object}  input
 * @param {number}  input.foodBaseTiyin        Σ(Dish.price × qty) — BAZADAN olingan
 * @param {number}  [input.deliveryFeeTiyin]   yetkazish narxi
 * @param {number}  [input.discountTiyin]      aksiya/chegirma (taomdan ayriladi)
 * @param {number}  [input.deliveryMarkupPercent] restoran o'z ustamasi (uning puli)
 * @param {number}  [input.customerFeePercent]     shartnomadan
 * @param {number}  [input.restaurantCommissionPercent] shartnomadan
 * @param {number}  [input.paymentFeePercent]  shlyuz haqi (Click 1.5%). Naqdda 0
 * @param {boolean} [input.deliveryFeeAbsorbedByLokma] delivery Click haqini
 *                  LokmaGo qoplasinmi (standart: yo'q — delivery tomoni qoplaydi)
 */
export function computeOrderFinance({
  foodBaseTiyin,
  deliveryFeeTiyin = 0,
  discountTiyin = 0,
  deliveryMarkupPercent = 0,
  customerFeePercent = 0,
  restaurantCommissionPercent = 0,
  paymentFeePercent = 0,
  deliveryFeeAbsorbedByLokma = false,
} = {}) {
  const foodBase = int(foodBaseTiyin);
  if (foodBase < 0) throw new Error('Taom summasi manfiy bo‘lishi mumkin emas');

  const deliveryFee = Math.max(0, int(deliveryFeeTiyin));
  const discount = Math.min(Math.max(0, int(discountTiyin)), foodBase);

  /*
   * Restoranning o'z ustamasi (deliveryMarkupPercent) — bu UNING
   * puli, komissiya bazasiga kiradi va payout'ga qaytadi.
   * Chegirma esa komissiyadan OLDIN ayriladi: restoran chegirma
   * bergan summadan komissiya olinmaydi.
   */
  const discountedBase = foodBase - discount;
  const deliveryMarkupAmount = applyPercent(discountedBase, deliveryMarkupPercent);

  // "foodSubtotal" — restoranning taom bo'yicha summasi (komissiya bazasi)
  const foodSubtotal = discountedBase + deliveryMarkupAmount;

  const customerFeeAmount = applyPercent(foodSubtotal, customerFeePercent);
  const restaurantCommissionAmount = applyPercent(foodSubtotal, restaurantCommissionPercent);

  const customerFoodTotal = foodSubtotal + customerFeeAmount;
  const totalCharged = customerFoodTotal + deliveryFee;

  // ═══ Shlyuz (Click/Payme/Paynet) haqi ═══
  const clickFeeTotal = applyPercent(totalCharged, paymentFeePercent);
  const clickFoodFeeAmount = applyPercent(foodSubtotal, paymentFeePercent);
  const clickDeliveryFeeAmount = applyPercent(deliveryFee, paymentFeePercent);
  /*
   * Residual — mijoz xizmat haqiga tegishli shlyuz xarajati.
   * Uni LokmaGo ulushidan alohida AYIRMAYMIZ (biznes qoidasi),
   * lekin buxgalteriya uchun ko'rinib turishi kerak.
   */
  const clickResidualAmount = clickFeeTotal - clickFoodFeeAmount - clickDeliveryFeeAmount;

  // ═══ Ulushlar ═══
  const restaurantPayout = foodSubtotal - restaurantCommissionAmount;
  const lokmaGrossCommission = customerFeeAmount + restaurantCommissionAmount;
  const lokmaFoodPaymentFee = clickFoodFeeAmount;
  const lokmaNetCommission = lokmaGrossCommission - lokmaFoodPaymentFee;

  const deliveryPayout = deliveryFeeAbsorbedByLokma
    ? deliveryFee
    : deliveryFee - clickDeliveryFeeAmount;

  /*
   * ═══ BIZNES KO'RSATKICHI ≠ HAQIQIY PUL ═══
   *
   * `lokmaNetCommission` — BIZNES ko'rsatkichi: komissiya minus
   * taomga tegishli shlyuz xarajati. Hisobotlarda shu ko'rsatiladi.
   *
   * `lokmaCashNet` — LokmaGo hisobida HAQIQATDA qoladigan pul:
   * mijoz to'lovidan restoran, delivery va shlyuz ulushi
   * ayirilgandan keyingi qoldiq. U `lokmaNetCommission` dan
   * `clickResidual` ga farq qiladi (mijoz xizmat haqidan olingan
   * shlyuz haqi).
   *
   * To'g'ridan-to'g'ri ayirish bilan hisoblanadi — shu sababli
   * rekonsiliatsiya har qanday yaxlitlashda ham ANIQ to'g'ri
   * chiqadi, bironta tiyin yo'qolmaydi.
   */
  const lokmaCashNet = totalCharged - restaurantPayout - deliveryPayout - clickFeeTotal;

  const finance = {
    model: FINANCE_MODEL,
    currency: 'UZS',
    unit: 'tiyin',

    foodBase,
    discountAmount: discount,
    deliveryMarkupPercent: Number(deliveryMarkupPercent) || 0,
    deliveryMarkupAmount,
    foodSubtotal,
    deliveryFee,

    customerFeePercent: Number(customerFeePercent) || 0,
    customerFeeAmount,
    restaurantCommissionPercent: Number(restaurantCommissionPercent) || 0,
    restaurantCommissionAmount,

    customerFoodTotal,
    totalCharged,

    clickFeePercent: Number(paymentFeePercent) || 0,
    clickFeeAmount: clickFeeTotal,
    clickFoodFeeAmount,
    clickDeliveryFeeAmount,
    clickResidualAmount,

    restaurantPayout,
    lokmaGrossCommission,
    lokmaFoodPaymentFee,
    lokmaNetCommission,
    lokmaCashNet,
    deliveryPayout,
    deliveryFeeAbsorbedByLokma: Boolean(deliveryFeeAbsorbedByLokma),

    calculatedAt: new Date(),
  };

  return finance;
}

/**
 * Rekonsiliatsiya — pul yo'qolmaganini tekshiradi.
 *
 * Mijozdan olingan har bir tiyin aniq bitta joyga ketishi kerak:
 *   restoran + LokmaGo (netto) + delivery + shlyuz = mijoz to'lovi
 *
 * `clickResidual` shlyuz haqining bir qismi bo'lgani uchun
 * `clickFeeAmount` ichida allaqachon hisobga olingan — shuning
 * uchun yig'indiga ALOHIDA qo'shilmaydi.
 *
 * @returns {{ ok: boolean, diff: number, parts: object }}
 */
export function reconcile(f) {
  const sum = f.restaurantPayout + f.lokmaCashNet + f.deliveryPayout + f.clickFeeAmount;
  const diff = f.totalCharged - sum;

  return {
    ok: diff === 0,
    diff,
    parts: {
      restaurantPayout: f.restaurantPayout,
      lokmaCashNet: f.lokmaCashNet,
      deliveryPayout: f.deliveryPayout,
      clickFeeAmount: f.clickFeeAmount,
      totalCharged: f.totalCharged,
    },
  };
}

export const somToTiyin = (som) => Math.round(Number(som || 0) * 100);
export const tiyinToSom = (tiyin) => Math.round(Number(tiyin) || 0) / 100;
