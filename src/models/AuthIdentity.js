import { Schema, model } from 'mongoose';

/**
 * AuthIdentity — bitta User qaysi auth-provayder(lar) orqali
 * kira olishini bog'laydi. Provayderga xos ID (masalan Telegram
 * user ID) SHU YERDA saqlanadi — User modelida EMAS, chunki:
 *
 *   1 mijoz = 1 LokmaGo User account.
 *
 * Bitta User bir nechta AuthIdentity'ga ega bo'lishi mumkin
 * (masalan kelajakda: telegram + phone), lekin har bir
 * AuthIdentity FAQAT bitta User'ga tegishli.
 *
 * MUHIM (orqaga moslik): User.telegramId maydoni HOZIRCHA
 * saqlanmoqda — ko'plab eski controller/service shu maydonga
 * to'g'ridan-to'g'ri bog'liq (referral, bot xabarlari, kuryer
 * dispetcherligi va h.k., 10+ fayl). Uni olib tashlash alohida,
 * ehtiyotkorlik bilan qilinadigan keyingi bosqich — bu yerda
 * AuthIdentity YANGI QATLAM sifatida QO'SHILADI, User.telegramId
 * bilan PARALLEL ishlaydi (auth.js -> loginOrCreateTelegramUser
 * ikkalasini ham sinxron yangilaydi).
 */
const authIdentitySchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    provider: {
      type: String,
      required: true,
      enum: ['telegram', 'phone', 'google', 'apple'],
    },

    // Provayderdagi noyob identifikator (masalan Telegram user ID)
    providerUserId: { type: String, required: true },
  },
  { timestamps: true },
);

// Bitta provayderdagi bitta identifikator faqat BITTA User'ga tegishli bo'lishi mumkin
authIdentitySchema.index({ provider: 1, providerUserId: 1 }, { unique: true });
// Bitta User bitta provayderdan faqat BITTA marta ro'yxatdan o'tishi mumkin
authIdentitySchema.index({ userId: 1, provider: 1 }, { unique: true });

export const AuthIdentity = model('AuthIdentity', authIdentitySchema);
