import { Schema, model } from 'mongoose';

/**
 * Bonus qoidasi — buyurtma uchun mijozga bonus beriladi.
 *
 * Bonus mijoz balansiga tushadi va keyingi buyurtmada
 * ishlatiladi (User.bonusBalance).
 */
const bonusRuleSchema = new Schema(
  {
    restaurantId: {
      type: Schema.Types.ObjectId, ref: 'Restaurant',
      required: true, index: true,
    },

    name: { type: String, default: 'Bonus', maxlength: 100 },

    // Bonus miqdori: foiz yoki qat'iy summa
    bonusType: { type: String, enum: ['percent', 'fixed'], default: 'fixed' },
    bonusValue: { type: Number, required: true, min: 0 },

    // Shu summadan boshlab beriladi
    minOrderAmount: { type: Number, default: 0 },
    // Bitta buyurtmada eng ko'p bonus (0 = cheklovsiz)
    maxBonusAmount: { type: Number, default: 0 },

    // Bonus necha kun amal qiladi (0 = muddatsiz)
    validDays: { type: Number, default: 0 },

    isActive: { type: Boolean, default: true, index: true },

    stats: {
      orders: { type: Number, default: 0 },
      totalGiven: { type: Number, default: 0 },
    },
  },
  { timestamps: true },
);

bonusRuleSchema.index({ restaurantId: 1, isActive: 1 });

export const BonusRule = model('BonusRule', bonusRuleSchema);
