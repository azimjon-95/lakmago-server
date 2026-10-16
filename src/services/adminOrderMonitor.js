/**
 * Admin Telegram guruhida buyurtmalarni kuzatish.
 *
 * - Buyurtma restoranga chiqarilganda (pending) bitta post yuboriladi.
 * - Status o'zgarganda o'sha post edit qilinadi.
 * - «Yakunlandi» / «Bekor qilish» — parol + ikkinchi tasdiq majburiy.
 * - Telegram xatolari asosiy order oqimini buzmaydi.
 */
import crypto from 'node:crypto';
import { config } from '../config/index.js';
import { Order } from '../models/Order.js';
import { AdminOrderPost } from '../models/AdminOrderPost.js';
import { orderLabel } from './orderNumber.js';
import { changeOrderStatus, OrderFlowError } from './orderFlow.js';

// Boshqa servislar kabi sozlanadigan baza manzil (config.telegramApiBase; standart https://api.telegram.org) — testlanadi
const TG_API = () => `${config.telegramApiBase}/bot${config.telegramBotToken}`;
const PREFIX = 'aom_';
const TERMINAL = new Set(['delivered', 'cancelled']);
const ACTIVE = ['pending', 'accepted', 'preparing', 'ready', 'delivering'];

const STATUS_LABEL = {
  pending: '⏳ Qabul qilinishini kutmoqda',
  accepted: '✅ Qabul qilindi',
  preparing: '👨‍🍳 Tayyorlanmoqda',
  ready: '🍽 Tayyor',
  delivering: '🚴 Yetkazilmoqda',
  delivered: '✅ Yetkazildi / yakunlandi',
  cancelled: '❌ Bekor qilindi',
  awaiting_payment: '💳 To‘lov kutilmoqda',
};

/** @type {Map<string, object>} */
const sessions = new Map();
/** @type {Map<string, { chatId: string, messageId: number, expiresAt: number }[]>} */
const tempMessages = new Map();

function sessionKey(token) {
  return String(token || '');
}

function nowMs() {
  return Date.now();
}

function randomToken() {
  return crypto.randomBytes(12).toString('hex');
}

function contentHash(text, markupJson) {
  return crypto
    .createHash('sha256')
    .update(String(text) + '|' + String(markupJson || ''))
    .digest('hex')
    .slice(0, 16);
}

