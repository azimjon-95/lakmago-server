import { Schema, model } from 'mongoose';

/**
 * Bank o'tkazmasi — Click orqali kelgan pulni restoranga yuborish.
 *
 * Nega kerak: Click split qilmaydi, butun summa LokmaGo hisobiga
 * tushadi. Restoran ulushi qarz bo'lib qoladi va uni keyinchalik
 * bank orqali o'tkazish kerak.
 *
 * Bir necha to'lov bitta o'tkazmaga birlashtiriladi (har buyurtma
 * uchun alohida o'tkazma bank haqini oshiradi).
 */
const payoutSchema = new Schema(
  {
    restaurantId: { type: Schema.Types.ObjectId, ref: 'Restaurant', required: true, index: true },

    // Qaysi to'lovlar shu o'tkazmaga kirdi
    paymentIds: [{ type: Schema.Types.ObjectId, ref: 'Payment' }],

    amount: { type: Number, required: true },      // tiyin
    currency: { type: String, default: 'UZS' },

    status: {
      type: String,
      enum: ['PENDING', 'PROCESSING', 'SENT', 'CONFIRMED', 'FAILED', 'CANCELLED'],
      default: 'PENDING',
      index: true,
    },

    /**
     * Takroriylikdan himoya: bir kalit bilan ikkinchi marta
     * yuborilmaydi. Tarmoq uzilib javob kelmasa ham xavfsiz
     * qayta urinish mumkin.
     */
    idempotencyKey: { type: String, required: true, unique: true, index: true },

    bankProvider: { type: String, default: 'manual' },
    bankReference: { type: String, default: '' },   // bank hujjat raqami

    attempts: { type: Number, default: 0 },
    lastError: { type: String, default: '' },
    nextRetryAt: { type: Date, default: null, index: true },

    sentAt: { type: Date, default: null },
    confirmedAt: { type: Date, default: null },

    // Bank rekvizitlari nusxasi — keyin o'zgarsa ham tarix buzilmaydi
    snapshot: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true },
);

payoutSchema.index({ status: 1, nextRetryAt: 1 });

export const Payout = model('Payout', payoutSchema);
