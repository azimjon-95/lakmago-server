import { asyncHandler } from '../middleware/error.js';
import { listSince, listPending, setStatus } from '../services/notifications.js';

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

  /** PATCH /panel/notifications/:id  { status } */
  updateStatus: asyncHandler(async (req, res) => {
    const updated = await setStatus(req.params.id, req.body?.status);
    if (!updated) return res.status(404).json({ error: 'Bildirishnoma topilmadi' });
    res.json(updated);
  }),
};
