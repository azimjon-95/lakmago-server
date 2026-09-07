import { z } from 'zod';
import { asyncHandler } from '../middleware/error.js';
import { RestaurantTelegramStaff } from '../models/RestaurantTelegramStaff.js';
import { createConnectLink, isRestaurantBotEnabled } from '../services/restaurantBot.js';

/*
 * Restoran panelidagi "Sozlamalar → Telegram" bo'limi.
 *
 * Restoran o'z xodimlarining Telegram akkauntlarini shu yerdan
 * boshqaradi: qo'shadi, ulash linkini oladi, uzadi.
 *
 * XAVFSIZLIK: barcha so'rovlarda restaurantId TOKEN'dan olinadi
 * (rid), so'rov tanasidan EMAS. Aks holda restoran boshqa
 * restoran xodimlarini ko'rishi yoki o'chirishi mumkin bo'lardi.
 */

// Restoran token'idagi restaurantId (auth middleware qo'ygan)
const rid = (req) => req.restaurantId;

// @ belgisi, bo'sh joy va https://t.me/ prefiksini tozalaymiz —
// admin qanday ko'chirib qo'yishidan qat'i nazar ishlasin
function normalizeUsername(raw) {
  return String(raw || '')
    .trim()
    .replace(/^https?:\/\/t\.me\//i, '')
    .replace(/^@/, '')
    .toLowerCase();
}

const addSchema = z.object({
  username: z.string().min(3).max(40),
});

export const restaurantTelegramController = {
  // GET /api/panel/telegram-staff
  list: asyncHandler(async (req, res) => {
    const staff = await RestaurantTelegramStaff.find({ restaurantId: rid(req) })
      .sort({ createdAt: -1 })
      .select('-connectToken')
      .lean();

    res.json({
      // Bot sozlanmagan bo'lsa panel buni aytadi — admin
      // "nega link chiqmayapti?" deb o'ylab qolmasin
      botEnabled: isRestaurantBotEnabled(),
      staff,
    });
  }),

  // POST /api/panel/telegram-staff
  add: asyncHandler(async (req, res) => {
    const parsed = addSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Username noto‘g‘ri' });
    }

    const username = normalizeUsername(parsed.data.username);
    if (!/^[a-z0-9_]{3,40}$/.test(username)) {
      return res.status(400).json({
        error: 'Username faqat harf, raqam va _ dan iborat bo‘lishi kerak',
      });
    }

    const exists = await RestaurantTelegramStaff.findOne({
      restaurantId: rid(req),
      username,
    }).lean();
    if (exists) {
      return res.status(409).json({ error: 'Bu username allaqachon qo‘shilgan' });
    }

    const staff = await RestaurantTelegramStaff.create({
      restaurantId: rid(req),
      username,
      isActive: true,
    });

    res.status(201).json(staff);
  }),

  // POST /api/panel/telegram-staff/:id/link
  // Ulash havolasini yaratadi (yoki yangilaydi)
  link: asyncHandler(async (req, res) => {
    const staff = await RestaurantTelegramStaff.findOne({
      _id: req.params.id,
      restaurantId: rid(req),
    });
    if (!staff) return res.status(404).json({ error: 'Xodim topilmadi' });

    const url = await createConnectLink(staff._id);
    if (!url) {
      return res.status(503).json({
        error: 'Telegram bot sozlanmagan. RESTAURANT_BOT_TOKEN ni tekshiring.',
      });
    }

    res.json({ url });
  }),

  /*
   * DELETE /api/panel/telegram-staff/:id
   *
   * Yozuv O'CHIRILMAYDI, faqat faolsizlanadi (TZ 19-band):
   * yangi buyurtmalar kelmaydi, lekin eski buyurtmalarda
   * "kim qabul qildi" ma'lumoti saqlanib qoladi.
   *
   * telegramUserId ham tozalanadi — shunda o'sha odam
   * keyinchalik boshqa restoranga ulanishi mumkin.
   */
  disconnect: asyncHandler(async (req, res) => {
    const staff = await RestaurantTelegramStaff.findOneAndUpdate(
      { _id: req.params.id, restaurantId: rid(req) },
      { isActive: false, telegramUserId: null, connectToken: null },
      { new: true },
    );
    if (!staff) return res.status(404).json({ error: 'Xodim topilmadi' });
    res.json({ ok: true });
  }),
};
