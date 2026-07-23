import { z } from 'zod';
import { asyncHandler } from '../middleware/error.js';
import { Restaurant } from '../models/Restaurant.js';
import { Dish } from '../models/Dish.js';
import { Order } from '../models/Order.js';
import { Banner, User } from '../models/User.js';
import { getIO } from '../sockets/io.js';
import { notifyUser } from '../services/telegram.js';

// Restoran token'idagi restaurantId'ni oladi (auth middleware qo'ygan)
function rid(req) {
  return req.restaurantId;
}

export const restaurantPanelController = {
  // GET /api/panel/me — restoranning o'z profili
  profile: asyncHandler(async (req, res) => {
    const restaurant = await Restaurant.findById(rid(req));
    if (!restaurant) return res.status(404).json({ error: 'Restoran topilmadi' });
    res.json(restaurant);
  }),

  // PATCH /api/panel/me/active  { isActive } — butun restoranni ochish/yopish
  toggleActive: asyncHandler(async (req, res) => {
    const { isActive } = req.body;
    const restaurant = await Restaurant.findByIdAndUpdate(
      rid(req),
      { isActive: Boolean(isActive) },
      { new: true },
    );
    if (!restaurant) return res.status(404).json({ error: 'Restoran topilmadi' });
    res.json(restaurant);
  }),

  // GET /api/panel/dishes — o'z taomlari (barchasi, STOPdagilar ham)
  dishes: asyncHandler(async (req, res) => {
    const dishes = await Dish.find({ restaurantId: rid(req) }).sort({ section: 1, name: 1 });
    res.json(dishes);
  }),

  // POST /api/panel/dishes — yangi taom qo'shish
  createDish: asyncHandler(async (req, res) => {
    const schema = z.object({
      section: z.string().min(1),
      name: z.string().min(1),
      description: z.string().optional().default(''),
      price: z.number().nonnegative(),
      oldPrice: z.number().optional(),
      icon: z.string().optional(),
      tint: z.string().optional(),
      calories: z.number().optional(),
      weightGram: z.number().optional(),
      imageUrl: z.string().optional(),
      images: z.array(z.string()).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Ma‘lumot noto‘g‘ri', details: parsed.error.issues });
    }
    const dish = await Dish.create({ ...parsed.data, restaurantId: rid(req) });
    res.status(201).json(dish);
  }),

  // PATCH /api/panel/dishes/:id — taomni tahrirlash (narx, nom, STOP)
  updateDish: asyncHandler(async (req, res) => {
    const allowed = ['name', 'description', 'price', 'oldPrice', 'section', 'icon', 'tint', 'isAvailable', 'isHit', 'isTrending', 'isDiscounted', 'calories', 'weightGram', 'imageUrl', 'images'];
    const update = {};
    for (const k of allowed) if (k in req.body) update[k] = req.body[k];
    // Faqat o'z taomini o'zgartira olsin
    const dish = await Dish.findOneAndUpdate(
      { _id: req.params.id, restaurantId: rid(req) },
      update,
      { new: true },
    );
    if (!dish) return res.status(404).json({ error: 'Taom topilmadi' });
    res.json(dish);
  }),

  // PATCH /api/panel/dishes/:id/stop  { stop: true|false }
  // Taomni STOPga tushirish yoki qaytarish (isAvailable teskarisi)
  toggleStop: asyncHandler(async (req, res) => {
    const { stop } = req.body;
    const dish = await Dish.findOneAndUpdate(
      { _id: req.params.id, restaurantId: rid(req) },
      { isAvailable: !stop },
      { new: true },
    );
    if (!dish) return res.status(404).json({ error: 'Taom topilmadi' });
    res.json(dish);
  }),

  // DELETE /api/panel/dishes/:id
  deleteDish: asyncHandler(async (req, res) => {
    const dish = await Dish.findOneAndDelete({ _id: req.params.id, restaurantId: rid(req) });
    if (!dish) return res.status(404).json({ error: 'Taom topilmadi' });
    res.json({ ok: true });
  }),

  // GET /api/panel/orders?status= — o'z buyurtmalari (live)
  orders: asyncHandler(async (req, res) => {
    const filter = { restaurantId: rid(req) };
    if (req.query.status && req.query.status !== 'all') filter.status = req.query.status;
    const orders = await Order.find(filter).sort({ createdAt: -1 }).limit(80);
    res.json(orders);
  }),

  // PATCH /api/panel/orders/:id/status  { status }
  // Restoran oqimi: pending → accepted → preparing → ready → delivering
  updateOrderStatus: asyncHandler(async (req, res) => {
    const { status } = req.body;
    const allowed = ['accepted', 'preparing', 'ready', 'delivering', 'cancelled'];
    if (!allowed.includes(status)) {
      return res.status(400).json({ error: 'Noto‘g‘ri status' });
    }

    const update = { status };
    if (status === 'accepted') update.acceptedAt = new Date();
    if (status === 'ready') update.readyAt = new Date();

    const order = await Order.findOneAndUpdate(
      { _id: req.params.id, restaurantId: rid(req) },
      update,
      { new: true },
    ).populate('userId');
    if (!order) return res.status(404).json({ error: 'Buyurtma topilmadi' });

    // Bekor qilinса — ishlatilган bonusни mijozга qaytaramiz (adolatli)
    if (status === 'cancelled' && order.bonusUsed > 0) {
      await User.updateOne({ _id: order.userId._id || order.userId }, { $inc: { bonusBalance: order.bonusUsed } });
    }

    const io = getIO();
    // Mijozga real-time status (buyurtma kuzatuvi shu yerdan yangilanadi)
    io?.to(`order:${order._id}`).emit('order:status', { orderId: String(order._id), status: order.status });
    // Admin global nazorati
    io?.to('admin').emit('order:update', order);

    // Telegram push
    const user = order.userId;
    const statusText = {
      accepted: '✅ Buyurtmangiz qabul qilindi',
      preparing: '👨‍🍳 Buyurtmangiz tayyorlanmoqda',
      ready: '🍽 Buyurtmangiz tayyor',
      delivering: '🚴 Kuryer buyurtmangizni olib ketdi',
      cancelled: '❌ Buyurtmangiz bekor qilindi',
    };
    if (user?.telegramId && statusText[status]) {
      notifyUser(user.telegramId, statusText[status]);
    }

    res.json(order);
  }),

  // ===== RESTORAN BANNERI =====
  // GET /api/panel/banner — restoranning o'z banneri
  getBanner: asyncHandler(async (req, res) => {
    const banner = await Banner.findOne({ kind: 'restaurant', restaurantId: rid(req) });
    res.json(banner || null);
  }),

  // PUT /api/panel/banner — o'z bannerini qo'shish/almashtirish
  setBanner: asyncHandler(async (req, res) => {
    const schema = z.object({
      // Rasm majburiy — banner asosan rasmdan iborat
      imageUrl: z.string().min(1),
      // Tugma ixtiyoriy
      hasButton: z.boolean().optional().default(false),
      title: z.string().optional().default(''),
      eyebrow: z.string().optional().default(''),
      cta: z.string().optional(),
      linkUrl: z.string().optional().default(''),
      bg: z.string().optional(),
      icon: z.string().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Banner rasmi majburiy' });

    // Restoran uchun bitta banner — bor bo'lsa yangilaymiz, yo'q bo'lsa yaratamiz
    const banner = await Banner.findOneAndUpdate(
      { kind: 'restaurant', restaurantId: rid(req) },
      { ...parsed.data, kind: 'restaurant', restaurantId: rid(req), active: true },
      { new: true, upsert: true },
    );
    res.json(banner);
  }),

  // DELETE /api/panel/banner — o'z bannerini o'chirish
  deleteBanner: asyncHandler(async (req, res) => {
    await Banner.deleteOne({ kind: 'restaurant', restaurantId: rid(req) });
    res.json({ ok: true });
  }),

};
