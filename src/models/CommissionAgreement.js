import { Schema, model } from 'mongoose';

/**
 * Restoran bilan komissiya shartnomasi.
 *
 * Har restoran bilan ALOHIDA kelishuv bo'lishi mumkin:
 * 5%+5%, 0%+9%, 10%+0% va h.k. Shuning uchun foizlar
 * Restaurant hujjatida emas, alohida versiyalanadigan
 * shartnomada saqlanadi.
 *
 * Muddat bilan: shartnoma o'zgarsa eskisi yopiladi, yangisi
 * ochiladi. Eski buyurtmalar o'z snapshot'i bilan qoladi.
 */
const agreementSchema = new Schema(
  {
    restaurantId: { type: Schema.Types.ObjectId, ref: 'Restaurant', required: true, index: true },

    // Restoran to'laydigan komissiya (uning ulushidan chegiriladi)
    restaurantCommissionPercent: { type: Number, required: true, min: 0, max: 100 },
    // Mijozdan olinadigan xizmat haqi (taom narxi ustiga qo'shiladi)
    customerFeePercent: { type: Number, required: true, min: 0, max: 100 },

    /**
     * Shlyuzga yuboriladigan YAGONA foiz.
     *
     * Payme/Click'ga ikkita alohida 5% emas, bitta 10% ketadi —
     * aks holda ikki marta komissiya ushlanadi.
     */
    totalSplitPercent: { type: Number, required: true, min: 0, max: 100 },

    /**
     * Restoran ulushi NIMADAN hisoblanadi.
     *
     * CUSTOMER_FINAL_PRICE — mijoz to'lagan yakuniy summadan
     * DELIVERY_PRICE      — xizmat haqisiz, faqat taom narxidan
     *
     * ESKIRGAN MAYDON — endi ishlatilmaydi.
     *
     * Avval ikki xil hisoblash qoidasi bor edi va ular har xil
     * natija berardi (10 000 bazada 5%+5% — biri 11 000, ikkinchisi
     * 11 025 chiqarardi). Bu chalkashlikka olib keldi: mijoz
     * xizmat haqi restoran ustamasi USTIGA emas, BAZANING O'ZIDAN
     * hisoblanishi kerak edi. Endi formula YAGONA va qattiq
     * yozilgan (services/pricingEngine.js, services/customerPricing.js) —
     * bu maydon faqat eski yozuvlar bilan moslik uchun qoldirildi,
     * hisob-kitobga ta'sir qilmaydi.
     */
    billingBase: {
      type: String,
      enum: ['CUSTOMER_FINAL_PRICE', 'DELIVERY_PRICE', 'BASE_ADDITIVE'],
      default: 'BASE_ADDITIVE',
    },

    status: { type: String, enum: ['ACTIVE', 'ARCHIVED'], default: 'ACTIVE', index: true },
    effectiveFrom: { type: Date, required: true, default: Date.now },
    effectiveTo: { type: Date, default: null },

    note: { type: String, default: '' },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

agreementSchema.index({ restaurantId: 1, status: 1, effectiveFrom: -1 });

/** Ikki foiz yig'indisi totalSplitPercent ga teng bo'lishi shart. */
agreementSchema.pre('validate', function fillTotal(next) {
  const sum = Number(this.restaurantCommissionPercent) + Number(this.customerFeePercent);
  if (this.totalSplitPercent === undefined || this.totalSplitPercent === null) {
    this.totalSplitPercent = sum;
  } else if (Math.abs(this.totalSplitPercent - sum) > 0.001) {
    return next(new Error(
      `totalSplitPercent (${this.totalSplitPercent}) ikki foiz yig'indisiga (${sum}) teng emas`,
    ));
  }
  next();
});

/** Shu restoran uchun amaldagi shartnoma. Yo'q bo'lsa null. */
export async function activeAgreement(restaurantId, at = new Date()) {
  return CommissionAgreement.findOne({
    restaurantId,
    status: 'ACTIVE',
    effectiveFrom: { $lte: at },
    $or: [{ effectiveTo: null }, { effectiveTo: { $gt: at } }],
  }).sort({ effectiveFrom: -1 }).lean();
}

export const CommissionAgreement = model('CommissionAgreement', agreementSchema);
