import { config } from '../config/index.js';
import { SupportChat } from '../models/SupportChat.js';
import { tgCall } from './telegramApi.js';

/*
 * ═══════════════════════════════════════════════════════════
 * MIJOZ YORDAM XABARLARI — TELEGRAM GURUHGA (MIJOZ BO'YICHA POST)
 * ═══════════════════════════════════════════════════════════
 *
 * Har bir MIJOZ uchun guruhda bitta post; u qayta-qayta yozsa yangi xabar
 * yaratilmaydi — o'sha post editMessageText bilan tahrirlanadi va yangi satr
 * pastdan qo'shiladi. Boshqa mijoz yozsa — alohida post (mijoz suhbat
 * ID'si bo'yicha ajratiladi).
 *
 *   🆘 Yangi mijoz xabari
 *
 *   👤 Murodbek · @muqaddas
 *
 *   «Hop» · 08:38
 *   «Qanday kartsa buladi» · 08:39
 *
 *   ⏳ Javob kutilmoqda                       ← admin javob berguncha
 *   ✅✅ Javob berildi · Admin · 08:41         ← admin javob bergach (post tahrirlanadi)
 *
 * ─── YANGI POST QACHON ───
 *  • post yo'q / boshqa guruhda (sozlama o'zgargan) / guruhdan o'chirilgan;
 *  • ADMIN JAVOB BERGAN: yangi xabar — yangi savol, yangi post;
 *  • mijoz oxirgi xabaridan SUPPORT_GROUP_THREAD_MINUTES (60) daqiqadan
 *    keyin yozsa;
 *  • post Telegram chegarasiga (4096) yaqinlashsa — davomi yangi postda.
 *
 * NEGA VAQT CHEGARASI VA "JAVOBDAN KEYIN YANGI POST": Telegram TAHRIRLANGAN
 * xabar uchun bildirishnoma BERMAYDI. Mijoz uzoq jimlikdan keyin yoki javobdan
 * keyin yozsa, eski postni jimgina tahrirlash adminlar e'tiboridan chetda
 * qolardi. Yangi post esa bildirishnoma beradi. Ketma-ket xabarlar (bir necha
 * daqiqa ichida) esa jamlanadi — spam yo'q. SUPPORT_GROUP_THREAD_MINUTES=0 —
 * vaqt cheklovsiz (faqat javobgacha).
 *
 * ─── BOT GURUHDA HECH NARSA QILMAYDI ───
 * Faqat yozadi va o'z postlarini tahrirlaydi; guruhdan HECH NARSA o'qimaydi.
 * Tugma oddiy `url` (bosilganda botga so'rov kelmaydi); guruh xabarlari
 * services/telegram.js da e'tiborsiz qoldiriladi.
 *
 * Sozlanmagan bo'lsa (SUPPORT_GROUP_CHAT_ID bo'sh) — jimgina o'tkaziladi.
 */

const MAX_POST = 3800;           // Telegram 4096 — HTML teglar uchun zaxira
const MAX_LINE = 1500;           // bitta satr (mijoz xabari 2000 gacha)
const TZ = 'Asia/Tashkent';

function esc(value = '') {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const hhmm = (d) => new Intl.DateTimeFormat('ru-RU', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }).format(new Date(d));

export function isSupportGroupEnabled() {
  return Boolean(config.telegramBotToken && config.supportGroupChatId);
}

const keyboard = () => ({
  inline_keyboard: [[{ text: '💬 Xabarlar bo‘limiga o‘tish', url: `${config.adminPanelUrl}/support` }]],
});

function whoLine(customer) {
  const name = [customer.firstName, customer.lastName].filter(Boolean).join(' ').trim() || 'Mijoz';
  const contact = customer.username ? `@${customer.username}` : (customer.phone || '');
  return `👤 <b>${esc(name)}</b>${contact ? ` · ${esc(contact)}` : ''}`;
}

/**
 * Post matni. `post`: { lines:[{text,at}], continued, repliedAt, repliedBy }
 * (sof funksiya — testlanadi)
 */
export function buildPostText(customer, post) {
  const head = post.continued ? '🆘 <b>Mijoz xabari (davomi)</b>' : '🆘 <b>Yangi mijoz xabari</b>';
  const lines = (post.lines || []).map((l) => `«${esc(l.text)}» · <i>${hhmm(l.at)}</i>`).join('\n');
  const status = post.repliedAt
    ? `✅✅ <b>Javob berildi</b>${post.repliedBy ? ` · ${esc(post.repliedBy)}` : ''} · <i>${hhmm(post.repliedAt)}</i>`
    : '⏳ <i>Javob kutilmoqda</i>';
  return `${head}\n\n${whoLine(customer)}\n\n${lines}\n\n${status}`;
}

/* ── Bir mijozning so'rovlari KETMA-KET (parallel ikki xabar ikki post yaratmasin) ── */
const locks = new Map();
function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  locks.set(key, next);
  next.finally(() => { if (locks.get(key) === next) locks.delete(key); }).catch(() => {});
  return next;
}

