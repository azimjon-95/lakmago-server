import { z } from 'zod';
import { asyncHandler } from '../middleware/error.js';
import { signToken } from '../middleware/auth.js';
import { User } from '../models/User.js';
import { StaffUser } from '../models/StaffUser.js';
import { getAllowedPages, DEPARTMENT_LABELS } from '../config/permissions.js';

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

    return res.status(401).json({ error: 'Login yoki parol xato' });
  }),

  // GET /api/auth/me  — joriy foydalanuvchi (token orqali)
  me: asyncHandler(async (req, res) => {
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