function esc(s = '') {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function som(n) {
  return Math.round(Number(n) || 0).toLocaleString('ru-RU').replace(/,/g, ' ');
}

function fmtTime(d) {
  if (!d) return '—';
  return new Date(d).toLocaleString('ru-RU', {
    timeZone: 'Asia/Tashkent',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function minutesSince(d) {
  if (!d) return null;
  const ms = Date.now() - new Date(d).getTime();
  if (!Number.isFinite(ms) || ms < 0) return 0;
  return Math.floor(ms / 60_000);
}

function durationText(order) {
  const st = order.status;
  if (TERMINAL.has(st)) {
    const end = order.deliveredAt || order.cancelledAt || order.updatedAt;
    const start = order.acceptedAt || order.createdAt;
    if (end && start) {
      const total = Math.floor((new Date(end) - new Date(start)) / 60_000);
      return `Jami: ${total} daqiqa`;
    }
    const m = minutesSince(start);
    return m != null ? `${m} daqiqa` : '';
  }
  if (st === 'pending') {
    const m = minutesSince(order.createdAt);
    return m != null ? `${m} daqiqadan beri qabul qilinmayapti` : '';
  }
  if (st === 'delivering') {
    const m = minutesSince(order.deliveringAt || order.readyAt);
    return m != null ? `Yo‘lda: ${m} daqiqa` : '';
  }
  const m = minutesSince(order.acceptedAt || order.createdAt);
  return m != null ? `Shu holatda: ${m} daqiqa` : '';
}

/*
 * Guruh ID: sozlamadagi, lekin Telegram "guruh supergruppaga aylandi (migrate_to_chat_id)" desa —
 * YANGI ID (xotirada; server qayta ishga tushsa birinchi xatoda o'zi qayta tuzaladi).
 */
let chatOverride = null;
export const alertsChatId = () => String(chatOverride || config.adminAlertsChatId || '');
/** Faqat testlar uchun: migratsiya natijasini tozalaydi */
export const _resetChatOverride = () => { chatOverride = null; };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SAFE_URL = /^(https?:\/\/|tg:\/\/)/i;
/** Telegram inline tugmada faqat http(s):// va tg:// ni qabul qiladi (tel: rad etilishi mumkin) */
const stripUnsafeButtons = (markup) => ({
  inline_keyboard: (markup?.inline_keyboard || [])
    .map((row) => row.filter((b) => !b.url || SAFE_URL.test(b.url)))
    .filter((row) => row.length),
});
const hasUnsafeButtons = (markup) => (markup?.inline_keyboard || []).flat().some((b) => b.url && !SAFE_URL.test(b.url));
// Bir marta rad etilgan bo'lsa — keyingi postlarga tel: tugmalari qo'shilmaydi (har safar qayta urinmaslik uchun)
let telButtonsBroken = false;

/**
 * tg() + vaqtinchalik xatolarda BUYURTMA YO'QOLMASLIGI uchun qayta urinish:
 *   • 429 — retry_after (≤3 s) kutib;
 *   • migrate_to_chat_id — yangi guruh ID'siga o'tib;
 *   • tugma URL'i rad etilsa (tel: va h.k.) — xavfli tugmalarsiz (amal tugmalari qoladi);
 *   • HTML parse xatosida — oddiy matn bilan.
 */
async function tgRetry(method, body, attempt = 0) {
  const res = await tg(method, body);
  if (!res || res.ok || attempt >= 3) return res;
  const desc = String(res.description || '');
  if (res.parameters?.migrate_to_chat_id && body.chat_id) {
    chatOverride = String(res.parameters.migrate_to_chat_id);
    console.error(`[adminOrderMonitor] guruh supergruppaga aylangan! Yangi ID: ${chatOverride} — .env dagi ADMIN_ALERTS_CHAT_ID ni yangilang`);
    return tgRetry(method, { ...body, chat_id: chatOverride }, attempt + 1);
  }
  if (res.error_code === 429) {
    await sleep(Math.min(Number(res.parameters?.retry_after) || 1, 3) * 1000);
    return tgRetry(method, body, attempt + 1);
  }
  if (res.error_code === 400 && body.reply_markup && hasUnsafeButtons(body.reply_markup)
      && /url|button|port|host/i.test(desc)) {
    telButtonsBroken = true;
    console.warn('[adminOrderMonitor] Telegram tel: tugmasini rad etdi — qo‘ng‘iroq tugmalarisiz yuboriladi (telefon matnda)');
    return tgRetry(method, { ...body, reply_markup: stripUnsafeButtons(body.reply_markup) }, attempt + 1);
  }
  if (res.error_code === 400 && body.parse_mode && /can't parse entities|can not parse entities/i.test(desc)) {
    const { parse_mode: _p, ...rest } = body;
    const plain = String(body.text || '').replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    return tgRetry(method, { ...rest, text: plain }, attempt + 1);
  }
  return res;
}

async function tg(method, body) {
  if (!config.telegramBotToken) return null;
  try {
    const r = await fetch(`${TG_API()}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({}));
    if (!data.ok) {
      console.error(`[adminOrderMonitor] TG ${method}:`, data.description || data.error_code);
    }
    return data;
  } catch (e) {
    console.error(`[adminOrderMonitor] TG ${method} network:`, e.message);
    return null;
  }
}

function trackTemp(sessionToken, chatId, messageId, ttlSec = 300) {
  if (!sessionToken || !chatId || !messageId) return;
  const list = tempMessages.get(sessionToken) || [];
  list.push({
    chatId: String(chatId),
    messageId: Number(messageId),
    expiresAt: nowMs() + ttlSec * 1000,
  });
  tempMessages.set(sessionToken, list);
}

async function deleteTracked(sessionToken) {
  const list = tempMessages.get(sessionToken) || [];
  tempMessages.delete(sessionToken);
  for (const m of list) {
    const res = await tg('deleteMessage', { chat_id: m.chatId, message_id: m.messageId });
    if (res && !res.ok) {
      console.warn(
        `[adminOrderMonitor] deleteMessage failed chat=${m.chatId} mid=${m.messageId}: ${res.description || ''}`,
      );
    }
  }
}

async function safeDelete(chatId, messageId) {
  if (!chatId || !messageId) return;
  const res = await tg('deleteMessage', { chat_id: chatId, message_id: messageId });
  if (res && !res.ok) {
    console.warn(`[adminOrderMonitor] deleteMessage failed: ${res.description || ''}`);
  }
}

function isAdminUser(telegramUserId) {
  const allow = config.adminOrderActionUserIds;
  if (!allow || allow.length === 0) return true;
  return allow.includes(String(telegramUserId));
}

function passwordConfigured() {
  return Boolean(config.adminOrderActionPassword && config.adminOrderActionPassword.length > 0);
}

function timingSafePasswordEqual(provided) {
  const expected = config.adminOrderActionPassword || '';
  const a = Buffer.from(String(provided || ''), 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) {
    const dummy = Buffer.alloc(a.length || 1);
    crypto.timingSafeEqual(a.length ? a : dummy, dummy);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

/** Telegram tel: URL — + ni encode qilmaslik (aks holda Wrong port number). */
function normalizeTelHref(raw) {
  const cleaned = String(raw || '').replace(/[^\d+]/g, '');
  if (!cleaned) return null;
  const digits = cleaned.replace(/\D/g, '');
  if (digits.length < 9) return null;
  const normalized = cleaned.startsWith('+') ? `+${digits}` : `+${digits}`;
  return `tel:${normalized}`;
}

function buildKeyboard(order, { showActions = true } = {}) {
  const rows = [];
  const phone = order.phone || order.userId?.phone || '';
  const restPhone = order.restaurantId?.phone || order.restaurantPhone || '';

  const contactRow = [];
  const telUser = telButtonsBroken ? null : normalizeTelHref(phone);
  if (telUser) {
    contactRow.push({ text: '📞 Mijozga qo‘ng‘iroq', url: telUser });
  }
  const telRest = telButtonsBroken ? null : normalizeTelHref(restPhone);
  if (telRest) {
    contactRow.push({ text: '📞 Restoranga qo‘ng‘iroq', url: telRest });
  }
  if (contactRow.length) rows.push(contactRow);

  const username = order.userId?.username;
  if (username) {
    rows.push([{ text: '👤 Mijoz Telegram', url: `https://t.me/${encodeURIComponent(username)}` }]);
  }

  if (showActions && !TERMINAL.has(order.status)) {
    const oid = String(order._id);
    rows.push([
      { text: '✅ Buyurtma yakunlandi', callback_data: `${PREFIX}done:${oid}` },
      { text: '❌ Bekor qilish', callback_data: `${PREFIX}cancel:${oid}` },
    ]);
  }
  return { inline_keyboard: rows };
}

function buildText(order) {
  const label = orderLabel(order);
  const st = order.status;
  const lines = [];
  lines.push(`📦 <b>${esc(label)}</b> · ${esc(order.restaurantName || '')}`);
  lines.push(`Holat: <b>${STATUS_LABEL[st] || st}</b>`);
  const dur = durationText(order);
  if (dur) lines.push(`⏱ ${esc(dur)}`);
  lines.push('');

  const u = order.userId && typeof order.userId === 'object' ? order.userId : null;
  const name = [u?.firstName, u?.lastName].filter(Boolean).join(' ') || order.customerName || '—';
  const phone = order.phone || u?.phone || '—';
  lines.push(`👤 ${esc(name)}`);
  lines.push(`📱 ${esc(phone)}`);
  if (u?.username) lines.push(`Telegram: @${esc(u.username)}`);
  const restPhoneText = order.restaurantId?.phone || order.restaurantPhone || '';
  if (restPhoneText) lines.push(`☎️ Restoran: ${esc(restPhoneText)}`);

  lines.push('');
  for (const it of order.items || []) {
    const qty = it.quantity || 1;
    const price = it.unitPrice != null ? som(it.unitPrice * qty) : '';
    lines.push(`• ${esc(it.name)} ×${qty}${price ? ` — ${price} so‘m` : ''}`);
  }
  lines.push('');
  lines.push(`Taomlar: ${som(order.subtotal)} so‘m`);
  if (order.deliveryFee != null && order.deliveryFee > 0) {
    lines.push(`Yetkazish: ${som(order.deliveryFee)} so‘m`);
  }
  const total = order.total ?? order.finance?.totalChargedSom ?? order.subtotal;
  lines.push(`<b>Jami: ${som(total)} so‘m</b>`);
  lines.push(
    `To‘lov: ${esc(order.paymentMethod || '—')}${order.isPaid ? ' ✅ to‘langan' : ' (naqd/kutilmoqda)'}`,
  );

  if (order.address || order.deliveryAddress) {
    lines.push(`📍 ${esc(order.address || order.deliveryAddress)}`);
  }
  lines.push(`Kelgan: ${fmtTime(order.createdAt)}`);
  if (order.acceptedAt) lines.push(`Qabul: ${fmtTime(order.acceptedAt)}`);
  if (order.deliveringAt) lines.push(`Yo‘lda: ${fmtTime(order.deliveringAt)}`);
  if (order.deliveredAt) lines.push(`Yakun: ${fmtTime(order.deliveredAt)}`);
  if (order.cancelledAt) lines.push(`Bekor: ${fmtTime(order.cancelledAt)}`);

  return lines.join('\n');
}

export async function onOrderReleasedToKitchen(orderId) {
  try {
    if (!alertsChatId() || !config.telegramBotToken) return;

    const order = await Order.findById(orderId)
      .populate('userId', 'firstName lastName username phone telegramId')
      .populate('restaurantId', 'name phone')
      .lean();
    if (!order) return;
    if (order.status === 'awaiting_payment') return;
    if (!ACTIVE.includes(order.status) && !TERMINAL.has(order.status)) return;

    const existing = await AdminOrderPost.findOne({ orderId: order._id }).lean();
    if (existing && !existing.orphaned) {
      await refreshAdminOrderPost(order._id);
      return;
    }

    const text = buildText(order);
    const reply_markup = buildKeyboard(order);
    const markupJson = JSON.stringify(reply_markup);
    const res = await tgRetry('sendMessage', {
      chat_id: alertsChatId(),
      text,
      parse_mode: 'HTML',
      reply_markup,
      disable_web_page_preview: true,
    });
    if (!res?.ok || !res.result?.message_id) {
      console.error('[adminOrderMonitor] sendMessage failed for order', String(orderId));
      return;
    }

    await AdminOrderPost.findOneAndUpdate(
      { orderId: order._id },
      {
        $set: {
          chatId: alertsChatId(),   // migratsiya bo'lgan bo'lsa — yangi ID
          messageId: res.result.message_id,
          lastStatus: order.status,
          lastEditedAt: new Date(),
          lastContentHash: contentHash(text, markupJson),
          orphaned: false,
        },
      },
      { upsert: true, new: true },
    );
  } catch (e) {
    console.error('[adminOrderMonitor] onOrderReleasedToKitchen:', e.message);
  }
}

export async function refreshAdminOrderPost(orderId) {
  try {
    if (!alertsChatId() || !config.telegramBotToken) return;

    const post = await AdminOrderPost.findOne({ orderId }).lean();
    if (!post || post.orphaned) return;

    const order = await Order.findById(orderId)
      .populate('userId', 'firstName lastName username phone telegramId')
      .populate('restaurantId', 'name phone')
      .lean();
    if (!order) return;

    const text = buildText(order);
    const reply_markup = buildKeyboard(order, { showActions: !TERMINAL.has(order.status) });
    const markupJson = JSON.stringify(reply_markup);
    const hash = contentHash(text, markupJson);
    if (hash === post.lastContentHash && post.lastStatus === order.status) return;

    const res = await tgRetry('editMessageText', {
      chat_id: post.chatId,
      message_id: post.messageId,
      text,
      parse_mode: 'HTML',
      reply_markup,
      disable_web_page_preview: true,
    });

    // "o'zgarmadi" — xato EMAS: post joyida, faqat hash yangilanadi (avval bu postni yetim qilib,
    // keyingi barcha yangilanishlarni jim to'xtatardi)
    const notModified = res?.error_code === 400 && /message is not modified/i.test(res.description || '');
    if (res?.ok || notModified) {
      await AdminOrderPost.updateOne(
        { _id: post._id },
        {
          $set: {
            lastStatus: order.status,
            lastEditedAt: new Date(),
            lastContentHash: hash,
          },
        },
      );
    } else if (
      res?.error_code === 400
      && /message to edit not found|message can't be edited|MESSAGE_ID_INVALID|chat not found/i.test(res.description || '')
    ) {
      // Post guruhdan o'chirilgan (ehtimol admin ataylab tozalagan) — endi tegilmaydi
      await AdminOrderPost.updateOne({ _id: post._id }, { $set: { orphaned: true } });
    }
  } catch (e) {
    console.error('[adminOrderMonitor] refreshAdminOrderPost:', e.message);
  }
}

export async function handleAdminOrderCallback(cq) {
  const data = cq?.data || '';
  if (!data.startsWith(PREFIX)) return false;

  const chatId = cq.message?.chat?.id;
  const fromId = cq.from?.id;
  const messageId = cq.message?.message_id;

  await tg('answerCallbackQuery', { callback_query_id: cq.id });

  if (!passwordConfigured()) {
    await tg('answerCallbackQuery', {
      callback_query_id: cq.id,
      text: 'Admin amal paroli sozlanmagan (ADMIN_ORDER_ACTION_PASSWORD)',
      show_alert: true,
    });
    console.error('[adminOrderMonitor] ADMIN_ORDER_ACTION_PASSWORD yo‘q — fail-closed');
    return true;
  }

  if (!isAdminUser(fromId)) {
    await tg('answerCallbackQuery', {
      callback_query_id: cq.id,
      text: 'Sizga ruxsat yo‘q',
      show_alert: true,
    });
    return true;
  }

  const rest = data.slice(PREFIX.length);
  if (rest.startsWith('done:') || rest.startsWith('cancel:')) {
    const action = rest.startsWith('done:') ? 'done' : 'cancel';
    const orderId = rest.split(':')[1];
    return startPasswordFlow({ action, orderId, fromId, chatId, messageId, cq });
  }
  if (rest.startsWith('confirm:')) {
    const token = rest.slice('confirm:'.length);
    return finalizeAction(token, fromId, cq);
  }
  if (rest.startsWith('abort:')) {
    const token = rest.slice('abort:'.length);
    const sess = sessions.get(sessionKey(token));
    if (sess) {
      sessions.delete(sessionKey(token));
      await deleteTracked(token);
    }
    return true;
  }
  return true;
}

async function startPasswordFlow({ action, orderId, fromId, chatId, messageId, cq }) {
  const order = await Order.findById(orderId).select('status restaurantId dailyNumber').lean();
  if (!order || TERMINAL.has(order.status)) {
    await tg('answerCallbackQuery', {
      callback_query_id: cq.id,
      text: 'Buyurtma allaqachon yakunlangan yoki bekor qilingan',
      show_alert: true,
    });
    await refreshAdminOrderPost(orderId);
    return true;
  }

  const token = randomToken();
  const ttl = (config.adminOrderActionSessionTtlSeconds || 120) * 1000;
  sessions.set(sessionKey(token), {
    token,
    action,
    orderId: String(orderId),
    restaurantId: String(order.restaurantId),
    userId: String(fromId),
    chatId: String(chatId),
    attempts: 0,
    stage: 'password',
    expiresAt: nowMs() + ttl,
    createdAt: nowMs(),
  });

  const privatePrompt = await tg('sendMessage', {
    chat_id: fromId,
    text:
      `🔒 <b>Parol kiriting</b>\n` +
      `Buyurtma: ${esc(orderLabel(order))}\n` +
      `Amal: ${action === 'done' ? 'Yakunlash' : 'Bekor qilish'}\n\n` +
      `Parolni shu yerga yozing. Xabar avtomatik o‘chiriladi.\n` +
      `Sessiya: ${Math.round(ttl / 1000)} soniya.`,
    parse_mode: 'HTML',
  });

  if (privatePrompt?.ok && privatePrompt.result?.message_id) {
    trackTemp(token, fromId, privatePrompt.result.message_id, ttl / 1000 + 30);
    sessions.get(sessionKey(token)).promptChatId = String(fromId);
    sessions.get(sessionKey(token)).preferPrivate = true;
    await tg('answerCallbackQuery', {
      callback_query_id: cq.id,
      text: 'Parol so‘rovi shaxsiy chatga yuborildi',
      show_alert: false,
    });
  } else {
    const groupPrompt = await tg('sendMessage', {
      chat_id: chatId,
      text:
        `🔒 Admin ${cq.from?.first_name || fromId}: parolni <b>shaxsiy chatda</b> botga yuboring ` +
        `(guruhda yozish xavfsiz emas).\n` +
        `Amal: ${action === 'done' ? 'yakunlash' : 'bekor qilish'} · ${esc(orderLabel(order))}\n` +
        `Token: <code>${token.slice(0, 8)}</code>`,
      parse_mode: 'HTML',
    });
    if (groupPrompt?.ok) trackTemp(token, chatId, groupPrompt.result.message_id, 60);
    console.warn('[adminOrderMonitor] private prompt failed — admin must open bot DM');
  }
  return true;
}

export async function handleAdminPasswordMessage(message) {
  if (!message?.text || message.text.startsWith('/')) return false;
  const fromId = String(message.from?.id || message.chat?.id);
  const chatId = String(message.chat?.id);

  let found = null;
  for (const [, sess] of sessions) {
    if (sess.userId === fromId && sess.stage === 'password' && sess.expiresAt > nowMs()) {
      found = sess;
      break;
    }
  }
  if (!found) return false;

  await safeDelete(chatId, message.message_id);

  if (found.attempts >= 5) {
    sessions.delete(sessionKey(found.token));
    await deleteTracked(found.token);
    await tg('sendMessage', { chat_id: chatId, text: 'Urinishlar limiti. Qayta tugmani bosing.' });
    return true;
  }

  found.attempts += 1;
  if (!timingSafePasswordEqual(message.text.trim())) {
    const warn = await tg('sendMessage', {
      chat_id: chatId,
      text: `❌ Noto‘g‘ri parol (${found.attempts}/5)`,
    });
    if (warn?.ok) trackTemp(found.token, chatId, warn.result.message_id, 30);
    console.info(`[adminOrderMonitor] bad password attempt user=${fromId} order=${found.orderId}`);
    return true;
  }

  found.stage = 'confirm';
  found.expiresAt = nowMs() + (config.adminOrderActionSessionTtlSeconds || 120) * 1000;

  const order = await Order.findById(found.orderId).select('status dailyNumber restaurantName').lean();
  const label = order ? orderLabel(order) : found.orderId;
  const actionLabel = found.action === 'done' ? 'yakunlash' : 'bekor qilish';

  const conf = await tg('sendMessage', {
    chat_id: chatId,
    text: `⚠️ Haqiqatan ham <b>${esc(label)}</b> buyurtmasini <b>${actionLabel}</b> qilasizmi?`,
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [
          { text: '✅ Ha, tasdiqlayman', callback_data: `${PREFIX}confirm:${found.token}` },
          { text: '↩️ Bekor', callback_data: `${PREFIX}abort:${found.token}` },
        ],
      ],
    },
  });
  if (conf?.ok) trackTemp(found.token, chatId, conf.result.message_id, 180);
  return true;
}

async function finalizeAction(token, fromId, cq) {
  const sess = sessions.get(sessionKey(token));
  if (!sess || sess.expiresAt < nowMs() || sess.stage !== 'confirm') {
    sessions.delete(sessionKey(token));
    await deleteTracked(token);
    await tg('answerCallbackQuery', {
      callback_query_id: cq.id,
      text: 'Sessiya muddati tugagan. Qayta urinib ko‘ring.',
      show_alert: true,
    });
    return true;
  }
  if (String(fromId) !== sess.userId) {
    await tg('answerCallbackQuery', {
      callback_query_id: cq.id,
      text: 'Bu sessiya boshqa adminniki',
      show_alert: true,
    });
    return true;
  }

  sessions.delete(sessionKey(token));
  await deleteTracked(token);

  const order = await Order.findById(sess.orderId).select('status restaurantId fulfillment').lean();
  if (!order) {
    await tg('answerCallbackQuery', {
      callback_query_id: cq.id,
      text: 'Buyurtma topilmadi',
      show_alert: true,
    });
    return true;
  }

  try {
    if (sess.action === 'done') {
      await changeOrderStatus({
        orderId: sess.orderId,
        restaurantId: sess.restaurantId || order.restaurantId,
        status: 'delivered',
        actorName: `Admin TG:${fromId}`,
        approvedByAdmin: true,
      });
    } else if (sess.action === 'cancel') {
      const needAdminApproval = order.status !== 'pending';
      await changeOrderStatus({
        orderId: sess.orderId,
        restaurantId: sess.restaurantId || order.restaurantId,
        status: 'cancelled',
        actorName: `Admin TG:${fromId}`,
        cancelReason: 'Admin guruhidan bekor qilindi',
        approvedByAdmin: needAdminApproval,
      });
    }
    console.info(
      `[adminOrderMonitor] audit order=${sess.orderId} action=${sess.action} by=${fromId} result=ok`,
    );
    await refreshAdminOrderPost(sess.orderId);
    await tg('answerCallbackQuery', {
      callback_query_id: cq.id,
      text: 'Bajarildi',
      show_alert: false,
    });
  } catch (e) {
    const msg = e instanceof OrderFlowError ? e.message : e.message || 'Xato';
    console.info(
      `[adminOrderMonitor] audit order=${sess.orderId} action=${sess.action} by=${fromId} result=fail ${e.code || ''}`,
    );
    await tg('answerCallbackQuery', {
      callback_query_id: cq.id,
      text: msg.slice(0, 180),
      show_alert: true,
    });
    await refreshAdminOrderPost(sess.orderId);
  }
  return true;
}

/*
 * YETKAZILMAGAN BUYURTMALAR: buyurtma posti faqat buyurtma chiqarilganda BIR MARTA yuborilardi.
 * Telegram o'sha payt ishlamasa (tarmoq, 429, guruh sozlamasi xato edi, keyin tuzaldi) —
 * buyurtma guruhga HECH QACHON tushmasdi. Endi har tekshiruvda oxirgi 3 soatdagi faol,
 * posti yo'q buyurtmalar yuboriladi (AdminOrderPost.orderId unikal — dublikat bo'lmaydi;
 * guruhdan o'chirilgan "yetim" postlar qayta yuborilmaydi).
 */
const CATCHUP_HOURS = 3;
async function catchUpMissingPosts() {
  const since = new Date(Date.now() - CATCHUP_HOURS * 3600_000);
  const recent = await Order.find({
    createdAt: { $gte: since },
    status: { $in: ACTIVE },
    fulfillment: { $in: ['delivery', 'pickup'] },
  }).select('_id').sort({ createdAt: 1 }).limit(30).lean();
  if (!recent.length) return;
  const have = new Set((await AdminOrderPost.find({ orderId: { $in: recent.map((o) => o._id) } }).select('orderId').lean())
    .map((p) => String(p.orderId)));
  let sent = 0;
  for (const o of recent) {
    if (have.has(String(o._id))) continue;
    await onOrderReleasedToKitchen(o._id);
    if (++sent >= 10) break;           // bir tekshiruvda ko'pi bilan 10 ta (Telegram limiti)
    await sleep(150);
  }
}

export async function tickAdminOrderMonitor() {
  try {
    for (const [k, sess] of sessions) {
      if (sess.expiresAt < nowMs()) {
        sessions.delete(k);
        await deleteTracked(sess.token);
      }
    }
    for (const [token, list] of tempMessages) {
      const keep = [];
      for (const m of list) {
        if (m.expiresAt < nowMs()) {
          await safeDelete(m.chatId, m.messageId);
        } else {
          keep.push(m);
        }
      }
      if (keep.length) tempMessages.set(token, keep);
      else tempMessages.delete(token);
    }

    if (!alertsChatId() || !config.telegramBotToken) return;

    await catchUpMissingPosts();

    const posts = await AdminOrderPost.find({
      orphaned: { $ne: true },
      lastStatus: { $in: ACTIVE },
    })
      .limit(40)
      .lean();

    for (const p of posts) {
      await refreshAdminOrderPost(p.orderId);
      await new Promise((r) => setTimeout(r, 80));
    }
  } catch (e) {
    console.error('[adminOrderMonitor] tick:', e.message);
  }
}

export function startAdminOrderMonitorScheduler() {
  const delay = 55_000;
  setTimeout(() => {
    tickAdminOrderMonitor().catch(() => {});
    setInterval(() => tickAdminOrderMonitor().catch(() => {}), 60_000);
  }, delay);
}
/* ═══ DIAGNOSTIKA: buyurtmalar admin guruhiga yetib boradimi? ═══ */
export async function adminOrderGroupStatus() {
  const out = { ok: false, tokenSet: Boolean(config.telegramBotToken), chatId: alertsChatId(), problems: [], hints: [] };
  const bad = (problem, hint) => { out.problems.push(problem); if (hint) out.hints.push(hint); };
  if (!out.tokenSet) bad('TELEGRAM_BOT_TOKEN sozlanmagan', '.env ga bot tokenini yozing');
  if (!out.chatId) bad('ADMIN_ALERTS_CHAT_ID (yoki SUPPORT_GROUP_CHAT_ID) sozlanmagan — yangi buyurtmalar admin guruhiga yuborilmaydi', 'Guruh ID sini (-100… bilan boshlanadi) .env ga yozing va serverni qayta ishga tushiring');
  if (out.problems.length) return out;
  if (!/^-?\d+$/.test(out.chatId)) bad(`Guruh ID noto'g'ri formatda: "${out.chatId}"`, 'Faqat raqam, masalan -1001234567890 (@nom emas)');

  const me = await tgRetry('getMe', {});
  if (!me?.ok) { bad(`Bot tokeni ishlamayapti: ${me?.description || 'javob yo‘q'}`, 'TELEGRAM_BOT_TOKEN ni @BotFather dan qayta oling'); return out; }
  out.bot = { id: me.result.id, username: me.result.username };

  const chat = await tgRetry('getChat', { chat_id: alertsChatId() });
  if (!chat?.ok) {
    if (/chat not found/i.test(chat?.description || '')) bad('Guruh topilmadi', 'ID noto‘g‘ri yoki bot guruhga qo‘shilmagan. Botni guruhga qo‘shing (ID odatda -100 bilan boshlanadi)');
    else bad(`Guruhni olib bo'lmadi: ${chat?.description || 'javob yo‘q'}`);
    return out;
  }
  out.chatId = alertsChatId();
  out.chat = { id: chat.result.id, title: chat.result.title || null, type: chat.result.type };
  if (chat.result.type === 'private') bad('Bu guruh emas, shaxsiy chat', 'Guruh ID sini ishlating (manfiy son)');

  const m = await tgRetry('getChatMember', { chat_id: alertsChatId(), user_id: me.result.id });
  if (m?.ok) {
    out.bot.status = m.result.status;
    if (['left', 'kicked'].includes(m.result.status)) bad(`Bot guruhda emas (${m.result.status})`, 'Botni guruhga qayta qo‘shing');
    else if (m.result.status === 'restricted' && m.result.can_send_messages === false) bad('Botga guruhda yozish taqiqlangan', 'Guruh sozlamalaridan botga xabar yozish huquqini bering');
  } else bad(`Bot huquqlarini tekshirib bo'lmadi: ${m?.description || 'javob yo‘q'}`);
  if (!config.adminOrderActionPassword) out.hints.push('ADMIN_ORDER_ACTION_PASSWORD sozlanmagan: guruhdagi "Yakunlandi/Bekor qilish" tugmalari ishlamaydi (buyurtmalar baribir ko‘rinadi)');
  out.ok = out.problems.length === 0;
  return out;
}

/** Sinov: guruhga xabar yuboradi */
export async function sendAdminOrderGroupTest(by = 'Admin') {
  const st = await adminOrderGroupStatus();
  if (!st.ok) return { ok: false, status: st };
  const r = await tgRetry('sendMessage', {
    chat_id: alertsChatId(),
    text: `✅ <b>Sinov xabari</b>\n\nYangi mijoz buyurtmalari shu guruhga tushadi.\n<i>${esc(by)} · ${fmtTime(new Date())}</i>`,
    parse_mode: 'HTML',
  });
  return r?.ok ? { ok: true, messageId: r.result.message_id, status: st } : { ok: false, error: r?.description || 'javob yo‘q', status: st };
}

/** Ishga tushganda: sozlama bo'sh bo'lsa — aniq ogohlantirish (avval jimgina o'tkazilardi) */
export function warnIfOrderGroupMissing() {
  if (config.telegramBotToken && !alertsChatId()) {
    console.warn('[adminOrderMonitor] ⚠️  ADMIN_ALERTS_CHAT_ID (va SUPPORT_GROUP_CHAT_ID) bo‘sh — yangi mijoz buyurtmalari Telegram admin guruhiga YUBORILMAYDI');
  }
}
