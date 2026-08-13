import { config } from '../config/index.js';

/**
 * To'lovni bo'lish hisobi.
 *
 * QOIDA: barcha summalar TIYINDA, butun son. JS Float ishlatilmaydi —
 * 0.1 + 0.2 !== 0.3 muammosi pulda yo'l qo'yilmaydi.
 *
 * Yaxlitlash qoidasi: restoran ulushi yaxlitlanadi, LokmaGo ulushi
 * AYIRMA sifatida olinadi. Shunda:
 *   restoran + lokma === jami   (har doim, tiyinsiz farqsiz)
 * Bu muhim: to'lov tizimlari bo'linma summasi jamiga aynan teng
 * bo'lishini talab qiladi, aks holda tranzaksiyani rad etadi.
 * Yaxlitlash farqi doim LokmaGo tomonida qoladi — restoran uchun
 * xavfsiz.
 */

/** Foizni tiyinga qo'llaydi. Butun son qaytaradi (pastga yaxlitlash). */
function percentOf(amountTiyin, percent) {
  // Foizni 100 ga ko'paytirib butun songa aylantiramiz:
  // 2.5% → 250 "bazis punkt". Shunda Float bo'linish bo'lmaydi.
  const bp = Math.round(Number(percent) * 100);        // 2.5 → 250
  return Math.floor((amountTiyin * bp) / 10000);       // 10000 = 100% bp
}

/**
 * Paynet: shlyuz pulni o'zi bo'ladi.
 *
 * 100% mijozdan → 90% restoranga to'g'ridan-to'g'ri,
 * 10% LokmaGo balansiga. Paynet o'z haqini (2.5%) LokmaGo
 * ulushidan oladi — restoran ulushi tegilmaydi.
 *
 * @param totalTiyin  mijoz to'lagan summa (tiyin)
 * @param lokmaPercent  LokmaGo ulushi %, shartnomadan yoki standart
 * @returns barcha summalar tiyinda
 */
export function splitPaynet(totalTiyin, lokmaPercent = config.split.defaultLokmaPercent) {
  const total = Math.round(Number(totalTiyin) || 0);
  if (total <= 0) throw new Error('Summa musbat bo\u2018lishi kerak');

  const lokmaGross = percentOf(total, lokmaPercent);
  // Ayirma — tiyin yo'qolmasligi uchun
  const restaurantAmount = total - lokmaGross;

  /*
   * Paynet haqi LokmaGo ULUSHIDAN olinadi (umumiy summadan emas):
   *   100 000 → brutto 10 000 → haq 250 (10 000 ning 2.5%) → netto 9 750
   * Restoran ulushi hech qanday holatda tegilmaydi.
   */
  const feeBase = config.split.paynetFeeBase === 'TOTAL' ? total : lokmaGross;
  const providerFee = percentOf(feeBase, config.split.paynetFeePercent);
  const lokmaNet = lokmaGross - providerFee;

  return {
    provider: 'paynet',
    total,
    restaurantAmount,       // shlyuz to'g'ridan-to'g'ri yuboradi
    lokmaGrossCommission: lokmaGross,
    providerFee,
    lokmaNetCommission: lokmaNet,
    // Shlyuz o'zi yuboradi — bank o'tkazmasi kerak emas
    payoutAmount: 0,
    requiresBankPayout: false,
  };
}

/**
 * Click: split qo'llab-quvvatlamaydi.
 *
 * Butun summa LokmaGo hisobiga tushadi (Click 1.5% ni umumiy
 * summadan ushlab qoladi). Restoran ulushi keyinchalik bank
 * orqali o'tkaziladi — shuning uchun requiresBankPayout = true.
 */
export function splitClick(totalTiyin, lokmaPercent = config.split.defaultLokmaPercent) {
  const total = Math.round(Number(totalTiyin) || 0);
  if (total <= 0) throw new Error('Summa musbat bo\u2018lishi kerak');

  const lokmaGross = percentOf(total, lokmaPercent);
  const restaurantAmount = total - lokmaGross;

  // Click haqi UMUMIY summadan olinadi (Paynetdan farqi shu)
  const feeBase = config.split.clickFeeBase === 'LOKMA_SHARE' ? lokmaGross : total;
  const providerFee = percentOf(feeBase, config.split.clickFeePercent);
  const lokmaNet = lokmaGross - providerFee;

  return {
    provider: 'click',
    total,
    restaurantAmount,       // LokmaGo qarzdor — bank orqali yuboriladi
    lokmaGrossCommission: lokmaGross,
    providerFee,
    lokmaNetCommission: lokmaNet,
    // LokmaGo qarzdor — shu summa bank orqali yuboriladi
    payoutAmount: restaurantAmount,
    requiresBankPayout: true,
  };
}

/** Provayder nomiga qarab tanlaydi. */
export function computeSplit(provider, totalTiyin, lokmaPercent) {
  if (provider === 'paynet') return splitPaynet(totalTiyin, lokmaPercent);
  if (provider === 'click') return splitClick(totalTiyin, lokmaPercent);
  // Payme eskirgan — Paynet bilan bir xil bo'linish mantiqi
  if (provider === 'payme') {
    return { ...splitPaynet(totalTiyin, lokmaPercent), provider: 'payme' };
  }
  throw new Error(`Noma'lum provayder: ${provider}`);
}

export const somToTiyin = (som) => Math.round(Number(som) * 100);
export const tiyinToSom = (tiyin) => Math.round(Number(tiyin)) / 100;
