import { asyncHandler } from '../middleware/error.js';
import { MARKET_CATEGORIES, MARKET_GROUPS, MARKET_UNITS } from '../constants/marketCategories.js';
import { hasFeature } from '../services/featureAccess.js';

/*
 * ═══ LOKMA MARKET ═══
 *
 *   GET /api/features           — qaysi bo'limlar shu mijozga ochiq (tugmalar uchun)
 *   GET /api/market/categories  — mahsulot kategoriyalari, guruhlar, birliklar
 *   GET /api/market/stores      — do'konlar          (catalog.list,  marketMode)
 *   GET /api/market/products    — do'kon mahsulotlari (catalog.all,   marketMode)
 *
 * Do'kon va mahsulot ro'yxatlari restoran ro'yxatlari bilan BITTA kod
 * (controllers/catalog.js) — faqat `req.marketMode` filtrni almashtiradi.
 * Shu tufayli narx (yetkazish ustamasi), ish vaqti, sahifalash, adolatli
 * aralashtirish — hammasi restoranlardagi bilan aynan bir xil ishlaydi.
 * Do'kon sahifasi, savat, buyurtma — mavjud restoran oqimi orqali.
 */
export const marketController = {
  features: asyncHandler(async (req, res) => {
    const [market, wedding] = await Promise.all([hasFeature(req, 'market'), hasFeature(req, 'wedding')]);
    res.set('Cache-Control', 'private, no-store');
    res.json({ market, wedding });
  }),

  categories: (_req, res) => {
    res.set('Cache-Control', 'public, max-age=600');
    res.json({ groups: MARKET_GROUPS, categories: MARKET_CATEGORIES, units: MARKET_UNITS });
  },

  /** catalog kontrolleridan oldin: shu so'rov market rejimida */
  marketMode: (req, _res, next) => { req.marketMode = true; next(); },
};
