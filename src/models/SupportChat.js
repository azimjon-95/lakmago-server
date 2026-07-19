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
  },
  { timestamps: true },
);

// Admin ro'yxati uchun: o'qilmagan birinchi, keyin yangi
supportChatSchema.index({ isResolved: 1, lastMessageAt: -1 });

export const SupportChat = model('SupportChat', supportChatSchema);
