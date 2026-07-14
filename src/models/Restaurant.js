import { Schema, model } from 'mongoose';

const restaurantSchema = new Schema(
  {
    name: { type: String, required: true },
    cuisine: { type: String, required: true },
    rating: { type: Number, default: 0 },
    reviewCount: { type: Number, default: 0 },
    deliveryMin: { type: Number, default: 20 },
    deliveryMax: { type: Number, default: 40 },
    deliveryFee: { type: Number, default: 0 },
    category: {
      type: String,
      // magazin qo'shildi
      enum: ['milliy', 'fastfood', 'sushi', 'kafe', 'shirinlik', 'magazin'],
      required: true,
    },
    // Muassasa turi: restoran / kafe / magazin
    kind: { type: String, enum: ['restaurant', 'cafe', 'shop'], default: 'restaurant' },

    tint: { type: String, default: '#FAEEDA' },
    icon: { type: String, default: 'ti-tools-kitchen-2' },
    discount: { type: Number },

    // Aloqa / manzil
    phone: { type: String },
    address: { type: String },

    isNew: { type: Boolean, default: false },
    isApproved: { type: Boolean, default: true }, // admin qo'shsa darhol faol
    // Restoran vaqtincha yopilgan/ochilgan (STOP butun muassasa uchun)
    isActive: { type: Boolean, default: true },

    ownerId: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

export const Restaurant = model('Restaurant', restaurantSchema);
