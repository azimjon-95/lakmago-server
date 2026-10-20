import { Schema, model } from 'mongoose';

/*
 * TELEGRAM ORQALI KIRISH SO'ROVI (bot havolasi) — services/tgLinkLogin.js.
 *
 * Telegram Login Widget native ilova (Capacitor WebView) da ishonchsiz: popup/oauth.telegram.org yopilib qoladi.
 * Shuning uchun ilova BIR MARTALIK so'rov yaratadi, Telegram'ni bot havolasi bilan ochadi, mijoz botda tasdiqlaydi
 * (ixtiyoriy: telefon raqamini ulashadi), ilova esa so'rovni so'rab turib avtomatik kiradi.
 *
 *   code        — OCHIQ (bot havolasida: /start login_<code>); o'zi hech narsa bermaydi
 *   pollHash    — YASHIRIN poll kalitining sha256 i; kalit faqat so'rovni yaratgan ilovada. Tokenlar FAQAT shu kalit
 *                 egasiga beriladi (havolani ko'rgan odam sessiyani o'g'irlay olmaydi)
 *   tgUser      — havolani ochgan Telegram foydalanuvchisi (bot yozadi); tasdiqlashgacha pending
 *   status      — pending → confirmed → consumed (tokenlar BIR MARTA beriladi) | cancelled
 */
const schema = new Schema(
  {
    code: { type: String, required: true, unique: true },
    pollHash: { type: String, required: true },
    platform: { type: String, enum: ['web', 'android', 'ios'], default: 'web' },
    deviceId: { type: String, default: '' },
    lang: { type: String, enum: ['uz', 'uzc', 'ru'], default: 'uz' },
    startParam: { type: String, default: '' },        // 'ref_<id>' — referal (faqat yangi foydalanuvchiga ta'sir qiladi)
    ip: { type: String, default: '' },
    userAgent: { type: String, default: '' },

    status: { type: String, enum: ['pending', 'confirmed', 'cancelled', 'consumed'], default: 'pending' },
    tgUser: {
      id: { type: String },
      first_name: String,
      last_name: String,
      username: String,
      language_code: String,
      is_premium: Boolean,
    },
    phone: { type: String, default: '' },             // Telegram kontakti orqali TASDIQLANGAN raqam (+998...)

    expiresAt: { type: Date, required: true },
    confirmedAt: { type: Date, default: null },
    consumedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

schema.index({ 'tgUser.id': 1, status: 1, createdAt: -1 });
schema.index({ createdAt: 1 }, { expireAfterSeconds: 3600 }); // 1 soatdan keyin o'zi o'chadi

export const TgLoginRequest = model('TgLoginRequest', schema);
