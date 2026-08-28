import { Schema, model } from 'mongoose';
import { cacheInvalidationPlugin } from './cacheInvalidation.js';

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

    // Tayyorlanish vaqti (daqiqa) — mijozga "nechida tayyor" hisobida ishlatiladi
    prepMinutes: { type: Number, default: 15, min: 1, max: 240 },

    // Taom kategoriyasi — barcha muassasalarga umumiy (Yandex Eda uslubi).
    // Mijoz shu bo'yicha qidiradi va filtrlaydi.
    category: {
      type: String,
      enum: [
        // Mijoz ilovasidagi kategoriyalar bilan bir xil
        'milliy', 'osh', 'shashlik', 'sup', 'salat', 'choyxona',
        'zavtroki', 'obed',
        'fastfood', 'lavash', 'burger', 'tovuq', 'pitsa',
        'sushi', 'evropa', 'turetskaya',
        'koffe', 'shirinlik', 'salqin', 'magazin_oziq',
        // eski qiymatlar mosligi uchun
        'issiq', 'shorva', 'salat', 'sovuq', 'grill', 'garnir',
        'nonushta', 'nonvoyxona', 'ichimlik', 'alkogol', 'boshqa',
      ],
      default: 'milliy',
      index: true,
    },
    tint: { type: String, default: '#FAEEDA' },
    icon: { type: String, default: 'ti-bowl' },
    // Rasm (Cloudinary URL) — bo'lsa ikon o'rniga rasm ko'rsatiladi
    imageUrl: { type: String, default: '' },
    images: [{ type: String }],
    // Umumiy katalogdan olingan bo'lsa — manba mahsulot.
    // Restoran o'zi yaratgan bo'lsa null.
    catalogProductId: { type: Schema.Types.ObjectId, ref: 'CatalogProduct', default: null, index: true },

    // ===== DINE-IN NARXI =====
    // SYNC   — delivery narxidan foydalanadi
    // CUSTOM — zal uchun alohida narx
    priceMode: { type: String, enum: ['sync', 'custom'], default: 'sync' },
    dineInPrice: { type: Number, default: null },

    /*
     * ICHIMLIK TURI — faqat category === 'salqin' bo'lganda.
     *
     * Nega alohida maydon, nega asosiy kategoriyaga qo'shilmadi:
     * mijoz bosh sahifada "Ichimlik" ni tanlaydi va HAMMA
     * ichimlikni ko'rishi kerak. Agar "Choy", "Sok", "Gazli"
     * alohida asosiy kategoriya bo'lsa, bosh sahifa 20 ta
     * kategoriyadan 30 taga chiqib ketardi va mijoz sokni
     * qidirib topa olmasdi.
     *
     * Shuning uchun ichimlik ICHIDA guruhlash — menyuda
     * sarlavha bo'lib chiqadi, bosh sahifada esa bittaligicha
     * qoladi.
     */
    drinkType: { type: String, default: '' },

    // ===== QO'SHIMCHA MA'LUMOT (barchasi ixtiyoriy) =====
    // Hajm: "0.5 l", "1 l", "330 ml"
    // Ichimlik uchun og'irlik o'rniga SHU ishlatiladi
    volume: { type: String, default: '' },

    // Og'irlik matn sifatida — "150 г" yoki "150/30/30/20 г"
    // (assortida bir necha qism bo'ladi)
    weight: { type: String, default: '' },
    // Eski maydon — moslik uchun saqlanadi
    weightGram: { type: Number },

    calories: { type: Number },
    protein: { type: Number },   // oqsil, g
    fat: { type: Number },       // yog', g
    carbs: { type: Number },     // uglevod, g
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

// Har qanday yozuv amalidan keyin Redis keshini avtomatik tozalaydi
dishSchema.plugin(cacheInvalidationPlugin, { kind: 'dish' });

export const Dish = model('Dish', dishSchema);
