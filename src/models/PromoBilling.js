import { Schema, model } from 'mongoose';

/**
 * Mijozlarni jalb qilish xizmati — obuna va billing.
 *
 * Restoran aksiya yoki reklamani birinchi marta yoqganda
 * obuna boshlanadi. Har 24 soatda kunlik narx qo'shiladi.
 *
 * Bonus xizmat narxini oshirmaydi — TZ talabi.
 */
const promoSubscriptionSchema = new Schema(
  {
    restaurantId: {
      type: Schema.Types.ObjectId, ref: 'Restaurant',
      required: true, unique: true, index: true,
    },

    status: {
      type: String,
      enum: ['active', 'suspended', 'expired'],
      default: 'active',
      index: true,
    },

    // Billing boshlangan aniq vaqt — calendar day emas
    startedAt: { type: Date, required: true },
    // Oxirgi hisoblangan davr tugagan vaqt
    lastBilledAt: { type: Date, required: true },

    // Shu obuna uchun kunlik narx. Tarif o'zgarsa eski
    // yozuvlar qayta hisoblanmaydi — bu joriy narx.
    dailyPrice: { type: Number, required: true },

    // Super Admin to'xtatgan bo'lsa
    suspendedAt: { type: Date, default: null },
    suspendReason: { type: String, default: '' },
  },
  { timestamps: true },
);

export const PromoSubscription = model('PromoSubscription', promoSubscriptionSchema);

/**
 * Bitta billing davri — 24 soat.
 * Har davr alohida yozuv, shunda qarz aniq hisoblanadi.
 */
const promoBillingSchema = new Schema(
  {
    restaurantId: {
      type: Schema.Types.ObjectId, ref: 'Restaurant',
      required: true, index: true,
    },

    // Qaysi xizmat uchun: promo (mijoz jalb qilish) yoki dinein
    service: { type: String, enum: ['promo', 'dinein'], default: 'promo', index: true },
    note: { type: String, default: '' },

    periodStart: { type: Date, required: true },
    periodEnd: { type: Date, required: true },

    amount: { type: Number, required: true },

    status: {
      type: String,
      enum: ['unpaid', 'paid'],
      default: 'unpaid',
      index: true,
    },

    // To'lov ma'lumotlari
    paidAt: { type: Date, default: null },
    paidAmount: { type: Number, default: 0 },
    // Qanday to'landi: admin qo'lda yoki delivery tushumidan
    paidVia: {
      type: String,
      enum: ['manual', 'settlement', null],
      default: null,
    },
    confirmedBy: { type: Schema.Types.ObjectId, ref: 'Admin', default: null },

    // Ledger yozuvi bilan bog'lanish — ikki marta yechilmasin
    ledgerId: { type: Schema.Types.ObjectId, ref: 'Ledger', default: null },
  },
  { timestamps: true },
);

// Bir davr ikki marta yaratilmasin
promoBillingSchema.index({ restaurantId: 1, service: 1, periodStart: 1 }, { unique: true });
promoBillingSchema.index({ restaurantId: 1, status: 1 });

export const PromoBilling = model('PromoBilling', promoBillingSchema);

/**
 * Tarif o'zgarish tarixi.
 * Eski billing yozuvlari qayta hisoblanmaydi.
 */
const promoTariffLogSchema = new Schema(
  {
    oldPrice: { type: Number, required: true },
    newPrice: { type: Number, required: true },
    changedBy: { type: Schema.Types.ObjectId, ref: 'Admin' },
    changedByName: { type: String, default: '' },
  },
  { timestamps: true },
);

export const PromoTariffLog = model('PromoTariffLog', promoTariffLogSchema);
