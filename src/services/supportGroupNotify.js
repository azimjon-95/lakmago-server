import { config } from '../config/index.js';
import { SupportChat } from '../models/SupportChat.js';
import { tgCall } from './telegramApi.js';

/*
 * ═══════════════════════════════════════════════════════════
 * MIJOZ YORDAM XABARLARI — TELEGRAM GURUHGA (MIJOZ BO'YICHA BITTA POST)
 * ═══════════════════════════════════════════════════════════
 *
 * Har bir MIJOZ uchun guruhda BITTA post — sessiya (suhbat) YOPILGUNCHA.
 * Mijoz qayta-qayta yozsa ham, admin javob bergandan KEYIN yana yozsa ham
 * yangi xabar yaratilmaydi: o'sha post editMessageText bilan tahrirlanadi va
 * yangi satr pastdan qo'shiladi. Boshqa mijoz yozsa — alohida post.
 *
 *   🆘 Yangi mijoz xabari
 *
 *   👤 Azimjon · @Azimjon_M
 *
 *   «Ыфдщь» · 11:25
 *   «Bu test sinovi» · 11:26
 *   ✅✅ Administrator javob berdi · 11:26        ← javob belgisi joyida qoladi
 *   «Aloo Taomlar achib qolgan ekan» · 11:27      ← javobdan keyingi xabar SHU postga
 *
 *   ⏳ Javob kutilmoqda                           ← oxirgi holat (mijoz yozdi, javob yo'q)
 *   ✅✅ Javob berildi · Administrator · 11:28     ← admin yana javob bergach
 *   🔒 Suhbat yopildi · 11:40                     ← admin "yopish"ni bosgach
 *
 * ─── YANGI POST FAQAT ───
 *  • sessiya YOPILGAN (admin "yopish"): keyingi xabar — yangi sessiya, yangi post;
 *  • post yo'q / boshqa guruhda (sozlama o'zgargan) / guruhdan o'chirilgan;
 *  • post Telegram chegarasiga (4096) yaqinlashsa — davomi yangi postda;
 *  • (ixtiyoriy) SUPPORT_GROUP_THREAD_MINUTES > 0 bo'lsa va mijoz shuncha jim tursa.
 *
 * ESLATMA: Telegram TAHRIRLANGAN xabar uchun bildirishnoma BERMAYDI. Shuning uchun
 * mijozning HAR KEYINGI xabari postni yangilash bilan birga shu postga JAVOB sifatida
 * qisqa "🔔 Ism: «matn»" xabari bo'lib ham yuboriladi (tovush bilan) — aks holda adminlar
 * birinchi xabardan keyingilarini umuman sezmasdi. Real-time signal admin panelda ham
 * (support:message).
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

/*
 * Guruh ID: sozlamadagi, lekin Telegram "guruh supergruppaga aylandi (migrate_to_chat_id)"
 * desa — YANGI ID (xotirada). Eski ID bilan har xabar rad etilib yo'qolib ketardi.
 * Server qayta ishga tushsa, birinchi xabarda xato qayta keladi va shu yerda o'zi tuzaladi;
 * baribir .env dagi SUPPORT_GROUP_CHAT_ID ni yangilash kerak (log'da aytiladi).
 */
let chatOverride = null;
export const groupChatId = () => String(chatOverride || config.supportGroupChatId || '');

