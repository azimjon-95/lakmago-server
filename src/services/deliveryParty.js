/*
 * ═══════════════════════════════════════════════════════════════
 * KIM YETKAZADI va YETKAZISH PULI KIMGA — YAGONA MANBA (sof funksiyalar)
 * ═══════════════════════════════════════════════════════════════
 *
 * Restoranning yetkazish rejimi (`Restaurant.courierMode`) — FAQAT LokmaGo admini o'zgartiradi:
 *   'own'   — restoranning o'z kuryeri (HOZIRGIDEK). Yetkazish puli 100% restoranga.
 *   'lokma' — LokmaGo kuryeri. Buyurtma umumiy "qutiga" (pool) tushadi, kim ulgursa — o'sha oladi.
 *   'both'  — ikkalasi: restoran HAR buyurtmada tanlaydi ("O'zim yetkazaman" / "LokmaGo kuryeri").
 *
 * LokmaGo kuryeri yetkazganda (party = 'lokma'):
 *   • Yetkazish puli restoranga BERILMAYDI (restaurantDeliveryPayout = 0; restoranga faqat taom ulushi).
 *   • Kuryer ulushi: nominal yetkazish narxi × (1 − p), p — LokmaGo foizi (admin boshqaradi, standart 10%).
 *     Masalan 30 000 so'm, 10% → kuryerga 27 000, LokmaGo'ga 3 000.
 *   • TEKIN yetkazish (admin yoqsa, faqat 'lokma' rejimida): mijozdan yetkazish OLINMAYDI (0 so'm),
 *     kuryer ulushini LokmaGo o'z hisobidan to'laydi (deliverySubsidy). LokmaGo bu holatda foiz olmaydi.
 *
 * BIRLIK: TIYIN (butun son), orderFinance.js bilan bir xil. Bu fayl bazaga/tarmoqqa murojaat QILMAYDI.
 *
 * REKONSILIATSIYA (har tiyin hisobda, orderFinance.reconcile):
 *   restaurantPayout + courierPayout + lokmaNetCommission + clickFeeAmount === totalCharged
 *   (party = 'restaurant' da courierPayout = 0 → avvalgi formula o'zgarmaydi).
 */

export const COURIER_MODES = ['own', 'lokma', 'both'];
export const PARTIES = ['restaurant', 'lokma'];
export const DEFAULT_COURIER_PERCENT = 10;

const int = (v) => Math.round(Number(v) || 0);
function applyPercent(amountTiyin, percent) {
  const bp = Math.round(Number(percent || 0) * 100);
  if (bp <= 0) return 0;
  return Math.round((Math.round(amountTiyin) * bp) / 10000);
}

export function normalizePercent(p, fallback = DEFAULT_COURIER_PERCENT) {
  const n = Number(p);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(100, Math.max(0, Math.round(n * 100) / 100));
}

/** Restoran uchun amaldagi LokmaGo foizi: restoranga alohida belgilangan bo'lsa — o'sha, aks holda global. */
export function courierPercentFor(restaurant, settings) {
  const own = restaurant?.lokmaCourierPercent;
  if (own !== null && own !== undefined && own !== '' && Number.isFinite(Number(own))) return normalizePercent(own);
  return normalizePercent(settings?.courier?.commissionPercent, DEFAULT_COURIER_PERCENT);
}

export const courierModeOf = (restaurant) => (COURIER_MODES.includes(restaurant?.courierMode) ? restaurant.courierMode : 'own');

/** Buyurtma yaratilganda kim yetkazishi: 'own' → restoran, 'lokma' → LokmaGo, 'both' → hali noma'lum (restoran tanlaydi). */
export function initialParty(restaurant) {
  const mode = courierModeOf(restaurant);
  if (mode === 'lokma') return 'lokma';
  if (mode === 'own') return 'restaurant';
  return null;
}

/** Tekin yetkazish FAQAT 'lokma' rejimida: 'both'/'own' da restoran o'zi tekinga yetkazib qolmasin. */
export const isFreeByLokma = (restaurant) => courierModeOf(restaurant) === 'lokma' && restaurant?.lokmaFreeDelivery === true;

/**
 * Narx kotirovkasiga tekin yetkazishni qo'llaydi (deliveryEngine.quoteDelivery natijasi, so'mda).
 * Mijoz narxi 0, haqiqiy narx `nominalPrice` da saqlanadi (kuryer ulushi shundan hisoblanadi).
 */
export function applyLokmaFreeDelivery(quote, restaurant) {
  if (!quote || quote.available === false) return quote;
  const nominalPrice = Number(quote.nominalPrice ?? quote.price) || 0;
  if (!isFreeByLokma(restaurant)) return { ...quote, nominalPrice };
  return { ...quote, price: 0, nominalPrice, freeByLokma: true };
}

/** Kuryer ulushi va LokmaGo foizi (tiyin). */
export function splitCourierFee(nominalTiyin, percent) {
  const nominal = Math.max(0, int(nominalTiyin));
  const lokma = applyPercent(nominal, normalizePercent(percent));
  return { nominal, courier: nominal - lokma, lokma };
}

