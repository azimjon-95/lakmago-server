import crypto from 'node:crypto';
import { config } from '../config/index.js';
import { TgLoginRequest } from '../models/TgLoginRequest.js';
import { tgCall } from './telegramApi.js';

/*
 * ═══════════════════════════════════════════════════════
 * TELEGRAM BOT ORQALI KIRISH (native ilova va brauzer uchun)
 * ═══════════════════════════════════════════════════════
 *
 *  1) Ilova  POST /auth/tg-link/start  →  { code, pollSecret, appLink, deepLink }
 *  2) Ilova Telegram'ni ochadi:  tg://resolve?domain=<bot>&start=login_<code>
 *  3) Bot (/start login_<code>) mijozga ID/qurilma/vaqtni ko'rsatib, 3 tugma beradi:
 *        📱 Raqamni ulashib kirish (request_contact)  |  ✅ Raqamsiz kirish  |  ❌ Bekor qilish
 *  4) Mijoz bosadi → so'rov 'confirmed' (telefon bo'lsa Telegram TASDIQLAGAN raqam, faqat O'ZINING raqami)
 *  5) Ilova  POST /auth/tg-link/poll {code, pollSecret}  → tasdiqlangach tokenlar (BIR MARTA) va profil
 *
 * XAVFSIZLIK:
 *  • `code` ochiq (havolada), lekin tokenlar FAQAT `pollSecret` egasiga beriladi (bazada faqat sha256).
 *  • Tasdiqlashni FAQAT havolani ochgan Telegram foydalanuvchisining O'ZI qila oladi (bot xabarlari uning ID siga bog'liq).
 *  • Bot xabarida qurilma va vaqt ko'rsatiladi + "Bu siz bo'lmasangiz — Bekor qilish" (begona so'rovni tasdiqlab qo'ymaslik uchun).
 *  • Bir martalik: consumed bo'lgach qayta berilmaydi; 5 daqiqada eskiradi.
 *  • Telefon: contact.user_id === from.id bo'lsagina qabul qilinadi (boshqa odamning kontakti rad etiladi).
 */
