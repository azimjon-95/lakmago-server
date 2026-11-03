import { Schema, model } from 'mongoose';
import bcrypt from 'bcryptjs';

/**
 * KURYER AKKAUNTI — BOSQICH 2 (login/parol bilan kiradigan ishchi kuryer, mobil ilovada «Kuryer» bo'limi).
 *
 * Bosqich 1 (havola orqali, ro'yxatsiz) O'ZGARMAGAN va yonma-yon ishlayveradi. Alohida kolleksiya: User / Courier / Restaurant
 * sxemalariga tegilmagan. Kuryer JWT'si BOSHQA maxfiy kalit bilan imzolanadi (config.courierJwtSecret) — shuning uchun u
 * mavjud `auth` middleware'idan o'tmaydi va mijoz / restoran / admin marshrutlarining birortasiga kira olmaydi.
 */
const courierAccountSchema = new Schema(
  {
    login: { type: String, required: true, unique: true, lowercase: true, trim: true, minlength: 3, maxlength: 40 },
    passwordHash: { type: String, required: true },
    name: { type: String, required: true, trim: true, maxlength: 60 },
    phone: { type: String, default: '', trim: true, maxlength: 20 },
    vehicle: { type: String, enum: ['', 'scooter', 'bike', 'car', 'foot'], default: '' },
    isActive: { type: Boolean, default: true },
    /** Hozir ochiq smena (CourierShift._id). Atomik «egallash» shu maydon orqali: ikki smena bir vaqtda ochilmaydi. */
    activeShiftId: { type: Schema.Types.ObjectId, ref: 'CourierShift', default: null },
    lastLoginAt: { type: Date, default: null },
  },
  { timestamps: true },
);

courierAccountSchema.methods.checkPassword = function (plain) {
  return bcrypt.compareSync(String(plain || ''), this.passwordHash);
};
courierAccountSchema.statics.hash = (plain) => bcrypt.hashSync(String(plain), 10);

export const CourierAccount = model('CourierAccount', courierAccountSchema);
