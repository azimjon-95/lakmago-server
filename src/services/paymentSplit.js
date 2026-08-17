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
 * Paynet: HOZIRCHA (2026-08-17) shlyuz o'zi bo'lmaydi.
 *
 * Biznes qarori: split funksiyasi hali yoqilmagan — Paynet ham,
 * Click ham to'liq summani (o'z haqini ushlab qolgandan keyin)
 * LokmaGo hisobiga o'tkazadi. Restoran ulushi har kuni QO'LDA
 * (bank orqali) yuboriladi — Moliya bo'limidagi kunlik hisobot
 * shu asosda tuziladi.
 *
 * Shuning uchun requiresBankPayout: true — Click bilan bir xil.
 * Kelajakda Paynet split yoqilsa, shu yerda o'zgartiriladi
 * (payoutAmount: 0, requiresBankPayout: false) — qolgan butun
 * hisoblash mantig'i (foizlar, netto) o'zgarishsiz qoladi.
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
   * Paynet haqi UMUMIY summadan (Click bilan bir xil qoida,
   * 2026-08-17 tasdiqlangan):
   *   100 000 → haq 1% = 1 000 → LokmaGo hisobiga 99 000 tushadi
   * Restoran ulushi (kelishuv bo'yicha, masalan 90 000) bunga
   * qaramay TO'LIQ to'lanadi — shlyuz haqi faqat LokmaGo NETTO
   * daromadini kamaytiradi.
   */
  const feeBase = config.split.paynetFeeBase === 'LOKMA_SHARE' ? lokmaGross : total;
  const providerFee = percentOf(feeBase, config.split.paynetFeePercent);
  const lokmaNet = lokmaGross - providerFee;

  return {
    provider: 'paynet',
    total,
    restaurantAmount,       // restoranga QARZ — kelishuv bo'yicha to'liq
    lokmaGrossCommission: lokmaGross,
    providerFee,
    lokmaNetCommission: lokmaNet,
    // HOZIRCHA qo'lda (bank orqali) yuboriladi — Click bilan bir xil
    payoutAmount: restaurantAmount,
    requiresBankPayout: true,
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
