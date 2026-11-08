import { Schema, model } from 'mongoose';

/*
 * Rasm baytlari DB da (muqova rasmlari: guruh × kenglik). name — masalan "gosht@720.webp".
 * Serverdan /api/catalog/assets/:name orqali beriladi (uzoq muddatli kesh bilan).
 */
const CatalogAssetSchema = new Schema({
  name: { type: String, required: true, unique: true, trim: true, maxlength: 120 },
  mime: { type: String, default: 'image/webp', maxlength: 60 },
  bytes: { type: Number, default: 0 },
  data: { type: Buffer, required: true },
}, { timestamps: true });

export const CatalogAsset = model('CatalogAsset', CatalogAssetSchema);
