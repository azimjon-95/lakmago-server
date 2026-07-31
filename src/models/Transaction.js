import { Schema, model } from 'mongoose';

/**
 * To'lov tranzaksiyasi — Payme va Click uchun umumiy.
 *
 * Har ikkala tizim webhook orqali ishlaydi: ular bizga so'rov
 * yuboradi, biz javob beramiz. Shuning uchun holatni o'zimiz
 * yuritamiz.
 */
const transactionSchema = new Schema(
  {
    // Qaysi tizim
    provider: {
      type: String,
      enum: ['payme', 'click'],
      required: true,
      index: true,
    },

    // Tizimdagi tranzaksiya ID (Payme: params.id, Click: click_trans_id)
    providerTransId: { type: String, required: true, index: true },

    // Bizning buyurtma
    orderId: { type: Schema.Types.ObjectId, ref: 'Order', required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', index: true },

    // Summa TIYINDA saqlanadi (Payme shunday ishlaydi).
    // Click so'mda yuboradi — qabul qilishda 100 ga ko'paytiramiz.
    amount: { type: Number, required: true },

    /**
     * Holat — Payme mantiqiga mos:
     *   1  — yaratilgan, to'lov kutilmoqda
     *   2  — to'langan
     *  -1  — yaratilgandan keyin bekor qilingan
     *  -2  — to'langandan keyin bekor qilingan (qaytarish)
     */
    state: { type: Number, default: 1, index: true },

    // Bekor qilish sababi (Payme kodlari)
    reason: { type: Number, default: null },

    // Vaqtlar — millisekundda (Payme shu formatni kutadi)
    createTime: { type: Number, default: () => Date.now() },
    performTime: { type: Number, default: 0 },
    cancelTime: { type: Number, default: 0 },

    // Click uchun qo'shimcha
    clickPrepareId: { type: Number, default: null },
    clickPaydocId: { type: String, default: '' },
  },
  { timestamps: true },
);

// Bir tizimda bitta ID takrorlanmasin
transactionSchema.index({ provider: 1, providerTransId: 1 }, { unique: true });

export const Transaction = model('Transaction', transactionSchema);
