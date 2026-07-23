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
      // O'zbekiston sharoiti: choyxona, osh, shashlik, klub, magazin turlari va h.k.
      enum: [
        'milliy', 'choyxona', 'osh', 'shashlik', 'fastfood', 'lavash', 'burger',
        'sushi', 'pitsa', 'kafe', 'shirinlik', 'restoran', 'klub', 'bar',
        'magazin_oziq', 'magazin_meva', 'salqin',
        // eski qiymatlar mosligi uchun
        'magazin',
      ],
      required: true,
    },
    // Muassasa turi: restoran / choyxona / kafe / fastfood / tungi klub / magazin
    kind: {
      type: String,
      enum: ['restaurant', 'choyxona', 'cafe', 'fastfood', 'club', 'shop'],
      default: 'restaurant',
    },

    tint: { type: String, default: '#FAEEDA' },
    icon: { type: String, default: 'ti-tools-kitchen-2' },
    // Restoran rasmi (Cloudinary) — karta va sahifa bannerida ko'rinadi
    imageUrl: { type: String, default: '' },
    images: [{ type: String }],
    discount: { type: Number },

    // Aloqa / manzil
    phone: { type: String },
    address: { type: String },
    // Xaritadagi joylashuv — kuryer va mijoz uchun
    lat: { type: Number },
    lng: { type: Number },
    // Mo'ljal (masalan "Metro yonida, 2-qavat")
    landmark: { type: String, default: '' },

    // ===== ISH TARTIBI (restoran sahifasida "Xabar" oynasida ko'rinadi) =====
    // Ochilish/yopilish vaqti — "07:00" formatida
    openTime: { type: String, default: '09:00' },
    closeTime: { type: String, default: '23:00' },
    // Yuridik ma'lumot (Uzum'dagi kabi: MCHJ nomi, manzil, INN)
    legalName: { type: String, default: '' },
    legalAddress: { type: String, default: '' },
    inn: { type: String, default: '' },

    // ===== XIZMAT HAQI VA BUYURTMA SHARTLARI =====
    // Minimal buyurtma summasi (so'mda)
    minOrderAmount: { type: Number, default: 0 },
    // Xizmat haqi: buyurtma summasining foizi
    serviceFeePercent: { type: Number, default: 0 },
    // Xizmat haqi chegaralari (foizdan hisoblanganda)
    serviceFeeMin: { type: Number, default: 0 },
    serviceFeeMax: { type: Number, default: 0 },

    // ===== OLIB KETISH (pickup) =====
    // Muassasa o'zi olib ketishni qabul qiladimi
    pickupEnabled: { type: Boolean, default: true },
    // Olib ketishda chegirma (foizda) — mijozni rag'batlantirish
    pickupDiscountPercent: { type: Number, default: 0 },
    // Tayyorlash vaqti (daqiqa) — olib ketish uchun "nechida tayyor" hisobi
    prepMinutes: { type: Number, default: 20 },

    // ===== DO'KON YO'NALISHLARI =====
    // Faqat kind='shop' bo'lganda ishlatiladi.
    // LokmaGo — ovqat platformasi, shuning uchun faqat oziq-ovqat yo'nalishlari.
    shopTypes: [{
      type: String,
      enum: ['oziq_ovqat', 'meva_sabzavot', 'nonvoyxona', 'shirinlik',
             'ichimlik', 'gosht', 'sut', 'quruq_meva', 'salqin'],
    }],

    // ===== STOL BRON QILISH (bizning ustunligimiz) =====
    // Restoran stol bron qilishni qabul qiladimi
    reservationEnabled: { type: Boolean, default: false },
    // Bron uchun qo'shimcha izoh (masalan "Kamida 2 soat oldin")
    reservationNote: { type: String, default: '' },

    isFresh: { type: Boolean, default: false }, // "Yangi" belgisi (isNew Mongoose zaxirasi)
    isApproved: { type: Boolean, default: true }, // admin qo'shsa darhol faol
    // Restoran vaqtincha yopilgan/ochilgan (STOP butun muassasa uchun — restoran o'zi)
    isActive: { type: Boolean, default: true },
    // Admin tomonidan BLOKLANGAN — bloklansa mijozга umuman ko'rinmaydi (taomlari bilan)
    isBlocked: { type: Boolean, default: false },

    ownerId: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

// Index'lar — katalog filtri va qidiruv tez ishlashi uchun
// Mijozga ko'rinadigan ro'yxat: isApproved + isActive + isBlocked + category
restaurantSchema.index({ isApproved: 1, isActive: 1, isBlocked: 1, category: 1 });
restaurantSchema.index({ isApproved: 1, isActive: 1, isBlocked: 1, createdAt: -1 }); // cursor pagination
restaurantSchema.index({ name: 'text', cuisine: 'text' }); // matn qidiruvi

export const Restaurant = model('Restaurant', restaurantSchema);
