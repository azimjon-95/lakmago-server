import { Restaurant } from '../models/Restaurant.js';
import { Dish } from '../models/Dish.js';
import { RestaurantTelegramStaff } from '../models/RestaurantTelegramStaff.js';
import { RestaurantDailyCheck } from '../models/RestaurantDailyCheck.js';
import { getIO } from '../sockets/io.js';
import {
  zoneDate, addDaysYmd, hhmmToMinutes, zonedToUtc, isRestaurantOpen,
} from './restaurantTime.js';
import {
  isRestaurantBotEnabled, sendToStaff, editStaffMessage, answerCallback, btn, esc,
} from './restaurantBotApi.js';
import { activeStaff } from './restaurantBotOrders.js';

/*
 * ═══════════════════════════════════════════════════════════
 * ERTALABKI OCHILISH TEKSHIRUVI (Morning Open Checklist)
 * ═══════════════════════════════════════════════════════════
 *
 * Har kuni restoran ochilish vaqtida barcha faol xodimlarga Telegram'da xabar:
 * "taomlaringizni tekshiring, stopdagilarni Stop-listga qo'shing". Ikki tugma:
 *   🛑 Stopga quyish — shu restoranning taomlari ro'yxati ochiladi (Stop / qaytarish)
 *   ✅ Barchasi bor  — "bugun tekshirildi", eslatmalar to'xtaydi
 * Hech qaysi tugma bosilmasa — har soatda eslatma (faqat ish vaqti ichida).
 * Panel (restoran paneli) ham xuddi shu holatni ko'rsatadi: banner.
 *
 * MAVJUD KODGA TA'SIR YO'Q: faqat yangi model (RestaurantDailyCheck), shu fayl, `mc:`
 * callback prefiksi va panel/admin uchun yangi endpointlar. Buyurtma oqimi, billing,
 * socket hodisalari o'zgarmagan (taomni stop qilish panel `updateDish` bilan AYNAN bir xil
 * hodisalarni yuboradi).
 *
 * KUN SANASI restoran vaqt zonasida (Toshkent) hisoblanadi; yarim tundan oshadigan
 * restoranda (22:00–02:00) tunda "sana" — ochilgan kun (sessionYmd).
 */

/** Xabar matni — TZ dagi AYNAN shu matn (imlo o'zgartirilmagan). */
export const MORNING_TEXT = 'Retoran ochilishi bilan taomlarizni rekshirib oling ish boshlashdan oldin '
  + 'Stopdagi taomlarizni Stop listga qushib quying esizdan chiqmasin '
  + 'mijizlarni hurmat qilaylik bugungi boshlagan ishizni olloh barokatli qilsin';

/**
 * Birinchi xabar oynasi (ochilish paytiga nisbatan, daqiqada, ikkala chegara ham kiradi).
 * Xabar OCHILISH PAYTIDA ketadi (before = 0); server qayta ishga tushsa yoki bitta tick
 * o'tib ketsa, 10 daqiqagacha kechikib yetkaziladi.
 */
export const FIRST_WINDOW = { beforeMin: 0, afterMin: 10 };
/** Eslatma oralig'i. */
export const REMINDER_EVERY_MIN = 60;
/** Bot menyusidagi bir sahifada nechta taom. */
export const MENU_PAGE_SIZE = 8;

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
const log = (...a) => console.log('[morningChecklist]', ...a);
const logErr = (...a) => console.error('[morningChecklist]', ...a);

/* ═══════════════════ VAQT QOIDALARI (sof funksiyalar) ═══════════════════ */

const tzOf = (r) => r?.timezone || 'Asia/Tashkent';
const weekdayOf = (ymd) => DAYS[new Date(`${ymd}T12:00:00Z`).getUTCDay()];

/** Restoran vaqt zonasidagi bugungi "YYYY-MM-DD". */
export function getTodayYmd(restaurant, now = Date.now()) {
  return zoneDate(tzOf(restaurant), new Date(now)).ymd;
}

/** Ochilish va yopilish vaqti aniq belgilanganmi (24 soat / belgilanmagan restoranda "ochilish" yo'q). */
export function hasOpeningTime(restaurant) {
  const open = hhmmToMinutes(restaurant?.openTime);
  const close = hhmmToMinutes(restaurant?.closeTime);
  return open !== null && close !== null && open !== close;
}

