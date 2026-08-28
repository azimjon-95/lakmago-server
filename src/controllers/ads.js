import { z } from 'zod';
import { asyncHandler } from '../middleware/error.js';
import { Ad } from '../models/Ad.js';
import { Restaurant } from '../models/Restaurant.js';
import { Dish } from '../models/Dish.js';
import { config } from '../config/index.js';

const createSchema = z.object({
  targetType: z.enum(['restaurant', 'dish']),
  dishId: z.string().length(24).optional(),
  imageUrl: z.string().min(1),
  days: z.number().int().min(1).max(90),
  customTitle: z.string().max(80).optional(),
  customDescription: z.string().max(200).optional(),
});

/* ============================================
   RESTORAN PANELI — reklama so'rovi yaratish
   ============================================ */
export const panelAdsController = {
  // GET /panel/ads — o'z restoranining barcha reklama so'rovlari
  list: asyncHandler(async (req, res) => {
    const ads = await Ad.find({ restaurantId: req.restaurantId })
      .sort({ createdAt: -1 })
      .populate('dishId', 'name imageUrl')
      .lean();
    res.json(ads);
  }),

  // GET /panel/ads/price — kunlik narxni ko'rsatish uchun
  price: asyncHandler(async (_req, res) => {
    res.json({ pricePerDaySom: config.adPricePerDaySom });
  }),

  // GET /panel/ads/images — "mavjud rasmdan tanlash" uchun ro'yxat
  // (restoranning o'z galereyasi + barcha taomlarining rasmlari)
  images: asyncHandler(async (req, res) => {
    const restaurant = await Restaurant.findById(req.restaurantId).select('imageUrl images').lean();
    const dishes = await Dish.find({ restaurantId: req.restaurantId, isAvailable: { $ne: false } })
      .select('name imageUrl images').lean();

    const restaurantImages = [restaurant?.imageUrl, ...(restaurant?.images || [])].filter(Boolean);
    const dishImages = dishes
      .flatMap((d) => [d.imageUrl, ...(d.images || [])].filter(Boolean).map((url) => ({ url, dishName: d.name, dishId: d._id })));

    res.json({
      restaurantImages: [...new Set(restaurantImages)],
      dishImages,
    });
  }),

  // POST /panel/ads — yangi reklama so'rovi (holat: pending)
  create: asyncHandler(async (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Noto‘g‘ri ma‘lumot', details: parsed.error.flatten() });
    }
    const { targetType, dishId, imageUrl, days, customTitle, customDescription } = parsed.data;

    /*
     * targetType==='dish' ikki yo'l bilan yaratilishi mumkin:
     *   a) dishId berilgan — mavjud taomga bog'lanadi, modalda
     *      HAQIQIY taom ma'lumoti (nomi, narxi) ko'rsatiladi
     *   b) dishId YO'Q — restoran o'zi rasm yuklab, o'zi
     *      sarlavha/tavsif yozadi (masalan menyuda hali yo'q
     *      maxsus taklif). Bu holda customTitle MAJBURIY —
     *      aks holda modalda ko'rsatiladigan hech narsa bo'lmaydi.
     */
    if (targetType === 'dish') {
      if (dishId) {
        const dish = await Dish.findOne({ _id: dishId, restaurantId: req.restaurantId });
        if (!dish) return res.status(404).json({ error: 'Taom topilmadi' });
      } else if (!customTitle?.trim()) {
        return res.status(400).json({ error: 'Taom tanlanmagan yoki sarlavha yozilmagan' });
      }
    }

    const pricePerDay = config.adPricePerDaySom * 100;   // so'm -> tiyin
    const ad = await Ad.create({
      restaurantId: req.restaurantId,
      targetType,
      dishId: targetType === 'dish' && dishId ? dishId : null,
      customTitle: (customTitle || '').trim(),
      customDescription: (customDescription || '').trim(),
      imageUrl,
      days,
      pricePerDay,
      totalPrice: pricePerDay * days,
      status: 'pending',
    });

    res.status(201).json(ad);
  }),

  // DELETE /panel/ads/:id — faqat 'pending' holatida bekor qilish mumkin
  cancel: asyncHandler(async (req, res) => {
    const ad = await Ad.findOne({ _id: req.params.id, restaurantId: req.restaurantId });
    if (!ad) return res.status(404).json({ error: 'Topilmadi' });
    if (ad.status !== 'pending') {
      return res.status(400).json({ error: 'Faqat kutilayotgan so‘rovni bekor qilish mumkin' });
    }
    ad.status = 'cancelled';
    await ad.save();
    res.json(ad);
  }),
};

