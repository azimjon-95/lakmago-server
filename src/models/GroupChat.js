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

    /*
     * ═══ RESTORAN GURUHI / KANALI (2026-11) ═══ — services/telegramGroup.js
     * restaurantId bo'sh   — UMUMIY LokmaGo guruhi: avvalgidek (umumiy "Buyurtma berish" pin, LokmaGo bosh sahifasi).
     * restaurantId bor     — RESTORAN guruhi: bot restoran nomi + tugmani pin qiladi, tugma SHU restoran sahifasini ochadi
     *                        (startapp=rest_<id>); umumiy LokmaGo promo bu yerga pin qilinmaydi.
     * adsEnabled           — umumiy reklama (admin "Reklama yuborish") shu chatga ketadimi. Restoran biriktirilganda o'chiriladi
     *                        (admin xohlasa yoqadi). Kanallarda standart o'chiq (avval kanallarga hech narsa yuborilmagan).
     */
    kind: { type: String, enum: ['group', 'channel'], default: 'group' },
    restaurantId: { type: Schema.Types.ObjectId, ref: 'Restaurant', default: null, index: true },
    adsEnabled: { type: Boolean, default: true },
    restaurantPin: {
      messageId: { type: Number, default: null },
      isPinned: { type: Boolean, default: false },
      pinnedAt: { type: Date, default: null },
      error: { type: String, default: '' },
    },
    boundAt: { type: Date, default: null },
    boundBy: { type: String, default: '' },
  },
  { timestamps: true },
);

export const GroupChat = model('GroupChat', groupChatSchema);
