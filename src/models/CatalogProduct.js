import { Schema, model } from 'mongoose';
import { CATALOG_CATEGORY_VALUES } from '../constants/catalogCategories.js';

/**
 * Umumiy mahsulot katalogi.
 *
 * Sabab: Coca-Cola, Pepsi, mineral suv kabi mahsulotlar barcha
 * restoranlarda bir xil. Har biri o'zi yaratsa baza keraksiz
 * kattayadi va nom/rasm har xil bo'ladi.
 *
 * Yechim: admin bir marta yaratadi, restoran tanlab faqat
 * o'z narxini qo'yadi.
 *
 * Kategoriya endi oziq-ovqat do'konlari (dukonlar) uchun ham
 * moslashtirilgan 70 ta kategoriyani o'z ichiga oladi — qarang
 * constants/catalogCategories.js. Restoran/kafe/oshxona/choyxona
 * turidagi muassasalarga FAQAT "ichimliklar" ko'rinadi, qolgan
 * 69 tasi faqat do'kon (Restaurant.kind === 'shop') uchun.
 */
const catalogProductSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, index: true },
    description: { type: String, default: '' },

    category: {
      type: String,
      required: true,
      index: true,
      enum: CATALOG_CATEGORY_VALUES,
    },

    // Hajm yoki og'irlik: "0.5 l", "1 l", "330 ml", "250 g"
    volume: { type: String, default: '' },

    imageUrl: { type: String, default: '' },

    /*
     * Brend, tavsiya narx, kaloriya/oqsil/yog'/uglevod — ADMIN
     * FORMASIDAN OLIB TASHLANDI (narxni restoran/do'kon o'zi
     * qo'yadi, brend/ozuqaviy ma'lumot kerak emas). Maydonlar
     * eski yozuvlar bilan moslik uchun sxemada qoladi, lekin
     * endi yangi mahsulot qo'shishda to'ldirilmaydi.
     */
    brand: { type: String, default: '', index: true },
    suggestedPrice: { type: Number, default: 0 },
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
