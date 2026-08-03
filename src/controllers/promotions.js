import { z } from 'zod';
import { asyncHandler } from '../middleware/error.js';
import { Promotion } from '../models/Promotion.js';
import { BonusRule } from '../models/BonusRule.js';
import { AdCampaign } from '../models/AdCampaign.js';
import { Order } from '../models/Order.js';
import { ensureSubscription, getDebt } from '../services/promoBilling.js';

const rid = (req) => req.restaurantId;

const CATEGORIES = [
  'milliy', 'osh', 'shashlik', 'sup', 'salat', 'choyxona',
  'zavtroki', 'obed', 'fastfood', 'lavash', 'burger', 'tovuq',
  'pitsa', 'sushi', 'evropa', 'turetskaya', 'koffe',
  'shirinlik', 'salqin', 'magazin_oziq',
];

// ===== AKSIYALAR =====
const promoSchema = z.object({
  name: z.string().min(2).max(100),
  discountType: z.enum(['percent', 'fixed']),
  discountValue: z.number().min(0),
  scope: z.enum(['all', 'category', 'dishes']).default('all'),
  categories: z.array(z.enum(CATEGORIES)).optional().default([]),
  dishIds: z.array(z.string().length(24)).optional().default([]),
  minOrderAmount: z.number().min(0).optional().default(0),
  maxDiscountAmount: z.number().min(0).optional().default(0),
  startsAt: z.string(),
  endsAt: z.string(),
  maxUses: z.number().int().min(0).optional().default(0),
  isActive: z.boolean().optional().default(true),
});

function validatePromo(data) {
  if (data.discountType === 'percent' && data.discountValue > 100) {
    return 'Foiz 100 dan oshmasligi kerak';
  }
  if (new Date(data.startsAt) >= new Date(data.endsAt)) {
    return 'Tugash sanasi boshlanishdan keyin bo\u2018lishi kerak';
  }
  if (data.scope === 'category' && !data.categories?.length) {
    return 'Kategoriya tanlang';
  }
  if (data.scope === 'dishes' && !data.dishIds?.length) {
    return 'Taom tanlang';
  }
  return null;
}

