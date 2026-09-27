import { config } from '../config/index.js';

/*
 * ═══════════════════════════════════════════════════════════
 * MIJOZ YORDAM XABARLARI — TELEGRAM GURUHGA
 * ═══════════════════════════════════════════════════════════
 *
 * Mijoz "Yordam xizmati"ga yozganda, admin panelni ochib
 * o'tirmasdan ham darhol bilib qolishi uchun — bitta ichki
 * Telegram guruhga yuboriladi. Xabar ostida "Xabarlar bo'limiga
 * o'tish" tugmasi bor, u https://admin.lokma.uz/support ni ochadi.
 *
 * ─── BOT GURUHDA HECH NARSA QILMAYDI ───
 * Bu funksiya FAQAT sendMessage yo'nalishida ishlaydi — guruhga
 * yozadi, guruhdan HECH NARSA o'qimaydi. Tugma oddiy `url` turida
 * (callback_data EMAS), Telegram uni to'g'ridan-to'g'ri brauzerda
 * ochadi — bosilganda BOTGA hech qanday so'rov (webhook update)
 * kelmaydi. Guruhda kimdir yozsa ham, mavjud webhook handler
 * (services/telegram.js) faqat SHAXSIY chatlarni qayta ishlaydi —
 * guruh xabarlari umuman ko'rib chiqilmaydi (private-chat qulfi).
 *
 * ─── MAVJUD BOT, YANGI TOKEN SHART EMAS ───
 * Asosiy mijoz boti (config.telegramBotToken) ishlatiladi — u
 * allaqachon ishlab turibdi, guruhga xabar yozish uning shaxsiy
 * chatlardagi vazifasiga (auto/buyurtma/yetkazish) HECH QANDAY
 * ta'sir qilmaydi. Faqat .env ga SUPPORT_GROUP_CHAT_ID qo'shiladi;
 * bot shu guruhga ODDIY A'ZO sifatida (yoki admin — farqi yo'q)
 * qo'shilgan bo'lishi kifoya.
 *
 * Sozlanmagan bo'lsa (SUPPORT_GROUP_CHAT_ID bo'sh) — jimgina
 * o'tkazib yuboriladi, mavjud tizimga hech qanday ta'sir qilmaydi.
 */

function esc(value = '') {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function isSupportGroupEnabled() {
  return Boolean(config.telegramBotToken && config.supportGroupChatId);
}

/**
 * @param {{ firstName?, lastName?, username?, phone? }} customer
 * @param {string} text — mijoz yozgan xabar
 */
export async function notifySupportGroup(customer, text) {
  if (!isSupportGroupEnabled()) return;

  const name = [customer.firstName, customer.lastName].filter(Boolean).join(' ').trim() || 'Mijoz';
  const contact = customer.username ? `@${customer.username}` : (customer.phone || '');

  const body = '🆘 <b>Yangi mijoz xabari</b>\n\n'
    + `👤 <b>${esc(name)}</b>${contact ? ` · ${esc(contact)}` : ''}\n\n`
    + `«${esc(String(text).slice(0, 800))}»`;

  try {
    const res = await fetch(`https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: config.supportGroupChatId,
        text: body,
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: {
          inline_keyboard: [[
            { text: '💬 Xabarlar bo‘limiga o‘tish', url: `${config.adminPanelUrl}/support` },
          ]],
        },
      }),
    });
    const data = await res.json();
    if (!data.ok) console.error('[supportGroup] sendMessage:', data.description);
  } catch (e) {
    console.error('[supportGroup] xabar yuborishda xato:', e.message);
  }
}
