import { z } from 'zod';
import { Types } from 'mongoose';
import { asyncHandler } from '../middleware/error.js';
import { Courier, normalizePhone } from '../models/Courier.js';
import { Order } from '../models/Order.js';
import { Ledger } from '../models/Ledger.js';
import { Restaurant } from '../models/Restaurant.js';
import { Settings, getSettings } from '../models/Settings.js';
import { DISTRICTS, DEFAULT_DISTRICT, isDistrict, normalizeDistricts } from '../constants/districts.js';
import { COURIER_MODES } from '../services/deliveryParty.js';
import { hashPin, verifyPin, isPinAcceptable, signCourierToken } from '../services/courierAuth.js';
import {
  CourierPoolError, listPool, myActiveOrders, claimOrder, releaseOrder, adminAssign, setOrderParty,
  courierBalanceSom, openCashExposureSom, debtLimitFor, poolCard, POOL_STATUSES, ACTIVE_STATUSES,
} from '../services/courierPool.js';
import { changeOrderStatus, OrderFlowError } from '../services/orderFlow.js';
import { tiyinToSom } from '../services/orderFinance.js';

/*
 * ═══ YETKAZISH: TUMANLAR, LOKMAGO KURYERLARI, RESTORAN REJIMI ═══
 *
 * RUXSATLAR (routes/index.js):
 *   GET  /districts                                    — ochiq (client, kuryer ilovasi, panel)
 *   /courier/*                                         — kuryer ilovasi (courierAuth: telefon + PIN)
 *   PATCH /admin/restaurants/:id/courier-settings      — FAQAT bosh admin: rejim, tekin yetkazish, foiz (pulga ta'sir qiladi)
 *   PATCH /admin/restaurants/:id/district              — admin + "restaurants" bo'limi xodimi
 *   /admin/couriers (ro'yxat, qo'shish, tuman, blok)   — admin + "couriers" bo'limi
 *   POST /admin/couriers/:id/ledger (naqd topshirish, to'lov, tuzatish) — admin + "billing" bo'limi (buxgalter)
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

/* ══════════════ KURYER ILOVASI ══════════════ */
function orderForCourier(o) {
  const f = o.finance || {};
  const r = o.restaurantId && typeof o.restaurantId === 'object' ? o.restaurantId : {};
  const u = o.userId && typeof o.userId === 'object' ? o.userId : {};
  return {
    ...poolCard(o),
    claimedAt: o.lokmaCourier?.claimedAt || null,
    pickedUpAt: o.lokmaCourier?.pickedUpAt || null,
    restaurant: { name: r.name || '', address: r.address || '', lat: r.lat ?? null, lng: r.lng ?? null, phone: r.phone || '' },
    customer: {
      name: u.firstName || '',
      phone: o.phone || u.phone || '',
      address: o.address || '',
      addressNote: o.addressNote || '',
      lat: o.addressLat ?? null,
      lng: o.addressLng ?? null,
      comment: o.comment || '',
    },
    items: (o.items || []).map((it) => ({ name: it.name, quantity: it.quantity })),
    totalSom: tiyinToSom(f.totalCharged),
  };
}

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
    maxActiveOrders: Number(s?.courier?.maxActiveOrders ?? 3),
  };
}

