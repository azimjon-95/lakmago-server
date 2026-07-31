import { Schema, model } from 'mongoose';

/**
 * Moliyaviy jurnal — har bir pul harakati yoziladi.
 *
 * Prinsip: yozuvlar HECH QACHON o'chirilmaydi va o'zgartirilmaydi.
 * Xato bo'lsa teskari yozuv qo'shiladi. Bu buxgalteriya standarti —
 * shunda "qayerdan keldi, qayerga ketdi" har doim aniq.
 */
const ledgerSchema = new Schema(
  {
    // Harakat turi
    type: {
      type: String,
      required: true,
      index: true,
      enum: [
        'payment_in',      // mijoz to'ladi → platforma hisobiga
        'commission',      // platforma komissiyasi
        'restaurant_due',  // restoranga qarz yozildi
        'payout',          // restoranga to'landi
        'refund',          // mijozga qaytarildi
        'adjustment',      // qo'lda tuzatish (admin)
      ],
    },

    // Summa (so'm). Musbat — kirim, manfiy — chiqim.
    amount: { type: Number, required: true },

    // Kim bilan bog'liq
    orderId: { type: Schema.Types.ObjectId, ref: 'Order', index: true },
    restaurantId: { type: Schema.Types.ObjectId, ref: 'Restaurant', index: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', index: true },

    // To'lov tizimi (payment_in va refund uchun)
    provider: { type: String, enum: ['payme', 'click', 'cash', null], default: null },
    transactionId: { type: Schema.Types.ObjectId, ref: 'Transaction' },

    // Hisob-kitob tafsiloti — keyin tekshirish uchun saqlanadi
    meta: {
      orderTotal: Number,        // buyurtma summasi
      commissionPercent: Number, // qo'llanilgan foiz
      commissionMode: String,    // markup | deduct
      note: String,
    },

    // Kim yaratdi (admin qo'lda qilsa)
    createdBy: { type: Schema.Types.ObjectId, ref: 'Admin', default: null },
  },
  { timestamps: true },
);

// Hisobotlar uchun
ledgerSchema.index({ createdAt: -1 });
ledgerSchema.index({ restaurantId: 1, type: 1, createdAt: -1 });

export const Ledger = model('Ledger', ledgerSchema);
