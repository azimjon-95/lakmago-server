import { z } from 'zod';
import { asyncHandler } from '../middleware/error.js';
import { User } from '../models/User.js';
import {
  requestCardToken, verifyCardToken, deleteCardToken, ClickApiError,
} from '../services/clickCardToken.js';

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
  bankName: z.string().max(60).optional().default(''),
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
      bankName: parsed.data.bankName.trim(),
      expiry: parsed.data.expiry.trim(),
      isDefault: user.cards.length === 0,
    });
    await user.save();

    res.status(201).json(user.cards);
  }),

  // DELETE /api/cards/:id
  remove: asyncHandler(async (req, res) => {
    const user = await User.findById(req.userId).select('+cards.clickToken');
    if (!user) return res.status(404).json({ error: 'Foydalanuvchi topilmadi' });

    const card = user.cards.id(req.params.id);
    if (!card) return res.status(404).json({ error: 'Karta topilmadi' });

    const wasDefault = card.isDefault;

    /*
     * Click tomonida ham bekor qilamiz.
     *
     * Xato bo'lsa TO'XTAMAYMIZ: mijoz kartani ro'yxatdan
     * o'chira olishi kerak, Click javob bermayotgani uning
     * muammosi emas. Token baribir bizda qolmaydi.
     */
    if (card.clickToken) {
      deleteCardToken(card.clickToken)
        .catch((e) => console.error('[click:token-delete]', e.message));
    }

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

  /* ═══════════ CLICK: KARTA BOG'LASH ═══════════ */

  /**
   * POST /api/cards/click/request  { number, expiry }
   *
   * 1-qadam: Click kartaga bog'langan telefonga SMS yuboradi.
   * Karta ro'yxatga "tasdiqlanmagan" holda qo'shiladi va
   * to'lovda tanlanmaydi.
   *
   * KARTA RAQAMI SAQLANMAYDI — u faqat Click'ga uzatiladi va
   * o'rniga token olinadi.
   */
  clickRequest: asyncHandler(async (req, res) => {
    const parsed = z.object({
      number: z.string().min(12).max(20),
      expiry: z.string().min(4).max(5),
    }).safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({ error: 'Karta ma\u2018lumotlari to\u2018liq emas' });
    }

    const digits = parsed.data.number.replace(/\D/g, '');
    const expiry = parsed.data.expiry.replace(/\D/g, '');
    if (digits.length < 12 || expiry.length !== 4) {
      return res.status(400).json({ error: 'Karta raqami yoki muddati noto\u2018g\u2018ri' });
    }

    const user = await User.findById(req.userId).select('+cards.clickToken');
    if (!user) return res.status(404).json({ error: 'Foydalanuvchi topilmadi' });

    const last4 = digits.slice(-4);
    const existing = user.cards.find((c) => c.last4 === last4 && c.verified);
    if (existing) {
      return res.status(400).json({ error: 'Bu karta allaqachon qo\u2018shilgan' });
    }

    let result;
    try {
      result = await requestCardToken(digits, expiry, true);
    } catch (e) {
      const err = e instanceof ClickApiError ? e : null;
      return res.status(400).json({
        error: err?.message || 'Kartani bog\u2018lab bo\u2018lmadi',
        code: err?.code,
      });
    }

    // Tasdiqlanmagan eski urinishlar qolmasin
    user.cards = user.cards.filter((c) => !(c.last4 === last4 && !c.verified));

    user.cards.push({
      last4,
      brand: detectBrand(digits),
      expiry: `${expiry.slice(0, 2)}/${expiry.slice(2)}`,
      clickToken: result.cardToken,
      verified: false,
      tokenRequestedAt: new Date(),
      isDefault: false,
    });
    await user.save();

    const card = user.cards[user.cards.length - 1];
    res.json({
      cardId: String(card._id),
      phoneNumber: result.phoneNumber,   // niqoblangan: 99890***1234
      last4,
    });
  }),

  /**
   * POST /api/cards/click/verify  { cardId, code }
   *
   * 2-qadam: SMS kod. Shundan keyin karta to'lovga yaroqli.
   */
  clickVerify: asyncHandler(async (req, res) => {
    const parsed = z.object({
      cardId: z.string().min(1),
      code: z.string().min(4).max(8),
    }).safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({ error: 'Kod noto\u2018g\u2018ri' });
    }

    const user = await User.findById(req.userId).select('+cards.clickToken');
    if (!user) return res.status(404).json({ error: 'Foydalanuvchi topilmadi' });

    const card = user.cards.id(parsed.data.cardId);
    if (!card) return res.status(404).json({ error: 'Karta topilmadi' });
    if (card.verified) return res.json({ ok: true, already: true });

    try {
      await verifyCardToken(card.clickToken, parsed.data.code);
    } catch (e) {
      const err = e instanceof ClickApiError ? e : null;
      return res.status(400).json({
        error: err?.message || 'Kodni tasdiqlab bo\u2018lmadi',
        code: err?.code,
      });
    }

    card.verified = true;
    // Birinchi tasdiqlangan karta avtomatik asosiy bo'ladi
    if (!user.cards.some((c) => c.verified && c.isDefault)) {
      card.isDefault = true;
    }
    await user.save();

    res.json({ ok: true, cards: user.cards });
  }),
};
