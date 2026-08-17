import { PaymentProvider } from './base.js';
import { config } from '../../config/index.js';

/**
 * Paynet.
 *
 * ┌──────────────────────────────────────────────────────────┐
 * │  DIQQAT: TRANSPORT QATLAMI HALI YOZILMAGAN               │
 * │                                                          │
 * │  Paynet merchant API rasmiy hujjati mavjud emas edi.      │
 * │  Endpoint, imzo usuli va maydon nomlarini taxmin qilib    │
 * │  yozish xavfli: noto'g'ri imzo bilan to'lov tasdiqlansa   │
 * │  pul yo'qoladi yoki soxta webhook qabul qilinadi.         │
 * │                                                          │
 * │  Hujjat kelgach faqat shu fayldagi TODO joylar            │
 * │  to'ldiriladi — qolgan tizim (model, split, payout,       │
 * │  registr, marshrutlar) tayyor va o'zgarmaydi.             │
 * └──────────────────────────────────────────────────────────┘
 *
 * Biznes modeli (tasdiqlangan, paymentSplit.js da bajarilgan):
 *   100% mijozdan → 90% restoran, 10% LokmaGo
 *   Paynet 2.5% ni LokmaGo ulushidan oladi → LokmaGo netto 7.5%
 *   Restoran ulushi tegilmaydi.
 */
export class PaynetProvider extends PaymentProvider {
  constructor() { super('paynet'); }

  isConfigured() {
    return Boolean(
      config.paynet.enabled
      && config.paynet.merchantId
      && config.paynet.secretKey
      && config.paynet.baseUrl,
    );
  }

  /*
   * HOZIRCHA (2026-08-17 biznes qarori) Paynet split YO'Q —
   * hisob-kitob to'liq LokmaGo hisobiga tushadi, restoran ulushi
   * har kuni QO'LDA (bank orqali) yuboriladi, Moliya bo'limidagi
   * kunlik hisobot orqali. Paynet API o'zi split funksiyasini
   * qo'llab-quvvatlasa ham, biz hali undan foydalanmayapmiz —
   * shuning uchun false.
   *
   * Kelayotgan split integratsiyasi uchun: shu yerni true ga
   * qaytarish YETARLI — paymentRecord.js'dagi payoutStatus
   * mantig'i avtomatik moslashadi (services/paymentRecord.js:
   * `payoutStatus = gateway?.supportsSplit() ? 'NOT_REQUIRED' : 'PENDING'`),
   * boshqa hech narsani o'zgartirish shart emas.
   */
  supportsSplit() { return false; }

  /**
   * Mijozga to'lov havolasi.
   *
   * TODO(paynet-docs): Paynet checkout URL formati yoki
   * "invoice create" chaqiruvi. Kerak bo'ladi:
   *   - endpoint manzili
   *   - so'rov maydonlari (summa birligi: so'm yoki tiyin?)
   *   - imzo algoritmi
   *   - restoran merchant ID qaysi maydonda uzatiladi
   */
  // eslint-disable-next-line no-unused-vars
  async createCheckout(order) {
    throw new Error(
      'Paynet integratsiyasi tugallanmagan: rasmiy API hujjati kerak. '
      + 'Hujjat kelgach services/providers/paynetProvider.js dagi TODO joylar to\u2018ldiriladi.',
    );
  }

  /**
   * Webhook.
   *
   * TODO(paynet-docs): Kerak bo'ladi:
   *   - imzo/autentifikatsiya tekshiruvi (Payme'da MD5+key,
   *     Click'da MD5 zanjir — Paynet'da qanday?)
   *   - so'rov formati (JSON-RPC? REST?)
   *   - holat nomlari va javob sxemasi
   *   - takroriy webhook uchun kutilgan javob
   *
   * Tekshiruv yozilmaguncha bu metod HECH QACHON to'lovni
   * muvaffaqiyatli deb belgilamaydi — soxta so'rov bilan
   * buyurtma oshxonaga tushib ketmasligi uchun.
   */
  // eslint-disable-next-line no-unused-vars
  async handleWebhook(req) {
    throw new Error('Paynet webhook: imzo tekshiruvi hali yozilmagan');
  }

  /** TODO(paynet-docs): qaytarish (refund/reverse) chaqiruvi. */
  // eslint-disable-next-line no-unused-vars
  async refund(payment, reason) {
    throw new Error('Paynet qaytarish: API hujjati kerak');
  }
}
