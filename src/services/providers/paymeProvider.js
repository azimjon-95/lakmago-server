import { PaymentProvider } from './base.js';
import { config } from '../../config/index.js';
import { handlePaymeRequest, buildPaymeCheckoutUrl } from '../payme.js';

/**
 * Payme — ESKIRGAN.
 *
 * Paynet bilan almashtirildi, lekin kod o'chirilmadi:
 *   • eski tranzaksiyalar va qaytarishlar hali ishlashi kerak
 *   • Paynet ulanmagunicha zaxira sifatida qoladi
 *
 * PAYME_ENABLED=false bo'lsa yangi to'lov qabul qilinmaydi,
 * lekin webhook javob berishda davom etadi (Payme tomonidagi
 * tugallanmagan tranzaksiyalar yopilishi uchun).
 */
export class PaymeProvider extends PaymentProvider {
  constructor() { super('payme'); }

  isConfigured() {
    return Boolean(config.payme.merchantId && config.payme.key);
  }

  /** Yangi to'lovlar uchun ochiqmi (eski webhooklar baribir ishlaydi). */
  acceptsNewPayments() {
    return this.isConfigured() && process.env.PAYME_ENABLED !== 'false';
  }

  supportsSplit() { return true; }

  async createCheckout(order) {
    if (!this.acceptsNewPayments()) {
      throw new Error('Payme o\u2018chirilgan — Paynet ishlating');
    }
    return { url: buildPaymeCheckoutUrl(order._id, order.total) };
  }

  async handleWebhook(req) {
    return handlePaymeRequest(req);
  }
}
