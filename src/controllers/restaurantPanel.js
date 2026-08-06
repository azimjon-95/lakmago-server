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
    // Shartnoma va moliya ma'lumotlari restoranga BERILMAYDI —
    // komissiya foizi, balans, to'langan summa faqat adminda.
    const restaurant = await Restaurant.findById(rid(req))
      .select('-ownerId -__v -commissionPercent -commissionMode -balance -totalPaidOut -contractNumber -contractDate');

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
      // Tayyorlanish vaqti va kategoriya
      prepMinutes: z.number().int().min(1).max(240).optional(),
      // Qo'shimcha ma'lumot — barchasi ixtiyoriy
      weight: z.string().optional(),
      volume: z.string().max(30).optional(),
      priceMode: z.enum(['sync', 'custom']).optional(),
      dineInPrice: z.number().min(0).nullable().optional(),
      calories: z.number().optional(),
      protein: z.number().optional(),
      fat: z.number().optional(),
      carbs: z.number().optional(),
      category: z.string().optional(),
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

    // Yuborilgan, lekin saqlanmagan maydonlarni aniqlaymiz.
    // Mongoose strict rejimda modelda yo'q maydonni jim tashlaydi —
    // bu jimgina ma'lumot yo'qolishiga olib keladi.
    const dropped = Object.keys(parsed.data).filter(
      (k) => parsed.data[k] !== undefined && dish[k] === undefined,
    );
    if (dropped.length) {
      console.warn(
        `[dish] Saqlanmagan maydonlar: ${dropped.join(', ')}\n` +
        '  Sabab: server eski kod bilan ishlayapti.\n' +
        '  Yechim: git pull && pm2 restart lakmago-server',
      );
    }
    // Real-time: admin nazorat panelida darhol ko'rinadi
    getIO()?.to('admin').emit('dish:update', { restaurantId: String(rid(req)) });
    res.status(201).json(dish);
  }),

  // PATCH /api/panel/dishes/:id — taomni tahrirlash (narx, nom, STOP)
  updateDish: asyncHandler(async (req, res) => {
    const allowed = ['name', 'description', 'price', 'oldPrice', 'section', 'category', 'prepMinutes', 'icon', 'tint', 'isAvailable', 'isHit', 'isTrending', 'isDiscounted', 'calories', 'weight', 'weightGram', 'protein', 'fat', 'carbs', 'volume', 'priceMode', 'dineInPrice', 'imageUrl', 'images'];
    const update = {};
    for (const k of allowed) if (k in req.body) update[k] = req.body[k];
    // Faqat o'z taomini o'zgartira olsin
    const dish = await Dish.findOneAndUpdate(
      { _id: req.params.id, restaurantId: rid(req) },
      update,
      { new: true },
    );
    if (!dish) return res.status(404).json({ error: 'Taom topilmadi' });

    // Panel va mijozlar ilovasi darhol yangilanadi
    const count = await Dish.countDocuments({
      restaurantId: rid(req),
      isAvailable: false,
    });
    const io = getIO();
    io?.to(`restaurant:${rid(req)}`).emit('dish:stop', {
      dishId: String(dish._id),
      isAvailable: dish.isAvailable,
      stoppedCount: count,
    });
    io?.emit('dish:update', { restaurantId: String(rid(req)) });

    res.json({ ...dish.toObject(), stoppedCount: count });
  }),

  // PATCH /api/panel/dishes/:id/stop  { stop: true|false }
  // Taomni STOPga tushirish yoki qaytarish (isAvailable teskarisi)
  // GET /api/panel/dishes/stopped — stop'dagi taomlar
  // Menyu sahifasidan alohida: faqat kerakli maydonlar,
  // ortiqcha ma'lumot yuborilmaydi.
  stoppedDishes: asyncHandler(async (req, res) => {
    const dishes = await Dish.find({
      restaurantId: rid(req),
      isAvailable: false,
    })
      .select('name imageUrl images price oldPrice category section volume updatedAt')
      .sort({ updatedAt: -1 })
      .lean();

    res.json(dishes);
  }),

  // GET /api/panel/dishes/stopped/count — faqat son (badge uchun)
  stoppedCount: asyncHandler(async (req, res) => {
    const count = await Dish.countDocuments({
      restaurantId: rid(req),
      isAvailable: false,
    });
    res.json({ count });
  }),

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
    const filter = {
      restaurantId: rid(req),
      // To'lov kutilayotgan buyurtmalar restoranga KO'RINMAYDI —
      // pul kelgach avtomatik 'pending' bo'ladi va chiqadi
      status: { $ne: 'awaiting_payment' },
    };
    if (req.query.status && req.query.status !== 'all') filter.status = req.query.status;

    // Mijoz ma'lumotlari bilan — restoran bog'lana olishi uchun
    const orders = await Order.find(filter)
      .populate('userId', 'firstName lastName username telegramId phone photoUrl')
      .sort({ createdAt: -1 })
      .limit(80)
      .lean();

    // Mijozni qulay ko'rinishga keltiramiz
    const items = orders.map((o) => {
      const u = o.userId || {};
      return {
        ...o,
        userId: u._id ? String(u._id) : null,
        customer: {
          name: [u.firstName, u.lastName].filter(Boolean).join(' ') || 'Mijoz',
          username: u.username || '',
          telegramId: u.telegramId || '',
          phone: o.phone || u.phone || '',
          photoUrl: u.photoUrl || '',
        },
      };
    });

    res.json(items);
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

    // Avvalgi holatni olamiz — bir xil bo'lsa xabar takrorlanmasin
    const before = await Order.findOne({ _id: req.params.id, restaurantId: rid(req) })
      .select('status').lean();
    if (!before) return res.status(404).json({ error: 'Buyurtma topilmadi' });

    const statusChanged = before.status !== status;

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
    // ===== HISOB-KITOB =====
    // Yetkazildi → restoran ulushi balansga qo'shiladi
    if (statusChanged && status === 'delivered') {
      const { settleOrder } = await import('../services/billing.js');
      await settleOrder(order._id).catch((e) =>
        console.error('[billing] settleOrder:', e.message));
    }

    // Bekor qilindi → to'langan bo'lsa pul qaytariladi
    if (statusChanged && status === 'cancelled' && order.isPaid) {
      const { recordRefund } = await import('../services/billing.js');
      await recordRefund(order, order.paymentMethod).catch((e) =>
        console.error('[billing] recordRefund:', e.message));
    }

    // Faqat holat HAQIQATAN o'zgarganda xabar yuboramiz.
    // Tugma ikki marta bosilsa ham mijozga bitta xabar boradi.
    if (statusChanged && user?.telegramId && statusText[status]) {
      notifyUser(user.telegramId, statusText[status]);
    }

    res.json(order);
  }),

  // ===== RESTORAN BANNERI =====
  // PATCH /api/panel/orders/:id/paid — naqd to'lov qabul qilindi
  markPaid: asyncHandler(async (req, res) => {
    const order = await Order.findOneAndUpdate(
      { _id: req.params.id, restaurantId: rid(req) },
      { isPaid: req.body.paid !== false, paidAt: new Date() },
      { new: true },
    );
    if (!order) return res.status(404).json({ error: 'Buyurtma topilmadi' });

    // Naqd to'lov jurnalga tushadi.
    // Komissiya esa buyurtma yetkazilganda hisoblanadi (settleOrder).
    if (order.isPaid) {
      const { recordPayment } = await import('../services/billing.js');
      await recordPayment(order, 'cash').catch(() => {});
    }

    getIO()?.to('admin').emit('order:update', order);
    res.json(order);
  }),

  // PATCH /api/panel/me — restoran o'z ma'lumotlarini tahrirlaydi
  //
  // XAVFSIZLIK: shartnomaga tegishli maydonlar (komissiya, balans,
  // to'langan summa) va tizim maydonlari (isApproved, isBlocked,
  // ownerId) BU YERDA O'ZGARTIRILMAYDI. Ular faqat adminda.
  updateProfile: asyncHandler(async (req, res) => {
    const schema = z.object({
      // Asosiy
      name: z.string().min(2).max(80).optional(),
      cuisine: z.string().max(80).optional(),
      description: z.string().max(500).optional(),
      phone: z.string().max(30).optional(),
      imageUrl: z.string().url().or(z.literal('')).optional(),

      // Joylashuv
      address: z.string().max(200).optional(),
      landmark: z.string().max(200).optional(),
      lat: z.number().min(-90).max(90).nullable().optional(),
      lng: z.number().min(-180).max(180).nullable().optional(),

      // Ish vaqti
      openTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
      closeTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),

      // Yetkazish shartlari
      deliveryMin: z.number().int().min(0).max(300).optional(),
      deliveryMax: z.number().int().min(0).max(300).optional(),
      deliveryFee: z.number().min(0).max(500000).optional(),
      freeDeliveryThreshold: z.number().min(0).max(10000000).optional(),
      minOrderAmount: z.number().min(0).max(10000000).optional(),

      // Olib ketish
      pickupEnabled: z.boolean().optional(),
      pickupDiscountPercent: z.number().min(0).max(50).optional(),
      prepMinutes: z.number().int().min(1).max(240).optional(),

      // Stol bron qilish
      reservationEnabled: z.boolean().optional(),
      reservationNote: z.string().max(300).optional(),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'Ma\u2018lumot noto\u2018g\u2018ri',
        details: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      });
    }

    const data = { ...parsed.data };

    // Yetkazish vaqti mantiqiy bo'lsin
    if (data.deliveryMin != null && data.deliveryMax != null
        && data.deliveryMin > data.deliveryMax) {
      return res.status(400).json({
        error: 'Eng kam yetkazish vaqti eng ko\u2018pdan katta bo\u2018lmasligi kerak',
      });
    }

    // Rasm o'zgarsa images ham yangilanadi
    if (data.imageUrl) data.images = [data.imageUrl];

    const restaurant = await Restaurant.findByIdAndUpdate(
      rid(req), data, { new: true, runValidators: true },
    ).select('-ownerId -__v -balance -totalPaidOut -commissionPercent -commissionMode');

    if (!restaurant) return res.status(404).json({ error: 'Restoran topilmadi' });

    // Mijozlar ilovasida yangilansin
    getIO()?.emit('restaurant:update', { _id: String(restaurant._id) });

    res.json(restaurant);
  }),

  // GET /api/panel/banner — muassasa rasmi
  // Banner alohida saqlanmaydi: muassasa yozuvidagi rasm — banner.
  getBanner: asyncHandler(async (req, res) => {
    const r = await Restaurant.findById(rid(req)).select('imageUrl').lean();
    res.json(r?.imageUrl ? { imageUrl: r.imageUrl } : null);
  }),

  // PUT /api/panel/banner — rasmni almashtirish
  setBanner: asyncHandler(async (req, res) => {
    const schema = z.object({ imageUrl: z.string().min(1) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Banner rasmi majburiy' });

    const { imageUrl } = parsed.data;
    const restaurant = await Restaurant.findByIdAndUpdate(
      rid(req),
      { imageUrl, images: [imageUrl] },
      { new: true },
    ).select('imageUrl').lean();

    // Real-time: mijoz ilovasi va admin panel darhol yangilanadi
    const io = getIO();
    io?.to('admin').emit('restaurant:update', { _id: String(rid(req)) });

    res.json({ imageUrl: restaurant?.imageUrl || '' });
  }),

  // DELETE /api/panel/banner — rasmni olib tashlash
  deleteBanner: asyncHandler(async (req, res) => {
    await Restaurant.findByIdAndUpdate(rid(req), { imageUrl: '', images: [] });
    getIO()?.to('admin').emit('restaurant:update', { _id: String(rid(req)) });
    res.json({ ok: true });
  }),

};
