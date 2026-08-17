import { Schema, model } from 'mongoose';
import bcrypt from 'bcryptjs';

/**
 * LokmaGo XODIMI — restoran va mijoz foydalanuvchilaridan (User)
 * ATAYLAB ALOHIDA sxema.
 *
 * NEGA ALOHIDA: User modeli mijoz (Telegram) va restoran
 * egalarini aralashtirib saqlaydi — xodimlar butunlay boshqa
 * tabiat (ichki jamoa, bo'lim, huquqlar darajasi). Aralashtirish
 * xavfsizlik va tushunarlilik nuqtai nazaridan xato bo'lardi.
 *
 * LEKIN bitta login panelidan kiradi (admin.lakmago.uz) — buni
 * panelAuth.js ta'minlaydi: login/parol User'da topilmasa,
 * StaffUser'da qidiradi.
 */
export const DEPARTMENTS = [
  'admin',            // to'liq huquq — xodim yollaydi, hammasini ko'radi
  'accountant',        // buxgalter — Moliya to'liq
  'developer',          // dasturchi
  'restaurant_ops',    // dostavka/restoranlar bilan ishlash
  'order_control',      // buyurtmalarni nazorat qilish
  'dinein_control',     // Dine-in nazorat/boshqaruv
  'marketing',          // reklama, bonuslar, mijoz jalb qilish
  'sysadmin',           // tizim administratori
];

const staffSchema = new Schema(
  {
    login: { type: String, required: true, unique: true, index: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },

    fullName: { type: String, required: true },
    phone: { type: String, default: '' },

    department: { type: String, enum: DEPARTMENTS, required: true, index: true },

    isActive: { type: Boolean, default: true },

    hiredAt: { type: Date, default: Date.now },
    // Qaysi admin yollagan — javobgarlik izi uchun
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },

    lastLoginAt: { type: Date, default: null },

    note: { type: String, default: '', maxlength: 500 },
  },
  { timestamps: true },
);

staffSchema.methods.checkPassword = function (plain) {
  if (!this.passwordHash) return false;
  return bcrypt.compareSync(plain, this.passwordHash);
};

// Parolni hash qilish (statik yordamchi) — User.js bilan bir xil naqsh
staffSchema.statics.hashPassword = function (plain) {
  return bcrypt.hashSync(plain, 10);
};

// JSON'da parol hash'ini yashirish
staffSchema.set('toJSON', {
  transform(_doc, ret) {
    delete ret.passwordHash;
    return ret;
  },
});

export const StaffUser = model('StaffUser', staffSchema);
