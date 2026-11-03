import { Schema, model } from 'mongoose';

/** Kuryerning bir ish smenasi: «Ishni boshladim» → «Ishni yakunladim». Hisobotlar va ish vaqti shundan olinadi. */
const courierShiftSchema = new Schema(
  {
    accountId: { type: Schema.Types.ObjectId, ref: 'CourierAccount', required: true, index: true },
    startedAt: { type: Date, default: Date.now },
    endedAt: { type: Date, default: null },
    endReason: { type: String, enum: ['', 'courier', 'auto'], default: '' },
    deliveries: { type: Number, default: 0 },
    distanceM: { type: Number, default: 0 },
    /** Oxirgi ma'lum nuqta (Redis'dan tashqari bazada ham — Redis tozalansa ham smena tarixi saqlanadi). */
    lastLoc: { lat: Number, lng: Number, at: Date },
  },
  { timestamps: true },
);
courierShiftSchema.index({ accountId: 1, startedAt: -1 });

export const CourierShift = model('CourierShift', courierShiftSchema);
