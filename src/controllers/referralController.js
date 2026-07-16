import { asyncHandler } from '../middleware/error.js';
import { config } from '../config/index.js';
import { User } from '../models/User.js';
import { checkChannelSubscription, rewardReferralIfSubscribed, buildReferralLink } from '../services/referral.js';

export const referralController = {
  // GET /api/referral/me — foydalanuvchi referal statistikasi (havola, soni, bonus)
  me: asyncHandler(async (req, res) => {
    const user = await User.findById(req.userId).select('referralCount bonusBalance isSubscribed').lean();
    if (!user) return res.status(404).json({ error: 'Foydalanuvchi topilmadi' });

    res.json({
      referralLink: buildReferralLink(req.userId),
      referralCount: user.referralCount || 0,
      bonusBalance: user.bonusBalance || 0,
      reward: config.referralReward,
      welcomeBonus: config.referralWelcomeBonus,
    });
  }),

  // GET /api/referral/subscription — asosiy kanалга obuna holatини tekshirish
  // Webapp ochilishдан oldin chaqiriladi (gate).
  subscription: asyncHandler(async (req, res) => {
    const user = await User.findById(req.userId).select('telegramId isSubscribed referredBy referralRewarded');
    if (!user) return res.status(404).json({ error: 'Foydalanuvchi topilmadi' });

    // Kanал sozlanmagan — obuna talab qilinmaydi
    if (!config.mainChannel) {
      return res.json({ required: false, subscribed: true });
    }

    const subscribed = await checkChannelSubscription(user.telegramId);

    // Obuna bo'lgan bo'lsa — holatни saqlaymiz + referal bonusини tekshiramiz
    if (subscribed && !user.isSubscribed) {
      user.isSubscribed = true;
      user.subscribedAt = new Date();
      await user.save();
    }
    if (subscribed) {
      try { await rewardReferralIfSubscribed(user); } catch { /* jim */ }
    }

    res.json({
      required: true,
      subscribed,
      channel: config.mainChannel,
      channelUrl: config.mainChannelUrl || `https://t.me/${String(config.mainChannel).replace('@', '')}`,
    });
  }),
};
