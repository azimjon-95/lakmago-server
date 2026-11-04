import { z } from 'zod';
import { Types } from 'mongoose';
import { asyncHandler } from '../middleware/error.js';
import { CourierAccount } from '../models/CourierAccount.js';
import { Order } from '../models/Order.js';
import { Ledger } from '../models/Ledger.js';
import { Restaurant } from '../models/Restaurant.js';
import { Settings, getSettings } from '../models/Settings.js';
import { DISTRICTS, DEFAULT_DISTRICT, isDistrict, normalizeDistricts } from '../constants/districts.js';
import { COURIER_MODES } from '../services/deliveryParty.js';
import {
  CourierPoolError, listPoolForAdmin, adminAssign, releaseOrder, setOrderParty,
  courierBalanceSom, openCashExposureSom, debtLimitFor, ACTIVE_STATUSES, POOL_STATUSES,
} from '../services/courierPool.js';
import { liveCouriers, courierTrack, orderTrace, flaggedEvents } from '../services/courierTrack.js';
import { OrderFlowError } from '../services/orderFlow.js';
import { tiyinToSom } from '../services/orderFinance.js';

/*
 * ═══ YETKAZISH: TUMANLAR, LOKMAGO KURYERLARI, RESTORAN REJIMI ═══
 *
 * RUXSATLAR (routes/index.js):
 *   GET  /districts                                    — ochiq (client, kuryer ilovasi, panel)
 *   /courier/*                                         — kuryer ilovasi (courierAuth: telefon + PIN)
 *   PATCH /admin/restaurants/:id/courier-settings      — FAQAT bosh admin: rejim, tekin yetkazish, foiz (pulga ta'sir qiladi)
 *   PATCH /admin/restaurants/:id/district              — admin + "restaurants" bo'limi xodimi
 *   /admin/courier-accounts (ro'yxat, qo'shish, tuman, blok)   — admin + "couriers" bo'limi
 *   POST /admin/courier-accounts/:id/ledger (naqd topshirish, to'lov, tuzatish) — admin + "billing" bo'limi (buxgalter)
 *   GET/PATCH /admin/courier-settings (global foiz, qarz chegarasi) — FAQAT bosh admin
 *   POST /panel/orders/:id/courier-party               — restoran, FAQAT 'both' rejimida
 */

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const isOid = (v) => Types.ObjectId.isValid(String(v || ''));

function sendError(res, e) {
  if (e instanceof CourierPoolError) return res.status(e.status).json({ error: e.message, code: e.code, ...e.extra });
  if (e instanceof OrderFlowError) return res.status(e.code === 'NOT_FOUND' ? 404 : 409).json({ error: e.message, code: e.code });
  throw e;
}

/* ══════════════ TUMANLAR (ochiq) ══════════════ */
export const districtsController = {
  list: asyncHandler(async (_req, res) => {
    res.set('Cache-Control', 'public, max-age=3600').json({ region: 'namangan', defaultDistrict: DEFAULT_DISTRICT, districts: DISTRICTS });
  }),
};

/* ══════════════ KURYER SUMMARY (admin kassa) ══════════════ */
async function courierSummary(courierId, courier) {
  const [balanceSom, openCashSom, debtLimitSom, s] = await Promise.all([
    courierBalanceSom(courierId), openCashExposureSom(courierId), debtLimitFor(courier), getSettings(),
  ]);
  return {
    balanceSom,                                        // + LokmaGo qarzdor, − kuryer qo'lidagi LokmaGo puli
    openCashSom,                                       // olingan, hali topshirilmagan naqd buyurtmalar
    debtLimitSom,
    cashRoomSom: round2(debtLimitSom + balanceSom - openCashSom),   // yana qancha naqd buyurtma ola oladi
    commissionPercent: Number(s?.courier?.commissionPercent ?? 10),
    maxActiveOrders: Number(s?.courier?.maxActiveOrders ?? 1),
  };
}

