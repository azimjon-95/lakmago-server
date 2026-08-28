import { z } from 'zod';
import { asyncHandler } from '../middleware/error.js';
import { StaffUser, DEPARTMENTS } from '../models/StaffUser.js';
import { DEPARTMENT_LABELS } from '../config/permissions.js';

const createSchema = z.object({
  login: z.string().min(3).max(40).regex(/^[a-z0-9_.]+$/i, "Login faqat lotin harflari, raqam, '_' va '.' bo'lishi mumkin"),
  password: z.string().min(6).max(100),
  fullName: z.string().min(2).max(120),
  department: z.enum(DEPARTMENTS),
  phone: z.string().max(30).optional(),
  note: z.string().max(500).optional(),
});

const updateSchema = z.object({
  fullName: z.string().min(2).max(120).optional(),
  department: z.enum(DEPARTMENTS).optional(),
  phone: z.string().max(30).optional(),
  note: z.string().max(500).optional(),
  isActive: z.boolean().optional(),
  password: z.string().min(6).max(100).optional(),   // parol tiklash
});

export const staffController = {
  // GET /admin/staff — barcha xodimlar (admin bo'limi bundan mustasno
  // ko'rsatiladi, lekin yaratib bo'lmaydi — pastda tekshiriladi)
  list: asyncHandler(async (_req, res) => {
    const items = await StaffUser.find({}).sort({ createdAt: -1 }).lean();
    res.json(items.map((s) => ({
      ...s,
      passwordHash: undefined,
      departmentLabel: DEPARTMENT_LABELS[s.department],
    })));
  }),

  // POST /admin/staff — yangi xodim yollash
  create: asyncHandler(async (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Noto‘g‘ri ma‘lumot', details: parsed.error.flatten() });
    }
    const { login, password, ...rest } = parsed.data;
    const normalizedLogin = login.toLowerCase().trim();

    const exists = await StaffUser.findOne({ login: normalizedLogin });
    if (exists) return res.status(409).json({ error: 'Bu login band' });

    // Admin/restoran jadvalida ham shu login bandmi — ikkalasi
    // bitta login maydonini bo'lishadi (bitta kirish oynasi
    // uchun), shuning uchun ikkalasida ham noyob bo'lishi kerak
    const { User } = await import('../models/User.js');
    const userExists = await User.findOne({ login: normalizedLogin });
    if (userExists) return res.status(409).json({ error: 'Bu login band' });

    const staff = await StaffUser.create({
      ...rest,
      login: normalizedLogin,
      passwordHash: StaffUser.hashPassword(password),
      createdBy: req.userId,
    });

    res.status(201).json({ ...staff.toJSON(), departmentLabel: DEPARTMENT_LABELS[staff.department] });
  }),

  // PATCH /admin/staff/:id
  update: asyncHandler(async (req, res) => {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Noto‘g‘ri ma‘lumot' });
    }
    const { password, ...rest } = parsed.data;
    const update = { ...rest };
    if (password) update.passwordHash = StaffUser.hashPassword(password);

    const staff = await StaffUser.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!staff) return res.status(404).json({ error: 'Xodim topilmadi' });
    res.json({ ...staff.toJSON(), departmentLabel: DEPARTMENT_LABELS[staff.department] });
  }),

  // DELETE /admin/staff/:id — ishdan bo'shatish
  remove: asyncHandler(async (req, res) => {
    const deleted = await StaffUser.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Xodim topilmadi' });
    res.json({ ok: true });
  }),

  // GET /admin/staff/departments — tanlov ro'yxati (frontend uchun)
  departments: asyncHandler(async (_req, res) => {
    res.json(DEPARTMENTS.filter((d) => d !== 'admin').map((d) => ({
      value: d, label: DEPARTMENT_LABELS[d],
    })));
  }),
};