/**
 * Joriy ISH SEANSI sanasi. Yarim tundan oshadigan restoranda (22:00–02:00) soat 01:00 da
 * seans kechagi kunda ochilgan — sana kecha.
 */
export function sessionYmd(restaurant, now = Date.now()) {
  const { ymd, minutes } = zoneDate(tzOf(restaurant), new Date(now));
  const open = hhmmToMinutes(restaurant?.openTime);
  const close = hhmmToMinutes(restaurant?.closeTime);
  if (open !== null && close !== null && open > close && minutes < close) return addDaysYmd(ymd, -1);
  return ymd;
}

/**
 * Shu kun ish kunimi. workingDays BO'SH yoki YO'Q bo'lsa — HAR KUNI (platformaning qolgan qismi
 * kabi: Restaurant sxemasi "Bo'sh bo'lsa — har kuni", isRestaurantOpen ham shunday).
 *
 * DIQQAT: avval TZ ni so'zma-so'z bajarib bo'sh ro'yxatni "ish kuni emas" deb o'qigan edik —
 * ish kunlarini hech qachon sozlamagan restoranlar (ko'pchilik) xabar olmay qolgan. Ro'yxat
 * ko'rsatilgan bo'lsa (masalan, dushanba dam) — faqat o'sha kunlarda yuboriladi.
 */
export function isWorkday(restaurant, ymd) {
  const days = restaurant?.workingDays;
  if (!Array.isArray(days) || days.length === 0) return true;
  return days.includes(weekdayOf(ymd));
}

/** Shu sanadagi ochilish paytining haqiqiy (UTC) vaqti. */
export function openingInstant(restaurant, ymd) {
  return zonedToUtc(ymd, restaurant?.openTime, tzOf(restaurant));
}

/**
 * Birinchi xabar yuborilsinmi: ish kuni + ochilish oynasi ichida + bugungi yozuv hali
 * yo'q yoki (pending va birinchi xabar yuborilmagan).
 * @param check  bugungi RestaurantDailyCheck (bo'lsa)
 */
export function shouldSendFirstMessage(restaurant, now = Date.now(), check = null) {
  if (!hasOpeningTime(restaurant)) return false;
  const ymd = sessionYmd(restaurant, now);
  if (!isWorkday(restaurant, ymd)) return false;
  const opening = openingInstant(restaurant, ymd);
  if (!opening) return false;
  const diffMin = Math.floor((now - opening.getTime()) / 60_000);
  if (diffMin < -FIRST_WINDOW.beforeMin || diffMin > FIRST_WINDOW.afterMin) return false;
  if (check && !(check.status === 'pending' && !check.firstSentAt)) return false;
  return true;
}

/**
 * Eslatma yuborilsinmi: pending + birinchi xabar ketgan + oxirgisidan kamida 60 daqiqa +
 * shu seansning yozuvi + restoran HOZIR ochiq (yopilgach eslatma to'xtaydi).
 */
export function shouldSendReminder(restaurant, check, now = Date.now()) {
  if (!check || check.status !== 'pending' || !check.firstSentAt) return false;
  if (check.date !== sessionYmd(restaurant, now)) return false;
  const base = new Date(check.lastReminderAt || check.firstSentAt).getTime();
  if (now - base < REMINDER_EVERY_MIN * 60_000) return false;
  return isRestaurantOpen(restaurant, new Date(now));
}

/* ═══════════════════ YUBORISH ═══════════════════ */

export function morningKeyboard(restaurantId, date) {
  return {
    inline_keyboard: [[
      btn('🛑 Stopga quyish', `mc:stop:${restaurantId}:${date}`, 'primary'),
      btn('✅ Barchasi bor', `mc:all:${restaurantId}:${date}`, 'success'),
    ]],
  };
}

/**
 * Barcha faol xodimlarga yuboradi. Xabar id'lari yozuvda saqlanadi — javob berilgach
 * hamma xodimdagi tugmalar olib tashlanadi.
 * @returns {{ staff: number, sent: number }}
 */
