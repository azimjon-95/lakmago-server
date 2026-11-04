import { Schema, model } from 'mongoose';

/**
 * Kuryer — LokmaGo tomonidan boshqariladigan kuryerlar ro'yxati.
 *
 * Hozircha ODDIY REYESTR: LokmaGo (yoki restoran) admin panelidan
 * kuryerni ism/telefon/Telegram chat ID bilan qo'shadi. Kuryer
 * o'zi ro'yxatdan o'tmaydi — bu keyingi versiyada (APK bilan
 * birga) to'liq ro'yxatdan o'tish oqimiga kengaytiriladi.
 *
 * telegramChatId — ENG MUHIM maydon: shu ID orqali kuryerga
 * buyurtma havolasi yuboriladi. Kuryer botga /start bosib o'z
 * chat ID sini administratorga bergan bo'lishi kerak (yoki bot
 * orqali ro'yxatdan o'tish oqimi — hozircha qo'lda kiritiladi).
 */
const courierSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    phone: { type: String, default: '' },
    telegramChatId: { type: String, required: true, index: true },
    telegramUsername: { type: String, default: '' },

    isActive: { type: Boolean, default: true },

    // Statistika — kelajakda reyting/hisobot uchun
    totalDeliveries: { type: Number, default: 0 },

    createdAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

export const Courier = model('Courier', courierSchema);
