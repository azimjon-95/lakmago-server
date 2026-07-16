import { config } from '../config/index.js';
import { GroupChat } from '../models/GroupChat.js';

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

// WebApp tugmasi (guruhда inline URL tugma — web_app guruhда ishlamaydi, shuning uchun URL)
function promoKeyboard() {
  return {
    inline_keyboard: [[
      { text: '🍽 Buyurtma berish', url: config.webappUrl },
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
    console.log(`[telegram demo] guruh ${chatId}ga reklama yuborilardi`);
    return null;
  }

  // Xabarni yuboramiz
  const msg = await tg('sendMessage', {
    chat_id: chatId,
    text: promoText(),
    parse_mode: 'HTML',
    reply_markup: promoKeyboard(),
    disable_web_page_preview: true,
  });

  // Tepaga pin qilamiz (bildirishnomasiz)
  let pinned = false;
  try {
    await tg('pinChatMessage', { chat_id: chatId, message_id: msg.message_id, disable_notification: true });
    pinned = true;
  } catch (e) {
    console.warn(`Pin qilib bo‘lmadi (${chatId}):`, e.message);
  }

  await GroupChat.findOneAndUpdate(
    { chatId: String(chatId) },
    { promoMessageId: msg.message_id, promoSentAt: new Date(), isPinned: pinned, isBotAdmin: true, lastCheckedAt: new Date() },
    { upsert: true },
  );

  return msg.message_id;
}

// Bot guruhga admin qilinganда chaqiriladi (my_chat_member event).
// Bir marta reklama yuboradi (agar hali yuborilmagan bo'lsa).
export async function onBotPromotedToAdmin(chat) {
  const chatId = String(chat.id);
  let group = await GroupChat.findOne({ chatId });

  // Yozuv yaratamiz/yangilaymiz
  if (!group) {
    group = await GroupChat.create({
      chatId,
      title: chat.title || '',
      type: chat.type || 'group',
      isBotAdmin: true,
      isActive: true,
    });
  } else {
    group.isBotAdmin = true;
    group.isActive = true;
    group.title = chat.title || group.title;
    await group.save();
  }

  // Reklama hali yuborilmaган bo'lsa — yuboramiz va pin qilamiz (bir marta)
  if (!group.promoMessageId) {
    await sendAndPinPromo(chatId);
  }
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

// KUNLIK TEKSHIRUV — barcha faol guruhlarni ko'rib chiqadi:
//   - reklama yuborilmaган bo'lsa → yuboradi + pin
//   - yuborilган lekin pin yo'qolган bo'lsa → qayta pin qiladi (yoki qayta yuboradi)
export async function dailyGroupCheck() {
  if (!config.telegramBotToken) {
    console.log('[telegram demo] kunlik guruh tekshiruvi (token yo‘q)');
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

  console.log(`✓ Kunlik guruh tekshiruvi: ${groups.length} guruh, ${fixed} tuzatildi`);
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
    console.log(`[telegram demo] guruh ${chatId}ga maxsus reklama yuborilardi`);
    return { ok: true, demo: true };
  }
  if (!chatId) throw new Error('chatId kerak');
  if (!text && !imageUrl) throw new Error('Matn yoki rasm bo\u2018lishi shart');

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
