import { Schema, model } from 'mongoose';

/**
 * Session — bitta qurilma/platformadagi login holati.
 *
 * Refresh token XOM HOLDA hech qachon saqlanmaydi — faqat SHA-256
 * hash'i (refreshTokenHash). Xom token FAQAT bir marta, javobda
 * clientga qaytariladi va boshqa hech qayerda (log, DB) yozilmaydi.
 *
 * ROTATSIYA: har safar /auth/refresh chaqirilganda ESKI Session
 * revokedAt bilan bekor qilinadi va YANGI Session yaratiladi (yangi
 * refreshTokenHash bilan). Shu tufayli o'g'irlangan eski refresh
 * token qayta ishlatilsa — session allaqachon revoked, rad etiladi.
 */
const sessionSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    refreshTokenHash: { type: String, required: true, unique: true, index: true },

    // Qaysi qurilma — clientdan keladi (masalan Telegram WebApp
    // instance identifikatori yoki generatsiya qilingan UUID)
    deviceId: { type: String, default: '' },

    platform: {
      type: String,
      required: true,
      enum: ['telegram', 'web', 'android', 'ios'],
    },

    expiresAt: { type: Date, required: true },

    // Bekor qilingan bo'lsa vaqti — logout yoki rotatsiya paytida
    revokedAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

// Eskirgan (muddati o'tgan) sessiyalarni MongoDB o'zi avtomatik
// o'chiradi — qo'lda tozalash kerak emas
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const Session = model('Session', sessionSchema);
