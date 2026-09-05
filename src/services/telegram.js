import { config } from '../config/index.js';

const TG_API = `https://api.telegram.org/bot${config.telegramBotToken}`;

/*
 * ═══ MINI APP DEEP LINK — markaziy joy ═══
 *
 * MUAMMO: Telegram'da tugma ikki XIL turda bo'ladi va ular
 * chalkashtirilgan edi:
 *
 *   web_app: { url: 'https://lokma.uz' }
 *     → Mini App sifatida ochiladi (Telegram ichida, WebView).
 *     → LEKIN faqat SHAXSIY chatda ishlaydi. Guruhga bunday
 *       tugma yuborishga Telegram Bot API o'zi yo'l qo'ymaydi.
 *
 *   url: 'https://lokma.uz'
 *     → Guruhda ham ishlaydi, LEKIN oddiy tashqi havola —
 *       Telegram uni brauzerda ochadi ("Открыть в браузере"),
 *       Mini App emas. Aynan shu www.lokma.uz kabi oddiy
 *       manzil guruh promo tugmasida va referal tugmasida
 *       ishlatilgani uchun ular BRAUZERDA ochilardi.
 *
 *   url: 'https://t.me/BOT_USERNAME/APP_NAME?startapp=...'
 *     → Bu UCHINCHI, to'g'ri yo'l: t.me domenidagi maxsus
 *       deep link. Oddiy `url` turidagi tugmada ham ishlaydi
 *       (ya'ni GURUHDA ham) VA Telegram buni avtomatik
 *       ravishda Mini App sifatida ochadi — chunki bu link
 *       t.me domeniga tegishli va Telegram klienti buni
 *       maxsus tan oladi.
 *
 * Xulosa: guruhga/referalga yuboriladigan HAR QANDAY tugma
 * shu funksiyadan olingan link bilan, `url:` turida
 * (web_app EMAS) yuborilishi kerak.
 */
let cachedBotUsername = null;

async function getBotUsername() {
  if (cachedBotUsername) return cachedBotUsername;
  try {
    const r = await fetch(`${TG_API}/getMe`);
    const d = await r.json();
    if (d.ok && d.result?.username) {
      cachedBotUsername = d.result.username;
      return cachedBotUsername;
    }
  } catch { /* pastdagi zaxiraga o'tamiz */ }
  return config.botUsername;
}

/**
 * Mini App'ga to'g'ridan-to'g'ri ochiladigan deep link.
 *
 * Format: https://t.me/{bot}?startapp={param} — SHORT NAME
 * (config.webappName, ilgari "/lokmago" bo'lib qo'shilardi)
 * QISMISIZ. Bot BotFather'da "Menu Button" orqali BITTA
 * asosiy Web App'ga bog'langan bo'lsa, Telegram short name
 * ko'rsatilmasa ham to'g'ri Web App'ni avtomatik ochadi —
 * so'ralgan aniq format shu.
 *
 * TO'LIQ EKRAN — `mode=fullscreen`
 * Telegram hujjati (core.telegram.org/api/bots/webapps): Mini App
 * havolasidagi `mode` parametri compact/fullscreen bo'lsa, klient
 * ilovani AYNAN SHU rejimda ochadi. Bu runtime'dagi
 * requestFullscreen() dan MUHIM FARQ QILADI:
 *
 *   requestFullscreen() — ilova ALLAQACHON ochilgandan keyin
 *     rejimni o'zgartirishni SO'RAYDI. Telegram uni rad etishi
 *     yoki e'tiborsiz qoldirishi mumkin (bizda aynan shunday
 *     bo'ldi), va hatto ishlaganda ham foydalanuvchi avval
 *     oddiy oynani, keyin sakrashni ko'radi.
 *
 *   mode=fullscreen — rejim OCHILISHDAN OLDIN, klient darajasida
 *     belgilanadi. Ilova birinchi kadrdanoq (splash paytidayoq)
 *     to'liq ekranda chiziladi, hech qanday sakrash yo'q.
 *
 * @param {string} [startParam] - ixtiyoriy: qaysi ekran/taom
 *   bilan ochilsin (masalan 'food_123'). Berilmasa ilova
 *   oddiy bosh sahifadan ochiladi.
 */
export async function buildMiniAppLink(startParam) {
  const username = await getBotUsername();
  const base = `https://t.me/${username}`;
  const start = startParam ? `?startapp=${startParam}` : '?startapp';
  return `${base}${start}&mode=fullscreen`;
}

// Foydalanuvchiga push xabar yuborish (buyurtma statusi, bron tasdiqi)
export async function notifyUser(telegramId, text) {
  if (!config.telegramBotToken) {
    return;
  }
  try {
    await fetch(`${TG_API}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: telegramId,
        text,
        parse_mode: 'HTML'
      })
    });
  } catch (err) {
    console.error('Telegram xabar xatosi:', err);
  }
}

// WebApp tugmasi bilan xabar (ilovani ochish)
export async function sendWebAppButton(telegramId, webAppUrl) {
  if (!config.telegramBotToken) return;
  await fetch(`${TG_API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: telegramId,
      text: 'LokmaGo — restoran va kafelar. Buyurtma bering, stol bron qiling!',
      reply_markup: {
        inline_keyboard: [[{ text: '🍽 Ilovani ochish', web_app: { url: webAppUrl } }]]
      }
    })
  });
}

