import { Schema, model } from 'mongoose';

/**
 * Kirim-chiqim yozuvi — LokmaGo'ning o'z operatsion xarajatlari.
 *
 * Bu RESTORAN to'lovlaridan (Payment/Payout) MUSTAQIL — bu yerda
 * platformaning o'zi to'laydigan narsalar qayd etiladi: server,
 * soliq, domen, bank komissiyasi, yo'l xarajati va h.k.
 *
 * Barcha summalar TIYINDA (butun son), boshqa moliyaviy
 * modellar bilan bir xil qoida.
 */
const expenseSchema = new Schema(
  {
    category: {
      type: String,
      enum: [
        'server',           // server/hosting xarajati
        'tax',              // soliq (umumiy)
        'income_tax',       // daromad solig'i
        'domain',           // domen/SSL
        'bank_fee',         // bank komissiyalari
        'fuel',             // yo'lkira/transport
        'salary',           // ish haqi
        'marketing',        // reklama
        'other',            // boshqa
      ],
      required: true,
      index: true,
    },
    amount: { type: Number, required: true },   // tiyin
    currency: { type: String, default: 'UZS' },

    title: { type: String, required: true, maxlength: 200 },
    note: { type: String, default: '', maxlength: 500 },

    // Qaysi sana uchun (masalan oylik xarajat — shu oyning 1-sanasi)
    date: { type: Date, required: true, default: Date.now, index: true },

    // Takrorlanuvchi xarajatmi (server, domen — har oy)
    recurring: { type: Boolean, default: false },

    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

expenseSchema.index({ date: -1, category: 1 });

export const Expense = model('Expense', expenseSchema);