export const courierAppController = {
  // POST /courier/auth/login { phone, pin }
  login: asyncHandler(async (req, res) => {
    const phoneKey = normalizePhone(req.body?.phone);
    const pin = String(req.body?.pin ?? '');
    if (phoneKey.length !== 9 || !/^\d{4,8}$/.test(pin)) return res.status(400).json({ error: 'Telefon yoki PIN noto‘g‘ri', code: 'BAD_INPUT' });
    const courier = await Courier.findOne({ phoneKey }).select('+pinHash status tokenVersion name').lean();
    // Bir xil javob — telefon bazada bormi-yo'qligini oshkor qilmaymiz
    if (!courier || !courier.pinHash || !verifyPin(pin, courier.pinHash)) {
      return res.status(401).json({ error: 'Telefon yoki PIN noto‘g‘ri', code: 'BAD_CREDENTIALS' });
    }
    if (courier.status !== 'active') {
      return res.status(403).json({ error: courier.status === 'pending' ? 'Akkaunt hali tasdiqlanmagan' : 'Akkaunt bloklangan', code: courier.status === 'pending' ? 'COURIER_PENDING' : 'COURIER_BLOCKED' });
    }
    await Courier.updateOne({ _id: courier._id }, { $set: { lastLoginAt: new Date() } });
    res.json({ token: signCourierToken(courier), courier: { id: String(courier._id), name: courier.name } });
  }),

  // GET /courier/me
  me: asyncHandler(async (req, res) => {
    const c = req.courier;
    res.json({
      courier: {
        id: req.courierId, name: c.name, phone: c.phone, vehicle: c.vehicle || '',
        workDistricts: c.workDistricts || [], isOnline: Boolean(c.isOnline), totalDeliveries: c.totalDeliveries || 0,
      },
      ...(await courierSummary(req.courierId, c)),
      districts: DISTRICTS,
    });
  }),

  // PATCH /courier/me { workDistricts?, isOnline?, vehicle? } — kuryer o'zi: bugun qaysi tumanlarda ishlaydi, onlayn/oflayn
  updateMe: asyncHandler(async (req, res) => {
    const schema = z.object({
      workDistricts: z.array(z.string()).max(20).optional(),
      isOnline: z.boolean().optional(),
      vehicle: z.enum(['foot', 'bike', 'moto', 'car', '']).optional(),
    }).strict();
    const parsed = schema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'Noto‘g‘ri ma‘lumot', code: 'BAD_INPUT' });
    const set = {};
    if (parsed.data.workDistricts) {
      const d = normalizeDistricts(parsed.data.workDistricts);
      if (d.length !== new Set(parsed.data.workDistricts).size) return res.status(400).json({ error: 'Noma‘lum tuman', code: 'BAD_DISTRICT' });
      set.workDistricts = d;
    }
    if (parsed.data.vehicle !== undefined) set.vehicle = parsed.data.vehicle;
    if (parsed.data.isOnline !== undefined) {
      const districts = set.workDistricts ?? req.courier.workDistricts ?? [];
      if (parsed.data.isOnline && !districts.length) return res.status(400).json({ error: 'Avval ishlaydigan tumanlaringizni tanlang', code: 'NO_DISTRICTS' });
      set.isOnline = parsed.data.isOnline;
      set.onlineAt = parsed.data.isOnline ? new Date() : null;
    }
    const c = await Courier.findByIdAndUpdate(req.courierId, { $set: set }, { new: true }).select('workDistricts isOnline vehicle').lean();
    res.json({ workDistricts: c.workDistricts, isOnline: c.isOnline, vehicle: c.vehicle });
  }),

  // GET /courier/pool — umumiy quti (faqat o'z tumanlari, mijoz manzilisiz)
  pool: asyncHandler(async (req, res) => {
    const c = await Courier.findById(req.courierId).select('workDistricts isOnline').lean();
    res.set('Cache-Control', 'no-store').json({ isOnline: Boolean(c?.isOnline), workDistricts: c?.workDistricts || [], orders: await listPool(c) });
  }),

  // GET /courier/orders/active — olingan buyurtmalar (to'liq ma'lumot)
  active: asyncHandler(async (req, res) => {
    res.set('Cache-Control', 'no-store').json({ orders: (await myActiveOrders(req.courierId)).map(orderForCourier) });
  }),

  // GET /courier/orders/history?days=30
  history: asyncHandler(async (req, res) => {
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 30));
    const since = new Date(Date.now() - days * 86400000);
    const rows = await Order.find({ 'lokmaCourier.courierId': new Types.ObjectId(req.courierId), status: 'delivered', deliveredAt: { $gte: since } })
      .sort({ deliveredAt: -1 }).limit(300)
      .select('dailyNumber deliveredAt paymentMethod finance district restaurantName').lean();
    res.json({
      days,
      totalEarningSom: round2(rows.reduce((s, o) => s + tiyinToSom(o.finance?.courierPayout), 0)),
      orders: rows.map((o) => ({
        id: String(o._id), number: o.dailyNumber ?? null, deliveredAt: o.deliveredAt, district: o.district,
        restaurantName: o.restaurantName || '', paymentMethod: o.paymentMethod,
        earningSom: tiyinToSom(o.finance?.courierPayout), cashCollectedSom: o.paymentMethod === 'cash' ? tiyinToSom(o.finance?.totalCharged) : 0,
      })),
    });
  }),

  // GET /courier/ledger — balans harakatlari
  ledger: asyncHandler(async (req, res) => {
    const rows = await Ledger.find({ courierId: new Types.ObjectId(req.courierId) }).sort({ createdAt: -1 }).limit(200)
      .select('type amount orderId createdAt meta.note').lean();
    res.json({ ...(await courierSummary(req.courierId, req.courier)), entries: rows });
  }),

  claim: asyncHandler(async (req, res) => {
    if (!isOid(req.params.id)) return res.status(400).json({ error: 'Noto‘g‘ri ID' });
    try {
      const { already } = await claimOrder(req.courierId, req.params.id);
      res.json({ ok: true, already });
    } catch (e) { sendError(res, e); }
  }),

  release: asyncHandler(async (req, res) => {
    if (!isOid(req.params.id)) return res.status(400).json({ error: 'Noto‘g‘ri ID' });
    try { res.json(await releaseOrder(req.courierId, req.params.id)); } catch (e) { sendError(res, e); }
  }),

  // POST /courier/orders/:id/pickup — "Restorandan oldim" (restoran "Tayyor" bosmagan bo'lsa ham — taom qo'lda)
  pickup: asyncHandler(async (req, res) => {
    if (!isOid(req.params.id)) return res.status(400).json({ error: 'Noto‘g‘ri ID' });
    const order = await Order.findOne({ _id: req.params.id, 'lokmaCourier.courierId': new Types.ObjectId(req.courierId) })
      .select('restaurantId status').lean();
    if (!order) return res.status(404).json({ error: 'Buyurtma topilmadi', code: 'NOT_FOUND' });
    try {
      if (['accepted', 'preparing'].includes(order.status)) {
        await changeOrderStatus({ orderId: order._id, restaurantId: order.restaurantId, status: 'ready', actorName: req.courier.name });
      }
      await changeOrderStatus({ orderId: order._id, restaurantId: order.restaurantId, status: 'delivering', actorName: req.courier.name, courierId: req.courierId });
      res.json({ ok: true });
    } catch (e) { sendError(res, e); }
  }),

  // POST /courier/orders/:id/deliver — "Mijozga topshirdim" (naqd bo'lsa — pul olingan deb hisoblanadi)
  deliver: asyncHandler(async (req, res) => {
    if (!isOid(req.params.id)) return res.status(400).json({ error: 'Noto‘g‘ri ID' });
    const order = await Order.findOne({ _id: req.params.id, 'lokmaCourier.courierId': new Types.ObjectId(req.courierId) })
      .select('restaurantId status').lean();
    if (!order) return res.status(404).json({ error: 'Buyurtma topilmadi', code: 'NOT_FOUND' });
    try {
      const { changed } = await changeOrderStatus({ orderId: order._id, restaurantId: order.restaurantId, status: 'delivered', actorName: req.courier.name, courierId: req.courierId });
      res.json({ ok: true, alreadyDelivered: !changed, ...(await courierSummary(req.courierId, req.courier)) });
    } catch (e) { sendError(res, e); }
  }),
};

