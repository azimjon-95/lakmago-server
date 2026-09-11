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
        'waiter_payout',   // ofitsiantga xizmat haqi to'landi
      ],
    },

    // Summa (so'm). Musbat — kirim, manfiy — chiqim.
    amount: { type: Number, required: true },

    // Kim bilan bog'liq
    orderId: { type: Schema.Types.ObjectId, ref: 'Order', index: true },
    waiterId: { type: Schema.Types.ObjectId, ref: 'Waiter', default: null, index: true },
    restaurantId: { type: Schema.Types.ObjectId, ref: 'Restaurant', index: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', index: true },

    /*
     * To'lov tizimi (payment_in va refund uchun).
     *
     * ═══ TUZATILDI ═══ Ilgari faqat ['payme','click','cash',null]
     * bo'lgan — 'paynet' YO'Q edi. Order.paymentMethod da esa
     * 'paynet' (va 'uzum') allaqachon ruxsat etilgan qiymatlar.
     * Ya'ni Paynet orqali birinchi haqiqiy to'lov kelganda,
     * recordPayment() shu yerda Mongoose validatsiya xatosi bilan
     * QULAB TUSHARDI — pul kelib, lekin jurnalga yozib
     * bo'lmasdi. Endi Order modeli bilan bir xil to'liq ro'yxat.
     */
    provider: { type: String, enum: ['payme', 'click', 'paynet', 'uzum', 'cash', null], default: null },
    transactionId: { type: Schema.Types.ObjectId, ref: 'Transaction' },

    /*
     * Bu yozuv NAQD buyurtmaga tegishlimi.
     *
     * NIMA UCHUN QO'SHILDI: "Moliya" hisobotida (kunlik hisob-kitob)
     * bitta restoranning bir kunlik KOMISSIYASI ikkiga bo'linishi
     * kerak — elektron to'lovdan ushlab qolingan qism va naqd
     * uchun QARZ qilingan qism (ular teskari yo'nalishda: birinchisi
     * restoran ulushidan yechiladi, ikkinchisi qo'shimcha qarz
     * bo'lib yoziladi). `provider` bu farqni ko'rsatmaydi (masalan
     * `commission` yozuvida provider umuman yo'q). Shu bayroq
     * bo'lmasa, har safar Order hujjatini alohida so'rab, naqd
     * ekanini tekshirish kerak bo'lardi — sekin va keraksiz.
     */
    isCash: { type: Boolean, default: false, index: true },

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

/*
 * Kunlik hisob-kitob hisoboti uchun (Moliya moduli). Restoran +
 * kun oralig'i + turi bo'yicha tez guruhlash kerak bo'ladi —
 * "Kunlik hisob-kitob" sahifasi har ochilishida shu so'rovni
 * yuboradi, ko'p restoran bo'lganda sekin ishlamasligi kerak.
 */
ledgerSchema.index({ restaurantId: 1, createdAt: -1, type: 1, isCash: 1 });

export const Ledger = model('Ledger', ledgerSchema);
