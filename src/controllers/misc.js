import { z } from 'zod';
import { asyncHandler } from '../middleware/error.js';
import { signToken, verifyTelegramInitData } from '../middleware/auth.js';
import { Banner } from '../models/User.js';
import { Restaurant } from '../models/Restaurant.js';
import { User } from '../models/User.js';
import { Order } from '../models/Order.js';
import { getIO } from '../sockets/io.js';
import { notifyUser } from '../services/telegram.js';
import { parseReferralCode, attachReferral, rewardReferralIfSubscribed, checkChannelSubscription, buildReferralLink } from '../services/referral.js';

export const bannerController = {
  // GET /api/banners — mijozга ko'rinadigan bannerlar
  list: asyncHandler(async (_req, res) => {
    const banners = await Banner.find({ active: true }).sort({ order: 1 }).lean();

    // Restoran bannerlari orasidan bloklangan/nofaol muassasalarникini olib tashlaymiz
    const restaurantBanners = banners.filter((b) => b.kind === 'restaurant' && b.restaurantId);
    const validRestIds = new Set();
    if (restaurantBanners.length) {
      const rests = await Restaurant.find({
        _id: { $in: restaurantBanners.map((b) => b.restaurantId) },
        isBlocked: { $ne: true },
        isActive: true,
      }).select('_id').lean();
      rests.forEach((r) => validRestIds.add(String(r._id)));
    }

    const visible = banners.filter((b) => {
      if (b.kind !== 'restaurant') return true; // platforma bannerlari doim ko'rinadi
      return validRestIds.has(String(b.restaurantId));
    });
    res.json(visible);
  }),
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

      // Yangi foydalanuvchи referal havola bilan kelган bo'lsa — bog'laymiz
      const startParam = req.body.startParam || req.body.start_param;
      const refCode = parseReferralCode(startParam);
      if (refCode) {
        try { await attachReferral(user, refCode); } catch { /* jim */ }
      }
    } else {
      Object.assign(user, profileFields);
      await user.save();
    }

    // 3) Referal bonusини tekshirish (obuna bo'lган bo'lsa beramiz)
    if (user.referredBy && !user.referralRewarded) {
      try { await rewardReferralIfSubscribed(user); } catch { /* jim */ }
    }

    // 4) JWT qaytarish
    const token = signToken(String(user._id), user.role ?? 'customer');
    res.json({ token, user, isNewUser });
  })
};

// MongoDB ObjectId formatи (24 belgili hex)
const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i, 'ID formatи noto\u2018g\u2018ri (ObjectId kutiladi)');

// Bitta restoran buyurtmasi sxemasi
const singleOrderSchema = z.object({
  restaurantId: objectIdSchema,
  restaurantName: z.string(),
  items: z.array(z.object({
    dishId: objectIdSchema.optional(),
    name: z.string(),
    quantity: z.number().int().positive(),
    unitPrice: z.number().nonnegative(),
    selectedOptions: z.array(z.object({ name: z.string(), price: z.number() })).optional(),
    note: z.string().optional(),
  })).min(1),
  subtotal: z.number(),
  deliveryFee: z.number().default(0),
  serviceFee: z.number().default(0),
  etaMinutes: z.number().optional(),
});

// Mijoz bir vaqtda bir necha restorandan buyurtma qilishi mumkin.
// { orders: [...], address, phone, paymentMethod } — har biri alohida Order bo'ladi,
// bitta groupId bilan bog'lanadi.
const batchOrderSchema = z.object({
  orders: z.array(singleOrderSchema).min(1),
  // Yetkazish turi: kuryer yoki o'zi olib ketish
  fulfillment: z.enum(['delivery', 'pickup']).default('delivery'),
  // Manzil — yetkazishda majburiy (pastda tekshiriladi)
  address: z.string().default(''),
  // Vaqt: darhol (tayyor bo'lishi bilan) yoki belgilangan vaqtga
  timingMode: z.enum(['asap', 'scheduled']).default('asap'),
  scheduledFor: z.string().datetime().optional(),
  phone: z.string().optional(),
  paymentMethod: z.enum(['payme', 'click', 'uzum', 'cash']).default('cash'),
  paymentLabel: z.string().optional(),
  useBonus: z.number().nonnegative().default(0), // ishlatmoqchi bo'lган bonus (so'm)
});