export async function sendMorningMessage(restaurant, check, isReminder = false) {
  const staff = await activeStaff(restaurant._id);
  if (!staff.length) return { staff: 0, sent: 0 };

  const keyboard = morningKeyboard(String(restaurant._id), check.date);
  const results = await Promise.all(staff.map(async (s) => {
    try {
      const res = await sendToStaff(s.telegramUserId, esc(MORNING_TEXT), keyboard);
      const messageId = res?.result?.message_id;
      return messageId ? { chatId: String(s.telegramUserId), messageId, kind: isReminder ? 'reminder' : 'first', at: new Date() } : null;
    } catch (e) {
      logErr(`xodimga yuborib bo‘lmadi (${restaurant._id}):`, e.message);
      return null;
    }
  }));
  const delivered = results.filter(Boolean);
  if (delivered.length) {
    await RestaurantDailyCheck.updateOne({ _id: check._id }, { $push: { messages: { $each: delivered } } });
  }
  return { staff: staff.length, sent: delivered.length };
}

/** Birinchi xabar uchun yozuvni ATOMIK egallaydi: faqat bitta jarayon yuboradi. */
export async function claimFirst(restaurant, ymd, now) {
  try {
    return await RestaurantDailyCheck.findOneAndUpdate(
      { restaurantId: restaurant._id, date: ymd, status: 'pending', firstSentAt: null },
      { $set: { firstSentAt: new Date(now), lastReminderAt: new Date(now) } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
  } catch (e) {
    if (e?.code === 11000) return null;   // boshqa jarayon (yoki avvalgi tick) allaqachon egallagan
    throw e;
  }
}

/** Eslatma uchun yozuvni ATOMIK egallaydi (lastReminderAt shartli). */
async function claimReminder(check, now) {
  return RestaurantDailyCheck.findOneAndUpdate(
    {
      _id: check._id,
      status: 'pending',
      lastReminderAt: { $lte: new Date(now - REMINDER_EVERY_MIN * 60_000) },
    },
    { $set: { lastReminderAt: new Date(now) } },
    { new: true },
  );
}

let running = false;

/**
 * Har daqiqada (src/index.js). Barcha faol + tasdiqlangan + bloklanmagan restoranlarni
 * ko'rib chiqadi; birinchi xabar yoki eslatma yuboradi. Bitta restoran xatosi boshqalarni
 * to'xtatmaydi. Bot sozlanmagan bo'lsa hech narsa qilmaydi (panel banner o'zi ishlaydi).
 */
export async function checkMorningChecklists(now = Date.now()) {
  if (!isRestaurantBotEnabled()) return { skipped: 'bot-off', first: 0, reminders: 0 };
  if (running) return { skipped: 'running', first: 0, reminders: 0 };
  running = true;
  const out = { first: 0, reminders: 0, undelivered: 0, errors: 0 };
  try {
    const restaurants = await Restaurant.find({ isActive: true, isApproved: true, isBlocked: { $ne: true } })
      .select('name openTime closeTime timezone workingDays').lean();

    // Har qanday vaqt zonasidagi sessiya sanasi shu uch kundan biri
    const utcToday = new Date(now).toISOString().slice(0, 10);
    const dates = [addDaysYmd(utcToday, -1), utcToday, addDaysYmd(utcToday, 1)];

    // Xotirada tez saralash — DB ga faqat kerak bo'lganda boriladi
    const inWindow = [];
    for (const r of restaurants) {
      try { if (shouldSendFirstMessage(r, now)) inWindow.push(r); } catch (e) { out.errors++; logErr(`oyna hisobi (${r._id}):`, e.message); }
    }
    const windowIds = inWindow.map((r) => r._id);

    // Bitta so'rov: oynadagilarning mavjud yozuvlari + barcha kutayotgan (pending) yozuvlar
    const [existing, pending] = await Promise.all([
      windowIds.length
        ? RestaurantDailyCheck.find({ restaurantId: { $in: windowIds }, date: { $in: dates } }).select('restaurantId date status firstSentAt').lean()
        : [],
      RestaurantDailyCheck.find({ status: 'pending', firstSentAt: { $ne: null }, date: { $in: dates } })
        .select('restaurantId date status firstSentAt lastReminderAt reminderCount').lean(),
    ]);
    const existingKey = new Map(existing.map((c) => [`${c.restaurantId}|${c.date}`, c]));
    const byRestaurant = new Map(restaurants.map((r) => [String(r._id), r]));

    // 1) Birinchi xabarlar
    for (const r of inWindow) {
      try {
        const ymd = sessionYmd(r, now);
        const have = existingKey.get(`${r._id}|${ymd}`) || null;
        if (!shouldSendFirstMessage(r, now, have)) continue;
        const claimed = await claimFirst(r, ymd, now);
        if (!claimed) continue;
        const res = await sendMorningMessage(r, claimed, false);
        if (res.sent > 0) out.first++; else out.undelivered++;   // xodim yo'q/ulanmagan — yozuv saqlanadi, panel banner ishlaydi
        log(`birinchi xabar: ${r.name} (${ymd}) — ${res.sent}/${res.staff} xodim`);
      } catch (e) { out.errors++; logErr(`birinchi xabar (${r._id}):`, e.message); }
    }

    // 2) Eslatmalar
    for (const c of pending) {
      try {
        const r = byRestaurant.get(String(c.restaurantId));
        if (!r || !shouldSendReminder(r, c, now)) continue;
        const claimed = await claimReminder(c, now);
        if (!claimed) continue;                    // boshqa jarayon egallagan yoki javob berilgan
        const res = await sendMorningMessage(r, claimed, true);
        if (res.sent > 0) {
          await RestaurantDailyCheck.updateOne({ _id: claimed._id }, { $inc: { reminderCount: 1 } });
          out.reminders++;
        } else out.undelivered++;
        log(`eslatma: ${r.name} (${claimed.date}) — ${res.sent}/${res.staff} xodim`);
      } catch (e) { out.errors++; logErr(`eslatma (${c.restaurantId}):`, e.message); }
    }
  } finally {
    running = false;
  }
  return out;
}

/* ═══════════════════ JAVOB (bot va panel uchun umumiy) ═══════════════════ */

/**
 * Javobni ATOMIK yozadi: faqat pending bo'lsa. Bir vaqtda bir necha xodim bossa — bittasi
 * yutadi. @returns {{ check, already }}  already=true — allaqachon javob berilgan.
 */
export async function recordResponse({ restaurantId, date, status, by, byName = '', via, now = Date.now(), createIfMissing = false }) {
  const set = { status, respondedAt: new Date(now), respondedBy: String(by ?? ''), respondedByName: byName, respondedVia: via };
  const updated = await RestaurantDailyCheck.findOneAndUpdate(
    { restaurantId, date, status: 'pending' }, { $set: set }, { new: true },
  );
  if (updated) return { check: updated, already: false };

  const existing = await RestaurantDailyCheck.findOne({ restaurantId, date });
  if (existing) return { check: existing, already: true };
  if (!createIfMissing) return { check: null, already: false };

  try {
    const created = await RestaurantDailyCheck.create({ restaurantId, date, ...set });
    return { check: created, already: false };
  } catch (e) {
    if (e?.code === 11000) return { check: await RestaurantDailyCheck.findOne({ restaurantId, date }), already: true };
    throw e;
  }
}

const hhmm = (d, tz) => new Intl.DateTimeFormat('ru-RU', { timeZone: tz, hour: '2-digit', minute: '2-digit' }).format(d);

function resolvedText(status, name, at, tz) {
  const who = name ? `${esc(name)}, ` : '';
  return status === 'checked_all_ok'
    ? `${esc(MORNING_TEXT)}\n\n✅ <b>Tekshirildi — hammasi bor</b> (${who}${hhmm(at, tz)})`
    : `${esc(MORNING_TEXT)}\n\n🛑 <b>Stop-list yangilandi</b> (${who}${hhmm(at, tz)})`;
}

/** Javob berilgach — hamma xodimdagi xabarlardan tugmalarni olib tashlaydi (xato — jim). */
async function closeMessages(check, text, { exceptChatId = null, exceptMessageId = null } = {}) {
  const msgs = (check?.messages || []).filter((m) => !(String(m.chatId) === String(exceptChatId) && m.messageId === exceptMessageId));
  await Promise.all(msgs.map((m) => editStaffMessage(m.chatId, m.messageId, text, null).catch(() => {})));
}

const emitCheck = (restaurantId, status) => {
  getIO()?.to(`restaurant:${restaurantId}`).emit('morning:check', { status });
};

/* ═══════════════════ BOT CALLBACK (mc:) ═══════════════════ */

const staffName = (s) => [s.firstName, s.lastName].filter(Boolean).join(' ') || (s.username ? `@${s.username}` : '');

/**
 *   mc:all:{restaurantId}:{date}        — "Barchasi bor"
 *   mc:stop:{restaurantId}:{date}       — "Stopga quyish" → taomlar ro'yxati
 *   mc:menu:{restaurantId}:{page}       — ro'yxat sahifasi
 *   mc:set:{dishId}:{0|1}:{page}        — taomni stopga (0) yoki qaytarish (1): ANIQ holat — idempotent
 *   mc:done:{restaurantId}              — ro'yxatni yopish
 *
 * XAVFSIZLIK: xodim bazadan telegram id bo'yicha topiladi; tugmadagi restaurantId
 * xodimning O'Z restoraniga teng bo'lishi shart — begona restoran menyusiga kirib
 * bo'lmaydi. Taom ham faqat xodimning restoranidan qidiriladi.
 */
export async function handleMorningChecklistCallback(cq) {
  const [, action, a, b, c] = String(cq.data || '').split(':');
  const staff = await RestaurantTelegramStaff.findOne({ telegramUserId: String(cq.from?.id), isActive: true }).lean();
  if (!staff) {
    await answerCallback(cq.id, 'Sizning akkauntingiz ulanmagan', { alert: true });
    return;
  }
  const restaurantId = String(staff.restaurantId);
  const chatId = String(cq.from?.id);
  const messageId = cq.message?.message_id;

  // Dish tugmasida restoran id yo'q — taom xodimning restoranidan qidiriladi
  if (action !== 'set' && a !== restaurantId) {
    await answerCallback(cq.id, 'Bu tugma sizning restoraningizga tegishli emas', { alert: true });
    return;
  }

  const restaurant = await Restaurant.findById(restaurantId).select('name timezone openTime closeTime workingDays').lean();
  if (!restaurant) { await answerCallback(cq.id); return; }

  if (action === 'all' || action === 'stop') {
    if (!YMD_RE.test(b || '')) { await answerCallback(cq.id, 'Eskirgan eslatma'); return; }
    const status = action === 'all' ? 'checked_all_ok' : 'checked_with_stop';
    const { check, already } = await recordResponse({
      restaurantId: staff.restaurantId, date: b, status, by: chatId, byName: staffName(staff), via: 'bot',
    });
    if (!check) { await answerCallback(cq.id, 'Eskirgan eslatma'); return; }

    if (action === 'all') {
      await answerCallback(cq.id, already ? 'Allaqachon tekshirilgan' : '✅ Rahmat! Bugun tekshirildi');
      if (!already) {
        await closeMessages(check, resolvedText(status, staffName(staff), new Date(), tzOf(restaurant)));
        emitCheck(restaurantId, status);
      }
      return;
    }

    // "Stopga quyish": holat yozildi; taomlar ro'yxati shu xabarda ochiladi (allaqachon
    // tekshirilgan bo'lsa ham ro'yxat ochiladi — xodim stop qilmoqchi)
    await answerCallback(cq.id, already ? 'Allaqachon tekshirilgan — ro‘yxat ochildi' : '🛑 Taomlar ro‘yxati');
    if (!already) {
      await closeMessages(check, resolvedText(status, staffName(staff), new Date(), tzOf(restaurant)), { exceptChatId: chatId, exceptMessageId: messageId });
      emitCheck(restaurantId, status);
    }
    await showMenu({ restaurant, restaurantId, chatId, messageId, page: 0 });
    return;
  }

  if (action === 'menu') {
    await answerCallback(cq.id);
    await showMenu({ restaurant, restaurantId, chatId, messageId, page: Number.parseInt(b, 10) || 0 });
    return;
  }

  if (action === 'set') {
    const dishId = a;
    const available = b === '1';
    const page = Number.parseInt(c, 10) || 0;
    if (!/^[a-f\d]{24}$/i.test(dishId || '')) { await answerCallback(cq.id, 'Taom topilmadi'); return; }
    const dish = await setDishAvailability(restaurantId, dishId, available);
    if (!dish) { await answerCallback(cq.id, 'Taom topilmadi', { alert: true }); return; }
    await answerCallback(cq.id, available ? `✅ ${dish.name} — stopdan chiqdi` : `🛑 ${dish.name} — stopga qo‘yildi`);
    await showMenu({ restaurant, restaurantId, chatId, messageId, page });
    return;
  }

  if (action === 'done') {
    const stopped = await Dish.countDocuments({ restaurantId: staff.restaurantId, isAvailable: false });
    await answerCallback(cq.id, '✅ Tayyor');
    await editStaffMessage(chatId, messageId,
      `✅ <b>Stop-list yangilandi.</b> ${stopped ? `Hozir stopda: <b>${stopped}</b> ta taom.` : 'Stopda taom yo‘q.'}`, null).catch(() => {});
    return;
  }

  await answerCallback(cq.id);
}

/**
 * Taomni stopga qo'yadi / qaytaradi. Panel `updateDish` bilan AYNAN bir xil hodisalar:
 * `dish:stop` (restoran xonasi, stoppedCount bilan) va `dish:update` — shuning uchun
 * paneldagi Stop List belgisi darhol yangilanadi.
 */
export async function setDishAvailability(restaurantId, dishId, isAvailable) {
  const dish = await Dish.findOneAndUpdate(
    { _id: dishId, restaurantId },       // faqat o'z restoranining taomi
    { isAvailable },
    { new: true },
  );
  if (!dish) return null;
  const count = await Dish.countDocuments({ restaurantId, isAvailable: false });
  const io = getIO();
  io?.to(`restaurant:${restaurantId}`).emit('dish:stop', { dishId: String(dish._id), isAvailable: dish.isAvailable, stoppedCount: count });
  io?.emit('dish:update', { restaurantId: String(restaurantId) });
  return dish;
}

/* ═══════════════════ BOT MENYUSI: TAOMLAR RO'YXATI ═══════════════════ */

const clip = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));

