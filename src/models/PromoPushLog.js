import { Schema, model } from 'mongoose';

/**
 * Taom taklifi push'i jurnali.
 *
 * (deviceId, day, slot) UNIQUE — bir qurilmaga bir kunda bir slotga ko'pi bilan BITTA xabar
 * (bir nechta pm2 nusxasi bo'lsa ham: yozuv yuborishdan OLDIN qo'yiladi, ikkinchisi dublikat xatosini oladi).
 * Takrorlanmaslik shu jurnaldan hisoblanadi (shablon 14 kun, taom 7 kun).
 */
const promoPushLogSchema = new Schema(
  {
    deviceId: { type: String, required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    day: { type: String, required: true },          // Toshkent sanasi YYYY-MM-DD
    slot: { type: String, enum: ['lunch', 'dinner', 'test'], required: true },
    templateId: { type: String, default: '' },
    dishId: { type: Schema.Types.ObjectId, ref: 'Dish', default: null },
    restaurantId: { type: Schema.Types.ObjectId, ref: 'Restaurant', default: null },
    lang: { type: String, default: 'uz' },
    title: { type: String, default: '' },
    body: { type: String, default: '' },
    status: { type: String, enum: ['sending', 'sent', 'failed', 'skipped'], default: 'sending' },
    error: { type: String, default: '' },
    sentAt: { type: Date, default: null },
    openedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

promoPushLogSchema.index(
  { deviceId: 1, day: 1, slot: 1 },
  { unique: true, partialFilterExpression: { slot: { $in: ['lunch', 'dinner'] } } },
);
promoPushLogSchema.index({ deviceId: 1, createdAt: -1 });
promoPushLogSchema.index({ userId: 1, day: 1 });
promoPushLogSchema.index({ day: 1, slot: 1, status: 1 });
promoPushLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 120 * 86_400 });

export const PromoPushLog = model('PromoPushLog', promoPushLogSchema);
