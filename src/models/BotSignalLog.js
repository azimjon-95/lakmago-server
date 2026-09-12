import { Schema, model } from 'mongoose';

/*
 * ═══════════════════════════════════════════════════════════
 * SIGNAL YUBORILGANI — TAKRORLANMASLIK KAFOLATI
 * ═══════════════════════════════════════════════════════════
 *
 * Talab: bitta buyurtma/bron uchun ovozli signal FAQAT BIR
 * MARTA ketsin — server qayta ishga tushsa, Telegram qayta
 * urinsa yoki notifyNewOrder ikkinchi bor chaqirilsa ham
 * (masalan karta to'lovi tasdiqlangandan keyin).
 *
 * Shuning uchun belgi xotirada emas, BAZADA saqlanadi:
 * xotiradagi Set restartda yo'qoladi va signal qaytadan ketardi.
 *
 * Unique indeks — atomik "band qilish" vositasi: yozuvni
 * yaratish muvaffaqiyatli bo'lsa, signalni aynan shu jarayon
 * yuboradi. Ikkita server nusxasi bir vaqtda urinsa, ikkinchisi
 * 11000 (duplicate key) oladi va yubormaydi.
 *
 * TTL 7 kun: buyurtma bir kunda ahamiyatini yo'qotadi, lekin
 * zaxira sifatida keng oraliq olinadi. TTL o'chirgach yozuv
 * yo'qoladi — o'sha eski buyurtma qayta signal bermaydi,
 * chunki uni qayta e'lon qiladigan kod yo'q.
 */
const botSignalLogSchema = new Schema(
  {
    // Buyurtma yoki bron _id si (matn ko'rinishida — ikkala tur uchun bir xil)
    refId: { type: String, required: true },
    // 'order' | 'reservation'
    kind: { type: String, required: true },
    // Qaysi xodimga yuborilgani — har biri o'z signalini bir marta oladi
    telegramUserId: { type: String, required: true },

    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false },
);

botSignalLogSchema.index({ refId: 1, kind: 1, telegramUserId: 1 }, { unique: true });
botSignalLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 7 * 24 * 60 * 60 });

export const BotSignalLog = model('BotSignalLog', botSignalLogSchema);
