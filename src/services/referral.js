import { config } from '../config/index.js';
import { User } from '../models/User.js';
import { notifyUser } from './telegram.js';

const TG_API = `https://api.telegram.org/bot${config.telegramBotToken}`;

async function tg(method, body) {
  const res = await fetch(`${TG_API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

// Foydalanuvchi asosiy kanалга obuna bo'lganmi — Telegram'дан tekshiradi.
// Kanал sozlanmagan bo'lsa — obuna talab qilinmaydi (true).
export async function checkChannelSubscription(telegramId) {
  if (!config.mainChannel || !config.telegramBotToken) return true;
  try {
    const data = await tg('getChatMember', { chat_id: config.mainChannel, user_id: Number(telegramId) });
    if (!data.ok) return false;
    const status = data.result?.status;
    // a'zo, admin yoki creator — obuna hisoblanadi. left/kicked — yo'q.
    return ['member', 'administrator', 'creator'].includes(status);
  } catch {
    return false;
  }
}

// Referal kodni ajratish: "ref_<userId>" → userId
export function parseReferralCode(startParam) {
  if (!startParam || typeof startParam !== 'string') return null;
  if (startParam.startsWith('ref_')) return startParam.slice(4);
  return null;
}

// Yangi foydalanuvchига referal bog'lash (faqat yangi user, o'zini o'zi emas).
// Hali bonus BERILMAYDI — obuna tasdiqlanганда beriladi.
export async function attachReferral(newUser, referrerId) {
  if (!referrerId || newUser.referredBy) return; // allaqачon bor
  if (String(newUser._id) === String(referrerId)) return; // o'zini o'zi taklif qila olmaydi

  const referrer = await User.findById(referrerId).select('_id').lean();
  if (!referrer) return;

  newUser.referredBy = referrerId;
  await newUser.save();
}

// Obuna tasdiqlanганда bonuslarни berish (bir marta).
// Ham taklif qiluvchи, ham yangi kelgan bonus oladi.
export async function rewardReferralIfSubscribed(user) {
  // Allaqачon mukofotlangan yoki referali yo'q — hech nima qilmaymiz
  if (user.referralRewarded || !user.referredBy) return;

  // Obunani tekshiramiz
  const subscribed = await checkChannelSubscription(user.telegramId);
  if (!subscribed) return;

  // Yangi kelganга xush kelibsiz bonusи
  user.referralRewarded = true;
  user.isSubscribed = true;
  user.subscribedAt = new Date();
  user.bonusBalance = (user.bonusBalance || 0) + config.referralWelcomeBonus;
  await user.save();

  // Taklif qiluvchига bonus + referal soni
  const referrer = await User.findById(user.referredBy);
  if (referrer) {
    referrer.referralCount = (referrer.referralCount || 0) + 1;
    referrer.bonusBalance = (referrer.bonusBalance || 0) + config.referralReward;
    await referrer.save();

    // Xabar beramiz
    if (referrer.telegramId) {
      const name = user.firstName || 'Do\u2018stingiz';
      notifyUser(
        referrer.telegramId,
        `🎉 <b>${name}</b> sizning taklifingiz bilan qo\u2018shildi!\n\n` +
        `💰 +${config.referralReward.toLocaleString('ru-RU')} so\u2018m bonus hisobingizga qo\u2018shildi.\n` +
        `👥 Jami takliflaringiz: ${referrer.referralCount}`,
      );
    }
  }

  return { welcomeBonus: config.referralWelcomeBonus, referrerReward: config.referralReward };
}

// Referal havolasini yasash
export function buildReferralLink(userId) {
  const botUsername = config.botUsername || 'LokmaGoBot';
  return `https://t.me/${botUsername}?start=ref_${userId}`;
}