const isNotModified = (e) => /message is not modified/i.test(e?.message || '');

async function sendNew(chatId, customer, post) {
  const res = await tgCall('sendMessage', {
    chat_id: chatId,
    text: buildPostText(customer, post),
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    reply_markup: keyboard(),
  });
  return res.message_id;
}

async function threaded(customer, rawText) {
  const chatId = String(config.supportGroupChatId);
  const now = new Date();
  const text = String(rawText).slice(0, MAX_LINE);
  const line = { text, at: now };

  const doc = await SupportChat.findById(customer._id).select('groupPost').lean();
  const prev = doc?.groupPost || null;

  const windowMs = config.supportGroupThreadMinutes * 60_000;
  const fresh = prev && prev.messageId && String(prev.chatId) === chatId && !prev.repliedAt
    && (windowMs === 0 || now.getTime() - new Date(prev.lastLineAt).getTime() <= windowMs);

  let full = false;
  if (fresh) {
    const lines = [...prev.lines, line];
    const next = { ...prev, lines };
    if (buildPostText(customer, next).length <= MAX_POST) {
      try {
        await tgCall('editMessageText', {
          chat_id: chatId,
          message_id: prev.messageId,
          text: buildPostText(customer, next),
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
          reply_markup: keyboard(),
        });
      } catch (e) {
        /*
         * "o'zgarmadi" — xato emas. Boshqa xato (post guruhdan o'chirilgan,
         * tahrirlab bo'lmaydi, tarmoq) — mijoz xabari BARIBIR adminlarga
         * yetishi kerak: yangi post yuboriladi.
         */
        if (!isNotModified(e)) {
          console.warn(`[supportGroup] tahrirlab bo‘lmadi (${e.message}) — yangi post`);
          return startNew();
        }
      }
      await SupportChat.updateOne({ _id: customer._id }, { $set: { 'groupPost.lines': lines, 'groupPost.lastLineAt': now } });
      return { mode: 'edited', messageId: prev.messageId };
    }
    full = true; // post to'ldi — davomi yangi postda
  }
  return startNew();

  async function startNew() {
    const post = { chatId, messageId: 0, lines: [line], continued: full, startedAt: now, lastLineAt: now, repliedAt: null, repliedBy: '' };
    post.messageId = await sendNew(chatId, customer, post);
    await SupportChat.updateOne({ _id: customer._id }, { $set: { groupPost: post } });
    return { mode: 'created', messageId: post.messageId };
  }
}

/**
 * Mijoz yangi xabar yozdi.
 * @param {{ _id?, firstName?, lastName?, username?, phone? }} customer — SupportChat hujjati
 * @param {string} text
 */
export async function notifySupportGroup(customer, text) {
  if (!isSupportGroupEnabled()) return null;
  try {
    // `_id` yo'q (oddiy obyekt) — ipga bog'lab bo'lmaydi: bitta post yuboriladi
    if (!customer?._id) {
      const chatId = String(config.supportGroupChatId);
      const id = await sendNew(chatId, customer || {}, { lines: [{ text: String(text).slice(0, MAX_LINE), at: new Date() }] });
      return { mode: 'created', messageId: id };
    }
    return await withLock(String(customer._id), () => threaded(customer, text));
  } catch (e) {
    console.error('[supportGroup] xabar yuborishda xato:', e.message);
    return null;
  }
}

/**
 * Admin mijozga javob berdi → guruhdagi shu mijozning posti tahrirlanadi: ✅✅.
 * Post yo'q bo'lsa (guruh o'chiq edi / eski xabar) — hech narsa qilmaydi.
 * @param {string|ObjectId} supportChatId — SupportChat._id
 * @param {string} adminName
 */
export async function markSupportGroupReplied(supportChatId, adminName = '') {
  if (!isSupportGroupEnabled() || !supportChatId) return null;
  try {
    return await withLock(String(supportChatId), async () => {
      const doc = await SupportChat.findById(supportChatId)
        .select('groupPost firstName lastName username phone').lean();
      const post = doc?.groupPost;
      if (!post?.messageId || post.repliedAt || String(post.chatId) !== String(config.supportGroupChatId)) {
        return { mode: 'skipped' };
      }
      const now = new Date();
      const next = { ...post, repliedAt: now, repliedBy: adminName };
      try {
        await tgCall('editMessageText', {
          chat_id: post.chatId,
          message_id: post.messageId,
          text: buildPostText(doc, next),
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
          reply_markup: keyboard(),
        });
      } catch (e) {
        // Post o'chirilgan bo'lishi mumkin — javob baribir qayd etiladi (keyingi xabar yangi post)
        if (!isNotModified(e)) console.warn(`[supportGroup] ✅✅ belgisini qo‘yib bo‘lmadi: ${e.message}`);
      }
      await SupportChat.updateOne({ _id: supportChatId }, { $set: { 'groupPost.repliedAt': now, 'groupPost.repliedBy': adminName } });
      return { mode: 'replied', messageId: post.messageId };
    });
  } catch (e) {
    console.error('[supportGroup] javob belgisida xato:', e.message);
    return null;
  }
}
