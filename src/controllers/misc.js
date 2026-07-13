import { z } from 'zod';
import { asyncHandler } from '../middleware/error.js';
import { signToken, verifyTelegramInitData } from '../middleware/auth.js';
import { Banner } from '../models/User.js';
import { User } from '../models/User.js';
import { Order } from '../models/Order.js';
import { getIO } from '../sockets/io.js';
import { notifyUser } from '../services/telegram.js';

export const bannerController = {
  // GET /api/banners
  list: asyncHandler(async (_req, res) => {
    const banners = await Banner.find({ active: true }).sort({ order: 1 });
    res.json(banners);
  })
};











export const authController = {
  // POST /api/auth/telegram
  // Body: { initData } — Telegram.WebApp.initData (server shu yerdan initDataUnsafe.user ni oladi va tasdiqlaydi)
  telegram: asyncHandler(async (req, res) => {
    const { initData } = req.body;
    if (!initData) return res.status(400).json({ error: 'initData yo‘q' });

    // 1) initData'ni Telegram Bot Token bilan HMAC-SHA256 orqali tasdiqlash
    const data = verifyTelegramInitData(initData);
    if (!data) return res.status(401).json({ error: 'Telegram tekshiruvi muvaffaqiyatsiz' });

    const tgUser = JSON.parse(data.user ?? '{}');
    if (!tgUser.id) return res.status(400).json({ error: 'Telegram user ma’lumoti topilmadi' });

    const telegramId = String(tgUser.id);
    const profileFields = {
      firstName: tgUser.first_name,
      lastName: tgUser.last_name,
      username: tgUser.username,
      languageCode: tgUser.language_code,
      isPremium: Boolean(tgUser.is_premium),
      photoUrl: tgUser.photo_url,
      lastLoginAt: new Date()
    };

    // 2) telegramId bo'yicha qidirish — topilmasa yaratish, topilsa yangilash
    let user = await User.findOne({ telegramId });
    let isNewUser = false;
    if (!user) {
      isNewUser = true;
      user = await User.create({ telegramId, ...profileFields });
    } else {
      Object.assign(user, profileFields);
      await user.save();
    }

    // 3) JWT qaytarish
    const token = signToken(String(user._id), user.role ?? 'customer');
    res.json({ token, user, isNewUser });
  })
};

const createOrderSchema = z.object({
  restaurantId: z.string(),
  restaurantName: z.string(),
  items: z.
  array(
    z.object({
      dishId: z.string(),
      name: z.string(),
      quantity: z.number().int().positive(),
      unitPrice: z.number().nonnegative(),
      selectedOptions: z.
      array(z.object({ name: z.string(), price: z.number() })).
      optional(),
      note: z.string().optional()
    })
  ).
  min(1),
  subtotal: z.number(),
  deliveryFee: z.number().default(0),
  serviceFee: z.number().default(0),
  total: z.number(),
  address: z.string(),
  paymentMethod: z.enum(['payme', 'click', 'uzum', 'cash']).default('cash')
});

export const orderController = {
  // POST /api/orders
  create: asyncHandler(async (req, res) => {
    const parsed = createOrderSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Ma‘lumot noto‘g‘ri', details: parsed.error.issues });
    }
    const order = await Order.create({ ...parsed.data, userId: req.userId, status: 'accepted' });

    // Real-time: restoranga yangi buyurtma xabari
    getIO()?.
    to(`restaurant:${parsed.data.restaurantId}`).
    emit('order:new', { orderId: order._id, total: order.total });

    res.status(201).json(order);
  }),

  // GET /api/orders  (foydalanuvchi buyurtmalari)
  myOrders: asyncHandler(async (req, res) => {
    const orders = await Order.find({ userId: req.userId }).sort({ createdAt: -1 });
    res.json(orders);
  }),

  // GET /api/orders/:id
  getOne: asyncHandler(async (req, res) => {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Buyurtma topilmadi' });
    res.json(order);
  }),

  // PATCH /api/orders/:id/status  { status }  (restoran/admin)
  updateStatus: asyncHandler(async (req, res) => {
    const { status } = req.body;
    const order = await Order.findByIdAndUpdate(
      req.params.id,
      { status },
      { new: true }
    ).populate('userId');
    if (!order) return res.status(404).json({ error: 'Buyurtma topilmadi' });

    // Real-time: mijozga status yangilanishi
    getIO()?.to(`order:${order._id}`).emit('order:status', { status: order.status });

    // Telegram push
    const user = order.userId;
    const statusText = {
      preparing: '👨‍🍳 Buyurtmangiz tayyorlanmoqda',
      delivering: '🚴 Buyurtmangiz yo‘lda',
      delivered: '✅ Buyurtmangiz yetkazildi. Yoqimli ishtaha!'
    };
    if (user?.telegramId && statusText[status]) {
      notifyUser(user.telegramId, statusText[status]);
    }

    res.json(order);
  })
};
