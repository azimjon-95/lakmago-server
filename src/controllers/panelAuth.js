import { z } from 'zod';
import { asyncHandler } from '../middleware/error.js';
import { signToken } from '../middleware/auth.js';
import { User } from '../models/User.js';

const loginSchema = z.object({
  login: z.string().min(2),
  password: z.string().min(1),
});

export const panelAuthController = {
  // POST /api/auth/login  { login, password }
  // Admin (lakmago.uz/eka) va restoran (lakmago.uz) foydalanuvchilari uchun.
  login: asyncHandler(async (req, res) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Login yoki parol noto‘g‘ri kiritildi' });
    }
    const { login, password } = parsed.data;

    const user = await User.findOne({ login: login.toLowerCase().trim() });
    if (!user || !user.checkPassword(password)) {
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
    res.json({
      token,
      user: {
        _id: user._id,
        login: user.login,
        role: user.role,
        restaurantId: user.restaurantId,
        firstName: user.firstName,
      },
    });
  }),

  // GET /api/auth/me  — joriy foydalanuvchi (token orqali)
  me: asyncHandler(async (req, res) => {
    const user = await User.findById(req.userId).populate('restaurantId');
    if (!user) return res.status(404).json({ error: 'Foydalanuvchi topilmadi' });
    res.json({
      _id: user._id,
      login: user.login,
      role: user.role,
      restaurantId: user.restaurantId,
      firstName: user.firstName,
    });
  }),
};
