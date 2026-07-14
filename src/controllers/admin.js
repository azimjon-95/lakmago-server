import { z } from 'zod';
import { asyncHandler } from '../middleware/error.js';
import { Restaurant } from '../models/Restaurant.js';
import { User } from '../models/User.js';
import { Order } from '../models/Order.js';

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

    res.json({
      restaurants,
      activeRestaurants,
      pendingRestaurants: restaurants - activeRestaurants,
      users,
      orders,
      todayOrders,
      totalRevenue,
      commission,
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
      category: z.enum(['milliy', 'fastfood', 'sushi', 'kafe', 'shirinlik', 'magazin']),
      kind: z.enum(['restaurant', 'cafe', 'shop']).default('restaurant'),
      phone: z.string().optional(),
      address: z.string().optional(),
      icon: z.string().optional(),
      tint: z.string().optional(),
      deliveryMin: z.number().optional(),
      deliveryMax: z.number().optional(),
      deliveryFee: z.number().optional(),
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
    const allowed = ['name', 'cuisine', 'category', 'kind', 'phone', 'address', 'icon', 'tint', 'isActive', 'isApproved', 'deliveryMin', 'deliveryMax', 'deliveryFee', 'discount'];
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
};
