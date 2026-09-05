import { z } from 'zod';
import { asyncHandler } from '../middleware/error.js';
import { User } from '../models/User.js';
import { Address } from '../models/Address.js';

/*
 * PATCH /users/me — QAT'IY WHITELIST. Faqat shu maydonlarga
 * ruxsat berilgan. telegramId/role/status/_id kabi himoyalangan
 * maydonlar bu yerdan HECH QACHON o'zgarmaydi — aks holda
 * foydalanuvchi o'zini admin qilib qo'yishi yoki boshqa birovning
 * telegramId'sini "band" qilishi mumkin bo'lardi.
 */
const profileUpdateSchema = z.object({
  firstName: z.string().min(1).max(60).optional(),
  lastName: z.string().max(60).optional(),
  phone: z.string().min(5).max(20).optional(),
  language: z.string().max(10).optional(),
}).strict();

const addressSchema = z.object({
  title: z.string().min(1).max(60).default('Manzil'),
  address: z.string().min(1).max(300),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
  entrance: z.string().max(20).optional().default(''),
  apartment: z.string().max(20).optional().default(''),
  floor: z.string().max(20).optional().default(''),
  comment: z.string().max(300).optional().default(''),
  isDefault: z.boolean().optional(),
});

export const userProfileController = {
  // GET /api/users/me
  me: asyncHandler(async (req, res) => {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'Foydalanuvchi topilmadi' });
    if (user.status === 'BLOCKED') return res.status(403).json({ error: 'Akkauntingiz bloklangan' });
    res.json({ user });
  }),

  // PATCH /api/users/me
  updateMe: asyncHandler(async (req, res) => {
    const parsed = profileUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'Ma\u02bblumot noto\u02bbg\u02bbri',
        details: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      });
    }

    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'Foydalanuvchi topilmadi' });
    if (user.status === 'BLOCKED') return res.status(403).json({ error: 'Akkauntingiz bloklangan' });

    /*
     * Telefon o'zgarsa phoneVerified qayta false bo'ladi — eski
     * (boshqa raqamga tegishli) tasdiqni yangi raqamga ko'chirib
     * qo'yish xavfsizlik teshigi bo'lardi. Tasdiqlash (SMS/qo'ng'iroq)
     * alohida oqim — bu fundament faqat maydonni tayyorlaydi.
     */
    if (parsed.data.phone !== undefined && parsed.data.phone !== user.phone) {
      user.phoneVerified = false;
    }

    Object.assign(user, parsed.data);
    await user.save();
    res.json({ user });
  }),

  // ===== Address (alohida kolleksiya — 2-bosqich Auth fundamenti) =====

  // GET /api/users/me/addresses
  listAddresses: asyncHandler(async (req, res) => {
    const addresses = await Address.find({ userId: req.userId }).sort({ isDefault: -1, createdAt: -1 }).lean();
    res.json({ addresses });
  }),

  // POST /api/users/me/addresses
  createAddress: asyncHandler(async (req, res) => {
    const parsed = addressSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Manzil ma\u02bblumoti noto\u02bbg\u02bbri', details: parsed.error.issues });
    }

    const existingCount = await Address.countDocuments({ userId: req.userId });
    // Birinchi manzil avtomatik asosiy bo'ladi
    const isDefault = existingCount === 0 ? true : Boolean(parsed.data.isDefault);

    if (isDefault) {
      await Address.updateMany({ userId: req.userId }, { isDefault: false });
    }

    const address = await Address.create({ ...parsed.data, userId: req.userId, isDefault });
    res.status(201).json({ address });
  }),

  // PATCH /api/users/me/addresses/:id
  updateAddress: asyncHandler(async (req, res) => {
    const parsed = addressSchema.partial().safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Manzil ma\u02bblumoti noto\u02bbg\u02bbri', details: parsed.error.issues });
    }

    const address = await Address.findOne({ _id: req.params.id, userId: req.userId });
    if (!address) return res.status(404).json({ error: 'Manzil topilmadi' });

    if (parsed.data.isDefault === true) {
      await Address.updateMany({ userId: req.userId, _id: { $ne: address._id } }, { isDefault: false });
    }

    Object.assign(address, parsed.data);
    await address.save();
    res.json({ address });
  }),

  // DELETE /api/users/me/addresses/:id
  removeAddress: asyncHandler(async (req, res) => {
    const address = await Address.findOneAndDelete({ _id: req.params.id, userId: req.userId });
    if (!address) return res.status(404).json({ error: 'Manzil topilmadi' });

    // Asosiy manzil o'chirilsa — qolgan eng yangisi asosiy bo'ladi
    if (address.isDefault) {
      const next = await Address.findOne({ userId: req.userId }).sort({ createdAt: -1 });
      if (next) { next.isDefault = true; await next.save(); }
    }

    res.json({ deleted: true });
  }),
};
