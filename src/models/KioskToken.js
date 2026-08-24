import { Schema, model } from 'mongoose';
import crypto from 'node:crypto';

/**
 * Kiosk token — zaldagi planshet/kompyuter uchun.
 *
 * NEGA ALOHIDA MODEL (ofitsiant loginidan farqi):
 *   Ofitsiant (Waiter) — SHAXS: login/parol, o'z stollari,
 *   o'z daromadi (xizmat haqi unga tushadi).
 *   Kiosk — QURILMA: shaxsga bog'lanmagan, restoran nomidan
 *   ishlaydi, buyurtmada waiterId bo'lmaydi. Shuning uchun
 *   Waiter modeliga qo'shib yuborilmadi.
 *
 * XAVFSIZLIK QARORI:
 *   Token o'zi kredensial (URL'da ko'rinadi), shuning uchun
 *   u BUTUN panelga emas, FAQAT `sections` ro'yxatidagi
 *   bo'limlarga ruxsat beradi. Token o'g'irlansa ham daromad,
 *   to'lovlar, sozlamalar ochilmaydi.
 */

const deviceSchema = new Schema(
  {
    deviceId: { type: String, required: true },
    label: { type: String, default: '' },      // "Android · Chrome"
    firstSeenAt: { type: Date, default: Date.now },
    lastSeenAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const kioskTokenSchema = new Schema(
  {
    restaurantId: {
      type: Schema.Types.ObjectId, ref: 'Restaurant',
      required: true, index: true,
    },

    // Planshetni ajratish uchun nom — "Zal 1", "Ikkinchi qavat"
    label: { type: String, default: '', trim: true, maxlength: 60 },

    // 64 belgili hex — taxmin qilib bo'lmaydi
    token: { type: String, required: true, unique: true, index: true },

    // PIN bcrypt bilan saqlanadi — ochiq matnda HECH QAYERDA yo'q.
    // Admin PINni qayta ko'ra olmaydi, faqat yangisini qo'ya oladi.
    pinHash: { type: String, required: true },

    expiresAt: { type: Date, required: true, index: true },
    isActive: { type: Boolean, default: true, index: true },

    // 0 = cheksiz qurilma, 1 = faqat bitta planshet
    deviceLimit: { type: Number, default: 0, min: 0, max: 20 },
    devices: { type: [deviceSchema], default: [] },

    // Kioskda ko'rinadigan bo'limlar. Ofitsiant, Daromad, Xizmat
    // haqi kabi admin qismlari BU RO'YXATGA KIRMAYDI.
    sections: {
      type: [{ type: String, enum: ['tables', 'stoplist', 'menu'] }],
      default: ['tables', 'stoplist', 'menu'],
    },

    autoFullscreen: { type: Boolean, default: true },

    /*
     * Necha soniya tegilmasa qulf tushadi.
     *
     * TZ bo'yicha 120 (2 daqiqa). HOZIR TEST UCHUN 15 —
     * qulfni tekshirish uchun har safar 2 daqiqa kutmaslik kerak.
     * QAYTARISH: shu qatordagi 15 → 120 va kiosk.js dagi
     * `?? 15` → `?? 120`. Boshqa joyda o'zgartirish shart emas.
     */
    inactivitySec: { type: Number, default: 15, min: 5, max: 3600 },

    // ===== PIN brute-force himoyasi =====
    // Server tomonda hisoblanadi — brauzerdagi hisobni
    // o'zgartirib aylanib o'tib bo'lmaydi.
    pinFails: { type: Number, default: 0 },
    pinBlockedUntil: { type: Date, default: null },

    lastUsedAt: { type: Date, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

kioskTokenSchema.index({ restaurantId: 1, isActive: 1 });

/** Xavfsiz tasodifiy token. */
kioskTokenSchema.statics.generateToken = function generateToken() {
  return crypto.randomBytes(32).toString('hex');   // 64 belgi
};

/**
 * Token hozir ishlaydimi.
 * Sabab qaytariladi — foydalanuvchiga aniq xabar berish uchun.
 */
kioskTokenSchema.methods.usableReason = function usableReason() {
  if (!this.isActive) return 'disabled';
  if (this.expiresAt && this.expiresAt.getTime() < Date.now()) return 'expired';
  return null;
};

export const KioskToken = model('KioskToken', kioskTokenSchema);
