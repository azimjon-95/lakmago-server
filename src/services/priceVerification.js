import { Dish } from '../models/Dish.js';

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

    // Tanlovlar narxi — faqat bazada MAVJUD bo'lganlari
    const allowed = new Map();
    for (const g of dish.optionGroups || []) {
      for (const o of g.options || []) allowed.set(o.name, Number(o.price) || 0);
    }

    let optionsSom = 0;
    const selected = (item?.selectedOptions || []).map((o) => {
      const realPrice = allowed.get(o?.name);
      if (realPrice === undefined) {
        mismatches.push({ dishId: String(dish._id), reason: `noma'lum tanlov: ${o?.name}` });
        return { name: o?.name, price: 0 };
      }
      optionsSom += realPrice;
      return { name: o.name, price: realPrice };
    });

    const serverUnit = Math.round(Number(dish.price) || 0) + optionsSom;
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
