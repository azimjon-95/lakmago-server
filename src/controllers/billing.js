import { z } from 'zod';
import { asyncHandler } from '../middleware/error.js';
import { Ledger } from '../models/Ledger.js';
import { Restaurant } from '../models/Restaurant.js';
import { recordPayout, getRestaurantSummary, getAllRestaurantsOrderCounts } from '../services/billing.js';
import { Order } from '../models/Order.js';
import { tiyinToSom } from '../services/orderFinance.js';

/*
 * ═══ CLICK ULUSHI ═══
 *
 * To'lov tizimi mijoz to'lovidan 1.5% ushlab qoladi va qolganini
 * LokmaGo hisobiga tashlaydi. Bu xarajat LokmaGo ULUSHIDAN
 * chiqadi — restoran ulushi undan kamaymaydi.
 *
 * Shuning uchun moliya bo'limida uchta raqam ko'rsatiladi:
 *   Komissiya (brutto) — kelishuv bo'yicha LokmaGo daromadi
 *   Click 1.5%         — to'lov tizimi ushlagani
 *   Sof daromad        — brutto − Click
 *
 * Summalar buyurtmaning `finance` snapshot'idan olinadi (u
 * buyurtma paytidagi shartlar bilan muzlatilgan). Naqd
 * buyurtmalarda Click haqi 0 — u hech qanday shlyuzga tegmaydi.
 *
 * Eski (snapshot'siz) buyurtmalarda bu ma'lumot yo'q: o'sha
 * paytda Click haqi alohida yozilmasdi. Ular 0 sifatida
 * qo'shiladi va hisobotda "legacy" deb ajratilmaydi — brutto
 * raqam baribir to'g'ri.
 */
export async function clickFeeByRestaurant() {
  const rows = await Order.aggregate([
    { $match: { 'finance.model': 'v2', 'finance.clickFeeAmount': { $gt: 0 } } },
    { $project: { restaurantId: 1, fee: '$finance.clickFeeAmount' } },
    { $group: { _id: '$restaurantId', fee: { $sum: '$fee' } } },
  ]).catch(() => []);

  const map = new Map();
  let total = 0;
  for (const r of rows) {
    const som = tiyinToSom(r.fee || 0);
    map.set(String(r._id), som);
    total += som;
  }
  return { map, total };
}

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

    const { total: clickFee } = await clickFeeByRestaurant();

    const komissiya = t.commission || 0;
    const qaytarilgan = Math.abs(t.refund || 0);

    res.json({
      tushum: t.payment_in || 0,
      komissiya,
      restoranlarUlushi: t.restaurant_due || 0,
      tolangan: Math.abs(t.payout || 0),
      qaytarilgan,
      // To'lov tizimi ushlagan summa — LokmaGo ulushidan chiqadi
      clickFee,
      /*
       * Platformada QOLGAN pul: kelishuv bo'yicha komissiya,
       * minus to'lov tizimi haqi, minus qaytarilganlar.
       */
      platformaDaromadi: komissiya - clickFee - qaytarilgan,
      // Click ayirilmasidan oldingi summa (solishtirish uchun)
      komissiyaBrutto: komissiya,
      restoranlargaQarz: totalDebt,
    });
  }),

  /*
   * GET /api/admin/billing/restaurants — restoranlar bo'yicha
   *
   * `from`/`to` ixtiyoriy: berilsa naqd/karta BUYURTMA SONI
   * shu oraliq bo'yicha hisoblanadi (Order.updatedAt). Summalar
   * (tushum, komissiya, balans) esa doim JAMI — Ledger'dan,
   * chunki balans "hozirgi holat", bir kunlik emas.
   */
  byRestaurant: asyncHandler(async (req, res) => {
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
    const counts = await getAllRestaurantsOrderCounts(req.query.from, req.query.to);
    const { map: clickMap } = await clickFeeByRestaurant();

    res.json(restaurants.map((r) => {
      const types = Object.fromEntries(
        (map.get(String(r._id)) || []).map((x) => [x.type, x.total]),
      );
      const c = counts.get(String(r._id)) || { cashCount: 0, cardCount: 0 };
      return {
        _id: r._id,
        name: r.name,
        commissionPercent: r.commissionPercent,
        commissionMode: r.commissionMode,
        tushum: types.payment_in || 0,
        // Kelishuv bo'yicha LokmaGo daromadi (Click ayirilmagan)
        komissiya: types.commission || 0,
        // To'lov tizimi ushlagani — shu komissiya ICHIDAN chiqadi
        clickFee: clickMap.get(String(r._id)) || 0,
        sofKomissiya: (types.commission || 0) - (clickMap.get(String(r._id)) || 0),
        balans: r.balance || 0,
        tolangan: r.totalPaidOut || 0,
        // Naqd/karta buyurtma soni — tanlangan sana oralig'i bo'yicha
        cashCount: c.cashCount,
        cardCount: c.cardCount,
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
      /*
       * Majburiy — TZ 16-band: takroriy yuborishdan himoya.
       * Mijoz (admin.jsx) buni so'rov yuborilishidan oldin bir
       * marta generatsiya qiladi. Backend uni Payout hujjatining
       * unique kalitiga aylantiradi.
       */
      idempotencyKey: z.string().min(8).max(100),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Noto‘g‘ri ma‘lumot' });
    }

    try {
      const result = await recordPayout(
        parsed.data.restaurantId,
        parsed.data.amount,
        req.userId,
        parsed.data.note,
        parsed.data.idempotencyKey,
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
      return res.status(400).json({ error: 'Noto‘g‘ri qiymat' });
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
