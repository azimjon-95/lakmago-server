import { z } from 'zod';
import { asyncHandler } from '../middleware/error.js';
import { PromoSubscription, PromoBilling, PromoTariffLog } from '../models/PromoBilling.js';
import { Promotion } from '../models/Promotion.js';
import { AdCampaign } from '../models/AdCampaign.js';
import { BonusRule } from '../models/BonusRule.js';
import { Restaurant } from '../models/Restaurant.js';
import { getSettings } from '../models/Settings.js';
import {
  getDebt, markDebtPaid, changeTariff, runBillingCycle,
} from '../services/promoBilling.js';

export const promoAdminController = {
  // GET /api/admin/promo/overview
  overview: asyncHandler(async (_req, res) => {
    const now = new Date();
    const todayStart = new Date(now); todayStart.setHours(0, 0, 0, 0);

    const [
      activeSubs, activePromos, activeAds, activeBonuses,
      settings, debtRows, paidRows, todayRows, settlementRows,
    ] = await Promise.all([
      PromoSubscription.countDocuments({ status: 'active' }),
      Promotion.countDocuments({ isActive: true, startsAt: { $lte: now }, endsAt: { $gte: now } }),
      AdCampaign.countDocuments({ isActive: true, startsAt: { $lte: now }, endsAt: { $gte: now } }),
      BonusRule.countDocuments({ isActive: true }),
      getSettings(),
      PromoBilling.aggregate([
        { $match: { status: 'unpaid' } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
      PromoBilling.aggregate([
        { $match: { status: 'paid' } },
        { $group: { _id: null, total: { $sum: '$paidAmount' } } },
      ]),
      PromoBilling.aggregate([
        { $match: { createdAt: { $gte: todayStart } } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
      PromoBilling.aggregate([
        { $match: { status: 'paid', paidVia: 'settlement' } },
        { $group: { _id: null, total: { $sum: '$paidAmount' } } },
      ]),
    ]);

    res.json({
      faolRestoranlar: activeSubs,
      faolAksiyalar: activePromos,
      faolReklamalar: activeAds,
      faolBonuslar: activeBonuses,
      kunlikNarx: settings.promoDailyPrice || 15000,
      bugungiHisob: todayRows[0]?.total || 0,
      jamiQarz: debtRows[0]?.total || 0,
      jamiTolangan: paidRows[0]?.total || 0,
      deliveryOrqali: settlementRows[0]?.total || 0,
      settlementYoqilgan: Boolean(settings.promoDeductFromSettlement),
    });
  }),

  // GET /api/admin/promo/restaurants?q=
  restaurants: asyncHandler(async (req, res) => {
    const q = String(req.query.q || '').trim();

    const filter = {};
    if (q) {
      filter.$or = [
        { name: { $regex: q, $options: 'i' } },
        { phone: { $regex: q, $options: 'i' } },
      ];
    }

    const restaurants = await Restaurant.find(filter)
      .select('name phone address isActive')
      .limit(100)
      .lean();

    const ids = restaurants.map((r) => r._id);
    const now = new Date();

    const [subs, debts, paids, promos, ads, bonuses] = await Promise.all([
      PromoSubscription.find({ restaurantId: { $in: ids } }).lean(),
      PromoBilling.aggregate([
        { $match: { restaurantId: { $in: ids }, status: 'unpaid' } },
        { $group: { _id: '$restaurantId', total: { $sum: '$amount' } } },
      ]),
      PromoBilling.aggregate([
        { $match: { restaurantId: { $in: ids }, status: 'paid' } },
        { $group: { _id: '$restaurantId', total: { $sum: '$paidAmount' } } },
      ]),
      Promotion.aggregate([
        { $match: { restaurantId: { $in: ids }, isActive: true, startsAt: { $lte: now }, endsAt: { $gte: now } } },
        { $group: { _id: '$restaurantId', n: { $sum: 1 } } },
      ]),
      AdCampaign.aggregate([
        { $match: { restaurantId: { $in: ids }, isActive: true, startsAt: { $lte: now }, endsAt: { $gte: now } } },
        { $group: { _id: '$restaurantId', n: { $sum: 1 } } },
      ]),
      BonusRule.aggregate([
        { $match: { restaurantId: { $in: ids }, isActive: true } },
        { $group: { _id: '$restaurantId', n: { $sum: 1 } } },
      ]),
    ]);

    const map = (arr, key = 'total') =>
      new Map(arr.map((x) => [String(x._id), x[key] ?? x.n]));

    const subMap = new Map(subs.map((s) => [String(s.restaurantId), s]));
    const debtMap = map(debts);
    const paidMap = map(paids);
    const promoMap = map(promos, 'n');
    const adMap = map(ads, 'n');
    const bonusMap = map(bonuses, 'n');

    res.json(restaurants.map((r) => {
      const id = String(r._id);
      const sub = subMap.get(id);
      return {
        _id: r._id,
        name: r.name,
        phone: r.phone || '',
        address: r.address || '',
        subscription: sub ? {
          status: sub.status,
          startedAt: sub.startedAt,
          dailyPrice: sub.dailyPrice,
        } : null,
        aksiya: (promoMap.get(id) || 0) > 0,
        reklama: (adMap.get(id) || 0) > 0,
        bonus: (bonusMap.get(id) || 0) > 0,
        qarz: debtMap.get(id) || 0,
        tolangan: paidMap.get(id) || 0,
      };
    }));
  }),

  // GET /api/admin/promo/billing/:restaurantId
  billingHistory: asyncHandler(async (req, res) => {
    const items = await PromoBilling.find({ restaurantId: req.params.restaurantId })
      .sort({ periodStart: -1 })
      .limit(100)
      .lean();

    const { debt, periods } = await getDebt(req.params.restaurantId);
    res.json({ items, debt, periods });
  }),

  // POST /api/admin/promo/billing/:restaurantId/pay
  markPaid: asyncHandler(async (req, res) => {
    const { debt } = await getDebt(req.params.restaurantId);
    if (debt <= 0) {
      return res.status(400).json({ error: 'Qarz yo\u2018q' });
    }

    const result = await markDebtPaid(req.params.restaurantId, req.userId, 'manual');
    res.json({ ...result, message: `${result.paid.toLocaleString('ru-RU')} so\u2018m to\u2018landi deb belgilandi` });
  }),

  // PATCH /api/admin/promo/subscription/:restaurantId  { status }
  setStatus: asyncHandler(async (req, res) => {
    const status = req.body.status;
    if (!['active', 'suspended', 'expired'].includes(status)) {
      return res.status(400).json({ error: 'Noto\u2018g\u2018ri holat' });
    }

    const sub = await PromoSubscription.findOne({ restaurantId: req.params.restaurantId });
    if (!sub) return res.status(404).json({ error: 'Obuna topilmadi' });

    sub.status = status;
    if (status === 'suspended') {
      sub.suspendedAt = new Date();
      sub.suspendReason = String(req.body.reason || '').slice(0, 200);
    } else if (status === 'active') {
      // Qayta yoqilganda hisob shu paytdan boshlanadi —
      // to'xtatilgan davr uchun qarz yozilmaydi
      sub.lastBilledAt = new Date();
      sub.suspendedAt = null;
      sub.suspendReason = '';
    }
    await sub.save();

    res.json(sub);
  }),

  // GET /api/admin/promo/tariff
  getTariff: asyncHandler(async (_req, res) => {
    const settings = await getSettings();
    const history = await PromoTariffLog.find().sort({ createdAt: -1 }).limit(20).lean();

    res.json({
      dailyPrice: settings.promoDailyPrice || 15000,
      deductFromSettlement: Boolean(settings.promoDeductFromSettlement),
      allowDiscountStacking: Boolean(settings.allowDiscountStacking),
      history,
    });
  }),

  // PATCH /api/admin/promo/tariff
  updateTariff: asyncHandler(async (req, res) => {
    const schema = z.object({
      dailyPrice: z.number().min(0).max(1000000).optional(),
      deductFromSettlement: z.boolean().optional(),
      allowDiscountStacking: z.boolean().optional(),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Noto\u2018g\u2018ri qiymat' });
    }

    const settings = await getSettings();
    let tariffResult = null;

    if (parsed.data.dailyPrice != null) {
      tariffResult = await changeTariff(parsed.data.dailyPrice, req.userId, 'Admin');
    }
    if (parsed.data.deductFromSettlement != null) {
      settings.promoDeductFromSettlement = parsed.data.deductFromSettlement;
    }
    if (parsed.data.allowDiscountStacking != null) {
      settings.allowDiscountStacking = parsed.data.allowDiscountStacking;
    }
    await settings.save();

    res.json({
      dailyPrice: settings.promoDailyPrice,
      deductFromSettlement: settings.promoDeductFromSettlement,
      allowDiscountStacking: settings.allowDiscountStacking,
      tariffChanged: tariffResult?.changed || false,
    });
  }),

  // POST /api/admin/promo/billing/run — qo'lda ishga tushirish
  runBilling: asyncHandler(async (_req, res) => {
    const count = await runBillingCycle();
    res.json({ periods: count });
  }),
};
