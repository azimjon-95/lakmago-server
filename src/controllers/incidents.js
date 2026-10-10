import { config } from '../config/index.js';
import { z } from 'zod';
import { asyncHandler } from '../middleware/error.js';
import { User } from '../models/User.js';
import { Order } from '../models/Order.js';
import { CustomerIncident } from '../models/CustomerIncident.js';
import {
  REFUSAL_REASONS, IncidentError, createCancelRequest, decideIncident, applyRestrictions,
  liftRestrictions, fetchTelegramPhoto, defaultCustomerMessage,
} from '../services/customerIncidents.js';

/*
 * "Mijoz rad etdi" — restoran so'rovi, admin qarori va mijoz cheklovlari.
 * Mantiq: services/customerIncidents.js
 */
const isId = (v) => /^[a-f0-9]{24}$/i.test(String(v || ''));
const fail = (res, e) => {
  if (e instanceof IncidentError) return res.status(e.http).json({ error: e.message, code: e.code });
  throw e;
};
const rid = (req) => req.restaurantId;

export const panelIncidentController = {
  // GET /api/panel/refusal-reasons
  reasons: (_req, res) => res.json({
    reasons: Object.entries(REFUSAL_REASONS).map(([value, label]) => ({ value, label })),
    // true — admin tasdig'ini kutadi; false (standart) — darhol bekor qilinadi
    approvalRequired: config.cancelApprovalRequired,
  }),

  // POST /api/panel/orders/:id/cancel-request  { reasonCode, note }
  request: asyncHandler(async (req, res) => {
    if (!isId(req.params.id)) return res.status(404).json({ error: 'Buyurtma topilmadi' });
    const body = z.object({ reasonCode: z.string().max(40), note: z.string().max(500).optional() }).safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'Sababni tanlang' });
    try {
      const { incident, order } = await createCancelRequest({
        orderId: req.params.id, restaurantId: rid(req), reasonCode: body.data.reasonCode, note: body.data.note, requestedBy: 'Restoran paneli',
      });
      res.status(201).json({ ok: true, incidentId: incident._id, mode: incident.mode, status: order.status, cancelRequest: order.cancelRequest });
    } catch (e) { return fail(res, e); }
  }),
};