/* ══════════════ ADMIN: KURYER KASSASI, QUTI, NAZORAT ══════════════ */
export const adminCourierController = {
  ledger: asyncHandler(async (req, res) => {
    if (!isOid(req.params.id)) return res.status(400).json({ error: 'Noto‘g‘ri ID' });
    const courier = await CourierAccount.findById(req.params.id).select('name debtLimitSom').lean();
    if (!courier) return res.status(404).json({ error: 'Kuryer topilmadi' });
    const rows = await Ledger.find({ courierId: new Types.ObjectId(req.params.id) }).sort({ createdAt: -1 }).limit(500).lean();
    res.json({ courier, ...(await courierSummary(req.params.id, courier)), entries: rows });
  }),

  /*
   * POST /admin/courier-accounts/:id/ledger { type, amountSom, note }
   *   courier_handover   — kuryer qo'lidagi naqdni topshirdi (+)
   *   courier_payout     — LokmaGo kuryerga ulushini to'ladi (−)
   *   courier_adjustment — tuzatish (± amountSom, sabab MAJBURIY)
   * Yozuvlar o'zgartirilmaydi/o'chirilmaydi — xato bo'lsa teskari tuzatish qo'shiladi (Ledger qoidasi).
   */
  addLedger: asyncHandler(async (req, res) => {
    if (!isOid(req.params.id)) return res.status(400).json({ error: 'Noto‘g‘ri ID' });
    const schema = z.object({
      type: z.enum(['courier_handover', 'courier_payout', 'courier_adjustment']),
      amountSom: z.number().finite(),
      note: z.string().trim().max(300).optional(),
    }).strict();
    const parsed = schema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'Noto‘g‘ri ma‘lumot', details: parsed.error.flatten() });
    const { type, note = '' } = parsed.data;
    const amt = round2(parsed.data.amountSom);
    if (amt === 0 || Math.abs(amt) > 100000000) return res.status(400).json({ error: 'Summa noto‘g‘ri', code: 'BAD_AMOUNT' });
    if (type !== 'courier_adjustment' && amt < 0) return res.status(400).json({ error: 'Summa musbat bo‘lsin', code: 'BAD_AMOUNT' });
    if (type === 'courier_adjustment' && note.length < 5) return res.status(400).json({ error: 'Tuzatish sababini yozing', code: 'NOTE_REQUIRED' });
    if (!(await CourierAccount.exists({ _id: req.params.id }))) return res.status(404).json({ error: 'Kuryer topilmadi' });
    const amount = type === 'courier_payout' ? -amt : amt;
    const row = await Ledger.create({
      type, amount, courierId: new Types.ObjectId(req.params.id),
      provider: type === 'courier_handover' ? 'cash' : null, isCash: type === 'courier_handover',
      meta: { note: note || (type === 'courier_handover' ? 'Naqd topshirildi' : 'Kuryerga to‘landi'), by: String(req.userId || ''), byRole: req.role, department: req.department || null },
    });
    res.status(201).json({ entry: row, balanceSom: await courierBalanceSom(req.params.id) });
  }),

  // GET /admin/courier-pool?district= — qutidagi (olinmagan) va kuryerdagi buyurtmalar
  pool: asyncHandler(async (req, res) => {
    const d = req.query.district && isDistrict(req.query.district) ? [String(req.query.district)] : null;
    const [waiting, assignedRows] = await Promise.all([
      listPoolForAdmin({ districts: d }),
      Order.find({ courierParty: 'lokma', 'lokmaCourier.courierId': { $ne: null }, status: { $in: ACTIVE_STATUSES }, ...(d ? { district: { $in: d } } : {}) })
        .select('dailyNumber status district restaurantName lokmaCourier paymentMethod finance items').populate('lokmaCourier.courierId', 'name phone').lean(),
    ]);
    res.set('Cache-Control', 'no-store').json({
      waiting,
      assigned: assignedRows.map((o) => ({
        id: String(o._id), number: o.dailyNumber ?? null, status: o.status, district: o.district, restaurantName: o.restaurantName || '',
        itemsLine: (o.items || []).map((i) => `${i.quantity}× ${i.name}`).join(', '),
        courier: o.lokmaCourier?.courierId ? { id: String(o.lokmaCourier.courierId._id), name: o.lokmaCourier.courierId.name, phone: o.lokmaCourier.courierId.phone } : null,
        claimedAt: o.lokmaCourier?.claimedAt, pickedUpAt: o.lokmaCourier?.pickedUpAt,
        paymentMethod: o.paymentMethod, cashToCollectSom: o.paymentMethod === 'cash' ? tiyinToSom(o.finance?.totalCharged) : 0,
      })),
    });
  }),

  /* ───── NAZORAT: jonli xarita, trek, buyurtma tarixi, shubhali voqealar ───── */

  // GET /admin/courier-accounts/live — smenadagi kuryerlar: qayerda, qaysi taomni qayerdan qayerga olib ketyapti
  live: asyncHandler(async (_req, res) => {
    res.set('Cache-Control', 'no-store').json({ at: new Date().toISOString(), couriers: await liveCouriers() });
  }),

  // GET /admin/courier-accounts/:id/track?from=&to= — kuryer yo'li (breadcrumb)
  track: asyncHandler(async (req, res) => {
    if (!isOid(req.params.id)) return res.status(400).json({ error: 'Noto‘g‘ri ID' });
    const day = 24 * 3600_000;
    const from = req.query.from ? new Date(req.query.from) : new Date(Date.now() - day);
    const to = req.query.to ? new Date(req.query.to) : new Date();
    if (Number.isNaN(+from) || Number.isNaN(+to)) return res.status(400).json({ error: 'Sana noto‘g‘ri' });
    res.set('Cache-Control', 'no-store').json(await courierTrack(req.params.id, { from, to }));
  }),

  // GET /admin/orders/:id/courier-trace — buyurtma bo'yicha to'liq nazorat (olish/oldi/topshirdi + joylashuv + yo'l)
  trace: asyncHandler(async (req, res) => {
    if (!isOid(req.params.id)) return res.status(400).json({ error: 'Noto‘g‘ri ID' });
    const t = await orderTrace(req.params.id);
    if (!t) return res.status(404).json({ error: 'Buyurtma topilmadi' });
    res.set('Cache-Control', 'no-store').json(t);
  }),

  // GET /admin/courier-events?flagged=1 — shubhali voqealar (uzoqdan "oldim/topshirdim", joylashuvsiz)
  events: asyncHandler(async (req, res) => {
    res.set('Cache-Control', 'no-store').json({ events: await flaggedEvents({ limit: Number(req.query.limit) || 100, since: req.query.since }) });
  }),

  assign: asyncHandler(async (req, res) => {
    if (!isOid(req.params.id) || !isOid(req.body?.courierId)) return res.status(400).json({ error: 'Noto‘g‘ri ID' });
    try { await adminAssign(req.params.id, req.body.courierId, { adminId: req.userId }); res.json({ ok: true }); } catch (e) { sendError(res, e); }
  }),

  release: asyncHandler(async (req, res) => {
    if (!isOid(req.params.id)) return res.status(400).json({ error: 'Noto‘g‘ri ID' });
    try { res.json(await releaseOrder(null, req.params.id, { byAdmin: true, adminId: req.userId })); } catch (e) { sendError(res, e); }
  }),

  // GET/PATCH /admin/courier-settings — global foiz, qarz chegarasi, bir vaqtdagi buyurtmalar (FAQAT bosh admin)
  getSettings: asyncHandler(async (_req, res) => {
    const s = await getSettings();
    res.json({ commissionPercent: s?.courier?.commissionPercent ?? 10, debtLimitSom: s?.courier?.debtLimitSom ?? 500000, maxActiveOrders: s?.courier?.maxActiveOrders ?? 1 });
  }),
  updateSettings: asyncHandler(async (req, res) => {
    const schema = z.object({
      commissionPercent: z.number().min(0).max(100).optional(),
      debtLimitSom: z.number().min(0).max(100000000).optional(),
      maxActiveOrders: z.number().int().min(1).max(10).optional(),
    }).strict();
    const parsed = schema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'Noto‘g‘ri ma‘lumot', details: parsed.error.flatten() });
    await getSettings();
    const set = {};
    for (const [k, v] of Object.entries(parsed.data)) set[`courier.${k}`] = k === 'commissionPercent' ? Math.round(v * 100) / 100 : v;
    const s = await Settings.findOneAndUpdate({ key: 'global' }, { $set: set }, { new: true }).lean();
    console.log(`[courier-settings] ${JSON.stringify(parsed.data)} — ${req.userId}`);
    res.json({ commissionPercent: s.courier.commissionPercent, debtLimitSom: s.courier.debtLimitSom, maxActiveOrders: s.courier.maxActiveOrders });
  }),
};

