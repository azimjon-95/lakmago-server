import { Schema, model } from 'mongoose';

/**
 * Reklama kampaniyasi — restoran yoki taomni ilova ichida
 * ko'rsatish.
 *
 * Kunlik budjet tugaganda ko'rsatish to'xtaydi.
 */
const adCampaignSchema = new Schema(
  {
    restaurantId: {
      type: Schema.Types.ObjectId, ref: 'Restaurant',
      required: true, index: true,
    },

    name: { type: String, required: true, maxlength: 100 },

    // Nima reklama qilinadi
    targetType: { type: String, enum: ['restaurant', 'dish'], default: 'restaurant' },
    dishId: { type: Schema.Types.ObjectId, ref: 'Dish', default: null },

    // Qayerda ko'rsatiladi
    placements: [{
      type: String,
      enum: ['home', 'category', 'search'],
    }],

    dailyBudget: { type: Number, required: true, min: 1000 },
    startsAt: { type: Date, required: true },
    endsAt: { type: Date, required: true },

    isActive: { type: Boolean, default: true, index: true },

    // Ko'rsatkichlar
    stats: {
      impressions: { type: Number, default: 0 },  // ko'rishlar
      clicks: { type: Number, default: 0 },
      orders: { type: Number, default: 0 },
      revenue: { type: Number, default: 0 },      // reklama orqali tushum
      spent: { type: Number, default: 0 },        // sarflangan
    },

    // Bugungi sarf — har kuni nolga tushadi
    todaySpent: { type: Number, default: 0 },
    todayDate: { type: String, default: '' },     // YYYY-MM-DD
  },
  { timestamps: true },
);

adCampaignSchema.index({ isActive: 1, startsAt: 1, endsAt: 1 });

/** Reklama hozir ko'rsatiladimi. */
adCampaignSchema.methods.isRunning = function (now = new Date()) {
  if (!this.isActive) return false;
  if (this.startsAt > now || this.endsAt < now) return false;

  // Bugungi budjet tugaganmi
  const today = now.toISOString().slice(0, 10);
  if (this.todayDate === today && this.todaySpent >= this.dailyBudget) return false;

  return true;
};

export const AdCampaign = model('AdCampaign', adCampaignSchema);
