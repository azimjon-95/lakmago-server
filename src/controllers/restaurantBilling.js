import { asyncHandler } from '../middleware/error.js';
import {
  getRestaurantOrderStats,
  getRestaurantDailyLedger,
  getRestaurantPendingPayout,
} from '../services/billing.js';
import { Ledger } from '../models/Ledger.js';

/*
 * ═══════════════════════════════════════════════════════════
 * RESTORAN O'ZI KO'RADIGAN MOLIYAVIY HISOBOT.
 *
 * XAVFSIZLIK QOIDASI — BUTUN FAYL BO'YICHA:
 * restaurantId HECH QACHON req.query yoki req.params'dan
 * olinmaydi. Faqat `req.restaurantId` — bu auth middleware
 * tomonidan JWT token ichidan qo'yiladi (requireRole('restaurant')
 * bilan birga, routes/index.js). Ya'ni restoran A hech qanday
 * so'rov bilan restoran B ning moliyaviy ma'lumotini so'ray
 * olmaydi — buni token almashtirib bo'lmaydi.
 * ═══════════════════════════════════════════════════════════
 */

export const restaurantBillingController = {
  /**
   * GET /api/panel/billing/summary?from=&to=
   *
   * Bosh sahifa uchun bitta chaqiruvda hammasi:
   *   - buyurtmalar soni (jami, naqd, karta) va summalari
   *   - balans (musbat = LokmaGo qarzdor, manfiy = restoran qarzdor)
   *   - jami hozirgacha o'tkazilgan summa
   *
   * `from`/`to` berilmasa — BUGUN.
   */
  summary: asyncHandler(async (req, res) => {
    const restaurantId = req.restaurantId;
    const { from, to } = req.query;

    const [orders, payout] = await Promise.all([
      getRestaurantOrderStats(restaurantId, from, to),
      getRestaurantPendingPayout(restaurantId),
    ]);

    res.json({ orders, payout });
  }),

  /**
   * GET /api/panel/billing/daily?from=&to=
   *
   * Kunlik jadval — "qachon qancha o'tkazildi" ro'yxati.
   * Standart oraliq: shu oyning boshidan bugungacha (bitta
   * kun emas, chunki jadval tabiiy ravishda bir necha kunni
   * qamrab ko'rsatilishi kutiladi — 'summary' esa bitta kun
   * uchun).
   */
  daily: asyncHandler(async (req, res) => {
    const restaurantId = req.restaurantId;
    let { from, to } = req.query;

    if (!from && !to) {
      const now = new Date();
      from = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
      to = now.toISOString();
    }

    const rows = await getRestaurantDailyLedger(restaurantId, from, to);
    res.json(rows);
  }),

  /**
   * GET /api/panel/billing/ledger?from=&to=&type=&limit=
   *
   * Batafsil jurnal — har bir yozuv alohida qatorda. Restoran
   * "aynan qaysi buyurtma uchun bu summa" deb so'rasa shu yerdan
   * ko'radi. LokmaGo admin panelidagi /admin/billing/ledger bilan
   * bir xil mantiq, farqi: restaurantId SO'ROVDAN emas, TOKEN'dan.
   */
  ledger: asyncHandler(async (req, res) => {
    const filter = { restaurantId: req.restaurantId };
    if (req.query.type) filter.type = req.query.type;
    if (req.query.from || req.query.to) {
      filter.createdAt = {};
      if (req.query.from) filter.createdAt.$gte = new Date(req.query.from);
      if (req.query.to) filter.createdAt.$lte = new Date(req.query.to);
    }

    const limit = Math.min(Number(req.query.limit) || 100, 300);
    const items = await Ledger.find(filter)
      .populate('orderId', 'total status paymentMethod')
      .sort({ createdAt: -1 })
      .limit(limit)
      .select('-createdBy')   // admin ID'si restoranga tegishli emas
      .lean();

    res.json(items);
  }),
};