/* ══════════════ ADMIN: RESTORAN REJIMI va TUMANI ══════════════ */
export const adminRestaurantDeliveryController = {
  /*
   * PATCH /admin/restaurants/:id/courier-settings — FAQAT bosh admin.
   * Rejim o'zgarishi YANGI buyurtmalarga ta'sir qiladi; mavjud buyurtmalar o'z snapshot'i bilan qoladi (pul o'zgarmaydi).
   */
  updateCourierSettings: asyncHandler(async (req, res) => {
    if (!isOid(req.params.id)) return res.status(400).json({ error: 'Noto‘g‘ri ID' });
    const schema = z.object({
      courierMode: z.enum(COURIER_MODES).optional(),
      lokmaFreeDelivery: z.boolean().optional(),
      lokmaCourierPercent: z.number().min(0).max(100).nullable().optional(),
      district: z.string().optional(),
    }).strict();
    const parsed = schema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'Noto‘g‘ri ma‘lumot', details: parsed.error.flatten() });
    const d = parsed.data;
    if (d.district !== undefined && !isDistrict(d.district)) return res.status(400).json({ error: 'Noma‘lum tuman', code: 'BAD_DISTRICT' });
    const set = { courierSettingsUpdatedAt: new Date(), courierSettingsUpdatedBy: String(req.userId || '') };
    for (const k of ['courierMode', 'lokmaFreeDelivery', 'district']) if (d[k] !== undefined) set[k] = d[k];
    if (d.lokmaCourierPercent !== undefined) set.lokmaCourierPercent = d.lokmaCourierPercent === null ? null : Math.round(d.lokmaCourierPercent * 100) / 100;
    const r = await Restaurant.findByIdAndUpdate(req.params.id, { $set: set }, { new: true })
      .select('name district courierMode lokmaFreeDelivery lokmaCourierPercent courierSettingsUpdatedAt exclusiveCouriers').lean();
    if (!r) return res.status(404).json({ error: 'Restoran topilmadi' });
    console.log(`[courier-settings] restoran ${r.name}: ${JSON.stringify(d)} — ${req.userId}`);
    res.json({ ...r, freeDeliveryActive: r.courierMode === 'lokma' && r.lokmaFreeDelivery === true });
  }),

  /*
   * PUT /admin/restaurants/:id/couriers { courierIds: [...] } — restoranga kuryerlarni BIRIKTIRISH ("kuryerlar" bo'limi).
   * Ro'yxat bo'sh emas bo'lsa: shu restoranning LokmaGo buyurtmalarini FAQAT shu kuryerlar ko'radi va oladi (tumanidan qat'i nazar);
   * bo'sh — hamma (tumani mos kuryerlar). To'liq ro'yxat almashtiriladi (qo'shish/olib tashlash bitta so'rovda).
   */
  setExclusiveCouriers: asyncHandler(async (req, res) => {
    if (!isOid(req.params.id)) return res.status(400).json({ error: 'Noto‘g‘ri ID' });
    const parsed = z.object({ courierIds: z.array(z.string().regex(/^[0-9a-fA-F]{24}$/)).max(50) }).strict().safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'Noto‘g‘ri ma‘lumot' });
    const ids = [...new Set(parsed.data.courierIds)];
    if (ids.length && (await CourierAccount.countDocuments({ _id: { $in: ids } })) !== ids.length) {
      return res.status(400).json({ error: 'Ro‘yxatda mavjud bo‘lmagan kuryer bor', code: 'BAD_COURIER' });
    }
    const r = await Restaurant.findByIdAndUpdate(req.params.id, { $set: { exclusiveCouriers: ids.map((x) => new Types.ObjectId(x)) } }, { new: true })
      .select('name courierMode exclusiveCouriers').lean();
    if (!r) return res.status(404).json({ error: 'Restoran topilmadi' });
    console.log(`[courier-bind] restoran ${r.name}: ${ids.length} ta kuryer — ${req.userId}`);
    res.json({ id: String(r._id), exclusiveCouriers: (r.exclusiveCouriers || []).map(String), courierMode: r.courierMode || 'own', activeInMode: r.courierMode !== 'own' });
  }),

  // PATCH /admin/restaurants/:id/district — tuman (restoranlar bo'limi xodimi ham)
  updateDistrict: asyncHandler(async (req, res) => {
    if (!isOid(req.params.id)) return res.status(400).json({ error: 'Noto‘g‘ri ID' });
    const district = String(req.body?.district || '');
    if (!isDistrict(district)) return res.status(400).json({ error: 'Noma‘lum tuman', code: 'BAD_DISTRICT' });
    const r = await Restaurant.findByIdAndUpdate(req.params.id, { $set: { district } }, { new: true }).select('name district').lean();
    if (!r) return res.status(404).json({ error: 'Restoran topilmadi' });
    res.json(r);
  }),
};

