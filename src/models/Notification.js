import { Schema, model } from 'mongoose';

/**
 * Bildirishnoma — markaziy tizim.
 *
 * Nega bazada saqlanadi:
 *   • Socket uzilib qolsa hodisa yo'qoladi. Bazada tursa,
 *     qayta ulanишda "seq" bo'yicha yetkazilmaganini olib kelamiz.
 *   • Panel qayta yuklansa ham bajarilmagan ishlar qoladi.
 *   • Server qayta ishga tushsa ham muhim hodisalar saqlanadi.
 *
 * notificationId — hodisa manbasidan hosil qilinadi
 * ("order:<id>", "reservation:<id>"). Shu tufayli bir hodisa
 * ikki marta yuborilsa ham bitta yozuv bo'ladi.
 */
const notificationSchema = new Schema(
  {
    // Takrorlanmas kalit — dublikatni bazada to'xtatadi
    notificationId: { type: String, required: true, unique: true, index: true },

    // Kimga: 'admin' yoki muayyan restoran
    audience: { type: String, enum: ['admin', 'restaurant'], required: true, index: true },
    restaurantId: { type: Schema.Types.ObjectId, ref: 'Restaurant', index: true },

    type: {
      type: String,
      required: true,
      enum: ['order', 'hall_order', 'reservation', 'waiter_call', 'bill_request', 'support'],
      index: true,
    },

    title: { type: String, required: true },
    body: { type: String, default: '' },

    // Qaysi ovoz chalinadi
    sound: { type: String, enum: ['orders', 'reservations', 'hall-orders', 'none'], default: 'orders' },

    // Bosilganda nima ochiladi
    refType: { type: String, default: '' },   // order | reservation | table
    refId: { type: String, default: '' },

    status: {
      type: String,
      enum: ['NEW', 'DELIVERED', 'SEEN', 'ACCEPTED', 'CANCELLED', 'MUTED'],
      default: 'NEW',
      index: true,
    },

    /**
     * O'sib boruvchi raqam. Qayta ulanganda mijoz oxirgi
     * ko'rgan seq'ini yuboradi, server undan keyingilarini
     * qaytaradi. createdAt bo'yicha emas — bir millisekundda
     * ikkita yozuv bo'lsa tartib buziladi.
     */
    seq: { type: Number, required: true, index: true },

    meta: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true },
);

// "Shu restoranning yetkazilmaganlari" — eng ko'p ishlatiladigan so'rov
notificationSchema.index({ audience: 1, restaurantId: 1, seq: 1 });

// Eski bildirishnomalar 30 kundan keyin o'zi o'chadi
notificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 });

export const Notification = model('Notification', notificationSchema);

/**
 * Ketma-ket raqam beruvchi hisoblagich.
 * findOneAndUpdate atomik — bir vaqtda kelgan hodisalar
 * bir xil raqam olmaydi.
 */
const counterSchema = new Schema({
  _id: { type: String },
  value: { type: Number, default: 0 },
});

export const Counter = model('Counter', counterSchema);

export async function nextSeq(name = 'notification') {
  const doc = await Counter.findByIdAndUpdate(
    name,
    { $inc: { value: 1 } },
    { new: true, upsert: true },
  ).lean();
  return doc.value;
}
