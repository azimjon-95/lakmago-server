import { Order } from '../models/Order.js';
import { RestaurantBotMessage } from '../models/RestaurantBotMessage.js';
import { activeStaff, refreshOrderMessages } from './restaurantBotOrders.js';
import { sendToStaff, tgCall, answerCallback, btn, esc } from './restaurantBotApi.js';
import { confirmOrderDelivered } from './deliveryCheck.js';
import { COMPLETABLE_STATUSES, REMINDER_RULES, planReminder } from './reminderRules.js';
import { orderLabel } from './orderNumber.js';

/*
 * ═══════════════════════════════════════════════════════════
 * RESTORANGA ESLATMA — BUYURTMA YAKUNLANMASDAN QOLIB KETMASIN
 * ═══════════════════════════════════════════════════════════
 *
 * MUAMMO: xodim buyurtmani qabul qiladi, lekin oxirigacha
 * yakunlamaydi — "Kuryerga topshirildi", kuryerning "Topshirdim"
 * yoki "Mijozga topshirildi" bosilmay qoladi. Buyurtma ochiq
 * qoladi va komissiya (billing.settleOrder) HECH QACHON
 * hisoblanmaydi. Mavjud 12 soatlik tarmoq (deliveryCheck.js) faqat
 * 'delivering' holatini ko'rardi — "Tayyor"da qotib qolgan
 * yetkazib berish buyurtmalari abadiy ochiq qolardi.
 *
 * NEGA ESLATMA RESTORANGA: kuryerlarda hozircha login yo'q
 * (courierDispatch.js — havola shaxsiy Telegram/WhatsApp orqali
 * ulashiladi), tizim kuryerni topib yoza olmaydi. Restoran esa
 * kuryer bilan ham, mijoz bilan ham bog'lana oladi.
 *
 * OQIM (yetkazib berish va olib ketish, barcha faol holatlar):
 *   holatga o'tgandan +30 daq → 1-eslatma  [✅ Yakunlandi] [⏳ Jarayonda]
 *   1-eslatmadan     +30 daq → 2-eslatma (+ avtomatik yakunlash ogohlantirishi)
 *   javob bo'lmasa: holatga o'tgandan ≥12 soat VA 2-eslatmadan ≥3 soat
 *                   → avtomatik yakunlanadi (confirmedBy: 'auto')
 *
 * Nozik joylar:
 *   • Xodim orada buyurtmani oldinga sursa (masalan "Tayyor") —
 *     hisob yangi holat uchun noldan (forStatus).
 *   • Rejalashtirilgan buyurtma (ertangi tort) — vaqti kelmaguncha
 *     so'ralmaydi: hisob scheduledFor'dan boshlanadi.
 *   • Eski buyurtmalarda restaurantReminder maydoni YO'Q — bazada
 *     `askedCount < 2` bilan filtrlansa ular hech qachon topilmasdi.
 *     Shuning uchun faol buyurtmalar olinadi va qaror JS'da.
 *   • Deploy paytida kunlar oldin qotib qolgan buyurtma: avval 2
 *     eslatma, keyin kamida 3 soat kutiladi — xodimga javob berish
 *     uchun vaqt qoladi, jimgina yakunlanmaydi.
 *   • Yetkazib berish 'delivering'da avtomatik yakunlash BU YERDA
 *     qilinmaydi — deliveryCheck.js ning 12 soatlik tarmog'i
 *     allaqachon qiladi (ikki joyda takrorlanmasin).
 *   • Yakunlash atomik (deliveryCheck.confirmOrderDelivered) — bekor
 *     qilingan buyurtma yakunlanmaydi, pul ikki marta yozilmaydi.
 */

// Sof qoidalar (jadval, planReminder, tasdiqlash sharti) — reminderRules.js da.
// Bu yerdan qayta eksport qilinadi: mavjud importlar va testlar o'zgarmaydi.
export { REMINDER_RULES, planReminder, confirmEligibility } from './reminderRules.js';

const HOUR = 60 * 60_000;
const TZ = 'Asia/Tashkent';

function when(o) {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(new Date(o.createdAt));
}

export function reminderText(o, n) {
  const head = n === 0 ? '🔔 <b>Buyurtma yakunlanmagan</b>' : '🔔 <b>Yana eslatma — buyurtma hali ochiq</b>';
  const ref = `<b>${esc(orderLabel(o))}</b> · ${when(o)}`;
  let body;
  if (o.fulfillment === 'pickup') {
    body = 'Mijoz o‘zi olib ketadi. Mijoz kelib <b>olib ketdimi</b>?';
  } else if (o.status === 'delivering') {
    body = 'Kuryerga topshirilgan. Kuryer mijozga <b>yetkazdimi</b>?';
  } else {
    body = 'Qabul qilingan, lekin kuryerga topshirilgani belgilanmagan. Buyurtma mijozga <b>yetkazildimi</b>?';
  }
  const warn = n >= 1
    ? '\n\n<i>Javob bo‘lmasa, buyurtma bir necha soatdan keyin avtomatik yakunlangan hisoblanadi.</i>'
    : '';
  return `${head}\n\n${ref}\n${body}${warn}`;
}

