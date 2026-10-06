/*
 * ═══ DO'KON (MARKET) QOIDASI — YAGONA JOY ═══
 *
 * Muassasa DO'KON hisoblanadi, agar:
 *   • turi (kind) — 'shop' ("Magazin"), YOKI
 *   • kategoriyasi — "Oziq-ovqat do'koni" (magazin_oziq),
 *     "Meva-sabzavot" (magazin_meva) yoki eski 'magazin'.
 *
 * Do'konlar va ularning mahsulotlari bosh sahifadagi restoranlar va
 * taomlar orasida UMUMAN ko'rinmaydi — ular faqat Lokma Market
 * bo'limida (controllers/market.js). Mijoz ilovasi ham shu qoidani
 * takrorlamaydi: server ro'yxatlarni allaqachon ajratib beradi.
 */
export const STORE_CATEGORIES = ['magazin_oziq', 'magazin_meva', 'magazin'];

export function isStore(r) {
  return r?.kind === 'shop' || STORE_CATEGORIES.includes(r?.category);
}

/** Restoran (do'kon EMAS) sharti — `$and` ichiga qo'shiladi (category/$or filtrlariga to'qnashmaydi). */
export const NOT_STORE = { kind: { $ne: 'shop' }, category: { $nin: STORE_CATEGORIES } };

/** Faqat do'konlar. */
export const ONLY_STORE = { $or: [{ kind: 'shop' }, { category: { $in: STORE_CATEGORIES } }] };

/** Mavjud filtrga shartni xavfsiz qo'shadi (filtrni o'zgartiradi va qaytaradi). */
export function andWith(filter, clause) {
  filter.$and = [...(filter.$and || []), clause];
  return filter;
}
