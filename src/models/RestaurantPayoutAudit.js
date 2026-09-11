import { Schema, model } from 'mongoose';

/*
 * ═══════════════════════════════════════════════════════════
 * TO'LOV REKVIZITI O'ZGARISHLARI AUDITI
 * ═══════════════════════════════════════════════════════════
 *
 * Bank yoki karta rekvizitlari o'zgartirilganda: kim, qachon,
 * qaysi qiymatdan qaysi qiymatga o'zgartirgani saqlanadi.
 *
 * NIMA UCHUN ALOHIDA KOLLEKSIYA (Restaurant ichiga emas):
 *   • yozuvlar HECH QACHON o'chirilmaydi va o'zgartirilmaydi —
 *     Restaurant hujjatining o'zi esa doim o'zgarib turadi
 *   • bitta restoranda ko'p marta o'zgarish bo'lishi mumkin,
 *     massiv sifatida saqlash hujjatni cheksiz kattalashtirardi
 *
 * MUHIM (TZ 13-band bilan bog'liq): bu audit "kim nima
 * o'zgartirdi" degan savolga javob beradi. "O'sha kuni qaysi
 * rekvizitga pul yuborilgan edi" degan savol esa BOSHQA joyda —
 * Payout hujjatining `destinationSnapshot` maydonida javob
 * topadi. Ikkisini aralashtirmaslik kerak: audit — kim
 * o'zgartirgani, snapshot — o'sha payt qanday bo'lgani.
 */
const restaurantPayoutAuditSchema = new Schema(
  {
    restaurantId: { type: Schema.Types.ObjectId, ref: 'Restaurant', required: true, index: true },

    // Kim o'zgartirdi
    changedBy: { type: Schema.Types.ObjectId, ref: 'Admin', default: null },
    changedByName: { type: String, default: '' }, // tez ko'rsatish uchun (populate shart emas)

    // Nima o'zgardi: 'method' | 'bank' | 'card' | 'status'
    field: { type: String, required: true },

    // Karta raqami kabi maxfiy qiymatlar bu yerda ham MASKALANGAN
    // holda saqlanadi — audit tarixi o'zi ham sizib chiqish
    // manbaiga aylanmasin.
    oldValue: { type: Schema.Types.Mixed, default: null },
    newValue: { type: Schema.Types.Mixed, default: null },

    // So'rov konteksti — kelajakda shubhali harakatni tekshirish uchun
    ip: { type: String, default: '' },
  },
  { timestamps: true },
);

restaurantPayoutAuditSchema.index({ restaurantId: 1, createdAt: -1 });

export const RestaurantPayoutAudit = model('RestaurantPayoutAudit', restaurantPayoutAuditSchema);
