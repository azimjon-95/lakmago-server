/**
 * ═══ TAOM KATEGORIYALARI — ESKI NOMLAR (ALIAS) ═══
 *
 * Dish.category enum'ida hozirgi kategoriyalar bilan birga ESKI
 * qiymatlar ham saqlanadi ('shorva', 'ichimlik', 'issiq' ...).
 * Mijoz ilovasi esa faqat yangi id'larni biladi ('sup', 'salqin',
 * 'obed' ...). Filtr faqat `category === id` bo'lsa, eski nom
 * bilan saqlangan taomlar o'z kategoriyasida UMUMAN chiqmasdi —
 * masalan "Sho'rva" tanlanganda 'shorva' deb saqlangan sho'rvalar.
 *
 * Bazani ko'chirish (migration) o'rniga shu xarita ishlatiladi:
 * mavjud ma'lumotga tegilmaydi, filtr esa ikkala nomni ham topadi.
 *
 * MUHIM: mijozdagi src/data/categories.js dagi CATEGORY_ALIASES
 * bilan BIR XIL bo'lishi kerak.
 */
export const DISH_CATEGORY_ALIASES = Object.freeze({
  sup: ['sup', 'shorva'],
  salqin: ['salqin', 'ichimlik'],
  zavtroki: ['zavtroki', 'nonushta'],
  non: ['non', 'nonvoyxona'],
  obed: ['obed', 'issiq'],
  shashlik: ['shashlik', 'grill'],
});

/** Kategoriya id'si uchun bazada qidiriladigan barcha qiymatlar. */
export function dishCategoryValues(categoryId) {
  return DISH_CATEGORY_ALIASES[categoryId] || [categoryId];
}

/**
 * ═══ CHEGIRMA — YAGONA HAQIQAT MANBAI ═══
 *
 * Taom chegirmada = `oldPrice > price`. Mijoz kartada "−8%"
 * belgisini aynan shu shart bo'yicha chiqaradi.
 *
 * `isDiscounted` bayrog'iga TAYANILMAYDI: restoran/admin panelda
 * eski narx (oldPrice) kiritilganda bayroq avtomatik
 * o'rnatilmaydi. Natijada bosh sahifada chegirma belgisi bilan
 * turgan taomlar "Super Chegirmalar → Barchasi" da topilmas,
 * "Tavsiya qilamiz" da esa chegirmalilar aralashib chiqardi.
 *
 * oldPrice yo'q (null/missing) bo'lsa MongoDB taqqoslashida u
 * har qanday sondan kichik — shart false, ya'ni chegirma emas.
 *
 * Funksiya (konstanta emas): Mongoose $expr ni cast qilishda
 * obyektni joyida o'zgartirishi mumkin — har so'rov yangi nusxa
 * oladi, umumiy obyekt buzilmaydi.
 */
export function discountExpr() {
  return { $gt: ['$oldPrice', '$price'] };
}
