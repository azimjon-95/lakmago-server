import { z } from 'zod';
import { asyncHandler } from '../middleware/error.js';
import { DineInConfig, Table, DineInSession, generateQrToken } from '../models/DineIn.js';
import { Restaurant } from '../models/Restaurant.js';
import { renderQrCard, renderQrPdf, generateQrPng, buildTableUrl } from '../services/qrDesign.js';
import { getIO } from '../sockets/io.js';

const rid = (req) => req.restaurantId;

/** Dine-in ishlayaptimi — tekshirib config qaytaradi. */
async function requireActive(restaurantId) {
  const cfg = await DineInConfig.findOne({ restaurantId });
  if (!cfg) return { ok: false, error: 'Dine-in yoqilmagan' };
  if (cfg.status !== 'active') {
    const msgs = {
      pending: 'So\u2018rov ko\u2018rib chiqilmoqda',
      approved: 'Tasdiqlangan, to\u2018lov kutilmoqda',
      payment_required: 'To\u2018lov talab qilinadi',
      suspended: 'Xizmat to\u2018xtatilgan',
    };
    return { ok: false, error: msgs[cfg.status] || 'Dine-in faol emas', status: cfg.status };
  }
  return { ok: true, config: cfg };
}

export const dineInController = {
  // ═══ RESTORAN PANELI ═══

  // GET /api/panel/dine-in
  getConfig: asyncHandler(async (req, res) => {
    let cfg = await DineInConfig.findOne({ restaurantId: rid(req) }).lean();

    if (!cfg) {
      // Hali so'ramagan
      return res.json({ status: 'none', tables: 0 });
    }

    const tables = await Table.countDocuments({ restaurantId: rid(req) });
    const activeSessions = await DineInSession.countDocuments({
      restaurantId: rid(req), status: 'active',
    });

    res.json({ ...cfg, tables, activeSessions });
  }),

  // POST /api/panel/dine-in/request — aktivatsiya so'rovi
  requestActivation: asyncHandler(async (req, res) => {
    const existing = await DineInConfig.findOne({ restaurantId: rid(req) });
    if (existing) {
      return res.status(400).json({ error: 'So\u2018rov allaqachon yuborilgan' });
    }

    const cfg = await DineInConfig.create({
      restaurantId: rid(req),
      status: 'pending',
    });

    getIO()?.to('admin').emit('dinein:request', {
      restaurantId: String(rid(req)),
    });

    res.status(201).json(cfg);
  }),

  // PATCH /api/panel/dine-in/settings — xizmat haqi va stop list
  updateSettings: asyncHandler(async (req, res) => {
    const schema = z.object({
      serviceFeeEnabled: z.boolean().optional(),
      serviceFeeType: z.enum(['percentage', 'fixed']).optional(),
      serviceFeeValue: z.number().min(0).max(1000000).optional(),
      useGlobalStopList: z.boolean().optional(),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Noto\u2018g\u2018ri qiymat' });
    }

    // Foiz 100 dan oshmasin
    if (parsed.data.serviceFeeType === 'percentage'
        && parsed.data.serviceFeeValue > 100) {
      return res.status(400).json({ error: 'Foiz 100 dan oshmasligi kerak' });
    }

    const cfg = await DineInConfig.findOneAndUpdate(
      { restaurantId: rid(req) },
      parsed.data,
      { new: true, runValidators: true },
    );

    if (!cfg) return res.status(404).json({ error: 'Dine-in sozlanmagan' });
    res.json(cfg);
  }),

  // PATCH /api/panel/dine-in/theme — QR dizayni
  updateTheme: asyncHandler(async (req, res) => {
    const schema = z.object({
      backgroundColor: z.string().max(30).optional(),
      backgroundImage: z.string().max(500).optional(),
      textColor: z.string().max(30).optional(),
      accentColor: z.string().max(30).optional(),
      logoUrl: z.string().max(500).optional(),
      headline: z.string().max(60).optional(),
      footnote: z.string().max(80).optional(),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Noto\u2018g\u2018ri qiymat' });
    }

    const cfg = await DineInConfig.findOneAndUpdate(
      { restaurantId: rid(req) },
      { $set: Object.fromEntries(
        Object.entries(parsed.data).map(([k, v]) => [`qrTheme.${k}`, v]),
      ) },
      { new: true },
    );

    if (!cfg) return res.status(404).json({ error: 'Dine-in sozlanmagan' });
    res.json(cfg.qrTheme);
  }),

  // ═══ STOLLAR ═══

  // GET /api/panel/tables
  listTables: asyncHandler(async (req, res) => {
    const tables = await Table.find({ restaurantId: rid(req) })
      .sort({ tableNumber: 1 })
      .lean();

    // Faol sessiyalar
    const sessions = await DineInSession.find({
      restaurantId: rid(req), status: 'active',
    }).select('tableId createdAt').lean();

    const sessionMap = new Map(sessions.map((s) => [String(s.tableId), s]));

    res.json(tables.map((t) => ({
      ...t,
      url: buildTableUrl(t.qrToken),
      activeSession: sessionMap.get(String(t._id)) || null,
    })));
  }),

  // POST /api/panel/tables
  createTable: asyncHandler(async (req, res) => {
    const check = await requireActive(rid(req));
    if (!check.ok) return res.status(403).json({ error: check.error });

    const schema = z.object({
      tableNumber: z.string().min(1).max(20),
      tableName: z.string().max(60).optional().default(''),
      capacity: z.number().int().min(1).max(50).optional().default(4),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Stol raqamini kiriting' });
    }

    try {
      const table = await Table.create({
        ...parsed.data,
        tableNumber: parsed.data.tableNumber.trim(),
        restaurantId: rid(req),
        branchId: rid(req),
        qrToken: generateQrToken(),
      });
      res.status(201).json({ ...table.toObject(), url: buildTableUrl(table.qrToken) });
    } catch (e) {
      if (e.code === 11000) {
        return res.status(400).json({ error: 'Bu raqamli stol allaqachon bor' });
      }
      throw e;
    }
  }),

  // POST /api/panel/tables/bulk — bir nechta stol birdan
  createBulk: asyncHandler(async (req, res) => {
    const check = await requireActive(rid(req));
    if (!check.ok) return res.status(403).json({ error: check.error });

    const count = Number(req.body.count);
    const startFrom = Number(req.body.startFrom) || 1;
    const capacity = Number(req.body.capacity) || 4;

    if (!Number.isInteger(count) || count < 1 || count > 100) {
      return res.status(400).json({ error: 'Stollar soni 1 dan 100 gacha' });
    }

    // Mavjud raqamlarni olamiz — takrorlanmasin
    const existing = await Table.find({ restaurantId: rid(req) })
      .select('tableNumber').lean();
    const taken = new Set(existing.map((t) => t.tableNumber));

    const toCreate = [];
    let num = startFrom;
    while (toCreate.length < count && num < startFrom + count * 3) {
      const label = String(num);
      if (!taken.has(label)) {
        toCreate.push({
          restaurantId: rid(req),
          branchId: rid(req),
          tableNumber: label,
          capacity,
          qrToken: generateQrToken(),
        });
      }
      num++;
    }

    const created = await Table.insertMany(toCreate, { ordered: false });
    res.status(201).json({ created: created.length });
  }),

  // PATCH /api/panel/tables/:id
  updateTable: asyncHandler(async (req, res) => {
    const schema = z.object({
      tableName: z.string().max(60).optional(),
      tableNumber: z.string().min(1).max(20).optional(),
      capacity: z.number().int().min(1).max(50).optional(),
      status: z.enum(['available', 'occupied', 'ordering', 'waiting', 'closed']).optional(),
      isActive: z.boolean().optional(),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Noto\u2018g\u2018ri qiymat' });
    }

    const table = await Table.findOneAndUpdate(
      { _id: req.params.id, restaurantId: rid(req) },
      parsed.data,
      { new: true, runValidators: true },
    );
    if (!table) return res.status(404).json({ error: 'Stol topilmadi' });

    getIO()?.to(`restaurant:${rid(req)}`).emit('table:update', {
      tableId: String(table._id), status: table.status,
    });

    res.json(table);
  }),

  // POST /api/panel/tables/:id/regenerate — QR ni yangilash
  regenerateQr: asyncHandler(async (req, res) => {
    const table = await Table.findOne({ _id: req.params.id, restaurantId: rid(req) });
    if (!table) return res.status(404).json({ error: 'Stol topilmadi' });

    // Eski QR ishlamay qoladi — faol sessiyani yopamiz
    await DineInSession.updateMany(
      { tableId: table._id, status: 'active' },
      { status: 'closed', closedAt: new Date(), closeReason: 'QR yangilandi' },
    );

    table.qrToken = generateQrToken();
    await table.save();

    res.json({ ...table.toObject(), url: buildTableUrl(table.qrToken) });
  }),

  // DELETE /api/panel/tables/:id
  deleteTable: asyncHandler(async (req, res) => {
    const active = await DineInSession.exists({
      tableId: req.params.id, status: 'active',
    });
    if (active) {
      return res.status(400).json({ error: 'Stolda faol sessiya bor' });
    }

    const table = await Table.findOneAndDelete({
      _id: req.params.id, restaurantId: rid(req),
    });
    if (!table) return res.status(404).json({ error: 'Stol topilmadi' });
    res.json({ deleted: true });
  }),

  // ═══ QR YUKLASH ═══

  // GET /api/panel/tables/:id/qr?format=svg|png
  getQr: asyncHandler(async (req, res) => {
    const table = await Table.findOne({ _id: req.params.id, restaurantId: rid(req) }).lean();
    if (!table) return res.status(404).json({ error: 'Stol topilmadi' });

    const [restaurant, cfg] = await Promise.all([
      Restaurant.findById(rid(req)).select('name').lean(),
      DineInConfig.findOne({ restaurantId: rid(req) }).lean(),
    ]);

    const format = req.query.format === 'png' ? 'png' : 'svg';

    if (format === 'png') {
      const dataUrl = await generateQrPng(table.qrToken, 800);
      const buf = Buffer.from(dataUrl.split(',')[1], 'base64');
      res.set('Content-Type', 'image/png');
      res.set('Content-Disposition',
        `attachment; filename="stol-${table.tableNumber}.png"`);
      return res.send(buf);
    }

    const svg = await renderQrCard(table, restaurant, cfg?.qrTheme || {});
    res.set('Content-Type', 'image/svg+xml');
    res.set('Content-Disposition',
      `attachment; filename="stol-${table.tableNumber}.svg"`);
    res.send(svg);
  }),

  // GET /api/panel/tables/qr/pdf — barcha stollar
  getAllQrPdf: asyncHandler(async (req, res) => {
    const tables = await Table.find({ restaurantId: rid(req), isActive: true })
      .sort({ tableNumber: 1 })
      .lean();

    if (tables.length === 0) {
      return res.status(400).json({ error: 'Stol yo\u2018q' });
    }

    const [restaurant, cfg] = await Promise.all([
      Restaurant.findById(rid(req)).select('name').lean(),
      DineInConfig.findOne({ restaurantId: rid(req) }).lean(),
    ]);

    const pdf = await renderQrPdf(tables, restaurant, cfg?.qrTheme || {});

    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', 'attachment; filename="qr-kodlar.pdf"');
    res.send(pdf);
  }),

  // ═══ MIJOZ: QR SKANERLASH ═══

  /**
   * POST /api/dine-in/scan  { token, deviceSessionId }
   *
   * Login TALAB QILINMAYDI.
   * Qurilma metadatasi olinmaydi va menyu ochilishini bloklamaydi.
   */
  scan: asyncHandler(async (req, res) => {
    const token = String(req.body.token || '').trim();
    if (!token || token.length < 16) {
      return res.status(400).json({ error: 'QR kod noto\u2018g\u2018ri' });
    }

    const table = await Table.findOne({ qrToken: token }).lean();
    if (!table || !table.isActive) {
      return res.status(404).json({ error: 'Stol topilmadi', code: 'INVALID_QR' });
    }

    // Dine-in ishlayaptimi
    const check = await requireActive(table.restaurantId);
    if (!check.ok) {
      return res.status(403).json({ error: check.error, code: 'DINEIN_INACTIVE' });
    }

    const restaurant = await Restaurant.findById(table.restaurantId)
      .select('name imageUrl tint icon cuisine openTime closeTime address')
      .lean();

    if (!restaurant) {
      return res.status(404).json({ error: 'Restoran topilmadi' });
    }

    // Qurilma sessiyasi — brauzer yaratadi, IMEI emas
    const deviceSessionId = String(req.body.deviceSessionId || '').slice(0, 100)
      || `dev_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

    // Shu qurilmaning shu stoldagi faol sessiyasi bormi
    let session = await DineInSession.findOne({
      tableId: table._id,
      deviceSessionId,
      status: 'active',
    });

    if (!session) {
      // Stolda boshqa faol sessiya bo'lsa unga qo'shilamiz
      // (bir stolda bir necha telefon bo'lishi mumkin)
      session = await DineInSession.findOne({
        tableId: table._id, status: 'active',
      });

      if (!session) {
        session = await DineInSession.create({
          restaurantId: table.restaurantId,
          branchId: table.branchId || table.restaurantId,
          tableId: table._id,
          deviceSessionId,
          status: 'active',
        });

        await Table.findByIdAndUpdate(table._id, {
          status: 'occupied',
          $inc: { totalSessions: 1 },
          lastSessionAt: new Date(),
        });

        getIO()?.to(`restaurant:${table.restaurantId}`).emit('table:update', {
          tableId: String(table._id), status: 'occupied',
        });
      }
    }

    res.json({
      session: {
        id: String(session._id),
        deviceSessionId,
        status: session.status,
        createdAt: session.createdAt,
      },
      table: {
        id: String(table._id),
        name: table.tableName,
        number: table.tableNumber,
        capacity: table.capacity,
      },
      restaurant: {
        id: String(restaurant._id),
        name: restaurant.name,
        imageUrl: restaurant.imageUrl,
        cuisine: restaurant.cuisine,
        tint: restaurant.tint,
        icon: restaurant.icon,
        openTime: restaurant.openTime,
        closeTime: restaurant.closeTime,
        address: restaurant.address,
      },
    });
  }),

  // GET /api/dine-in/session/:id — sessiya holati
  getSession: asyncHandler(async (req, res) => {
    const session = await DineInSession.findById(req.params.id).lean();
    if (!session) return res.status(404).json({ error: 'Sessiya topilmadi' });

    const [table, restaurant] = await Promise.all([
      Table.findById(session.tableId).select('tableName tableNumber').lean(),
      Restaurant.findById(session.restaurantId).select('name imageUrl').lean(),
    ]);

    res.json({ session, table, restaurant });
  }),

  // ═══ SUPER ADMIN ═══

  // GET /api/admin/dine-in
  adminList: asyncHandler(async (_req, res) => {
    const configs = await DineInConfig.find()
      .sort({ createdAt: -1 })
      .lean();

    const ids = configs.map((c) => c.restaurantId);
    const [restaurants, tableCounts] = await Promise.all([
      Restaurant.find({ _id: { $in: ids } }).select('name phone').lean(),
      Table.aggregate([
        { $match: { restaurantId: { $in: ids } } },
        { $group: { _id: '$restaurantId', n: { $sum: 1 } } },
      ]),
    ]);

    const restMap = new Map(restaurants.map((r) => [String(r._id), r]));
    const countMap = new Map(tableCounts.map((t) => [String(t._id), t.n]));

    res.json(configs.map((c) => ({
      ...c,
      restaurant: restMap.get(String(c.restaurantId)) || null,
      tables: countMap.get(String(c.restaurantId)) || 0,
    })));
  }),

  // PATCH /api/admin/dine-in/:restaurantId  { status }
  adminSetStatus: asyncHandler(async (req, res) => {
    const status = req.body.status;
    const allowed = ['pending', 'approved', 'payment_required', 'active', 'suspended'];
    if (!allowed.includes(status)) {
      return res.status(400).json({ error: 'Noto\u2018g\u2018ri holat' });
    }

    const cfg = await DineInConfig.findOne({ restaurantId: req.params.restaurantId });
    if (!cfg) return res.status(404).json({ error: 'So\u2018rov topilmadi' });

    cfg.status = status;
    if (status === 'approved') cfg.approvedAt = new Date();
    if (status === 'active') cfg.activatedAt = new Date();
    if (status === 'suspended') {
      cfg.suspendedAt = new Date();
      cfg.suspendReason = String(req.body.reason || '').slice(0, 200);
    }
    await cfg.save();

    getIO()?.to(`restaurant:${cfg.restaurantId}`).emit('dinein:status', {
      status: cfg.status,
    });

    res.json(cfg);
  }),
};
