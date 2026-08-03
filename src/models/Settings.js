import { Schema, model } from 'mongoose';

// Platforma global sozlamalari (bitta hujjat — singleton).
const settingsSchema = new Schema(
  {
    key: { type: String, default: 'global', unique: true },

    // Komissiya foizi (masalan 5 = 5%)
    commissionPercent: { type: Number, default: 0 },

    // ===== REFERRAL TIZIMI =====
    // O'chirilsa: profilda karta ko'rinmaydi, bot havolasi
    // ishlamaydi, bonus berilmaydi.
    referralEnabled: { type: Boolean, default: true },

    // ===== MIJOZLARNI JALB QILISH XIZMATI =====
    // Kunlik narx. Aksiya + reklama birga ishlatilsa ham
    // BITTA narx olinadi.
    promoDailyPrice: { type: Number, default: 15000 },

    // Qarzni delivery tushumidan avtomatik ushlab qolish
    promoDeductFromSettlement: { type: Boolean, default: false },

    // Bir buyurtmada aksiya va bonus birga ishlatilsinmi.
    // false — faqat eng foydalisi qo'llanadi.
    allowDiscountStacking: { type: Boolean, default: false },

    // Komissiya rejimi:
    //   markup     → mijoz narx ustiga +5% to'laydi (platforma foydasi ustidan)
    //   deduct     → restoran narxidan −5% olamiz (restoran foydasidan)
    //   none       → komissiya yo'q (hozircha 0)
    commissionMode: { type: String, enum: ['markup', 'deduct', 'none'], default: 'none' },
  },
  { timestamps: true },
);

export const Settings = model('Settings', settingsSchema);

// Sozlamalarni olish (bo'lmasa yaratadi) — singleton pattern
export async function getSettings() {
  let s = await Settings.findOne({ key: 'global' });
  if (!s) s = await Settings.create({ key: 'global' });
  return s;
}
