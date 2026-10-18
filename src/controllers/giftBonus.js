import mongoose from 'mongoose';
import { z } from 'zod';
import { GiftBonus } from '../models/GiftBonus.js';
import { Order } from '../models/Order.js';
import { Restaurant } from '../models/Restaurant.js';
import { asyncHandler } from '../middleware/error.js';
import { MAX_ACTIVE_RULES, invalidateGiftCache, isLive, quoteGifts, sanitizeGift } from '../services/giftBonus.js';

/*
 * Mijoz: POST /api/gift-bonus/quote — savatdagi har restoran uchun "sovg'a bor / yana X so'm qoldi".
 *        Hisob buyurtma yaratishdagi bilan BIR XIL funksiyada (services/giftBonus.js).
 * Admin: CRUD + statistika (qancha berildi, qancha restoranlarga qoplandi).
 */
const quoteSchema = z.object({
  groups: z.array(z.object({
    restaurantId: z.string().regex(/^[a-f\d]{24}$/i),
    subtotal: z.number().min(0).max(1_000_000_000),
  })).min(1).max(10),
  fulfillment: z.enum(['delivery', 'pickup']).default('delivery'),
  paymentMethod: z.enum(['cash', 'click', 'payme', 'paynet', 'uzum']).optional(),
});

const validId = (id) => mongoose.isValidObjectId(id) && String(id).length === 24;

/** Qoida bo'yicha statistika: Order'lardan hisoblanadi (alohida hisoblagich yo'q — chalkashmaydi) */
async function statsFor(ids) {
  if (!ids.length) return new Map();
  const rows = await Order.aggregate([
    { $match: { 'bonusItems.ruleId': { $in: ids } } },
    { $unwind: '$bonusItems' },
    { $match: { 'bonusItems.ruleId': { $in: ids } } },
    {
      $group: {
        _id: '$bonusItems.ruleId',
        given: { $sum: { $cond: [{ $eq: ['$status', 'cancelled'] }, 0, '$bonusItems.quantity'] } },
        orders: { $sum: { $cond: [{ $eq: ['$status', 'cancelled'] }, 0, 1] } },
        deliveredQty: { $sum: { $cond: [{ $eq: ['$status', 'delivered'] }, '$bonusItems.quantity', 0] } },
        compensated: { $sum: { $cond: [{ $eq: ['$status', 'delivered'] }, { $multiply: ['$bonusItems.reimburse', '$bonusItems.quantity'] }, 0] } },
        pending: { $sum: { $cond: [{ $in: ['$status', ['cancelled', 'delivered']] }, 0, { $multiply: ['$bonusItems.reimburse', '$bonusItems.quantity'] }] } },
        cancelled: { $sum: { $cond: [{ $eq: ['$status', 'cancelled'] }, 1, 0] } },
      },
    },
  ]);
  return new Map(rows.map((r) => [String(r._id), r]));
}

const view = (r, st) => ({
  ...r, id: String(r._id), live: isLive(r),
  restaurantIds: (r.restaurantIds || []).map(String),
  stats: {
    orders: st?.orders || 0,        // bonus berilgan buyurtmalar (bekor qilinmaganlar)
    given: st?.given || 0,          // berilgan sovg'alar soni
    delivered: st?.deliveredQty || 0,
    compensated: st?.compensated || 0, // yetkazilgan buyurtmalar uchun restoranlarga qoplangan (so'm)
    pending: st?.pending || 0,         // hali yo'lda: yetkazilsa qoplanadi
    cancelled: st?.cancelled || 0,
  },
});

