/*
 * ═══ RESTORANNING KATALOG HUDUDI (serviceDistrictId / serviceAreaDistrictIds) ═══
 *
 * `Restaurant.district` (kuryer tumani) ga TEGMAYDI — bu alohida maydonlar (TZ 7).
 *   • serviceDistrictId — FAQAT server koordinatadan hisoblaydi (admin/restoran yuborgan qiymatga ishonilmaydi).
 *     Tashqarida/noaniq/koordinatasiz → null + sabab. Hech qachon "pop" deb taxmin qilinmaydi.
 *   • serviceAreaDistrictIds — faqat admin o'zgartiradi; standart [serviceDistrictId]. O'z tumani har doim ichida.
 *   • Bosh admin override (sabab bilan) — koordinata natijasidan ustun; districtAudit'ga yoziladi.
 * Resolver o'chiq bo'lsa — hech narsa yozilmaydi (eski xatti-harakat).
 */
import { config } from '../config/index.js';
import { isDistrict } from '../constants/districts.js';
import { resolveRestaurantDistrict, isResolverAvailable, boundaryVersion, supportedDistrictIds } from './districtResolver.js';

const AUDIT_MAX = 50;
const validCoord = (lat, lng) => Number.isFinite(Number(lat)) && Number.isFinite(Number(lng))
  && lat !== null && lng !== null && lat !== '' && lng !== ''
  && !(Number(lat) === 0 && Number(lng) === 0);

export const districtFeatureOn = () => config.district.boundariesEnabled && isResolverAvailable();

/** Admin yuborgan xizmat hududi ro'yxatini tozalaydi: faqat poligoni bor tumanlar, takrorsiz. */
export function cleanServiceArea(list) {
  const ok = new Set(supportedDistrictIds());
  return [...new Set((Array.isArray(list) ? list : []).map(String))].filter((id) => ok.has(id) && isDistrict(id));
}

/**
 * Koordinatadan katalog hududini hisoblaydi. Hujjat/yangilanish obyektini qaytaradi ($set uchun).
 * @param r — joriy restoran (lean yoki doc): lat, lng, serviceAreaDistrictIds, serviceDistrictOverride
 * @param opts.area — admin yangi xizmat hududi yuborgan bo'lsa
 */
export function computeServiceDistrict(r, { area, by = 'system', action = 'resolve' } = {}) {
  if (!districtFeatureOn()) return null;
  const override = r?.serviceDistrictOverride?.districtId && isDistrict(r.serviceDistrictOverride.districtId) ? r.serviceDistrictOverride.districtId : null;
  let districtId = null; let reason = null;
  if (override) {
    districtId = override;
  } else if (!validCoord(r?.lat, r?.lng)) {
    reason = 'NO_COORDINATES';
  } else {
    const res = resolveRestaurantDistrict(Number(r.lat), Number(r.lng));
    districtId = res.matched ? res.districtId : null;
    reason = res.matched ? null : res.reason;
  }
  const prevArea = Array.isArray(r?.serviceAreaDistrictIds) ? r.serviceAreaDistrictIds : [];
  // Avvalgi avtomatik tuman (agar u hududda bo'lsa) yangisiga almashadi; admin qo'shgan boshqa tumanlar saqlanadi
  const base = area !== undefined ? cleanServiceArea(area) : prevArea.filter((id) => id !== r?.serviceDistrictId);
  const nextArea = [...new Set([...(districtId ? [districtId] : []), ...cleanServiceArea(base)])];
  const set = {
    serviceDistrictId: districtId,
    serviceAreaDistrictIds: nextArea,
    districtBoundaryVersion: boundaryVersion(),
    districtResolvedAt: new Date(),
    districtResolveReason: reason,
  };
  const changed = (r?.serviceDistrictId ?? null) !== districtId
    || JSON.stringify(prevArea) !== JSON.stringify(nextArea)
    || (r?.districtResolveReason ?? null) !== reason;
  const audit = changed ? {
    at: new Date(), by: String(by), action, from: r?.serviceDistrictId ?? null, to: districtId, area: nextArea, reason: reason || null, version: boundaryVersion(),
  } : null;
  return { set, audit, changed };
}

/** Mongoose update obyekti: $set + districtAudit'ga $push (cheklangan). */
export function toMongoUpdate(result) {
  if (!result) return null;
  const u = { $set: result.set };
  if (result.audit) u.$push = { districtAudit: { $each: [result.audit], $slice: -AUDIT_MAX } };
  return u;
}

/** Restoran saqlangandan keyin (create/update) — hisoblab yozadi. Xato bo'lsa asosiy amalni buzmaydi. */
export async function refreshRestaurantDistrict(Restaurant, id, opts = {}) {
  try {
    if (!districtFeatureOn()) return null;
    const r = await Restaurant.findById(id).select('lat lng serviceDistrictId serviceAreaDistrictIds serviceDistrictOverride districtResolveReason').lean();
    if (!r) return null;
    const result = computeServiceDistrict(r, opts);
    const u = toMongoUpdate(result);
    if (u) await Restaurant.updateOne({ _id: id }, u);
    return result;
  } catch (e) {
    console.error('[restaurantDistrict] hisoblab bo\'lmadi:', e.message);
    return null;
  }
}
