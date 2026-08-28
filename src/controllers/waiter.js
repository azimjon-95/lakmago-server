import { z } from 'zod';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { asyncHandler } from '../middleware/error.js';
import { Waiter } from '../models/Waiter.js';
import { Table, DineInConfig, DineInSession } from '../models/DineIn.js';
import { Restaurant } from '../models/Restaurant.js';
import { Order } from '../models/Order.js';
import { config } from '../config/index.js';
import { getIO } from '../sockets/io.js';

const rid = (req) => req.restaurantId;

export const waiterController = {
  // ═══ RESTORAN PANELI: ofitsiantlar ═══

  // GET /api/panel/waiters
  list: asyncHandler(async (req, res) => {
    const waiters = await Waiter.find({ restaurantId: rid(req) })
      .select('-passwordHash')
      .populate('tableIds', 'tableNumber tableName')
      .sort({ createdAt: -1 })
      .lean();

    res.json(waiters.map((w) => ({
      ...w,
      fullName: [w.firstName, w.lastName].filter(Boolean).join(' '),
      deviceBound: Boolean(w.deviceId),
    })));
  }),

  // POST /api/panel/waiters
  create: asyncHandler(async (req, res) => {
    const schema = z.object({
      firstName: z.string().min(2).max(50),
      lastName: z.string().max(50).optional().default(''),
      phone: z.string().max(30).optional().default(''),
      login: z.string().min(3).max(30).regex(/^[a-z0-9_.]+$/i, 'Faqat harf, raqam va _'),
      password: z.string().min(4).max(60),
      tableIds: z.array(z.string().length(24)).optional().default([]),
      schedule: z.object({
        days: z.array(z.string()).optional(),
        from: z.string().max(5).optional(),
        to: z.string().max(5).optional(),
      }).optional(),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: parsed.error.issues[0]?.message || 'Ma‘lumot noto‘g‘ri',
      });
    }

    const login = parsed.data.login.toLowerCase();
    if (await Waiter.exists({ login })) {
      return res.status(400).json({ error: 'Bu login band' });
    }

    // Stol chegarasi: bitta stolga eng ko'pi 3 ofitsiant
    const err = await checkTableLimit(parsed.data.tableIds, rid(req), null);
    if (err) return res.status(400).json({ error: err });

    const waiter = await Waiter.create({
      ...parsed.data,
      login,
      passwordHash: await bcrypt.hash(parsed.data.password, 10),
      restaurantId: rid(req),
      branchId: rid(req),
    });

    const obj = waiter.toObject();
    delete obj.passwordHash;
    res.status(201).json(obj);
  }),

  // PATCH /api/panel/waiters/:id
  update: asyncHandler(async (req, res) => {
    const schema = z.object({
      firstName: z.string().min(2).max(50).optional(),
      lastName: z.string().max(50).optional(),
      phone: z.string().max(30).optional(),
      password: z.string().min(4).max(60).optional(),
      isActive: z.boolean().optional(),
      tableIds: z.array(z.string().length(24)).optional(),
      schedule: z.object({
        days: z.array(z.string()).optional(),
        from: z.string().max(5).optional(),
        to: z.string().max(5).optional(),
      }).optional(),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Ma‘lumot noto‘g‘ri' });
    }

    if (parsed.data.tableIds) {
      const err = await checkTableLimit(parsed.data.tableIds, rid(req), req.params.id);
      if (err) return res.status(400).json({ error: err });
    }

    const update = { ...parsed.data };
    if (update.password) {
      update.passwordHash = await bcrypt.hash(update.password, 10);
      delete update.password;
    }

    const waiter = await Waiter.findOneAndUpdate(
      { _id: req.params.id, restaurantId: rid(req) },
      update,
      { new: true, runValidators: true },
    ).select('-passwordHash');

    if (!waiter) return res.status(404).json({ error: 'Ofitsiant topilmadi' });
    res.json(waiter);
  }),

  // POST /api/panel/waiters/:id/reset-device
  resetDevice: asyncHandler(async (req, res) => {
    const waiter = await Waiter.findOneAndUpdate(
      { _id: req.params.id, restaurantId: rid(req) },
      { deviceId: null, deviceBoundAt: null, deviceLabel: '' },
      { new: true },
    ).select('-passwordHash');

    if (!waiter) return res.status(404).json({ error: 'Ofitsiant topilmadi' });
    res.json({ ...waiter.toObject(), message: 'Keyingi kirishda yangi qurilma bog‘lanadi' });
  }),

  // DELETE /api/panel/waiters/:id
  remove: asyncHandler(async (req, res) => {
    const waiter = await Waiter.findOneAndDelete({
      _id: req.params.id, restaurantId: rid(req),
    });
    if (!waiter) return res.status(404).json({ error: 'Ofitsiant topilmadi' });
    res.json({ deleted: true });
  }),

  // ═══ OFITSIANT KIRISHI ═══

  /**
   * POST /api/waiter/login  { login, password, deviceId, deviceLabel }
   *
   * Qurilma bog'lash SERVERDA tekshiriladi.
   */
  login: asyncHandler(async (req, res) => {
    const { login, password, deviceId, deviceLabel } = req.body;

    if (!login || !password || !deviceId) {
      return res.status(400).json({ error: 'Login va parol kiriting' });
    }

    // trim: eski yozuvlarda (sxemaga trim qo'shilishidan oldin)
    // login oxirida bo'sh joy qolgan bo'lishi mumkin
    const loginKey = String(login).trim().toLowerCase();
    const waiter = await Waiter.findOne({ login: loginKey });

    if (!waiter || !(await bcrypt.compare(password, waiter.passwordHash))) {
      // Javobda sabab ko'rsatilmaydi — akkaunt bor-yo'qligini
      // bilib olishga yo'l qo'ymaslik uchun. Lekin restoran
      // nosozlikni topa olishi kerak, shuning uchun logga yozamiz.
      console.warn(
        '[waiter:login] muvaffaqiyatsiz —',
        waiter ? `login topildi (${loginKey}), parol mos emas` : `bunday login yo'q: "${loginKey}"`,
      );
      return res.status(401).json({ error: 'Login yoki parol noto‘g‘ri' });
    }

    if (!waiter.isActive) {
      return res.status(403).json({ error: 'Akkaunt faol emas' });
    }

    // Restoran Dine-in ishlayaptimi
    const cfg = await DineInConfig.findOne({ restaurantId: waiter.restaurantId });
    if (!cfg || cfg.status !== 'active') {
      return res.status(403).json({ error: 'Dine-in xizmati faol emas' });
    }

    const device = String(deviceId).slice(0, 120);

    // ===== QURILMA TEKSHIRUVI =====
    if (waiter.deviceId && waiter.deviceId !== device) {
      return res.status(403).json({
        error: 'Bu akkaunt boshqa qurilmaga bog‘langan. '
          + 'Administratordan qurilmani almashtirishni so‘rang.',
        code: 'DEVICE_MISMATCH',
      });
    }

    // Shu qurilmada boshqa restoran ofitsianti bormi
    if (!waiter.deviceId) {
      const other = await Waiter.findOne({
        deviceId: device,
        restaurantId: { $ne: waiter.restaurantId },
      }).populate('restaurantId', 'name');

      if (other) {
        const otherName = other.restaurantId?.name || 'boshqa restoran';
        return res.status(403).json({
          error: `Siz ${otherName} restoranida ishlaysiz. `
            + 'Ushbu akkaunt boshqa restoranga tegishli. Kirish taqiqlangan.',
          code: 'DEVICE_OTHER_RESTAURANT',
        });
      }

      // Birinchi kirish — qurilmani bog'laymiz
      waiter.deviceId = device;
      waiter.deviceBoundAt = new Date();
      waiter.deviceLabel = String(deviceLabel || '').slice(0, 100);
    }

    waiter.lastLoginAt = new Date();
    await waiter.save();

    const restaurant = await Restaurant.findById(waiter.restaurantId)
      .select('name imageUrl').lean();

    const token = jwt.sign(
      {
        waiterId: String(waiter._id),
        restaurantId: String(waiter.restaurantId),
        deviceId: device,
        role: 'waiter',
      },
      config.jwtSecret,
      { expiresIn: '30d' },
    );

    res.json({
      token,
      waiter: {
        id: String(waiter._id),
        firstName: waiter.firstName,
        lastName: waiter.lastName,
        fullName: [waiter.firstName, waiter.lastName].filter(Boolean).join(' '),
      },
      restaurant,
    });
  }),

  // GET /api/waiter/me
  me: asyncHandler(async (req, res) => {
    const waiter = await Waiter.findById(req.waiterId)
      .select('-passwordHash')
      .populate('tableIds', 'tableNumber tableName status capacity')
      .lean();

    if (!waiter) return res.status(404).json({ error: 'Topilmadi' });

    const restaurant = await Restaurant.findById(waiter.restaurantId)
      .select('name imageUrl').lean();

    res.json({ ...waiter, restaurant });
  }),

  // GET /api/waiter/tables — biriktirilgan stollar
  //
  // Kiosk va restoran admini uchun ham ishlaydi: ular SHAXS emas,
  // shuning uchun req.waiterId bo'lmaydi va cheklovsiz — restoranning
  // barcha stollari ko'rinadi.
  myTables: asyncHandler(async (req, res) => {
    let filter;

    if (req.waiterId) {
      const waiter = await Waiter.findById(req.waiterId).select('tableIds restaurantId').lean();
      if (!waiter) return res.status(404).json({ error: 'Topilmadi' });

      // Stol biriktirilmagan bo'lsa — barcha stollar
      filter = waiter.tableIds?.length
        ? { _id: { $in: waiter.tableIds } }
        : { restaurantId: waiter.restaurantId, isActive: true };
    } else {
      filter = { restaurantId: rid(req), isActive: true };
    }

    const tables = await Table.find(filter).sort({ tableNumber: 1 }).lean();

    // Faol sessiyalar va buyurtmalar
    const tableIds = tables.map((t) => t._id);
    const [sessions, orders] = await Promise.all([
      DineInSession.find({ tableId: { $in: tableIds }, status: 'active' }).lean(),
      Order.find({
        tableId: { $in: tableIds },
        fulfillment: 'dinein',
        status: { $nin: ['completed', 'cancelled'] },
      }).select('tableId total status dineInNumber').lean(),
    ]);

    const sessionMap = new Map(sessions.map((s) => [String(s.tableId), s]));
    const orderMap = new Map();
    for (const o of orders) {
      const k = String(o.tableId);
      if (!orderMap.has(k)) orderMap.set(k, []);
      orderMap.get(k).push(o);
    }

    res.json(tables.map((t) => {
      const session = sessionMap.get(String(t._id)) || null;
      const tableOrders = orderMap.get(String(t._id)) || [];

      return {
        ...t,
        session,
        activeOrders: tableOrders,
        // Zal xaritasi uchun
        guestCount: session?.guestCount || t.guestCount || 0,
        orderTotal: tableOrders.reduce((s, o) => s + (o.total || 0), 0),
        isBusy: Boolean(session),
      };
    }));
  }),

  /**
   * PATCH /api/waiter/tables/:id/guests  { count }
   *
   * Stolda nechta mijoz o'tirganini belgilaydi.
   */
  setGuests: asyncHandler(async (req, res) => {
    const count = Math.max(0, Math.min(50, Number(req.body.count) || 0));

    const table = await Table.findOne({
      _id: req.params.id,
      restaurantId: req.restaurantId,
    });
    if (!table) return res.status(404).json({ error: 'Stol topilmadi' });

    // Ofitsiantga biriktirilganmi (FAQAT ofitsiant kirganda —
    // restoran admini istalgan stolni boshqaradi, cheklovsiz)
    if (req.waiterId) {
      const waiter = await Waiter.findById(req.waiterId).select('tableIds').lean();
      if (waiter?.tableIds?.length) {
        const allowed = waiter.tableIds.some((id) => String(id) === String(table._id));
        if (!allowed) {
          return res.status(403).json({ error: 'Bu stol sizga biriktirilmagan' });
        }
      }
    }

    table.guestCount = count;
    if (count > 0 && table.status !== 'occupied') table.status = 'occupied';
    await table.save();

    // Faol sessiyaga ham yozamiz
    await DineInSession.updateOne(
      { tableId: table._id, status: 'active' },
      { guestCount: count },
    );

    getIO()?.to(`restaurant:${req.restaurantId}`).emit('table:update', {
      tableId: String(table._id),
      status: table.status,
      guestCount: count,
    });

    res.json({ guestCount: count, status: table.status });
  }),

  /**
   * GET /api/waiter/tables/:id — bitta stol tafsiloti
   *
   * Buyurtmalar, taomlar, hisob — hammasi bir so'rovda.
   */
  tableDetail: asyncHandler(async (req, res) => {
    const table = await Table.findOne({
      _id: req.params.id,
      restaurantId: req.restaurantId,
    }).lean();
    if (!table) return res.status(404).json({ error: 'Stol topilmadi' });

    const session = await DineInSession.findOne({
      tableId: table._id, status: 'active',
    }).lean();

    const orders = session
      ? await Order.find({ dineInSessionId: session._id })
          .sort({ createdAt: -1 })
          .lean()
      : [];

    const active = orders.filter((o) => o.status !== 'cancelled');
    const total = active.reduce((s, o) => s + (o.total || 0), 0);
    const serviceFee = active.reduce((s, o) => s + (o.serviceFee || 0), 0);

    res.json({
      table: {
        ...table,
        guestCount: session?.guestCount || table.guestCount || 0,
      },
      session,
      orders,
      summary: {
        orders: active.length,
        subtotal: active.reduce((s, o) => s + (o.subtotal || 0), 0),
        serviceFee,
        total,
      },
    });
  }),
};

/** Bitta stolga eng ko'pi 3 ofitsiant biriktiriladi. */
async function checkTableLimit(tableIds, restaurantId, excludeWaiterId) {
  if (!tableIds?.length) return null;

  for (const tableId of tableIds) {
    const filter = { restaurantId, tableIds: tableId, isActive: true };
    if (excludeWaiterId) filter._id = { $ne: excludeWaiterId };

    const count = await Waiter.countDocuments(filter);
    if (count >= 3) {
      const table = await Table.findById(tableId).select('tableNumber').lean();
      return `Stol ${table?.tableNumber || ''} ga allaqachon 3 ta ofitsiant biriktirilgan`;
    }
  }
  return null;
}
