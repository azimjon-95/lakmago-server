import { z } from 'zod';
import { asyncHandler } from '../middleware/error.js';
import { signCourierToken } from '../middleware/courierAuth.js';
import { CourierAccount } from '../models/CourierAccount.js';
import { CourierDevice } from '../models/CourierDevice.js';
import * as app from '../services/courierApp.js';
import { notifyOfferClosed, testCourierPush } from '../services/courierPush.js';
import { onShiftCount } from '../services/courierPresence.js';

/**
 * Kuryer ilovasi API (`/api/courier-app/*`). Kuryer identifikatori FAQAT tokendan (courierAuth → req.courier) — bodyda yo'q.
 * Boshqa kuryerning buyurtmasi / tarixi / joylashuviga kirish yo'li yo'q: hamma so'rov `assignedAccountId = req.courierId` bo'yicha.
 */
const send = (res, r) => (r.ok ? res.json(r) : res.status(r.status || 400).json({ error: r.error }));
const OID = /^[0-9a-fA-F]{24}$/;

export const courierAppController = {
  login: asyncHandler(async (req, res) => {
    const p = z.object({ login: z.string().trim().min(3).max(40), password: z.string().min(1).max(200) }).safeParse(req.body);
    if (!p.success) return res.status(400).json({ error: 'Login yoki parol noto‘g‘ri kiritildi' });
    const acc = await CourierAccount.findOne({ login: p.data.login.toLowerCase() });
    if (!acc || !acc.checkPassword(p.data.password)) return res.status(401).json({ error: 'Login yoki parol xato' });
    if (!acc.isActive) return res.status(403).json({ error: 'Akkaunt bloklangan. Administrator bilan bog‘laning.' });
    await CourierAccount.updateOne({ _id: acc._id }, { $set: { lastLoginAt: new Date() } });
    res.json({ token: signCourierToken(acc._id), courier: { id: String(acc._id), login: acc.login, name: acc.name, phone: acc.phone, vehicle: acc.vehicle } });
  }),

  me: asyncHandler(async (req, res) => res.json({ courier: { id: req.courierId, name: req.courier.name, phone: req.courier.phone, vehicle: req.courier.vehicle }, ...(await app.shiftState(req.courierId)) })),

  shift: asyncHandler(async (req, res) => res.json(await app.shiftState(req.courierId))),
  shiftStart: asyncHandler(async (req, res) => send(res, await app.startShift(req.courierId))),
  shiftEnd: asyncHandler(async (req, res) => send(res, await app.endShift(req.courierId))),
  shifts: asyncHandler(async (req, res) => res.json(await app.shiftHistory(req.courierId, Number(req.query.limit) || 30))),

  location: asyncHandler(async (req, res) => {
    const p = z.object({ lat: z.number(), lng: z.number(), accuracy: z.number().optional(), speed: z.number().optional(), heading: z.number().optional() }).safeParse(req.body);
    if (!p.success) return res.status(400).json({ error: 'Joylashuv noto‘g‘ri' });
    const r = await app.recordLocation(req.courier, p.data);
    if (!r.ok) return res.status(r.status || 400).json({ error: r.error });
    res.status(204).end();
  }),

  offers: asyncHandler(async (req, res) => res.json(await app.listOffers(req.courierId))),

  accept: asyncHandler(async (req, res) => {
    if (!OID.test(req.params.id)) return res.status(400).json({ error: 'Noto‘g‘ri so‘rov' });
    const r = await app.acceptOffer({ _id: req.courier._id, ...req.courier }, req.params.id);
    if (r.ok) notifyOfferClosed(req.params.id, req.courierId).catch(() => {});      // boshqalarda signal to'xtasin (kutilmaydi)
    send(res, r);
  }),

  active: asyncHandler(async (req, res) => { const a = await app.activeAssignment(req.courierId); res.json({ active: a ? app.activeView(a) : null }); }),
  deliver: asyncHandler(async (req, res) => send(res, await app.deliverActive({ _id: req.courier._id, ...req.courier }))),

  history: asyncHandler(async (req, res) => res.json(await app.history(req.courierId, { limit: Number(req.query.limit) || 30, before: req.query.before }))),
  stats: asyncHandler(async (req, res) => res.json(await app.stats(req.courierId))),

  registerDevice: asyncHandler(async (req, res) => {
    const p = z.object({ token: z.string().trim().min(20).max(4096), platform: z.enum(['android', 'ios']), environment: z.enum(['development', 'production']).optional(), appVersion: z.string().trim().max(32).optional() }).safeParse(req.body);
    if (!p.success) return res.status(400).json({ error: 'Token yoki platforma noto‘g‘ri' });
    await CourierDevice.findOneAndUpdate({ token: p.data.token }, { $set: { platform: p.data.platform, courierId: req.courierId, lastSeen: new Date(), failCount: 0, lastError: '', ...(p.data.environment ? { environment: p.data.environment } : {}), ...(p.data.appVersion !== undefined ? { appVersion: p.data.appVersion } : {}) } }, { upsert: true, setDefaultsOnInsert: true });
    res.status(204).end();
  }),
  unregisterDevice: asyncHandler(async (req, res) => {
    const p = z.object({ token: z.string().trim().min(20).max(4096) }).safeParse(req.body);
    if (!p.success) return res.status(400).json({ error: 'Token noto‘g‘ri' });
    await CourierDevice.deleteOne({ token: p.data.token, courierId: req.courierId });      // faqat O'Z tokeni
    res.status(204).end();
  }),
  testPush: asyncHandler(async (req, res) => res.json({ sent: await testCourierPush(req.courierId) })),
};

