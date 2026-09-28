import { z } from 'zod';
import { asyncHandler } from '../middleware/error.js';
import { Ledger } from '../models/Ledger.js';
import { Restaurant } from '../models/Restaurant.js';
import { recordPayout, getRestaurantSummary, getAllRestaurantsOrderCounts } from '../services/billing.js';
import { Order } from '../models/Order.js';
import { tiyinToSom } from '../services/orderFinance.js';
import { User } from '../models/User.js';
import { orderLabel } from '../services/orderNumber.js';
import { canAccessPage } from '../config/permissions.js';
import { resolvePeriod, deliveredWindow, paymentGroupFilter } from '../services/billingPeriod.js';

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

/*
 * Tanlangan DAVR uchun restoranlar bo'yicha summalar.
 *
 * Ledger yozuvlari — pul HARAKATI vaqti bo'yicha (createdAt):
 * tushum, komissiya, restoran ulushi, o'tkazilgan (payout).
 * Click haqi — buyurtma yetkazilgan sana bo'yicha (komissiya ham
 * shu paytda hisoblanadi, shuning uchun "komissiya − Click" davr
 * ichida ham to'g'ri chiqadi).
 *
 * `$project` + `$group` ikki bosqichda (clickFeeByRestaurant
 * kabi): ichki maydonni to'g'ridan-to'g'ri $sum qilish ba'zi
 * MongoDB-mos bazalarda 0 qaytaradi.
 */
async function periodStatsByRestaurant(period) {
  const ledgerRows = await Ledger.aggregate([
    { $match: { restaurantId: { $ne: null }, createdAt: period.cond } },
    { $group: { _id: { restaurantId: '$restaurantId', type: '$type' }, total: { $sum: '$amount' } } },
  ]);
  /*
   * Click haqi — aggregatsiya EMAS, oddiy find + JS'da yig'ish:
   * ichki maydon ('finance.clickFeeAmount') ustida $project+$sum
   * ba'zi MongoDB-mos bazalarda 0 qaytaradi va uni sinab
   * ko'rib bo'lmaydi. Davr cheklangan (<=400 kun) va faqat karta
   * buyurtmalari — hajm kichik. 200 000 — xotira uchun himoya.
   */
  const clickOrders = await Order.find({
    status: 'delivered',
    'finance.model': 'v2',
    'finance.clickFeeAmount': { $gt: 0 },
    ...deliveredWindow(period),
  }).select('restaurantId finance.clickFeeAmount').limit(200000).lean();
  const clickRows = [];
  const feeSums = new Map();
  for (const o of clickOrders) {
    const k = String(o.restaurantId);
    feeSums.set(k, (feeSums.get(k) || 0) + (o.finance?.clickFeeAmount || 0));
  }
  for (const [id, fee] of feeSums) clickRows.push({ _id: id, fee });

  const byId = new Map();
  const bucket = (id) => {
    const k = String(id);
    if (!byId.has(k)) byId.set(k, { types: {}, clickFee: 0 });
    return byId.get(k);
  };
  for (const r of ledgerRows) bucket(r._id.restaurantId).types[r._id.type] = r.total;
  for (const r of clickRows) bucket(r._id).clickFee = tiyinToSom(r.fee || 0);

  const out = new Map();
  for (const [id, { types, clickFee }] of byId) {
    const komissiya = types.commission || 0;
    out.set(id, {
      tushum: types.payment_in || 0,
      komissiya,
      clickFee,
      sofKomissiya: komissiya - clickFee,
      restoranUlushi: types.restaurant_due || 0,
      tolangan: Math.abs(types.payout || 0),
      qaytarilgan: Math.abs(types.refund || 0),
    });
  }
  return out;
}

const EMPTY_PERIOD = {
  tushum: 0, komissiya: 0, clickFee: 0, sofKomissiya: 0, restoranUlushi: 0, tolangan: 0, qaytarilgan: 0,
};

const isObjectId = (v) => typeof v === 'string' && /^[a-f\d]{24}$/i.test(v);

