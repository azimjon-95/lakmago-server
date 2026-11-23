import { asyncHandler } from '../middleware/error.js';
import { Ledger } from '../models/Ledger.js';
import {
  buildRestaurantSummary,
  buildRestaurantDaily,
  buildRestaurantOrderList,
  reportPeriod,
  restaurantLedgerView,
  toOid,
} from '../services/restaurantReport.js';

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
 *
 * Hisob-kitob — services/restaurantReport.js (2026-11-23 audit:
 * eski aggregate'lar string ID sababli hech narsa topmasdi).
 * Sana: `from`/`to` — "YYYY-MM-DD" (Toshkent kuni, ikkala chegara
 * kiradi). Noto'g'ri sana → 400 (PeriodError).
 * ═══════════════════════════════════════════════════════════
 */

export const restaurantBillingController = {
  /**
   * GET /api/panel/billing/summary?from=&to=   (bo'sh — bugun)
   *
   *   orders  — davrda YETKAZILGAN buyurtmalar: soni, naqd/karta,
   *             yetkazish/olib ketish/zal, top taomlar, bekorlar
   *   finance — shu buyurtmalar bo'yicha taom savdosi, restoran
   *             komissiyasi, mijoz xizmat haqi, ulush, naqdda LokmaGo
   *             qismi, karta ulushi, davrdagi o'tkazmalar
   *   payout  — UMUMIY balans (davrga bog'liq emas), oxirgi o'tkazma
   */
  summary: asyncHandler(async (req, res) => {
    res.json(await buildRestaurantSummary(req.restaurantId, req.query));
  }),

  /** GET /api/panel/billing/daily?from=&to=   (bo'sh — shu oy) */
  daily: asyncHandler(async (req, res) => {
    res.json(await buildRestaurantDaily(req.restaurantId, req.query));
  }),

  /** GET /api/panel/billing/orders?from=&to=&limit=   (bo'sh — bugun) */
  orders: asyncHandler(async (req, res) => {
    res.json(await buildRestaurantOrderList(req.restaurantId, req.query));
  }),

  /**
   * GET /api/panel/billing/ledger?from=&to=&type=&limit=
   *
   * Batafsil jurnal — har bir yozuv alohida qatorda (masalan
   * type=payout — o'tkazmalar tarixi). `meta` restoranga
   * CHIQMAYDI (LokmaGo sof daromadi, Click haqi) — faqat izoh.
   */
  ledger: asyncHandler(async (req, res) => {
    const filter = { restaurantId: toOid(req.restaurantId) };
    if (req.query.type) filter.type = String(req.query.type);
    if (req.query.from || req.query.to) {
      filter.createdAt = reportPeriod(req.query).period.cond;
    }

    const limit = Math.min(Number(req.query.limit) || 100, 300);
    const items = await Ledger.find(filter)
      .populate('orderId', 'total status paymentMethod dailyNumber')
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    res.json(items.map(restaurantLedgerView));
  }),
};
