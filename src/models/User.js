import { Schema, model } from 'mongoose';
import bcrypt from 'bcryptjs';

const userSchema = new Schema(
  {
    // --- Telegram mijozlari uchun (webapp) ---
    telegramId: { type: String, unique: true, sparse: true, index: true },
    firstName: { type: String },
    lastName: { type: String },
    username: { type: String },
    languageCode: { type: String },
    isPremium: { type: Boolean, default: false },
    photoUrl: { type: String },

    // --- Panel foydalanuvchilari uchun (admin / restoran) — login/parol ---
    login: { type: String, unique: true, sparse: true, index: true, lowercase: true, trim: true },
    passwordHash: { type: String },

    lastLoginAt: { type: Date },
    phone: { type: String },

    // Rol: customer (mijoz), restaurant (restoran egasi), admin (dastur egasi)
    role: { type: String, enum: ['customer', 'restaurant', 'admin'], default: 'customer' },

    // Restoran foydalanuvchisi qaysi restoranga tegishli
    restaurantId: { type: Schema.Types.ObjectId, ref: 'Restaurant' },

    // Akkaunt faolmi (admin bloklashi mumkin)
    isActive: { type: Boolean, default: true },

    favorites: [{ type: Schema.Types.ObjectId, ref: 'Restaurant' }],
    addresses: [
      { title: String, address: String, lat: Number, lng: Number },
    ],
    defaultAddressId: { type: Schema.Types.ObjectId },
  },
  { timestamps: true },
);

// Parolni tekshirish
userSchema.methods.checkPassword = function (plain) {
  if (!this.passwordHash) return false;
  return bcrypt.compareSync(plain, this.passwordHash);
};

// Parolni hash qilish (statik yordamchi)
userSchema.statics.hashPassword = function (plain) {
  return bcrypt.hashSync(plain, 10);
};

// JSON'da parol hash'ini yashirish
userSchema.set('toJSON', {
  transform(_doc, ret) {
    delete ret.passwordHash;
    return ret;
  },
});

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
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);

export const Banner = model('Banner', bannerSchema);