/**
 * Taomlar sahifasi. Tartib BARQAROR (bo'lim, nom): bosganda taom sakrab ketmaydi.
 * Tugma matni HOZIRGI holatni ko'rsatadi: ✅ bor (bossangiz stopga), 🛑 stopda (bossangiz qaytadi).
 */
export async function renderMenu(restaurant, restaurantId, page = 0) {
  const dishes = await Dish.find({ restaurantId }).select('name isAvailable section').sort({ section: 1, name: 1 }).lean();
  const stopped = dishes.filter((d) => d.isAvailable === false).length;
  const pages = Math.max(1, Math.ceil(dishes.length / MENU_PAGE_SIZE));
  const p = Math.min(Math.max(0, page), pages - 1);
  const slice = dishes.slice(p * MENU_PAGE_SIZE, (p + 1) * MENU_PAGE_SIZE);

  const lines = [
    `🛑 <b>Stop-list</b> — ${esc(restaurant?.name || 'Restoran')}`,
    '',
    dishes.length
      ? 'Stopga qo‘yish uchun taom nomini bosing. 🛑 belgili taomlar hozir stopda — qaytarish uchun bosing.'
      : 'Menyuda hali taom yo‘q.',
    `Stopda: <b>${stopped}</b> ta · Sahifa ${p + 1}/${pages}`,
  ];

  const rows = slice.map((d) => [btn(
    `${d.isAvailable === false ? '🛑' : '✅'} ${clip(d.name, 36)}`,
    `mc:set:${d._id}:${d.isAvailable === false ? 1 : 0}:${p}`,
    d.isAvailable === false ? 'danger' : undefined,
  )]);
  const nav = [];
  if (p > 0) nav.push(btn('◀️', `mc:menu:${restaurantId}:${p - 1}`));
  if (p < pages - 1) nav.push(btn('▶️', `mc:menu:${restaurantId}:${p + 1}`));
  if (nav.length) rows.push(nav);
  rows.push([btn('✅ Tayyor', `mc:done:${restaurantId}`, 'success')]);

  return { text: lines.join('\n'), keyboard: { inline_keyboard: rows }, page: p, pages, stopped, total: dishes.length };
}

