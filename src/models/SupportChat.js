import { Schema, model } from 'mongoose';

// Qo'llab-quvvatlash suhbati — har mijoz uchun bitta.
// Xabarlar ichida saqlanadi (suhbat qisqa bo'ladi, alohida kolleksiya shart emas).
const messageSchema = new Schema({
  // 'user' — mijoz yozdi, 'admin' — operator javob berdi
  from: { type: String, enum: ['user', 'admin'], required: true },
  text: { type: String, required: true },
  // Operator ismi (admin javobida)
  adminName: { type: String, default: '' },
  readAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
}, { _id: true });

/*
 * Telegram guruhdagi shu mijozning JORIY posti (services/supportGroupNotify.js).
 * Mijoz qayta-qayta yozsa har safar yangi xabar emas — shu post tahrirlanadi
 * (editMessageText), yangi satr pastdan qo'shiladi. Telegram xabar matnini
 * qayta yig'ish uchun satrlar shu yerda saqlanadi.
 */
const groupPostSchema = new Schema({
  chatId: { type: String, required: true },     // qaysi guruhda (sozlama o'zgarsa eski post tahrirlanmaydi)
  messageId: { type: Number, required: true },
  /*
   * Post satrlari xronologik tartibda: mijoz xabari (`user`) yoki admin javobi
   * belgisi (`reply`, ✅✅). Admin javobidan KEYIN mijoz yozsa ham shu postga
   * qo'shiladi — sessiya yopilguncha bitta post.
   */
  lines: [{
    kind: { type: String, enum: ['user', 'reply'], default: 'user' },
    text: String,       // user uchun
    by: String,         // reply uchun: admin ismi
    at: Date,
    _id: false,
  }],
  continued: { type: Boolean, default: false },  // oldingi post to'lib, davomi
  startedAt: { type: Date, default: Date.now },
  lastLineAt: { type: Date, default: Date.now }, // MIJOZNING oxirgi xabari
  closedAt: { type: Date, default: null },       // sessiya yopildi — keyingi xabar YANGI post
  // ESKI shakl (kind'siz postlar): javob alohida maydonda edi. Yangi kod yozmaydi, faqat o'qiydi.
  repliedAt: { type: Date, default: null },
  repliedBy: { type: String, default: '' },
}, { _id: false });

const supportChatSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },

    // Mijoz ma'lumotlari — adminga darhol ko'rinishi uchun nusxalanadi
    telegramId: { type: String, index: true },
    firstName: { type: String, default: '' },
    lastName: { type: String, default: '' },
    username: { type: String, default: '' },
    photoUrl: { type: String, default: '' },
    phone: { type: String, default: '' },

    messages: [messageSchema],

    // Admin uchun holat
    unreadCount: { type: Number, default: 0, index: true },   // admin o'qimagan
    userUnreadCount: { type: Number, default: 0 },            // mijoz o'qimagan
    lastMessageAt: { type: Date, default: Date.now, index: true },
    lastMessageText: { type: String, default: '' },

    // Suhbat yopilganmi (hal qilingan)
    isResolved: { type: Boolean, default: false, index: true },
    // Guruhdagi joriy post (null — hali yo'q yoki guruh o'chiq)
    groupPost: { type: groupPostSchema, default: null },
  },
  { timestamps: true },
);

// Admin ro'yxati uchun: o'qilmagan birinchi, keyin yangi
supportChatSchema.index({ isResolved: 1, lastMessageAt: -1 });

export const SupportChat = model('SupportChat', supportChatSchema);
