/**
 * Bank o'tkazma provayderi interfeysi.
 *
 * Click split qilmagani uchun restoran ulushini LokmaGo o'zi
 * o'tkazishi kerak. Bank API hali berilmagan, shuning uchun
 * interfeys ajratildi: bank ulanganda faqat yangi sinf yoziladi,
 * payout mantig'i o'zgarmaydi.
 */
export class BankPayoutProvider {
  constructor(name) { this.name = name; }

  isConfigured() { return false; }

  /**
   * O'tkazma yuborish.
   *
   * MUHIM: idempotencyKey majburiy. Tarmoq uzilib javob
   * kelmasa, xuddi shu kalit bilan qayta yuborish xavfsiz
   * bo'lishi kerak — pul ikki marta ketmasin.
   *
   * @returns {Promise<{status:'SENT'|'CONFIRMED'|'FAILED', reference?:string, error?:string}>}
   */
  // eslint-disable-next-line no-unused-vars
  async send({ idempotencyKey, amount, account, description }) {
    throw new Error(`${this.name}: send bajarilmagan`);
  }

  /** Yuborilgan o'tkazma holatini so'rash. */
  // eslint-disable-next-line no-unused-vars
  async checkStatus(reference) {
    throw new Error(`${this.name}: checkStatus bajarilmagan`);
  }
}