async function showMenu({ restaurant, restaurantId, chatId, messageId, page }) {
  const view = await renderMenu(restaurant, restaurantId, page);
  if (messageId) {
    await editStaffMessage(chatId, messageId, view.text, view.keyboard).catch(() => {});
  } else {
    await sendToStaff(chatId, view.text, view.keyboard);
  }
  return view;
}

/* ═══════════════════ PANEL VA ADMIN ═══════════════════ */

const viewOf = (check, ymd, status = null) => ({
  status: check ? check.status : status,
  reminderCount: check?.reminderCount || 0,
  firstSentAt: check?.firstSentAt || null,
  date: ymd,
});

/**
 * Restoran paneli: bugungi holat.
 *   • javob berilgan → o'sha holat;
 *   • javob yo'q → faqat ish kuni, ochilgandan keyin va restoran ochiq paytida 'pending'
 *     (ochilishdan oldin / yopilgach / dam olish kunida banner ko'rinmasin → status null);
 *   • bot yo'q yoki xodim ulanmagan bo'lsa ham banner ishlaydi (yozuv shart emas).
 */
export async function getPanelMorningStatus(restaurant, now = Date.now()) {
  const ymd = sessionYmd(restaurant, now);
  const check = await RestaurantDailyCheck.findOne({ restaurantId: restaurant._id, date: ymd }).lean();
  if (check && check.status !== 'pending') return viewOf(check, ymd);

  if (restaurant.isActive === false || restaurant.isBlocked) return viewOf(null, ymd);
  if (!hasOpeningTime(restaurant) || !isWorkday(restaurant, ymd)) return viewOf(null, ymd);
  const opening = openingInstant(restaurant, ymd);
  if (!opening || now < opening.getTime()) return viewOf(null, ymd);
  if (!isRestaurantOpen(restaurant, new Date(now))) return viewOf(null, ymd);
  return viewOf(check, ymd, 'pending');
}

