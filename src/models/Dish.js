import { Schema, model } from 'mongoose';

const optionSchema = new Schema(
  {
    name: { type: String, required: true },
    price: { type: Number, default: 0 }
  },
  { _id: true }
);

const optionGroupSchema = new Schema(
  {
    title: { type: String, required: true },
    required: { type: Boolean, default: false },
    multiple: { type: Boolean, default: false },
    options: [optionSchema]
  },
  { _id: true }
);

const dishSchema = new Schema(
  {
    restaurantId: { type: Schema.Types.ObjectId, ref: 'Restaurant', required: true, index: true },
    section: { type: String, required: true },
    name: { type: String, required: true },
    description: { type: String, default: '' },
    price: { type: Number, required: true },
    oldPrice: { type: Number },
    tint: { type: String, default: '#FAEEDA' },
    icon: { type: String, default: 'ti-bowl' },
    // Rasm (Cloudinary URL) — bo'lsa ikon o'rniga rasm ko'rsatiladi
    imageUrl: { type: String, default: '' },
    images: [{ type: String }],
    calories: { type: Number },
    weightGram: { type: Number },
    ingredients: [{ type: String }],
    optionGroups: [optionGroupSchema],
    isHit: { type: Boolean, default: false },
    isTrending: { type: Boolean, default: false },
    isDiscounted: { type: Boolean, default: false },
    isAvailable: { type: Boolean, default: true }
  },
  { timestamps: true }
);

// Index'lar — menyu va trend/chegirma so'rovlari tez ishlashi uchun
dishSchema.index({ restaurantId: 1, isAvailable: 1, section: 1 }); // restoran menyusi
dishSchema.index({ isTrending: 1, isAvailable: 1 });               // trend taomlar
dishSchema.index({ isDiscounted: 1, isAvailable: 1 });             // chegirmadagilar

export const Dish = model('Dish', dishSchema);
