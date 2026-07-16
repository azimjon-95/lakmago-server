import { Schema, model } from 'mongoose';

// Bot admin qilingan Telegram guruhlari.
// Har kuni tekshiriladi: reklama xabari yuborilganmi va pin qilinganmi.
const groupChatSchema = new Schema(
  {
    chatId: { type: String, required: true, unique: true, index: true },
    title: { type: String, default: '' },
    type: { type: String, default: 'group' }, // group | supergroup

    // Bot hozir shu guruhда adminmi? (admin bo'lmasa pin qila olmaydi)
    isBotAdmin: { type: Boolean, default: false },

    // Reklama xabari holati
    promoMessageId: { type: Number, default: null }, // yuborilган xabar ID
    promoSentAt: { type: Date, default: null },
    isPinned: { type: Boolean, default: false },

    // Guruh faolmi (bot chiqarib yuborilmaganmi)
    isActive: { type: Boolean, default: true },

    lastCheckedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

export const GroupChat = model('GroupChat', groupChatSchema);