/** Panel: "Barchasi bor". Idempotent — qayta bosilsa xato bermaydi. */
export async function panelMarkAllOk(restaurant, userId, now = Date.now()) {
  const ymd = sessionYmd(restaurant, now);
  const { check, already } = await recordResponse({
    restaurantId: restaurant._id, date: ymd, status: 'checked_all_ok', by: userId, byName: 'Panel', via: 'panel', now, createIfMissing: true,
  });
  if (check && !already) {
    await closeMessages(check, resolvedText('checked_all_ok', 'Panel', new Date(now), tzOf(restaurant)));
    emitCheck(String(restaurant._id), 'checked_all_ok');
  }
  return { ok: true, already, status: check?.status || 'checked_all_ok' };
}

/** Admin jadvali: barcha faol restoranlar uchun shu kunning holati. */
export async function listMorningChecks(date) {
  const restaurants = await Restaurant.find({ isActive: true, isApproved: true, isBlocked: { $ne: true } })
    .select('name openTime closeTime workingDays timezone').sort({ name: 1 }).lean();
  const checks = await RestaurantDailyCheck.find({ date }).lean();
  const byId = new Map(checks.map((c) => [String(c.restaurantId), c]));
  return restaurants.map((r) => {
    const c = byId.get(String(r._id));
    return {
      restaurantId: String(r._id),
      name: r.name,
      openTime: r.openTime || '',
      status: c ? c.status : 'not_sent',
      reminderCount: c?.reminderCount || 0,
      firstSentAt: c?.firstSentAt || null,
      respondedAt: c?.respondedAt || null,
      respondedBy: c?.respondedByName || c?.respondedBy || '',
      respondedVia: c?.respondedVia || null,
    };
  });
}

