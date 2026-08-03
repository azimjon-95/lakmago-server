import { Schema, model } from 'mongoose';

/**
 * Menyu ko'chirish so'rovi.
 *
 * Restoran o'z taomlarini boshqa filialga yuboradi.
 * Qabul qiluvchi tasdiqlagach taomlar nusxalanadi.
 */
const menuTransferSchema = new Schema(
  {
    fromRestaurantId: {
      type: Schema.Types.ObjectId, ref: 'Restaurant',
      required: true, index: true,
    },
    fromRestaurantName: { type: String, default: '' },

    toRestaurantId: {
      type: Schema.Types.ObjectId, ref: 'Restaurant',
      required: true, index: true,
    },
    toRestaurantName: { type: String, default: '' },

    // Ko'chiriladigan taomlar ID lari
    dishIds: [{ type: Schema.Types.ObjectId, ref: 'Dish' }],

    // Butun menyumi yoki tanlangan taomlar
    mode: { type: String, enum: ['all', 'selected'], default: 'selected' },

    status: {
      type: String,
      enum: ['pending', 'processing', 'approved', 'rejected', 'failed'],
      default: 'pending',
      index: true,
    },

    // Natija — tasdiqlangandan keyin to'ldiriladi
    result: {
      created: { type: Number, default: 0 },   // yangi qo'shildi
      skipped: { type: Number, default: 0 },   // allaqachon bor edi
      failed: { type: Number, default: 0 },
      error: { type: String, default: '' },
    },

    rejectReason: { type: String, default: '' },
    processedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

menuTransferSchema.index({ toRestaurantId: 1, status: 1, createdAt: -1 });
menuTransferSchema.index({ fromRestaurantId: 1, createdAt: -1 });

export const MenuTransfer = model('MenuTransfer', menuTransferSchema);
