import { Schema, model } from 'mongoose';

/**
 * Bitta buyurtma uchun mobil push holati.
 *  • `orderId` takrorlanmas → bir buyurtma ikki marta "yangi" deb yuborilmaydi (retry / ikki emit).
 *  • Buyurtma qabul qilinmaguncha push qayta yuboriladi (iOS o'zi takrorlay olmaydi): sentCount / lastSentAt.
 *  • `done` → qabul qilindi / bekor qilindi / chegara: boshqa yuborilmaydi.
 * Server qayta ishga tushsa ham holat yo'qolmaydi (bazada). 2 kundan keyin o'zi o'chadi.
 */
const orderPushStateSchema = new Schema(
  {
    orderId: { type: Schema.Types.ObjectId, ref: 'Order', required: true, unique: true },
    restaurantId: { type: Schema.Types.ObjectId, ref: 'Restaurant', required: true, index: true },
    sentCount: { type: Number, default: 0 },
    lastSentAt: { type: Date, default: null },
    done: { type: Boolean, default: false, index: true },
    // monitoring
    delivered: { type: Number, default: 0 },   // provayder qabul qilgan xabarlar (telefonga yetganini EMAS)
    failed: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now, expires: 2 * 24 * 3600 },
  },
);

export const OrderPushState = model('OrderPushState', orderPushStateSchema);