/* ══════════════ ADMIN: KURYERLAR ══════════════ */
const courierBody = z.object({
  name: z.string().trim().min(2).max(80),
  phone: z.string().trim().max(32),
  pin: z.string().optional(),
  telegramChatId: z.string().trim().max(32).optional(),
  telegramUsername: z.string().trim().max(64).optional(),
  status: z.enum(['pending', 'active', 'blocked']).optional(),
  blockedReason: z.string().trim().max(200).optional(),
  workDistricts: z.array(z.string()).max(20).optional(),
  vehicle: z.enum(['foot', 'bike', 'moto', 'car', '']).optional(),
  debtLimitSom: z.number().min(0).max(100000000).nullable().optional(),
  // Eski admin panel (2026-08) "Faol/Nofaol" tugmasi shuni yuboradi — status'ga aylantiriladi (moslik)
  isActive: z.boolean().optional(),
}).strict();

async function balancesFor(ids) {
  if (!ids.length) return new Map();
  const rows = await Ledger.aggregate([
    { $match: { courierId: { $in: ids.map((i) => new Types.ObjectId(String(i))) } } },
    { $group: { _id: '$courierId', total: { $sum: '$amount' } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), round2(r.total)]));
}

export const adminCourierController = {
  list: asyncHandler(async (_req, res) => {
    const couriers = await Courier.find().select('+pinHash').sort({ status: 1, isOnline: -1, name: 1 }).lean();
    const ids = couriers.map((c) => c._id);
    const [balances, activeRows] = await Promise.all([
      balancesFor(ids),
      Order.aggregate([
        { $match: { 'lokmaCourier.courierId': { $in: ids }, status: { $in: ACTIVE_STATUSES } } },
        { $group: { _id: '$lokmaCourier.courierId', n: { $sum: 1 } } },
      ]),
    ]);
    const active = new Map(activeRows.map((r) => [String(r._id), r.n]));
    // PIN hash HECH QACHON javobga chiqmaydi — faqat "PIN o'rnatilganmi"
    res.json(couriers.map(({ pinHash, ...c }) => ({ ...c, hasPin: Boolean(pinHash), balanceSom: balances.get(String(c._id)) || 0, activeOrders: active.get(String(c._id)) || 0 })));
  }),

  create: asyncHandler(async (req, res) => {
    const parsed = courierBody.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'Noto‘g‘ri ma‘lumot', details: parsed.error.flatten() });
    const d = parsed.data;
    const phoneKey = normalizePhone(d.phone);
    if (phoneKey.length !== 9) return res.status(400).json({ error: 'Telefon raqami noto‘g‘ri', code: 'BAD_PHONE' });
    if (await Courier.exists({ phoneKey })) return res.status(409).json({ error: 'Bu telefon bilan kuryer allaqachon bor', code: 'PHONE_TAKEN' });
    if (d.pin !== undefined && !isPinAcceptable(d.pin)) return res.status(400).json({ error: 'PIN 4–8 raqam bo‘lsin va oddiy bo‘lmasin (1111, 1234 emas)', code: 'WEAK_PIN' });
    const status = d.status || 'active';
    const courier = await Courier.create({
      name: d.name, phone: d.phone, phoneKey,
      telegramChatId: d.telegramChatId || '', telegramUsername: d.telegramUsername || '',
      status, isActive: status === 'active', blockedReason: d.blockedReason || '',
      workDistricts: normalizeDistricts(d.workDistricts || []),
      vehicle: d.vehicle || '', debtLimitSom: d.debtLimitSom ?? null,
      pinHash: d.pin ? hashPin(d.pin) : '',
    });
    const out = courier.toObject();
    delete out.pinHash;
    res.status(201).json(out);
  }),

  /*
   * XATO TUZATILDI: avval `req.body` dagi istalgan qiymat tekshiruvsiz yozilardi (bo'sh ism, matnli isActive ...).
   * Endi zod bilan; PIN almashsa yoki bloklansa — tokenVersion++ (eski sessiyalar darhol bekor), bloklanganda oflayn.
   */
  update: asyncHandler(async (req, res) => {
    if (!isOid(req.params.id)) return res.status(400).json({ error: 'Noto‘g‘ri ID' });
    const parsed = courierBody.partial().safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'Noto‘g‘ri ma‘lumot', details: parsed.error.flatten() });
    const d = parsed.data;
    const set = {};
    const inc = {};
    for (const k of ['name', 'telegramChatId', 'telegramUsername', 'blockedReason', 'vehicle']) if (d[k] !== undefined) set[k] = d[k];
    if (d.debtLimitSom !== undefined) set.debtLimitSom = d.debtLimitSom;
    if (d.workDistricts) set.workDistricts = normalizeDistricts(d.workDistricts);
    if (d.phone !== undefined) {
      const phoneKey = normalizePhone(d.phone);
      if (phoneKey.length !== 9) return res.status(400).json({ error: 'Telefon raqami noto‘g‘ri', code: 'BAD_PHONE' });
      if (await Courier.exists({ phoneKey, _id: { $ne: req.params.id } })) return res.status(409).json({ error: 'Bu telefon bilan kuryer allaqachon bor', code: 'PHONE_TAKEN' });
      set.phone = d.phone; set.phoneKey = phoneKey;
    }
    if (d.pin !== undefined) {
      if (!isPinAcceptable(d.pin)) return res.status(400).json({ error: 'PIN 4–8 raqam bo‘lsin va oddiy bo‘lmasin (1111, 1234 emas)', code: 'WEAK_PIN' });
      set.pinHash = hashPin(d.pin);
      inc.tokenVersion = 1;
    }
    if (!d.status && typeof d.isActive === 'boolean') d.status = d.isActive ? 'active' : 'blocked';
    if (d.status) {
      set.status = d.status;
      set.isActive = d.status === 'active';
      if (d.status !== 'active') { set.isOnline = false; inc.tokenVersion = 1; }
    }
    const courier = await Courier.findByIdAndUpdate(req.params.id, { $set: set, ...(Object.keys(inc).length ? { $inc: inc } : {}) }, { new: true }).lean();
    if (!courier) return res.status(404).json({ error: 'Kuryer topilmadi' });
    delete courier.pinHash;
    res.json(courier);
  }),

  /*
   * XATO TUZATILDI: avval kuryer butunlay o'chirilardi — endi uning balans tarixi (Ledger) yoki faol buyurtmasi bo'lsa
   * O'CHIRILMAYDI (pul izi yo'qolmasin), bloklash taklif qilinadi.
   */
  remove: asyncHandler(async (req, res) => {
    if (!isOid(req.params.id)) return res.status(400).json({ error: 'Noto‘g‘ri ID' });
    const id = new Types.ObjectId(req.params.id);
    const [hasLedger, hasOrders] = await Promise.all([Ledger.exists({ courierId: id }), Order.exists({ 'lokmaCourier.courierId': id })]);
    if (hasLedger || hasOrders) {
      return res.status(409).json({ error: 'Kuryerning buyurtma/balans tarixi bor — o‘chirib bo‘lmaydi, bloklang', code: 'HAS_HISTORY' });
    }
    await Courier.deleteOne({ _id: id });
    res.json({ ok: true });
  }),

  ledger: asyncHandler(async (req, res) => {
    if (!isOid(req.params.id)) return res.status(400).json({ error: 'Noto‘g‘ri ID' });
    const courier = await Courier.findById(req.params.id).select('name debtLimitSom').lean();
    if (!courier) return res.status(404).json({ error: 'Kuryer topilmadi' });
    const rows = await Ledger.find({ courierId: new Types.ObjectId(req.params.id) }).sort({ createdAt: -1 }).limit(500).lean();
    res.json({ courier, ...(await courierSummary(req.params.id, courier)), entries: rows });
  }),

  /*
   * POST /admin/couriers/:id/ledger { type, amountSom, note }
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
    if (!(await Courier.exists({ _id: req.params.id }))) return res.status(404).json({ error: 'Kuryer topilmadi' });
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
    const d = req.query.district && isDistrict(req.query.district) ? [String(req.query.district)] : DISTRICTS.map((x) => x.id);
    const [waiting, assigned] = await Promise.all([
      listPool({ workDistricts: d }, { limit: 100 }),
      Order.find({ courierParty: 'lokma', 'lokmaCourier.courierId': { $ne: null }, status: { $in: ACTIVE_STATUSES }, district: { $in: d } })
        .select('dailyNumber status district restaurantName lokmaCourier paymentMethod finance').populate('lokmaCourier.courierId', 'name phone').lean(),
    ]);
    res.set('Cache-Control', 'no-store').json({
      waiting,
      assigned: assigned.map((o) => ({
        id: String(o._id), number: o.dailyNumber ?? null, status: o.status, district: o.district, restaurantName: o.restaurantName || '',
        courier: o.lokmaCourier?.courierId ? { id: String(o.lokmaCourier.courierId._id), name: o.lokmaCourier.courierId.name, phone: o.lokmaCourier.courierId.phone } : null,
        claimedAt: o.lokmaCourier?.claimedAt, pickedUpAt: o.lokmaCourier?.pickedUpAt,
        paymentMethod: o.paymentMethod, cashToCollectSom: o.paymentMethod === 'cash' ? tiyinToSom(o.finance?.totalCharged) : 0,
      })),
    });
  }),

  assign: asyncHandler(async (req, res) => {
    if (!isOid(req.params.id) || !isOid(req.body?.courierId)) return res.status(400).json({ error: 'Noto‘g‘ri ID' });
    try { await adminAssign(req.params.id, req.body.courierId); res.json({ ok: true }); } catch (e) { sendError(res, e); }
  }),

  release: asyncHandler(async (req, res) => {
    if (!isOid(req.params.id)) return res.status(400).json({ error: 'Noto‘g‘ri ID' });
    try { res.json(await releaseOrder(null, req.params.id, { byAdmin: true })); } catch (e) { sendError(res, e); }
  }),

  // GET/PATCH /admin/courier-settings — global foiz, qarz chegarasi, bir vaqtdagi buyurtmalar (FAQAT bosh admin)
  getSettings: asyncHandler(async (_req, res) => {
    const s = await getSettings();
    res.json({ commissionPercent: s?.courier?.commissionPercent ?? 10, debtLimitSom: s?.courier?.debtLimitSom ?? 500000, maxActiveOrders: s?.courier?.maxActiveOrders ?? 3 });
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
      .select('name district courierMode lokmaFreeDelivery lokmaCourierPercent courierSettingsUpdatedAt').lean();
    if (!r) return res.status(404).json({ error: 'Restoran topilmadi' });
    console.log(`[courier-settings] restoran ${r.name}: ${JSON.stringify(d)} — ${req.userId}`);
    res.json({ ...r, freeDeliveryActive: r.courierMode === 'lokma' && r.lokmaFreeDelivery === true });
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
