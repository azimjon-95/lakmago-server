import { config } from '../config/index.js';
import { User } from '../models/User.js';
import { parseReferralCode, attachReferral, checkChannelSubscription } from './referral.js';

const TG_API = `https://api.telegram.org/bot${config.telegramBotToken}`;

async function tg(method, body) {
  const res = await fetch(`${TG_API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

// /start buyrug'i — referal + majburiy obuna + webapp tugmasi.
export async function handleStartCommand(telegramId, startParam, from) {
  // 1) Foydalanuvchini topamiz/yaratamiz (bot orqali birinchi kirish)
  let user = await User.findOne({ telegramId });
  const isNew = !user;
  if (!user) {
    user = await User.create({
      telegramId,
      firstName: from?.first_name,
      lastName: from?.last_name,
      username: from?.username,
      languageCode: from?.language_code,
    });
  }

  // 2) Referal havola bilan kelган bo'lsa — bog'laymiz (faqat yangi user)
  const refCode = parseReferralCode(startParam);
  if (isNew && refCode) {
    try { await attachReferral(user, refCode); } catch { /* jim */ }
  }

  // 3) Majburiy obuna: kanал sozlangan va user hali obuna bo'lmagan bo'lsa
  if (config.mainChannel) {
    const subscribed = await checkChannelSubscription(telegramId);
    if (!subscribed) {
      const channelUrl = config.mainChannelUrl || `https://t.me/${String(config.mainChannel).replace('@', '')}`;
      await tg('sendMessage', {
        chat_id: telegramId,
        text:
          '👋 <b>LokmaGo\u2019ga xush kelibsiz!</b>\n\n' +
          '🍽 Mazali taomlarni buyurtma qilishдан oldin asosiy kanalimizga obuna bo\u2018ling.\n\n' +
          '1️⃣ Kanalga obuna bo\u2018ling\n' +
          '2️⃣ «Tekshirish» tugmasini bosing',
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: '📢 Kanalga obuna bo\u2018lish', url: channelUrl }],
            [{ text: '✅ Tekshirish', callback_data: 'check_sub' }],
          ],
        },
      });
      return;
    }
  }

  // 4) Obuna bor (yoki talab yo'q) — webapp tugmasini yuboramiz
  await sendWebAppEntry(telegramId, user);
}

// Webapp'ga kirish tugmasi + xush kelibsiz
export async function sendWebAppEntry(telegramId, user) {
  const bonusLine = (user?.bonusBalance > 0)
    ? `\n💰 Sizda ${user.bonusBalance.toLocaleString('ru-RU')} so\u2018m bonus bor!`
    : '';
  await tg('sendMessage', {
    chat_id: telegramId,
    text:
      '🎉 <b>Tayyor!</b> Endi buyurtma berishingiz mumkin.' + bonusLine + '\n\n' +
      '👇 Ilovani ochish uchun tugmani bosing:',
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [[
        { text: '🍽 Buyurtma berish', web_app: { url: config.webappUrl } },
      ]],
    },
  });
}

// «Tekshirish» tugmasi bosilганда (callback_query)
export async function handleCheckSubscription(callbackQuery) {
  const telegramId = String(callbackQuery.from.id);
  const callbackId = callbackQuery.id;

  const subscribed = await checkChannelSubscription(telegramId);
  if (!subscribed) {
    // Hali obuna emas — ogohlantirish (popup)
    await tg('answerCallbackQuery', {
      callback_query_id: callbackId,
      text: '❌ Siz hali kanalga obuna bo\u2018lmadingiz. Obuna bo\u2018lib, qayta bosing.',
      show_alert: true,
    });
    return;
  }

  // Obuna tasdiqlandi — bonus berish (referal bo'lsa)
  await tg('answerCallbackQuery', { callback_query_id: callbackId, text: '✅ Obuna tasdiqlandi!' });

  const user = await User.findOne({ telegramId });
  if (user) {
    if (!user.isSubscribed) {
      user.isSubscribed = true;
      user.subscribedAt = new Date();
      await user.save();
    }
    const { rewardReferralIfSubscribed } = await import('./referral.js');
    try { await rewardReferralIfSubscribed(user); } catch { /* jim */ }
    await sendWebAppEntry(telegramId, user);
  }
}
