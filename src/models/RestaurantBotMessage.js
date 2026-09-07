import { Schema, model } from 'mongoose';

/*
 * ═══════════════════════════════════════════════════════════
 * BOT XABARLARINING IZI
 * ═══════════════════════════════════════════════════════════
 *
 * Bitta buyurtma restoranning BARCHA ulangan xodimlariga
 * yuboriladi. Xodimlardan biri "Qabul qilish" bosganda,
 * QOLGANLARINING ekranidagi xabar ham yangilanishi kerak —
 * aks holda ular hali ham "Qabul qilish" tugmasini ko'rib
 * turadi va bosishga urinadi (TZ 18-band).
 *
 * Buning uchun har bir yuborilgan xabarning message_id sini
 * bilishimiz kerak. Telegram uni faqat yuborish paytida
 * qaytaradi — keyin so'rab olib bo'lmaydi. Shuning uchun
 * saqlaymiz.
 *
 * ─── NIMA UCHUN ALOHIDA KOLLEKSIYA ───
 * Order ichiga massiv sifatida yozish ham mumkin edi, lekin
 * o'shanda har bir xabar yangilanishida butun Order hujjati
 * qayta yozilardi. Buyurtma esa eng band kolleksiya —
 * u yerga keraksiz yozuv qo'shmaslik ma'qul.
 *
 * TTL: 24 soatdan keyin avtomatik o'chadi. Eski buyurtma
 * xabarini yangilash ma'nosiz, saqlash esa bazani shishiradi.
 */
const restaurantBotMessageSchema = new Schema(
  {
    orderId: { type: Schema.Types.ObjectId, ref: 'Order', required: true, index: true },
    telegramUserId: { type: String, required: true },
    messageId: { type: Number, required: true },

    // 'order' | 'reservation' — bir xil mexanizm ikkalasiga
    kind: { type: String, default: 'order' },

    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false },
);

// 24 soatdan keyin o'zi o'chadi
restaurantBotMessageSchema.index({ createdAt: 1 }, { expireAfterSeconds: 24 * 60 * 60 });

export const RestaurantBotMessage = model('RestaurantBotMessage', restaurantBotMessageSchema);