export function isSupportGroupEnabled() {
  return Boolean(config.telegramBotToken && groupChatId());
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stripTags = (html = '') => String(html)
  .replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/**
 * Telegram chaqiruvi — vaqtinchalik xatolarda xabar YO'QOLMASLIGI uchun:
 *   • 429 (juda tez) — retry_after (≤3 s) kutib qayta;
 *   • "can't parse entities" — HTML'siz oddiy matn bilan qayta;
 *   • migrate_to_chat_id — yangi guruh ID'siga o'tib qayta.
 * Boshqa xato chaqiruvchiga uzatiladi (u loglaydi / zaxira yo'lini tanlaydi).
 */
async function call(method, body, attempt = 0) {
  try {
    return await tgCall(method, body);
  } catch (e) {
    if (attempt >= 2) throw e;
    if (e.migrateTo) {
      chatOverride = String(e.migrateTo);
      console.error(`[supportGroup] guruh supergruppaga aylangan! Yangi ID: ${chatOverride} — .env dagi SUPPORT_GROUP_CHAT_ID ni yangilang`);
      return call(method, { ...body, chat_id: chatOverride }, attempt + 1);
    }
    if (e.code === 429 && e.retryAfter) {
      await sleep(Math.min(Number(e.retryAfter) || 1, 3) * 1000);
      return call(method, body, attempt + 1);
    }
    if (body.parse_mode && /can't parse entities|can not parse entities/i.test(e.description || e.message || '')) {
      const { parse_mode: _drop, ...rest } = body;
      return call(method, { ...rest, text: stripTags(body.text) }, attempt + 1);
    }
    throw e;
  }
}

/*
 * Tugma AYNAN SHU mijozning suhbatini ochadi: /support?chat=<SupportChat._id>.
 * Admin panel (SupportPage) `chat` parametrini o'qib suhbatni darhol ochadi;
 * kirmagan bo'lsa — login'dan keyin ham URL saqlanadi (LoginPage yo'naltirmaydi).
 * Query parametr (yo'l emas) — eski admin build ham /support ni ochaveradi.
 * Id noma'lum bo'lsa (customer._id yo'q) — umumiy /support.
 * Post har tahrirda tugmani qayta yuboradi, shuning uchun eski postlar ham
 * keyingi tahrirda to'g'ri havolaga o'tadi.
 */
export function supportChatUrl(supportChatId) {
  const base = `${config.adminPanelUrl}/support`;
  const id = supportChatId ? String(supportChatId) : '';
  return /^[a-f\d]{24}$/i.test(id) ? `${base}?chat=${id}` : base;
}

const keyboard = (supportChatId) => ({
  inline_keyboard: [[{ text: '💬 Xabarlar bo‘limiga o‘tish', url: supportChatUrl(supportChatId) }]],
});

function whoLine(customer) {
  const name = [customer.firstName, customer.lastName].filter(Boolean).join(' ').trim() || 'Mijoz';
  const contact = customer.username ? `@${customer.username}` : (customer.phone || '');
  return `👤 <b>${esc(name)}</b>${contact ? ` · ${esc(contact)}` : ''}`;
}

/**
 * Post satrlari. ESKI postlar (kind'siz, javob alohida `repliedAt` da) ham
 * to'g'ri o'qiladi: javob oxirgi satr sifatida qo'shiladi.
 */
export function entriesOf(post) {
  const lines = (post.lines || []).map((l) => ({
    kind: l.kind || 'user', text: l.text || '', by: l.by || '', at: l.at,
  }));
  if (post.repliedAt && !lines.some((l) => l.kind === 'reply')) {
    lines.push({ kind: 'reply', text: '', by: post.repliedBy || '', at: post.repliedAt });
  }
  return lines;
}

/**
 * Post matni (sof funksiya — testlanadi).
 * `post`: { lines:[{kind,text,by,at}], continued, closedAt }
 */
export function buildPostText(customer, post) {
  const head = post.continued ? '🆘 <b>Mijoz xabari (davomi)</b>' : '🆘 <b>Yangi mijoz xabari</b>';
  const entries = entriesOf(post);
  const lastIdx = entries.length - 1;
  const last = entries[lastIdx];
  const closed = Boolean(post.closedAt);

  const body = entries.map((e, i) => {
    if (e.kind === 'reply') {
      // Oxirgi javob (yopilmagan post) pastki holat qatorida — takrorlanmasin
      if (i === lastIdx && !closed) return null;
      return `✅✅ <i>${esc(e.by || 'Admin')} javob berdi</i> · <i>${hhmm(e.at)}</i>`;
    }
    return `«${esc(e.text)}» · <i>${hhmm(e.at)}</i>`;
  }).filter(Boolean).join('\n');

  let status;
  if (closed) status = `🔒 <b>Suhbat yopildi</b> · <i>${hhmm(post.closedAt)}</i>`;
  else if (last?.kind === 'reply') status = `✅✅ <b>Javob berildi</b>${last.by ? ` · ${esc(last.by)}` : ''} · <i>${hhmm(last.at)}</i>`;
  else status = '⏳ <i>Javob kutilmoqda</i>';

  return `${head}\n\n${whoLine(customer)}\n\n${body ? `${body}\n\n` : ''}${status}`;
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
  const res = await call('sendMessage', {
    chat_id: chatId,
    text: buildPostText(customer, post),
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    reply_markup: keyboard(customer?._id),
  });
  return res.message_id;
}

const SNIPPET = 400;

async function notifyFollowUp(chatId, customer, postMessageId, text) {
  const name = [customer.firstName, customer.lastName].filter(Boolean).join(' ').trim() || 'Mijoz';
  const snippet = text.length > SNIPPET ? `${text.slice(0, SNIPPET)}…` : text;
  try {
    await call('sendMessage', {
      chat_id: chatId,
      text: `🔔 <b>${esc(name)}</b>: «${esc(snippet)}»`,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      // Postga javob — adminlar suhbatni ko'radi; post o'chirilgan bo'lsa ham xabar yetadi
      reply_parameters: { message_id: postMessageId, allow_sending_without_reply: true },
      reply_markup: keyboard(customer?._id),
    });
  } catch (e) {
    console.error(`[supportGroup] bildirishnoma yuborilmadi: ${e.message}`);
  }
}

async function threaded(customer, rawText) {
  const chatId = groupChatId();
  const now = new Date();
  const text = String(rawText).slice(0, MAX_LINE);

  const doc = await SupportChat.findById(customer._id).select('groupPost').lean();
  const prev = doc?.groupPost || null;

  const windowMs = config.supportGroupThreadMinutes * 60_000;
  // Post "yangi" bo'lib qolish sharti: yopilmagan, shu guruhda, (ixtiyoriy) vaqt chegarasi ichida.
  // ADMIN JAVOB BERGANI bu yerda ahamiyatsiz — javobdan keyingi xabar ham shu postga qo'shiladi.
  const fresh = prev && prev.messageId && String(prev.chatId) === chatId && !prev.closedAt
    && (windowMs === 0 || now.getTime() - new Date(prev.lastLineAt).getTime() <= windowMs);

  let full = false;
  if (fresh) {
    const lines = [...entriesOf(prev), { kind: 'user', text, by: '', at: now }];
    // repliedAt: ESKI maydon — satrlarga ko'chirildi, qayta hisoblanmasin
    const next = { ...prev, lines, repliedAt: null };
    if (buildPostText(customer, next).length <= MAX_POST) {
      try {
        await call('editMessageText', {
          chat_id: chatId,
          message_id: prev.messageId,
          text: buildPostText(customer, next),
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
          reply_markup: keyboard(customer._id),
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
      await SupportChat.updateOne({ _id: customer._id }, { $set: { 'groupPost.lines': lines, 'groupPost.lastLineAt': now, 'groupPost.repliedAt': null } });
      /*
       * TELEGRAM TAHRIR UCHUN BILDIRISHNOMA BERMAYDI — post jim yangilanardi va adminlar
       * mijozning keyingi xabarlarini UMUMAN sezmasdi. Shuning uchun har keyingi xabar
       * shu postga JAVOB sifatida qisqa xabar bo'lib ham yuboriladi (tovush bilan).
       */
      await notifyFollowUp(chatId, customer, prev.messageId, text);
      return { mode: 'edited', messageId: prev.messageId };
    }
    full = true; // post to'ldi — davomi yangi postda
  }
  return startNew();

  async function startNew() {
    const post = { chatId, messageId: 0, lines: [{ kind: 'user', text, by: '', at: now }], continued: full, startedAt: now, lastLineAt: now, closedAt: null, repliedAt: null, repliedBy: '' };
    post.messageId = await sendNew(chatId, customer, post);
    post.chatId = groupChatId();   // migratsiya bo'lgan bo'lsa — yangi ID
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
      const chatId = groupChatId();
      const id = await sendNew(chatId, customer || {}, { lines: [{ kind: 'user', text: String(text).slice(0, MAX_LINE), at: new Date() }] });
      return { mode: 'created', messageId: id };
    }
    return await withLock(String(customer._id), () => threaded(customer, text));
  } catch (e) {
    console.error('[supportGroup] xabar yuborishda xato:', e.message);
    return null;
  }
}

/** Posti tahrirlash — "o'zgarmadi" xato emas; boshqa xato logga. */
async function editPost(doc, post) {
  try {
    await call('editMessageText', {
      chat_id: post.chatId,
      message_id: post.messageId,
      text: buildPostText(doc, post),
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: keyboard(doc?._id),
    });
    return true;
  } catch (e) {
    if (isNotModified(e)) return true;
    console.warn(`[supportGroup] postni tahrirlab bo‘lmadi: ${e.message}`);
    return false;
  }
}

const POST_FIELDS = 'groupPost firstName lastName username phone';
const live = (post) => post?.messageId && String(post.chatId) === groupChatId() && !post.closedAt;

/**
 * Admin mijozga javob berdi → guruhdagi shu mijozning postiga ✅✅ belgisi qo'shiladi
 * (satrlar orasida joyida qoladi; mijoz keyin yozsa ⏳ ga qaytadi).
 * Post yo'q/yopilgan bo'lsa yoki oxirgi satr allaqachon javob bo'lsa — hech narsa qilmaydi.
 * @param {string|ObjectId} supportChatId — SupportChat._id
 * @param {string} adminName
 */
export async function markSupportGroupReplied(supportChatId, adminName = '') {
  if (!isSupportGroupEnabled() || !supportChatId) return null;
  try {
    return await withLock(String(supportChatId), async () => {
      const doc = await SupportChat.findById(supportChatId).select(POST_FIELDS).lean();
      const post = doc?.groupPost;
      if (!live(post)) return { mode: 'skipped' };
      const entries = entriesOf(post);
      if (entries[entries.length - 1]?.kind === 'reply') return { mode: 'skipped' }; // ketma-ket ikkinchi javob — holat o'zgarmaydi
      const now = new Date();
      entries.push({ kind: 'reply', text: '', by: adminName, at: now });
      // Tahrir muvaffaqiyatsiz bo'lsa ham javob qayd etiladi (post o'chirilgan bo'lishi mumkin)
      await editPost(doc, { ...post, lines: entries, repliedAt: null });
      await SupportChat.updateOne({ _id: supportChatId }, { $set: { 'groupPost.lines': entries, 'groupPost.repliedAt': null } });
      return { mode: 'replied', messageId: post.messageId };
    });
  } catch (e) {
    console.error('[supportGroup] javob belgisida xato:', e.message);
    return null;
  }
}

/**
 * Sessiya YOPILDI (admin "yopish") → post oxiriga "🔒 Suhbat yopildi"; keyingi mijoz
 * xabari YANGI post bo'ladi.
 */
export async function markSupportGroupClosed(supportChatId) {
  if (!isSupportGroupEnabled() || !supportChatId) return null;
  try {
    return await withLock(String(supportChatId), async () => {
      const doc = await SupportChat.findById(supportChatId).select(POST_FIELDS).lean();
      const post = doc?.groupPost;
      if (!post?.messageId || post.closedAt) return { mode: 'skipped' };
      const closedAt = new Date();
      if (String(post.chatId) === groupChatId()) {
        await editPost(doc, { ...post, lines: entriesOf(post), repliedAt: null, closedAt });
      }
      await SupportChat.updateOne({ _id: supportChatId }, { $set: { 'groupPost.closedAt': closedAt } });
      return { mode: 'closed', messageId: post.messageId };
    });
  } catch (e) {
    console.error('[supportGroup] yopishda xato:', e.message);
    return null;
  }
}

/* ═══════════════════════════════════════════════════════════
 * DIAGNOSTIKA — mijoz xabarlari adminlar guruhiga YETIB BORADIMI?
 * ═══════════════════════════════════════════════════════════
 * Avval sozlama xato bo'lsa (ID bo'sh/noto'g'ri, bot guruhda yo'q, yozish huquqi yo'q)
 * server JIM turardi — xabarlar shunchaki yo'qolardi. Endi sababi aniq aytiladi.
 */
export async function supportGroupStatus() {
  const out = { ok: false, tokenSet: Boolean(config.telegramBotToken), chatId: groupChatId(), problems: [], hints: [] };
  const bad = (problem, hint) => { out.problems.push(problem); if (hint) out.hints.push(hint); };

  if (!out.tokenSet) bad('TELEGRAM_BOT_TOKEN sozlanmagan', '.env ga bot tokenini yozing');
  if (!out.chatId) bad('SUPPORT_GROUP_CHAT_ID sozlanmagan — mijoz xabarlari Telegram guruhiga yuborilmaydi', 'Guruh ID sini (-100… bilan boshlanadi) .env ga yozing va serverni qayta ishga tushiring');
  if (out.problems.length) return out;
  if (!/^-?\d+$/.test(out.chatId)) bad(`SUPPORT_GROUP_CHAT_ID noto'g'ri formatda: "${out.chatId}"`, 'Faqat raqam bo‘lishi kerak, masalan -1001234567890 (@nom emas)');

  let me = null;
  try { me = await tgCall('getMe', {}); out.bot = { id: me.id, username: me.username }; }
  catch (e) { bad(`Bot tokeni ishlamayapti: ${e.message}`, 'TELEGRAM_BOT_TOKEN ni @BotFather dan qayta oling'); return out; }

  try {
    const chat = await call('getChat', { chat_id: groupChatId() });
    out.chat = { id: chat.id, title: chat.title || null, type: chat.type, isForum: Boolean(chat.is_forum) };
    out.chatId = groupChatId();
    if (chat.type === 'private') bad('Bu guruh emas, shaxsiy chat', 'Guruh ID sini ishlating (manfiy son)');
  } catch (e) {
    const d = e.description || e.message || '';
    if (/chat not found/i.test(d)) bad('Guruh topilmadi', 'ID noto‘g‘ri yoki bot guruhga qo‘shilmagan. Botni guruhga qo‘shing; guruh ID si odatda -100 bilan boshlanadi');
    else bad(`Guruhni olib bo'lmadi: ${d}`);
    return out;
  }

  try {
    const m = await call('getChatMember', { chat_id: groupChatId(), user_id: me.id });
    out.bot.status = m.status;
    if (m.status === 'left' || m.status === 'kicked') bad(`Bot guruhda emas (${m.status})`, 'Botni guruhga qayta qo‘shing');
    else if (m.status === 'restricted' && m.can_send_messages === false) bad('Botga guruhda yozish taqiqlangan', 'Guruh sozlamalaridan botga xabar yozish huquqini bering');
    else if (m.status === 'member' && out.chat?.type === 'channel') bad('Kanalda bot administrator bo‘lishi kerak');
    if (m.status === 'administrator' && m.can_post_messages === false) bad('Bot kanalga post yozolmaydi', 'Administrator huquqlarida "Xabar yozish" ni yoqing');
  } catch (e) {
    bad(`Bot huquqlarini tekshirib bo'lmadi: ${e.message}`);
  }
  out.ok = out.problems.length === 0;
  return out;
}

/** Guruhga sinov xabari — sozlama to'g'riligini ko'z bilan tasdiqlash uchun */
export async function sendSupportGroupTest(by = 'Admin') {
  const st = await supportGroupStatus();
  if (!st.ok) return { ok: false, status: st };
  try {
    const r = await call('sendMessage', {
      chat_id: groupChatId(),
      text: `✅ <b>Sinov xabari</b>\n\nMijoz yordam xabarlari shu guruhga keladi.\n<i>${esc(by)} · ${hhmm(new Date())}</i>`,
      parse_mode: 'HTML',
    });
    return { ok: true, messageId: r.message_id, status: st };
  } catch (e) {
    return { ok: false, error: e.message, status: st };
  }
}

/** Ishga tushganda: sozlama bo'sh bo'lsa — aniq ogohlantirish (avval jimgina o'tkazilardi) */
export function warnIfSupportGroupMissing() {
  if (!config.telegramBotToken) return;
  if (!groupChatId()) {
    console.warn('[supportGroup] ⚠️  SUPPORT_GROUP_CHAT_ID bo‘sh — mijoz xabarlari Telegram adminlar guruhiga YUBORILMAYDI (faqat admin panelda ko‘rinadi)');
  }
}
