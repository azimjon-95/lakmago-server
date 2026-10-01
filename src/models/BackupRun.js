import { Schema, model } from 'mongoose';

/*
 * Bazaning kunlik JSON zaxirasi — HAR URINISH/YUBORISH yozuvi (services/dbBackup.js).
 *
 * Vazifalari:
 *   • `ymd` UNIQUE — bir kun uchun zaxira BIR MARTA (bir nechta server nusxasi
 *     yoki qayta ishga tushish ikki marta yubormasin);
 *   • qayta urinish holati (failed → nextAttemptAt);
 *   • Telegram'ga tushgan fayl (messageId) — eskisini KEYIN o'chirish uchun;
 *   • o'chirish jadvali (deleteAt/deletedAt) server qayta ishga tushsa ham saqlanadi.
 */
const schema = new Schema(
  {
    // 'YYYY-MM-DD' (Toshkent). Qo'lda ishga tushirilsa: 'YYYY-MM-DD+manual-HHMMSS'
    ymd: { type: String, required: true, unique: true },
    trigger: { type: String, enum: ['schedule', 'catchup', 'manual'], default: 'schedule' },
    status: { type: String, enum: ['running', 'sent', 'failed'], default: 'running', index: true },
    attempts: { type: Number, default: 0 },
    nextAttemptAt: { type: Date, default: null },
    lockedUntil: { type: Date, default: null },
    startedAt: { type: Date, default: Date.now },
    error: { type: String, default: '' },

    chatId: { type: String, default: '' },
    messageId: { type: Number, default: null },
    fileName: { type: String, default: '' },
    gzip: { type: Boolean, default: false },
    bytes: { type: Number, default: 0 },        // JSON hajmi (siqishdan oldin)
    sentBytes: { type: Number, default: 0 },    // Telegram'ga yuborilgan hajm
    collections: { type: Number, default: 0 },
    documents: { type: Number, default: 0 },
    durationMs: { type: Number, default: 0 },
    sentAt: { type: Date, default: null },

    // Yangi fayl KELGACH eskisiga qo'yiladi; yangi kelmasa hech qachon qo'yilmaydi
    deleteAt: { type: Date, default: null },
    deletedAt: { type: Date, default: null },
    deleteAttempts: { type: Number, default: 0 },
    deleteError: { type: String, default: '' },
  },
  { timestamps: true },
);

schema.index({ status: 1, deleteAt: 1, deletedAt: 1 });
schema.index({ status: 1, nextAttemptAt: 1 });
schema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

export const BackupRun = model('BackupRun', schema);