const COURIERS = ['Aziz', 'Bek', 'Dilshod', 'Jasur', 'Sardor', 'Ulug\'bek'];

export const orderController = {
  // POST /api/orders
  // Bir yoki bir necha restoran buyurtmasini qabul qiladi (batch).
  create: asyncHandler(async (req, res) => {
    const parsed = batchOrderSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Ma\u2018lumot noto\u2018g\u2018ri', details: parsed.error.issues });
    }
    const { orders, address, phone, paymentMethod, paymentLabel, useBonus,
            fulfillment, timingMode, scheduledFor } = parsed.data;

    // Yetkazishda manzil majburiy, olib ketishda shart emas
    if (fulfillment === 'delivery' && !address.trim()) {
      return res.status(400).json({ error: 'Yetkazish uchun manzil kiriting' });
    }
    // Belgilangan vaqt tanlansa — u kelajakda bo'lishi kerak
    const scheduledDate = scheduledFor ? new Date(scheduledFor) : null;
    if (timingMode === 'scheduled') {
      if (!scheduledDate || isNaN(scheduledDate.getTime())) {
        return res.status(400).json({ error: 'Vaqt noto\u2018g\u2018ri' });
      }
      if (scheduledDate.getTime() < Date.now() - 60_000) {
        return res.status(400).json({ error: 'Tanlangan vaqt o\u2018tib ketgan' });
      }
    }

    // Olib ketishda yetkazish haqi olinmaydi
    const isPickup = fulfillment === 'pickup';
    const groupId = 'G' + Date.now() + Math.floor(Math.random() * 1000);
    const io = getIO();

    // ===== BONUS BILAN TO'LASH =====
    // Butun buyurtма summasi (barcha restoranlar)
    const grandTotal = orders.reduce(
      (s, o) => s + o.subtotal + (isPickup ? 0 : (o.deliveryFee || 0)) + (o.serviceFee || 0), 0,
    );
    // Ishlatiladigan bonus: so'ralган, lekin balansдан va summадан oshмаsин
    let bonusToUse = 0;
    if (useBonus > 0) {
      const user = await User.findById(req.userId).select('bonusBalance');
      const available = user?.bonusBalance || 0;
      bonusToUse = Math.min(useBonus, available, grandTotal);
      // Atomik ayirish (poyga holatини oldini oladi — faqat yetarli bo'lsa)
      if (bonusToUse > 0) {
        const upd = await User.updateOne(
          { _id: req.userId, bonusBalance: { $gte: bonusToUse } },
          { $inc: { bonusBalance: -bonusToUse } },
        );
        if (upd.modifiedCount === 0) bonusToUse = 0; // balans yetмади
      }
    }
    let bonusLeft = bonusToUse; // buyurtмаларга taqsimlаnadi

    const created = [];
    for (let i = 0; i < orders.length; i++) {
      const o = orders[i];
      // Olib ketishda yetkazish haqi yo'q
      const fee = isPickup ? 0 : (o.deliveryFee || 0);
      const orderTotal = o.subtotal + fee + (o.serviceFee || 0);
      // Bonusni shu buyurtmaga qo'llaymiz (ketma-ket, oshib ketmasin)
      const orderBonus = Math.min(bonusLeft, orderTotal);
      bonusLeft -= orderBonus;
      const total = orderTotal - orderBonus;

      const doc = await Order.create({
        userId: req.userId,
        restaurantId: o.restaurantId,
        restaurantName: o.restaurantName,
        groupId,
        items: o.items,
        subtotal: o.subtotal,
        deliveryFee: fee,
        serviceFee: o.serviceFee || 0,
        bonusUsed: orderBonus,
        total,
        status: 'pending',
        fulfillment,
        address: isPickup ? '' : address,
        timingMode,
        scheduledFor: scheduledDate,
        phone,
        paymentMethod,
        paymentLabel,
        etaMinutes: o.etaMinutes,
        // Kuryer faqat yetkazishda tayinlanadi
        ...(isPickup ? {} : { courierName: COURIERS[Math.floor(Math.random() * COURIERS.length)] }),
      });
      created.push(doc);

      // Real-time: restoranга yangi buyurtma (signal chalinadi)
      io?.to(`restaurant:${o.restaurantId}`).emit('order:new', doc);
      io?.to('admin').emit('order:new', doc);
    }

    res.status(201).json({ groupId, orders: created, bonusUsed: bonusToUse });
  }),

  // GET /api/orders  (foydalanuvchi buyurtmalari — groupId bo'yicha guruhlangan)
  myOrders: asyncHandler(async (req, res) => {
    const orders = await Order.find({ userId: req.userId }).sort({ createdAt: -1 });
    res.json(orders);
  }),

  // GET /api/orders/group/:groupId  (bitta buyurtma = bir necha restoran)
  getGroup: asyncHandler(async (req, res) => {
    const orders = await Order.find({ groupId: req.params.groupId, userId: req.userId }).sort({ createdAt: 1 });
    if (orders.length === 0) return res.status(404).json({ error: 'Buyurtma topilmadi' });
    res.json(orders);
  }),

  // GET /api/orders/active  (mijozning faol buyurtmalari)
  active: asyncHandler(async (req, res) => {
    const orders = await Order.find({
      userId: req.userId,
      status: { $nin: ['delivered', 'cancelled'] },
    }).sort({ createdAt: -1 });
    res.json(orders);
  }),

  // GET /api/orders/:id
  getOne: asyncHandler(async (req, res) => {
    if (!/^[a-f\d]{24}$/i.test(req.params.id)) return res.status(404).json({ error: 'Buyurtma topilmadi' });
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Buyurtma topilmadi' });
    res.json(order);
  }),

  // PATCH /api/orders/:id/confirm  — mijoz "Ha, oldim" (delivered) + baho
  confirmDelivery: asyncHandler(async (req, res) => {
    const { rating, comment } = req.body;
    const update = { status: 'delivered', deliveredAt: new Date() };
    if (rating) { update.rating = rating; update.comment = comment; update.ratedAt = new Date(); }
    const order = await Order.findOneAndUpdate(
      { _id: req.params.id, userId: req.userId },
      update,
      { new: true },
    );
    if (!order) return res.status(404).json({ error: 'Buyurtma topilmadi' });

    getIO()?.to(`restaurant:${order.restaurantId}`).emit('order:update', order);
    getIO()?.to('admin').emit('order:update', order);
    res.json(order);
  }),

  // PATCH /api/orders/:id/status  { status }  (restoran/admin)
  updateStatus: asyncHandler(async (req, res) => {
    const { status } = req.body;
    const order = await Order.findByIdAndUpdate(req.params.id, { status }, { new: true }).populate('userId');
    if (!order) return res.status(404).json({ error: 'Buyurtma topilmadi' });

    getIO()?.to(`order:${order._id}`).emit('order:status', { orderId: order._id, status: order.status });

    const user = order.userId;
    const statusText = {
      preparing: '\ud83d\udc68\u200d\ud83c\udf73 Buyurtmangiz tayyorlanmoqda',
      delivering: '\ud83d\udeb4 Buyurtmangiz yo\u2018lda',
      delivered: '\u2705 Buyurtmangiz yetkazildi. Yoqimli ishtaha!',
    };
    if (user?.telegramId && statusText[status]) {
      notifyUser(user.telegramId, statusText[status]);
    }
    res.json(order);
  }),
};