/** Admin: kuryer akkauntlarini yaratish / bloklash / parolni tiklash (`couriers` ruxsati bilan). Parol hech qachon qaytarilmaydi. */
const pub = (c) => ({ id: String(c._id), login: c.login, name: c.name, phone: c.phone, vehicle: c.vehicle, isActive: c.isActive, onShift: !!c.activeShiftId, lastLoginAt: c.lastLoginAt, createdAt: c.createdAt });
export const courierAccountAdminController = {
  list: asyncHandler(async (_req, res) => res.json({ onlineNow: await onShiftCount(), couriers: (await CourierAccount.find().sort({ isActive: -1, name: 1 }).lean()).map(pub) })),
  create: asyncHandler(async (req, res) => {
    const p = z.object({ login: z.string().trim().min(3).max(40), password: z.string().min(8).max(100), name: z.string().trim().min(2).max(60), phone: z.string().trim().max(20).optional(), vehicle: z.enum(['', 'scooter', 'bike', 'car', 'foot']).optional() }).safeParse(req.body);
    if (!p.success) return res.status(400).json({ error: 'Ma‘lumot noto‘g‘ri (parol kamida 8 belgi)' });
    if (await CourierAccount.exists({ login: p.data.login.toLowerCase() })) return res.status(409).json({ error: 'Bu login band' });
    const c = await CourierAccount.create({ login: p.data.login, passwordHash: CourierAccount.hash(p.data.password), name: p.data.name, phone: p.data.phone || '', vehicle: p.data.vehicle || '' });
    res.status(201).json(pub(c));
  }),
  update: asyncHandler(async (req, res) => {
    const p = z.object({ name: z.string().trim().min(2).max(60), phone: z.string().trim().max(20), vehicle: z.enum(['', 'scooter', 'bike', 'car', 'foot']), isActive: z.boolean(), password: z.string().min(8).max(100) }).partial().strict().safeParse(req.body);
    if (!p.success || !OID.test(req.params.id)) return res.status(400).json({ error: 'Ma‘lumot noto‘g‘ri' });
    const { password, ...rest } = p.data;
    const set = { ...rest, ...(password ? { passwordHash: CourierAccount.hash(password) } : {}) };
    const c = await CourierAccount.findByIdAndUpdate(req.params.id, { $set: set }, { new: true });
    if (!c) return res.status(404).json({ error: 'Kuryer topilmadi' });
    if (rest.isActive === false) await app.endShift(c._id, 'auto');          // bloklangan kuryer smenada qolib ketmasin
    res.json(pub(c));
  }),
};
