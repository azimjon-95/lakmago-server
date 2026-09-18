import { BotBroadcast, BotBroadcastDelivery } from '../models/BotBroadcast.js';
import { RestaurantTelegramStaff } from '../models/RestaurantTelegramStaff.js';
import { Restaurant } from '../models/Restaurant.js';
import { isRestaurantBotEnabled, tgCall, esc, btn, urlBtn, answerCallback } from './restaurantBotApi.js';

/*
 * ═══════════════════════════════════════════════════════════
 * RESTORAN BOTLARI — XABAR TARQATISH
 * ═══════════════════════════════════════════════════════════
 *
 * IZOLYATSIYA: bu modul faqat O'ZINING modellari bilan ishlaydi
 * va restaurantBotApi dan transportni oladi. Buyurtma, bron,
 * moliya yoki menyu oqimlariga TEGMAYDI.
 *
 * ─── TELEGRAM CHEKLOVLARI ───
 * Bot sekundiga ~30 ta xabar yubora oladi. Undan tez yuborilsa
 * 429 (Too Many Requests) qaytadi va xabarlar yo'qoladi. Shuning
 * uchun yuborish PORSIYALAB, oraliq bilan boradi va 429 kelsa
 * `retry_after` gacha kutiladi.
 *
 * ─── NIMA O'LCHANADI ───
 *   sent    — Telegram qabul qildi
 *   failed  — xato (bot bloklangan, chat yo'q ...)
 *   clicked — tugma bosildi
 * "O'qidi" ni Telegram BERMAYDI — u o'lchanmaydi.
 */

const BATCH = 25;            // bir porsiyada nechta xabar
const PAUSE_MS = 1100;       // porsiyalar orasidagi tanaffus
const MAX_RETRY = 2;         // 429 dan keyin necha marta qayta urinish

/** Xabarni Telegram uchun tayyorlaydi. */
function buildMessage(broadcast) {
  const text = broadcast.format === 'html'
    ? broadcast.text
    : esc(broadcast.text);

  const rows = (broadcast.buttons || []).map((b) => [
    b.kind === 'url'
      ? urlBtn(b.text, b.url)
      : btn(b.text, `b:${broadcast._id}:${b.key}`, 'primary'),
  ]);

  return {
    text,
    reply_markup: rows.length ? { inline_keyboard: rows } : undefined,
  };
}

/** Bitta xodimga yuborish. 429 bo'lsa kutib qayta uriniladi. */
async function sendOne(chatId, message, attempt = 0) {
  const res = await tgCall('sendMessage', {
    chat_id: chatId,
    text: message.text,
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    ...(message.reply_markup ? { reply_markup: message.reply_markup } : {}),
  });

  if (res?.ok) return { ok: true, messageId: res.result?.message_id };

  /*
   * Telegram "sekinlang" dedi — kutib qayta urinamiz.
   *
   * DIQQAT: `retry_after` 0 ham bo'lishi mumkin. Oddiy
   * `if (retryAfter)` tekshiruvi nolni "yo'q" deb qabul qilib,
   * xabarni yo'qotib yuborardi — shuning uchun son ekani
   * aniq tekshiriladi.
   */
  const retryAfter = Number(res?.parameters?.retry_after);
  if (Number.isFinite(retryAfter) && attempt < MAX_RETRY) {
    await new Promise((r) => setTimeout(r, (retryAfter + 1) * 1000));
    return sendOne(chatId, message, attempt + 1);
  }

  return { ok: false, error: res?.description || 'Telegram javob bermadi' };
}

/**
 * Xabarni yuboradi va har bir oluvchi uchun yozuv qoldiradi.
 *
 * @param {string} broadcastId
 * @returns {Promise<object>} yangilangan statistika
 */
export async function sendBroadcast(broadcastId) {
  const broadcast = await BotBroadcast.findById(broadcastId);
  if (!broadcast) throw new Error('Xabar topilmadi');

  if (broadcast.status === 'sending' || broadcast.status === 'sent') {
    throw new Error('Bu xabar allaqachon yuborilgan');
  }
  if (!isRestaurantBotEnabled()) {
    throw new Error('Restoran boti sozlanmagan (RESTAURANT_BOT_TOKEN)');
  }

  // Oluvchilar: ulangan, faol xodimlar
  const filter = { isActive: true, telegramUserId: { $ne: null } };
  if (broadcast.target === 'selected') {
    if (!broadcast.restaurantIds?.length) throw new Error('Restoran tanlanmagan');
    filter.restaurantId = { $in: broadcast.restaurantIds };
  }

  const staff = await RestaurantTelegramStaff.find(filter)
    .select('telegramUserId firstName username restaurantId').lean();

  if (!staff.length) throw new Error('Botga ulangan xodim topilmadi');

  const restaurants = await Restaurant.find({
    _id: { $in: [...new Set(staff.map((s) => String(s.restaurantId)))] },
  }).select('name').lean();
  const nameById = new Map(restaurants.map((r) => [String(r._id), r.name]));

  broadcast.status = 'sending';
  broadcast.stats.total = staff.length;
  broadcast.stats.restaurants = nameById.size;
  await broadcast.save();

  const message = buildMessage(broadcast);
  let sent = 0;
  let failed = 0;

  for (let i = 0; i < staff.length; i += BATCH) {
    const chunk = staff.slice(i, i + BATCH);

    // Porsiya ichida parallel — Telegram sekundiga ~30 tani ko'taradi
    const results = await Promise.all(chunk.map(async (s) => {
      const r = await sendOne(s.telegramUserId, message);
      return { staff: s, ...r };
    }));

    for (const r of results) {
      if (r.ok) sent++; else failed++;
      /*
       * `updateOne + upsert` — qayta ishga tushirilsa ham bir
       * xodim uchun ikkinchi yozuv paydo bo'lmaydi (unique indeks).
       */
      await BotBroadcastDelivery.updateOne(
        { broadcastId: broadcast._id, telegramUserId: r.staff.telegramUserId },
        {
          $set: {
            restaurantId: r.staff.restaurantId,
            restaurantName: nameById.get(String(r.staff.restaurantId)) || '',
            staffName: r.staff.firstName || r.staff.username || '',
            status: r.ok ? 'sent' : 'failed',
            messageId: r.messageId || null,
            error: r.error || '',
          },
        },
        { upsert: true },
      ).catch(() => {});
    }

    if (i + BATCH < staff.length) {
      await new Promise((r) => setTimeout(r, PAUSE_MS));
    }
  }

  broadcast.status = failed && !sent ? 'failed' : 'sent';
  broadcast.stats.sent = sent;
  broadcast.stats.failed = failed;
  broadcast.sentAt = new Date();
  await broadcast.save();

  return broadcast.stats;
}

