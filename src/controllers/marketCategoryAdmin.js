import { z } from 'zod';
import { asyncHandler } from '../middleware/error.js';
import { MarketCategory } from '../models/MarketCategory.js';
import { Dish } from '../models/Dish.js';
import { listMarketCategories, invalidateMarketCategories } from '../services/marketCategoryRegistry.js';

/*
 * ADMIN: Market kategoriyalari — yagona ro'yxat. Qo'shish/tahrirlash/o'chirish/faollashtirish shu yerda.
 * Kalit (key) yaratilgandan keyin O'ZGARMAYDI (mahsulotlar unga bog'langan). O'chirish — faqat hech bir mahsulot ishlatmasa;
 * ishlatilayotgan bo'lsa nofaol qilish (isActive=false) tavsiya qilinadi.
 */
const https = z.string().trim().max(500).refine((v) => v === '' || /^https:\/\//i.test(v), 'Rasm havolasi https bilan boshlanishi kerak');
const createSchema = z.object({
  key: z.string().trim().toLowerCase().regex(/^[a-z0-9_]{2,60}$/, 'Kalit: faqat a–z, 0–9 va _ (2–60 belgi)'),
  nameUz: z.string().trim().min(1, 'Nomi (lotin) kiritilishi shart').max(80),
  nameUzc: z.string().trim().max(80).optional(),
  nameRu: z.string().trim().max(80).optional(),
  emoji: z.string().max(16).optional(),
  imageUrl: https.optional(),
  order: z.number().int().min(0).max(100000).optional(),
  isActive: z.boolean().optional(),
}).strict();
const updateSchema = createSchema.omit({ key: true }).partial().strict();

async function nextOrder() {
  const last = await MarketCategory.findOne({}).sort({ order: -1 }).lean();
  return (last?.order || 0) + 10;
}

export const marketCategoryAdminController = {
  // GET /api/admin/market-categories — hammasi (nofaollari ham) + har biriga ishlatilish soni
  list: asyncHandler(async (_req, res) => {
    const cats = await listMarketCategories({ onlyActive: false });
    const usage = await Dish.aggregate([
      { $match: { catalogCategory: { $ne: null } } },
      { $group: { _id: '$catalogCategory', n: { $sum: 1 } } },
    ]);
    const byKey = new Map(usage.map((u) => [u._id, u.n]));
    res.json(cats.map((c) => ({ ...c, usage: byKey.get(c.key) || 0 })));
  }),

  // POST /api/admin/market-categories
  create: asyncHandler(async (req, res) => {
    const p = createSchema.safeParse(req.body || {});
    if (!p.success) return res.status(400).json({ error: p.error.issues[0]?.message || 'Ma‘lumot noto‘g‘ri' });
    const d = p.data;
    if (await MarketCategory.exists({ key: d.key })) return res.status(409).json({ error: 'Bu kalit allaqachon mavjud', code: 'KEY_TAKEN' });
    const doc = await MarketCategory.create({
      key: d.key,
      nameUz: d.nameUz,
      nameUzc: d.nameUzc || '',
      nameRu: d.nameRu || '',
      emoji: d.emoji || '🛒',
      imageUrl: d.imageUrl || '',
      order: d.order ?? (await nextOrder()),
      isActive: d.isActive !== false,
    });
    invalidateMarketCategories();
    res.status(201).json(doc);
  }),

  // PATCH /api/admin/market-categories/:key — nom, rasm, emoji, tartib, faollik (kalit o'zgarmaydi)
  update: asyncHandler(async (req, res) => {
    const key = String(req.params.key || '').toLowerCase();
    const p = updateSchema.safeParse(req.body || {});
    if (!p.success) return res.status(400).json({ error: p.error.issues[0]?.message || 'Ma‘lumot noto‘g‘ri' });
    const set = {};
    for (const [k, v] of Object.entries(p.data)) if (v !== undefined) set[k] = v;
    if (!Object.keys(set).length) return res.status(400).json({ error: 'O‘zgartiriladigan maydon yo‘q' });
    const doc = await MarketCategory.findOneAndUpdate({ key }, { $set: set }, { new: true }).lean();
    if (!doc) return res.status(404).json({ error: 'Kategoriya topilmadi' });
    invalidateMarketCategories();
    res.json(doc);
  }),

  // DELETE /api/admin/market-categories/:key — faqat ishlatilmasa
  remove: asyncHandler(async (req, res) => {
    const key = String(req.params.key || '').toLowerCase();
    const usage = await Dish.countDocuments({ catalogCategory: key });
    if (usage > 0) {
      return res.status(409).json({ error: `Bu kategoriyada ${usage} ta mahsulot bor. Avval mahsulotlarni ko‘chiring yoki kategoriyani nofaol qiling.`, code: 'IN_USE', usage });
    }
    const r = await MarketCategory.deleteOne({ key });
    if (!r.deletedCount) return res.status(404).json({ error: 'Kategoriya topilmadi' });
    invalidateMarketCategories();
    res.json({ ok: true });
  }),
};
