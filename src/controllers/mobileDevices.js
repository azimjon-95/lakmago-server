import { z } from 'zod';
import { asyncHandler } from '../middleware/error.js';
import { MobileDevice } from '../models/MobileDevice.js';
import { providers, providerCheck, sendTestPush } from '../services/mobilePush.js';

const lastTest = new Map();                 // restaurantId → oxirgi test vaqti (suiiste'moldan himoya)

/**
 * Restoran mobil ilovasining push tokeni. restaurantId FAQAT tokendan (requireRole('restaurant')) — bodyda yo'q.
 *  POST   /api/panel/devices  { token, platform: 'android'|'ios' }   ro'yxatga olish / yangilash (204)
 *  DELETE /api/panel/devices  { token }                              chiqishda (204)
 *  GET    /api/panel/devices                                         monitoring: qurilmalar va oxirgi natija
 */
const tokenSchema = z.string().trim().min(20).max(4096);

export const mobileDevicesController = {
  register: asyncHandler(async (req, res) => {
    const parsed = z.object({ token: tokenSchema, platform: z.enum(['android', 'ios']), environment: z.enum(['development', 'production']).optional() }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Token yoki platforma noto‘g‘ri' });
    const { token, platform, environment } = parsed.data;
    // Bir token — bitta restoran: telefon boshqa restoranga kirsa yozuv o'shanga ko'chadi.
    await MobileDevice.findOneAndUpdate(
      { token },
      { $set: { platform, restaurantId: req.restaurantId, userId: req.userId || undefined, lastSeen: new Date(), failCount: 0, lastError: '', ...(environment ? { environment } : {}) } },
      { upsert: true, setDefaultsOnInsert: true },
    );
    res.status(204).end();
  }),

  unregister: asyncHandler(async (req, res) => {
    const parsed = z.object({ token: tokenSchema }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Token noto‘g‘ri' });
    await MobileDevice.deleteOne({ token: parsed.data.token, restaurantId: req.restaurantId });   // faqat o'z restoranining tokeni
    res.status(204).end();
  }),

  list: asyncHandler(async (req, res) => {
    const devices = await MobileDevice.find({ restaurantId: req.restaurantId }).sort({ lastSeen: -1 }).lean();
    res.json({
      providers: providers(),
      check: providerCheck(),
      devices: devices.map((d) => ({
        platform: d.platform, environment: d.environment || null, token: `…${String(d.token).slice(-6)}`,
        lastSeen: d.lastSeen, lastSentAt: d.lastSentAt, lastError: d.lastError, failCount: d.failCount,
      })),
    });
  }),

  /** POST /api/panel/devices/test — o'z telefonlariga test push; natija har qurilma uchun alohida (sabab bilan). */
  test: asyncHandler(async (req, res) => {
    const key = String(req.restaurantId);
    const wait = 10_000 - (Date.now() - (lastTest.get(key) || 0));
    if (wait > 0) return res.status(429).json({ error: `Biroz kuting (${Math.ceil(wait / 1000)} s)` });
    lastTest.set(key, Date.now());
    const results = await sendTestPush(req.restaurantId);
    res.json({ providers: providers(), registered: results.length, results });
  }),
};
