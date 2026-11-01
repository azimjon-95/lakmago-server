import { Schema, model } from 'mongoose';

/**
 * Har bir yuborish (buyurtma × urinish × qurilma) uchun bitta yozuv — "server yubordi" ≠ "telefonga yetdi" ni farqlash uchun:
 *   SENT (provayder qabul qildi) → RECEIVED (ilova qabul qildi, hozircha faqat Android) → OPENED (bildirishnoma bosildi)
 *   FAILED (provayder rad etdi, sabab `error` da).
 * Mijoz ma'lumoti saqlanmaydi. 7 kundan keyin o'zi o'chadi (TTL). Idempotent: (orderId, type, attempt, deviceKey) unikal.
 */
const notificationLogSchema = new Schema({
  notificationId: { type: String, required: true },                 // `${orderId}:${attempt}`
  orderId: { type: Schema.Types.ObjectId, required: true },
  restaurantId: { type: Schema.Types.ObjectId, required: true, index: true },
  deviceKey: { type: String, required: true },                      // MobileDevice._id (token EMAS)
  platform: { type: String, enum: ['android', 'ios'], required: true },
  provider: { type: String, enum: ['fcm', 'apns'], required: true },
  type: { type: String, enum: ['NEW_ORDER', 'ORDER_UPDATED', 'ORDER_CANCELLED'], required: true },
  attempt: { type: Number, default: 1 },
  status: { type: String, enum: ['SENT', 'FAILED', 'RECEIVED', 'OPENED'], required: true },
  error: { type: String, default: '' },
  sentAt: { type: Date, default: Date.now },
  receivedAt: { type: Date, default: null },
  openedAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now, expires: 7 * 24 * 3600 },
});
notificationLogSchema.index({ orderId: 1, type: 1, attempt: 1, deviceKey: 1 }, { unique: true });

export const NotificationLog = model('NotificationLog', notificationLogSchema);
