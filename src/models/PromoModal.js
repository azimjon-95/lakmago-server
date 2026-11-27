import mongoose from 'mongoose';

/*
 * ═══ REKLAMA OYNALARI (mijoz ilovasi ochilganda) ═══
 * Admin bir nechta yaratadi; mijozga NAVBAT bilan ko'rsatiladi (bittasini yopsa — keyingisi).
 * Har oyna mijozga kuniga bir marta (frequency=daily) yoki umuman bir marta (once).
 * `version` — admin "Qayta ko'rsatish" desa oshadi: bugun ko'rganlarga ham yana chiqadi.
 * Matnda *yulduzcha* ichidagi qism shablonning urg'u rangida chiqadi (HTML emas — xavfsiz).
 */
const promoModalSchema = new mongoose.Schema(
  {
    // image — faqat rasm: matnsiz, ramkasiz, butun oynani qoplaydi
    template: { type: String, enum: ['brush', 'coupon', 'sunburst', 'image'], default: 'brush' },
    title: { type: String, default: '', maxlength: 90 },
    footer: { type: String, default: '', maxlength: 70 },
    imageUrl: { type: String, default: '' },
    /** Bosilganda ochiladigan sahifa: ilova ichidagi yo'l (/market) yoki https havola; bo'sh — faqat yopiladi */
    link: { type: String, default: '', maxlength: 200 },
    /**
     * "Faqat rasm" oynasining pastki tugmalari (0–2 ta): nom + havola. Boshqa shablonlarda bo'sh.
     * `clicks` — shu tugma bosilgan soni (umumiy stats.clicked ham oshadi).
     */
    buttons: {
      type: [new mongoose.Schema({
        label: { type: String, required: true, maxlength: 24 },
        link: { type: String, required: true, maxlength: 200 },
        clicks: { type: Number, default: 0 },
      }, { _id: false })],
      default: [],
    },
    active: { type: Boolean, default: false, index: true },
    order: { type: Number, default: 0 },
    frequency: { type: String, enum: ['daily', 'once'], default: 'daily' },
    // Kimga ko'rinadi (services/clientChannel.js). not_app — sayt va Telegram (ilovaga taklif uchun).
    audience: { type: String, enum: ['all', 'app', 'not_app', 'telegram', 'web'], default: 'all' },
    // Tugma: oddiy havola yoki "Ilovani yuklab olish" (mijoz qurilmasiga mos App Store / Google Play)
    cta: { type: String, enum: ['link', 'install_app'], default: 'link' },
    startsAt: { type: Date, default: null },
    endsAt: { type: Date, default: null },
    version: { type: Number, default: 1 },
    stats: {
      shown: { type: Number, default: 0 },
      clicked: { type: Number, default: 0 },
    },
  },
  { timestamps: true },
);
promoModalSchema.index({ active: 1, order: 1 });

export const PromoModal = mongoose.model('PromoModal', promoModalSchema);
