import { PaymentProvider } from './base.js';
import { config } from '../../config/index.js';
import { clickPrepare, clickComplete, buildClickCheckoutUrl } from '../click.js';

/**
 * Click.
 *
 * Split QO'LLAMAYDI: butun summa LokmaGo hisobiga tushadi,
 * Click 1.5% ni umumiy summadan ushlab qoladi. Restoran ulushi
 * keyinchalik bank orqali o'tkaziladi (payout.js).
 *
 * Mavjud click.js mantig'i o'zgartirilmagan — faqat o'ralgan.
 */
export class ClickProvider extends PaymentProvider {
  constructor() { super('click'); }

  isConfigured() {
    return Boolean(config.click.enabled && config.click.serviceId && config.click.secretKey);
  }

  supportsSplit() { return false; }

  async createCheckout(order) {
    return { url: buildClickCheckoutUrl(order._id, order.total) };
  }

  /**
   * Click ikki bosqichli: prepare → complete.
   * Marshrut qaysi bosqich ekanini `stage` bilan uzatadi.
   */
  async handleWebhook(req, stage) {
    if (stage === 'prepare') return clickPrepare(req.body);
    return clickComplete(req.body);
  }
}
