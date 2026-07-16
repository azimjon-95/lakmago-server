import { z } from 'zod';
import { asyncHandler } from '../middleware/error.js';
import { Restaurant } from '../models/Restaurant.js';
import { User, Banner } from '../models/User.js';
import { Order } from '../models/Order.js';
import { Dish } from '../models/Dish.js';
import { Settings, getSettings } from '../models/Settings.js';
import { getIO } from '../sockets/io.js';

export const adminController = {
  // GET /api/admin/stats — umumiy analitika
  stats: asyncHandler(async (_req, res) => {
    const [restaurants, activeRestaurants, users, orders] = await Promise.all([
      Restaurant.countDocuments(),
      Restaurant.countDocuments({ isActive: true }),
      User.countDocuments({ role: 'customer' }),
      Order.countDocuments(),
    ]);

    const revenueAgg = await Order.aggregate([
      { $match: { status: 'delivered' } },
      { $group: { _id: null, total: { $sum: '$total' } } },
    ]);
    const totalRevenue = revenueAgg[0]?.total ?? 0;
    const commission = Math.round(totalRevenue * 0.12); // 12% platforma komissiyasi

    // Bugungi buyurtmalar
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const todayOrders = await Order.countDocuments({ createdAt: { $gte: startOfDay } });

    // Eng ko'p buyurtma qilingan taomlar (psixologiya/marketing uchun)
    const topDishes = await Order.aggregate([
      { $unwind: '$items' },
      { $group: { _id: '$items.name', count: { $sum: '$items.quantity' }, revenue: { $sum: { $multiply: ['$items.unitPrice', '$items.quantity'] } } } },
      { $sort: { count: -1 } },
      { $limit: 8 },
    ]);

    res.json({
      restaurants,
      activeRestaurants,
      pendingRestaurants: restaurants - activeRestaurants,
      users,
      orders,
      todayOrders,
      totalRevenue,
      commission,
      topDishes: topDishes.map((d) => ({ name: d._id, count: d.count, revenue: d.revenue })),
    });
  }),

  // GET /api/admin/restaurants?status=active|inactive
  restaurants: asyncHandler(async (req, res) => {
    const filter = {};
    if (req.query.status === 'active') filter.isActive = true;
    if (req.query.status === 'inactive') filter.isActive = false;
    const list = await Restaurant.find(filter).sort({ createdAt: -1 }).lean();

    // Har muassasaning egasi (login) ni qo'shib beramiz
    const withOwner = await Promise.all(
      list.map(async (r) => {
        const owner = await User.findOne({ restaurantId: r._id, role: 'restaurant' }).lean();
        return { ...r, ownerLogin: owner?.login ?? null };
      }),
    );
    res.json(withOwner);
  }),

  // POST /api/admin/restaurants — yangi muassasa + restoran akkaunti (login/parol)
  createRestaurant: asyncHandler(async (req, res) => {
    const schema = z.object({
      name: z.string().min(1),
      cuisine: z.string().min(1),
      // Kategoriya va tur — moslashuvchan (yangi turlar qo'shish oson bo'lsin)
      category: z.string().min(1),
      kind: z.string().default('restaurant'),
      phone: z.string().optional(),
      address: z.string().optional(),
      icon: z.string().optional(),
      tint: z.string().optional(),
      deliveryMin: z.number().optional(),
      deliveryMax: z.number().optional(),
      deliveryFee: z.number().optional(),
      imageUrl: z.string().optional(),
      images: z.array(z.string()).optional(),
      // Restoran akkaunti
      login: z.string().min(3),
      password: z.string().min(4),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Ma‘lumot noto‘g‘ri', details: parsed.error.issues });
    }
    const { login, password, ...restData } = parsed.data;

    // Login band emasligini tekshirish
    const exists = await User.findOne({ login: login.toLowerCase().trim() });
    if (exists) return res.status(409).json({ error: 'Bu login allaqachon band' });

    // 1) Muassasa yaratish
    const restaurant = await Restaurant.create({ ...restData, isApproved: true, isActive: true });

    // 2) Restoran akkauntini yaratish (login/parol) va restoranga bog'lash
    const owner = await User.create({
      login: login.toLowerCase().trim(),
      passwordHash: User.hashPassword(password),
      role: 'restaurant',
      restaurantId: restaurant._id,
      firstName: restData.name,
    });
    restaurant.ownerId = owner._id;
    await restaurant.save();

    res.status(201).json({ restaurant, ownerLogin: owner.login });
  }),

  // PATCH /api/admin/restaurants/:id — muassasa ma'lumotini yangilash (faol/nofaol ham)
  updateRestaurant: asyncHandler(async (req, res) => {
    const allowed = ['name', 'cuisine', 'category', 'kind', 'phone', 'address', 'icon', 'tint', 'isActive', 'isBlocked', 'isApproved', 'deliveryMin', 'deliveryMax', 'deliveryFee', 'discount', 'imageUrl', 'images'];
    const update = {};
    for (const k of allowed) if (k in req.body) update[k] = req.body[k];
    const restaurant = await Restaurant.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!restaurant) return res.status(404).json({ error: 'Muassasa topilmadi' });
    res.json(restaurant);
  }),

  // PATCH /api/admin/restaurants/:id/password — restoran parolini almashtirish
  resetRestaurantPassword: asyncHandler(async (req, res) => {
    const { password } = req.body;
    if (!password || password.length < 4) {
      return res.status(400).json({ error: 'Parol kamida 4 belgi bo‘lishi kerak' });
    }
    const owner = await User.findOne({ restaurantId: req.params.id, role: 'restaurant' });
    if (!owner) return res.status(404).json({ error: 'Restoran akkaunti topilmadi' });
    owner.passwordHash = User.hashPassword(password);
    await owner.save();
    res.json({ ok: true });
  }),

  // DELETE /api/admin/restaurants/:id — muassasa va uning akkauntini o'chirish
  deleteRestaurant: asyncHandler(async (req, res) => {
    const restaurant = await Restaurant.findByIdAndDelete(req.params.id);
    if (!restaurant) return res.status(404).json({ error: 'Muassasa topilmadi' });
    await User.deleteMany({ restaurantId: req.params.id, role: 'restaurant' });
    res.json({ ok: true });
  }),

  // GET /api/admin/orders — barcha buyurtmalar (live nazorat)
  allOrders: asyncHandler(async (req, res) => {
    const filter = {};
    if (req.query.status && req.query.status !== 'all') filter.status = req.query.status;
    const orders = await Order.find(filter).sort({ createdAt: -1 }).limit(100).lean();
    res.json(orders);
  }),

  // GET /api/admin/users — mijozlar ro'yxati
  users: asyncHandler(async (_req, res) => {
    const users = await User.find({ role: 'customer' }).sort({ createdAt: -1 }).limit(100);
    res.json(users);
  }),

  // ===== BLOKLASH =====
  // PATCH /api/admin/restaurants/:id/block  { blocked: true|false }
  // Bloklansa mijozga umuman ko'rinmaydi (barcha taomlari bilan).
  toggleBlock: asyncHandler(async (req, res) => {
    const { blocked } = req.body;
    const restaurant = await Restaurant.findByIdAndUpdate(
      req.params.id,
      { isBlocked: Boolean(blocked) },
      { new: true },
    );
    if (!restaurant) return res.status(404).json({ error: 'Muassasa topilmadi' });
    getIO()?.to('admin').emit('restaurant:update', restaurant);
    res.json(restaurant);
  }),

  // ===== KOMISSIYA SOZLAMASI =====
  // GET /api/admin/settings
  getSettingsData: asyncHandler(async (_req, res) => {
    const s = await getSettings();
    res.json({ commissionPercent: s.commissionPercent, commissionMode: s.commissionMode });
  }),

  // PATCH /api/admin/settings  { commissionPercent, commissionMode }
  updateSettings: asyncHandler(async (req, res) => {
    const schema = z.object({
      commissionPercent: z.number().min(0).max(100).optional(),
      commissionMode: z.enum(['markup', 'deduct', 'none']).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Noto\u2018g\u2018ri qiymat' });

    const s = await getSettings();
    if ('commissionPercent' in parsed.data) s.commissionPercent = parsed.data.commissionPercent;
    if ('commissionMode' in parsed.data) s.commissionMode = parsed.data.commissionMode;
    await s.save();
    res.json({ commissionPercent: s.commissionPercent, commissionMode: s.commissionMode });
  }),

  // ===== DAROMAD HISOBI =====
  // GET /api/admin/revenue — har muassasa bo'yicha daromad + platforma daromadi
  revenue: asyncHandler(async (_req, res) => {
    const settings = await getSettings();
    const pct = settings.commissionMode === 'none' ? 0 : settings.commissionPercent;

    // Yetkazilgan buyurtmalar bo'yicha restoran daromadi
    const byRestaurant = await Order.aggregate([
      { $match: { status: 'delivered' } },
      { $group: { _id: '$restaurantId', name: { $first: '$restaurantName' }, orders: { $sum: 1 }, gross: { $sum: '$subtotal' } } },
      { $sort: { gross: -1 } },
    ]);

    // Har muassasa uchun: restoran daromadi va platforma komissiyasini hisoblaymiz
    const rows = byRestaurant.map((r) => {
      const gross = r.gross;
      let platformIncome = 0;
      let restaurantIncome = gross;
      if (settings.commissionMode === 'markup') {
        // Mijoz narx ustiga +pct to'ladi → platforma o'sha ustamani oladi
        platformIncome = Math.round(gross * (pct / 100));
        restaurantIncome = gross; // restoran to'liq oladi
      } else if (settings.commissionMode === 'deduct') {
        // Restoran narxidan −pct olamiz
        platformIncome = Math.round(gross * (pct / 100));
        restaurantIncome = gross - platformIncome;
      }
      return { restaurantId: r._id, name: r.name, orders: r.orders, gross, restaurantIncome, platformIncome };
    });

    const totalGross = rows.reduce((s, r) => s + r.gross, 0);
    const totalPlatform = rows.reduce((s, r) => s + r.platformIncome, 0);
    const totalRestaurant = rows.reduce((s, r) => s + r.restaurantIncome, 0);

    res.json({
      commissionPercent: pct,
      commissionMode: settings.commissionMode,
      rows,
      totals: { gross: totalGross, platform: totalPlatform, restaurant: totalRestaurant },
    });
  }),

  // ===== BANNER BOSHQARUVI =====
  // GET /api/admin/banners — barcha bannerlar (platforma + restoran)
  banners: asyncHandler(async (_req, res) => {
    const list = await Banner.find().sort({ kind: 1, order: 1, createdAt: -1 }).lean();
    const withRest = await Promise.all(list.map(async (b) => {
      if (b.restaurantId) {
        const r = await Restaurant.findById(b.restaurantId).select('name').lean();
        return { ...b, restaurantName: r?.name ?? null };
      }
      return b;
    }));
    res.json(withRest);
  }),

  // POST /api/admin/banners — platforma banneri qo'shish
  createBanner: asyncHandler(async (req, res) => {
    const schema = z.object({
      title: z.string().min(1),
      eyebrow: z.string().optional().default(''),
      cta: z.string().optional(),
      bg: z.string().optional(),
      imageUrl: z.string().optional(),
      icon: z.string().optional(),
      order: z.number().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Ma\u2018lumot noto\u2018g\u2018ri' });
    const banner = await Banner.create({ ...parsed.data, kind: 'platform', active: true });
    res.status(201).json(banner);
  }),

  // PATCH /api/admin/banners/:id
  updateBanner: asyncHandler(async (req, res) => {
    const allowed = ['title', 'eyebrow', 'cta', 'bg', 'imageUrl', 'icon', 'order', 'active'];
    const update = {};
    for (const k of allowed) if (k in req.body) update[k] = req.body[k];
    const banner = await Banner.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!banner) return res.status(404).json({ error: 'Banner topilmadi' });
    res.json(banner);
  }),

  // DELETE /api/admin/banners/:id — admin istalgan bannerni o'chira oladi (restoran ham)
  deleteBanner: asyncHandler(async (req, res) => {
    const banner = await Banner.findByIdAndDelete(req.params.id);
    if (!banner) return res.status(404).json({ error: 'Banner topilmadi' });
    res.json({ ok: true });
  }),

};
