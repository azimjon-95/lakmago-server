import { Schema, model } from 'mongoose';

/*
 * MARKET KATEGORIYALARI — yagona, markaziy ro'yxat (admin paneldan boshqariladi).
 * Do'kon mahsulotining katalog kaliti (Dish.catalogCategory) SHU ro'yxatdan olinadi: forma, Market bosh sahifa qatori,
 * /market/products?category= filtri va server tekshiruvi — hammasi bir manba.
 *   key   — mahsulot va URL uchun ID (o'zgarmaydi), masalan `choy`, `sut_mahsulotlari`
 *   nameUz/nameUzc/nameRu — uch tildagi nom;  emoji — rasm yo'q bo'lganda;  imageUrl — ixtiyoriy rasm (https)
 */
const MarketCategorySchema = new Schema({
  key: { type: String, required: true, unique: true, trim: true, lowercase: true, match: /^[a-z0-9_]{2,60}$/ },
  nameUz: { type: String, required: true, trim: true, maxlength: 80 },
  nameUzc: { type: String, default: '', trim: true, maxlength: 80 },
  nameRu: { type: String, default: '', trim: true, maxlength: 80 },
  emoji: { type: String, default: '🛒', maxlength: 16 },
  // Ikon (yumaloq, Cloudinary) — kategoriya doirasi va "Barchasi" ro'yxatida
  imageUrl: { type: String, default: '', maxlength: 500 },
  // Karta rasmi (yumaloq, Cloudinary) — kategoriya sarlavhasi yonida
  cardUrl: { type: String, default: '', maxlength: 500 },
  // Tavsif — kategoriya ochilganda ko'rinadi
  description: { type: String, default: '', trim: true, maxlength: 300 },
  order: { type: Number, default: 0, index: true },
  isActive: { type: Boolean, default: true, index: true },
}, { timestamps: true });

export const MarketCategory = model('MarketCategory', MarketCategorySchema);
