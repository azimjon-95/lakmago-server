import { asyncHandler } from '../middleware/error.js';
import { Order } from '../models/Order.js';
import { Table, DineInSession, DineInConfig } from '../models/DineIn.js';
import { Waiter } from '../models/Waiter.js';
import { Restaurant } from '../models/Restaurant.js';
import { calcDineInOrder, nextDineInNumber, getDineInMenu } from '../services/dineInPricing.js';
import { getIO } from '../sockets/io.js';

/**
 * Zal buyurtmalari.
 *
 * Ikki manba: QR (mijoz o'zi) va WAITER (ofitsiant).
 * QR buyurtmasi hech qachon ofitsiant buyurtmasiga aylanmaydi.
 */

export const dineInOrderController = {
  // GET /api/dine-in/menu/:restaurantId — zal narxlari bilan
  menu: asyncHandler(async (req, res) => {
    const cfg = await DineInConfig.findOne({ restaurantId: req.params.restaurantId }).lean();
    if (!cfg || cfg.status !== 'active') {
      return res.status(403).json({ error: 'Dine-in faol emas' });
    }

    const dishes = await getDineInMenu(req.params.restaurantId);
    res.json(dishes);
  }),

  /**
   * POST /api/dine-in/orders
   * { sessionId, items, note }
   *
   * Mijoz QR orqali buyurtma beradi. Login kerak emas.
   */
  createFromQr: asyncHandler(async (req, res) => {
    const session = await DineInSession.findById(req.body.sessionId);
    if (!session) {
      return res.status(404).json({ error: 'Sessiya topilmadi' });
    }

    // Yopilgan sessiyaga buyurtma qo'shib bo'lmaydi
    if (session.status !== 'active') {
      return res.status(400).json({
        error: 'Sessiya yopilgan. QR kodni qayta skanerlang.',
        code: 'SESSION_CLOSED',
      });
    }

    const cfg = await DineInConfig.findOne({ restaurantId: session.restaurantId }).lean();
    if (!cfg || cfg.status !== 'active') {
      return res.status(403).json({ error: 'Dine-in faol emas' });
    }

    // ===== SERVERDA QAYTA HISOB =====
    const calc = await calcDineInOrder(req.body.items, session.restaurantId, 'qr');
    if (!calc.ok) {
      return res.status(400).json({ error: calc.error, code: calc.code });
    }

    // ===== BONUS =====
    // Mijoz Telegram akkaunti bilan bog'langan bo'lsa
    // bonusini ishlatishi mumkin. Balans SERVERDA tekshiriladi.
    let bonusUsed = 0;
    const userId = req.userId || null;

    if (userId && req.body.useBonus) {
      const { User } = await import('../models/User.js');
      const { getSettings } = await import('../models/Settings.js');

      const [user, settings] = await Promise.all([
        User.findById(userId).select('bonusBalance').lean(),
        getSettings(),
      ]);

      const balance = user?.bonusBalance || 0;
      if (balance > 0) {
        // Chegirma qo'shish qoidasi
        const allowStacking = Boolean(settings.allowDiscountStacking);
        const canUseBonus = allowStacking || !calc.promoDiscount
          || calc.promoDiscount < balance;

        if (canUseBonus) {
          bonusUsed = Math.min(balance, calc.total);
        }
      }
    }

    const order = await createOrder({
      session,
      calc,
      orderSource: 'qr',
      note: req.body.note,
      userId,
      bonusUsed,
    });

    // Bonus balansidan yechamiz
    if (bonusUsed > 0) {
      const { User } = await import('../models/User.js');
      await User.findByIdAndUpdate(userId, { $inc: { bonusBalance: -bonusUsed } });
    }

    notifyNewOrder(order, session);
    res.status(201).json(order);
  }),

  /**
   * POST /api/waiter/orders
   * { tableId, items, note }
   *
   * Ofitsiant buyurtmasi — xizmat haqi qo'llanadi.
   */
  createFromWaiter: asyncHandler(async (req, res) => {
    const table = await Table.findOne({
      _id: req.body.tableId,
      restaurantId: req.restaurantId,
    });
    if (!table) return res.status(404).json({ error: 'Stol topilmadi' });

    const waiter = await Waiter.findById(req.waiterId).lean();
    if (!waiter) return res.status(404).json({ error: 'Ofitsiant topilmadi' });

    // Stol biriktirilganmi
    if (waiter.tableIds?.length) {
      const allowed = waiter.tableIds.some((id) => String(id) === String(table._id));
      if (!allowed) {
        return res.status(403).json({ error: 'Bu stol sizga biriktirilmagan' });
      }
    }

    // Sessiya — bo'lmasa yaratamiz
    let session = await DineInSession.findOne({
      tableId: table._id, status: 'active',
    });

    if (!session) {
      session = await DineInSession.create({
        restaurantId: table.restaurantId,
        branchId: table.branchId || table.restaurantId,
        tableId: table._id,
        deviceSessionId: `waiter_${waiter._id}`,
        status: 'active',
      });
      await Table.findByIdAndUpdate(table._id, {
        status: 'occupied',
        $inc: { totalSessions: 1 },
        lastSessionAt: new Date(),
      });
    }

    const calc = await calcDineInOrder(req.body.items, req.restaurantId, 'waiter');
    if (!calc.ok) {
      return res.status(400).json({ error: calc.error, code: calc.code });
    }

    const order = await createOrder({
      session,
      calc,
      orderSource: 'waiter',
      waiter,
      note: req.body.note,
    });

    // Xizmat haqi — ofitsiant daromadi
    if (calc.serviceFee > 0) {
      await Waiter.findByIdAndUpdate(waiter._id, {
        $inc: {
          'earnings.total': calc.serviceFee,
          'earnings.orders': 1,
        },
      });
    }

    notifyNewOrder(order, session);
    res.status(201).json(order);
  }),

  // GET /api/dine-in/orders/:sessionId — sessiya buyurtmalari
  sessionOrders: asyncHandler(async (req, res) => {
    const session = await DineInSession.findById(req.params.sessionId).lean();
    if (!session) return res.status(404).json({ error: 'Sessiya topilmadi' });

    const orders = await Order.find({ dineInSessionId: session._id })
      .sort({ createdAt: -1 })
      .lean();

    const total = orders
      .filter((o) => o.status !== 'cancelled')
      .reduce((s, o) => s + (o.total || 0), 0);

    res.json({ orders, total, sessionStatus: session.status });
  }),

  // GET /api/waiter/orders — ofitsiant o'z buyurtmalari
  waiterOrders: asyncHandler(async (req, res) => {
    const filter = { waiterId: req.waiterId, fulfillment: 'dinein' };

    if (req.query.active === '1') {
      filter.status = { $nin: ['completed', 'cancelled'] };
    }

    const orders = await Order.find(filter)
      .populate('tableId', 'tableNumber tableName')
      .sort({ createdAt: -1 })
      .limit(Number(req.query.limit) || 50)
      .lean();

    // Bugungi jamlanma
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const today = await Order.aggregate([
      {
        $match: {
          waiterId: req.waiterId,
          status: { $ne: 'cancelled' },
          createdAt: { $gte: todayStart },
        },
      },
      {
        $group: {
          _id: null,
          orders: { $sum: 1 },
          sales: { $sum: '$total' },
          serviceFee: { $sum: '$serviceFee' },
        },
      },
    ]);

    res.json({
      orders,
      today: today[0] || { orders: 0, sales: 0, serviceFee: 0 },
    });
  }),

  // PATCH /api/panel/dine-in/orders/:id/status
  updateStatus: asyncHandler(async (req, res) => {
    const allowed = ['accepted', 'preparing', 'ready', 'served', 'completed', 'cancelled'];
    const status = req.body.status;

    if (!allowed.includes(status)) {
      return res.status(400).json({ error: 'Noto\u2018g\u2018ri holat' });
    }

    // Buyurtma O'CHIRILMAYDI — faqat holat o'zgaradi.
    // Bekor qilish ham holat, yozuv saqlanadi.
    const order = await Order.findOneAndUpdate(
      {
        _id: req.params.id,
        restaurantId: req.restaurantId,
        fulfillment: 'dinein',
      },
      {
        status,
        updatedBy: req.userId || req.waiterId || null,
        updatedByRole: req.waiterId ? 'waiter' : 'restaurant',
        ...(status === 'cancelled' ? { cancelledAt: new Date() } : {}),
      },
      { new: true },
    );

    if (!order) return res.status(404).json({ error: 'Buyurtma topilmadi' });

    // Bekor qilinganda bonus qaytariladi
    if (status === 'cancelled' && order.bonusUsed > 0 && order.userId) {
      const { User } = await import('../models/User.js');
      await User.findByIdAndUpdate(order.userId, {
        $inc: { bonusBalance: order.bonusUsed },
      });
    }

    // Yakunlanganda komissiya yoziladi
    if (status === 'completed') {
      const { recordDineInCommission } = await import('../services/dineInBilling.js');
      recordDineInCommission(order).catch((e) => console.error('[dinein-comm]', e.message));
    }

    const io = getIO();
    // Mijozga — sessiya xonasi orqali
    io?.to(`session:${order.dineInSessionId}`).emit('dinein:status', {
      orderId: String(order._id),
      status,
      dineInNumber: order.dineInNumber,
    });
    io?.to(`restaurant:${order.restaurantId}`).emit('dinein:order', order);

    res.json(order);
  }),

  /**
   * GET /api/panel/dine-in/orders
   *
   * active=1 — faqat faol (jonli sahifa uchun)
   * Aks holda tarix: sahifalash, sana va manba filtri.
   */
  panelOrders: asyncHandler(async (req, res) => {
    const filter = {
      restaurantId: req.restaurantId,
      fulfillment: 'dinein',
    };

    if (req.query.active === '1') {
      filter.status = { $nin: ['completed', 'cancelled'] };

      const orders = await Order.find(filter)
        .populate('tableId', 'tableNumber tableName')
        .sort({ createdAt: -1 })
        .limit(100)
        .lean();

      return res.json(orders);
    }

    // ===== TARIX =====
    if (req.query.status) filter.status = req.query.status;
    if (req.query.source) filter.orderSource = req.query.source;

    if (req.query.from || req.query.to) {
      filter.createdAt = {};
      if (req.query.from) filter.createdAt.$gte = new Date(req.query.from);
      if (req.query.to) {
        const to = new Date(req.query.to);
        to.setHours(23, 59, 59, 999);
        filter.createdAt.$lte = to;
      }
    }

    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Number(req.query.limit) || 25);

    const [orders, total, totals] = await Promise.all([
      Order.find(filter)
        .populate('tableId', 'tableNumber tableName')
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Order.countDocuments(filter),
      Order.aggregate([
        { $match: { ...filter, status: { $ne: 'cancelled' } } },
        {
          $group: {
            _id: null,
            revenue: { $sum: '$total' },
            serviceFee: { $sum: '$serviceFee' },
            discount: { $sum: '$promotionDiscount' },
          },
        },
      ]),
    ]);

    res.json({
      orders,
      page,
      pages: Math.ceil(total / limit),
      total,
      summary: totals[0] || { revenue: 0, serviceFee: 0, discount: 0 },
    });
  }),
};

