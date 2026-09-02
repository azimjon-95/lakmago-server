import { config } from '../config/index.js';
import { GroupChat } from '../models/GroupChat.js';
import { buildMiniAppLink } from './telegram.js';

const TG_API = `https://api.telegram.org/bot${config.telegramBotToken}`;

// Reklama matni — chiroyli, ishtaha ochadigan
function promoText() {
  return (
    '🍽 <b>LokmaGo</b> — shirin va mazali taomlar!\n\n' +
    '🔥 Eng sara restoran, choyxona va kafelardan\n' +
    '⚡️ Tez va issiq yetkazib berish\n' +
    '💳 Qulay to‘lov, jonli kuzatuv\n\n' +
    '👇 Buyurtma berish uchun tugmani bosing:'
  );
}

/*
 * XATO EDI: `url: config.webappUrl` = oddiy https://lokma.uz.
 * Guruhda web_app tugma turi ishlamaydi (Telegram taqiqlaydi),
 * shuning uchun oddiy `url` ishlatilgan — TO'G'RI qaror, lekin
 * QIYMATI noto'g'ri edi: oddiy sayt manzili Telegram tomonidan
 * brauzerda ochiladi, Mini App sifatida emas.
 *
 * t.me/BOT/APP?startapp ko'rinishidagi deep link esa `url`
 * turida ham ishlaydi (guruhda ham) VA Mini App sifatida
 * ochiladi — Telegram buni maxsus tan oladi (services/telegram.js).
 */
async function promoKeyboard() {
  return {
    inline_keyboard: [[
      { text: '🍽 Buyurtma berish', url: await buildMiniAppLink() },
    ]],
  };
}

async function tg(method, body) {
  const res = await fetch(`${TG_API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`${method}: ${data.description}`);
  return data.result;
}

// Bot guruhда adminmi? (pin qilish uchun admin bo'lishi shart)
export async function checkBotIsAdmin(chatId) {
  if (!config.telegramBotToken) return false;
  try {
    const me = await tg('getMe', {});
    const member = await tg('getChatMember', { chat_id: chatId, user_id: me.id });
    return ['administrator', 'creator'].includes(member.status);
  } catch {
    return false;
  }
}

// Reklama xabarini yuborish + pin qilish. Guruh yozuvини yangilaydi.
export async function sendAndPinPromo(chatId) {
  if (!config.telegramBotToken) {
    return null;
  }

  // Xabarni yuboramiz
  const msg = await tg('sendMessage', {
    chat_id: chatId,
    text: promoText(),
    parse_mode: 'HTML',
    reply_markup: await promoKeyboard(),
    disable_web_page_preview: true,
  });

  // Tepaga pin qilamiz (bildirishnomasiz)
  let pinned = false;
  try {
    await tg('pinChatMessage', { chat_id: chatId, message_id: msg.message_id, disable_notification: true });
    pinned = true;
  } catch (e) {
    // Eng ko'p uchraydigan sabab: botda "Pin messages" huquqi yo'q
    const hint = /not enough rights|CHAT_ADMIN_REQUIRED/i.test(e.message)
      ? ' → Botga "Xabarlarni mahkamlash" (Pin messages) huquqini bering'
      : '';
    console.warn(`[bot] ${chatId} — pin qilib bo'lmadi: ${e.message}${hint}`);
  }

  await GroupChat.findOneAndUpdate(
    { chatId: String(chatId) },
    { promoMessageId: msg.message_id, promoSentAt: new Date(), isPinned: pinned, isBotAdmin: true, lastCheckedAt: new Date() },
    { upsert: true },
  );

  return msg.message_id;
}

