import { Schema, model } from 'mongoose';

/* Do'kon katalogi guruhlari (20 ta) — muqova rasmi CatalogAsset dan (coverAsset nomi bo'yicha). */
const CatalogSeedGroupSchema = new Schema({
  id: { type: String, required: true, unique: true, trim: true, lowercase: true, maxlength: 60 },
  label: { type: String, required: true, trim: true, maxlength: 120 },
  hint: { type: String, default: '', maxlength: 240 },
  emoji: { type: String, default: '', maxlength: 16 },
  from: { type: String, default: '', maxlength: 16 },
  to: { type: String, default: '', maxlength: 16 },
  order: { type: Number, default: 0, index: true },
  coverAsset: { type: String, default: '', maxlength: 80 },
}, { timestamps: true });

export const CatalogSeedGroup = model('CatalogSeedGroup', CatalogSeedGroupSchema);
