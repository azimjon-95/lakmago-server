import { Schema, model } from 'mongoose';

/*
 * ═══════════════════════════════════════════════════════════
 * TELEGRAM'GA YUKLANGAN FAYL (file_id KESHI)
 * ═══════════════════════════════════════════════════════════
 *
 * Signal ovozi har safar qayta yuklansa, har buyurtmada
 * ortiqcha trafik va kechikish bo'ladi. Telegram bir marta
 * yuklangan faylga `file_id` beradi — keyingi yuborishlarda
 * faqat shu satrni jo'natish yetarli (bir necha barobar tez).
 *
 * `hash` — fayl mazmunining SHA-1 i. Siz sounds/order.mp3 ni
 * ALMASHTIRSANGIZ hash o'zgaradi va kesh o'zi bekor bo'ladi:
 * yangi ovoz avtomatik yuklanadi, qo'lda hech narsa qilish
 * kerak emas.
 */
const botAssetSchema = new Schema(
  {
    key: { type: String, required: true, unique: true },   // 'signal:order' | 'signal:reservation'
    fileId: { type: String, required: true },
    hash: { type: String, required: true },
    updatedAt: { type: Date, default: Date.now },
  },
  { versionKey: false },
);

export const BotAsset = model('BotAsset', botAssetSchema);