// Guruhni bazaga yozish/yangilash (admin bo'lsa ham, bo'lmasa ham).
export async function registerGroup(chat, isBotAdmin) {
  const chatId = String(chat.id);
  const group = await GroupChat.findOneAndUpdate(
    { chatId },
    {
      $set: {
        title: chat.title || '',
        type: chat.type || 'group',
        isBotAdmin,
        isActive: true,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  return group;
}

// Bot guruhga admin qilinganda chaqiriladi (my_chat_member event).
// Darhol reklama yuboradi va pin qiladi.
export async function onBotPromotedToAdmin(chat) {
  const chatId = String(chat.id);
  const group = await registerGroup(chat, true);

  // Reklama hali yuborilmagan bo'lsa — darhol yuboramiz va pin qilamiz
  if (!group.promoMessageId) {
    try {
      const msgId = await sendAndPinPromo(chatId);
    } catch (e) {
      console.error(`[bot] "${chat.title}" — promo XATOSI:`, e.message);
      throw e;
    }
  }

  // Adminlarga xabar beramiz (yangi guruh qo'shildi)
  try {
    const { getIO } = await import('../sockets/io.js');
    getIO()?.to('admin').emit('group:new', {
      chatId,
      title: chat.title || '',
      type: chat.type,
      isBotAdmin: true,
    });
  } catch { /* socket ishlamasa ham davom etamiz */ }

  return group;
}

// Xabar hali ham pin turibdimi tekshirish
async function isStillPinned(chatId, messageId) {
  try {
    const chat = await tg('getChat', { chat_id: chatId });
    return chat.pinned_message?.message_id === messageId;
  } catch {
    return false;
  }
}

/*
 * ═══ ESKI XABARLARDAGI TUGMANI YANGILASH ═══
 *
 * MUHIM TOPILMA: dailyGroupCheck() va onBotPromotedToAdmin()
 * `group.promoMessageId` mavjud bo'lsa YANGI XABAR HECH QACHON
 * YUBORMAYDI — faqat pin holatini tekshiradi. Ya'ni promoText()
 * yoki promoKeyboard() ichidagi o'zgarish (masalan link formati
 * tuzatilishi) FAQAT yangi guruhlarga ta'sir qiladi — avgustda
 * (yoki undan oldin) yuborilgan xabarlar ESKI holicha, eski
 * (noto'g'ri) tugma bilan abadiy qolib ketardi.
 *
 * Bu funksiya xabarni O'CHIRIB QAYTA YUBORMAYDI (bu pin holatini
 * yo'qotardi, guruh a'zolariga bildirishnoma ketardi) — faqat
 * `editMessageReplyMarkup` bilan TUGMANI YANGILAYDI. Matn,
 * pin, xabar ID — hech biri o'zgarmaydi, mijoz hech narsa
 * sezmaydi, faqat tugma bosilganda endi to'g'ri ishlaydi.
 *
 * Bir martalik migratsiya sifatida ishlatiladi (admin panel
 * yoki bir marta qo'lda chaqirish orqali) — kod tuzatilgach
 * BARCHA mavjud guruhdagi eski xabarlarni to'g'irlash uchun.
 */
export async function refreshPromoButton(chatId, messageId) {
  await tg('editMessageReplyMarkup', {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: await promoKeyboard(),
  });
}

/**
 * Barcha faol guruhlardagi promo tugmasini yangilaydi.
 * Xabar yuborilmagan guruh (promoMessageId yo'q) — o'tkazib
 * yuboriladi, chunki onBotPromotedToAdmin() uni baribir to'g'ri
 * (yangi) link bilan yuboradi.
 */
export async function refreshAllPromoButtons() {
  const groups = await GroupChat.find({ isActive: true, promoMessageId: { $ne: null } });
  let fixed = 0;
  let failed = 0;

  for (const group of groups) {
    try {
      await refreshPromoButton(group.chatId, group.promoMessageId);
      fixed++;
    } catch (e) {
      failed++;
      /*
       * Eng ko'p uchraydigan sabab: xabar o'chirilgan yoki
       * "message is not modified" (agar tugma ALLAQACHON
       * to'g'ri bo'lsa — bu XATO EMAS, shunchaki hech narsa
       * o'zgarmagani uchun Telegram rad etadi).
       */
      if (!/message is not modified/i.test(e.message)) {
        console.warn(`[bot] ${group.chatId} — tugma yangilanmadi: ${e.message}`);
      } else {
        fixed++; failed--;   // aslida allaqachon to'g'ri edi — muvaffaqiyat hisoblanadi
      }
    }
  }

  return { total: groups.length, fixed, failed };
}

// KUNLIK TEKSHIRUV — barcha faol guruhlarni ko'rib chiqadi:
//   - reklama yuborilmaган bo'lsa → yuboradi + pin
//   - yuborilган lekin pin yo'qolган bo'lsa → qayta pin qiladi (yoki qayta yuboradi)
export async function dailyGroupCheck() {
  if (!config.telegramBotToken) {
    return { checked: 0, fixed: 0 };
  }

  const groups = await GroupChat.find({ isActive: true });
  let fixed = 0;

  for (const group of groups) {
    try {
      // Bot hali ham adminmi?
      const isAdmin = await checkBotIsAdmin(group.chatId);
      group.isBotAdmin = isAdmin;
      group.lastCheckedAt = new Date();

      if (!isAdmin) {
        // Admin emas — pin qila olmaymiz, keyingi safar
        await group.save();
        continue;
      }

      // Reklama umuman yuborilmaган → yuboramiz
      if (!group.promoMessageId) {
        await sendAndPinPromo(group.chatId);
        fixed++;
        continue;
      }

      // Yuborilган — pin hali turibdimi?
      const pinned = await isStillPinned(group.chatId, group.promoMessageId);
      if (!pinned) {
        // Pin yo'qolган — qayta pin qilishga urinamiz
        try {
          await tg('pinChatMessage', { chat_id: group.chatId, message_id: group.promoMessageId, disable_notification: true });
          group.isPinned = true;
          fixed++;
        } catch {
          // Eski xabar o'chirilган bo'lishi mumkin — yangisini yuboramiz
          await sendAndPinPromo(group.chatId);
          fixed++;
        }
      } else {
        group.isPinned = true;
      }
      await group.save();
    } catch (e) {
      console.error(`Guruh tekshiruv xatosi (${group.chatId}):`, e.message);
    }
  }

  return { checked: groups.length, fixed };
}

// ===== MOSLASHUVCHAN REKLAMA (admin paneldan) =====
// Admin istalgan guruhga istalgan reklama yuboradi:
//   - matn + rasm + tugma
//   - faqat matn + tugma
//   - faqat rasm (+ izoh)
//   - faqat matn
// Telegram formatiga to'liq mos (sendPhoto yoki sendMessage tanlanadi).
//
// opts = {
//   chatId,               // qaysi guruhga
//   text,                 // matn (HTML) — ixtiyoriy
//   imageUrl,             // rasm URL — ixtiyoriy
//   buttonText, buttonUrl,// tugma — ixtiyoriy (ikkalasi birga)
//   pin,                  // true bo'lsa yuborilgach pin qiladi
// }
export async function sendCustomBroadcast(opts) {
  const { chatId, text = '', imageUrl = '', buttonText = '', buttonUrl = '', pin = false } = opts;

  if (!config.telegramBotToken) {
    return { ok: true, demo: true };
  }
  if (!chatId) throw new Error('chatId kerak');
  if (!text && !imageUrl) throw new Error('Matn yoki rasm bo‘lishi shart');

  // Tugma (agar berilgan bo'lsa)
  const keyboard = (buttonText && buttonUrl)
    ? { inline_keyboard: [[{ text: buttonText, url: buttonUrl }]] }
    : undefined;

  let msg;
  if (imageUrl) {
    // Rasm bilan — sendPhoto (matn caption bo'ladi, 1024 belgigacha)
    msg = await tg('sendPhoto', {
      chat_id: chatId,
      photo: imageUrl,
      caption: text || undefined,
      parse_mode: text ? 'HTML' : undefined,
      reply_markup: keyboard,
    });
  } else {
    // Faqat matn — sendMessage
    msg = await tg('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      reply_markup: keyboard,
      disable_web_page_preview: true,
    });
  }

  // So'ralса pin qilamiz
  let pinned = false;
  if (pin) {
    try {
      await tg('pinChatMessage', { chat_id: chatId, message_id: msg.message_id, disable_notification: true });
      pinned = true;
    } catch (e) {
      console.warn(`Pin xatosi (${chatId}):`, e.message);
    }
  }

  return { ok: true, messageId: msg.message_id, pinned };
}
