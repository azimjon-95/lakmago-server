import { Schema, model } from 'mongoose';

/*
 * ═══════════════════════════════════════════════════════════
 * RESTORAN KARTASINING TO'LIQ RAQAMI (shifrlangan)
 * ═══════════════════════════════════════════════════════════
 *
 * NIMA UCHUN: buxgalter restoranga pulni kartaga o'tkazadi —
 * faqat oxirgi 4 xonani bilib bu mumkin emas edi. To'liq
 * raqam kerak.
 *
 * NIMA UCHUN ALOHIDA KOLLEKSIYA (Restaurant ichida emas):
 * Restaurant hujjati ko'p joyda o'qiladi — restoran paneli,
 * admin ro'yxatlari, hisobotlar. Shifrlangan qiymat o'sha
 * hujjat ichida tursa, biror so'rov unga `select` qo'yishni
 * unutgan zahoti sizib chiqishi mumkin. Alohida kolleksiyaga
 * esa FAQAT shu yerni ochib o'qigan kod (restaurantPayout.reveal)
 * tegadi — "tasodifan qaytarib yuborish" imkoni yo'q.
 * (RestaurantPaymentAccount bilan bir xil tamoyil.)
 *
 * Qiymat AES-256-GCM bilan shifrlanadi (lib/secrets.js).
 * CVV va amal qilish muddati UMUMAN saqlanmaydi — bu karta
 * pul QABUL QILISH uchun (o'tkazma), undan pul yechib bo'lmaydi.
 */
const schema = new Schema(
  {
    restaurantId: { type: Schema.Types.ObjectId, ref: 'Restaurant', required: true, unique: true },
    cardNumberEnc: { type: String, default: '' },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

export const RestaurantPayoutSecret = model('RestaurantPayoutSecret', schema);
