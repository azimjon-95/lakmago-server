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

/*
 * Nomdan kalit (ID) yasash: o‘/o'/oʻ → o, g‘/g'/gʻ → g, qolgan belgilar → _ ; kichik harf.
 * Masalan: "Sut mahsulotlari" → sut_mahsulotlari; "Chips va snack" → chips_va_snack.
 */
export function slugifyKey(name) {
  const s = String(name || '')
    .toLowerCase()
    .replace(/[oʻ‘’'`]/g, (m) => (m === 'o' ? 'o' : ''))
    .replace(/g[ʻ‘’'`]/g, 'g')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return s.slice(0, 60).replace(/_+$/, '');
}
const createSchema = z.object({
  // Bo'sh bo'lsa — nomdan avtomatik yasaladi (create ichida)
  key: z.string().trim().toLowerCase().max(60).optional(),
  nameUz: z.string().trim().min(1, 'Nomi (lotin) kiritilishi shart').max(80),
  nameUzc: z.string().trim().max(80).optional(),
  nameRu: z.string().trim().max(80).optional(),
  nameEn: z.string().trim().max(120).optional(),
  emoji: z.string().max(16).optional(),
  imageUrl: https.optional(),
  cardUrl: https.optional(),
  description: z.string().trim().max(300).optional(),
  order: z.number().int().min(0).max(100000).optional(),
  isActive: z.boolean().optional(),
}).strict();
const updateSchema = createSchema.omit({ key: true }).partial().strict();

/* API maydonlari -> DB hujjat shakli (catalogcategories): name, description, i18n.{uz,uzc,ru,en} */
function toDbSet(p) {
  const s = {};
  if (p.nameUz !== undefined) { s.name = p.nameUz; s['i18n.uz.name'] = p.nameUz; }
  if (p.description !== undefined) { s.description = p.description; s['i18n.uz.description'] = p.description; }
  if (p.nameUzc !== undefined) s['i18n.uzc.name'] = p.nameUzc;
  if (p.nameRu !== undefined) s['i18n.ru.name'] = p.nameRu;
  if (p.nameEn !== undefined) s['i18n.en.name'] = p.nameEn;
  for (const k of ['emoji', 'imageUrl', 'cardUrl', 'order', 'isActive']) if (p[k] !== undefined) s[k] = p[k];
  return s;
}

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
    const key = (d.key && d.key.length ? d.key : slugifyKey(d.nameUz));
    if (!/^[a-z0-9_]{2,60}$/.test(key)) return res.status(400).json({ error: 'Kalit yasab bo‘lmadi — boshqa nom kiriting yoki kalitni qo‘lda yozing (a–z, 0–9, _)' });
    if (await MarketCategory.exists({ key })) return res.status(409).json({ error: 'Bu kalit allaqachon mavjud', code: 'KEY_TAKEN' });
    const doc = await MarketCategory.create({
      key,
      name: d.nameUz,
      description: d.description || '',
      i18n: {
        uz: { name: d.nameUz, description: d.description || '' },
        uzc: { name: d.nameUzc || '' },
        ru: { name: d.nameRu || '' },
        en: { name: d.nameEn || '' },
      },
      emoji: d.emoji || '🛒',
      imageUrl: d.imageUrl || '',
      cardUrl: d.cardUrl || '',
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
    const set = toDbSet(p.data);
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