/* ============================================
   ADMIN — tasdiqlash / rad etish
   ============================================ */
export const adminAdsController = {
  // GET /admin/ads?status=pending
  list: asyncHandler(async (req, res) => {
    const filter = {};
    if (req.query.status) filter.status = req.query.status;

    const ads = await Ad.find(filter)
      .sort({ createdAt: -1 })
      .populate('restaurantId', 'name imageUrl')
      .populate('dishId', 'name imageUrl')
      .lean();
    res.json(ads);
  }),

  // PATCH /admin/ads/:id/approve
  approve: asyncHandler(async (req, res) => {
    const ad = await Ad.findById(req.params.id);
    if (!ad) return res.status(404).json({ error: 'Topilmadi' });
    if (ad.status !== 'pending') {
      return res.status(400).json({ error: 'Bu so‘rov allaqachon ko‘rib chiqilgan' });
    }

    const now = new Date();
    const endsAt = new Date(now);
    endsAt.setDate(endsAt.getDate() + ad.days);

    ad.status = 'approved';
    ad.startsAt = now;
    ad.endsAt = endsAt;
    ad.reviewedBy = req.userId;
    ad.reviewedByModel = req.role === 'staff' ? 'StaffUser' : 'User';
    ad.reviewedAt = now;
    await ad.save();

    res.json(ad);
  }),

  // PATCH /admin/ads/:id/reject  { reason? }
  reject: asyncHandler(async (req, res) => {
    const ad = await Ad.findById(req.params.id);
    if (!ad) return res.status(404).json({ error: 'Topilmadi' });
    if (ad.status !== 'pending') {
      return res.status(400).json({ error: 'Bu so‘rov allaqachon ko‘rib chiqilgan' });
    }

    ad.status = 'rejected';
    ad.rejectReason = String(req.body?.reason || '').slice(0, 300);
    ad.reviewedBy = req.userId;
    ad.reviewedByModel = req.role === 'staff' ? 'StaffUser' : 'User';
    ad.reviewedAt = new Date();
    await ad.save();

    res.json(ad);
  }),
};

/* ============================================
   OCHIQ (mijoz ilovasi) — bosh sahifa banner
   ============================================ */
export const publicAdsController = {
  // GET /ads/banner — hozir faol reklamalar (tasdiqlangan + muddati ichida)
  banner: asyncHandler(async (_req, res) => {
    const now = new Date();
    const ads = await Ad.find({
      status: { $in: ['approved', 'active'] },
      startsAt: { $lte: now },
      endsAt: { $gte: now },
    })
      .sort({ createdAt: -1 })
      .limit(20)
      .populate('restaurantId', 'name imageUrl isActive isBlocked')
      .populate('dishId', 'name price imageUrl')
      .lean();

    // Bloklangan/o'chirilgan restoranlarning reklamasi ko'rinmasin
    const visible = ads.filter((a) => a.restaurantId && a.restaurantId.isActive && !a.restaurantId.isBlocked);

    res.json(visible.map((a) => ({
      id: String(a._id),
      targetType: a.targetType,
      imageUrl: a.imageUrl,
      restaurantId: String(a.restaurantId._id),
      restaurantName: a.restaurantId.name,
      // Moslashtirilgan matn — restoran o'zi yozgan (rasm+matn
      // yoki taomga bog'lanmagan reklama uchun). Bo'sh bo'lsa,
      // mijoz tarafida standart matnga (restoran nomi yoki
      // haqiqiy taom nomi) qaytiladi.
      customTitle: a.customTitle || null,
      customDescription: a.customDescription || null,
      dish: a.dishId ? {
        id: String(a.dishId._id), name: a.dishId.name,
        price: a.dishId.price, imageUrl: a.dishId.imageUrl,
      } : null,
    })));
  }),

  // POST /ads/:id/click — statistika uchun (ixtiyoriy, xato bo'lsa ham sahifa buzilmasin)
  click: asyncHandler(async (req, res) => {
    await Ad.updateOne({ _id: req.params.id }, { $inc: { clicks: 1 } }).catch(() => {});
    res.json({ ok: true });
  }),
};
