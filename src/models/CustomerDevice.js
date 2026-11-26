import { Schema, model } from 'mongoose';

/**
 * MIJOZ ilovasi (Lokma Go, iOS/Android) qurilmasi — taom takliflari push'i uchun.
 *
 * Restoran ilovasi qurilmalari (MobileDevice) bilan ARALASHMAYDI: boshqa ilova, boshqa maqsad.
 * deviceId — X-Lokma-Device izi (services/clientChannel.js → deviceFingerprint; xom ID saqlanmaydi).
 * Mehmon (hisobsiz) ham bo'lishi mumkin — userId ixtiyoriy (guest-first, 4-qoida).
 * Token logga yozilmaydi (6-qoida).
 */
const customerDeviceSchema = new Schema(
  {
    deviceId: { type: String, required: true, unique: true },
    token: { type: String, default: '' },
    platform: { type: String, enum: ['android', 'ios'], required: true },
    // iOS: null — avval production, BadDeviceToken bo'lsa sandbox sinab ko'riladi va natija shu yerga yoziladi
    environment: { type: String, enum: ['development', 'production', null], default: null },
    userId: { type: Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    lang: { type: String, enum: ['uz', 'uzc', 'ru'], default: 'uz' },
    district: { type: String, default: '' },
    appVersion: { type: String, default: '' },

    // Mijoz roziligi (ilova ichidagi tugma) va OS ruxsati. Ikkalasi ham bo'lsagina yuboriladi.
    promoOptIn: { type: Boolean, default: false },
    osPermission: { type: String, enum: ['granted', 'denied', 'prompt', 'unknown'], default: 'unknown' },
    consentAt: { type: Date, default: null },

    lastSeen: { type: Date, default: Date.now },
    lastSentAt: { type: Date, default: null },
    lastOpenedAt: { type: Date, default: null },
    lastError: { type: String, default: '' },
    failCount: { type: Number, default: 0 },
  },
  { timestamps: true },
);

customerDeviceSchema.index({ token: 1 }, { unique: true, partialFilterExpression: { token: { $type: 'string', $gt: '' } } });
customerDeviceSchema.index({ promoOptIn: 1, osPermission: 1, failCount: 1 });

export const CustomerDevice = model('CustomerDevice', customerDeviceSchema);
