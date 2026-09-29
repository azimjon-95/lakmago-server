import { Schema, model } from 'mongoose';

/*
 * ═══════════════════════════════════════════════════════════
 * BFF HODISALARI NAVBATI (outbox)
 * ═══════════════════════════════════════════════════════════
 *
 * Buyurtma o'zgarganda hodisa AVVAL shu yerga yoziladi (buyurtma
 * yozuvi bilan bir so'rov ichida, tez), yuborishni esa alohida ishchi
 * qiladi (services/bffEvents.js). Nega to'g'ridan-to'g'ri POST emas:
 *   • BFF vaqtincha o'chiq (deploy) yoki sekin bo'lsa hodisa YO'QOLMASIN —
 *     "yangi buyurtma keldi, lekin restoran ilovasi bilmadi" eng yomon xato;
 *   • server qayta ishga tushsa ham navbat saqlanadi;
 *   • buyurtma yaratish/status o'zgartirish BFF javobini KUTMAYDI.
 *
 * Hodisa faqat SIGNAL ("shu buyurtma o'zgardi"): BFF tafsilotni
 * GET /app/service/:restaurantId/orders/:id dan oladi. Shuning uchun
 * tartib va takroriy yetkazish muhim emas (BFF idempotent bo'lishi kerak).
 */
const schema = new Schema(
  {
    event: { type: String, enum: ['created', 'updated', 'cancelled', 'delivered'], required: true },
    restaurantId: { type: String, required: true },
    orderId: { type: String, required: true, index: true },
    // created/cancelled/delivered — buyurtma uchun BIR MARTA ("created:<id>"); updated — yo'q
    dedupeKey: { type: String, default: undefined },
    attempts: { type: Number, default: 0 },
    nextAttemptAt: { type: Date, default: Date.now },
    // Ishchi olganda 30 soniyalik ijara — ikki nusxa bir hodisani yubormasin
    lockedUntil: { type: Date, default: () => new Date(0) },
    doneAt: { type: Date, default: null },
    failed: { type: Boolean, default: false },
    lastError: { type: String, default: '' },
  },
  { timestamps: true },
);

schema.index({ dedupeKey: 1 }, { unique: true, sparse: true });
schema.index({ doneAt: 1, nextAttemptAt: 1 });
// Eski yozuvlar o'zi o'chadi
schema.index({ createdAt: 1 }, { expireAfterSeconds: 3 * 24 * 60 * 60 });

export const BffEvent = model('BffEvent', schema);
