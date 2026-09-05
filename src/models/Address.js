import { Schema, model } from 'mongoose';

/**
 * Address — alohida kolleksiya (Auth fundamenti, 2-bosqich talabi).
 *
 * MUHIM: User.addresses (embedded array, models/User.js) HAM HALI
 * MAVJUD va BUZILMAGAN — hozirgi client (lakmago-client) shu orqali
 * ishlaydi (controllers/address.js, /api/addresses). Bu YANGI model
 * PARALLEL FUNDAMENT sifatida qo'shildi (talabnomada aniq so'ralgan
 * maydonlar bilan: latitude/longitude, apartment, comment), lekin
 * client hali ko'chirilmagan — shuning uchun ikkalasi bir muncha
 * vaqt yonma-yon turadi. Keyingi bosqichda client shu yangi
 * /users/me/addresses API'ga o'tkazilganda, eski /addresses va
 * User.addresses deprecated qilinishi mumkin.
 */
const addressSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    title: { type: String, default: 'Manzil' },
    address: { type: String, required: true },

    latitude: { type: Number },
    longitude: { type: Number },

    entrance: { type: String, default: '' },
    apartment: { type: String, default: '' },
    floor: { type: String, default: '' },
    comment: { type: String, default: '' },

    isDefault: { type: Boolean, default: false },
  },
  { timestamps: true },
);

addressSchema.index({ userId: 1, isDefault: 1 });

export const Address = model('Address', addressSchema);
