import { Schema, model } from 'mongoose';
import { encryptSecret, decryptSecret, maskTail } from '../lib/secrets.js';

/**
 * Restoranning to'lov rekvizitlari.
 *
 * Alohida to'plamda saqlanadi (Restaurant ichida emas): bu
 * ma'lumot maxfiy va Restaurant hujjati mijoz ilovasiga ham
 * yuboriladi — tasodifan sizib chiqmasligi kerak.
 *
 * Maxfiy qiymatlar shifrlangan holda yoziladi.
 */
const accountSchema = new Schema(
  {
    restaurantId: { type: Schema.Types.ObjectId, ref: 'Restaurant', required: true, index: true },

    provider: { type: String, enum: ['paynet', 'click'], required: true },

    /**
     * Shlyuzdagi merchant/hisob identifikatori.
     *
     * Paynet: split shu ID ga yo'naltiriladi — u bo'lmasa
     * restoran ulushini kimga yuborishni bilib bo'lmaydi.
     */
    merchantId: { type: String, default: '' },
    accountId: { type: String, default: '' },

    // Shifrlangan (ochiq matnda saqlanmaydi)
    secretKeyEnc: { type: String, default: '' },

    // ── Bank rekvizitlari: Click ulushini o'tkazish uchun ──
    bank: {
      accountNumber: { type: String, default: '' },   // hisob raqami
      mfo: { type: String, default: '' },
      inn: { type: String, default: '' },             // STIR
      beneficiaryName: { type: String, default: '' },
      bankName: { type: String, default: '' },
    },

    isActive: { type: Boolean, default: true, index: true },
    verifiedAt: { type: Date, default: null },
    note: { type: String, default: '' },
  },
  { timestamps: true },
);

// Bir restoranda bir provayder uchun bitta hisob
accountSchema.index({ restaurantId: 1, provider: 1 }, { unique: true });

/** Maxfiy kalitni yozish (shifrlaydi). */
accountSchema.methods.setSecret = function setSecret(plain) {
  this.secretKeyEnc = encryptSecret(plain);
};

/** Maxfiy kalitni o'qish (faqat server ichida). */
accountSchema.methods.getSecret = function getSecret() {
  return this.secretKeyEnc ? decryptSecret(this.secretKeyEnc) : '';
};

/** Panelga yuborish uchun xavfsiz ko'rinish — sirlar chiqmaydi. */
accountSchema.methods.toSafeJSON = function toSafeJSON() {
  return {
    _id: this._id,
    restaurantId: this.restaurantId,
    provider: this.provider,
    merchantId: this.merchantId,
    accountId: this.accountId,
    hasSecret: Boolean(this.secretKeyEnc),
    bank: {
      accountNumber: maskTail(this.bank?.accountNumber),
      mfo: this.bank?.mfo || '',
      inn: this.bank?.inn || '',
      beneficiaryName: this.bank?.beneficiaryName || '',
      bankName: this.bank?.bankName || '',
    },
    isActive: this.isActive,
    verifiedAt: this.verifiedAt,
  };
};

export const RestaurantPaymentAccount = model('RestaurantPaymentAccount', accountSchema);
