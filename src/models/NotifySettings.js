import { Schema, model } from 'mongoose';

/**
 * Restoranning buyurtma bildirishnomasi sozlamalari (admin panel → «Bildirishnomalar»).
 * Alohida kolleksiya: mavjud Restaurant sxemasiga TEGILMAGAN (ixtiyoriy, orqaga mos). Yozuv yo'q bo'lsa — standart qiymatlar
 * (hozirgi xatti-harakat: ovozli, 30 s da takror, 10 martagacha).
 */
const notifySettingsSchema = new Schema(
  {
    restaurantId: { type: Schema.Types.ObjectId, ref: 'Restaurant', required: true, unique: true },
    sound: { type: Boolean, default: true },
    vibration: { type: Boolean, default: true },
    repeatEnabled: { type: Boolean, default: true },
    repeatIntervalSec: { type: Number, enum: [30, 60, 90], default: 30 },
    repeatLimit: { type: Number, min: 1, max: 20, default: 10 },       // jami yuborishlar (birinchisi bilan)
    soundType: { type: String, enum: ['default', 'custom'], default: 'custom' },   // iOS: tizim ovozi yoki LokmaGo melodiyasi
  },
  { timestamps: true },
);

export const NotifySettings = model('NotifySettings', notifySettingsSchema);
