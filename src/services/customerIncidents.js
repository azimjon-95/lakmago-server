import { config } from '../config/index.js';
import { Order } from '../models/Order.js';
import { User } from '../models/User.js';
import { CustomerIncident } from '../models/CustomerIncident.js';
import { changeOrderStatus, OrderFlowError } from './orderFlow.js';
import { orderLabel } from './orderNumber.js';
import { notifyUser } from './telegram.js';
import { getIO } from '../sockets/io.js';
import { emitOrderToRestaurant } from './orderSocket.js';

/*
 * ═══ "MIJOZ RAD ETDI" — admin tasdig'i bilan bekor qilish ═══
 *
 * 1) Restoran qabul qilingan buyurtma uchun so'rov yuboradi (sabab tanlaydi):
 *    createCancelRequest() → CustomerIncident (mijoz ma'lumoti nusxasi bilan),
 *    Order.cancelRequest = pending, admin guruhiga xabar (admin panel havolasi).
 *    Buyurtma o'z holatida QOLADI — admin hal qilguncha.
 * 2) Admin (admin panel) hal qiladi — decideIncident():
 *      approve → buyurtma bekor qilinadi (orderFlow, approvedByAdmin);
 *                xohlasa: mijozning naqd to'lovi o'chiriladi va/yoki bloklanadi
 *                (sababi mijozga yuboriladi va ilovada ko'rsatiladi);
 *      reject  → buyurtma davom etadi, restoranga xabar.
 * Guruhdagi tugmalar ATAYLAB havola (admin panel): asosiy bot guruh
 * callback'larini qayta ishlamaydi va qaror faqat admin hisobi bilan qilinadi.
 */
export const REFUSAL_REASONS = {
  not_needed: 'Mijoz taom kerak emas dedi',
  changed_mind: 'Mijoz fikrini o‘zgartirdi (to‘qman / boshqa joydan oldi)',
  no_answer: 'Mijoz telefonga javob bermayapti',
  refused_at_door: 'Mijoz eshik oldida qabul qilmadi',
  wrong_address: 'Manzil noto‘g‘ri, mijoz topilmadi',
  other: 'Boshqa sabab',
};
export const REFUSABLE_STATUSES = ['accepted', 'preparing', 'ready', 'delivering'];

export class IncidentError extends Error {
  constructor(code, message, http = 400) { super(message); this.code = code; this.http = http; }
}

