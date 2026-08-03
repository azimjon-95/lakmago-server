import { asyncHandler } from '../middleware/error.js';
import { Promotion } from '../models/Promotion.js';
import { AdCampaign } from '../models/AdCampaign.js';
import { PromoSubscription } from '../models/PromoBilling.js';
import { Restaurant } from '../models/Restaurant.js';
import { Dish } from '../models/Dish.js';

/**
 * Client va Dine-in uchun YAGONA manba.
 *
 * Aksiya va reklama ma'lumotlari alohida yaratilmaydi —
 * ikkala interfeys shu API'dan oladi.
 */

/** Obunasi to'xtatilgan restoranlarni chetlab o'tamiz. */
async function activeRestaurantIds() {
  const suspended = await PromoSubscription.find({
    status: { $in: ['suspended'] },
  }).select('restaurantId').lean();

  return new Set(suspended.map((s) => String(s.restaurantId)));
}

export const publicPromoController = {
  /**
   * GET /api/promotions?restaurantId=&category=&dishId=
   *
   * Faol aksiyalar. Muddati tugagani avtomatik chiqmaydi.
   */
  list: asyncHandler(async (req, res) => {
    const now = new Date();
    const filter = {
      isActive: true,
      startsAt: { $lte: now },
      endsAt: { $gte: now },
    };

    if (req.query.restaurantId) filter.restaurantId = req.query.restaurantId;

    let promos = await Promotion.find(filter)
      .select('name discountType discountValue scope categories dishIds minOrderAmount restaurantId endsAt maxUses usedCount')
      .limit(50)
      .lean();

    // Limiti tugaganlarni chiqaramiz
    promos = promos.filter((p) => p.maxUses === 0 || p.usedCount < p.maxUses);

    // To'xtatilgan obunalar
    const suspended = await activeRestaurantIds();
    promos = promos.filter((p) => !suspended.has(String(p.restaurantId)));

    // Kategoriya yoki taom bo'yicha filtr
    if (req.query.category) {
      promos = promos.filter((p) =>
        p.scope === 'all' || p.categories?.includes(req.query.category));
    }
    if (req.query.dishId) {
      promos = promos.filter((p) =>
        p.scope === 'all'
        || p.dishIds?.some((id) => String(id) === req.query.dishId));
    }

    // Restoran nomlarini qo'shamiz
    const restIds = [...new Set(promos.map((p) => String(p.restaurantId)))];
    const rests = await Restaurant.find({
      _id: { $in: restIds },
      isActive: true, isBlocked: { $ne: true }, isApproved: true,
    }).select('name imageUrl tint').lean();

    const restMap = new Map(rests.map((r) => [String(r._id), r]));

    res.json(
      promos
        .filter((p) => restMap.has(String(p.restaurantId)))
        .map((p) => {
          const r = restMap.get(String(p.restaurantId));
          return {
            id: String(p._id),
            name: p.name,
            discountType: p.discountType,
            discountValue: p.discountValue,
            scope: p.scope,
            categories: p.categories,
            minOrderAmount: p.minOrderAmount,
            endsAt: p.endsAt,
            restaurantId: String(p.restaurantId),
            restaurantName: r.name,
            restaurantImage: r.imageUrl,
            restaurantTint: r.tint,
          };
        }),
    );
  }),

  /**
   * GET /api/ads?placement=home|category|search
   *
   * Faol reklamalar. Kunlik budjet tugagani chiqmaydi.
   */
  ads: asyncHandler(async (req, res) => {
    const placement = req.query.placement;
    if (!['home', 'category', 'search'].includes(placement)) {
      return res.json([]);
    }

    const now = new Date();
    const today = now.toISOString().slice(0, 10);

    let ads = await AdCampaign.find({
      isActive: true,
      placements: placement,
      startsAt: { $lte: now },
      endsAt: { $gte: now },
    }).limit(20).lean();

    // Kunlik budjet tugaganlarni chiqaramiz
    ads = ads.filter((a) => !(a.todayDate === today && a.todaySpent >= a.dailyBudget));

    const suspended = await activeRestaurantIds();
    ads = ads.filter((a) => !suspended.has(String(a.restaurantId)));

    if (ads.length === 0) return res.json([]);

    // Restoran va taom ma'lumotlari
    const restIds = ads.map((a) => a.restaurantId);
    const dishIds = ads.filter((a) => a.dishId).map((a) => a.dishId);

    const [rests, dishes] = await Promise.all([
      Restaurant.find({
        _id: { $in: restIds },
        isActive: true, isBlocked: { $ne: true }, isApproved: true,
      }).select('name imageUrl tint icon cuisine rating deliveryMin deliveryMax').lean(),
      dishIds.length
        ? Dish.find({ _id: { $in: dishIds }, isAvailable: true })
            .select('name price oldPrice imageUrl category restaurantId').lean()
        : [],
    ]);

    const restMap = new Map(rests.map((r) => [String(r._id), r]));
    const dishMap = new Map(dishes.map((d) => [String(d._id), d]));

    res.json(
      ads
        .filter((a) => restMap.has(String(a.restaurantId)))
        .filter((a) => a.targetType !== 'dish' || dishMap.has(String(a.dishId)))
        .map((a) => ({
          id: String(a._id),
          targetType: a.targetType,
          restaurant: restMap.get(String(a.restaurantId)),
          dish: a.dishId ? dishMap.get(String(a.dishId)) : null,
        })),
    );
  }),

  /**
   * POST /api/ads/:id/event  { type: 'impression' | 'click' }
   *
   * Ko'rish va bosishlarni qayd etadi. Bosish uchun kunlik
   * budjetdan yechiladi.
   */
  trackEvent: asyncHandler(async (req, res) => {
    const type = req.body.type;
    if (!['impression', 'click'].includes(type)) {
      return res.status(400).json({ error: 'Noto\u2018g\u2018ri hodisa' });
    }

    const ad = await AdCampaign.findById(req.params.id);
    if (!ad) return res.status(404).json({ error: 'Reklama topilmadi' });

    const today = new Date().toISOString().slice(0, 10);
    // Kun almashgan — hisobni tozalaymiz
    if (ad.todayDate !== today) {
      ad.todayDate = today;
      ad.todaySpent = 0;
    }

    if (type === 'impression') {
      ad.stats.impressions += 1;
    } else {
      ad.stats.clicks += 1;
      // Bosish narxi — kunlik budjetning 1%
      const clickCost = Math.max(100, Math.round(ad.dailyBudget * 0.01));
      ad.todaySpent += clickCost;
      ad.stats.spent += clickCost;
    }

    await ad.save();
    res.json({ ok: true });
  }),
};
