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
        error: parsed.error.issues[0]?.message || 'Ma\u2018lumot noto\u2018g\u2018ri',
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
      return res.status(400).json({ error: 'Ma\u2018lumot noto\u2018g\u2018ri' });
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
    res.json({ ...waiter.toObject(), message: 'Keyingi kirishda yangi qurilma bog\u2018lanadi' });
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

    const waiter = await Waiter.findOne({ login: String(login).toLowerCase() });
    if (!waiter || !(await bcrypt.compare(password, waiter.passwordHash))) {
      return res.status(401).json({ error: 'Login yoki parol noto\u2018g\u2018ri' });
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
        error: 'Bu akkaunt boshqa qurilmaga bog\u2018langan. '
          + 'Administratordan qurilmani almashtirishni so\u2018rang.',
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
  myTables: asyncHandler(async (req, res) => {
    const waiter = await Waiter.findById(req.waiterId).select('tableIds restaurantId').lean();
    if (!waiter) return res.status(404).json({ error: 'Topilmadi' });

    // Stol biriktirilmagan bo'lsa — barcha stollar
    const filter = waiter.tableIds?.length
      ? { _id: { $in: waiter.tableIds } }
      : { restaurantId: waiter.restaurantId, isActive: true };

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

    res.json(tables.map((t) => ({
      ...t,
      session: sessionMap.get(String(t._id)) || null,
      activeOrders: orderMap.get(String(t._id)) || [],
    })));
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
