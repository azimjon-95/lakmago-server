import { z } from 'zod';
import { asyncHandler } from '../middleware/error.js';
import { User } from '../models/User.js';

// Karta turini raqamdan aniqlaymiz (O'zbekiston + xalqaro)
function detectBrand(number) {
  const n = String(number).replace(/\D/g, '');
  if (n.startsWith('8600')) return 'uzcard';
  if (n.startsWith('9860')) return 'humo';
  if (n.startsWith('4')) return 'visa';
  if (/^5[1-5]/.test(n)) return 'mastercard';
  return 'card';
}

const cardSchema = z.object({
  // To'liq raqam faqat tekshirish uchun keladi — SAQLANMAYDI
  number: z.string().min(12).max(20),
  expiry: z.string().optional().default(''),
  holder: z.string().optional().default(''),
});

export const cardController = {
  // GET /api/cards
  list: asyncHandler(async (req, res) => {
    const user = await User.findById(req.userId).select('cards').lean();
    res.json(user?.cards || []);
  }),

  // POST /api/cards
  create: asyncHandler(async (req, res) => {
    const parsed = cardSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Karta raqami noto\u2018g\u2018ri' });
    }

    const digits = parsed.data.number.replace(/\D/g, '');
    if (digits.length < 12) {
      return res.status(400).json({ error: 'Karta raqami to\u2018liq emas' });
    }

    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'Foydalanuvchi topilmadi' });

    const last4 = digits.slice(-4);
    // Bir xil karta ikki marta qo'shilmasin
    if (user.cards.some((c) => c.last4 === last4)) {
      return res.status(400).json({ error: 'Bu karta allaqachon qo\u2018shilgan' });
    }

    // Faqat oxirgi 4 raqam saqlanadi — to'liq raqam hech qayerga yozilmaydi
    user.cards.push({
      last4,
      brand: detectBrand(digits),
      holder: parsed.data.holder.trim(),
      expiry: parsed.data.expiry.trim(),
      isDefault: user.cards.length === 0,
    });
    await user.save();

    res.status(201).json(user.cards);
  }),

  // DELETE /api/cards/:id
  remove: asyncHandler(async (req, res) => {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'Foydalanuvchi topilmadi' });

    const card = user.cards.id(req.params.id);
    if (!card) return res.status(404).json({ error: 'Karta topilmadi' });

    const wasDefault = card.isDefault;
    card.deleteOne();
    // Asosiy karta o'chirilsa birinchisi asosiy bo'ladi
    if (wasDefault && user.cards.length) user.cards[0].isDefault = true;
    await user.save();

    res.json(user.cards);
  }),

  // PATCH /api/cards/:id/default
  setDefault: asyncHandler(async (req, res) => {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'Foydalanuvchi topilmadi' });

    const card = user.cards.id(req.params.id);
    if (!card) return res.status(404).json({ error: 'Karta topilmadi' });

    user.cards.forEach((c) => { c.isDefault = false; });
    card.isDefault = true;
    await user.save();

    res.json(user.cards);
  }),
};
