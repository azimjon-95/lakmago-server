import { Schema, model } from 'mongoose';

/**
 * Buyurtma narxining o'zgarmas nusxasi.
 *
 * NEGA KERAK: buyurtma yaratilgach restoran narxni yoki
 * shartnoma foizini o'zgartirishi mumkin. Agar hisob-kitob
 * har safar qaytadan qilinsa, eski buyurtmalar summasi
 * o'zgarib ketadi — moliyaviy hisobot va qaytarish buziladi.
 *
 * Shuning uchun bu yozuv BIR MARTA yoziladi va keyin
 * o'zgartirilmaydi. Qaytarish ham shu yozuvdan hisoblanadi.
 *
 * Barcha summalar TIYINDA (butun son).
 */
const snapshotSchema = new Schema(
  {
    orderId: { type: Schema.Types.ObjectId, ref: 'Order', required: true, unique: true, index: true },
    restaurantId: { type: Schema.Types.ObjectId, ref: 'Restaurant', required: true, index: true },

    // ── Narx zanjiri ──
    basePrice: { type: Number, required: true },            // restoran kiritgan
    deliveryMarkupPercent: { type: Number, default: 0 },    // restoran belgilagan ustama
    deliveryPrice: { type: Number, required: true },        // base + ustama
    customerFeePercent: { type: Number, default: 0 },
    customerFeeAmount: { type: Number, default: 0 },
    customerFinalPrice: { type: Number, required: true },   // mijoz to'laydigan

    // ── Bo'linish ──
    restaurantCommissionPercent: { type: Number, default: 0 },
    aggregatedSplitPercent: { type: Number, default: 0 },   // shlyuzga ketadigan yagona foiz
    billingBase: { type: String, default: 'CUSTOMER_FINAL_PRICE' },
    restaurantPayoutAmount: { type: Number, required: true },
    lokmaGrossRevenue: { type: Number, required: true },

    // ── Shlyuz ──
    gatewayEstimatedFee: { type: Number, default: 0 },
    gatewayActualFee: { type: Number, default: null },      // hisobot kelgach to'ldiriladi
    gatewayProvider: { type: String, default: '' },         // PAYNET | CLICK | PAYME
    gatewayTransactionId: { type: String, default: '' },

    // Qaysi shartnoma qo'llandi — tekshirish uchun
    agreementId: { type: Schema.Types.ObjectId, ref: 'CommissionAgreement' },

    // Buyurtma turi: dine-in va bronda ustama/haq qo'llanmaydi
    fulfillment: { type: String, default: 'delivery' },
  },
  { timestamps: true },
);

/**
 * O'zgarmaslik qo'riqchisi.
 *
 * gatewayActualFee va gatewayTransactionId dan tashqari hech
 * qaysi maydon o'zgartirilmaydi — ular to'lovdan KEYIN keladi
 * va hisob-kitobni o'zgartirmaydi.
 */
const MUTABLE = new Set(['gatewayActualFee', 'gatewayTransactionId', 'gatewayProvider', 'updatedAt']);

snapshotSchema.pre('save', function guard(next) {
  if (this.isNew) return next();
  const changed = this.modifiedPaths().filter((p) => !MUTABLE.has(p));
  if (changed.length) {
    return next(new Error(
      `Narx nusxasi o'zgarmas: ${changed.join(', ')} maydonini o'zgartirib bo'lmaydi`,
    ));
  }
  next();
});

export const OrderPricingSnapshot = model('OrderPricingSnapshot', snapshotSchema);