/* ══════════════ RESTORAN PANELI ══════════════ */
export const panelDeliveryController = {
  // GET /panel/courier-settings — restoran o'z rejimini ko'radi (o'zgartira olmaydi)
  info: asyncHandler(async (req, res) => {
    const r = await Restaurant.findById(req.restaurantId).select('district courierMode lokmaFreeDelivery').lean();
    if (!r) return res.status(404).json({ error: 'Restoran topilmadi' });
    res.json({
      district: r.district || DEFAULT_DISTRICT,
      courierMode: COURIER_MODES.includes(r.courierMode) ? r.courierMode : 'own',
      freeDeliveryActive: r.courierMode === 'lokma' && r.lokmaFreeDelivery === true,
      canChoosePerOrder: r.courierMode === 'both',
    });
  }),

  // POST /panel/orders/:id/courier-party { party: 'restaurant' | 'lokma' } — faqat 'both' rejimida
  setParty: asyncHandler(async (req, res) => {
    if (!isOid(req.params.id)) return res.status(400).json({ error: 'Noto‘g‘ri ID' });
    try {
      const { order, changed } = await setOrderParty({ restaurantId: req.restaurantId, orderId: req.params.id, party: String(req.body?.party || ''), actor: String(req.userId || '') });
      res.json({ ok: true, changed, courierParty: order.courierParty, inPool: order.courierParty === 'lokma' && POOL_STATUSES.includes(order.status) });
    } catch (e) { sendError(res, e); }
  }),
};
