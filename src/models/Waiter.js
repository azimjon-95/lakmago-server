import { Schema, model } from 'mongoose';

/**
 * Ofitsiant.
 *
 * Qurilmaga bog'lash (device binding) SERVERDA tekshiriladi —
 * localStorage bilan cheklanmaydi, chunki uni o'zgartirish oson.
 */
const waiterSchema = new Schema(
  {
    restaurantId: {
      type: Schema.Types.ObjectId, ref: 'Restaurant',
      required: true, index: true,
    },
    branchId: { type: Schema.Types.ObjectId, ref: 'Restaurant', index: true },

    firstName: { type: String, required: true, trim: true },
    lastName: { type: String, default: '', trim: true },
    phone: { type: String, default: '' },

    // Kirish
    login: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },

    isActive: { type: Boolean, default: true, index: true },

    // ===== QURILMAGA BOG'LASH =====
    // Birinchi kirishda qurilma bog'lanadi. Keyingi kirishlarda
    // server userId + deviceId + restaurantId ni tekshiradi.
    deviceId: { type: String, default: null, index: true },
    deviceBoundAt: { type: Date, default: null },
    deviceLabel: { type: String, default: '' },   // "iPhone · Safari"

    // Biriktirilgan stollar
    tableIds: [{ type: Schema.Types.ObjectId, ref: 'Table' }],

    // Ish grafigi — ixtiyoriy
    schedule: {
      days: [{ type: String, enum: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] }],
      from: { type: String, default: '' },   // "09:00"
      to: { type: String, default: '' },     // "18:00"
    },

    // Daromad — xizmat haqidan
    earnings: {
      total: { type: Number, default: 0 },
      orders: { type: Number, default: 0 },
      paidOut: { type: Number, default: 0 },
    },

    lastLoginAt: { type: Date, default: null },
  },
  { timestamps: true },
);

waiterSchema.index({ restaurantId: 1, isActive: 1 });

waiterSchema.methods.fullName = function () {
  return [this.firstName, this.lastName].filter(Boolean).join(' ');
};

export const Waiter = model('Waiter', waiterSchema);
