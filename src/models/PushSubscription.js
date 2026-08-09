import { Schema, model } from 'mongoose';

/**
 * Qurilma obunasi (Web Push).
 *
 * Har brauzer/qurilma alohida yozuv. Bir restoranga bir necha
 * admin ulanishi mumkin — har biriga alohida push boradi.
 *
 * endpoint takrorlanmas: brauzer bir xil qurilma uchun bir xil
 * endpoint beradi, shuning uchun qayta obuna bo'lganda yangi
 * yozuv emas, borini yangilaymiz.
 */
const pushSubscriptionSchema = new Schema(
  {
    endpoint: { type: String, required: true, unique: true, index: true },
    keys: {
      p256dh: { type: String, required: true },
      auth: { type: String, required: true },
    },

    // Kimga tegishli — bildirishnoma faqat shu doiraga boradi
    userId: { type: Schema.Types.ObjectId, ref: 'User', index: true },
    role: { type: String, enum: ['admin', 'restaurant'], required: true },
    restaurantId: { type: Schema.Types.ObjectId, ref: 'Restaurant', index: true },
    branchId: { type: Schema.Types.ObjectId, ref: 'Restaurant', index: true },

    // Qurilmani ajratish uchun (chiqishda o'chiriladi)
    deviceId: { type: String, default: '', index: true },
    userAgent: { type: String, default: '' },

    // Yaroqsiz obunani darhol o'chirmaymiz — vaqtincha xato
    // bo'lishi mumkin. Uch marta ketma-ket xato bo'lsa o'chadi.
    failCount: { type: Number, default: 0 },
    lastSeen: { type: Date, default: Date.now, index: true },
  },
  { timestamps: true },
);

// "Shu restoranning barcha qurilmalari" — asosiy so'rov
pushSubscriptionSchema.index({ role: 1, restaurantId: 1 });

// 60 kun ishlatilmagan obuna o'zi o'chadi
pushSubscriptionSchema.index({ lastSeen: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 60 });

export const PushSubscription = model('PushSubscription', pushSubscriptionSchema);
