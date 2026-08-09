import { asyncHandler } from '../middleware/error.js';
import { Table, DineInSession, TableRequest, DineInConfig } from '../models/DineIn.js';
import { Order } from '../models/Order.js';
import { Waiter } from '../models/Waiter.js';
import { Ledger } from '../models/Ledger.js';
import { getIO } from '../sockets/io.js';
import { notify } from '../services/notifications.js';

/**
 * Zal jonli boshqaruvi: so'rovlar, sessiya, statistika, chek.
 *
 * Mavjud Socket.IO ishlatiladi — yangi ulanish yaratilmaydi.
 */

// Spam oldini olish: shu muddat ichida qayta chaqirib bo'lmaydi
const REQUEST_COOLDOWN_MS = 90_000;

export const dineInLiveController = {
  // ═══ MIJOZ: chaqiruv va hisob ═══

  /**
   * POST /api/dine-in/request  { sessionId, type }
   * type: 'waiter' | 'bill'
   */
  createRequest: asyncHandler(async (req, res) => {
    const type = req.body.type;
    if (!['waiter', 'bill'].includes(type)) {
      return res.status(400).json({ error: 'Noto\u2018g\u2018ri so\u2018rov turi' });
    }

    const session = await DineInSession.findById(req.body.sessionId);
    if (!session || session.status !== 'active') {
      return res.status(400).json({ error: 'Sessiya faol emas' });
    }

    // Yaqinda shunday so'rov yuborilganmi
    const recent = await TableRequest.findOne({
      tableId: session.tableId,
      type,
      status: { $ne: 'done' },
      createdAt: { $gte: new Date(Date.now() - REQUEST_COOLDOWN_MS) },
    });

    if (recent) {
      return res.status(429).json({
        error: recent.status === 'accepted'
          ? 'Ofitsiant xabardor qilindi'
          : 'So\u2018rovingiz yuborilgan, biroz kuting',
        code: 'COOLDOWN',
        request: recent,
      });
    }

    const request = await TableRequest.create({
      restaurantId: session.restaurantId,
      tableId: session.tableId,
      sessionId: session._id,
      type,
    });

    // Stol holatini yangilaymiz
    if (type === 'bill') {
      await Table.findByIdAndUpdate(session.tableId, { status: 'waiting' });
    }

    const table = await Table.findById(session.tableId)
      .select('tableNumber tableName').lean();

    const io = getIO();
    const payload = {
      id: String(request._id),
      type,
      tableId: String(session.tableId),
      tableNumber: table?.tableNumber,
      tableName: table?.tableName,
      createdAt: request.createdAt,
    };

    // Restoran paneli va ofitsiantlar
    io?.to(`restaurant:${session.restaurantId}`).emit('dinein:request', payload);

    const tableLabel = table?.tableName || `Stol ${table?.tableNumber ?? ''}`;
    notify({
      notificationId: `request:${request._id}`,
      audience: 'restaurant',
      restaurantId: session.restaurantId,
      type: type === 'bill' ? 'bill_request' : 'waiter_call',
      title: type === 'bill' ? 'Hisob so\u2018raldi' : 'Ofitsiant chaqirilmoqda',
      body: tableLabel,
      refType: 'table',
      refId: session.tableId,
      meta: { requestType: type, tableNumber: table?.tableNumber },
    }).catch((e) => console.error('[notify:request]', e.message));

    res.status(201).json(request);
  }),

  // GET /api/dine-in/requests/:sessionId — mijoz o'z so'rovlarini ko'radi
  mySessionRequests: asyncHandler(async (req, res) => {
    const requests = await TableRequest.find({
      sessionId: req.params.sessionId,
      status: { $ne: 'done' },
    }).sort({ createdAt: -1 }).limit(5).lean();

    res.json(requests);
  }),

  // ═══ RESTORAN / OFITSIANT: so'rovlarni boshqarish ═══

  // GET /api/panel/dine-in/requests
  listRequests: asyncHandler(async (req, res) => {
    const filter = {
      restaurantId: req.restaurantId,
      status: { $ne: 'done' },
    };

    // Ofitsiant faqat O'Z stollari so'rovlarini ko'radi
    if (req.waiterId) {
      const w = await Waiter.findById(req.waiterId).select('tableIds').lean();
      if (w?.tableIds?.length) {
        filter.tableId = { $in: w.tableIds };
      }
    }

    const requests = await TableRequest.find(filter)
      .populate('tableId', 'tableNumber tableName')
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();

    res.json(requests);
  }),

  // PATCH /api/panel/dine-in/requests/:id  { status }
  updateRequest: asyncHandler(async (req, res) => {
    const status = req.body.status;
    if (!['accepted', 'done'].includes(status)) {
      return res.status(400).json({ error: 'Noto\u2018g\u2018ri holat' });
    }

    const update = { status };
    if (status === 'accepted') {
      update.acceptedAt = new Date();
      if (req.waiterId) {
        const w = await Waiter.findById(req.waiterId).select('firstName lastName').lean();
        update.acceptedBy = req.waiterId;
        update.acceptedByName = [w?.firstName, w?.lastName].filter(Boolean).join(' ');
      }
    } else {
      update.doneAt = new Date();
    }

    const query = { _id: req.params.id, restaurantId: req.restaurantId };

    // Ofitsiant boshqa stolga tegmasin
    if (req.waiterId) {
      const w = await Waiter.findById(req.waiterId).select('tableIds').lean();
      if (w?.tableIds?.length) {
        query.tableId = { $in: w.tableIds };
      }
    }

    const request = await TableRequest.findOneAndUpdate(query, update, { new: true });

    if (!request) {
      return res.status(404).json({ error: 'So\u2018rov topilmadi yoki sizga tegishli emas' });
    }

    const io = getIO();
    // Mijozga javob
    io?.to(`session:${request.sessionId}`).emit('dinein:request-update', {
      id: String(request._id),
      type: request.type,
      status: request.status,
      acceptedByName: request.acceptedByName,
    });
    io?.to(`restaurant:${req.restaurantId}`).emit('dinein:request-update', request);

    res.json(request);
  }),

  // ═══ SESSIYA ═══

  /**
   * POST /api/panel/dine-in/tables/:tableId/close
   *
   * Stolni yopadi. Eski buyurtmalar yangi mijozga ko'rinmaydi.
   */
  closeTable: asyncHandler(async (req, res) => {
    const table = await Table.findOne({
      _id: req.params.tableId,
      restaurantId: req.restaurantId,
    });
    if (!table) return res.status(404).json({ error: 'Stol topilmadi' });

    const session = await DineInSession.findOne({
      tableId: table._id, status: 'active',
    });

    if (!session) {
      await Table.findByIdAndUpdate(table._id, { status: 'available' });
      return res.json({ closed: true, message: 'Stol bo\u2018shatildi' });
    }

    // Tugallanmagan buyurtmalar bormi
    const openOrders = await Order.countDocuments({
      dineInSessionId: session._id,
      status: { $nin: ['completed', 'cancelled', 'served'] },
    });

    if (openOrders > 0 && req.body.force !== true) {
      return res.status(400).json({
        error: `${openOrders} ta buyurtma hali yakunlanmagan`,
        code: 'OPEN_ORDERS',
        openOrders,
      });
    }

    // Qolgan buyurtmalarni yakunlaymiz
    await Order.updateMany(
      { dineInSessionId: session._id, status: { $nin: ['cancelled'] } },
      { status: 'completed' },
    );

    session.status = 'closed';
    session.closedAt = new Date();
    session.closeReason = String(req.body.reason || 'Admin yopdi').slice(0, 200);
    await session.save();

    await Table.findByIdAndUpdate(table._id, { status: 'available' });

    // Ochiq so'rovlarni yopamiz
    await TableRequest.updateMany(
      { sessionId: session._id, status: { $ne: 'done' } },
      { status: 'done', doneAt: new Date() },
    );

    const io = getIO();
    io?.to(`session:${session._id}`).emit('dinein:session-closed', {});
    io?.to(`restaurant:${req.restaurantId}`).emit('table:update', {
      tableId: String(table._id), status: 'available',
    });

    res.json({ closed: true, sessionId: String(session._id) });
  }),

  /**
   * GET /api/dine-in/receipt/:sessionId — chek
   *
   * Mijoz va restoran uchun bir xil.
   */
  receipt: asyncHandler(async (req, res) => {
    const session = await DineInSession.findById(req.params.sessionId).lean();
    if (!session) return res.status(404).json({ error: 'Sessiya topilmadi' });

    const [orders, table, config] = await Promise.all([
      Order.find({
        dineInSessionId: session._id,
        status: { $ne: 'cancelled' },
      }).sort({ createdAt: 1 }).lean(),
      Table.findById(session.tableId).select('tableNumber tableName').lean(),
      DineInConfig.findOne({ restaurantId: session.restaurantId }).lean(),
    ]);

    const { Restaurant } = await import('../models/Restaurant.js');
    const restaurant = await Restaurant.findById(session.restaurantId)
      .select('name address phone imageUrl').lean();

    // Barcha taomlarni birlashtiramiz
    const lines = [];
    let subtotal = 0;
    let serviceFee = 0;
    let discount = 0;

    for (const o of orders) {
      for (const it of o.items || []) {
        lines.push({
          name: it.name,
          quantity: it.quantity,
          unitPrice: it.unitPrice,
          total: it.unitPrice * it.quantity,
          orderNumber: o.dineInNumber,
        });
      }
      subtotal += o.subtotal || 0;
      serviceFee += o.serviceFee || 0;
      discount += (o.promotionDiscount || 0) + (o.bonusUsed || 0);
    }

    res.json({
      restaurant,
      table,
      session: {
        id: String(session._id),
        status: session.status,
        startedAt: session.createdAt,
        closedAt: session.closedAt,
      },
      orders: orders.map((o) => ({
        number: o.dineInNumber,
        total: o.total,
        status: o.status,
        createdAt: o.createdAt,
      })),
      lines,
      subtotal,
      serviceFee,
      discount,
      total: subtotal + serviceFee - discount,
      serviceFeeLabel: config?.serviceFeeEnabled
        ? (config.serviceFeeType === 'percentage'
          ? `Xizmat haqi ${config.serviceFeeValue}%`
          : 'Xizmat haqi')
        : 'Xizmat haqi',
    });
  }),

  // ═══ DASHBOARD ═══

  // GET /api/panel/dine-in/dashboard
  dashboard: asyncHandler(async (req, res) => {
    const restaurantId = req.restaurantId;
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const [todayOrders, activeSessions, preparing, requests] = await Promise.all([
      Order.find({
        restaurantId,
        fulfillment: 'dinein',
        createdAt: { $gte: todayStart },
        status: { $ne: 'cancelled' },
      }).select('total serviceFee status orderSource').lean(),

      DineInSession.countDocuments({ restaurantId, status: 'active' }),

      Order.countDocuments({
        restaurantId,
        fulfillment: 'dinein',
        status: { $in: ['pending', 'accepted', 'preparing'] },
      }),

      TableRequest.find({
        restaurantId,
        status: { $ne: 'done' },
      }).populate('tableId', 'tableNumber tableName').lean(),
    ]);

    const revenue = todayOrders.reduce((s, o) => s + (o.total || 0), 0);
    const serviceFees = todayOrders.reduce((s, o) => s + (o.serviceFee || 0), 0);

    res.json({
      bugungiBuyurtmalar: todayOrders.length,
      bugungiTushum: revenue,
      xizmatHaqi: serviceFees,
      faolStollar: activeSessions,
      tayyorlanmoqda: preparing,
      hisobSoragan: requests.filter((r) => r.type === 'bill'),
      ofitsiantChaqirgan: requests.filter((r) => r.type === 'waiter'),
      qrBuyurtmalar: todayOrders.filter((o) => o.orderSource === 'qr').length,
      ofitsiantBuyurtmalar: todayOrders.filter((o) => o.orderSource === 'waiter').length,
    });
  }),

  // ═══ OFITSIANT DAROMADI ═══

  // GET /api/panel/waiters/earnings?period=today|week|month
  waiterEarnings: asyncHandler(async (req, res) => {
    const period = req.query.period || 'month';
    const from = periodStart(period, req.query.from);
    const to = req.query.to ? new Date(req.query.to) : new Date();

    const waiters = await Waiter.find({ restaurantId: req.restaurantId })
      .select('firstName lastName earnings isActive')
      .lean();

    const ids = waiters.map((w) => w._id);

    // Davr ichidagi buyurtmalar
    const orders = await Order.aggregate([
      {
        $match: {
          restaurantId: req.restaurantId,
          waiterId: { $in: ids },
          status: { $ne: 'cancelled' },
          createdAt: { $gte: from, $lte: to },
        },
      },
      {
        $group: {
          _id: '$waiterId',
          sales: { $sum: '$total' },
          serviceFee: { $sum: '$serviceFee' },
          orders: { $sum: 1 },
        },
      },
    ]);

    // To'langan summalar
    const payouts = await Ledger.aggregate([
      {
        $match: {
          type: 'waiter_payout',
          waiterId: { $in: ids },
        },
      },
      { $group: { _id: '$waiterId', paid: { $sum: { $abs: '$amount' } } } },
    ]);

    const orderMap = new Map(orders.map((o) => [String(o._id), o]));
    const paidMap = new Map(payouts.map((p) => [String(p._id), p.paid]));

    res.json({
      period,
      from,
      to,
      waiters: waiters.map((w) => {
        const id = String(w._id);
        const stat = orderMap.get(id) || { sales: 0, serviceFee: 0, orders: 0 };
        const paid = paidMap.get(id) || 0;
        const earned = w.earnings?.total || 0;

        return {
          _id: w._id,
          fullName: [w.firstName, w.lastName].filter(Boolean).join(' '),
          isActive: w.isActive,
          // Davr bo'yicha
          savdo: stat.sales,
          xizmatHaqi: stat.serviceFee,
          buyurtmalar: stat.orders,
          // Umumiy
          jamiDaromad: earned,
          tolangan: paid,
          qoldiq: Math.max(0, earned - paid),
        };
      }),
    });
  }),

  /**
   * POST /api/panel/waiters/:id/payout  { amount, note }
   *
   * Ofitsiantga xizmat haqini to'lash.
   * Ikki marta hisoblanmasligi uchun Ledger yozuvi yaratiladi
   * va qoldiq shundan hisoblanadi.
   */
  payWaiter: asyncHandler(async (req, res) => {
    const waiter = await Waiter.findOne({
      _id: req.params.id,
      restaurantId: req.restaurantId,
    });
    if (!waiter) return res.status(404).json({ error: 'Ofitsiant topilmadi' });

    const amount = Number(req.body.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: 'Summa noto\u2018g\u2018ri' });
    }

    // Qoldiqni hisoblaymiz
    const paidRows = await Ledger.aggregate([
      { $match: { type: 'waiter_payout', waiterId: waiter._id } },
      { $group: { _id: null, total: { $sum: { $abs: '$amount' } } } },
    ]);

    const alreadyPaid = paidRows[0]?.total || 0;
    const earned = waiter.earnings?.total || 0;
    const remaining = earned - alreadyPaid;

    if (amount > remaining) {
      return res.status(400).json({
        error: `Qoldiq ${remaining.toLocaleString('ru-RU')} so\u2018m. `
          + 'Bundan ko\u2018p to\u2018lab bo\u2018lmaydi.',
        code: 'EXCEEDS_BALANCE',
        remaining,
      });
    }

    await Ledger.create({
      type: 'waiter_payout',
      amount: -amount,
      restaurantId: req.restaurantId,
      waiterId: waiter._id,
      createdBy: req.userId || null,
      meta: {
        note: String(req.body.note || '').slice(0, 200)
          || `${waiter.firstName} — xizmat haqi to\u2018landi`,
        period: req.body.period || '',
      },
    });

    await Waiter.findByIdAndUpdate(waiter._id, {
      $inc: { 'earnings.paidOut': amount },
    });

    res.json({
      paid: amount,
      remaining: remaining - amount,
    });
  }),
};

/** Davr boshlanishi. */
function periodStart(period, custom) {
  if (custom) return new Date(custom);

  const d = new Date();
  d.setHours(0, 0, 0, 0);

  if (period === 'today') return d;
  if (period === 'week') {
    // Dushanbadan boshlab
    const day = d.getDay() || 7;
    d.setDate(d.getDate() - day + 1);
    return d;
  }
  // month
  d.setDate(1);
  return d;
}
