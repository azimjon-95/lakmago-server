/*
 * GET /api/location/resolve?lat=&lng= — koordinata qaysi tuman/shaharda (TZ 6).
 * Javob: { success, data: { districtId, districtName, matched, boundaryVersion, reason? } }.
 * Koordinatalar LOGGA YOZILMAYDI. Resolver o'chiq/buzuq bo'lsa — 503 (boshqa API'lar ishlashda davom etadi).
 */
import { asyncHandler } from '../middleware/error.js';
import { resolveDistrict, isResolverAvailable, boundaryVersion } from '../services/districtResolver.js';
import { z } from 'zod';
import { Restaurant } from '../models/Restaurant.js';
import { isDistrict, districtLabel } from '../constants/districts.js';
import { resolveRestaurantDistrict, supportedDistrictIds } from '../services/districtResolver.js';
import { refreshRestaurantDistrict, districtFeatureOn } from '../services/restaurantDistrict.js';
import { NO_BOUNDARY_DISTRICTS } from '../constants/districtBoundaryMap.js';
import { config } from '../config/index.js';

const LANGS = new Set(['uz', 'uzc', 'ru']);
// Faqat oddiy o'nlik son (1e3, Infinity, bo'sh satr, massiv — rad etiladi)
const NUM = /^-?\d{1,3}(\.\d{1,12})?$/;

export const locationController = {
  resolve: asyncHandler(async (req, res) => {
    const { lat: rawLat, lng: rawLng, lang: rawLang } = req.query;
    if (typeof rawLat !== 'string' || typeof rawLng !== 'string' || !NUM.test(rawLat) || !NUM.test(rawLng)) {
      return res.status(400).json({ success: false, error: 'INVALID_COORDINATES', message: 'lat va lng son bo‘lishi kerak' });
    }
    const lat = Number(rawLat); const lng = Number(rawLng);
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return res.status(400).json({ success: false, error: 'INVALID_COORDINATES', message: 'lat −90…90, lng −180…180' });
    }
    if (!isResolverAvailable()) {
      return res.status(503).json({ success: false, error: 'DISTRICT_RESOLVER_UNAVAILABLE', boundaryVersion: boundaryVersion() });
    }
    const lang = typeof rawLang === 'string' && LANGS.has(rawLang) ? rawLang : 'uz';
    res.set('Cache-Control', 'no-store');
    return res.json({ success: true, data: resolveDistrict(lat, lng, { lang }) });
  }),
};

/* ══════════════ ADMIN: restoran katalog hududi ══════════════ */

const isOid = (id) => typeof id === 'string' && /^[a-f\d]{24}$/i.test(id);

export const adminDistrictController = {
  /**
   * GET /api/admin/district-preview?lat=&lng= — admin xaritada nuqta qo'yganda "Restoran joylashgan tuman"ni ko'radi
   * (saqlashdan oldin). Restoran uchun bufer qo'llanmaydi. Flag o'chiq bo'lsa { enabled:false }.
   */
  preview: asyncHandler(async (req, res) => {
    const enabled = districtFeatureOn();
    const base = {
      enabled, catalogFilterEnabled: config.district.catalogFilterEnabled,
      supported: enabled ? supportedDistrictIds().map((id) => ({ id, name: districtLabel(id) })) : [],
      noBoundary: NO_BOUNDARY_DISTRICTS,
    };
    if (!enabled) return res.json(base);
    const lat = Number(req.query.lat); const lng = Number(req.query.lng);
    if (!NUM.test(String(req.query.lat ?? '')) || !NUM.test(String(req.query.lng ?? '')) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return res.json({ ...base, result: null });
    }
    return res.json({ ...base, result: resolveRestaurantDistrict(lat, lng) });
  }),

  /**
   * PATCH /api/admin/restaurants/:id/service-district — FAQAT bosh admin. Koordinata natijasini qo'lda almashtirish
   * (masalan poligoni yo'q hudud yoki chegaradagi restoran). Sabab majburiy, districtAudit'ga yoziladi.
   * districtId: null — override bekor qilinadi (yana koordinatadan aniqlanadi).
   */
  override: asyncHandler(async (req, res) => {
    if (!isOid(req.params.id)) return res.status(400).json({ error: 'Noto‘g‘ri ID' });
    if (!districtFeatureOn()) return res.status(503).json({ error: 'Tuman chegaralari o‘chiq', code: 'DISTRICT_RESOLVER_UNAVAILABLE' });
    const parsed = z.object({ districtId: z.string().nullable(), reason: z.string().trim().min(5).max(300) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'districtId va sabab (kamida 5 belgi) kerak' });
    const { districtId, reason } = parsed.data;
    if (districtId !== null && !isDistrict(districtId)) return res.status(400).json({ error: 'Noma‘lum tuman' });
    const by = `admin:${req.userId}`;
    const r = await Restaurant.findByIdAndUpdate(req.params.id, districtId
      ? { $set: { serviceDistrictOverride: { districtId, reason, by, at: new Date() } } }
      : { $unset: { serviceDistrictOverride: 1 } }, { new: true }).select('_id');
    if (!r) return res.status(404).json({ error: 'Muassasa topilmadi' });
    await refreshRestaurantDistrict(Restaurant, r._id, { by, action: districtId ? `override: ${reason}` : `override-off: ${reason}` });
    const fresh = await Restaurant.findById(r._id).select('serviceDistrictId serviceAreaDistrictIds serviceDistrictOverride districtResolveReason districtBoundaryVersion districtAudit').lean();
    return res.json(fresh);
  }),
};
