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
    // Telefon SMS/qo'ng'iroq orqali tasdiqlanganmi (hozircha
    // ishlatilmaydi — Auth fundamenti uchun tayyorlab qo'yilgan,
    // kelajakda "phone" auth-provayderi qo'shilganda kerak bo'ladi)
    phoneVerified: { type: Boolean, default: false },

    /*
     * status — YANGI, ACTIVE|BLOCKED|DELETED. Mavjud `isActive`
     * (pastda) bilan BIR TOMONLAMA sinxron: status o'zgarsa
     * isActive ham avtomatik yangilanadi (pre-save hook, pastda).
     * Aksincha EMAS — isActive'ni to'g'ridan-to'g'ri o'zgartiradigan
     * eski kod yo'q (tekshirildi), shuning uchun bu xavfsiz.
     * Ikkalasini saqlash sababi: isActive allaqachon admin
     * ro'yxatida filtr sifatida ishlatiladi (controllers/admin.js),
     * uni olib tashlash keraksiz risk.
     */
    status: { type: String, enum: ['ACTIVE', 'BLOCKED', 'DELETED'], default: 'ACTIVE', index: true },

    // Rol: customer (mijoz), restaurant (restoran egasi), admin (dastur egasi)
    role: { type: String, enum: ['customer', 'restaurant', 'admin'], default: 'customer' },

    // Restoran foydalanuvchisi qaysi restoranga tegishli
    restaurantId: { type: Schema.Types.ObjectId, ref: 'Restaurant' },

    // Akkaunt faolmi (admin bloklashi mumkin)
    isActive: { type: Boolean, default: true },

    favorites: [{ type: Schema.Types.ObjectId, ref: 'Restaurant' }],
    // Manzillar — kuryer topishi uchun to'liq ma'lumot
    addresses: [{
      title: String,          // "Uy", "Ish", "Boshqa"
      address: String,        // to'liq matn (ko'cha, uy)
      street: String,         // ko'cha nomi
      city: String,           // shahar
      entrance: String,       // kirish (podyezd)
      floor: String,          // qavat
      flat: String,           // xonadon
      note: String,           // mo'ljal, domofon kodi
      labelId: String,        // 'home' | 'work' | 'other'
      lat: Number,
      lng: Number,
    }],
    defaultAddressId: { type: Schema.Types.ObjectId },

    // ===== TO'LOV KARTALARI =====
    // Xavfsizlik: to'liq raqam SAQLANMAYDI — faqat oxirgi 4 raqam
    // va turi. Haqiqiy to'lov Payme/Click orqali amalga oshiriladi.
    cards: [{
      last4: { type: String, required: true },      // 1234
      brand: { type: String, default: 'card' },     // uzcard | humo | visa | mastercard
      // Bank nomi — mijoz kartalarni adashtirmasligi uchun
      bankName: { type: String, default: '' },
      holder: { type: String, default: '' },        // karta egasi (ixtiyoriy)
      expiry: { type: String, default: '' },        // MM/YY
      isDefault: { type: Boolean, default: false },
      addedAt: { type: Date, default: Date.now },

      /*
       * CLICK TOKENI — shu karta bilan pul yechish uchun.
       *
       * Karta RAQAMI hech qachon saqlanmaydi (faqat last4).
       * Token esa raqamning o'rnini bosadi: u faqat BIZNING
       * service_id bilan ishlaydi va o'g'irlansa ham boshqa
       * joyda foydasi yo'q.
       *
       * verified: SMS bilan tasdiqlanganmi. Tasdiqlanmagan
       * token bilan Click pul yechishga ruxsat bermaydi,
       * shuning uchun bunday karta ro'yxatda "tasdiqlanmagan"
       * bo'lib turadi va to'lovda tanlab bo'lmaydi.
       */
      clickToken: { type: String, default: '', select: false },
      verified: { type: Boolean, default: false },

      // Tokenni so'ragan vaqt — tasdiqlanmagan kartalarni
      // tozalash uchun
      tokenRequestedAt: { type: Date, default: null },
    }],

    // ===== REFERRAL TIZIMI =====
    // Bu foydalanuvchini kim taklif qilgan (referrer userId)
    referredBy: { type: Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    // Nechta odam taklif qilgan (muvaffaqiyatli — kanalга obuna bo'lgan)
    referralCount: { type: Number, default: 0 },
    // Bonus balans (so'mда) — buyurtmада ishlatiladi
    bonusBalance: { type: Number, default: 0 },
    // Referal orqali kelib, hali bonusи berilmagan (obunani kutayapti) — takroriy bonusning oldини oladi
    referralRewarded: { type: Boolean, default: false },
    // Asosiy kanал/guruhга obuna bo'lganmi (webapp ochilishi uchun shart)
    isSubscribed: { type: Boolean, default: false },
    subscribedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

/*
 * avatarUrl — Auth fundamenti spetsifikatsiyasidagi nom. Alohida
 * maydon sifatida SAQLAMAYMIZ (ikki manba = asinxron bo'lib qolish
 * xavfi) — buning o'rniga mavjud photoUrl'ga ishora qiluvchi
 * VIRTUAL. Yangi kod user.avatarUrl deb o'qishi mumkin, eski kod
 * esa user.photoUrl bilan davom etaveradi — ikkalasi ham bir xil
 * qiymatni ko'radi.
 */
userSchema.virtual('avatarUrl').get(function () { return this.photoUrl; });

// status o'zgarsa isActive avtomatik sinxronlanadi (bir tomonlama
// — pastga qarang, User.js boshidagi izohga)
userSchema.pre('save', function (next) {
  if (this.isModified('status')) {
    this.isActive = this.status === 'ACTIVE';
  }
  next();
});

// Parolni tekshirish
userSchema.methods.checkPassword = function (plain) {
  if (!this.passwordHash) return false;
  return bcrypt.compareSync(plain, this.passwordHash);
};

// Parolni hash qilish (statik yordamchi)
userSchema.statics.hashPassword = function (plain) {
  return bcrypt.hashSync(plain, 10);
};

// JSON'da parol hash'ini yashirish, virtual maydonlarni qo'shish
userSchema.set('toJSON', {
  virtuals: true,
  transform(_doc, ret) {
    delete ret.passwordHash;
    return ret;
  },
});

export const User = model('User', userSchema);

const bannerSchema = new Schema(
  {
    // Matnlar — IXTIYORIY. Faqat tugma yoqilganda ishlatiladi.
    eyebrow: { type: String, default: '' },
    title: { type: String, default: '' },
    cta: { type: String, default: 'Ko‘rish' },
    // Tugma yoqilganmi va qayerga olib boradi
    hasButton: { type: Boolean, default: false },
    linkUrl: { type: String, default: '' },
    bg: { type: String, default: '#411E00' },
    accentText: { type: String, default: '#FAC775' },
    ctaBg: { type: String, default: '#EF9F27' },
    ctaText: { type: String, default: '#2C1400' },
    icon: { type: String, default: 'ti-gift' },

    // Banner rasmi (URL). Bo'lsa rang o'rniga rasm ko'rsatiladi.
    imageUrl: { type: String, default: '' },

    // Banner egaligi:
    //   platform  → sayt egasi (admin) qo'shган umumiy reklama
    //   restaurant→ restoran o'zi qo'shган banner (restaurantId to'ldiriladi)
    kind: { type: String, enum: ['platform', 'restaurant'], default: 'platform' },
    restaurantId: { type: Schema.Types.ObjectId, ref: 'Restaurant' },

    order: { type: Number, default: 0 },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);

export const Banner = model('Banner', bannerSchema);