/* ═══════════════════ DIAGNOSTIKA (faqat o'qiydi) ═══════════════════ */

/**
 * "Nega bu restoranga ertalabki xabar ketmadi / ketmaydi?" — sabablar ro'yxati.
 * Sof funksiya: bazaga murojaat qilmaydi (ma'lumotni chaqiruvchi beradi).
 *
 * @returns {{ blockers: Array<{code,text}>, state: string, detail: string }}
 *   state: blocked | waiting | in-window | missed | sent | answered
 */
export function explainMorning(r, { now = Date.now(), staffCount = 0, check = null, botEnabled = true } = {}) {
  const blockers = [];
  const add = (code, text) => blockers.push({ code, text });

  if (!botEnabled) add('BOT_OFF', 'RESTAURANT_BOT_TOKEN .env da yo‘q — bot hech kimga yubormaydi');
  if (r.isActive === false) add('INACTIVE', 'Restoran nofaol (isActive=false)');
  if (r.isBlocked) add('BLOCKED', 'Restoran bloklangan');
  if (r.isApproved === false) add('NOT_APPROVED', 'Restoran tasdiqlanmagan (isApproved=false)');
  if (!hasOpeningTime(r)) add('NO_HOURS', `Ochilish/yopilish vaqti yo‘q yoki 24 soat (openTime=${JSON.stringify(r.openTime ?? null)}, closeTime=${JSON.stringify(r.closeTime ?? null)})`);

  const ymd = sessionYmd(r, now);
  if (hasOpeningTime(r) && !isWorkday(r, ymd)) add('OFF_DAY', `Bugun ish kuni emas (workingDays=${JSON.stringify(r.workingDays)}, bugun=${weekdayOf(ymd)})`);
  if (!staffCount) add('NO_STAFF', 'Botga ulangan faol xodim yo‘q (RestaurantTelegramStaff: telegramUserId yo‘q yoki isActive=false) — faqat panel banner ishlaydi');

  let state = 'blocked'; let detail = '';
  if (check?.status && check.status !== 'pending') {
    state = 'answered';
    detail = `${check.status === 'checked_all_ok' ? 'Barchasi bor' : 'Stopga qo‘yildi'} (${check.respondedVia || '?'}, ${check.respondedByName || check.respondedBy || '?'})`;
  } else if (check?.firstSentAt) {
    state = 'sent';
    detail = `birinchi xabar ${new Date(check.firstSentAt).toISOString()}, eslatma: ${check.reminderCount || 0}, yetkazilgan xabar: ${(check.messages || []).length}`;
  } else if (hasOpeningTime(r)) {
    const opening = openingInstant(r, ymd);
    const diffMin = opening ? Math.floor((now - opening.getTime()) / 60_000) : null;
    if (diffMin === null) { detail = 'ochilish vaqtini hisoblab bo‘lmadi'; }
    else if (diffMin < -FIRST_WINDOW.beforeMin) { state = 'waiting'; detail = `ochilishiga ${-diffMin} daqiqa qoldi (${r.openTime})`; }
    else if (diffMin <= FIRST_WINDOW.afterMin) { state = 'in-window'; detail = `oyna ichida (ochilganiga ${diffMin} daq) — keyingi tick'da yuboriladi`; }
    else {
      state = 'missed';
      detail = `OYNA O‘TIB KETGAN: ${r.openTime} da ochilgan (${diffMin} daq oldin), birinchi xabar ketmagan — bugun bot YUBORMAYDI (eslatma ham faqat birinchi xabardan keyin). Sabab: server shu paytda ishlamagan/yangi kod hali yoqilmagan, yoki yuqoridagi to‘siqlardan biri`;
    }
  }
  if (blockers.length && state !== 'answered' && state !== 'sent') state = 'blocked';
  return { blockers, state, detail };
}

