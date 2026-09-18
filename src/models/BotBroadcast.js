import { Schema, model } from 'mongoose';

/*
 * ═══════════════════════════════════════════════════════════
 * RESTORAN BOTLARI — XABAR YUBORISH
 * ═══════════════════════════════════════════════════════════
 *
 * Admin restoran xodimlariga (bot orqali) xabar yuboradi:
 * yangilik, eslatma, so'rov. Xabar ostiga tugmalar qo'yish
 * mumkin — kim bosgani sanaladi.
 *
 * IKKI HUJJAT:
 *   BotBroadcast         — xabarning O'ZI (matn, tugmalar, maqsad)
 *   BotBroadcastDelivery — HAR BIR oluvchi uchun alohida yozuv
 *
 * Nega alohida: 50 restoranga yuborilsa, kim oldi, kim bloklagan,
 * kim tugma bosgan — hammasi alohida kuzatiladi va statistika
 * bitta so'rov bilan chiqadi.
 *
 * ⚠ TELEGRAM CHEKLOVI: "xabarni o'qidi" ma'lumotini bermaydi.
 * Shuning uchun uchta o'lchanadigan holat bor:
 *   sent    — Telegram qabul qildi va yetkazdi
 *   failed  — xato (bloklagan, chat topilmadi va h.k.)
 *   clicked — tugma bosildi (kim, qachon, qaysi tugma)
 */

const buttonSchema = new Schema({
  // Tugma matni (Telegram cheklovi ~64 belgi)
  text: { type: String, required: true, maxlength: 64 },
  /*
   * `callback` — javob tugmasi (bosilgani sanaladi).
   * `url`      — havola tugmasi (bosilishi Telegram tomonidan
   *              hisoblanmaydi, shuning uchun sanalmaydi).
   */
  kind: { type: String, enum: ['callback', 'url'], default: 'callback' },
  url: { type: String, default: '' },
  // Ichki kalit — statistikada shu bo'yicha guruhlanadi
  key: { type: String, required: true, maxlength: 32 },
}, { _id: false });

const broadcastSchema = new Schema(
  {
    title: { type: String, default: '', maxlength: 120 },   // faqat admin ko'radi
    text: { type: String, required: true, maxlength: 3500 },

    /*
     * Telegram formatlash. `html` — <b>, <i>, <a href>.
     * `none` — oddiy matn (belgilar ekranlanadi).
     */
    format: { type: String, enum: ['html', 'none'], default: 'html' },

    // Tugmalar: har qatorda bittadan (mobil ekranda o'qish qulay)
    buttons: { type: [buttonSchema], default: [] },

    // Kimga: barchasiga yoki tanlanganlarga
    target: { type: String, enum: ['all', 'selected'], default: 'all' },
    restaurantIds: [{ type: Schema.Types.ObjectId, ref: 'Restaurant' }],

    status: {
      type: String,
      enum: ['draft', 'sending', 'sent', 'failed'],
      default: 'draft',
      index: true,
    },

    // Yig'ma statistika — tez ko'rsatish uchun (haqiqat manbai: Delivery)
    stats: {
      total: { type: Number, default: 0 },      // nechta xodimga urinildi
      sent: { type: Number, default: 0 },
      failed: { type: Number, default: 0 },
      clicked: { type: Number, default: 0 },    // noyob bosganlar
      restaurants: { type: Number, default: 0 },
    },

    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    createdByName: { type: String, default: '' },
    sentAt: { type: Date, default: null },
    error: { type: String, default: '' },
  },
  { timestamps: true },
);

broadcastSchema.index({ createdAt: -1 });

export const BotBroadcast = model('BotBroadcast', broadcastSchema);

/* ═══════════════════════════════════════════════════════════ */

const deliverySchema = new Schema(
  {
    broadcastId: { type: Schema.Types.ObjectId, ref: 'BotBroadcast', required: true, index: true },
    restaurantId: { type: Schema.Types.ObjectId, ref: 'Restaurant', index: true },
    restaurantName: { type: String, default: '' },

    telegramUserId: { type: String, required: true },
    staffName: { type: String, default: '' },

    status: { type: String, enum: ['sent', 'failed'], required: true },
    messageId: { type: Number, default: null },
    error: { type: String, default: '' },

    // Tugma bosilishi
    clickedAt: { type: Date, default: null },
    clickedKey: { type: String, default: '' },
  },
  { timestamps: true },
);

/*
 * Bir xodimga bitta xabar BIR MARTA yoziladi. Yuborish qayta
 * ishga tushsa ham takror yozuv paydo bo'lmaydi va statistika
 * shishib ketmaydi.
 */
deliverySchema.index({ broadcastId: 1, telegramUserId: 1 }, { unique: true });

export const BotBroadcastDelivery = model('BotBroadcastDelivery', deliverySchema);
