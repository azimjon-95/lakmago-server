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


/*
 * ═══ MIJOZGA "QABUL QILDINGIZMI?" SO'ROVI — SOF QOIDA ═══
 *
 * MUAMMO: buyurtma qabul qilinadi, lekin oxirigacha yetkazilgani belgilanmaydi
 * (restoran "Kuryerga topshirildi"ni, kuryer "Topshirdim"ni bosmaydi) — buyurtma
 * ochiq qoladi va komissiya/pul hisobi tushmaydi.
 *
 * QOIDA (services/deliveryCheck.js checkDeliveries ishlatadi):
 *   • accepted / preparing / ready (yetkazib berish): QABUL QILINGANIDAN
 *     `firstAfterAcceptMin` (60) daqiqa o'tib hali yakunlanmagan bo'lsa — mijozga
 *     bot orqali [✅ Ha, qabul qildim] [⏳ Kutyapman] yuboriladi;
 *   • delivering: avvalgidek — kuryer olib ketganidan +20 daq (kuryerga vaqt beriladi);
 *   • keyingi so'rovlar: avvalgisidan +10, +30 daq (jami 3 ta — hisoblagich umumiy);
 *   • rejalashtirilgan buyurtma (scheduledFor) — vaqti kelmaguncha so'ralmaydi.
 */
export const CUSTOMER_ASK = {
  firstAfterAcceptMin: 60,
  deliveringFirstMin: 20,
  gapsMin: [20, 10, 30], // [n]-so'rovdan oldingi kutish (n=0 — birinchi)
  maxAsks: 3,
};

/** Sof qaror: mijozdan hozir so'rash kerakmi. @returns {{ ask: boolean, n?: number, dueAt?: number }} */
export function planCustomerAsk(o, now = Date.now()) {
  const R = CUSTOMER_ASK;
  if (!COMPLETABLE_STATUSES.includes(o.status)) return { ask: false };
  if (!o.userId) return { ask: false }; // zal buyurtmasida mijoz hisobi yo'q
  // Yetkazib berishdan tashqari faqat eski 'delivering' yo'li (avvalgi xatti-harakat)
  if (o.status !== 'delivering' && o.fulfillment !== 'delivery') return { ask: false };

  const dc = o.deliveryCheck || {};
  if (dc.confirmed) return { ask: false };
  const count = dc.askedCount || 0;
  if (count >= R.maxAsks) return { ask: false };

  const T = (d) => new Date(d).getTime();
  let due;
  if (count > 0) {
    due = T(dc.lastAskedAt || o.updatedAt || o.createdAt) + R.gapsMin[count] * MIN;
  } else if (o.status === 'delivering') {
    due = T(o.deliveringAt || o.updatedAt || o.createdAt) + R.deliveringFirstMin * MIN;
  } else {
    const accepted = T(o.acceptedAt || o.createdAt);
    const stage = o.scheduledFor ? Math.max(accepted, T(o.scheduledFor)) : accepted;
    due = stage + R.firstAfterAcceptMin * MIN;
  }
  return { ask: now >= due, n: count, dueAt: due };
}
