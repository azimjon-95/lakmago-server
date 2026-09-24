/*
 * ═══════════════════════════════════════════════════════════
 * TAOM NARXI — HAJM/RAZMER VA QO'SHIMCHALAR
 * ═══════════════════════════════════════════════════════════
 *
 * DIQQAT: bu mantiq mijoz ilovasida ham AYNAN SHUNDAY yozilgan
 * (lakmago-client/src/lib/dishPricing.js). Ikkalasi bir
 * xil natija berishi SHART — aks holda mijoz ekranda bir summani
 * ko'rib, boshqasini to'laydi. O'zgartirsangiz — ikkalasini birga.
 *
 * ─── IKKI TUR TANLOV GURUHI ───
 *
 *   addon   — QO'SHIMCHA: narxi taom narxiga QO'SHILADI
 *             (masalan "Pishloq +5 000"). Bir nechtasini tanlash
 *             mumkin. Avvalgi xatti-harakat — o'zgarmagan.
 *
 *   variant — HAJM/RAZMER: narxi taom narxini ALMASHTIRADI
 *             (masalan "33 sm — 61 500", "40 sm — 76 875").
 *             Faqat BITTASI tanlanadi va tanlash SHART.
 *
 * ─── XATO (nima uchun kerak bo'ldi) ───
 *
 * Ma'lumotlar bazaga to'g'ridan-to'g'ri import qilinganda hajm
 * guruhlari oddiy qo'shimcha sifatida tushdi. Natijada:
 *   • ikkala hajm bir vaqtda tanlanardi;
 *   • narx QO'SHILARDI: 61 500 + 61 500 + 76 875 = 199 875 —
 *     mijozdan uch barobar ko'p pul olinardi.
 *
 * ─── ESKI MA'LUMOT (kind yozilmagan) ───
 *
 * Admin guruhni aniq belgilamagan bo'lsa, ehtiyotkor aniqlash
 * ishlaydi — UCHALA shart birga bajarilishi kerak:
 *   1) sarlavhada hajm so'zi bor ("Porsiya hajmi", "Razmer",
 *      "Gramm", "Размер" ...);
 *   2) kamida 2 ta variant;
 *   3) HAR BIR variant narxi taom narxining kamida yarmi —
 *      ya'ni bu to'liq narx, qo'shimcha emas ("Pishloq +5 000"
 *      bu shartdan o'tmaydi).
 * Admin `kind` ni aniq belgilasa — aniqlash ishlatilmaydi.
 */

const SIZE_WORDS = /(hajm|razmer|o['‘ʻ’`]?lcham|porsiya|portsiya|gramm?|\bgr\b|size|litr|объ[её]м|размер|порци|вес|литр)/i;

/** Guruh hajm/razmer (narxni almashtiruvchi) guruhimi. */
export function isVariantGroup(group, basePrice) {
  if (!group) return false;
  if (group.kind === 'variant') return true;
  if (group.kind === 'addon') return false;

  const options = group.options || [];
  if (options.length < 2) return false;
  if (!SIZE_WORDS.test(String(group.title || ''))) return false;

  const base = Number(basePrice) || 0;
  if (base <= 0) return false;
  return options.every((o) => Number(o.price) >= base * 0.5);
}

/** Option qaysi guruhga tegishli — avval id, keyin nom bo'yicha. */
function groupOf(groups, option) {
  const oid = String(option?.id ?? option?._id ?? '');
  return groups.find((g) => (g.options || []).some((o) => (
    (oid && String(o.id ?? o._id ?? '') === oid) || o.name === option?.name
  ))) || null;
}

/**
 * Bitta taom narxi (tanlovlar bilan).
 *
 * variant tanlangan bo'lsa — uning narxi taom narxini ALMASHTIRADI,
 * qo'shimchalar esa ustiga QO'SHILADI.
 */
export function dishUnitPrice(dish, selectedOptions = []) {
  const groups = dish?.optionGroups || [];
  let base = Number(dish?.price) || 0;
  let addons = 0;
  let variantSet = false;

  for (const opt of selectedOptions || []) {
    const g = groupOf(groups, opt);
    const price = Number(opt?.price) || 0;
    if (g && isVariantGroup(g, dish?.price)) {
      // Bitta variant guruhida faqat bittasi hisobga olinadi
      if (!variantSet) { base = price; variantSet = true; }
    } else {
      addons += price;
    }
  }

  return base + addons;
}

/** Variant guruhining eng arzon varianti — oldindan tanlash uchun. */
export function cheapestOption(group) {
  return [...(group?.options || [])]
    .sort((a, b) => (Number(a.price) || 0) - (Number(b.price) || 0))[0] || null;
}
