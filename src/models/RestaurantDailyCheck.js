import { Schema, model } from 'mongoose';

/*
 * ═══════════════════════════════════════════════════════════
 * ERTALABKI OCHILISH TEKSHIRUVI — KUNLIK HOLAT
 * ═══════════════════════════════════════════════════════════
 * Har restoran uchun har kuni BITTA yozuv (restoran vaqt zonasidagi sana bo'yicha):
 * ochilishda xodimlarga "taomlarni tekshiring, stopdagilarni stop-listga qo'shing"
 * xabari yuborilganmi, javob berilganmi (bot yoki panel orqali), nechta eslatma ketgan.
 *
 * Bu YANGI kolleksiya — mavjud modellarga tegmaydi (services/morningChecklist.js).
 * Unique indeks {restaurantId, date}: bir kunda bitta yozuv; ikkita jarayon bir vaqtda
 * birinchi xabarni yubormoqchi bo'lsa, faqat biri yozuvni yarata oladi (E11000 → ikkinchisi
 * jim chiqib ketadi). Eski yozuvlar 180 kundan keyin o'zi o'chadi (TTL).
 */
const schema = new Schema(
  {
    restaurantId: { type: Schema.Types.ObjectId, ref: 'Restaurant', required: true, index: true },
    date: { type: String, required: true },                 // "YYYY-MM-DD" (restoran vaqt zonasida)
    status: { type: String, enum: ['pending', 'checked_all_ok', 'checked_with_stop'], default: 'pending' },
    firstSentAt: { type: Date, default: null },
    lastReminderAt: { type: Date, default: null },
    reminderCount: { type: Number, default: 0 },
    respondedAt: { type: Date, default: null },
    respondedBy: { type: String, default: null },           // telegramUserId yoki panel userId
    respondedVia: { type: String, enum: ['bot', 'panel', null], default: null },

    // Qo'shimcha (faqat shu yangi kolleksiyada): admin jadvalida ism ko'rsatish va
    // javob berilganda barcha xodimlardagi xabar tugmalarini olib tashlash uchun
    respondedByName: { type: String, default: '' },
    messages: {
      type: [new Schema({
        chatId: { type: String, required: true },
        messageId: { type: Number, required: true },
        kind: { type: String, enum: ['first', 'reminder'], default: 'first' },
        at: { type: Date, default: Date.now },
      }, { _id: false })],
      default: [],
    },
  },
  { timestamps: true },
);

schema.index({ restaurantId: 1, date: 1 }, { unique: true });
schema.index({ status: 1, date: 1 });
schema.index({ createdAt: 1 }, { expireAfterSeconds: 180 * 24 * 60 * 60 });

export const RestaurantDailyCheck = model('RestaurantDailyCheck', schema);
