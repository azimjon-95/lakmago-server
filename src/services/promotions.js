import { Promotion } from '../models/Promotion.js';
import { BonusRule } from '../models/BonusRule.js';
import { User } from '../models/User.js';

/**
 * Aksiya va bonus hisob-kitobi.
 *
 * MUHIM: barcha hisob SERVERDA bajariladi. Frontend yuborgan
 * chegirma qiymatiga ishonilmaydi — u faqat ko'rsatish uchun.
 */

/**
 * Taomga aksiya tegishlimi.
 */
function appliesTo(promo, item) {
  if (promo.scope === 'all') return true;

  if (promo.scope === 'category') {
    return promo.categories?.includes(item.category);
  }

  if (promo.scope === 'dishes') {
    return promo.dishIds?.some((id) => String(id) === String(item.dishId));
  }

  return false;
}

/**
 * Chegirma summasini hisoblaydi.
 *
 * @param {number} base - chegirma qo'llanadigan summa
 * @param {object} promo - aksiya
 */
function calcDiscount(base, promo) {
  let discount = promo.discountType === 'percent'
    ? Math.round(base * promo.discountValue / 100)
    : Math.min(promo.discountValue, base);

  // Foizli chegirmada yuqori chegara
  if (promo.maxDiscountAmount > 0 && discount > promo.maxDiscountAmount) {
    discount = promo.maxDiscountAmount;
  }

  return Math.max(0, Math.min(discount, base));
}

/**
 * Buyurtma uchun eng foydali aksiyani topadi va qo'llaydi.
 *
 * Bir buyurtmaga BITTA aksiya qo'llaniladi — eng katta
 * chegirma beradigani. Bir nechtasini qo'shish restoranga
 * zarar keltirishi mumkin.
 *
 * @param {string} restaurantId
 * @param {Array} items - [{ dishId, category, unitPrice, quantity }]
 * @param {number} subtotal
 * @returns {{ discount, promotionId, promotionName } | null}
 */
export async function applyPromotion(restaurantId, items, subtotal) {
  const now = new Date();

  const promos = await Promotion.find({
    restaurantId,
    isActive: true,
    startsAt: { $lte: now },
    endsAt: { $gte: now },
  }).lean();

  let best = null;

  for (const promo of promos) {
    // Limit tugaganmi
    if (promo.maxUses > 0 && promo.usedCount >= promo.maxUses) continue;
    // Minimal summa
    if (subtotal < (promo.minOrderAmount || 0)) continue;

    // Chegirma qo'llanadigan summani hisoblaymiz
    let base = 0;
    if (promo.scope === 'all') {
      base = subtotal;
    } else {
      for (const it of items) {
        if (appliesTo(promo, it)) {
          base += (it.unitPrice || 0) * (it.quantity || 1);
        }
      }
    }

    if (base <= 0) continue;

    const discount = calcDiscount(base, promo);
    if (discount <= 0) continue;

    if (!best || discount > best.discount) {
      best = {
        discount,
        promotionId: promo._id,
        promotionName: promo.name,
      };
    }
  }

  return best;
}

/**
 * Aksiya ishlatilganini qayd etadi.
 * Limit tugasa avtomatik o'chiriladi.
 */
export async function markPromotionUsed(promotionId, discount, revenue) {
  const promo = await Promotion.findById(promotionId);
  if (!promo) return;

  promo.usedCount += 1;
  promo.stats.orders += 1;
  promo.stats.totalDiscount += discount;
  promo.stats.totalRevenue += revenue;

  // Limit tugadi — avtomatik deaktivatsiya
  if (promo.maxUses > 0 && promo.usedCount >= promo.maxUses) {
    promo.isActive = false;
  }

  await promo.save();
}

/**
 * Buyurtma uchun bonus hisoblaydi.
 * Bonus buyurtma YETKAZILGANDAN keyin beriladi.
 */
export async function calcBonus(restaurantId, orderTotal) {
  const rule = await BonusRule.findOne({
    restaurantId,
    isActive: true,
    minOrderAmount: { $lte: orderTotal },
  }).sort({ minOrderAmount: -1 }).lean();

  if (!rule) return null;

  let bonus = rule.bonusType === 'percent'
    ? Math.round(orderTotal * rule.bonusValue / 100)
    : rule.bonusValue;

  if (rule.maxBonusAmount > 0 && bonus > rule.maxBonusAmount) {
    bonus = rule.maxBonusAmount;
  }

  if (bonus <= 0) return null;

  return { bonus, ruleId: rule._id, ruleName: rule.name };
}

/**
 * Bonusni mijoz balansiga qo'shadi.
 * Buyurtma yetkazilganda chaqiriladi.
 */
export async function grantBonus(userId, restaurantId, orderTotal) {
  const result = await calcBonus(restaurantId, orderTotal);
  if (!result) return null;

  await User.findByIdAndUpdate(userId, {
    $inc: { bonusBalance: result.bonus },
  });

  await BonusRule.findByIdAndUpdate(result.ruleId, {
    $inc: { 'stats.orders': 1, 'stats.totalGiven': result.bonus },
  });

  return result;
}

/**
 * Muddati tugagan aksiyalarni o'chiradi.
 * Kuniga bir marta ishga tushadi.
 */
export async function deactivateExpired() {
  const now = new Date();

  const expired = await Promotion.updateMany(
    { isActive: true, endsAt: { $lt: now } },
    { isActive: false },
  );

  const { AdCampaign } = await import('../models/AdCampaign.js');
  const expiredAds = await AdCampaign.updateMany(
    { isActive: true, endsAt: { $lt: now } },
    { isActive: false },
  );

  if (expired.modifiedCount || expiredAds.modifiedCount) {
    console.log(
      `[promo] Muddati tugadi: ${expired.modifiedCount} aksiya, `
      + `${expiredAds.modifiedCount} reklama`,
    );
  }
}
