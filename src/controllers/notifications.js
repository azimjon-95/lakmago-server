import { z } from 'zod';
import { asyncHandler } from '../middleware/error.js';
import { listSince, listPending, setStatus } from '../services/notifications.js';
import { Notification } from '../models/Notification.js';
import { PushSubscription } from '../models/PushSubscription.js';
import { config } from '../config/index.js';

/**
 * Bildirishnomalarni sinxronlash.
 *
 * Frontend faqat socketga ishonmaydi: ulanish tiklanganda yoki
 * panel qayta yuklanganda shu yerdan yo'qolganlarini olib keladi.
 */

/** So'rovchi kim: admin butun platformani, restoran o'zinikini ko'radi. */
function scopeOf(req) {
  return req.role === 'admin'
    ? { audience: 'admin', restaurantId: null }
    : { audience: 'restaurant', restaurantId: req.restaurantId };
}

export const notificationController = {
  /**
   * GET /panel/notifications?after=<seq>
   *
   * after berilsa — o'shandan keyingilar (uzilishdan keyin).
   * berilmasa — javob berilmagan (pending) bildirishnomalar.
   */
  list: asyncHandler(async (req, res) => {
    const scope = scopeOf(req);
    const after = req.query.after;

    const items = after !== undefined && after !== ''
      ? await listSince({ ...scope, afterSeq: after })
      : await listPending(scope);

    // Mijoz keyingi safar shu seq'dan so'raydi
    const lastSeq = items.length ? items[items.length - 1].seq : Number(after) || 0;

    res.json({ items, lastSeq });
  }),

  /**
   * PATCH /panel/notifications/:id  { status }
   *
   * Idempotent: bir bildirishnomani ikki marta Accept qilish
   * ikkinchi marta hech narsani o'zgartirmaydi (setStatus
   * yakuniy holatdan orqaga qaytarmaydi).
   */
  updateStatus: asyncHandler(async (req, res) => {
    const scope = scopeOf(req);

    // Egalik tekshiruvi: boshqa restoranning bildirishnomasiga
    // tegib bo'lmaydi. Frontenddan kelgan ma'lumotga ishonmaymiz.
    const own = await Notification.findOne({ notificationId: req.params.id })
      .select('audience restaurantId').lean();
    if (!own) return res.status(404).json({ error: 'Bildirishnoma topilmadi' });

    const allowed = scope.audience === 'admin'
      ? true
      : own.audience === 'restaurant' && String(own.restaurantId) === String(scope.restaurantId);
    if (!allowed) return res.status(403).json({ error: 'Ruxsat yo‘q' });

    const updated = await setStatus(req.params.id, req.body?.status);
    if (!updated) return res.status(404).json({ error: 'Bildirishnoma topilmadi' });
    res.json(updated);
  }),

  /** GET /panel/push/key — brauzer obuna bo'lishi uchun ochiq kalit */
  publicKey: asyncHandler(async (_req, res) => {
    res.json({ key: config.vapidPublicKey || '' });
  }),

  /**
   * POST /panel/push/subscribe
   *
   * Qamrov serverdan olinadi (req.role, req.restaurantId) —
   * frontend "men falon restoranman" deb ayta olmaydi.
   */
  subscribe: asyncHandler(async (req, res) => {
    const schema = z.object({
      endpoint: z.string().url().max(600),
      keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(200) }),
      deviceId: z.string().max(80).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Obuna ma‘lumoti noto‘g‘ri' });

    const { endpoint, keys, deviceId } = parsed.data;

    await PushSubscription.findOneAndUpdate(
      { endpoint },
      {
        endpoint,
        keys,
        userId: req.userId || undefined,
        role: req.role === 'admin' ? 'admin' : 'restaurant',
        restaurantId: req.role === 'admin' ? undefined : req.restaurantId,
        branchId: req.branchId || undefined,
        deviceId: deviceId || '',
        userAgent: String(req.headers['user-agent'] || '').slice(0, 200),
        failCount: 0,
        lastSeen: new Date(),
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    res.status(201).json({ ok: true });
  }),

  /** POST /panel/push/unsubscribe — chiqishda yoki qurilma almashganda */
  unsubscribe: asyncHandler(async (req, res) => {
    const endpoint = String(req.body?.endpoint || '');
    if (!endpoint) return res.status(400).json({ error: 'endpoint kerak' });

    // Faqat o'z obunasini o'chira oladi
    const filter = req.role === 'admin'
      ? { endpoint, role: 'admin' }
      : { endpoint, role: 'restaurant', restaurantId: req.restaurantId };

    await PushSubscription.deleteOne(filter);
    res.json({ ok: true });
  }),
};