export const giftBonusController = {
  quote: asyncHandler(async (req, res) => {
    const parsed = quoteSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Ma‘lumot noto‘g‘ri' });
    const { groups, fulfillment, paymentMethod } = parsed.data;
    const rests = await Restaurant.find({ _id: { $in: groups.map((g) => g.restaurantId) } })
      .select('kind pickupDiscountPercent').lean();
    const byId = new Map(rests.map((r) => [String(r._id), r]));
    const prepared = groups.filter((g) => byId.has(g.restaurantId)).map((g) => {
      const r = byId.get(g.restaurantId);
      // Olib ketish chegirmasi buyurtma yaratishdagi kabi SERVERDA hisoblanadi (mijoz yuborgan qiymatga ishonilmaydi)
      const pickupDiscount = fulfillment === 'pickup' && r.pickupDiscountPercent > 0 ? Math.round(g.subtotal * r.pickupDiscountPercent / 100) : 0;
      return { restaurantId: g.restaurantId, restaurantKind: r.kind, menuAmount: g.subtotal, paidAmount: Math.max(0, g.subtotal - pickupDiscount) };
    });
    const out = await quoteGifts({ groups: prepared, userId: req.userId, fulfillment, paymentMethod });
    res.set('Cache-Control', 'no-store').json({ groups: out });
  }),

  // ── Admin ──
  list: asyncHandler(async (_req, res) => {
    const rows = await GiftBonus.find().sort({ createdAt: 1 }).lean();
    const stats = await statsFor(rows.map((r) => r._id));
    res.json(rows.map((r) => view(r, stats.get(String(r._id)))));
  }),

  create: asyncHandler(async (req, res) => {
    const { data, error } = sanitizeGift(req.body);
    if (error) return res.status(400).json({ error });
    if (data.active && (await GiftBonus.countDocuments({ active: true })) >= MAX_ACTIVE_RULES) {
      return res.status(400).json({ error: `Bir vaqtda ko‘pi bilan ${MAX_ACTIVE_RULES} ta bonus yoqilishi mumkin` });
    }
    const doc = await GiftBonus.create(data);
    invalidateGiftCache();
    res.status(201).json(view(doc.toObject(), null));
  }),

  update: asyncHandler(async (req, res) => {
    if (!validId(req.params.id)) return res.status(404).json({ error: 'Topilmadi' });
    const { data, error } = sanitizeGift(req.body, { partial: true });
    if (error) return res.status(400).json({ error });
    // Yuqori/pastki chegara kesishuvi: faqat bittasi o'zgarsa ham mavjud qiymat bilan tekshiriladi
    if (data.minAmount !== undefined || data.maxAmount !== undefined) {
      const cur = await GiftBonus.findById(req.params.id).select('minAmount maxAmount').lean();
      if (!cur) return res.status(404).json({ error: 'Topilmadi' });
      const min = data.minAmount ?? cur.minAmount; const max = data.maxAmount ?? cur.maxAmount;
      if (max && max <= min) return res.status(400).json({ error: 'Yuqori chegara pastki chegaradan katta bo‘lsin' });
    }
    if (data.active === true && (await GiftBonus.countDocuments({ active: true, _id: { $ne: req.params.id } })) >= MAX_ACTIVE_RULES) {
      return res.status(400).json({ error: `Bir vaqtda ko‘pi bilan ${MAX_ACTIVE_RULES} ta bonus yoqilishi mumkin` });
    }
    const doc = await GiftBonus.findByIdAndUpdate(req.params.id, { $set: data }, { new: true, runValidators: true }).lean();
    if (!doc) return res.status(404).json({ error: 'Topilmadi' });
    invalidateGiftCache();
    const stats = await statsFor([doc._id]);
    res.json(view(doc, stats.get(String(doc._id))));
  }),

  /** Ishlatilgan qoidani o'chirib bo'lmaydi (hisobot va buyurtmalar tarixi saqlansin) — to'xtatiladi */
  remove: asyncHandler(async (req, res) => {
    if (!validId(req.params.id)) return res.status(404).json({ error: 'Topilmadi' });
    const used = await Order.exists({ 'bonusItems.ruleId': req.params.id });
    if (used) return res.status(409).json({ error: 'Bu bonus buyurtmalarda ishlatilgan — o‘chirib bo‘lmaydi, uni o‘chirib qo‘ying (to‘xtating)', code: 'GIFT_USED' });
    await GiftBonus.deleteOne({ _id: req.params.id });
    invalidateGiftCache();
    res.json({ ok: true });
  }),
};
