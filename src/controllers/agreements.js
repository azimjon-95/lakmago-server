import { z } from 'zod';
import { asyncHandler } from '../middleware/error.js';
import { CommissionAgreement, activeAgreement } from '../models/CommissionAgreement.js';
import { Restaurant } from '../models/Restaurant.js';

/**
 * Komissiya shartnomalari — admin paneli uchun.
 *
 * Har restoran bilan alohida kelishuv: 5%+5%, 0%+9%, 10%+0%.
 * Eski shartnoma o'chirilmaydi — arxivlanadi, chunki eski
 * buyurtmalar qaysi shart bo'yicha hisoblanganini bilish kerak.
 */

const agreementSchema = z.object({
  restaurantCommissionPercent: z.number().min(0).max(100),
  customerFeePercent: z.number().min(0).max(100),
  billingBase: z.enum(['CUSTOMER_FINAL_PRICE', 'DELIVERY_PRICE']).optional(),
  note: z.string().max(300).optional(),
});

export const agreementController = {
  /** GET /admin/agreements — barcha restoranlar va amaldagi shartnomasi */
  list: asyncHandler(async (_req, res) => {
    const restaurants = await Restaurant.find({})
      .select('name isActive deliveryMarkupPercent')
      .sort({ name: 1 })
      .lean();

    const active = await CommissionAgreement.find({ status: 'ACTIVE' }).lean();
    const byRestaurant = new Map(active.map((a) => [String(a.restaurantId), a]));

    res.json(restaurants.map((r) => {
      const a = byRestaurant.get(String(r._id));
      return {
        _id: r._id,
        name: r.name,
        isActive: r.isActive,
        deliveryMarkupPercent: r.deliveryMarkupPercent || 0,
        agreement: a ? {
          _id: a._id,
          restaurantCommissionPercent: a.restaurantCommissionPercent,
          customerFeePercent: a.customerFeePercent,
          totalSplitPercent: a.totalSplitPercent,
          billingBase: a.billingBase,
          effectiveFrom: a.effectiveFrom,
          note: a.note,
        } : null,
      };
    }));
  }),

  /**
   * PUT /admin/agreements/:restaurantId
   *
   * Yangi shartnoma. Eskisi arxivlanadi — o'chirilmaydi.
   */
  upsert: asyncHandler(async (req, res) => {
    const parsed = agreementSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Foizlar 0 dan 100 gacha bo\u2018lishi kerak' });
    }
    const { restaurantId } = req.params;

    const restaurant = await Restaurant.findById(restaurantId).select('_id').lean();
    if (!restaurant) return res.status(404).json({ error: 'Restoran topilmadi' });

    const now = new Date();

    // Eskisini yopamiz — tarix saqlanadi
    await CommissionAgreement.updateMany(
      { restaurantId, status: 'ACTIVE' },
      { status: 'ARCHIVED', effectiveTo: now },
    );

    const created = await CommissionAgreement.create({
      restaurantId,
      restaurantCommissionPercent: parsed.data.restaurantCommissionPercent,
      customerFeePercent: parsed.data.customerFeePercent,
      totalSplitPercent: parsed.data.restaurantCommissionPercent + parsed.data.customerFeePercent,
      billingBase: parsed.data.billingBase || 'CUSTOMER_FINAL_PRICE',
      note: parsed.data.note || '',
      effectiveFrom: now,
      status: 'ACTIVE',
      createdBy: req.userId,
    });

    res.status(201).json(created);
  }),

  /** GET /admin/agreements/:restaurantId/history — shartnomalar tarixi */
  history: asyncHandler(async (req, res) => {
    const items = await CommissionAgreement.find({ restaurantId: req.params.restaurantId })
      .sort({ effectiveFrom: -1 })
      .limit(50)
      .lean();
    res.json(items);
  }),

  /**
   * PATCH /panel/delivery-markup
   *
   * Restoran o'z yetkazish ustamasini belgilaydi.
   * Dine-in va bronga ta'sir qilmaydi.
   */
  setDeliveryMarkup: asyncHandler(async (req, res) => {
    const percent = Number(req.body?.deliveryMarkupPercent);
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
      return res.status(400).json({ error: 'Ustama 0 dan 100 gacha bo\u2018lishi kerak' });
    }

    const updated = await Restaurant.findByIdAndUpdate(
      req.restaurantId,
      { deliveryMarkupPercent: percent },
      { new: true },
    ).select('deliveryMarkupPercent').lean();

    if (!updated) return res.status(404).json({ error: 'Restoran topilmadi' });
    res.json(updated);
  }),

  /** GET /panel/agreement — restoran o'z shartini ko'radi (faqat o'qish) */
  myAgreement: asyncHandler(async (req, res) => {
    const a = await activeAgreement(req.restaurantId);
    const r = await Restaurant.findById(req.restaurantId)
      .select('deliveryMarkupPercent').lean();

    res.json({
      deliveryMarkupPercent: r?.deliveryMarkupPercent || 0,
      agreement: a ? {
        restaurantCommissionPercent: a.restaurantCommissionPercent,
        customerFeePercent: a.customerFeePercent,
        totalSplitPercent: a.totalSplitPercent,
        effectiveFrom: a.effectiveFrom,
      } : null,
    });
  }),
};
