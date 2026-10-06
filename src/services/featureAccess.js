import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';
import { User } from '../models/User.js';

/*
 * ═══ YANGI BO'LIMLARNI BOSQICHMA-BOSQICH OCHISH (feature flags) ═══
 *
 * .env:
 *   LOKMA_MARKET_ACCESS=all                  → hammaga ko'rinadi
 *   LOKMA_MARKET_ACCESS=12345678,87654321    → faqat shu Telegram ID'larga
 *   LOKMA_MARKET_ACCESS=                     → hech kimga (yashirin)
 *   LOKMA_WEDDING_ACCESS — xuddi shunday ("To'yxonalar" tugmasi, hozircha "Tez orada")
 *
 * Test qilish: avval o'z ID'laringizni yozing → sinab ko'ring →
 * `all` qiling → server restart. Kalit yo'q bo'lsa — yashirin
 * (xavfsiz standart: tasodifan hammaga ochilib qolmaydi).
 *
 * Ruxsat SERVERDA tekshiriladi: tugma yashirilgan mijoz /api/market/*
 * ga to'g'ridan-to'g'ri so'rov yuborsa ham ma'lumot olmaydi.
 */
export const FEATURE_ENV = {
  market: 'LOKMA_MARKET_ACCESS',
  wedding: 'LOKMA_WEDDING_ACCESS',
};

function parseRule(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return { all: false, ids: new Set() };
  if (s.toLowerCase() === 'all') return { all: true, ids: new Set() };
  return { all: false, ids: new Set(s.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean)) };
}

/** Qoida — env'dan har safar o'qiladi (arzon; testda process.env o'zgartirish oson). */
export function featureRule(name) {
  return parseRule(process.env[FEATURE_ENV[name]]);
}

// Foydalanuvchi → Telegram ID (5 daqiqa xotirada — har so'rovda bazaga bormaslik uchun)
const tgCache = new Map();
const TG_TTL = 5 * 60 * 1000;

async function telegramIdOf(userId) {
  if (!userId) return '';
  const key = String(userId);
  const hit = tgCache.get(key);
  if (hit && hit.exp > Date.now()) return hit.tg;
  const u = await User.findById(key).select('telegramId').lean().catch(() => null);
  const tg = u?.telegramId ? String(u.telegramId) : '';
  if (tgCache.size > 5000) tgCache.clear();
  tgCache.set(key, { tg, exp: Date.now() + TG_TTL });
  return tg;
}

/** Bearer token bo'lsa — userId (yo'q yoki yaroqsiz bo'lsa — null, xato bermaydi). */
export function optionalUserId(req) {
  if (req.userId) return req.userId;
  const h = req.headers?.authorization;
  if (!h?.startsWith('Bearer ')) return null;
  try {
    return jwt.verify(h.slice(7), config.jwtSecret)?.userId || null;
  } catch {
    return null;
  }
}

/** Shu so'rov egasiga bo'lim ochiqmi. */
export async function hasFeature(req, name) {
  const rule = featureRule(name);
  if (rule.all) return true;
  if (!rule.ids.size) return false;
  const tg = await telegramIdOf(optionalUserId(req));
  return Boolean(tg) && rule.ids.has(tg);
}

/** Express middleware: bo'lim yopiq bo'lsa 403. */
export function requireFeature(name) {
  return async (req, res, next) => {
    try {
      if (await hasFeature(req, name)) return next();
      return res.status(403).json({ error: 'Bu bo‘lim hozircha mavjud emas', code: 'FEATURE_DISABLED' });
    } catch (e) { return next(e); }
  };
}
