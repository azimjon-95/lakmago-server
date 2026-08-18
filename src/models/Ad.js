import { Schema, model } from 'mongoose';

/**
 * Reklama — restoran yoki taomni bosh sahifa banner karuselida
 * ko'rsatish.
 *
 * ESKI AdCampaign (budjet/klik hisoblovchi, murakkab) o'rniga —
 * SODDA model: restoran necha kun ko'rsatishni tanlaydi, kunlik
 * narx BIR XIL (pricePerDay), umumiy narx hisoblanadi. Har bir
 * so'rov ADMIN TASDIQLASHIDAN o'tadi — avtomatik ishga
 * tushmaydi.
 *
 * Ikki tur, ortiq emas:
 *   restaurant — butun restoranni reklama qiladi
 *   dish       — bitta aniq taomni reklama qiladi
 */
const adSchema = new Schema(
  {
    restaurantId: {
      type: Schema.Types.ObjectId, ref: 'Restaurant',
      required: true, index: true,
    },

    targetType: { type: String, enum: ['restaurant', 'dish'], required: true },
    // Faqat 'dish' turida VA "mavjud taomdan" tanlansa to'ldiriladi.
    // Bo'sh bo'lishi mumkin — restoran o'zi rasm+matn yozganda
    // (haqiqiy taom yozuviga bog'lanmagan reklama).
    dishId: { type: Schema.Types.ObjectId, ref: 'Dish', default: null },

    /*
     * Moslashtirilgan matn — restoran o'zi yozadi. Ikki holatda
     * ishlatiladi:
     *   1) targetType==='restaurant' — modalda restoran nomi
     *      o'rniga (yoki qo'shimcha) ko'rsatish uchun, ixtiyoriy
     *   2) targetType==='dish' VA dishId=null — restoran mavjud
     *      taomga bog'lamasdan, o'zi xohlagan sarlavha/tavsifni
     *      yozganda (majburiy, chunki boshqa ma'lumot manbai yo'q)
     */
    customTitle: { type: String, default: '', maxlength: 80 },
    customDescription: { type: String, default: '', maxlength: 200 },

    // Banner rasmi — restoran o'zining mavjud rasmidan (restoran
    // yoki taom galereyasidan) tanlaydi, YOKI yangi yuklaydi.
    imageUrl: { type: String, required: true },

    days: { type: Number, required: true, min: 1, max: 90 },
    pricePerDay: { type: Number, required: true },   // tiyin — tasdiqlash payti narxi
    totalPrice: { type: Number, required: true },     // tiyin — days * pricePerDay

    status: {
      type: String,
      enum: [
        'pending',    // restoran yubordi, admin javobini kutmoqda
        'approved',   // admin tasdiqladi — startsAt/endsAt shu payt belgilanadi
        'rejected',   // admin rad etdi
        'active',     // hozir banner'da ko'rinmoqda (approved + vaqt oralig'ida)
        'expired',    // muddati tugadi
        'cancelled',  // restoran o'zi bekor qildi (pending holatda)
      ],
      default: 'pending',
      index: true,
    },

    // FAQAT admin tasdiqlagandan keyin to'ldiriladi
    startsAt: { type: Date, default: null },
    endsAt: { type: Date, default: null },

    reviewedBy: { type: Schema.Types.ObjectId, refPath: 'reviewedByModel', default: null },
    reviewedByModel: { type: String, enum: ['User', 'StaffUser'], default: 'User' },
    reviewedAt: { type: Date, default: null },
    rejectReason: { type: String, default: '', maxlength: 300 },

    // Ko'rsatkichlar — oddiy, budjetga bog'liq emas
    impressions: { type: Number, default: 0 },
    clicks: { type: Number, default: 0 },
  },
  { timestamps: true },
);

adSchema.index({ status: 1, startsAt: 1, endsAt: 1 });

/** Hozir banner'da ko'rsatilishi kerakmi. */
adSchema.methods.isRunning = function (now = new Date()) {
  if (this.status !== 'approved' && this.status !== 'active') return false;
  if (!this.startsAt || !this.endsAt) return false;
  return this.startsAt <= now && this.endsAt >= now;
};

export const Ad = model('Ad', adSchema);
