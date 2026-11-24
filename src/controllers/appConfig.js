import { Settings, getSettings } from '../models/Settings.js';
import { asyncHandler } from '../middleware/error.js';
import { normalizeVersion } from '../services/clientChannel.js';

/*
 * ═══════════════════════════════════════════════════════════
 * MIJOZ ILOVASI SOZLAMASI — yangilanish va do'kon havolalari
 * ═══════════════════════════════════════════════════════════
 *
 * GET  /api/app/config        — ochiq (ilova ochilganda va fondan qaytganda)
 * GET  /api/admin/app-config  — admin
 * PATCH /api/admin/app-config — admin
 *
 * Ilova (lakmago-client lib/appUpdate.js):
 *   joriy < minVersion   → majburiy "Yangilang" (yopib bo'lmaydi)
 *   do'konda yangisi bor → Android: fonda yuklab o'rnatadi; iOS: taklif oynasi
 */
const DEFAULTS = {
  iosMinVersion: '', androidMinVersion: '',
  iosStoreUrl: '', androidStoreUrl: 'https://play.google.com/store/apps/details?id=lokma.uz',
  updatePromptDays: 3,
};
const STORE_URL = {
  ios: /^https:\/\/apps\.apple\.com\/[\w\-/%.?=&]+$/i,
  android: /^https:\/\/play\.google\.com\/store\/apps\/details\?id=[\w.]+[\w\-/%.?=&]*$/i,
};

let cache = { at: 0, data: null };
const CACHE_MS = 60_000;

export function publicAppConfig(raw = {}) {
  const c = { ...DEFAULTS, ...(raw || {}) };
  return {
    ios: { minVersion: normalizeVersion(c.iosMinVersion), storeUrl: c.iosStoreUrl || '' },
    android: { minVersion: normalizeVersion(c.androidMinVersion), storeUrl: c.androidStoreUrl || '' },
    updatePromptDays: Math.min(30, Math.max(1, Number(c.updatePromptDays) || 3)),
  };
}

/** Admin kiritgani. @returns {{ data, error? }} */
export function sanitizeAppConfig(input = {}) {
  const data = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(input, k);
  for (const [k, label] of [['iosMinVersion', 'iOS'], ['androidMinVersion', 'Android']]) {
    if (!has(k)) continue;
    const raw = String(input[k] ?? '').trim();
    const v = normalizeVersion(raw);
    if (raw && !v) return { data, error: `${label} minimal versiyasi noto‘g‘ri (masalan 1.2.0)` };
    data[k] = v;
  }
  for (const [k, p, label] of [['iosStoreUrl', 'ios', 'App Store'], ['androidStoreUrl', 'android', 'Google Play']]) {
    if (!has(k)) continue;
    const raw = String(input[k] ?? '').trim();
    if (raw && !STORE_URL[p].test(raw)) return { data, error: `${label} havolasi noto‘g‘ri` };
    data[k] = raw.slice(0, 300);
  }
  if (has('updatePromptDays')) data.updatePromptDays = Math.min(30, Math.max(1, Math.round(Number(input.updatePromptDays) || 3)));
  return { data };
}

export const appConfigController = {
  public: asyncHandler(async (_req, res) => {
    const now = Date.now();
    if (!cache.data || now - cache.at > CACHE_MS) {
      const s = await Settings.findOne({ key: 'global' }).select('clientApp').lean();
      cache = { at: now, data: publicAppConfig(s?.clientApp) };
    }
    res.set('Cache-Control', 'public, max-age=60').json(cache.data);
  }),

  get: asyncHandler(async (_req, res) => {
    const s = await getSettings();
    res.json({ ...DEFAULTS, ...(s.clientApp?.toObject?.() ?? s.clientApp ?? {}) });
  }),

  update: asyncHandler(async (req, res) => {
    const { data, error } = sanitizeAppConfig(req.body || {});
    if (error) return res.status(400).json({ error });
    const set = Object.fromEntries(Object.entries(data).map(([k, v]) => [`clientApp.${k}`, v]));
    await getSettings();
    const s = await Settings.findOneAndUpdate({ key: 'global' }, { $set: set }, { new: true, runValidators: true }).lean();
    cache = { at: 0, data: null };
    res.json({ ...DEFAULTS, ...(s?.clientApp || {}) });
  }),
};

/*
 * GET /api/admin/stats/channels?from=YYYY-MM-DD&to=YYYY-MM-DD (Toshkent kuni; bo'sh — oxirgi 30 kun)
 * Buyurtmalar kanal kesimida: soni, yakunlangan, summa, sovg'a berilgani, noyob mijozlar.
 * Faqat o'qish. Kanal belgisi shu funksiya chiqqandan keyingi buyurtmalarda bor ("noma'lum" — eskilari).
 */
export const channelStatsController = asyncHandler(async (req, res) => {
  const { Order } = await import('../models/Order.js');
  const { resolvePeriod } = await import('../services/billingPeriod.js');
  const { zoneDate, addDaysYmd } = await import('../services/restaurantTime.js');
  const today = zoneDate('Asia/Tashkent', new Date()).ymd;
  const period = resolvePeriod(req.query.from || addDaysYmd(today, -29), req.query.to || today);
  const rows = await Order.aggregate([
    { $match: { createdAt: period.cond, status: { $ne: 'awaiting_payment' } } },
    { $group: {
      _id: { $ifNull: ['$clientChannel', 'unknown'] },
      orders: { $sum: 1 },
      delivered: { $sum: { $cond: [{ $eq: ['$status', 'delivered'] }, 1, 0] } },
      cancelled: { $sum: { $cond: [{ $eq: ['$status', 'cancelled'] }, 1, 0] } },
      revenue: { $sum: { $cond: [{ $eq: ['$status', 'delivered'] }, '$total', 0] } },
      withGift: { $sum: { $cond: [{ $gt: [{ $size: { $ifNull: ['$bonusItems', []] } }, 0] }, 1, 0] } },
      users: { $addToSet: '$userId' },
    } },
    { $project: { _id: 0, channel: '$_id', orders: 1, delivered: 1, cancelled: 1, revenue: 1, withGift: 1, customers: { $size: '$users' } } },
    { $sort: { orders: -1 } },
  ]);
  res.json({ from: period.start, to: period.end, channels: rows });
});