export const promotionController = {
  listPromotions: asyncHandler(async (req, res) => {
    const items = await Promotion.find({ restaurantId: rid(req) })
      .sort({ createdAt: -1 })
      .lean();

    const now = new Date();
    res.json(items.map((p) => ({
      ...p,
      // Hozir amal qilyaptimi — frontend hisoblamasin
      running: p.isActive
        && new Date(p.startsAt) <= now
        && new Date(p.endsAt) >= now
        && (p.maxUses === 0 || p.usedCount < p.maxUses),
    })));
  }),

  createPromotion: asyncHandler(async (req, res) => {
    const parsed = promoSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: parsed.error.issues[0]?.message || 'Ma\u2018lumot noto\u2018g\u2018ri',
      });
    }

    const err = validatePromo(parsed.data);
    if (err) return res.status(400).json({ error: err });

    const promo = await Promotion.create({
      ...parsed.data,
      restaurantId: rid(req),
    });

    // Xizmat obunasi — aksiya yoqilgan bo'lsa billing boshlanadi
    if (promo.isActive) {
      ensureSubscription(rid(req)).catch((e) =>
        console.error('[promo-sub]', e.message));
    }

    res.status(201).json(promo);
  }),

  updatePromotion: asyncHandler(async (req, res) => {
    const parsed = promoSchema.partial().safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Ma\u2018lumot noto\u2018g\u2018ri' });
    }

    if (parsed.data.startsAt && parsed.data.endsAt) {
      const err = validatePromo(parsed.data);
      if (err) return res.status(400).json({ error: err });
    }

    // Faqat o'z aksiyasi
    const promo = await Promotion.findOneAndUpdate(
      { _id: req.params.id, restaurantId: rid(req) },
      parsed.data,
      { new: true, runValidators: true },
    );
    if (!promo) return res.status(404).json({ error: 'Aksiya topilmadi' });

    if (promo.isActive) {
      ensureSubscription(rid(req)).catch(() => {});
    }

    res.json(promo);
  }),

  deletePromotion: asyncHandler(async (req, res) => {
    const promo = await Promotion.findOneAndDelete({
      _id: req.params.id, restaurantId: rid(req),
    });
    if (!promo) return res.status(404).json({ error: 'Aksiya topilmadi' });
    res.json({ deleted: true });
  }),

  // ===== BONUSLAR =====
  listBonuses: asyncHandler(async (req, res) => {
    const items = await BonusRule.find({ restaurantId: rid(req) })
      .sort({ minOrderAmount: 1 })
      .lean();
    res.json(items);
  }),

  createBonus: asyncHandler(async (req, res) => {
    const schema = z.object({
      name: z.string().max(100).optional().default('Bonus'),
      bonusType: z.enum(['percent', 'fixed']).default('fixed'),
      bonusValue: z.number().min(0),
      minOrderAmount: z.number().min(0).optional().default(0),
      maxBonusAmount: z.number().min(0).optional().default(0),
      validDays: z.number().int().min(0).optional().default(0),
      isActive: z.boolean().optional().default(true),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Ma\u2018lumot noto\u2018g\u2018ri' });
    }
    if (parsed.data.bonusType === 'percent' && parsed.data.bonusValue > 50) {
      return res.status(400).json({ error: 'Bonus 50% dan oshmasligi kerak' });
    }

    const rule = await BonusRule.create({ ...parsed.data, restaurantId: rid(req) });
    res.status(201).json(rule);
  }),

  updateBonus: asyncHandler(async (req, res) => {
    const rule = await BonusRule.findOneAndUpdate(
      { _id: req.params.id, restaurantId: rid(req) },
      req.body,
      { new: true, runValidators: true },
    );
    if (!rule) return res.status(404).json({ error: 'Qoida topilmadi' });
    res.json(rule);
  }),

  deleteBonus: asyncHandler(async (req, res) => {
    const rule = await BonusRule.findOneAndDelete({
      _id: req.params.id, restaurantId: rid(req),
    });
    if (!rule) return res.status(404).json({ error: 'Qoida topilmadi' });
    res.json({ deleted: true });
  }),

  // ===== REKLAMA =====
  listAds: asyncHandler(async (req, res) => {
    const items = await AdCampaign.find({ restaurantId: rid(req) })
      .sort({ createdAt: -1 })
      .lean();

    const now = new Date();
    const today = now.toISOString().slice(0, 10);

    res.json(items.map((a) => ({
      ...a,
      running: a.isActive
        && new Date(a.startsAt) <= now
        && new Date(a.endsAt) >= now
        && !(a.todayDate === today && a.todaySpent >= a.dailyBudget),
      // Foydali ko'rsatkichlar
      ctr: a.stats.impressions > 0
        ? Math.round((a.stats.clicks / a.stats.impressions) * 1000) / 10
        : 0,
      roi: a.stats.spent > 0
        ? Math.round((a.stats.revenue / a.stats.spent) * 10) / 10
        : 0,
    })));
  }),

  createAd: asyncHandler(async (req, res) => {
    const schema = z.object({
      name: z.string().min(2).max(100),
      targetType: z.enum(['restaurant', 'dish']).default('restaurant'),
      dishId: z.string().length(24).nullable().optional(),
      placements: z.array(z.enum(['home', 'category', 'search'])).min(1),
      dailyBudget: z.number().min(1000),
      startsAt: z.string(),
      endsAt: z.string(),
      isActive: z.boolean().optional().default(true),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: parsed.error.issues[0]?.message || 'Ma\u2018lumot noto\u2018g\u2018ri',
      });
    }
    if (new Date(parsed.data.startsAt) >= new Date(parsed.data.endsAt)) {
      return res.status(400).json({ error: 'Sanalar noto\u2018g\u2018ri' });
    }
    if (parsed.data.targetType === 'dish' && !parsed.data.dishId) {
      return res.status(400).json({ error: 'Taom tanlang' });
    }

    const ad = await AdCampaign.create({ ...parsed.data, restaurantId: rid(req) });

    if (ad.isActive) {
      ensureSubscription(rid(req)).catch((e) =>
        console.error('[promo-sub]', e.message));
    }

    res.status(201).json(ad);
  }),

  updateAd: asyncHandler(async (req, res) => {
    const ad = await AdCampaign.findOneAndUpdate(
      { _id: req.params.id, restaurantId: rid(req) },
      req.body,
      { new: true, runValidators: true },
    );
    if (!ad) return res.status(404).json({ error: 'Reklama topilmadi' });

    if (ad.isActive) {
      ensureSubscription(rid(req)).catch(() => {});
    }

    res.json(ad);
  }),

  deleteAd: asyncHandler(async (req, res) => {
    const ad = await AdCampaign.findOneAndDelete({
      _id: req.params.id, restaurantId: rid(req),
    });
    if (!ad) return res.status(404).json({ error: 'Reklama topilmadi' });
    res.json({ deleted: true });
  }),

  // ===== UMUMIY STATISTIKA =====
  overview: asyncHandler(async (req, res) => {
    const restaurantId = rid(req);

    const [promos, bonuses, ads] = await Promise.all([
      Promotion.find({ restaurantId }).select('stats usedCount').lean(),
      BonusRule.find({ restaurantId }).select('stats').lean(),
      AdCampaign.find({ restaurantId }).select('stats').lean(),
    ]);

    const sum = (arr, path) => arr.reduce((s, x) => {
      const val = path.split('.').reduce((o, k) => o?.[k], x);
      return s + (Number(val) || 0);
    }, 0);

    // Yangi va qaytgan mijozlar — aksiyali buyurtmalar bo'yicha
    const promoOrders = await Order.find({
      restaurantId,
      promotionId: { $ne: null },
      status: { $ne: 'cancelled' },
    }).select('userId').lean();

    const userCounts = new Map();
    for (const o of promoOrders) {
      const k = String(o.userId);
      userCounts.set(k, (userCounts.get(k) || 0) + 1);
    }
    const newCustomers = [...userCounts.values()].filter((c) => c === 1).length;
    const repeatCustomers = [...userCounts.values()].filter((c) => c > 1).length;

    const debtInfo = await getDebt(restaurantId);
    const { getSettings } = await import('../models/Settings.js');
    const settings = await getSettings();

    res.json({
      xizmat: {
        kunlikNarx: settings.promoDailyPrice || 15000,
        qarz: debtInfo.debt,
        kunlar: debtInfo.periods,
      },
      aksiyalar: {
        soni: promos.length,
        foydalanish: sum(promos, 'usedCount'),
        chegirma: sum(promos, 'stats.totalDiscount'),
        tushum: sum(promos, 'stats.totalRevenue'),
      },
      bonuslar: {
        soni: bonuses.length,
        berilgan: sum(bonuses, 'stats.totalGiven'),
        buyurtmalar: sum(bonuses, 'stats.orders'),
      },
      reklama: {
        soni: ads.length,
        korishlar: sum(ads, 'stats.impressions'),
        bosishlar: sum(ads, 'stats.clicks'),
        buyurtmalar: sum(ads, 'stats.orders'),
        xarajat: sum(ads, 'stats.spent'),
        tushum: sum(ads, 'stats.revenue'),
      },
      mijozlar: {
        yangi: newCustomers,
        qaytgan: repeatCustomers,
      },
    });
  }),
};
