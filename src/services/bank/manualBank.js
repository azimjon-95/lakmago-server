import { BankPayoutProvider } from './base.js';

/**
 * Qo'lda o'tkazma — bank API ulanmaguncha ishlaydigan rejim.
 *
 * Hech qanday tashqi chaqiruv qilmaydi: o'tkazmani "yuborishga
 * tayyor" holatida qoldiradi va moliyachi bank-mijoz dasturi
 * orqali qo'lda bajaradi, keyin panelda tasdiqlaydi.
 *
 * Bu vaqtinchalik yechim emas, balki zaxira: bank API uzilganda
 * ham to'lovlar to'planib borishi va yo'qolmasligi kerak.
 */
export class ManualBankProvider extends BankPayoutProvider {
  constructor() { super('manual'); }

  isConfigured() { return true; }

  async send({ idempotencyKey }) {
    // Avtomatik yuborilmaydi — moliyachi tasdiqlashi kutiladi
    return {
      status: 'SENT',
      reference: `MANUAL-${idempotencyKey.slice(0, 24)}`,
      manual: true,
    };
  }

  async checkStatus() {
    // Qo'lda rejimda holatni odam belgilaydi
    return { status: 'SENT' };
  }
}
