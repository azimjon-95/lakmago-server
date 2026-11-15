/*
 * ═══ KATALOGNI TUMAN BO'YICHA FILTRLASH (?district=chust) ═══
 *
 * Faqat DISTRICT_CATALOG_FILTER_ENABLED=true VA resolver ishlayotgan bo'lsa VA so'rovda to'g'ri `district` bo'lsa.
 * Aks holda null → filtr qo'shilmaydi, kesh kaliti o'zgarmaydi: eski mijozlar va flag o'chiq — 100% eski natija.
 *
 * Restoran tumanga tegishli:  serviceDistrictId = d  YOKI  serviceAreaDistrictIds ∋ d.
 * Eski (migratsiya qilinmagan, serviceDistrictId maydoni YO'Q) restoranlar — DISTRICT_CATALOG_LEGACY_POLICY:
 *   'show' (standart) — har tumanda ko'rinadi (migratsiya paytida hech narsa yo'qolmaydi); 'hide' — ko'rinmaydi.
 * Migratsiyadan o'tib, tumani aniqlanmagan (serviceDistrictId: null) restoranlar filtrlangan ro'yxatda ko'rinmaydi
 * (admin ko'rib chiqadi) — ular hech qachon "Pop" deb ko'rsatilmaydi.
 */
import { config } from '../config/index.js';
import { supportedDistrictIds } from './districtResolver.js';
import { districtFeatureOn } from './restaurantDistrict.js';

/** So'rovdagi yaroqli tuman (yoki null — filtrsiz). */
export function catalogDistrict(req) {
  if (!config.district.catalogFilterEnabled || !districtFeatureOn()) return null;
  const d = req?.query?.district;
  if (typeof d !== 'string' || !d) return null;
  return supportedDistrictIds().includes(d) ? d : null;
}

/** Restoran filtri bo'lagi (andWith bilan qo'shiladi). */
export function districtClause(d) {
  const or = [{ serviceDistrictId: d }, { serviceAreaDistrictIds: d }];
  if (config.district.legacyPolicy === 'show') or.push({ serviceDistrictId: { $exists: false } });
  return { $or: or };
}

/** Kesh kaliti qo'shimchasi: filtr yo'q — bo'sh (eski kalit o'zgarmaydi), bor — `:d=chust`. */
export const districtKeySuffix = (d) => (d ? `:d=${d}` : '');

/** Filtrga tuman bo'lagini qo'shadi; tuman yo'q bo'lsa filtr AYNAN o'zgarmaydi (eski so'rov bilan bir xil). */
export function withDistrict(filter, d) {
  if (!d) return filter;
  filter.$and = [...(filter.$and || []), districtClause(d)];
  return filter;
}
