/*
 * Yangi stol broni → admin Telegram guruhiga QISQA post (buyurtma kartalari tushadigan guruh bilan bir xil:
 * ADMIN_ALERTS_CHAT_ID, bo'sh bo'lsa SUPPORT_GROUP_CHAT_ID). Holat o'zgarsa post tahrirlanadi.
 *
 * Telegram xatosi bronni HECH QACHON buzmaydi (chaqiruvchi .catch qiladi; bu yerda ham hech narsa otilmaydi).
 * Bu restoranga yo'nalgan kanal EMAS (faqat adminlar) — 1-qoida (to'lanmagan buyurtma) bronga tegishli emas:
 * bron to'lovsiz, restoran bilan kelishuv.
 */
import { Reservation } from '../models/Reservation.js';
import { sendAlert, editAlert } from './adminOrderMonitor.js';
import { customerTelegramButton } from '../lib/orderContactLinks.js';
import { customerTrustText } from '../lib/reservationCustomer.js';

const esc = (s = '') => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const som = (n) => Math.round(Number(n) || 0).toLocaleString('ru-RU').replace(/[\s\u00a0\u202f,]/g, ' ');
const WD = ['yak', 'dush', 'sesh', 'chor', 'pay', 'jum', 'shan'];

/** "2026-11-25" → "25.11 (chor)" */
export function shortDate(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
  if (!m) return esc(ymd || '—');
  const wd = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay();
  return `${m[3]}.${m[2]} (${WD[wd]})`;
}

const STATUS_LINE = {
  confirmed: '✅ Restoran qabul qildi',
  rejected: '❌ Restoran rad etdi',
  cancelled: '🚫 Mijoz bekor qildi',
  coming: '📞 Mijoz keladi',
  not_coming: '🚫 Mijoz kelmaydi',
  on_way: '🚗 Mijoz yo‘lda',
  arrived: '🙋 Mijoz keldi',
  completed: '🏁 Yakunlandi',
};

export function buildGroupText(r, { title = '' } = {}) {
  const c = r.customer || {};
  const who = esc(r.name);
  const handle = c.username ? ` · @${esc(c.username)}` : '';
  const lines = [
    `${title || '📅 <b>Yangi stol broni</b>'} · <b>${esc(r.restaurantName)}</b>`,
    `👤 <b>${who}</b>${handle} · ${esc(r.phone)}`,
  ];
  const trust = customerTrustText(c);
  if (trust) lines.push(`🔎 ${esc(trust)}`);
  lines.push(`🕐 ${shortDate(r.date)} · <b>${esc(r.time)}</b> · 👥 ${Number(r.guests) || 0} kishi`);

  const pre = (r.preOrder || []).filter((p) => p?.name);
  if (pre.length) {
    const total = pre.reduce((s, p) => s + (Number(p.price) || 0) * (Number(p.quantity) || 1), 0);
    lines.push(`🍽 ${pre.map((p) => `${Number(p.quantity) || 1}× ${esc(p.name)}`).join(', ')}${total ? ` — <b>${som(total)} so‘m</b>` : ''}`);
  }
  if (r.note) lines.push(`📝 ${esc(r.note)}`);
  const st = STATUS_LINE[r.status];
  if (st) lines.push('', `<b>${st}</b>`);
  return lines.join('\n');
}

function buildMarkup(r) {
  const row = [];
  const tg = customerTelegramButton({ username: r.customer?.username, telegramId: r.customer?.telegramId });
  if (tg) row.push({ text: tg.text, url: tg.url });
  return row.length ? { inline_keyboard: [row] } : undefined;
}

/** Yangi bron — post yuboriladi, xabar ID'si bronga yoziladi. Hech qachon otmaydi. */
export async function notifyReservationGroup(reservationId) {
  try {
    const r = await Reservation.findById(reservationId).lean();
    if (!r) return { ok: false, error: 'bron topilmadi' };
    const res = await sendAlert({
      text: buildGroupText(r),
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: buildMarkup(r),
    });
    if (res.ok) {
      await Reservation.updateOne({ _id: r._id }, { $set: { groupPost: { chatId: String(res.chatId), messageId: res.messageId } } });
    } else {
      console.error('[reservationGroup] yuborilmadi:', res.error);
    }
    return res;
  } catch (e) {
    console.error('[reservationGroup]', e.message);
    return { ok: false, error: e.message };
  }
}

/** Holat o'zgarganda postni yangilaydi (post yo'q bo'lsa jim o'tadi) */
export async function refreshReservationGroupPost(reservationId) {
  try {
    const r = await Reservation.findById(reservationId).lean();
    if (!r?.groupPost?.messageId) return { ok: false, error: 'post yo‘q' };
    return await editAlert(r.groupPost.chatId, r.groupPost.messageId, {
      text: buildGroupText(r),
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: buildMarkup(r),
    });
  } catch (e) {
    console.error('[reservationGroup:refresh]', e.message);
    return { ok: false, error: e.message };
  }
}