/**
 * Moliya snapshot'iga yetkazuvchini qo'llaydi (YANGI obyekt qaytaradi, kirishni o'zgartirmaydi).
 *
 * @param {object} finance  computeOrderFinance natijasi (deliveryFee — MIJOZ to'lagan yetkazish)
 * @param {object} o
 * @param {'restaurant'|'lokma'|null} o.party
 * @param {number} [o.nominalDeliveryFeeTiyin]  haqiqiy yetkazish narxi (tekinda mijoz 0 to'laydi, nominal saqlanadi)
 * @param {number} [o.percent]                  LokmaGo foizi
 * @param {boolean} [o.free]                    tekin yetkazish (LokmaGo hisobidan)
 */
export function applyDeliveryParty(finance, { party = 'restaurant', nominalDeliveryFeeTiyin, percent = DEFAULT_COURIER_PERCENT, free = false } = {}) {
  if (!finance) return finance;
  const f = { ...finance };
  const customerDelivery = int(f.deliveryFee);
  const free_ = Boolean(free) && party === 'lokma';
  const nominal = Math.max(0, int(nominalDeliveryFeeTiyin ?? customerDelivery));
  if (free_ && customerDelivery !== 0) throw new Error('Tekin yetkazishda mijozdan yetkazish puli olinmasligi kerak');
  if (!free_ && party === 'lokma' && nominal !== customerDelivery) {
    throw new Error('LokmaGo kuryerida nominal narx mijoz to‘lagan yetkazishga teng bo‘lishi kerak');
  }

  // Asos (restoran ulushi yetkazishsiz) — avvalgi qo'llanishdan qat'i nazar qaytadan
  const lokmaNetBase = int(f.lokmaGrossCommission) - int(f.clickFeeAmount);
  f.courierParty = party ?? null;
  f.nominalDeliveryFee = nominal;
  f.freeDeliveryByLokma = free_;

  if (party === 'lokma') {
    const pct = normalizePercent(percent);
    const { courier, lokma } = splitCourierFee(nominal, pct);
    f.courierCommissionPercent = pct;
    f.courierPayout = courier;
    f.lokmaDeliveryCommission = free_ ? 0 : lokma;          // tekinda LokmaGo foiz olmaydi — o'zi to'laydi
    f.deliverySubsidy = free_ ? courier : 0;                // LokmaGo kuryerga o'z hisobidan to'laydigan pul
    f.restaurantDeliveryPayout = 0;
  } else {
    // Restoran kuryeri yoki hali noma'lum ('both' — tanlanmagan): yetkazish puli restoranga (HOZIRGIDEK)
    f.courierCommissionPercent = 0;
    f.courierPayout = 0;
    f.lokmaDeliveryCommission = 0;
    f.deliverySubsidy = 0;
    f.restaurantDeliveryPayout = customerDelivery;
  }
  f.restaurantPayout = int(f.restaurantFoodPayout) + f.restaurantDeliveryPayout;
  f.deliveryPayout = f.restaurantDeliveryPayout;            // eski nom bilan moslik
  f.lokmaNetCommission = lokmaNetBase + f.lokmaDeliveryCommission - f.deliverySubsidy;
  f.lokmaCashNet = int(f.totalCharged) - f.restaurantPayout - f.courierPayout - int(f.clickFeeAmount);
  return f;
}

/**
 * LokmaGo kuryeri yetkazgach uning balansiga yoziladigan harakatlar (tiyin).
 * Balans: musbat — LokmaGo kuryerga qarzdor, manfiy — kuryer LokmaGo'ga qarzdor (qo'lidagi naqd).
 *
 *   NAQD:  kuryer mijozdan JAMI summani oldi (−totalCharged: bu pul LokmaGo'niki) va o'z ulushini oladi (+courierPayout).
 *          Restoranga taom ulushini LokmaGo to'laydi (restoran hisobiga — billing.settleOrder, karta kabi).
 *   KARTA: pul LokmaGo'da — kuryerga faqat ulushi (+courierPayout).
 */
export function courierSettlement(finance, { paymentMethod } = {}) {
  if (!finance || finance.courierParty !== 'lokma') return [];
  const entries = [];
  if (paymentMethod === 'cash') entries.push({ type: 'courier_cash', amount: -int(finance.totalCharged) });
  if (int(finance.courierPayout) > 0) entries.push({ type: 'courier_earning', amount: int(finance.courierPayout) });
  return entries;
}

/** Naqd buyurtmada kuryer qo'liga oladigan va LokmaGo'ga qaytarishi kerak bo'lgan summa (balansga ta'siri, tiyin). */
export function cashExposure(finance, paymentMethod) {
  if (paymentMethod !== 'cash') return -int(finance?.courierPayout);   // karta: balans oshadi (manfiy ta'sir)
  return int(finance?.totalCharged) - int(finance?.courierPayout);
}
