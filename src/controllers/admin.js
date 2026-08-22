import { z } from 'zod';
import { config } from '../config/index.js';
import { asyncHandler } from '../middleware/error.js';
import { Restaurant } from '../models/Restaurant.js';
import { User, Banner } from '../models/User.js';
import { Order } from '../models/Order.js';
import { Dish } from '../models/Dish.js';
import { Settings, getSettings } from '../models/Settings.js';
import { GroupChat } from '../models/GroupChat.js';
import { Reservation } from '../models/Reservation.js';
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

    // ===== BUGUN =====
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const startOfYesterday = new Date(startOfDay.getTime() - 864e5);

    // Hali yopilmagan — diqqat talab qiladigan buyurtmalar
    const OPEN = ['pending', 'accepted', 'preparing', 'ready', 'delivering'];

    const dayShape = (from, to) => ([
      { $match: to ? { createdAt: { $gte: from, $lt: to } } : { createdAt: { $gte: from } } },
      {
        $group: {
          _id: null,
          orders: { $sum: 1 },
          delivered: { $sum: { $cond: [{ $eq: ['$status', 'delivered'] }, 1, 0] } },
          cancelled: { $sum: { $cond: [{ $eq: ['$status', 'cancelled'] }, 1, 0] } },
          open: { $sum: { $cond: [{ $in: ['$status', OPEN] }, 1, 0] } },
          revenue: { $sum: { $cond: [{ $eq: ['$status', 'delivered'] }, '$total', 0] } },
        },
      },
    ]);

    const settings = await getSettings();
    const pct = settings.commissionMode === 'none' ? 0 : settings.commissionPercent;

    const [todayAgg, yesterdayAgg, byRestaurant] = await Promise.all([
      Order.aggregate(dayShape(startOfDay)),
      Order.aggregate(dayShape(startOfYesterday, startOfDay)),

      // Bugun qaysi muassasaga ko'p taom berilyapti
      Order.aggregate([
        { $match: { createdAt: { $gte: startOfDay }, status: { $ne: 'cancelled' } } },
        { $unwind: '$items' },
        {
          $group: {
            _id: '$restaurantId',
            name: { $first: '$restaurantName' },
            dishes: { $sum: '$items.quantity' },
            revenue: { $sum: { $multiply: ['$items.unitPrice', '$items.quantity'] } },
            orderIds: { $addToSet: '$_id' },
            openIds: {
              $addToSet: { $cond: [{ $in: ['$status', OPEN] }, '$_id', '$$REMOVE'] },
            },
          },
        },
        {
          $project: {
            name: 1, dishes: 1, revenue: 1,
            orders: { $size: '$orderIds' },
            open: { $size: '$openIds' },
          },
        },
        { $sort: { dishes: -1 } },
      ]),
    ]);

    const empty = { orders: 0, delivered: 0, cancelled: 0, open: 0, revenue: 0 };
    const t = todayAgg[0] || empty;
    const y = yesterdayAgg[0] || empty;

    const dishesToday = byRestaurant.reduce((s, r) => s + r.dishes, 0);

    res.json({
      restaurants,
      activeRestaurants,
      pendingRestaurants: restaurants - activeRestaurants,
      users,
      orders,
      todayOrders: t.orders,
      totalRevenue,
      commission,
      commissionPercent: pct,

      today: {
        orders: t.orders,
        delivered: t.delivered,
        cancelled: t.cancelled,
        open: t.open,
        dishes: dishesToday,
        revenue: t.revenue,
        commission: Math.round(t.revenue * (pct / 100)),
        avgCheck: t.delivered ? Math.round(t.revenue / t.delivered) : 0,
      },
      yesterday: { orders: y.orders, revenue: y.revenue },

      // Bugungi reyting — eng ko'p taom bergan muassasalar
      todayByRestaurant: byRestaurant.slice(0, 10).map((r) => ({
        id: String(r._id),
        name: r.name || 'Nomsiz',
        dishes: r.dishes,
        orders: r.orders,
        open: r.open,
        revenue: r.revenue,
      })),
      activeRestaurantsToday: byRestaurant.length,
    });
  }),

  // GET /api/admin/restaurants?status=active|inactive
  restaurants: asyncHandler(async (req, res) => {
    const filter = {};
    if (req.query.status === 'active') filter.isActive = true;
    if (req.query.status === 'inactive') filter.isActive = false;
    const list = await Restaurant.find(filter).sort({ createdAt: -1 }).lean();

    /*
     * TEZLIK (2026-08 tuzatish): avval har bir restoran uchun
     * ALOHIDA User.findOne() so'rovi yuborilardi (N+1 naqshi).
     * 50 ta restoran bo'lsa — 51 ta so'rov (1 + 50), parallel
     * yuborilsa ham har birining o'z tarmoq/bazaga borish
     * xarajati bor. Ko'p restoranli hisoblarda bu "sahifa
     * ochilishida qotib qolish" shikoyatining bir sababi
     * bo'lishi mumkin edi.
     *
     * Endi BITTA so'rov: barcha restoranId'lar $in orqali,
     * natija Map'ga joylanadi (O(1) qidiruv).
     */
    const owners = await User.find({
      restaurantId: { $in: list.map((r) => r._id) },
      role: 'restaurant',
    }).select('restaurantId login').lean();
    const ownerMap = new Map(owners.map((o) => [String(o.restaurantId), o.login]));

    const withOwner = list.map((r) => ({ ...r, ownerLogin: ownerMap.get(String(r._id)) ?? null }));
    res.json(withOwner);
  }),

  // POST /api/admin/restaurants — yangi muassasa + restoran akkaunti (login/parol)
  // GET /api/admin/restaurants/:id/dishes — muassasa menyusi
  restaurantDishes: asyncHandler(async (req, res) => {
    const restaurant = await Restaurant.findById(req.params.id)
      .select('name cuisine kind').lean();
    if (!restaurant) return res.status(404).json({ error: 'Muassasa topilmadi' });

    const dishes = await Dish.find({ restaurantId: req.params.id })
      .sort({ section: 1, createdAt: 1 }).lean();

    res.json({ restaurant, dishes });
  }),

  // GET /api/admin/restaurants/:id/reservations — muassasa bronlari
  restaurantReservations: asyncHandler(async (req, res) => {
    const restaurant = await Restaurant.findById(req.params.id)
      .select('name reservationEnabled').lean();
    if (!restaurant) return res.status(404).json({ error: 'Muassasa topilmadi' });

    const reservations = await Reservation.find({ restaurantId: req.params.id })
      .sort({ scheduledAt: -1 }).limit(100).lean();

    res.json({ restaurant, reservations });
  }),

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
      lat: z.number().optional(),
      lng: z.number().optional(),
      landmark: z.string().optional(),
      // Ish tartibi
      openTime: z.string().optional(),
      closeTime: z.string().optional(),
      legalName: z.string().optional(),
      legalAddress: z.string().optional(),
      inn: z.string().optional(),
      // Xizmat haqi
      minOrderAmount: z.number().optional(),
      serviceFeePercent: z.number().optional(),
      serviceFeeMin: z.number().optional(),
      serviceFeeMax: z.number().optional(),
      // Stol bron
      reservationEnabled: z.boolean().optional(),
      reservationNote: z.string().optional(),
      // Olib ketish
      pickupEnabled: z.boolean().optional(),
      deliveryEnabled: z.boolean().optional(),
      pickupDiscountPercent: z.number().optional(),
      prepMinutes: z.number().optional(),
      // Do'kon yo'nalishlari
      shopTypes: z.array(z.string()).optional(),
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
    const allowed = [
      'name', 'cuisine', 'category', 'kind', 'phone', 'address', 'lat', 'lng', 'landmark', 'icon', 'tint',
      'isActive', 'isBlocked', 'isApproved', 'deliveryMin', 'deliveryMax',
      'deliveryFee', 'discount', 'imageUrl', 'images',
      // Ish tartibi va yuridik ma'lumot
      'openTime', 'closeTime', 'legalName', 'legalAddress', 'inn',
      // Xizmat haqi va buyurtma shartlari
      'minOrderAmount', 'freeDeliveryThreshold', 'serviceFeePercent', 'serviceFeeMin', 'serviceFeeMax',
      // Stol bron qilish
      'reservationEnabled', 'reservationNote',
      // Olib ketish va do'kon yo'nalishlari
      'pickupEnabled', 'deliveryEnabled', 'pickupDiscountPercent', 'prepMinutes', 'shopTypes',
    ];
    const update = {};
    for (const k of allowed) if (k in req.body) update[k] = req.body[k];
    const restaurant = await Restaurant.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!restaurant) return res.status(404).json({ error: 'Muassasa topilmadi' });
    // Real-time: admin panel va restoran paneli darhol yangilanadi
    getIO()?.to('admin').emit('restaurant:update', restaurant);
    getIO()?.to(`restaurant:${restaurant._id}`).emit('restaurant:update', restaurant);
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
    getIO()?.to('admin').emit('restaurant:update', { _id: req.params.id, deleted: true });
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
      referralEnabled: z.boolean().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Noto\u2018g\u2018ri qiymat' });

    const s = await getSettings();
    if ('commissionPercent' in parsed.data) s.commissionPercent = parsed.data.commissionPercent;
    if ('commissionMode' in parsed.data) s.commissionMode = parsed.data.commissionMode;
    if ('referralEnabled' in parsed.data) s.referralEnabled = parsed.data.referralEnabled;
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
    const list = await Banner.find()
      .populate('restaurantId', 'name')
      .sort({ kind: 1, order: 1, createdAt: -1 })
      .lean();
    /*
     * TEZLIK (2026-08 tuzatish): pastda BUTUNLAY ORTIQCHA N+1
     * so'rov bloki bor edi — populate() yuqorida restoran nomini
     * ALLAQACHON olib kelgan, lekin keyin har bir banner uchun
     * Restaurant.findById() bilan XUDDI SHU nom yana so'ralardi
     * (ikki barobar ish, hech qanday foyda bermay). Butunlay
     * olib tashlandi.
     */
    // Restoran nomini qulay maydonga chiqaramiz
    list.forEach((b) => {
      if (b.restaurantId?.name) {
        b.restaurantName = b.restaurantId.name;
        b.restaurantId = b.restaurantId._id;
      }
    });
    res.json(list);
  }),

  // POST /api/admin/banners — platforma banneri qo'shish
  createBanner: asyncHandler(async (req, res) => {
    const schema = z.object({
      // Rasm majburiy — banner asosan rasmdan iborat
      imageUrl: z.string().min(1),
      // Tugma ixtiyoriy: yoqilsa matn va havola kerak
      hasButton: z.boolean().optional().default(false),
      title: z.string().optional().default(''),
      eyebrow: z.string().optional().default(''),
      cta: z.string().optional(),
      linkUrl: z.string().optional().default(''),
      bg: z.string().optional(),
      icon: z.string().optional(),
      order: z.number().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Banner rasmi majburiy' });
    const banner = await Banner.create({ ...parsed.data, kind: 'platform', active: true });
    res.status(201).json(banner);
  }),

  // PATCH /api/admin/banners/:id
  updateBanner: asyncHandler(async (req, res) => {
    const allowed = ['title', 'eyebrow', 'cta', 'bg', 'imageUrl', 'icon', 'order', 'active', 'hasButton', 'linkUrl'];
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

  // ===== TELEGRAM GURUHLAR =====
  // GET /api/admin/groups — bot admin qilingan guruhlar (holat bilan)
  groups: asyncHandler(async (_req, res) => {
    const groups = await GroupChat.find().sort({ createdAt: -1 }).lean();
    res.json(groups);
  }),

  // POST /api/admin/groups/:chatId/resend — reklama xabarini qayta yuborish + pin
  // POST /api/admin/groups/add — guruhni qo'lda qo'shish
  // Telegram bot qaysi guruhlarda ekanini o'zi aytmaydi (xavfsizlik).
  // Bot allaqachon qo'shilgan bo'lsa, admin chat ID bilan qo'shadi.
  addGroup: asyncHandler(async (req, res) => {
    const chatId = String(req.body.chatId || '').trim();
    if (!chatId) return res.status(400).json({ error: 'Chat ID kiriting' });

    if (!config.telegramBotToken) {
      return res.status(400).json({ error: 'Bot tokeni sozlanmagan' });
    }

    // Telegram'dan guruh ma'lumotini olamiz — bot a'zomi tekshiramiz
    try {
      const res1 = await fetch(
        `https://api.telegram.org/bot${config.telegramBotToken}/getChat?chat_id=${encodeURIComponent(chatId)}`,
      );
      const chat = await res1.json();
      if (!chat.ok) {
        return res.status(400).json({
          error: chat.description?.includes('not found')
            ? 'Guruh topilmadi. Bot guruhga qo\u2018shilganmi?'
            : chat.description,
        });
      }

      // Bot admin ekanini tekshiramiz
      const meRes = await fetch(
        `https://api.telegram.org/bot${config.telegramBotToken}/getMe`,
      );
      const me = await meRes.json();
      const memRes = await fetch(
        `https://api.telegram.org/bot${config.telegramBotToken}/getChatMember` +
        `?chat_id=${encodeURIComponent(chatId)}&user_id=${me.result.id}`,
      );
      const mem = await memRes.json();
      const isAdmin = ['administrator', 'creator'].includes(mem.result?.status);

      const { registerGroup } = await import('../services/telegramGroup.js');
      const group = await registerGroup(
        { id: chat.result.id, title: chat.result.title, type: chat.result.type },
        isAdmin,
      );

      getIO()?.to('admin').emit('group:new', { chatId: String(chat.result.id) });
      res.status(201).json({ ...group.toObject?.() || group, isBotAdmin: isAdmin });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }),

  resendPromo: asyncHandler(async (req, res) => {
    const { sendAndPinPromo } = await import('../services/telegramGroup.js');
    try {
      await sendAndPinPromo(req.params.chatId);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }),

  // POST /api/admin/groups/:chatId/broadcast — MOSLASHUVCHAN reklama
  // { text?, imageUrl?, buttonText?, buttonUrl?, pin? }
  broadcast: asyncHandler(async (req, res) => {
    const schema = z.object({
      text: z.string().optional().default(''),
      imageUrl: z.string().optional().default(''),
      buttonText: z.string().optional().default(''),
      buttonUrl: z.string().optional().default(''),
      pin: z.boolean().optional().default(false),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Ma\u2018lumot noto\u2018g\u2018ri' });
    if (!parsed.data.text && !parsed.data.imageUrl) {
      return res.status(400).json({ error: 'Matn yoki rasm bo\u2018lishi shart' });
    }

    const { sendCustomBroadcast } = await import('../services/telegramGroup.js');
    try {
      const result = await sendCustomBroadcast({ chatId: req.params.chatId, ...parsed.data });
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }),

  // POST /api/admin/groups/broadcast-all — bir vaqtda BARCHA faol guruhlarga
  broadcastAll: asyncHandler(async (req, res) => {
    const schema = z.object({
      text: z.string().optional().default(''),
      imageUrl: z.string().optional().default(''),
      buttonText: z.string().optional().default(''),
      buttonUrl: z.string().optional().default(''),
      pin: z.boolean().optional().default(false),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Ma\u2018lumot noto\u2018g\u2018ri' });
    if (!parsed.data.text && !parsed.data.imageUrl) {
      return res.status(400).json({ error: 'Matn yoki rasm bo\u2018lishi shart' });
    }

    const { sendCustomBroadcast } = await import('../services/telegramGroup.js');
    const groups = await GroupChat.find({ isActive: true, isBotAdmin: true });
    let sent = 0, failed = 0;
    for (const g of groups) {
      try {
        await sendCustomBroadcast({ chatId: g.chatId, ...parsed.data });
        sent++;
      } catch {
        failed++;
      }
    }
    res.json({ total: groups.length, sent, failed });
  }),

  // POST /api/admin/groups/check — kunlik tekshiruvni qo'lda ishga tushirish
  runGroupCheck: asyncHandler(async (_req, res) => {
    const { dailyGroupCheck } = await import('../services/telegramGroup.js');
    const result = await dailyGroupCheck();
    res.json(result);
  }),

  // ===== BUYURTMALAR NAZORATI (kim → qaysi restoran → nima) =====
  // GET /api/admin/orders?status=&restaurantId=&groupId=
  orders: asyncHandler(async (req, res) => {
    const filter = {};
    if (req.query.status) filter.status = req.query.status;
    if (req.query.restaurantId) filter.restaurantId = req.query.restaurantId;
    if (req.query.groupId) filter.groupId = req.query.groupId;

    const orders = await Order.find(filter)
      .populate('userId', 'firstName lastName username phone telegramId')
      .sort({ createdAt: -1 })
      .limit(Number(req.query.limit) || 100)
      .lean();

    res.json(orders);
  }),

  // GET /api/admin/orders/live — faol (yetkazilmagan) buyurtmalar, real-time nazorat
  liveOrders: asyncHandler(async (_req, res) => {
    const orders = await Order.find({ status: { $nin: ['delivered', 'cancelled'] } })
      .populate('userId', 'firstName lastName username phone')
      .sort({ createdAt: -1 })
      .lean();
    res.json(orders);
  }),

};
