/*
 * ═══════════════════════════════════════════════════════════
 * ESLATMA QOIDALARI — SOF (bazasiz, botsiz, tarmoqsiz)
 * ═══════════════════════════════════════════════════════════
 *
 * restaurantReminders.js (bot eslatmalari) va panel/gateway
 * (`restaurantConfirm`, "Yetkazildi" endpointi) BIR XIL qoidani
 * ishlatishi uchun shu yerda. Avval bu kod restaurantReminders.js
 * ichida edi va u og'ir bog'liqliklarni (bot, deliveryCheck) tortardi.
 */

/** Restoran yakunlay oladigan (hali ochiq) faol holatlar. */
export const COMPLETABLE_STATUSES = ['accepted', 'preparing', 'ready', 'delivering'];

const MIN = 60_000;
const HOUR = 60 * MIN;
export const REMINDER_RULES = {
  firstAfterMin: 30,
  secondAfterMin: 30,
  maxReminders: 2,
  autoAfterStageHours: 12,
  autoGraceAfterLastHours: 3,
  lookbackDays: 30,
};

/** Buyurtma joriy holatga qachon o'tgan (rejalashtirilgan vaqtdan oldin emas). */
function stageAt(o) {
  const byStatus = {
    accepted: o.acceptedAt,
    preparing: o.acceptedAt,
    ready: o.readyAt,
    delivering: o.deliveringAt,
  }[o.status];
  let t = new Date(byStatus || o.updatedAt || o.createdAt).getTime();
  if (o.scheduledFor) t = Math.max(t, new Date(o.scheduledFor).getTime());
  return t;
}

/**
 * Sof qaror: bu buyurtma bilan hozir nima qilish kerak.
 * @returns {{ action: 'none' } | { action: 'ask', n: number } | { action: 'auto' }}
 */
export function planReminder(o, now = Date.now()) {
  if (!COMPLETABLE_STATUSES.includes(o.status)) return { action: 'none' };
  if (!['delivery', 'pickup'].includes(o.fulfillment)) return { action: 'none' };

  const rr = o.restaurantReminder || {};
  const count = rr.forStatus === o.status ? (rr.askedCount || 0) : 0;
  const base = stageAt(o);
  if (now < base) return { action: 'none' }; // rejalashtirilgan — vaqti kelmagan

  const R = REMINDER_RULES;
  if (count < R.maxReminders) {
    const due = count === 0
      ? base + R.firstAfterMin * MIN
      : new Date(rr.lastAskedAt || base).getTime() + R.secondAfterMin * MIN;
    return now >= due ? { action: 'ask', n: count } : { action: 'none' };
  }

  if (o.fulfillment === 'delivery' && o.status === 'delivering') return { action: 'none' };
  const last = new Date(rr.lastAskedAt || base).getTime();
  if (now - base >= R.autoAfterStageHours * HOUR && now - last >= R.autoGraceAfterLastHours * HOUR) {
    return { action: 'auto' };
  }
  return { action: 'none' };
}

/**
 * Restoran "Yetkazildi"ni (deliveryCheck / restaurantReminder yo'li bilan)
 * tasdiqlay oladimi.
 *
 * PICKUP: doim mumkin (restoran o'zi topshiradi, oddiy PATCH delivered ham ruxsat).
 * DELIVERY: kuryer/mijoz tasdiqlashi kerak — restoran o'zi darhol yakunlasa,
 * kuryer taomni hali yetkazmasdan komissiya hisoblanib ketardi
 * (orderFlow.js PICKUP_ONLY_STATUSES). Shuning uchun restoran FAQAT shu
 * holatga o'tganidan `firstAfterMin` daqiqa o'tgach (bot 1-eslatmani
 * yuboradigan payt) yoki eslatma allaqachon yuborilgan bo'lsa tasdiqlaydi.
 *
 * Vaqt sharti eslatma YUBORILGANIGA emas, vaqtga qarab: restoran boti
 * o'chiq bo'lsa (RESTAURANT_BOT_TOKEN yo'q) eslatma umuman ketmaydi va
 * "yuborilgan bo'lsa" sharti abadiy bloklab qo'yardi.
 *
 * @returns {{ eligible: boolean, eligibleAt: Date|null }}
 */
export function confirmEligibility(o, now = Date.now()) {
  if (!COMPLETABLE_STATUSES.includes(o.status)) return { eligible: false, eligibleAt: null };
  if (o.fulfillment !== 'delivery') return { eligible: true, eligibleAt: null };

  const eligibleAt = new Date(stageAt(o) + REMINDER_RULES.firstAfterMin * MIN);
  const rr = o.restaurantReminder || {};
  const asked = rr.forStatus === o.status && (rr.askedCount || 0) >= 1;
  return { eligible: asked || now >= eligibleAt.getTime(), eligibleAt };
}
