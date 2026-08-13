/**
 * To'lov provayderi interfeysi.
 *
 * Har bir shlyuz (Click, Paynet, eskirgan Payme) shu shaklga
 * keltiriladi. Kontroller endi qaysi shlyuz ekanini bilmaydi —
 * yangi provayder qo'shish uchun faqat shu interfeysni bajaruvchi
 * fayl yoziladi va registrga qo'shiladi.
 *
 * MUHIM: provayderlarning ICHKI mantig'i o'zgartirilmaydi —
 * mavjud, ishlab turgan Payme/Click kodi shunchaki o'raladi.
 */
export class PaymentProvider {
  /** @param {string} name  'click' | 'paynet' | 'payme' */
  constructor(name) {
    this.name = name;
  }

  /** Sozlamalar to'liqmi — bo'lmasa provayder ro'yxatga kirmaydi. */
  isConfigured() {
    return false;
  }

  /** Shlyuz pulni o'zi bo'la oladimi (restoranga to'g'ridan-to'g'ri). */
  supportsSplit() {
    return false;
  }

  /**
   * Mijozga to'lov havolasi.
   * @param {object} order  buyurtma hujjati
   * @returns {Promise<{url: string}>}
   */
  // eslint-disable-next-line no-unused-vars
  async createCheckout(order) {
    throw new Error(`${this.name}: createCheckout bajarilmagan`);
  }

  /**
   * Shlyuzdan kelgan webhookni qayta ishlash.
   *
   * MUHIM: imzo/autentifikatsiya shu yerda tekshiriladi.
   * Mijozdan kelgan "to'ladim" ga hech qachon ishonilmaydi.
   *
   * @param {object} req  express so'rovi
   * @returns {Promise<object>}  shlyuz kutgan javob
   */
  // eslint-disable-next-line no-unused-vars
  async handleWebhook(req) {
    throw new Error(`${this.name}: handleWebhook bajarilmagan`);
  }

  /** Pulni qaytarish. Qo'llamasa xato beradi. */
  // eslint-disable-next-line no-unused-vars
  async refund(payment, reason) {
    throw new Error(`${this.name}: qaytarish qo\u2018llanmaydi`);
  }
}
