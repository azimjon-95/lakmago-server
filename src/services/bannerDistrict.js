/*
 * ═══ BANNER VA REKLAMALARNI TUMAN BO'YICHA KO'RSATISH (?district=chust) ═══
 *
 * Tuman katalog bilan AYNAN bir shartda olinadi (services/catalogDistrict.js → catalogDistrict): flag o'chiq, resolver
 * ishlamayapti yoki so'rovda tuman yo'q bo'lsa — filtr YO'Q, natija 100% eskicha (eski mijozlar ham, flag o'chiq ham).
 *
 * Banner qaysi tumanga tegishli (birinchi mos qoida):
 *   1) admin belgilagan `districtIds` (bo'sh emas)      → faqat shu tumanlarda;
 *   2) restoranga bog'langan (restaurantId yoki linkUrl `/restaurant/<id>`) → o'sha restoran tumani(lar)ida
 *      (katalog qoidasi: serviceDistrictId / serviceAreaDistrictIds; migratsiya qilinmagan eski restoran — legacyPolicy);
 *   3) hech biri yo'q                                    → umumiy: hamma tumanda (eski bannerlar avvalgidek).
 * Restoran reklamasi (Ad) har doim restoranga bog'langan → 2-qoida.
 *
 * Migratsiya kerak emas: mavjud bannerlar restoran havolasi bo'yicha o'zi to'g'ri tumanga tushadi.
 */
import { config } from '../config/index.js';
import { supportedDistrictIds } from './districtResolver.js';

const OID = /^[a-f0-9]{24}$/i;
const LINK_RE = /\/restaurant\/([a-f0-9]{24})(?:[/?#]|$)/i;

/** Restoran shu tumanga tegishlimi — catalogDistrict.districtClause bilan bir xil mantiq. */
export function restaurantInDistrict(rest, d) {
  if (!rest || !d) return false;
  if (rest.serviceDistrictId === d) return true;
  if (Array.isArray(rest.serviceAreaDistrictIds) && rest.serviceAreaDistrictIds.includes(d)) return true;
  // Migratsiya qilinmagan (maydon umuman yo'q) — katalogdagi kabi siyosat
  if (rest.serviceDistrictId === undefined && config.district.legacyPolicy === 'show') return true;
  return false;
}

/** Bannerga bog'langan restoran ID'si (satr) yoki null. */
export function linkedRestaurantId(banner) {
  const direct = banner?.restaurantId ? String(banner.restaurantId._id || banner.restaurantId) : '';
  if (OID.test(direct)) return direct;
  const m = typeof banner?.linkUrl === 'string' ? banner.linkUrl.match(LINK_RE) : null;
  return m ? m[1].toLowerCase() : null;
}

/** Banner shu tumanda ko'rinadimi. restById: Map<id, {serviceDistrictId, serviceAreaDistrictIds}> */
export function bannerVisibleInDistrict(banner, d, restById) {
  if (!d) return true;
  if (Array.isArray(banner.districtIds) && banner.districtIds.length) return banner.districtIds.includes(d);
  const rid = linkedRestaurantId(banner);
  if (!rid) return true;                         // umumiy banner
  const rest = restById?.get(rid);
  if (!rest) return true;                        // restoran topilmadi — avvalgidek ko'rinadi (hech narsa yo'qolmaydi)
  return restaurantInDistrict(rest, d);
}

/**
 * Admin yuborgan tumanlar ro'yxati → toza massiv. undefined — maydon yuborilmagan (o'zgartirilmaydi).
 * Resolver ishlayotgan bo'lsa faqat ma'lum tumanlar qabul qilinadi; aks holda — xavfsiz slug.
 * Noto'g'ri qiymat → { error }.
 */
export function sanitizeDistrictIds(input) {
  if (input === undefined) return { value: undefined };
  if (input === null || input === '') return { value: [] };
  if (!Array.isArray(input)) return { error: 'Tumanlar ro‘yxati noto‘g‘ri' };
  const known = supportedDistrictIds();
  const out = [];
  for (const raw of input) {
    const id = typeof raw === 'string' ? raw.trim() : '';
    if (!/^[a-z][a-z0-9_]{1,39}$/.test(id)) return { error: 'Tuman noto‘g‘ri' };
    if (known.length && !known.includes(id)) return { error: `Noma’lum tuman: ${id}` };
    if (!out.includes(id)) out.push(id);
  }
  if (out.length > 30) return { error: 'Tumanlar juda ko‘p' };
  return { value: out };
}
