import { Dish } from '../models/Dish.js';
import { isVariantGroup } from './dishVariants.js';

/*
 * ═══════════════════════════════════════════════════════════
 * NARX TEKSHIRUVI — "SERVER PRICE WINS"
 * ═══════════════════════════════════════════════════════════
 *
 * CLAUDE.md 5-QOIDA: backend frontend yuborgan narxga ISHONMAYDI.
 *
 * AUDITDA ANIQLANGAN XATO: `unitPrice` va `subtotal` mijozdan
 * kelardi va bazadagi `Dish.price` bilan UMUMAN solishtirilmasdi
 * (faqat taom mavjudligi tekshirilardi). Ya'ni API'ga qo'lda
 * `unitPrice: 1` yuborilsa, buyurtma shu narxda o'tib ketardi va
 * restoran 1 so'mga taom tayyorlardi.
 *
 * Endi taom summasi HAR DOIM bazadan qayta hisoblanadi. Mijoz
 * yuborgan narx faqat TAQQOSLASH uchun ishlatiladi: farq bo'lsa
 * server qiymati g'olib, farq esa logga yoziladi (menyu narxi
 * mijoz savatni ochgandan keyin o'zgargan bo'lishi mumkin).
 *
 * Qo'shimcha tanlovlar (optionGroups) ham bazadan tekshiriladi:
 * nomi bo'yicha topilmagan tanlov narxi HISOBGA OLINMAYDI.
 */

/**
 * Buyurtma elementlari uchun haqiqiy baza summasini hisoblaydi.
 *
 * @param {Array}  items         mijoz yuborgan elementlar
 * @param {string} restaurantId  buyurtma qaysi restoranga
 * @returns {Promise<{ foodBaseSom:number, items:Array, mismatches:Array }>}
 *   `items` — narxi tuzatilgan elementlar (bazaga shu yoziladi)
 */
export async function verifyItemPrices(items, restaurantId) {
  const list = Array.isArray(items) ? items : [];
  const ids = [...new Set(list.map((i) => i?.dishId).filter(Boolean).map(String))];

  const dishes = ids.length
    ? await Dish.find({ _id: { $in: ids }, restaurantId })
      .select('name price optionGroups').lean()
      .catch(() => [])
    : [];
  const byId = new Map(dishes.map((d) => [String(d._id), d]));

  const mismatches = [];
  let foodBaseSom = 0;

  const verified = list.map((item) => {
    const qty = Math.max(1, Math.round(Number(item?.quantity) || 1));
    const dish = byId.get(String(item?.dishId || ''));

    /*
     * Taom bazada topilmasa (dishId yo'q — masalan qo'lda
     * kiritilgan pozitsiya) mijoz narxi qoldiriladi: uni
     * tekshirishning imkoni yo'q. Bunday holat logga tushadi.
     */
    if (!dish) {
      const unit = Math.max(0, Math.round(Number(item?.unitPrice) || 0));
      foodBaseSom += unit * qty;
      if (item?.dishId) {
        mismatches.push({ dishId: String(item.dishId), reason: 'taom bazada topilmadi' });
      }
      return { ...item, quantity: qty, unitPrice: unit };
    }

    /*
     * Tanlovlar narxi — faqat bazada MAVJUD bo'lganlari.
     *
     * Har tanlov qaysi guruhga tegishli ekani ham yoziladi:
     *   variant (hajm/razmer) — narxi taom narxini ALMASHTIRADI;
     *   addon (qo'shimcha)    — narxi QO'SHILADI.
     * Avval hammasi qo'shilardi va hajmli taomda (pitsa 33/40 sm)
     * mijozdan ikki-uch barobar ko'p pul olinardi.
     *
     * Mantiq mijoz ilovasi bilan AYNAN bir xil (dishVariants.js).
     */
    const allowed = new Map();
    for (const g of dish.optionGroups || []) {
      const variant = isVariantGroup(g, dish.price);
      for (const o of g.options || []) {
        allowed.set(o.name, { price: Number(o.price) || 0, variant, group: g.title });
      }
    }

    let basePrice = Math.round(Number(dish.price) || 0);
    let addonsSom = 0;
    let variantChosen = null;

    const selected = [];
    for (const o of item?.selectedOptions || []) {
      const real = allowed.get(o?.name);
      if (!real) {
        mismatches.push({ dishId: String(dish._id), reason: `noma'lum tanlov: ${o?.name}` });
        continue;
      }
      if (real.variant) {
        /*
         * Bitta taomda faqat BITTA hajm. Ikkinchisi kelsa
         * (eski ilova yoki soxta so'rov) — e'tiborsiz qoldiriladi.
         */
        if (variantChosen) {
          mismatches.push({ dishId: String(dish._id), reason: `ortiqcha hajm: ${o.name}` });
          continue;
        }
        variantChosen = o.name;
        basePrice = Math.round(real.price);
      } else {
        addonsSom += real.price;
      }
      selected.push({ name: o.name, price: real.price, group: real.group, variant: real.variant });
    }

    /*
     * Hajm guruhi bor, lekin mijoz birortasini tanlamagan (eski
     * ilova) — ENG ARZON variant qo'llanadi. Baza narxi emas:
     * import xatosi tufayli u variantlardan biriga teng bo'lmasligi
     * mumkin.
     */
    if (!variantChosen) {
      for (const g of dish.optionGroups || []) {
        if (!isVariantGroup(g, dish.price)) continue;
        const cheapest = [...(g.options || [])]
          .sort((a, b) => (Number(a.price) || 0) - (Number(b.price) || 0))[0];
        if (cheapest) {
          basePrice = Math.round(Number(cheapest.price) || 0);
          selected.unshift({ name: cheapest.name, price: cheapest.price, group: g.title, variant: true });
        }
        break;
      }
    }

    const serverUnit = basePrice + addonsSom;
    const clientUnit = Math.round(Number(item?.unitPrice) || 0);

    if (clientUnit !== serverUnit) {
      mismatches.push({
        dishId: String(dish._id),
        name: dish.name,
        client: clientUnit,
        server: serverUnit,
      });
    }

    foodBaseSom += serverUnit * qty;

    return {
      ...item,
      quantity: qty,
      name: dish.name,          // nom ham bazadan — soxta nom yozilmasin
      unitPrice: serverUnit,    // ← SERVER NARXI G'OLIB
      selectedOptions: selected,
    };
  });

  return { foodBaseSom, items: verified, mismatches };
}
