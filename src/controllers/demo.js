import { asyncHandler } from '../middleware/error.js';
import { demoLogin, getDemoRestaurantCard, isDemoReady, isDemoUser } from '../services/demoAccount.js';

/*
 * Ilova imkoniyatlari va demo hisob (App Store tekshiruvi). Hammasi services/demoAccount.js da tushuntirilgan.
 *   GET  /api/app/capabilities  — ommaviy: ilova qaysi imkoniyatlarni ko'rsatishi kerak. ESKI server bu endpointni
 *                                 bilmaydi (404) — ilova hamma yangi imkoniyatni YASHIRADI (haqiqiy mijozlarga ta'sir yo'q).
 *   POST /api/auth/demo-login   — demo kirish (faqat DEMO_LOGIN_ENABLED=true; aks holda 404)
 *   GET  /api/demo/restaurant   — demo foydalanuvchining bosh sahifasi uchun demo restoran kartochkasi
 */
export const demoController = {
  capabilities: (_req, res) => {
    res.set('Cache-Control', 'no-store').json({ v: 2, demoLogin: isDemoReady(), accountDeletion: true });
  },

  login: asyncHandler(async (req, res) => {
    try {
      const result = await demoLogin({
        login: req.body?.login, password: req.body?.password, platform: req.body?.platform, deviceId: req.body?.deviceId,
      });
      res.json(result);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message });
      throw e;
    }
  }),

  restaurant: asyncHandler(async (req, res) => {
    if (!isDemoReady() || !(await isDemoUser(req.userId))) return res.status(404).json({ error: 'Topilmadi' });
    const card = await getDemoRestaurantCard();
    if (!card) return res.status(404).json({ error: 'Topilmadi' });
    res.json(card);
  }),
};
