import { Schema, model } from 'mongoose';

/** Kuryer telefonining push tokeni (FCM / APNs). MobileDevice (restoran) bilan ARALASHTIRILMAGAN. Token bitta akkauntda bo'ladi. */
const courierDeviceSchema = new Schema(
  {
    token: { type: String, required: true, unique: true, index: true },
    platform: { type: String, enum: ['android', 'ios'], required: true },
    environment: { type: String, enum: ['development', 'production'], default: null },
    courierId: { type: Schema.Types.ObjectId, ref: 'CourierAccount', required: true, index: true },
    appVersion: { type: String, default: '' },
    lastSeen: { type: Date, default: Date.now },
    failCount: { type: Number, default: 0 },
    lastError: { type: String, default: '' },
  },
  { timestamps: true },
);

export const CourierDevice = model('CourierDevice', courierDeviceSchema);