function reminderKeyboard(o) {
  return { inline_keyboard: [[
    btn('✅ Yakunlandi', `o:remyes:${o._id}`, 'success'),
    btn('⏳ Jarayonda', `o:remno:${o._id}`),
  ]] };
}

async function ask(o, n) {
  const staff = await activeStaff(o.restaurantId);
  if (!staff.length) return false;

  const text = reminderText(o, n);
  const keyboard = reminderKeyboard(o);
  const results = await Promise.all(staff.map(async (s) => {
    const res = await sendToStaff(s.telegramUserId, text, keyboard);
    const messageId = res?.result?.message_id;
    if (messageId) {
      await RestaurantBotMessage.create({
        orderId: o._id, telegramUserId: String(s.telegramUserId), messageId, kind: 'reminder',
      }).catch(() => {});
    }
    return Boolean(res?.ok);
  }));
  if (!results.some(Boolean)) return false;

  // Holat o'zgargan bo'lsa (orada xodim bosgan) — yozilmaydi
  await Order.updateOne({ _id: o._id, status: o.status }, {
    $set: { restaurantReminder: { askedCount: n + 1, lastAskedAt: new Date(), forStatus: o.status } },
  });
  return true;
}

/** Barcha xodimlardagi eslatma nusxalaridan tugmalarni olib tashlaydi. */
export async function clearReminderButtons(orderId) {
  const msgs = await RestaurantBotMessage.find({ orderId, kind: 'reminder' }).lean();
  await Promise.all(msgs.map((m) => tgCall('editMessageReplyMarkup', {
    chat_id: m.telegramUserId, message_id: m.messageId, reply_markup: { inline_keyboard: [] },
  }).catch(() => {})));
}

/** Har 2 daqiqada (src/index.js). */
export async function checkRestaurantReminders(now = Date.now()) {
  const since = new Date(now - REMINDER_RULES.lookbackDays * 24 * HOUR);
  const orders = await Order.find({
    fulfillment: { $in: ['delivery', 'pickup'] },
    status: { $in: COMPLETABLE_STATUSES },
    createdAt: { $gte: since },
  }).limit(500).lean();

  let sent = 0;
  let autoCompleted = 0;
  for (const o of orders) {
    const plan = planReminder(o, now);
    try {
      if (plan.action === 'ask' && await ask(o, plan.n)) sent++;
      if (plan.action === 'auto') {
        const done = await confirmOrderDelivered(o._id, 'auto', { restaurantId: o.restaurantId });
        if (done) {
          autoCompleted++;
          await clearReminderButtons(o._id);
          await refreshOrderMessages(o._id).catch(() => {});
        }
      }
    } catch (e) {
      console.error(`[restaurantReminder] ${plan.action} xatosi (${o._id}):`, e.message);
    }
  }
  return { sent, autoCompleted, checked: orders.length };
}

/**
 * "✅ Yakunlandi" / "⏳ Jarayonda" — restaurantBotOrders.js dan
 * (o:remyes / o:remno). Egalik xodimning BAZADAGI bog'lanishidan.
 */
export async function handleReminderCallback(cq, staff, action, orderId) {
  const order = await Order.findOne({ _id: orderId, restaurantId: staff.restaurantId })
    .select('_id status').lean();
  if (!order) {
    await answerCallback(cq.id, 'Buyurtma topilmadi', { alert: true });
    return;
  }

  // Bitta xodim javob berdi — boshqalardagi nusxalar ham yopiladi
  await clearReminderButtons(order._id);

  if (action === 'remno') {
    await answerCallback(cq.id, '⏳ Tushunarli, keyinroq yana so‘raymiz');
    return;
  }

  const done = await confirmOrderDelivered(order._id, 'restaurant', { restaurantId: staff.restaurantId });
  if (!done) {
    await answerCallback(cq.id, 'Bu buyurtma allaqachon yakunlangan yoki bekor qilingan', { alert: true });
    return;
  }
  await answerCallback(cq.id, '✅ Yakunlandi, rahmat!');
  // Buyurtma kartasidagi eski tugmalar ("Kuryerga topshirildi" va h.k.) yangilanadi
  await refreshOrderMessages(order._id).catch(() => {});
}
