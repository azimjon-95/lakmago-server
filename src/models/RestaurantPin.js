import { Schema, model } from 'mongoose';

/*
 * ═══════════════════════════════════════════════════════════
 * "BARCHA RESTORANLAR" RO'YXATIDA PIN (1, 2, 3-O'RIN)
 * ═══════════════════════════════════════════════════════════
 *
 * Mijoz ilovasida restoranlar tasodifiy tartibda chiqadi. Admin ("Mijoz jalb
 * qilish") istalgan restoranni 1, 2 yoki 3-o'ringa VAQT ORALIG'I bilan pin
 * qiladi: [startsAt, endsAt). Qolganlari pastda tasodifiy bo'lib qoladi.
 *
 * • Muddat tugagach pin AVTOMATIK yo'qoladi: "faol" — so'rov vaqtida
 *   `startsAt <= hozir < endsAt` bilan aniqlanadi. Cron yoki tozalash YO'Q,
 *   shuning uchun server o'chiq turgan paytdagi muddat ham to'g'ri hisoblanadi.
 * • Oldindan belgilash mumkin (startsAt kelajakda): vaqti kelganda o'zi faol bo'ladi.
 * • Bir o'rin bir vaqtda BITTA restoranga (services/restaurantPins.js to'qnashuvni
 *   rad etadi). Bir restoran bir vaqtda faqat bitta o'rinda.
 * • Bekor qilish — `cancelledAt` (o'chirilmaydi): kim, qachon, qaysi muddatga pin
 *   qilgani tarixda qoladi (reklama xizmati — nazorat va hisob-kitob uchun).
 */
const schema = new Schema(
  {
    restaurantId: { type: Schema.Types.ObjectId, ref: 'Restaurant', required: true, index: true },
    position: { type: Number, enum: [1, 2, 3], required: true },
    startsAt: { type: Date, required: true },
    endsAt: { type: Date, required: true },
    cancelledAt: { type: Date, default: null },
    note: { type: String, default: '', maxlength: 200 },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    createdByName: { type: String, default: '' },
  },
  { timestamps: true },
);

// To'qnashuv tekshiruvi (o'rin + vaqt) va faol pinlarni yuklash
schema.index({ position: 1, startsAt: 1, endsAt: 1 });
schema.index({ cancelledAt: 1, endsAt: 1 });

export const RestaurantPin = model('RestaurantPin', schema);
