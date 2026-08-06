import { Dish } from '../models/Dish.js';
import { DineInConfig } from '../models/DineIn.js';

/**
 * Dine-in narx va hisob-kitob.
 *
 * MUHIM: barcha hisob SERVERDA bajariladi. Frontend yuborgan
 * narx, summa yoki xizmat haqiga ishonilmaydi.
 */

/**
 * Taomning zal narxi.
 *
 * SYNC   → delivery narxi
 * CUSTOM → alohida narx (belgilanmagan bo'lsa delivery)
 */
export function resolveDineInPrice(dish) {
  if (dish.priceMode === 'custom' && dish.dineInPrice != null && dish.dineInPrice > 0) {
    return dish.dineInPrice;
  }
  return dish.price;
}

/**
 * Xizmat haqi.
 *
 * FAQAT ofitsiant buyurtmasiga qo'llanadi. QR buyurtmasida
 * mijoz o'zi buyurtma bergan — xizmat ko'rsatilmagan.
 */
export function calcServiceFee(subtotal, config, orderSource) {
  if (orderSource !== 'waiter') return 0;
  if (!config?.serviceFeeEnabled) return 0;

  const value = Number(config.serviceFeeValue) || 0;
  if (value <= 0) return 0;

  const fee = config.serviceFeeType === 'fixed'
    ? value
    : Math.round(subtotal * value / 100);

  return Math.max(0, fee);
}

/**
 * Buyurtmani serverda qayta hisoblaydi.
 *
 * @param {Array} items - [{ dishId, quantity, selectedOptions }]
 * @param {string} restaurantId
 * @param {string} orderSource - 'qr' | 'waiter'
 * @returns {{ ok, items, subtotal, serviceFee, total } | { ok: false, error }}
 */
export async function calcDineInOrder(items, restaurantId, orderSource) {
  if (!Array.isArray(items) || items.length === 0) {
    return { ok: false, error: 'Savat bo\u2018sh' };
  }

  const dishIds = items.map((i) => i.dishId).filter(Boolean);
  const dishes = await Dish.find({
    _id: { $in: dishIds },
    restaurantId,
  }).lean();

  const dishMap = new Map(dishes.map((d) => [String(d._id), d]));

  const config = await DineInConfig.findOne({ restaurantId }).lean();

  const resolved = [];
  let subtotal = 0;

  for (const item of items) {
    const dish = dishMap.get(String(item.dishId));

    if (!dish) {
      return { ok: false, error: 'Taom topilmadi', code: 'DISH_NOT_FOUND' };
    }

    // Stop list — mavjud tizimdan
    if (config?.useGlobalStopList !== false && dish.isAvailable === false) {
      return {
        ok: false,
        error: `"${dish.name}" hozir mavjud emas`,
        code: 'DISH_STOPPED',
      };
    }

    const qty = Math.max(1, Math.min(50, Number(item.quantity) || 1));
    const basePrice = resolveDineInPrice(dish);

    // Variantlar — narxi bazadan olinadi, clientdan emas
    const options = [];
    let optionsPrice = 0;

    for (const sel of item.selectedOptions || []) {
      for (const group of dish.optionGroups || []) {
        const found = (group.options || []).find(
          (o) => o.name === sel.name,
        );
        if (found) {
          options.push({ name: found.name, price: found.price || 0 });
          optionsPrice += found.price || 0;
        }
      }
    }

    const unitPrice = basePrice + optionsPrice;
    subtotal += unitPrice * qty;

    resolved.push({
      dishId: dish._id,
      name: dish.name,
      quantity: qty,
      unitPrice,
      selectedOptions: options,
      note: String(item.note || '').slice(0, 200),
    });
  }

  const serviceFee = calcServiceFee(subtotal, config, orderSource);

  // ===== AKSIYA =====
  // Delivery bilan bir xil mantiq — alohida tizim emas
  const { applyPromotion } = await import('./promotions.js');
  const promo = await applyPromotion(restaurantId, resolved.map((r) => ({
    dishId: r.dishId,
    category: dishMap.get(String(r.dishId))?.category,
    unitPrice: r.unitPrice,
    quantity: r.quantity,
  })), subtotal);

  const promoDiscount = promo?.discount || 0;

  return {
    ok: true,
    items: resolved,
    subtotal,
    serviceFee,
    promotion: promo,
    promoDiscount,
    total: Math.max(0, subtotal - promoDiscount + serviceFee),
  };
}

/**
 * Zal buyurtmasi raqami: #A-124
 *
 * Har restoranda kunlik ketma-ketlik.
 */
export async function nextDineInNumber(restaurantId) {
  const { Order } = await import('../models/Order.js');

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const count = await Order.countDocuments({
    restaurantId,
    fulfillment: 'dinein',
    createdAt: { $gte: todayStart },
  });

  const n = count + 1;
  // A-001 … A-999, keyin B-001
  const letterIndex = Math.floor((n - 1) / 999);
  const letter = String.fromCharCode(65 + (letterIndex % 26));
  const num = ((n - 1) % 999) + 1;

  return `${letter}-${String(num).padStart(3, '0')}`;
}

/** Menyuni Dine-in narxlari bilan qaytaradi. */
export async function getDineInMenu(restaurantId) {
  const config = await DineInConfig.findOne({ restaurantId }).lean();
  const useStopList = config?.useGlobalStopList !== false;

  const filter = { restaurantId };
  if (useStopList) filter.isAvailable = { $ne: false };

  const dishes = await Dish.find(filter)
    .select('name description category section imageUrl images price oldPrice priceMode dineInPrice optionGroups weight volume calories prepMinutes isAvailable tint icon')
    .sort({ section: 1, name: 1 })
    .lean();

  // Mijozga FAQAT zal narxi ko'rsatiladi — delivery narxi emas
  return dishes.map((d) => {
    const price = resolveDineInPrice(d);
    const { price: _delivery, dineInPrice: _custom, priceMode: _mode, ...rest } = d;
    return { ...rest, price };
  });
}