/** Bazadan o'qib, har restoran uchun diagnostika. `name` — nom bo'yicha qidirish, `all` — nofaollarni ham. */
export async function diagnoseMorning({ now = Date.now(), name = null, all = false } = {}) {
  const filter = all ? {} : { isActive: { $ne: false }, isBlocked: { $ne: true } };
  if (name) filter.name = new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const restaurants = await Restaurant.find(filter).select('name openTime closeTime timezone workingDays isActive isApproved isBlocked').sort({ name: 1 }).lean();
  const ids = restaurants.map((r) => r._id);
  const utcToday = new Date(now).toISOString().slice(0, 10);
  const dates = [addDaysYmd(utcToday, -1), utcToday, addDaysYmd(utcToday, 1)];
  const [staff, checks] = await Promise.all([
    RestaurantTelegramStaff.aggregate([{ $match: { restaurantId: { $in: ids }, isActive: true, telegramUserId: { $ne: null } } }, { $group: { _id: '$restaurantId', n: { $sum: 1 } } }]),
    RestaurantDailyCheck.find({ restaurantId: { $in: ids }, date: { $in: dates } }).lean(),
  ]);
  const staffBy = new Map(staff.map((s) => [String(s._id), s.n]));
  const checkBy = new Map(checks.map((c) => [`${c.restaurantId}|${c.date}`, c]));
  const botEnabled = isRestaurantBotEnabled();
  return {
    now: new Date(now).toISOString(), botEnabled,
    rows: restaurants.map((r) => {
      const ymd = sessionYmd(r, now);
      const check = checkBy.get(`${r._id}|${ymd}`) || null;
      return { id: String(r._id), name: r.name, openTime: r.openTime, closeTime: r.closeTime, workingDays: r.workingDays || [], date: ymd,
        staff: staffBy.get(String(r._id)) || 0, ...explainMorning(r, { now, staffCount: staffBy.get(String(r._id)) || 0, check, botEnabled }) };
    }),
  };
}