export const adminIncidentController = {
  // GET /api/admin/incidents?status=pending|approved|rejected|all
  list: asyncHandler(async (req, res) => {
    const status = ['pending', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : null;
    const q = status ? { status } : {};
    const [items, pending] = await Promise.all([
      CustomerIncident.find(q).sort({ createdAt: -1 }).limit(Math.min(200, Number(req.query.limit) || 100)).lean(),
      CustomerIncident.countDocuments({ status: 'pending' }),
    ]);
    res.json({ items, pending, settings: { approvalRequired: config.cancelApprovalRequired, restrictionsEnabled: config.customerRestrictionsEnabled } });
  }),

  // GET /api/admin/incidents/:id
  get: asyncHandler(async (req, res) => {
    if (!isId(req.params.id)) return res.status(404).json({ error: 'Topilmadi' });
    const inc = await CustomerIncident.findById(req.params.id).lean();
    if (!inc) return res.status(404).json({ error: 'Topilmadi' });
    const [user, history] = await Promise.all([
      inc.userId ? User.findById(inc.userId).select('firstName lastName username phone telegramId status cashDisabled blockInfo').lean() : null,
      inc.userId ? CustomerIncident.find({ userId: inc.userId, _id: { $ne: inc._id } }).sort({ createdAt: -1 }).limit(20).select('status restaurantName reason createdAt orderLabel').lean() : [],
    ]);
    res.json({ incident: inc, user, history, defaultMessage: defaultCustomerMessage(inc), settings: { restrictionsEnabled: config.customerRestrictionsEnabled } });
  }),

  // POST /api/admin/incidents/:id/decide  { approve, disableCash, block, customerMessage, note }
  decide: asyncHandler(async (req, res) => {
    if (!isId(req.params.id)) return res.status(404).json({ error: 'Topilmadi' });
    const b = z.object({
      approve: z.boolean(),
      disableCash: z.boolean().optional(),
      block: z.boolean().optional(),
      customerMessage: z.string().max(600).optional(),
      note: z.string().max(500).optional(),
    }).safeParse(req.body);
    if (!b.success) return res.status(400).json({ error: 'Ma‘lumot noto‘g‘ri' });
    try {
      const adminName = req.role === 'admin' ? 'Admin' : 'Xodim';
      const inc = await decideIncident(req.params.id, { ...b.data, adminName });
      res.json({ incident: inc });
    } catch (e) { return fail(res, e); }
  }),

  // GET /api/admin/incidents/:id/photo — mijozning Telegram rasmi (hodisa paytidagi)
  photo: asyncHandler(async (req, res) => {
    if (!isId(req.params.id)) return res.status(404).end();
    const inc = await CustomerIncident.findById(req.params.id).select('snapshot.photoFileId').lean();
    const img = await fetchTelegramPhoto(inc?.snapshot?.photoFileId).catch(() => null);
    if (!img) return res.status(404).end();
    res.set('Content-Type', img.type).set('Cache-Control', 'private, max-age=86400').send(img.buffer);
  }),

  /*
   * GET /api/admin/cancellation-stats?days=30&min=2 — TAHLIL (jazo emas):
   * qaysi mijozda buyurtmalar takroran bekor bo'lgan va qaysi sabab bilan
   * ("javob bermadi", "tasdiqlamadi", "voz kechdi"). Faqat sabab kodi bor
   * buyurtmalar (constants/rejectReasons.js, refused_*). Qaror admin qo'lida.
   */
  cancellationStats: asyncHandler(async (req, res) => {
    const days = Math.min(180, Math.max(1, Number(req.query.days) || 30));
    const min = Math.min(20, Math.max(1, Number(req.query.min) || 2));
    const since = new Date(Date.now() - days * 86_400_000);
    const rows = await Order.aggregate([
      { $match: { status: 'cancelled', createdAt: { $gte: since }, userId: { $ne: null }, cancelReasonCode: { $exists: true, $ne: null } } },
      { $group: { _id: '$userId', cancelled: { $sum: 1 }, codes: { $push: '$cancelReasonCode' }, last: { $max: '$createdAt' }, restaurants: { $addToSet: '$restaurantName' } } },
      { $match: { cancelled: { $gte: min } } },
      { $sort: { cancelled: -1, last: -1 } },
      { $limit: 100 },
    ]);
    const ids = rows.map((r) => r._id);
    const [users, totals] = await Promise.all([
      User.find({ _id: { $in: ids } }).select('firstName lastName username phone phoneVerified telegramId status cashDisabled').lean(),
      Order.aggregate([{ $match: { userId: { $in: ids }, createdAt: { $gte: since } } }, { $group: { _id: '$userId', n: { $sum: 1 } } }]),
    ]);
    const uMap = new Map(users.map((u) => [String(u._id), u]));
    const tMap = new Map(totals.map((t) => [String(t._id), t.n]));
    res.json({
      days, min,
      items: rows.map((r) => {
        const byCode = {};
        r.codes.forEach((c) => { byCode[c] = (byCode[c] || 0) + 1; });
        return {
          user: uMap.get(String(r._id)) || { _id: r._id },
          cancelled: r.cancelled,
          totalOrders: tMap.get(String(r._id)) || r.cancelled,
          byCode,
          lastAt: r.last,
          restaurants: (r.restaurants || []).filter(Boolean).slice(0, 5),
        };
      }),
    });
  }),

  // GET /api/admin/restricted-customers
  restricted: asyncHandler(async (_req, res) => {
    const users = await User.find({ $or: [{ 'cashDisabled.active': true }, { status: 'BLOCKED' }] })
      .select('firstName lastName username phone telegramId photoUrl status cashDisabled blockInfo createdAt')
      .sort({ updatedAt: -1 }).limit(500).lean();
    res.json({ users });
  }),

  // PATCH /api/admin/customers/:id/restrictions  { cash?: {active, reason}, block?: {active, reason} }
  setRestrictions: asyncHandler(async (req, res) => {
    if (!isId(req.params.id)) return res.status(404).json({ error: 'Topilmadi' });
    const item = z.object({ active: z.boolean(), reason: z.string().max(600).optional() });
    const b = z.object({ cash: item.optional(), block: item.optional() }).safeParse(req.body);
    if (!b.success) return res.status(400).json({ error: 'Ma‘lumot noto‘g‘ri' });
    const by = req.role === 'admin' ? 'Admin' : 'Xodim';
    const { cash, block } = b.data;
    if ((cash?.active || block?.active) && !config.customerRestrictionsEnabled) {
      return res.status(403).json({ error: 'Mijoz cheklovlari o‘chirilgan (CUSTOMER_RESTRICTIONS_ENABLED=false)' });
    }
    const needReason = (x) => x?.active && String(x.reason || '').trim().length < 5;
    if (needReason(cash) || needReason(block)) return res.status(400).json({ error: 'Mijozga ko‘rsatiladigan sababni yozing' });

    if (cash?.active || block?.active) {
      await applyRestrictions(req.params.id, {
        disableCash: Boolean(cash?.active), block: Boolean(block?.active),
        reason: String((block?.active ? block.reason : cash.reason) || '').trim(), by,
      });
    }
    if (cash && !cash.active) await liftRestrictions(req.params.id, { cash: true });
    if (block && !block.active) await liftRestrictions(req.params.id, { block: true });
    const user = await User.findById(req.params.id).select('firstName lastName username phone telegramId status cashDisabled blockInfo').lean();
    res.json({ user });
  }),
};