/** Buyurtma yaratish — ikkala manba uchun umumiy. */
async function createOrder({ session, calc, orderSource, waiter, note, userId, bonusUsed }) {
  const dineInNumber = await nextDineInNumber(session.restaurantId);

  // restaurantName sxemada majburiy — berilmasa buyurtma saqlanmaydi
  const restaurant = await Restaurant.findById(session.restaurantId)
    .select('name').lean();

  const order = await Order.create({
    restaurantId: session.restaurantId,
    restaurantName: restaurant?.name || 'Restoran',
    fulfillment: 'dinein',
    orderSource,

    tableId: session.tableId,
    dineInSessionId: session._id,
    deviceSessionId: session.deviceSessionId,
    dineInNumber,

    ...(waiter ? {
      waiterId: waiter._id,
      waiterName: [waiter.firstName, waiter.lastName].filter(Boolean).join(' '),
    } : {}),

    items: calc.items,
    subtotal: calc.subtotal,
    serviceFee: calc.serviceFee,
    deliveryFee: 0,

    // Aksiya — serverda hisoblangan
    promotionId: calc.promotion?.promotionId || null,
    promotionName: calc.promotion?.promotionName || '',
    promotionDiscount: calc.promoDiscount || 0,

    bonusUsed: bonusUsed || 0,
    total: Math.max(0, calc.total - (bonusUsed || 0)),

    ...(userId ? { userId } : {}),

    status: 'pending',
    note: String(note || '').slice(0, 300),
    paymentMethod: 'cash',

    // Audit
    createdBy: waiter?._id || userId || null,
    createdByRole: orderSource === 'waiter' ? 'waiter' : 'user',
  });

  // Aksiya hisobini yangilaymiz
  if (calc.promotion) {
    const { markPromotionUsed } = await import('../services/promotions.js');
    markPromotionUsed(calc.promotion.promotionId, calc.promoDiscount, order.total)
      .catch((e) => console.error('[promo]', e.message));
  }

  // Sessiyaga bog'laymiz
  await DineInSession.findByIdAndUpdate(session._id, {
    $push: { orderIds: order._id },
  });

  await Table.findByIdAndUpdate(session.tableId, { status: 'ordering' });

  return order;
}

/** Restoran paneliga xabar — ovoz va bildirishnoma uchun. */
function notifyNewOrder(order, session) {
  const io = getIO();
  io?.to(`restaurant:${order.restaurantId}`).emit('dinein:new', {
    orderId: String(order._id),
    dineInNumber: order.dineInNumber,
    tableId: String(session.tableId),
    total: order.total,
    orderSource: order.orderSource,
    itemCount: order.items?.length || 0,
  });
}