export const LOGIN_TTL_MS = 5 * 60_000;

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789'; // 54 ta, adashtiriladigan belgilarsiz
const CODE_LEN = 16;

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const safeEqual = (a, b) => {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/** Tekis taqsimlangan tasodifiy kod (rejection sampling — modul siljishi yo'q) */
export function makeCode(len = CODE_LEN) {
  const limit = 256 - (256 % CODE_ALPHABET.length);
  let out = '';
  while (out.length < len) {
    for (const b of crypto.randomBytes(len * 2)) {
      if (b < limit) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
      if (out.length === len) break;
    }
  }
  return out;
}

const validCode = (c) => typeof c === 'string' && /^[A-Za-z0-9]{16}$/.test(c);

/* ───────────── 1) Boshlash ───────────── */
export async function startLogin({ platform, deviceId, lang, ref, ip, userAgent }, now = new Date()) {
  const code = makeCode();
  const pollSecret = crypto.randomBytes(32).toString('base64url');
  await TgLoginRequest.create({
    code,
    pollHash: sha256(pollSecret),
    platform: ['android', 'ios'].includes(platform) ? platform : 'web',
    deviceId: String(deviceId || '').slice(0, 80),
    lang: ['uz', 'uzc', 'ru'].includes(lang) ? lang : 'uz',
    // Referal: faqat shakli to'g'ri bo'lsa (ref_<id>), aks holda e'tiborsiz
    startParam: /^ref_[\w-]{1,40}$/.test(String(ref || '')) ? String(ref) : '',
    ip: String(ip || '').slice(0, 60),
    userAgent: String(userAgent || '').slice(0, 160),
    expiresAt: new Date(now.getTime() + LOGIN_TTL_MS),
  });
  const bot = String(config.botUsername || '').replace(/^@/, '');
  return {
    code,
    pollSecret,
    // Telegram ilovasini TO'G'RIDAN-TO'G'RI ochadi; ochilmasa https havola (t.me sahifasi) zaxira
    appLink: `tg://resolve?domain=${bot}&start=login_${code}`,
    deepLink: `https://t.me/${bot}?start=login_${code}`,
    bot,
    expiresIn: Math.round(LOGIN_TTL_MS / 1000),
  };
}

/* ───────────── 2) So'rash (poll) ───────────── */
/**
 * @param {{code:string,pollSecret:string}} body
 * @param {{ complete: Function }} deps — completeTelegramAuth (controllers/misc.js) — testlarda soxta
 * @returns {{ http:number, body:object }}
 */
export async function pollLogin(body, { complete }, now = new Date()) {
  const { code, pollSecret } = body || {};
  if (!validCode(code) || typeof pollSecret !== 'string' || pollSecret.length < 20 || pollSecret.length > 100) {
    return { http: 400, body: { status: 'invalid' } };
  }
  const reqDoc = await TgLoginRequest.findOne({ code });
  // Kod yo'q yoki kalit mos emas — bir xil javob (qaysi biri noto'g'riligini oshkor qilmaymiz)
  if (!reqDoc || !safeEqual(reqDoc.pollHash, sha256(pollSecret))) return { http: 404, body: { status: 'invalid' } };

  if (reqDoc.status === 'cancelled') return { http: 200, body: { status: 'cancelled' } };
  if (reqDoc.status === 'consumed') return { http: 200, body: { status: 'used' } };
  if (reqDoc.status === 'pending') {
    if (reqDoc.expiresAt <= now) return { http: 200, body: { status: 'expired' } };
    // awaiting: mijoz botni ochdi va tasdiqlashni kutyapmiz (ilova "2-qadam" ni ko'rsatadi)
    return { http: 200, body: { status: 'pending', awaiting: Boolean(reqDoc.tgUser?.id) } };
  }

  // confirmed → tokenlarni BIR MARTA beramiz (atomik: ikkita parallel so'rovdan faqat bittasi o'tadi)
  const claimed = await TgLoginRequest.findOneAndUpdate(
    { _id: reqDoc._id, status: 'confirmed' },
    { $set: { status: 'consumed', consumedAt: now } },
    { new: true },
  );
  if (!claimed) return { http: 200, body: { status: 'used' } };

  const tg = claimed.tgUser || {};
  try {
    const result = await complete(
      { id: tg.id, first_name: tg.first_name, last_name: tg.last_name, username: tg.username, language_code: tg.language_code, is_premium: tg.is_premium },
      { platform: claimed.platform, deviceId: claimed.deviceId, startParam: claimed.startParam },
    );
    // Telegram TASDIQLAGAN telefon: faqat bo'sh bo'lsa yoziladi (mijozning qo'lda kiritganini ezmaydi)
    if (claimed.phone && result?.user && !result.user.phone) {
      result.user.phone = claimed.phone;
      result.user.phoneVerified = true;
      await result.user.save?.();
    }
    return { http: 200, body: { status: 'ok', ...result } };
  } catch (e) {
    if (e.status) return { http: e.status, body: e.payload || { error: e.message } }; // masalan bloklangan mijoz (403)
    // Kutilmagan (baza) xato — mijoz qayta urinsin: so'rovni tasdiqlangan holatga qaytaramiz
    await TgLoginRequest.updateOne({ _id: claimed._id, status: 'consumed' }, { $set: { status: 'confirmed', consumedAt: null } });
    console.error('[tgLink] kirishni yakunlab bo‘lmadi:', e.message);
    return { http: 500, body: { error: 'Kirishni yakunlab bo‘lmadi. Qayta urinib ko‘ring.' } };
  }
}

/* ───────────── 3) Bot: matnlar ───────────── */
const T = {
  uz: {
    title: '🔐 <b>Lokma Go</b> ilovasiga kirish',
    device: { web: 'Brauzer', android: 'Android ilova', ios: 'iPhone ilovasi' },
    prompt: 'Kirish uchun pastdagi tugmani bosing 👇',
    notYou: "Bu siz bo'lmasangiz — «Bekor qilish»ni bosing.",
    share: '📱 Raqamni ulashib kirish', noPhone: '✅ Raqamsiz kirish', cancel: '❌ Bekor qilish',
    done: '✅ <b>Tayyor!</b>\nLokma Go ilovasiga qayting — avtomatik kirasiz.',
    cancelled: 'Bekor qilindi. Hech narsa o‘zgarmadi.',
    expired: 'Havola eskirgan. Ilovada «Kirish» tugmasini qayta bosing.',
    ownOnly: 'Iltimos, aynan o‘zingizning raqamingizni ulashing (pastdagi tugma orqali).',
  },
  uzc: {
    title: '🔐 <b>Lokma Go</b> иловасига кириш',
    device: { web: 'Браузер', android: 'Android илова', ios: 'iPhone иловаси' },
    prompt: 'Кириш учун пастдаги тугмани босинг 👇',
    notYou: 'Бу сиз бўлмасангиз — «Бекор қилиш»ни босинг.',
    share: '📱 Рақамни улашиб кириш', noPhone: '✅ Рақамсиз кириш', cancel: '❌ Бекор қилиш',
    done: '✅ <b>Тайёр!</b>\nLokma Go иловасига қайтинг — автоматик кирасиз.',
    cancelled: 'Бекор қилинди. Ҳеч нарса ўзгармади.',
    expired: 'Ҳавола эскирган. Иловада «Кириш» тугмасини қайта босинг.',
    ownOnly: 'Илтимос, айнан ўзингизнинг рақамингизни улашинг (пастдаги тугма орқали).',
  },
  ru: {
    title: '🔐 Вход в <b>Lokma Go</b>',
    device: { web: 'Браузер', android: 'Приложение Android', ios: 'Приложение iPhone' },
    prompt: 'Нажмите кнопку ниже, чтобы войти 👇',
    notYou: 'Если это не вы — нажмите «Отмена».',
    share: '📱 Поделиться номером и войти', noPhone: '✅ Войти без номера', cancel: '❌ Отмена',
    done: '✅ <b>Готово!</b>\nВернитесь в приложение Lokma Go — вход произойдёт автоматически.',
    cancelled: 'Отменено. Ничего не изменилось.',
    expired: 'Ссылка устарела. Нажмите «Войти» в приложении ещё раз.',
    ownOnly: 'Пожалуйста, поделитесь именно своим номером (кнопкой ниже).',
  },
};
const LANGS = ['uz', 'uzc', 'ru'];
// Tugma matnlari qaysi tilda bo'lsa ham taniladi (mijoz tilni o'zgartirgan bo'lishi mumkin)
const isBtn = (text, key) => LANGS.some((l) => T[l][key] === text);

const hhmm = (d) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tashkent', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
const esc = (s) => String(s ?? '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

async function say(chatId, text, extra = {}) {
  try {
    await tgCall('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...extra });
  } catch (e) {
    console.error('[tgLink] bot xabari yuborilmadi:', e.message);
  }
}

const normPhone = (raw) => {
  const d = String(raw || '').replace(/\D/g, '');
  return d.length >= 9 && d.length <= 15 ? `+${d}` : '';
};

/** Shu Telegram foydalanuvchisining eng so'nggi KUTAYOTGAN so'rovi (havolani u ochgan) */
async function pendingFor(tgId, now) {
  return TgLoginRequest.findOne({ 'tgUser.id': String(tgId), status: 'pending', expiresAt: { $gt: now } }).sort({ createdAt: -1 });
}

/* ───────────── 4) Bot: /start login_<code> ───────────── */
export async function handleLoginStart(message, code, now = new Date()) {
  const chatId = message.chat.id;
  const from = message.from || {};
  const lang0 = LANGS.includes(from.language_code) ? from.language_code : (from.language_code === 'ru' ? 'ru' : 'uz');
  if (!validCode(code)) { await say(chatId, T[lang0].expired); return true; }

  const reqDoc = await TgLoginRequest.findOne({ code });
  const L = T[reqDoc?.lang || lang0];
  if (!reqDoc || reqDoc.status !== 'pending' || reqDoc.expiresAt <= now) { await say(chatId, L.expired); return true; }

  // Havolani ochgan foydalanuvchini yozib qo'yamiz (tasdiqlash KEYIN, uning o'z tugmasi bilan)
  await TgLoginRequest.updateOne({ _id: reqDoc._id, status: 'pending' }, {
    $set: { tgUser: { id: String(from.id), first_name: from.first_name, last_name: from.last_name, username: from.username, language_code: from.language_code, is_premium: from.is_premium } },
  });
  await say(chatId,
    `${L.title}\n\n📍 ${esc(L.device[reqDoc.platform] || L.device.web)} · ${hhmm(now)}\n\n${L.prompt}\n<i>${L.notYou}</i>`,
    {
      reply_markup: {
        keyboard: [[{ text: L.share, request_contact: true }], [{ text: L.noPhone }, { text: L.cancel }]],
        resize_keyboard: true, one_time_keyboard: true,
      },
    });
  return true;
}

async function confirm(reqDoc, phone, now) {
  const r = await TgLoginRequest.updateOne(
    { _id: reqDoc._id, status: 'pending', expiresAt: { $gt: now } },
    { $set: { status: 'confirmed', confirmedAt: now, phone: phone || '' } },
  );
  return Boolean(r.modifiedCount ?? r.nModified ?? 1);
}

/* ───────────── 5) Bot: kontakt (telefon) ───────────── */
export async function handleLoginContact(message, now = new Date()) {
  const from = message.from || {};
  const reqDoc = await pendingFor(from.id, now);
  if (!reqDoc) return false; // bu bizning oqim emas
  const L = T[reqDoc.lang];
  const contact = message.contact || {};
  // Faqat O'ZINING raqami: boshqa odamning kontaktini ulashib "tasdiqlab" bo'lmaydi
  if (String(contact.user_id) !== String(from.id)) { await say(message.chat.id, L.ownOnly); return true; }
  await confirm(reqDoc, normPhone(contact.phone_number), now);
  await say(message.chat.id, L.done, { reply_markup: { remove_keyboard: true } });
  return true;
}

/* ───────────── 6) Bot: "Raqamsiz kirish" / "Bekor qilish" ───────────── */
export async function handleLoginText(message, now = new Date()) {
  const text = String(message.text || '');
  const noPhone = isBtn(text, 'noPhone');
  const cancel = isBtn(text, 'cancel');
  if (!noPhone && !cancel) return false;
  const reqDoc = await pendingFor(message.from?.id, now);
  if (!reqDoc) return false;
  const L = T[reqDoc.lang];
  if (cancel) {
    await TgLoginRequest.updateOne({ _id: reqDoc._id, status: 'pending' }, { $set: { status: 'cancelled' } });
    await say(message.chat.id, L.cancelled, { reply_markup: { remove_keyboard: true } });
    return true;
  }
  await confirm(reqDoc, '', now);
  await say(message.chat.id, L.done, { reply_markup: { remove_keyboard: true } });
  return true;
}
