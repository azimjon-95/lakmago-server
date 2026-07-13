import { Schema, model } from 'mongoose';

const userSchema = new Schema(
  {
    telegramId: { type: String, required: true, unique: true, index: true },
    firstName: { type: String },
    lastName: { type: String },
    username: { type: String },
    languageCode: { type: String },
    isPremium: { type: Boolean, default: false },
    photoUrl: { type: String },
    lastLoginAt: { type: Date },
    phone: { type: String },
    role: { type: String, enum: ['customer', 'restaurant', 'admin'], default: 'customer' },
    favorites: [{ type: Schema.Types.ObjectId, ref: 'Restaurant' }],
    addresses: [
    {
      title: String,
      address: String,
      lat: Number,
      lng: Number
    }],

    defaultAddressId: { type: Schema.Types.ObjectId }
  },
  { timestamps: true } // createdAt, updatedAt avtomatik
);


export const User = model('User', userSchema);

const bannerSchema = new Schema(
  {
    eyebrow: { type: String, required: true },
    title: { type: String, required: true },
    cta: { type: String, default: 'Ko‘rish' },
    bg: { type: String, default: '#411E00' },
    accentText: { type: String, default: '#FAC775' },
    ctaBg: { type: String, default: '#EF9F27' },
    ctaText: { type: String, default: '#2C1400' },
    icon: { type: String, default: 'ti-gift' },
    order: { type: Number, default: 0 },
    active: { type: Boolean, default: true }
  },
  { timestamps: true }
);

export const Banner = model('Banner', bannerSchema);
