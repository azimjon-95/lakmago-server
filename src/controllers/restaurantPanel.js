import { z } from 'zod';
import { asyncHandler } from '../middleware/error.js';
import { Restaurant } from '../models/Restaurant.js';
import { Dish } from '../models/Dish.js';
import { Order } from '../models/Order.js';
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
    const allowed = ['name', 'description', 'price', 'oldPrice', 'section', 'icon', 'tint', 'isAvailable', 'isHit', 'isTrending', 'isDiscounted', 'calories', 'weightGram'];
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
  updateOrderStatus: asyncHandler(async (req, res) => {
    const { status } = req.body;
    const order = await Order.findOneAndUpdate(
      { _id: req.params.id, restaurantId: rid(req) },
      { status },
      { new: true },
    ).populate('userId');
    if (!order) return res.status(404).json({ error: 'Buyurtma topilmadi' });

    // Mijozga real-time status
    getIO()?.to(`order:${order._id}`).emit('order:status', { status: order.status });

    // Telegram push
    const user = order.userId;
    const statusText = {
      preparing: '👨‍🍳 Buyurtmangiz tayyorlanmoqda',
      delivering: '🚴 Buyurtmangiz yo‘lda',
      delivered: '✅ Buyurtmangiz yetkazildi. Yoqimli ishtaha!',
      cancelled: '❌ Buyurtmangiz bekor qilindi',
    };
    if (user?.telegramId && statusText[status]) {
      notifyUser(user.telegramId, statusText[status]);
    }

    res.json(order);
  }),
};
