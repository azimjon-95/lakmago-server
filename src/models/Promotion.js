import { Schema, model } from 'mongoose';

/**
 * Aksiya — restoran taomlariga chegirma.
 *
 * Chegirma checkout paytida SERVERDA hisoblanadi.
 * Frontend yuborgan qiymatga ishonilmaydi.
 */
const promotionSchema = new Schema(
  {
    restaurantId: {
      type: Schema.Types.ObjectId, ref: 'Restaurant',
      required: true, index: true,
    },

    name: { type: String, required: true, trim: true, maxlength: 100 },

    // Chegirma turi va miqdori
    discountType: { type: String, enum: ['percent', 'fixed'], required: true },
    discountValue: { type: Number, required: true, min: 0 },

    // Nimaga qo'llaniladi
    scope: {
      type: String,
      enum: ['all', 'category', 'dishes'],
      default: 'all',
    },
    categories: [{ type: String }],
    dishIds: [{ type: Schema.Types.ObjectId, ref: 'Dish' }],

    // Shartlar
    minOrderAmount: { type: Number, default: 0 },
    // Foizli chegirmada eng ko'p summa (0 = cheklovsiz)
    maxDiscountAmount: { type: Number, default: 0 },

    startsAt: { type: Date, required: true },
    endsAt: { type: Date, required: true },

    // Foydalanish chegarasi (0 = cheksiz)
    maxUses: { type: Number, default: 0 },
    usedCount: { type: Number, default: 0 },

    isActive: { type: Boolean, default: true, index: true },

    // Statistika
    stats: {
      orders: { type: Number, default: 0 },
      totalDiscount: { type: Number, default: 0 },
      totalRevenue: { type: Number, default: 0 },
    },
  },
  { timestamps: true },
);

// Faol aksiyalarni tez topish uchun
promotionSchema.index({ restaurantId: 1, isActive: 1, startsAt: 1, endsAt: 1 });

/** Aksiya hozir amal qiladimi. */
promotionSchema.methods.isRunning = function (now = new Date()) {
  if (!this.isActive) return false;
  if (this.startsAt > now || this.endsAt < now) return false;
  if (this.maxUses > 0 && this.usedCount >= this.maxUses) return false;
  return true;
};

export const Promotion = model('Promotion', promotionSchema);