const esc = (s = '') => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmtDate = (d) => new Date(d).toLocaleDateString('ru-RU', { timeZone: 'Asia/Tashkent' });
const fmtTime = (d) => new Date(d).toLocaleString('ru-RU', { timeZone: 'Asia/Tashkent', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const som = (n) => Math.round(Number(n) || 0).toLocaleString('ru-RU').replace(/,/g, ' ');

async function tg(method, body) {
  if (!config.telegramBotToken) return null;
  try {
    const r = await fetch(`https://api.telegram.org/bot${config.telegramBotToken}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return await r.json();
  } catch (e) {
    console.error(`[incident] Telegram ${method}:`, e.message);
    return null;
  }
}

/** Telegram profil rasmi file_id (bot orqali) — rasm keyin ham admin panelda ochiladi */
async function telegramPhotoFileId(telegramId) {
  if (!telegramId) return '';
  const r = await tg('getUserProfilePhotos', { user_id: Number(telegramId), limit: 1 });
  const sizes = r?.ok ? r.result?.photos?.[0] : null;
  return sizes?.length ? sizes[sizes.length - 1].file_id : '';
}

function itemsOf(order) {
  return (order.items || []).map((i) => ({
    name: String(i.name || i.dishName || 'Taom').slice(0, 120),
    qty: Number(i.qty ?? i.quantity ?? 1) || 1,
    price: Number(i.price) || 0,
  }));
}

/** Mijozga ko'rsatiladigan standart sabab (admin o'zgartirishi mumkin) */
export function defaultCustomerMessage(incident) {
  const items = (incident.order?.items || []).slice(0, 4).map((i) => i.name).join(', ');
  return `Siz ${fmtDate(incident.createdAt || new Date())} kuni «${incident.restaurantName}» dan buyurtma qilib`
    + `${items ? ` (${items})` : ''}, restoran tasdiqlab tayyorlaganidan keyin undan voz kechgansiz.`;
}

/* ───────────── 1. Restoran so'rovi ───────────── */
export async function createCancelRequest({ orderId, restaurantId, reasonCode, note = '', requestedBy = '' }) {
  if (!REFUSAL_REASONS[reasonCode]) throw new IncidentError('BAD_REASON', 'Sababni tanlang');
  const cleanNote = String(note || '').trim().slice(0, 500);
  if (reasonCode === 'other' && cleanNote.length < 3) throw new IncidentError('NOTE_REQUIRED', 'Sababni qisqacha yozing');

  const order = await Order.findOne({ _id: orderId, restaurantId }).populate('userId', 'firstName lastName username telegramId phone photoUrl addresses createdAt').populate('restaurantId', 'name');
  if (!order) throw new IncidentError('NOT_FOUND', 'Buyurtma topilmadi', 404);
  if (!REFUSABLE_STATUSES.includes(order.status)) {
    throw new IncidentError('WRONG_STATE', order.status === 'pending'
      ? 'Hali qabul qilinmagan buyurtmani “Rad etish” bilan bekor qiling'
      : 'Bu buyurtma yakunlangan yoki bekor qilingan');
  }
  if (order.cancelRequest?.status === 'pending') throw new IncidentError('ALREADY_PENDING', 'So‘rov allaqachon yuborilgan — admin ko‘rib chiqmoqda', 409);

  const u = order.userId && typeof order.userId === 'object' ? order.userId : null;
  const [ordersCount, previousIncidents, photoFileId] = await Promise.all([
    u ? Order.countDocuments({ userId: u._id }) : 0,
    u ? CustomerIncident.countDocuments({ userId: u._id, status: 'approved' }) : 0,
    telegramPhotoFileId(u?.telegramId),
  ]);
  const restaurantName = order.restaurantId?.name || order.restaurantName || '';
  const reason = REFUSAL_REASONS[reasonCode];

  const postMode = !config.cancelApprovalRequired;
  const incident = await CustomerIncident.create({
    mode: postMode ? 'post' : 'approval',
    orderId: order._id,
    orderLabel: orderLabel(order),
    orderStatusAtRequest: order.status,
    restaurantId: order.restaurantId?._id || order.restaurantId,
    restaurantName,
    userId: u?._id,
    reasonCode, reason, note: cleanNote, requestedBy: String(requestedBy || '').slice(0, 80),
    order: {
      items: itemsOf(order), total: order.total || 0, paymentMethod: order.paymentMethod || '', isPaid: Boolean(order.isPaid),
      address: order.address || '', phone: order.phone || '', fulfillment: order.fulfillment || '',
      createdAt: order.createdAt, acceptedAt: order.acceptedAt,
    },
    snapshot: u ? {
      firstName: u.firstName, lastName: u.lastName, username: u.username, telegramId: u.telegramId ? String(u.telegramId) : '',
      phone: u.phone || order.phone || '', photoUrl: u.photoUrl || '', photoFileId,
      addresses: (u.addresses || []).map((a) => ({ title: a.title, address: a.address, city: a.city, lat: a.lat, lng: a.lng })),
      createdAt: u.createdAt, ordersCount, previousIncidents,
    } : { phone: order.phone || '' },
  });

  // Faqat pending bo'lmasa yoziladi (ikki xodim bir vaqtda bosgan holat)
  const claimed = await Order.findOneAndUpdate(
    { _id: order._id, 'cancelRequest.status': { $ne: 'pending' } },
    { $set: { cancelRequest: { status: 'pending', incidentId: incident._id, reason, requestedAt: new Date() } } },
    { new: true },
  );
  if (!claimed) {
    await CustomerIncident.deleteOne({ _id: incident._id });
    throw new IncidentError('ALREADY_PENDING', 'So‘rov allaqachon yuborilgan — admin ko‘rib chiqmoqda', 409);
  }

  /*
   * STANDART (TZ): restoran ish jarayoni saqlanadi — buyurtma DARHOL bekor qilinadi
   * (sabab va kod bilan), holat esa admin ko'rib chiqishi uchun qayd etiladi.
   */
  let finalOrder = claimed;
  if (postMode) {
    try {
      const r = await changeOrderStatus({
        orderId: order._id, restaurantId, status: 'cancelled',
        actorName: requestedBy || 'Restoran', cancelReason: `Mijoz voz kechdi: ${reason}`,
        cancelReasonCode: `refused_${reasonCode}`, approvedByAdmin: true,
      });
      finalOrder = r.order || claimed;
      await Order.updateOne({ _id: order._id }, { $set: { 'cancelRequest.status': 'approved', 'cancelRequest.decidedAt': new Date() } });
    } catch (e) {
      // Bekor qilinmadi (orada holat o'zgardi) — hammasi ortga qaytariladi
      await Order.updateOne({ _id: order._id }, { $unset: { cancelRequest: 1 } }).catch(() => {});
      await CustomerIncident.deleteOne({ _id: incident._id }).catch(() => {});
      if (e instanceof OrderFlowError) throw new IncidentError('ORDER_STATE', `Bekor qilib bo‘lmadi: ${e.message}`, 409);
      throw e;
    }
  }

  await postToGroup(incident).catch((e) => console.error('[incident] guruh:', e.message));
  getIO()?.to('admin').emit('incident:new', { _id: incident._id });
  await pushOrderUpdate(claimed._id);
  return { incident, order: finalOrder, mode: incident.mode };
}

function groupText(inc) {
  const s = inc.snapshot || {};
  const name = [s.firstName, s.lastName].filter(Boolean).join(' ') || 'Mijoz';
  const items = (inc.order?.items || []).map((i) => `  • ${esc(i.name)} × ${i.qty}`).join('\n');
  const post = inc.mode === 'post';
  const decided = inc.status === 'pending'
    ? (post ? '⏳ <b>Buyurtma bekor qilindi — admin ko‘rib chiqishi kutilmoqda</b>' : '⏳ <b>Admin qarori kutilmoqda</b>')
    : post
      ? (inc.status === 'approved'
        ? `🧾 <b>Ko‘rib chiqildi: mijoz voz kechgan</b>${inc.decision?.cashDisabled ? ' · 💵 naqd o‘chirildi' : ''}${inc.decision?.blocked ? ' · ⛔ bloklandi' : ''}${inc.decision?.by ? ` · ${esc(inc.decision.by)}` : ''}`
        : `ℹ️ <b>Ko‘rib chiqildi: asossiz</b> — mijozga chora ko‘rilmadi${inc.decision?.by ? ` · ${esc(inc.decision.by)}` : ''}`)
      : inc.status === 'approved'
      ? `✅ <b>Bekor qilish tasdiqlandi</b>${inc.decision?.cashDisabled ? ' · 💵 naqd o‘chirildi' : ''}${inc.decision?.blocked ? ' · ⛔ bloklandi' : ''}${inc.decision?.by ? ` · ${esc(inc.decision.by)}` : ''}`
      : `❌ <b>Rad etildi</b> — buyurtma davom etadi${inc.decision?.by ? ` · ${esc(inc.decision.by)}` : ''}`;
  return [
    '🚫 <b>Mijoz buyurtmadan voz kechdi</b>',
    '',
    `🏪 <b>${esc(inc.restaurantName)}</b> · ${esc(inc.orderLabel)}`,
    `👤 ${esc(name)}${s.username ? ` (@${esc(s.username)})` : ''}`,
    `📞 ${esc(s.phone || inc.order?.phone || '—')}`,
    `💰 ${som(inc.order?.total)} so'm · ${inc.order?.paymentMethod === 'cash' ? 'Naqd' : esc(inc.order?.paymentMethod || '')}${inc.order?.isPaid ? ' (to‘langan)' : ''}`,
    items ? `🍽 Taomlar:\n${items}` : '',
    '',
    `📝 Sabab: <b>${esc(inc.reason)}</b>${inc.note ? `\n💬 ${esc(inc.note)}` : ''}`,
    s.previousIncidents ? `⚠️ Avval ham ${s.previousIncidents} marta shunday bo‘lgan` : '',
    `🕒 ${fmtTime(inc.createdAt)}${inc.requestedBy ? ` · ${esc(inc.requestedBy)}` : ''}`,
    '',
    decided,
  ].filter((l) => l !== '').join('\n');
}

function groupKeyboard(inc) {
  return { inline_keyboard: [[{ text: inc.status === 'pending' ? '🔎 Ko‘rib chiqish (admin panel)' : '📄 Batafsil', url: `${config.adminPanelUrl}/incidents?id=${inc._id}` }]] };
}

async function postToGroup(inc) {
  const chatId = config.adminAlertsChatId;
  if (!chatId || !config.telegramBotToken) return;
  const r = await tg('sendMessage', {
    chat_id: chatId, text: groupText(inc), parse_mode: 'HTML',
    link_preview_options: { is_disabled: true }, reply_markup: groupKeyboard(inc),
  });
  if (r?.ok) {
    await CustomerIncident.updateOne({ _id: inc._id }, { $set: { groupPost: { chatId: String(chatId), messageId: r.result.message_id } } });
  }
}

async function refreshGroupPost(inc) {
  if (!inc.groupPost?.messageId) return;
  await tg('editMessageText', {
    chat_id: inc.groupPost.chatId, message_id: inc.groupPost.messageId, text: groupText(inc), parse_mode: 'HTML',
    link_preview_options: { is_disabled: true }, reply_markup: groupKeyboard(inc),
  });
}

/* ───────────── 2. Admin qarori ───────────── */
export async function decideIncident(id, { approve, disableCash = false, block = false, customerMessage = '', note = '', adminName = 'Admin' }) {
  const inc = await CustomerIncident.findById(id);
  if (!inc) throw new IncidentError('NOT_FOUND', 'Topilmadi', 404);
  if (inc.status !== 'pending') throw new IncidentError('ALREADY_DECIDED', 'Bu so‘rov allaqachon hal qilingan', 409);

  // Atomik: bir vaqtda ikki admin qaror qilmasin
  const claimed = await CustomerIncident.findOneAndUpdate(
    { _id: id, status: 'pending' },
    { $set: { status: approve ? 'approved' : 'rejected', 'decision.by': adminName, 'decision.at': new Date(), 'decision.note': String(note || '').slice(0, 500) } },
    { new: true },
  );
  if (!claimed) throw new IncidentError('ALREADY_DECIDED', 'Bu so‘rov allaqachon hal qilingan', 409);

  // Cheklovlar o'chiq bo'lsa (CUSTOMER_RESTRICTIONS_ENABLED=false) — faqat qayd etiladi
  if (!config.customerRestrictionsEnabled) { disableCash = false; block = false; }

  // POST rejimi: buyurtma allaqachon bekor qilingan — faqat baho va (ixtiyoriy) cheklov
  if (claimed.mode === 'post') {
    const msg = String(customerMessage || '').trim().slice(0, 600) || defaultCustomerMessage(claimed);
    if (approve && claimed.userId && (disableCash || block)) {
      await applyRestrictions(claimed.userId, { disableCash, block, reason: msg, by: adminName, incidentId: claimed._id });
    }
    claimed.decision.cashDisabled = Boolean(approve && disableCash);
    claimed.decision.blocked = Boolean(approve && block);
    claimed.decision.customerMessage = approve && (disableCash || block) ? msg : '';
    await claimed.save();
    await refreshGroupPost(claimed).catch(() => {});
    getIO()?.to('admin').emit('incident:update', { _id: claimed._id });
    return claimed;
  }

  if (!approve) {
    await Order.updateOne({ _id: inc.orderId }, { $set: { 'cancelRequest.status': 'rejected', 'cancelRequest.decidedAt': new Date() } });
    await notifyRestaurant(claimed, '❌ <b>LokmaGo admini bekor qilishni rad etdi</b> — buyurtmani davom ettiring.');
    await refreshGroupPost(claimed).catch(() => {});
    getIO()?.to('admin').emit('incident:update', { _id: claimed._id });
    return claimed;
  }

  // Bekor qilish (agar buyurtma orada yakunlanmagan bo'lsa)
  try {
    await changeOrderStatus({
      orderId: inc.orderId, restaurantId: inc.restaurantId, status: 'cancelled',
      actorName: 'LokmaGo admin', cancelReason: `Mijoz voz kechdi: ${inc.reason}`, approvedByAdmin: true,
    });
  } catch (e) {
    // Buyurtma allaqachon yakunlangan/bekor bo'lgan — qarorni qaytaramiz
    await CustomerIncident.updateOne({ _id: id }, { $set: { status: 'pending' }, $unset: { decision: 1 } });
    if (e instanceof OrderFlowError) throw new IncidentError('ORDER_STATE', `Buyurtmani bekor qilib bo‘lmadi: ${e.message}`, 409);
    throw e;
  }
  await Order.updateOne({ _id: inc.orderId }, { $set: { 'cancelRequest.status': 'approved', 'cancelRequest.decidedAt': new Date() } });

  const msg = String(customerMessage || '').trim().slice(0, 600) || defaultCustomerMessage(claimed);
  if (claimed.userId && (disableCash || block)) {
    await applyRestrictions(claimed.userId, { disableCash, block, reason: msg, by: adminName, incidentId: claimed._id });
  }
  claimed.decision.cashDisabled = Boolean(disableCash);
  claimed.decision.blocked = Boolean(block);
  claimed.decision.customerMessage = (disableCash || block) ? msg : '';
  await claimed.save();

  await notifyRestaurant(claimed, '✅ <b>LokmaGo admini bekor qilishni tasdiqladi</b> — buyurtma bekor qilindi.');
  await refreshGroupPost(claimed).catch(() => {});
  getIO()?.to('admin').emit('incident:update', { _id: claimed._id });
  return claimed;
}

/** Naqd o'chirish / bloklash (admin qarori yoki keyinchalik qo'lda) — mijozga sababi bilan xabar */
export async function applyRestrictions(userId, { disableCash, block, reason, by = 'Admin', incidentId }) {
  if (!config.customerRestrictionsEnabled) return null; // cheklovlar o'chiq
  const set = {};
  if (disableCash) Object.assign(set, { 'cashDisabled.active': true, 'cashDisabled.reason': reason, 'cashDisabled.at': new Date(), 'cashDisabled.by': by, ...(incidentId ? { 'cashDisabled.incidentId': incidentId } : {}) });
  if (block) Object.assign(set, { status: 'BLOCKED', isActive: false, 'blockInfo.reason': reason, 'blockInfo.at': new Date(), 'blockInfo.by': by, ...(incidentId ? { 'blockInfo.incidentId': incidentId } : {}) });
  if (!Object.keys(set).length) return null;
  const user = await User.findByIdAndUpdate(userId, { $set: set }, { new: true }).select('telegramId status cashDisabled blockInfo');
  if (user?.telegramId) {
    const text = block
      ? `⛔ <b>Hisobingiz bloklandi</b>\n\n${esc(reason)}\n\nShu sababli LokmaGo xizmatlaridan foydalana olmaysiz. Savollar bo‘lsa, qo‘llab-quvvatlash xizmatiga yozing.`
      : `💳 <b>Naqd to‘lov o‘chirildi</b>\n\n${esc(reason)}\n\nEndi buyurtmalarni faqat karta orqali oldindan to‘lab bera olasiz.`;
    notifyUser(user.telegramId, text);
  }
  return user;
}

/** Cheklovni olib tashlash (admin panel) */
export async function liftRestrictions(userId, { cash = false, block = false }) {
  const set = {}; const unset = {};
  if (cash) { set['cashDisabled.active'] = false; }
  if (block) { set.status = 'ACTIVE'; set.isActive = true; unset.blockInfo = 1; }
  if (!cash && !block) return null;
  return User.findByIdAndUpdate(userId, { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}) }, { new: true })
    .select('firstName lastName username phone telegramId status cashDisabled blockInfo');
}

async function notifyRestaurant(inc, text) {
  try {
    const { activeStaff } = await import('./restaurantBotOrders.js');
    const { sendToStaff } = await import('./restaurantBotApi.js');
    const { RestaurantBotMessage } = await import('../models/RestaurantBotMessage.js');
    const staff = await activeStaff(inc.restaurantId);
    const cards = await RestaurantBotMessage.find({ orderId: inc.orderId, kind: 'order' }).lean();
    const cardOf = new Map(cards.map((c) => [String(c.telegramUserId), c.messageId]));
    const body = `${text}\n\n${esc(inc.orderLabel)} · ${esc(inc.reason)}`;
    await Promise.all(staff.map((s) => {
      const cardId = cardOf.get(String(s.telegramUserId));
      return sendToStaff(s.telegramUserId, body, null, cardId ? { reply_parameters: { message_id: cardId, allow_sending_without_reply: true } } : {}).catch(() => null);
    }));
  } catch (e) {
    console.error('[incident] restoranga xabar:', e.message);
  }
  await pushOrderUpdate(inc.orderId);
}

/** Restoran paneli va admin uchun buyurtmaning yangi holati (xavfsiz ko'rinish — orderSocket) */
async function pushOrderUpdate(orderId) {
  const io = getIO();
  if (!io) return;
  try {
    const order = await Order.findById(orderId).populate('userId', 'firstName lastName username telegramId phone photoUrl');
    if (!order) return;
    emitOrderToRestaurant(io, 'order:update', order);
    io.to('admin').emit('order:update', order);
  } catch (e) {
    console.error('[incident] socket:', e.message);
  }
}

/** Admin panel: hodisa uchun mijozning Telegram rasmi (file_id orqali) */
export async function fetchTelegramPhoto(fileId) {
  if (!fileId || !config.telegramBotToken) return null;
  const f = await tg('getFile', { file_id: fileId });
  if (!f?.ok || !f.result?.file_path) return null;
  const r = await fetch(`https://api.telegram.org/file/bot${config.telegramBotToken}/${f.result.file_path}`);
  if (!r.ok) return null;
  return { buffer: Buffer.from(await r.arrayBuffer()), type: r.headers.get('content-type') || 'image/jpeg' };
}
