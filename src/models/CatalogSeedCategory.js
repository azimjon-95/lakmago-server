import { Schema, model } from 'mongoose';

/*
 * DO'KON katalogi (70 ta kategoriya) — DB nusxasi. Dastlab seed/catalog/categories.json dan yuklanadi (import, idempotent).
 * Restoran katalogi (constants/catalogCategories.js) o'zgarmaydi — bu faqat do'konlar uchun.
 */
const CatalogSeedCategorySchema = new Schema({
  key: { type: String, required: true, unique: true, trim: true, lowercase: true, maxlength: 60 },
  nameUz: { type: String, required: true, trim: true, maxlength: 120 },
  nameUzc: { type: String, default: '', trim: true, maxlength: 120 },
  nameRu: { type: String, default: '', trim: true, maxlength: 120 },
  group: { type: String, required: true, index: true },
  order: { type: Number, default: 0, index: true },
  isActive: { type: Boolean, default: true, index: true },
}, { timestamps: true });

export const CatalogSeedCategory = model('CatalogSeedCategory', CatalogSeedCategorySchema);
