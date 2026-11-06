import { config } from '../config/index.js';
import { GroupChat } from '../models/GroupChat.js';
import { buildMiniAppLink } from './telegram.js';
import { tgCall, tgUpload } from './telegramApi.js';

const TG_API = `${config.telegramApiBase}/bot${config.telegramBotToken}`;

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
  const isChannel = chat.type === 'channel';
  const group = await GroupChat.findOneAndUpdate(
    { chatId },
    {
      $set: {
        title: chat.title || '',
        type: chat.type || 'group',
        kind: isChannel ? 'channel' : 'group',
        isBotAdmin,
        isActive: true,
      },
      // Kanalga avval hech narsa yuborilmagan — standart holda umumiy reklama O'CHIQ (faqat restoran biriktirilsa pin)
      $setOnInsert: { adsEnabled: !isChannel },
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

  if (group.restaurantId) {
    // RESTORAN guruhi/kanali (qayta admin qilindi) — restoran pini tiklanadi, umumiy promo YUBORILMAYDI
    await ensureRestaurantPin(group).catch((e) => console.error(`[bot] "${chat.title}" — restoran pini xatosi:`, e.message));
  } else if (group.kind === 'channel') {
    // Kanal: umumiy promo avtomatik yuborilmaydi (avvalgidek) — admin restoran biriktirsa pin qilinadi
  } else if (!group.promoMessageId) {
    // UMUMIY guruh: reklama hali yuborilmagan bo'lsa — darhol yuboramiz va pin qilamiz (o'zgarishsiz)
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
  const groups = await GroupChat.find({ isActive: true, promoMessageId: { $ne: null }, restaurantId: null });   // restoran guruhlariga tegilmaydi
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

      // RESTORAN guruhi/kanali: faqat restoran pini tekshiriladi (umumiy promo bu yerga YUBORILMAYDI)
      if (group.restaurantId) {
        await group.save();
        if (await ensureRestaurantPin(group)) fixed++;
        continue;
      }
      // Kanal (restoransiz): umumiy promo avtomatik yuborilmaydi
      if (group.kind === 'channel') { await group.save(); continue; }

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
//   - media (RASM yoki VIDEO) + matn + tugma
//   - faqat matn + tugma
//   - faqat media (+ izoh)
// Xabar tartibi: Media → Matn (HTML) → Tugma → Pin (tanlansa).
//
// opts = {
//   chatId,                 // qaysi guruhga
//   text,                   // matn (HTML) — ixtiyoriy
//   imageUrl,               // rasm URL — ixtiyoriy
//   video,                  // { buffer, filename, mimetype } — XOTIRADAGI fayl, ixtiyoriy
//   videoFileId,            // oldin yuklangan video (Telegram file_id) — ko'p guruhga yuborishda
//   videoMethod,            // videoFileId qaysi usul bilan yuborilgan ('sendVideo' | 'sendDocument')
//   buttonText, buttonUrl,  // tugma — ixtiyoriy (ikkalasi birga)
//   pin,                    // true bo'lsa yuborilgach pin qiladi
// }
//
// VIDEO BAZAGA SAQLANMAYDI: fayl faqat so'rov davomida xotirada (multer
// memoryStorage) turadi va shu yerdan to'g'ridan-to'g'ri Telegram'ga
// uzatiladi; diskka ham, MongoDB'ga ham, Cloudinary'ga ham yozilmaydi.
// Bir nechta guruhga yuborilganda FAYL BIR MARTA yuklanadi: Telegram qaytargan
// file_id keyingi guruhlarga ishlatiladi (tez, trafik tejaladi).

/** Telegram izoh (caption) chegarasi — TEGLARSIZ 1024 belgi. */
const CAPTION_LIMIT = 1024;

/** HTML matnning ko'rinadigan uzunligi (teglar tashlanadi, &lt; kabilar 1 belgi). */
export function visibleLength(html) {
  return String(html || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&(lt|gt|amp|quot|#39);/g, '.')
    .length;
}

export async function sendCustomBroadcast(opts) {
  const {
    chatId, text = '', imageUrl = '', video = null, videoFileId = '', videoMethod = 'sendVideo',
    buttonText = '', buttonUrl = '', pin = false,
  } = opts;

  if (!config.telegramBotToken) {
    return { ok: true, demo: true };
  }
  if (!chatId) throw new Error('chatId kerak');
  const hasVideo = Boolean(video || videoFileId);
  if (!text && !imageUrl && !hasVideo) throw new Error('Matn, rasm yoki video bo‘lishi shart');
  if (imageUrl && hasVideo) throw new Error('Rasm yoki video — bittasini tanlang');

  // Tugma (agar berilgan bo'lsa)
  const keyboard = (buttonText && buttonUrl)
    ? { inline_keyboard: [[{ text: buttonText, url: buttonUrl }]] }
    : undefined;

  const hasMedia = Boolean(imageUrl) || hasVideo;
  /*
   * Izoh 1024 belgidan uzun bo'lsa Telegram butun so'rovni rad etardi
   * ("message caption is too long") — reklama umuman ketmasdi. Endi media
   * izohsiz yuboriladi, matn va tugma esa uning ortidan alohida xabarda.
   */
  const splitText = hasMedia && Boolean(text) && visibleLength(text) > CAPTION_LIMIT;
  const caption = hasMedia && !splitText && text ? text : undefined;
  const mediaKeyboard = hasMedia && !splitText ? keyboard : undefined;

  let msg;
  let out = {};
  if (hasVideo) {
    const base = { chat_id: chatId, caption, parse_mode: caption ? 'HTML' : undefined, reply_markup: mediaKeyboard, supports_streaming: true };
    if (video) {
      msg = await tgUpload(
        'sendVideo', base,
        { field: 'video', blob: new Blob([video.buffer], { type: video.mimetype || 'video/mp4' }), filename: video.filename || 'video.mp4' },
      );
      // Telegram mp4 bo'lmagan faylni hujjat sifatida qabul qilishi mumkin — qayta ishlatish shunga mos
      const asVideo = Boolean(msg.video);
      out = { videoFileId: (msg.video || msg.document)?.file_id, videoMethod: asVideo ? 'sendVideo' : 'sendDocument' };
    } else if (videoMethod === 'sendDocument') {
      msg = await tgCall('sendDocument', { chat_id: chatId, document: videoFileId, caption, parse_mode: caption ? 'HTML' : undefined, reply_markup: mediaKeyboard });
      out = { videoFileId, videoMethod };
    } else {
      msg = await tgCall('sendVideo', { ...base, video: videoFileId });
      out = { videoFileId, videoMethod: 'sendVideo' };
    }
  } else if (imageUrl) {
    // Rasm bilan — sendPhoto (matn caption bo'ladi, 1024 belgigacha)
    msg = await tgCall('sendPhoto', {
      chat_id: chatId,
      photo: imageUrl,
      caption,
      parse_mode: caption ? 'HTML' : undefined,
      reply_markup: mediaKeyboard,
    });
  } else {
    // Faqat matn — sendMessage
    msg = await tgCall('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      reply_markup: keyboard,
      disable_web_page_preview: true,
    });
  }

  // Uzun matn: media ortidan alohida xabar (tugma shu xabarda)
  let textMessageId;
  if (splitText) {
    const t = await tgCall('sendMessage', {
      chat_id: chatId, text, parse_mode: 'HTML', reply_markup: keyboard, disable_web_page_preview: true,
    });
    textMessageId = t.message_id;
  }

  // So'ralса pin qilamiz (post = birinchi xabar: media, yoki oddiy matn)
  let pinned = false;
  if (pin) {
    try {
      await tgCall('pinChatMessage', { chat_id: chatId, message_id: msg.message_id, disable_notification: true });
      pinned = true;
    } catch (e) {
      console.warn(`Pin xatosi (${chatId}):`, e.message);
    }
  }

  return { ok: true, messageId: msg.message_id, textMessageId, pinned, captionSplit: splitText, ...out };
}


/* ═══════════════════════════════════════════════════════════════
 * RESTORAN GURUHI / KANALI (2026-11)
 * ═══════════════════════════════════════════════════════════════
 * Admin guruh yoki kanalga restoran biriktiradi → bot restoran nomi va tugmani yuborib TEPAGA pin qiladi.
 * Tugma `t.me/<bot>?startapp=rest_<id>` — Mini App to'g'ridan-to'g'ri SHU restoran sahifasida ochiladi
 * (mijoz ilovasi: lib/telegram.js getStartParam). Umumiy LokmaGo promo bu chatga pin qilinmaydi va (standart) reklama ketmaydi.
 * Kunlik tekshiruv (dailyGroupCheck) pin yo'qolsa qayta pin qiladi, xabar o'chirilgan bo'lsa yangisini yuboradi.
 */

const escHtml = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Restoran pini mazmuni (sof funksiya — tests/group-restaurant.test.mjs). */
export function restaurantPinContent(r, link) {
  const name = escHtml(r?.name || 'Restoran');
  const lines = [`🍽 <b>${name}</b>`];
  if (r?.cuisine) lines.push(`<i>${escHtml(r.cuisine)}</i>`);
  lines.push('', '📲 Menyu, narxlar va buyurtma — LokmaGo ilovasida', '⚡️ Tez yetkazib berish yoki olib ketish', '', '👇 Buyurtma berish uchun tugmani bosing:');
  const photo = r?.imageUrl || (Array.isArray(r?.images) ? r.images.find(Boolean) : '') || '';
  return {
    text: lines.join('\n'),
    photo: /^https?:\/\//i.test(photo) ? photo : '',
    keyboard: { inline_keyboard: [[{ text: `🍽 ${String(r?.name || 'Restoran').slice(0, 40)} — buyurtma berish`, url: link }]] },
  };
}

export const restaurantStartParam = (restaurantId) => `rest_${String(restaurantId)}`;

async function loadRestaurant(id) {
  const { Restaurant } = await import('../models/Restaurant.js');
  return Restaurant.findById(id).select('name cuisine imageUrl images isActive').lean();
}

/** Restoran xabarini yuboradi va pin qiladi. Umumiy promo pini olib tashlanadi (tepada restoran tursin). */
export async function sendAndPinRestaurant(group, restaurant) {
  if (!config.telegramBotToken) return { demo: true };
  const link = await buildMiniAppLink(restaurantStartParam(restaurant._id));
  const c = restaurantPinContent(restaurant, link);
  let msg;
  if (c.photo) {
    try {
      msg = await tg('sendPhoto', { chat_id: group.chatId, photo: c.photo, caption: c.text, parse_mode: 'HTML', reply_markup: c.keyboard });
    } catch (e) {
      console.warn(`[bot] ${group.chatId} — rasm yuborilmadi (${e.message}), matn bilan`);
    }
  }
  if (!msg) {
    msg = await tg('sendMessage', { chat_id: group.chatId, text: c.text, parse_mode: 'HTML', reply_markup: c.keyboard, disable_web_page_preview: true });
  }
  let isPinned = false; let error = '';
  try {
    await tg('pinChatMessage', { chat_id: group.chatId, message_id: msg.message_id, disable_notification: true });
    isPinned = true;
  } catch (e) {
    error = /not enough rights|CHAT_ADMIN_REQUIRED|rights/i.test(e.message)
      ? 'Botda "Xabarlarni mahkamlash" (Pin messages) huquqi yo‘q'
      : e.message;
  }
  // Umumiy LokmaGo promo pini olib tashlanadi — restoran guruhida tepada faqat restoran tursin (xabarning o'zi o'chirilmaydi)
  if (group.promoMessageId) {
    await tg('unpinChatMessage', { chat_id: group.chatId, message_id: group.promoMessageId }).catch(() => {});
  }
  // Eski restoran xabari (boshqa restoran yoki qayta yuborish) pinidan olinadi
  const prev = group.restaurantPin?.messageId;
  if (prev && prev !== msg.message_id) await tg('unpinChatMessage', { chat_id: group.chatId, message_id: prev }).catch(() => {});

  await GroupChat.updateOne({ chatId: String(group.chatId) }, {
    $set: {
      'restaurantPin.messageId': msg.message_id, 'restaurantPin.isPinned': isPinned, 'restaurantPin.pinnedAt': isPinned ? new Date() : null,
      'restaurantPin.error': error, isPinned: false, lastCheckedAt: new Date(),
    },
  });
  return { messageId: msg.message_id, isPinned, error };
}

/** Restoran pini joyidami? Yo'q bo'lsa qayta pin, xabar o'chirilgan bo'lsa yangisini yuboradi. true — tuzatildi. */
export async function ensureRestaurantPin(group) {
  const restaurant = await loadRestaurant(group.restaurantId);
  if (!restaurant) return false;
  const id = group.restaurantPin?.messageId;
  if (id && await isStillPinned(group.chatId, id)) {
    if (!group.restaurantPin.isPinned) await GroupChat.updateOne({ chatId: String(group.chatId) }, { $set: { 'restaurantPin.isPinned': true, 'restaurantPin.error': '' } });
    return false;
  }
  if (id) {
    try {
      await tg('pinChatMessage', { chat_id: group.chatId, message_id: id, disable_notification: true });
      await GroupChat.updateOne({ chatId: String(group.chatId) }, { $set: { 'restaurantPin.isPinned': true, 'restaurantPin.pinnedAt': new Date(), 'restaurantPin.error': '' } });
      return true;
    } catch { /* xabar o'chirilgan — yangisi yuboriladi */ }
  }
  await sendAndPinRestaurant(group, restaurant);
  return true;
}

export class GroupBindError extends Error {
  constructor(message, status = 400, code = 'BAD_REQUEST') { super(message); this.status = status; this.code = code; }
}

/**
 * Guruh/kanalga restoran biriktirish (`restaurantId`) yoki ajratish (null).
 *  • biriktirish: restoran pini yuboriladi va tepaga pin qilinadi; umumiy reklama O'CHIRILADI (adsEnabled=false; admin yoqishi mumkin).
 *  • ajratish: restoran pini olinadi; umumiy guruhda LokmaGo promo pini qaytariladi (kanalda — hech narsa).
 */
export async function bindGroupRestaurant(chatId, restaurantId, { adminId = '' } = {}) {
  const group = await GroupChat.findOne({ chatId: String(chatId) });
  if (!group) throw new GroupBindError('Guruh topilmadi', 404, 'NOT_FOUND');

  if (!restaurantId) {
    const prev = group.restaurantPin?.messageId;
    if (prev) await tg('unpinChatMessage', { chat_id: group.chatId, message_id: prev }).catch(() => {});
    await GroupChat.updateOne({ chatId: group.chatId }, {
      $set: { restaurantId: null, boundAt: null, boundBy: '', 'restaurantPin.isPinned': false, 'restaurantPin.messageId': null, 'restaurantPin.error': '' },
    });
    // Umumiy guruh: LokmaGo promo qayta tepaga (mavjud xabar pin qilinadi, bo'lmasa yangisi yuboriladi)
    if (group.kind !== 'channel' && group.isBotAdmin) {
      try {
        if (group.promoMessageId) await tg('pinChatMessage', { chat_id: group.chatId, message_id: group.promoMessageId, disable_notification: true });
        else await sendAndPinPromo(group.chatId);
        await GroupChat.updateOne({ chatId: group.chatId }, { $set: { isPinned: true } });
      } catch { await sendAndPinPromo(group.chatId).catch(() => {}); }
    }
    console.log(`[group] ${group.title || group.chatId}: restoran ajratildi — ${adminId}`);
    return GroupChat.findOne({ chatId: group.chatId }).lean();
  }

  const restaurant = await loadRestaurant(restaurantId);
  if (!restaurant) throw new GroupBindError('Restoran topilmadi', 404, 'RESTAURANT_NOT_FOUND');
  if (restaurant.isActive === false) throw new GroupBindError('Restoran faol emas', 409, 'RESTAURANT_INACTIVE');
  if (!group.isBotAdmin) throw new GroupBindError('Bot bu chatda admin emas — avval admin qiling (pin uchun)', 409, 'NOT_ADMIN');

  const firstBind = !group.restaurantId;
  await GroupChat.updateOne({ chatId: group.chatId }, {
    $set: { restaurantId: restaurant._id, boundAt: new Date(), boundBy: String(adminId || ''), ...(firstBind ? { adsEnabled: false } : {}) },
  });
  const fresh = await GroupChat.findOne({ chatId: group.chatId }).lean();
  const r = await sendAndPinRestaurant(fresh, restaurant);
  console.log(`[group] ${group.title || group.chatId} → ${restaurant.name} (pin: ${r.isPinned ? 'ha' : `yo'q: ${r.error}`}) — ${adminId}`);
  return GroupChat.findOne({ chatId: group.chatId }).lean();
}

/**
 * Reklama qaysi chatlarga ketadi (sof funksiya). Faqat faol, bot admin bo'lgan va REKLAMASI YOQILGAN chatlar.
 * `chatIds` berilsa — faqat tanlanganlar (shu shartlar bilan). Qaytaradi: { targets, skipped: [{chatId,title,reason}] }.
 */
export function selectBroadcastTargets(groups, chatIds = null) {
  const wanted = Array.isArray(chatIds) && chatIds.length ? new Set(chatIds.map(String)) : null;
  const targets = []; const skipped = [];
  for (const g of groups) {
    if (wanted && !wanted.has(String(g.chatId))) continue;
    const reason = !g.isActive ? 'inactive' : !g.isBotAdmin ? 'not_admin' : g.adsEnabled === false ? 'ads_disabled' : '';
    if (reason) { if (wanted) skipped.push({ chatId: g.chatId, title: g.title, reason }); continue; }
    targets.push(g);
  }
  return { targets, skipped };
}
