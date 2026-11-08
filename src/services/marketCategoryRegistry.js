import { MarketCategory } from '../models/MarketCategory.js';
import { MARKET_HOME_SEED } from '../constants/marketHomeSeed.js';

/*
 * Market kategoriyalari registri — YAGONA manba. Kesh: 30 soniya (yoki admin o'zgartirganda darhol).
 * Mahsulot kalitini tekshirish, do'kon formasi va Market qatori shu yerdan o'qiydi.
 */
const TTL_MS = 30_000;
let cache = null;
let cachedAt = 0;

/** Birinchi ishga tushishda boshlang'ich ro'yxatni yozadi. Mavjud kalitlarga TEGMAYDI (admin o'zgartirishlari saqlanadi). */
export async function seedMarketCategories() {
  for (const [i, c] of MARKET_HOME_SEED.entries()) {
    await MarketCategory.updateOne(
      { key: c.key },
      { $setOnInsert: { ...c, order: (i + 1) * 10, isActive: true, imageUrl: '' } },
      { upsert: true },
    );
  }
  invalidateMarketCategories();
}

export function invalidateMarketCategories() {
  cache = null;
}

function toView(r) {
  return {
    key: r.key,
    uz: r.nameUz,
    uzc: r.nameUzc || r.nameUz,
    ru: r.nameRu || r.nameUz,
    emoji: r.emoji || '🛒',
    imageUrl: r.imageUrl || '',
    order: r.order,
    isActive: r.isActive !== false,
  };
}

/** Barcha kategoriyalar (tartib bo'yicha). onlyActive=true — faqat faollari (mijoz va do'kon formasi uchun). */
export async function listMarketCategories({ onlyActive = true } = {}) {
  if (!cache || Date.now() - cachedAt > TTL_MS) {
    const rows = await MarketCategory.find({}).sort({ order: 1, _id: 1 }).lean();
    cache = rows.map(toView);
    cachedAt = Date.now();
  }
  return onlyActive ? cache.filter((c) => c.isActive) : cache;
}

/** Kalit ro'yxatda (faol yoki nofaol) bormi? Mahsulot yozishda va filtrda tekshiriladi. */
export async function isMarketCategoryKey(key) {
  if (!key || typeof key !== 'string') return false;
  const all = await listMarketCategories({ onlyActive: false });
  return all.some((c) => c.key === key);
}
