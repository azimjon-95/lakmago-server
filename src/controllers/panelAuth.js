import { blockedPayload } from '../services/customerBlock.js';
import { weddingFetch } from './weddingProxy.js';
import { z } from 'zod';
import { asyncHandler } from '../middleware/error.js';
import { signToken, signVenueOwnerToken } from '../middleware/auth.js';
import { User } from '../models/User.js';
import { StaffUser } from '../models/StaffUser.js';
import { getAllowedPages, DEPARTMENT_LABELS } from '../config/permissions.js';
import { warmupRestaurant } from '../services/restaurantWarmup.js';

const loginSchema = z.object({
  login: z.string().min(2),
  password: z.string().min(1),
});

export const panelAuthController = {
  // POST /api/auth/login  { login, password }
  //
  // BITTA login oynasi — admin, restoran VA LokmaGo xodimi
  // (buxgalter, dasturchi va h.k.) barchasi shu yerdan kiradi.
  // Avval User (admin/restoran), topilmasa StaffUser (xodim)
  // tekshiriladi — ikkalasi ALOHIDA jadval, lekin foydalanuvchi
  // uchun bitta, farqsiz kirish tajribasi.
  login: asyncHandler(async (req, res) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Login yoki parol noto‘g‘ri kiritildi' });
    }
    const { login, password } = parsed.data;
    const normalizedLogin = login.toLowerCase().trim();

    // 1) Admin / restoran (mavjud, o'zgarishsiz)
    const user = await User.findOne({ login: normalizedLogin });
    if (user) {
      if (!user.checkPassword(password)) {
        return res.status(401).json({ error: 'Login yoki parol xato' });
      }
      if (!user.isActive) {
        return res.status(403).json({ error: 'Akkaunt bloklangan. Administrator bilan bog‘laning.' });
      }
      if (user.role !== 'admin' && user.role !== 'restaurant') {
        return res.status(403).json({ error: 'Bu akkaunt panelga kira olmaydi' });
      }

      user.lastLoginAt = new Date();
      await user.save();

      const token = signToken(String(user._id), user.role, user.restaurantId ? String(user.restaurantId) : null);

      /*
       * Restoran kirdi — uning BUTUN ma'lumotini fon rejimida
       * Redisga yuklaymiz (profil + barcha taomlar).
       *
       * `await` YO'Q — ataylab: login javobi kutib turmasligi
       * kerak. Warm-up tugamasa ham panel ochilaveradi, shunchaki
       * birinchi so'rovlar bazadan o'qiydi.
       */
      if (user.role === 'restaurant' && user.restaurantId) {
        warmupRestaurant(user.restaurantId).catch(() => {});
      }

      return res.json({
        token,
        user: {
          _id: user._id,
          login: user.login,
          role: user.role,
          restaurantId: user.restaurantId,
          firstName: user.firstName,
          allowedPages: getAllowedPages(user.role, null),
        },
      });
    }

    // 2) LokmaGo xodimi (StaffUser — alohida jadval)
    const staff = await StaffUser.findOne({ login: normalizedLogin });
    if (staff) {
      if (!staff.checkPassword(password)) {
        return res.status(401).json({ error: 'Login yoki parol xato' });
      }
      if (!staff.isActive) {
        return res.status(403).json({ error: 'Akkaunt bloklangan. Administrator bilan bog‘laning.' });
      }

      staff.lastLoginAt = new Date();
      await staff.save();

      const token = signToken(String(staff._id), 'staff', null, staff.department);
      return res.json({
        token,
        user: {
          _id: staff._id,
          login: staff.login,
          role: 'staff',
          department: staff.department,
          departmentLabel: DEPARTMENT_LABELS[staff.department],
          firstName: staff.fullName,
          allowedPages: getAllowedPages('staff', staff.department),
        },
      });
    }

    /*
     * 3) TO'YXONA EGASI — akkaunt to'yxona serverida (ma'lumot LokmaGo bazasiga
     *    yozilmaydi). Tekshiruv server-server, kalit bilan. Muvaffaqiyatli
     *    bo'lsa — 'venue_owner' token: faqat o'z to'yxonasi CRM bo'limi.
     */
    if (process.env.WEDDING_API_URL && process.env.WEDDING_ADMIN_KEY) {
      const { status, data } = await weddingFetch('/api/internal/owner-login', {
        method: 'POST', body: { login: normalizedLogin, password },
      });
      if (status === 200 && data?.venue_id) {
        return res.json({
          token: signVenueOwnerToken(data.venue_id),
          user: { _id: `venue:${data.venue_id}`, login: data.login, role: 'venue_owner', venueId: data.venue_id, firstName: data.venue_name, allowedPages: [] },
        });
      }
      if (status === 403) return res.status(403).json({ error: data?.error || 'Akkaunt bloklangan' });
    }

    return res.status(401).json({ error: 'Login yoki parol xato' });
  }),

  // GET /api/auth/me  — joriy foydalanuvchi (token orqali)
  me: asyncHandler(async (req, res) => {
    // To'yxona egasi — ma'lumot to'yxona serveridan (akkaunt/blok holati ham shu yerda tekshiriladi)
    if (req.role === 'venue_owner') {
      const { status, data } = await weddingFetch('/api/owner/me', { headers: { 'X-Venue-Id': String(req.venueId) } });
      if (status !== 200) return res.status(status === 503 || status === 502 ? status : 401).json({ error: data?.error || 'Sessiya tugadi' });
      return res.json({ _id: `venue:${req.venueId}`, role: 'venue_owner', venueId: req.venueId, firstName: data.venue?.name, allowedPages: [] });
    }
    if (req.role === 'staff') {
      const staff = await StaffUser.findById(req.userId);
      if (!staff) return res.status(404).json({ error: 'Foydalanuvchi topilmadi' });
      return res.json({
        _id: staff._id,
        login: staff.login,
        role: 'staff',
        department: staff.department,
        departmentLabel: DEPARTMENT_LABELS[staff.department],
        firstName: staff.fullName,
        allowedPages: getAllowedPages('staff', staff.department),
      });
    }

    // Mijoz (Telegram Mini App) — Auth fundamenti: GET /auth/me
    // to'liq profil obyektini qaytaradi (panel javobidan farqli,
    // chunki client (masalan ProfilePage) shu maydonlarga tayanadi:
    // addresses, cards, bonusBalance va h.k.). status===BLOCKED
    // bo'lsa rad etiladi — token hali muddati o'tmagan bo'lsa ham
    // (admin keyinroq bloklagan bo'lishi mumkin).
    if (req.role === 'customer') {
      const user = await User.findById(req.userId);
      if (!user) return res.status(404).json({ error: 'Foydalanuvchi topilmadi' });
      if (user.status === 'BLOCKED') return res.status(403).json(blockedPayload(user));
      return res.json({ user });
    }

    const user = await User.findById(req.userId).populate('restaurantId');
    if (!user) return res.status(404).json({ error: 'Foydalanuvchi topilmadi' });
    res.json({
      _id: user._id,
      login: user.login,
      role: user.role,
      restaurantId: user.restaurantId,
      firstName: user.firstName,
      allowedPages: getAllowedPages(user.role, null),
    });
  }),
};
