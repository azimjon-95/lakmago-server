import { asyncHandler } from '../middleware/error.js';
import { CatalogSeedCategory } from '../models/CatalogSeedCategory.js';
import { CatalogSeedGroup } from '../models/CatalogSeedGroup.js';
import { CatalogAsset } from '../models/CatalogAsset.js';

/*
 * DO'KON katalogi — o'qish (ochiq): guruhlar + kategoriyalar; rasm baytlari /assets/:name orqali.
 * GET /api/market/catalog-categories
 * GET /api/catalog/assets/:name
 */
export const catalogDbController = {
  list: asyncHandler(async (_req, res) => {
    res.set('Cache-Control', 'public, max-age=300');
    const [groups, categories] = await Promise.all([
      CatalogSeedGroup.find({}).sort({ order: 1, _id: 1 }).lean(),
      CatalogSeedCategory.find({ isActive: true }).sort({ order: 1, _id: 1 }).lean(),
    ]);
    res.json({
      groups: groups.map((g) => ({
        id: g.id, label: g.label, hint: g.hint || '', emoji: g.emoji || '', from: g.from || '', to: g.to || '', order: g.order,
        cover: g.coverAsset ? `/api/catalog/assets/${g.coverAsset}` : '',
      })),
      categories: categories.map((c) => ({ key: c.key, uz: c.nameUz, uzc: c.nameUzc || c.nameUz, ru: c.nameRu || c.nameUz, group: c.group, order: c.order })),
    });
  }),

  asset: asyncHandler(async (req, res) => {
    const name = String(req.params.name || '');
    if (!/^[a-z0-9_]+@\d{3,4}\.webp$/.test(name)) return res.status(400).json({ error: 'Noto‘g‘ri rasm nomi' });
    // lean() emas: lean'da data BSON Binary bo'lib qoladi (Buffer.from bo'sh bayt beradi)
    const doc = await CatalogAsset.findOne({ name }).select('mime data');
    if (!doc) return res.status(404).json({ error: 'Rasm topilmadi' });
    res.set('Content-Type', doc.mime || 'image/webp');
    res.set('Cache-Control', 'public, max-age=86400, immutable');
    res.send(doc.data);
  }),
};
