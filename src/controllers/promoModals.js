import mongoose from 'mongoose';
import { PromoModal } from '../models/PromoModal.js';
import { asyncHandler } from '../middleware/error.js';
import { MAX_ACTIVE, isLive, publicView, sanitizePromo } from '../services/promoModals.js';

/*
 * Mijoz: GET /api/promo-modals/active — faol oynalar (tartib bo'yicha), 30 s kesh.
 * Admin: CRUD + tartib + "qayta ko'rsatish" (version++) + statistika.
 */
let cache = { at: 0, data: null };
const CACHE_MS = 30_000;
export const invalidatePromoCache = () => { cache = { at: 0, data: null }; };
const validId = (id) => mongoose.isValidObjectId(id);

async function activeCount(exceptId) {
  return PromoModal.countDocuments({ active: true, ...(exceptId ? { _id: { $ne: exceptId } } : {}) });
}

export const promoModalController = {
  active: asyncHandler(async (_req, res) => {
    const now = Date.now();
    if (!cache.data || now - cache.at > CACHE_MS) {
      const rows = await PromoModal.find({ active: true }).sort({ order: 1, createdAt: 1 }).limit(20).lean();
      cache = { at: now, data: rows };
    }
    const list = cache.data.filter((p) => isLive(p, new Date(now))).slice(0, MAX_ACTIVE).map(publicView);
    res.set('Cache-Control', 'no-store').json(list);
  }),

  /** Mijoz ko'rdi / bosdi — faqat son (shaxsiy ma'lumot yo'q) */
  track: asyncHandler(async (req, res) => {
    const { id } = req.params;
    const kind = req.body?.kind === 'click' ? 'clicked' : 'shown';
    if (validId(id)) await PromoModal.updateOne({ _id: id }, { $inc: { [`stats.${kind}`]: 1 } }).catch(() => {});
    res.status(204).end();
  }),

  list: asyncHandler(async (_req, res) => {
    const rows = await PromoModal.find().sort({ order: 1, createdAt: 1 }).lean();
    res.json(rows.map((p) => ({ ...p, id: String(p._id), live: isLive(p) })));
  }),

  create: asyncHandler(async (req, res) => {
    const { data, error } = sanitizePromo(req.body);
    if (error) return res.status(400).json({ error });
    if (data.active && (await activeCount()) >= MAX_ACTIVE) return res.status(400).json({ error: `Bir vaqtda ko‘pi bilan ${MAX_ACTIVE} ta oyna faol bo‘lishi mumkin` });
    const last = await PromoModal.findOne().sort({ order: -1 }).select('order').lean();
    const doc = await PromoModal.create({ ...data, order: (last?.order ?? -1) + 1 });
    invalidatePromoCache();
    res.status(201).json({ ...doc.toObject(), id: String(doc._id), live: isLive(doc) });
  }),

  update: asyncHandler(async (req, res) => {
    if (!validId(req.params.id)) return res.status(404).json({ error: 'Topilmadi' });
    const { data, error } = sanitizePromo(req.body, { partial: true });
    if (error) return res.status(400).json({ error });
    if (data.active && (await activeCount(req.params.id)) >= MAX_ACTIVE) return res.status(400).json({ error: `Bir vaqtda ko‘pi bilan ${MAX_ACTIVE} ta oyna faol bo‘lishi mumkin` });
    const doc = await PromoModal.findByIdAndUpdate(req.params.id, { $set: data }, { new: true, runValidators: true }).lean();
    if (!doc) return res.status(404).json({ error: 'Topilmadi' });
    invalidatePromoCache();
    res.json({ ...doc, id: String(doc._id), live: isLive(doc) });
  }),

  /** Bugun ko'rgan mijozlarga ham yana ko'rsatish */
  reshow: asyncHandler(async (req, res) => {
    if (!validId(req.params.id)) return res.status(404).json({ error: 'Topilmadi' });
    const doc = await PromoModal.findByIdAndUpdate(req.params.id, { $inc: { version: 1 } }, { new: true }).lean();
    if (!doc) return res.status(404).json({ error: 'Topilmadi' });
    invalidatePromoCache();
    res.json({ ...doc, id: String(doc._id), live: isLive(doc) });
  }),

  reorder: asyncHandler(async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter(validId).slice(0, 100) : [];
    if (!ids.length) return res.status(400).json({ error: 'Tartib bo‘sh' });
    await PromoModal.bulkWrite(ids.map((id, i) => ({ updateOne: { filter: { _id: id }, update: { $set: { order: i } } } })));
    invalidatePromoCache();
    res.json({ ok: true });
  }),

  remove: asyncHandler(async (req, res) => {
    if (!validId(req.params.id)) return res.status(404).json({ error: 'Topilmadi' });
    await PromoModal.deleteOne({ _id: req.params.id });
    invalidatePromoCache();
    res.json({ ok: true });
  }),
};
