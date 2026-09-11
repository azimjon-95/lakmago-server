import { asyncHandler } from '../middleware/error.js';
import { config } from '../config/index.js';
import { Restaurant } from '../models/Restaurant.js';
import { Dish } from '../models/Dish.js';
import crypto from 'crypto';

const isValidId = (id) => typeof id === 'string' && /^[a-f\d]{24}$/i.test(id);

/** Timing-safe parol solishtirish */
function passwordOk(given) {
  const expected = config.jRoutePassword;
  if (!expected) return false;
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    // uzunlik farq qilsa ham constant-time taqqoslash uchun fake
    crypto.timingSafeEqual(Buffer.alloc(b.length), b);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

/**
 * GET /j/:password/:restaurantId
 *
 * Env dagi J_ROUTE_PASSWORD (masalan 4454) bilan himoyalangan.
 * Restoran hujjati + shu restoranga tegishli BARCHA taomlar
 * (mavjud/mavjud emas) bitta katta JSON da qaytariladi.
 */
export const jDumpController = {
  dump: asyncHandler(async (req, res) => {
    const { password, restaurantId } = req.params;

    // Parol sozlanmagan yoki noto'g'ri — mavjud emasdek ko'rsatamiz
    if (!config.jRoutePassword || !passwordOk(password)) {
      return res.status(404).json({ error: 'Not found' });
    }

    if (!isValidId(restaurantId)) {
      return res.status(400).json({ error: 'Noto\'g\'ri restoran ID' });
    }

    const restaurant = await Restaurant.findById(restaurantId).lean();
    if (!restaurant) {
      return res.status(404).json({ error: 'Restoran topilmadi' });
    }

    const dishes = await Dish.find({ restaurantId })
      .sort({ section: 1, name: 1 })
      .lean();

    // Bo'limlar bo'yicha guruhlash (menyu qulayroq ko'rinsin)
    const menuBySection = {};
    for (const d of dishes) {
      const sec = d.section || 'Boshqa';
      if (!menuBySection[sec]) menuBySection[sec] = [];
      menuBySection[sec].push(d);
    }

    res.json({
      ok: true,
      exportedAt: new Date().toISOString(),
      restaurant,
      dishes,
      menuBySection,
      meta: {
        dishCount: dishes.length,
        availableCount: dishes.filter((d) => d.isAvailable !== false).length,
        sections: Object.keys(menuBySection),
      },
    });
  }),
};