export const billingController = {
  // GET /api/admin/billing/overview — umumiy holat
  overview: asyncHandler(async (req, res) => {
    const match = {};
    const overviewPeriod = resolvePeriod(req.query.from, req.query.to);
    if (overviewPeriod) match.createdAt = overviewPeriod.cond;

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
    // Noto'g'ri sana bo'lsa — 400 (jimgina e'tiborsiz qoldirilmaydi)
    const period = resolvePeriod(req.query.from, req.query.to);
    /*
     * Bir bosqichli $group + JS'da yig'ish. Avval ikkinchi $group
     * `$push` ishlatardi — natija bir xil, lekin ba'zi MongoDB-mos
     * bazalarda ($push) qo'llanmaydi va so'rov 500 berardi.
     */
    const rows = await Ledger.aggregate([
      { $match: { restaurantId: { $ne: null } } },
      {
        $group: {
          _id: { restaurantId: '$restaurantId', type: '$type' },
          total: { $sum: '$amount' },
        },
      },
    ]);
    const typesByRestaurant = new Map();
    for (const r of rows) {
      const k = String(r._id.restaurantId);
      if (!typesByRestaurant.has(k)) typesByRestaurant.set(k, {});
      typesByRestaurant.get(k)[r._id.type] = r.total;
    }

    const restaurants = await Restaurant.find({})
      .select('name balance totalPaidOut commissionPercent commissionMode')
      .lean();

    
    const counts = await getAllRestaurantsOrderCounts(req.query.from, req.query.to);
    const { map: clickMap } = await clickFeeByRestaurant();
    const periodMap = period ? await periodStatsByRestaurant(period) : null;
    res.json(restaurants.map((r) => {
      const types = typesByRestaurant.get(String(r._id)) || {};
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
        /*
         * Davr tanlangan bo'lsa — SHU DAVR uchun summalar.
         * Yuqoridagi tushum/komissiya/tolangan doim JAMI qoladi,
         * `balans` esa hozirgi holat (bir kunlik emas).
         */
        period: periodMap ? (periodMap.get(String(r._id)) || EMPTY_PERIOD) : null,
      };
    }));
  }),

  // GET /api/admin/billing/ledger — batafsil jurnal
  ledger: asyncHandler(async (req, res) => {
    const filter = {};
    if (req.query.restaurantId) filter.restaurantId = req.query.restaurantId;
    if (req.query.type) filter.type = req.query.type;
    const ledgerPeriod = resolvePeriod(req.query.from, req.query.to);
    if (ledgerPeriod) filter.createdAt = ledgerPeriod.cond;

    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const items = await Ledger.find(filter)
      .populate('restaurantId', 'name')
      .populate('orderId', 'total status')
      .sort({ createdAt: -1 })
        .limit(limit)
      .lean();

    /*
     * "Kim o'tkazdi" — createdBy → ism. populate ishlatilmaydi:
     * `createdBy` ref'i 'Admin', xodimlar esa 'User' kolleksiyasida.
     */
    const ids = [...new Set(items.map((i) => i.createdBy).filter(Boolean).map(String))];
    if (ids.length) {
      const users = await User.find({ _id: { $in: ids } }).select('firstName lastName login').lean();
      const names = new Map(users.map((u) => [String(u._id),
        [u.firstName, u.lastName].filter(Boolean).join(' ') || u.login || '']));
      for (const it of items) it.createdByName = it.createdBy ? (names.get(String(it.createdBy)) || '') : '';
    }
    res.json(items);
  }),

  /*
   * GET /api/admin/billing/restaurant/:id/orders?method=cash|card&from&to
   *
   * Restoran kartasidagi "Naqd: N ta" / "Karta: N ta" sonining
   * ORQASIDAGI buyurtmalar. Sanash qoidasi AYNAN bir xil
   * (services/billing.js getAllRestaurantsOrderCounts): faqat
   * yetkazilgan, naqd yoki (naqd EMAS) karta, yetkazilgan sana
   * bo'yicha — shuning uchun ro'yxat uzunligi kartadagi songa teng.
   *
   * Summalar alohida ko'rsatiladi: taom puli, yetkazish puli,
   * mijoz xizmat haqi. Jami — mijoz HAQIQATDA to'lagan summa
   * (order.total); farq bo'lsa (chegirma, bonus) `adjustment`
   * sifatida chiqadi — ustunlar doim jamiga tenglashadi.
   *
   * MIJOZ MA'LUMOTI: faqat 'orders' sahifasiga ruxsati bor
   * xodim/admin ko'radi (DashboardPage dagi qoida bilan bir xil).
   * Buxgalterga restoran bilan hisob-kitob uchun buyurtma tarkibi
   * yetarli — mijozning ismi/telefoni kerak emas.
   */
  restaurantOrders: asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!isObjectId(id)) return res.status(400).json({ error: 'Noto‘g‘ri restoran ID' });

    const method = ['cash', 'card'].includes(req.query.method) ? req.query.method : 'all';
    const period = resolvePeriod(req.query.from, req.query.to);

    const restaurant = await Restaurant.findById(id).select('name').lean();
    if (!restaurant) return res.status(404).json({ error: 'Restoran topilmadi' });

    const LIMIT = 300;
    const filter = {
      restaurantId: id,
      status: 'delivered',
      ...paymentGroupFilter(method),
      ...deliveredWindow(period),
    };
    const [rows, count] = await Promise.all([
      Order.find(filter)
        .populate('userId', 'firstName lastName phone')
        .sort({ deliveredAt: -1, updatedAt: -1 })
        .limit(LIMIT)
        .lean(),
      Order.countDocuments(filter),
    ]);

    const seesCustomer = req.role === 'admin' || canAccessPage(req.role, req.department, 'orders');
    const round = (n) => Math.round((Number(n) || 0) * 100) / 100;

    const orders = rows.map((o) => {
      const f = o.finance?.model === 'v2' ? o.finance : null;
      const foodTotal = f ? tiyinToSom(f.foodSubtotal) : round(o.subtotal);
      const customerFee = f ? tiyinToSom(f.customerFeeAmount) : round(o.serviceFee);
      const deliveryFee = f ? tiyinToSom(f.deliveryFee) : round(o.deliveryFee);
      const total = round(o.total);
      const u = o.userId && typeof o.userId === 'object' ? o.userId : null;

      return {
        _id: o._id,
        label: orderLabel(o),
        createdAt: o.createdAt,
        deliveredAt: o.deliveredAt || o.updatedAt,
        fulfillment: o.fulfillment,
        paymentMethod: o.paymentMethod,
        method: o.paymentMethod === 'cash' ? 'cash' : 'card',
        isPaid: Boolean(o.isPaid),
        customer: seesCustomer && u
          ? { name: [u.firstName, u.lastName].filter(Boolean).join(' ') || 'Mijoz', phone: o.phone || u.phone || '' }
          : null,
        items: (o.items || []).map((it) => ({
          name: it.name,
          quantity: it.quantity,
          unitPrice: round(it.unitPrice),
          lineTotal: round((Number(it.unitPrice) || 0) * (Number(it.quantity) || 0)),
          options: (it.selectedOptions || []).map((x) => x.name).filter(Boolean),
        })),
        foodTotal,
        customerFee,
        deliveryFee,
        total,
        // Chegirma/bonus (manfiy) yoki boshqa qo'shimcha (musbat)
        adjustment: round(total - foodTotal - customerFee - deliveryFee),
        // Faqat v2 snapshot bor buyurtmalarda (eskilarida yo'q — null)
        restaurantShare: f ? tiyinToSom(f.restaurantPayout) : null,
        lokmaCommission: f ? tiyinToSom(f.lokmaGrossCommission) : null,
        clickFee: f ? tiyinToSom(f.clickFeeAmount) : null,
      };
    });

    const sum = (key) => round(orders.reduce((a, o) => a + (o[key] || 0), 0));
    res.json({
      restaurant: { _id: restaurant._id, name: restaurant.name },
      method,
      count,
      truncated: count > orders.length,
      totals: {
        foodTotal: sum('foodTotal'),
        customerFee: sum('customerFee'),
        deliveryFee: sum('deliveryFee'),
        adjustment: sum('adjustment'),
        total: sum('total'),
        restaurantShare: sum('restaurantShare'),
        lokmaCommission: sum('lokmaCommission'),
      },
      orders,
    });
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
