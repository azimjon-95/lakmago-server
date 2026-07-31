import { z } from 'zod';
import { asyncHandler } from '../middleware/error.js';
import { Ledger } from '../models/Ledger.js';
import { Restaurant } from '../models/Restaurant.js';
import { recordPayout, getRestaurantSummary } from '../services/billing.js';

export const billingController = {
  // GET /api/admin/billing/overview — umumiy holat
  overview: asyncHandler(async (req, res) => {
    const match = {};
    if (req.query.from || req.query.to) {
      match.createdAt = {};
      if (req.query.from) match.createdAt.$gte = new Date(req.query.from);
      if (req.query.to) match.createdAt.$lte = new Date(req.query.to);
    }

    const rows = await Ledger.aggregate([
      { $match: match },
      { $group: { _id: '$type', total: { $sum: '$amount' }, count: { $sum: 1 } } },
    ]);
    const t = Object.fromEntries(rows.map((r) => [r._id, r.total]));

    // Restoranlarga jami qarzimiz
    const [{ totalDebt = 0 } = {}] = await Restaurant.aggregate([
      { $group: { _id: null, totalDebt: { $sum: '$balance' } } },
    ]);

    res.json({
      tushum: t.payment_in || 0,
      komissiya: t.commission || 0,
      restoranlarUlushi: t.restaurant_due || 0,
      tolangan: Math.abs(t.payout || 0),
      qaytarilgan: Math.abs(t.refund || 0),
      // Platformada qolgan: komissiya − qaytarilgan
      platformaDaromadi: (t.commission || 0) - Math.abs(t.refund || 0),
      restoranlargaQarz: totalDebt,
    });
  }),

  // GET /api/admin/billing/restaurants — restoranlar bo'yicha
  byRestaurant: asyncHandler(async (_req, res) => {
    const rows = await Ledger.aggregate([
      { $match: { restaurantId: { $ne: null } } },
      {
        $group: {
          _id: { restaurantId: '$restaurantId', type: '$type' },
          total: { $sum: '$amount' },
        },
      },
      {
        $group: {
          _id: '$_id.restaurantId',
          types: { $push: { type: '$_id.type', total: '$total' } },
        },
      },
    ]);

    const restaurants = await Restaurant.find({})
      .select('name balance totalPaidOut commissionPercent commissionMode')
      .lean();

    const map = new Map(rows.map((r) => [String(r._id), r.types]));

    res.json(restaurants.map((r) => {
      const types = Object.fromEntries(
        (map.get(String(r._id)) || []).map((x) => [x.type, x.total]),
      );
      return {
        _id: r._id,
        name: r.name,
        commissionPercent: r.commissionPercent,
        commissionMode: r.commissionMode,
        tushum: types.payment_in || 0,
        komissiya: types.commission || 0,
        balans: r.balance || 0,
        tolangan: r.totalPaidOut || 0,
      };
    }));
  }),

  // GET /api/admin/billing/ledger — batafsil jurnal
  ledger: asyncHandler(async (req, res) => {
    const filter = {};
    if (req.query.restaurantId) filter.restaurantId = req.query.restaurantId;
    if (req.query.type) filter.type = req.query.type;
    if (req.query.from || req.query.to) {
      filter.createdAt = {};
      if (req.query.from) filter.createdAt.$gte = new Date(req.query.from);
      if (req.query.to) filter.createdAt.$lte = new Date(req.query.to);
    }

    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const items = await Ledger.find(filter)
      .populate('restaurantId', 'name')
      .populate('orderId', 'total status')
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    res.json(items);
  }),

  // GET /api/admin/billing/restaurant/:id
  restaurantSummary: asyncHandler(async (req, res) => {
    const data = await getRestaurantSummary(
      req.params.id, req.query.from, req.query.to,
    );
    res.json(data);
  }),

  // POST /api/admin/billing/payout — restoranga to'lov
  payout: asyncHandler(async (req, res) => {
    const schema = z.object({
      restaurantId: z.string().length(24),
      amount: z.number().positive(),
      note: z.string().max(200).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Noto\u2018g\u2018ri ma\u2018lumot' });
    }

    try {
      const result = await recordPayout(
        parsed.data.restaurantId,
        parsed.data.amount,
        req.userId,
        parsed.data.note,
      );
      res.json(result);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  }),

  // PATCH /api/admin/restaurants/:id/commission
  setCommission: asyncHandler(async (req, res) => {
    const schema = z.object({
      commissionPercent: z.number().min(0).max(100).nullable().optional(),
      commissionMode: z.enum(['markup', 'deduct']).nullable().optional(),
      contractNumber: z.string().max(50).optional(),
      contractDate: z.string().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Noto\u2018g\u2018ri qiymat' });
    }

    const update = { ...parsed.data };
    if (update.contractDate) update.contractDate = new Date(update.contractDate);

    const restaurant = await Restaurant.findByIdAndUpdate(
      req.params.id, update, { new: true },
    ).select('name commissionPercent commissionMode contractNumber contractDate');

    if (!restaurant) return res.status(404).json({ error: 'Restoran topilmadi' });
    res.json(restaurant);
  }),
};
