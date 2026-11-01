import { z } from 'zod';
import { asyncHandler } from '../middleware/error.js';
import { NotifySettings } from '../models/NotifySettings.js';
import { NotificationLog } from '../models/NotificationLog.js';
import { MobileDevice } from '../models/MobileDevice.js';
import { getNotifySettings, invalidateNotifySettings } from '../services/notifySettings.js';

/**
 * Restoran o'z bildirishnoma sozlamalarini boshqaradi (admin panel «Bildirishnomalar»). restaurantId FAQAT JWT'dan.
 *  GET  /api/panel/notification-settings          joriy sozlama (yozilmagan bo'lsa standart)
 *  PUT  /api/panel/notification-settings          qisman yangilash; noma'lum maydon / noto'g'ri qiymat → 400
 *  GET  /api/panel/notifications/recent           oxirgi yuborishlar jurnali (holat, urinish, xato) — token va mijoz ma'lumoti YO'Q
 *  POST /api/panel/devices/ack                    ilova: «push yetib keldi» (received) / «bildirishnoma bosildi» (opened)
 */
const settingsSchema = z.object({
  sound: z.boolean(), vibration: z.boolean(), repeatEnabled: z.boolean(),
  repeatIntervalSec: z.union([z.literal(30), z.literal(60), z.literal(90)]),
  repeatLimit: z.number().int().min(1).max(20), soundType: z.enum(['default', 'custom']),
}).partial().strict();

export const notifySettingsController = {
  get: asyncHandler(async (req, res) => res.json(await getNotifySettings(req.restaurantId))),

  update: asyncHandler(async (req, res) => {
    const parsed = settingsSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Sozlama noto‘g‘ri (interval: 30 / 60 / 90, limit: 1–20)' });
    await NotifySettings.updateOne({ restaurantId: req.restaurantId }, { $set: parsed.data, $setOnInsert: { restaurantId: req.restaurantId } }, { upsert: true });
    invalidateNotifySettings(req.restaurantId);
    res.json(await getNotifySettings(req.restaurantId));
  }),

  recent: asyncHandler(async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const logs = await NotificationLog.find({ restaurantId: req.restaurantId }).sort({ sentAt: -1 }).limit(limit).lean();
    res.json(logs.map((l) => ({
      orderId: String(l.orderId), type: l.type, attempt: l.attempt, platform: l.platform, provider: l.provider,
      status: l.status, error: l.error || '', sentAt: l.sentAt, receivedAt: l.receivedAt, openedAt: l.openedAt,
    })));
  }),

  ack: asyncHandler(async (req, res) => {
    const parsed = z.object({
      token: z.string().trim().min(20).max(4096), orderId: z.string().regex(/^[0-9a-fA-F]{24}$/),
      attempt: z.number().int().min(0).max(50), event: z.enum(['received', 'opened']),
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Noto‘g‘ri so‘rov' });
    const { token, orderId, attempt, event } = parsed.data;
    // Faqat O'Z restoranining qurilmasi; topilmasa ham 204 (qurilma / buyurtma mavjudligi haqida ma'lumot bermaymiz)
    const device = await MobileDevice.findOne({ token, restaurantId: req.restaurantId }).select('_id').lean();
    if (device) {
      const now = new Date();
      const where = { orderId, restaurantId: req.restaurantId, type: 'NEW_ORDER', attempt, deviceKey: String(device._id) };
      if (event === 'received') await NotificationLog.updateOne({ ...where, status: 'SENT' }, { $set: { status: 'RECEIVED', receivedAt: now } });   // OPENED ni pasaytirmaydi
      else await NotificationLog.updateOne({ ...where, status: { $in: ['SENT', 'RECEIVED'] } }, { $set: { status: 'OPENED', openedAt: now } });
    }
    res.status(204).end();
  }),
};
