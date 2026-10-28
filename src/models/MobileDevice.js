import { Schema, model } from 'mongoose';

/**
 * Restoran mobil ilovasining (Android / iOS) push tokeni.
 *
 * Web Push obunalari (PushSubscription — brauzer paneli) bilan aralashtirilmaydi: bu yerda FCM (Android) yoki
 * APNs (iOS) tokeni saqlanadi. Bitta token faqat BITTA restoranda bo'ladi: telefon boshqa restoranga kirsa,
 * yozuv o'sha restoranga ko'chadi (eski restoranning buyurtmalari bu telefonga bormaydi).
 */
const mobileDeviceSchema = new Schema(
  {
    token: { type: String, required: true, unique: true, index: true },
    platform: { type: String, enum: ['android', 'ios'], required: true },
    restaurantId: { type: Schema.Types.ObjectId, ref: 'Restaurant', required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User' },
    // iOS: Xcode/debug build tokeni 'development' (sandbox APNs), TestFlight/App Store tokeni 'production'. Yo'q bo'lsa — APNS_PRODUCTION.
    environment: { type: String, enum: ['development', 'production'], default: null },

    // Monitoring: oxirgi muvaffaqiyatli yuborish va oxirgi xato (token ishlayaptimi?)
    lastSeen: { type: Date, default: Date.now },
    lastSentAt: { type: Date, default: null },
    lastError: { type: String, default: '' },
    failCount: { type: Number, default: 0 },
  },
  { timestamps: true },
);

export const MobileDevice = model('MobileDevice', mobileDeviceSchema);
