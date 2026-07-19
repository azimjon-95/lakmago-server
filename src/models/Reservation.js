import { Schema, model } from 'mongoose';

const reservationSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    restaurantId: { type: Schema.Types.ObjectId, ref: 'Restaurant', required: true, index: true },
    restaurantName: { type: String, required: true },
    date: { type: String, required: true }, // YYYY-MM-DD
    time: { type: String, required: true }, // HH:mm
    guests: { type: Number, required: true, min: 1 },
    name: { type: String, required: true },
    phone: { type: String, required: true },
    note: { type: String },
    status: {
      type: String,
      // pending — kutilmoqda, confirmed — restoran tasdiqladi,
      // rejected — restoran rad etdi, cancelled — mijoz bekor qildi,
      // coming — mijoz "boramiz" dedi, not_coming — "bora olmaymiz",
      // on_way — "yo'ldamiz", arrived — "keldik", completed — yakunlandi
      enum: ['pending', 'confirmed', 'rejected', 'cancelled',
             'coming', 'not_coming', 'on_way', 'arrived', 'completed'],
      default: 'pending',
      index: true
    },

    // Bron sanasi va vaqti — bitta Date sifatida (eslatmalar uchun)
    scheduledAt: { type: Date, index: true },

    // Restoran rad etish sababi
    rejectReason: { type: String, default: '' },

    // ===== ESLATMALAR (bot orqali) =====
    // Har biri bir marta yuboriladi — takror yuborilmasligi uchun belgilanadi
    reminders: {
      h90: { sent: { type: Boolean, default: false }, sentAt: Date },  // 1.5 soat
      h60: { sent: { type: Boolean, default: false }, sentAt: Date },  // 1 soat
      m30: { sent: { type: Boolean, default: false }, sentAt: Date },  // 30 daqiqa
      arrival: { sent: { type: Boolean, default: false }, sentAt: Date }, // vaqt keldi
    },

    // Mijoz javobi tarixi (kim qachon nima bosdi)
    responses: [{
      action: String,      // 'coming' | 'not_coming' | 'on_way' | 'arrived'
      at: { type: Date, default: Date.now },
    }],
  },
  { timestamps: true }
);


export const Reservation = model('Reservation', reservationSchema);