/**
 * Tugma bosildi (callback_data: `b:<broadcastId>:<key>`).
 *
 * Restoran botining callback yo'naltirgichidan chaqiriladi.
 * Boshqa tugmalar (buyurtma, bron, menyu) bu funksiyaga
 * tushmaydi — prefiks ular bilan kesishmaydi.
 *
 * @returns {Promise<boolean>} shu modul ishlov berdimi
 */
export async function handleBroadcastCallback(cq) {
  const [, broadcastId, key] = String(cq.data || '').split(':');
  if (!/^[a-f\d]{24}$/i.test(broadcastId || '')) {
    await answerCallback(cq.id);
    return true;
  }

  const broadcast = await BotBroadcast.findById(broadcastId).select('buttons').lean();
  const button = broadcast?.buttons?.find((b) => b.key === key);

  /*
   * Bir xodim bir necha marta bossa ham BIR MARTA sanaladi:
   * filtrda `clickedAt: null` turibdi.
   */
  const updated = await BotBroadcastDelivery.findOneAndUpdate(
    { broadcastId, telegramUserId: String(cq.from?.id), clickedAt: null },
    { $set: { clickedAt: new Date(), clickedKey: key } },
    { new: true },
  );

  if (updated) {
    await BotBroadcast.updateOne({ _id: broadcastId }, { $inc: { 'stats.clicked': 1 } });
  }

  await answerCallback(
    cq.id,
    updated ? `✅ ${button?.text || 'Qabul qilindi'}` : 'Allaqachon belgilangan',
  );
  return true;
}

/**
 * Statistika — kim oldi, kim bosdi, kim ololmadi.
 * Faqat O'QIYDI.
 */
export async function getBroadcastStats(broadcastId) {
  const broadcast = await BotBroadcast.findById(broadcastId).lean();
  if (!broadcast) return null;

  const deliveries = await BotBroadcastDelivery.find({ broadcastId })
    .select('restaurantName staffName status error clickedAt clickedKey')
    .sort({ clickedAt: -1, createdAt: 1 })
    .lean();

  // Tugmalar bo'yicha taqsimot
  const byButton = {};
  for (const b of broadcast.buttons || []) byButton[b.key] = { text: b.text, count: 0 };
  for (const d of deliveries) {
    if (d.clickedKey && byButton[d.clickedKey]) byButton[d.clickedKey].count++;
  }

  return {
    broadcast,
    byButton: Object.entries(byButton).map(([key, v]) => ({ key, ...v })),
    deliveries,
    summary: {
      total: deliveries.length,
      sent: deliveries.filter((d) => d.status === 'sent').length,
      failed: deliveries.filter((d) => d.status === 'failed').length,
      clicked: deliveries.filter((d) => d.clickedAt).length,
    },
  };
}

/**
 * Botga ulangan restoranlar ro'yxati — kimga yuborish mumkin.
 */
export async function listBotRestaurants() {
  const staff = await RestaurantTelegramStaff.find({
    isActive: true, telegramUserId: { $ne: null },
  }).select('restaurantId firstName username connectedAt lastActionAt').lean();

  const ids = [...new Set(staff.map((s) => String(s.restaurantId)))];
  const restaurants = await Restaurant.find({ _id: { $in: ids } })
    .select('name imageUrl isActive isBlocked').lean();

  return restaurants.map((r) => {
    const mine = staff.filter((s) => String(s.restaurantId) === String(r._id));
    return {
      _id: r._id,
      name: r.name,
      imageUrl: r.imageUrl || '',
      isActive: r.isActive !== false && r.isBlocked !== true,
      staffCount: mine.length,
      staff: mine.map((s) => ({
        name: s.firstName || s.username || '',
        connectedAt: s.connectedAt,
        lastActionAt: s.lastActionAt,
      })),
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
}