// Bot webhook update'ini qayta ishlash (/start buyrug'i)








// Bot webhook update'ini qayta ishlash
export async function handleBotUpdate(update) {
  // 1) Bot guruhга admin qilinganини aniqlash (my_chat_member event)
  if (update.my_chat_member) {
    const { chat, new_chat_member, old_chat_member } = update.my_chat_member;
    const status = new_chat_member?.status;
    const prevStatus = old_chat_member?.status;

    // Faqat guruh/superguruh (shaxsiy chat emas)
    if (chat?.type !== 'group' && chat?.type !== 'supergroup') return;

    try {
      const { onBotPromotedToAdmin, registerGroup } = await import('./telegramGroup.js');
      const { GroupChat } = await import('../models/GroupChat.js');

      if (status === 'administrator' || status === 'creator') {
        // Bot admin qilindi — darhol reklama yuborib pin qilamiz
        await onBotPromotedToAdmin(chat);
      } else if (status === 'member') {
        // Bot qo'shildi, lekin admin emas — yozib qo'yamiz.
        // Keyin admin qilinsa my_chat_member yana keladi.
        await registerGroup(chat, false);
      } else if (status === 'left' || status === 'kicked') {
        await GroupChat.findOneAndUpdate(
          { chatId: String(chat.id) },
          { isActive: false, isBotAdmin: false },
        );
      }
    } catch (e) {
      console.error('[bot] guruh xatosi:', e.message, e.stack);
    }
    return;
  }

  // 2) Callback tugmalar
  // Inline so'rov — taomni rasm bilan ulashish
  if (update.inline_query) {
    const { handleInlineQuery } = await import('./inlineShare.js');
    await handleInlineQuery(update.inline_query).catch((e) =>
      console.error('[inline]', e.message));
    return;
  }

  if (update.callback_query) {
    const data = update.callback_query.data || '';
    try {
      // Obuna tasdiqlash
      if (data === 'check_sub') {
        const { handleCheckSubscription } = await import('./referralStart.js');
        await handleCheckSubscription(update.callback_query);
        return;
      }
      // Bron javoblari (boramiz / bora olmaymiz / yo'ldamiz / keldik)
      if (data.startsWith('resv_')) {
        const { handleReservationResponse } = await import('./reservationReminder.js');
        await handleReservationResponse(update.callback_query);
        return;
      }
      // Yetkazish tasdiqlash (oldim / hali olmadim)
      if (data.startsWith('dlv_')) {
        const { handleDeliveryResponse } = await import('./deliveryCheck.js');
        await handleDeliveryResponse(update.callback_query);
        return;
      }
      // Baho (yulduzlar)
      if (data.startsWith('rate_')) {
        const { handleRatingResponse } = await import('./deliveryCheck.js');
        await handleRatingResponse(update.callback_query);
        return;
      }
      // Izohsiz yuborish
      if (data.startsWith('cmt_')) {
        const { handleCommentSkip } = await import('./deliveryCheck.js');
        await handleCommentSkip(update.callback_query);
        return;
      }
      // Asosiy menyu tugmalari
      if (data.startsWith('menu_')) {
        const { handleMenuCallback } = await import('./botMenu.js');
        await handleMenuCallback(update.callback_query);
        return;
      }
    } catch (e) {
      console.error('[bot] callback xatosi:', e.message);
    }
    return;
  }

  // 3) Oddiy xabarlar (/start yoki /start ref_<id>)
  const message = update.message;
  if (!message?.text) return;

  // Oddiy matn — baho izohi bo'lishi mumkin
  if (!message.text.startsWith('/')) {
    try {
      const { handleReviewText } = await import('./deliveryCheck.js');
      const handled = await handleReviewText(String(message.chat.id), message.text);
      if (handled) return;
    } catch (e) {
      console.error('[bot] izoh xatosi:', e.message);
    }
  }

  if (message.text.startsWith('/start')) {
    const telegramId = String(message.chat.id);
    // Referal kodni ajratamiz: "/start ref_123"
    const parts = message.text.split(' ');
    const startParam = parts[1] || '';

    try {
      const { handleStartCommand } = await import('./referralStart.js');
      await handleStartCommand(telegramId, startParam, message.from);
    } catch (e) {
      // Xato jim yutilmasin — logga yozamiz va mijozga xabar beramiz
      console.error('[bot] /start xatosi:', e.message, e.stack);
      await sendPlainMessage(telegramId,
        'Kechirasiz, texnik nosozlik. Bir ozdan keyin /start ni qayta bosing.');
    }
  }
}

// Oddiy matnli xabar (xato holatlari uchun)
async function sendPlainMessage(chatId, text) {
  if (!config.telegramBotToken) return;
  try {
    await fetch(`https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
  } catch { /* jim */ }
}
