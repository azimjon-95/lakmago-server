import { Schema, model } from 'mongoose';

/**
 * Sign in with Apple uchun BIR MARTALIK, MUDDATI CHEKLANGAN challenge.
 *
 * Oqim: ilova challenge so'raydi → server tasodifiy `nonce` beradi → ilova uni Apple'ga uzatadi (Apple uni identity
 * token ichiga `nonce` sifatida yozadi) → ilova token bilan challengeId'ni yuboradi → server challenge'ni ATOMIK
 * ravishda "ishlatilgan" qiladi (qayta ishlatib bo'lmaydi) va token ichidagi nonce bilan solishtiradi.
 * Shu tufayli o'g'irlangan/eski token boshqa challenge bilan (yoki ikkinchi marta) ishlamaydi (replay himoyasi).
 *
 * Ishlatilgan/eskirgan yozuvlar TTL indeks bilan o'zi o'chadi (expiresAt dan 10 daqiqa keyin).
 */
const schema = new Schema(
  {
    nonce: { type: String, required: true, unique: true },
    deviceId: { type: String, default: '' },
    platform: { type: String, required: true, enum: ['ios'] },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 600 });

export const AppleAuthChallenge = model('AppleAuthChallenge', schema);
