import { Schema, model } from 'mongoose';

/*
 * MARKET KATEGORIYALARI — DB kolleksiyasi: `catalogcategories` (Grok yuklagan, test.catalogcategories).
 * Hujjat shakli:
 *   key, name (uz), description, imageUrl (Cloudinary, kategoriya ikoni), cardUrl (karta rasmi),
 *   i18n: { uz: {name, description}, uzc: {name}, ru: {name, description}, en: {name, description} },
 *   order, isActive, emoji
 * API javobi (registry): uz/uzc/ru/en, description, imageUrl, cardUrl — admin va klient shu shaklni ishlatadi.
 */
const L10n = new Schema({
  name: { type: String, default: '', trim: true, maxlength: 120 },
  description: { type: String, default: '', trim: true, maxlength: 300 },
}, { _id: false });

const MarketCategorySchema = new Schema({
  key: { type: String, required: true, unique: true, trim: true, lowercase: true, match: /^[a-z0-9_]{2,60}$/ },
  name: { type: String, default: '', trim: true, maxlength: 120 },
  description: { type: String, default: '', trim: true, maxlength: 300 },
  emoji: { type: String, default: '🛒', maxlength: 16 },
  imageUrl: { type: String, default: '', maxlength: 500 },
  cardUrl: { type: String, default: '', maxlength: 500 },
  i18n: {
    uz: { type: L10n, default: () => ({}) },
    uzc: { type: new Schema({ name: { type: String, default: '', trim: true, maxlength: 120 } }, { _id: false }), default: () => ({}) },
    ru: { type: L10n, default: () => ({}) },
    en: { type: L10n, default: () => ({}) },
  },
  order: { type: Number, default: 0, index: true },
  isActive: { type: Boolean, default: true, index: true },
}, { timestamps: true, collection: 'catalogcategories' });

export const MarketCategory = model('MarketCategory', MarketCategorySchema);
