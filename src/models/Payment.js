import { Schema, model } from 'mongoose';

/**
 * To'lov yozuvi — pul harakatining yagona haqiqat manbai.
 *
 * Transaction modelidan farqi: Transaction shlyuz protokoli
 * holatini yuritadi (Payme state 1/2/-1/-2), Payment esa
 * BIZNES holatini: kim qancha oldi, restoranga o'tkazildimi.
 *
 * Barcha summalar TIYINDA (butun son). Float ishlatilmaydi.
 */
const paymentSchema = new Schema(
  {
    orderId: { type: Schema.Types.ObjectId, ref: 'Order', required: true, index: true },
    restaurantId: { type: Schema.Types.ObjectId, ref: 'Restaurant', required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', index: true },

    provider: {
      type: String,
      enum: ['paynet', 'click', 'payme'],   // payme — eskirgan, eski yozuvlar uchun
      required: true,
      index: true,
    },
    // Shlyuzdagi tranzaksiya ID — takroriy webhookni aniqlash uchun
    providerTransactionId: { type: String, default: '', index: true },
    // Bizdagi Transaction hujjatiga havola
    transactionId: { type: Schema.Types.ObjectId, ref: 'Transaction' },

    amount: { type: Number, required: true },        // mijoz to'lagan, tiyin
    currency: { type: String, default: 'UZS' },

    status: {
      type: String,
      enum: ['PENDING', 'SUCCESS', 'FAILED', 'CANCELLED', 'REFUNDED'],
      default: 'PENDING',
      index: true,
    },

    // ── Bo'linish (paymentSplit.js hisoblaydi) ──
    providerFee: { type: Number, default: 0 },            // shlyuz ushlagan
    restaurantAmount: { type: Number, default: 0 },       // restoran ulushi
    lokmaGrossCommission: { type: Number, default: 0 },   // LokmaGo brutto
    lokmaNetCommission: { type: Number, default: 0 },     // shlyuz haqidan keyin
    lokmaPercentApplied: { type: Number, default: 0 },    // qaysi foiz qo'llandi

    /**
     * Restoranga pul yetkazish holati.
     *
     * Paynet: shlyuz o'zi bo'ladi → darhol SETTLED.
     * Click: LokmaGo hisobiga tushadi → bank orqali yuborilishi
     *        kerak, PENDING dan boshlanadi.
     */
    payoutStatus: {
      type: String,
      enum: ['NOT_REQUIRED', 'PENDING', 'PROCESSING', 'SETTLED', 'FAILED'],
      default: 'NOT_REQUIRED',
      index: true,
    },
    payoutReference: { type: String, default: '' },   // bank hujjat raqami
    payoutId: { type: Schema.Types.ObjectId, ref: 'Payout', index: true },

    /**
     * Takroriylikdan himoya. Bir buyurtma + bir provayder uchun
     * bitta to'lov yozuvi bo'ladi — webhook ikki marta kelsa ham.
     */
    idempotencyKey: { type: String, required: true, unique: true, index: true },

    // Bekor qilish / qaytarish
    refundReason: {
      type: String,
      enum: ['CUSTOMER_CANCELLED', 'RESTAURANT_CANCELLED',
             'RESTAURANT_REJECTED', 'PAYMENT_FAILED', null],
      default: null,
    },
    refundedAt: { type: Date, default: null },

    paidAt: { type: Date, default: null },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true },
);

// "Shu restoranning to'lanmagan ulushlari" — payout uchun asosiy so'rov
paymentSchema.index({ restaurantId: 1, payoutStatus: 1, status: 1 });

/** Bir buyurtma + provayder uchun barqaror kalit. */
export function buildIdempotencyKey(orderId, provider, providerTransactionId = '') {
  return `${provider}:${orderId}:${providerTransactionId || 'init'}`;
}

export const Payment = model('Payment', paymentSchema);
