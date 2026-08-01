import { Schema, model } from 'mongoose';

/**
 * Umumiy mahsulot katalogi.
 *
 * Sabab: Coca-Cola, Pepsi, mineral suv kabi mahsulotlar barcha
 * restoranlarda bir xil. Har biri o'zi yaratsa baza keraksiz
 * kattayadi va nom/rasm har xil bo'ladi.
 *
 * Yechim: admin bir marta yaratadi, restoran tanlab faqat
 * o'z narxini qo'yadi.
 */
const catalogProductSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, index: true },
    description: { type: String, default: '' },

    // Dish bilan bir xil kategoriyalar
    category: {
      type: String,
      required: true,
      index: true,
      enum: [
        'milliy', 'osh', 'shashlik', 'sup', 'salat', 'choyxona',
        'zavtroki', 'obed',
        'fastfood', 'lavash', 'burger', 'tovuq', 'pitsa',
        'sushi', 'evropa', 'turetskaya',
        'koffe', 'shirinlik', 'salqin', 'magazin_oziq',
      ],
    },

    // Hajm yoki og'irlik: "0.5 l", "1 l", "330 ml", "250 g"
    volume: { type: String, default: '' },

    imageUrl: { type: String, default: '' },

    // Brend — bir mahsulotning turli hajmlarini guruhlash uchun
    brand: { type: String, default: '', index: true },

    // Tavsiya etilgan narx — restoran o'zgartirishi mumkin
    suggestedPrice: { type: Number, default: 0 },

    // Ozuqaviy ma'lumot (ixtiyoriy)
    calories: { type: Number },
    protein: { type: Number },
    fat: { type: Number },
    carbs: { type: Number },

    // Nofaol bo'lsa restoranlarga ko'rinmaydi
    isActive: { type: Boolean, default: true, index: true },

    // Nechta restoran qo'shgani — mashhurligini ko'rsatadi
    usageCount: { type: Number, default: 0 },
  },
  { timestamps: true },
);

// Qidiruv uchun
catalogProductSchema.index({ name: 'text', brand: 'text' });

export const CatalogProduct = model('CatalogProduct', catalogProductSchema);
