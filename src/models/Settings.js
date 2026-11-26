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

    // ===== DINE-IN TARIFI =====
    // Frontendga hardcode qilinmaydi — hammasi shu yerdan
    dineIn: {
      // Obuna narxi va davri
      price: { type: Number, default: 99000 },
      billingPeriod: { type: String, enum: ['daily', 'monthly'], default: 'monthly' },

      // Sinov muddati (kun). 0 = sinovsiz
      trialDays: { type: Number, default: 14 },

      // Ulanish to'lovi — bir marta
      activationFee: { type: Number, default: 0 },

      // Buyurtmadan komissiya (%). 0 = yo'q
      commissionPercent: { type: Number, default: 0 },

      // Qarzni delivery tushumidan ushlab qolish
      deductFromSettlement: { type: Boolean, default: false },
    },

    // Bir buyurtmada aksiya va bonus birga ishlatilsinmi.
    // false — faqat eng foydalisi qo'llanadi.
    allowDiscountStacking: { type: Boolean, default: false },

    // Komissiya rejimi:
    //   markup     → mijoz narx ustiga +5% to'laydi (platforma foydasi ustidan)
    //   deduct     → restoran narxidan −5% olamiz (restoran foydasidan)
    //   none       → komissiya yo'q (hozircha 0)
    commissionMode: { type: String, enum: ['markup', 'deduct', 'none'], default: 'none' },

    /*
     * ===== LOKMAGO KURYERLARI (2026-11) =====
     *   commissionPercent — LokmaGo'ning har bir yetkazishdan foizi (30 000 so'm, 10% → kuryerga 27 000). Restoranga
     *                       alohida foiz Restaurant.lokmaCourierPercent bilan beriladi.
     *   debtLimitSom      — kuryer qo'lidagi naqd (LokmaGo puli) chegarasi: oshsa yangi NAQD buyurtma ololmaydi,
     *                       avval pulni topshiradi. Kuryerga alohida Courier.debtLimitSom beriladi.
     *   maxActiveOrders   — kuryer bir vaqtda nechta buyurtmani olib yura oladi.
     */
    courier: {
      commissionPercent: { type: Number, default: 10, min: 0, max: 100 },
      debtLimitSom: { type: Number, default: 500000, min: 0 },
      maxActiveOrders: { type: Number, default: 1, min: 1, max: 10 },    // mobil ilova hozircha BITTA faol buyurtma ko'rsatadi — oshirish uchun ilovada ro'yxat kerak
    },
    /*
     * Mijoz ilovasi (iOS/Android) versiyalari — controllers/appConfig.js, GET /api/app/config.
     *   *MinVersion — bundan ESKI ilova bloklanadi ("Yangilang", yopib bo'lmaydi). Bo'sh — majburiy emas.
     *   *StoreUrl   — "Yangilash" va "Ilovani yuklab olish" tugmalari shu yerga olib boradi.
     *   updatePromptDays — yangi versiya chiqqanda ixtiyoriy taklif necha kunda bir eslatiladi.
     * Eng so'nggi versiyani ilova do'konning o'zidan oladi (App Store / Google Play) — bu yerda yozilmaydi.
     */
    clientApp: {
      iosMinVersion: { type: String, default: '' },
      androidMinVersion: { type: String, default: '' },
      iosStoreUrl: { type: String, default: '' },
      androidStoreUrl: { type: String, default: 'https://play.google.com/store/apps/details?id=lokma.uz' },
      updatePromptDays: { type: Number, default: 3, min: 1, max: 30 },
    },
    /*
     * TAOM TAKLIFLARI PUSH'I (mijoz ilovasi, services/promoPush.js). Kuniga 2 slot, Toshkent vaqti.
     * Standart O'CHIQ — admin sinab ko'rib yoqadi.
     */
    promoPush: {
      enabled: { type: Boolean, default: false },
      lunchFrom: { type: String, default: '11:30' },
      lunchTo: { type: String, default: '12:30' },
      dinnerFrom: { type: String, default: '18:00' },
      dinnerTo: { type: String, default: '19:30' },
    },
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
