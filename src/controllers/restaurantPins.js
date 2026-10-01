import { z } from 'zod';
import { asyncHandler } from '../middleware/error.js';
import { User } from '../models/User.js';
import { Restaurant } from '../models/Restaurant.js';
import { createPin, updatePin, cancelPin, listPins, PinError, POSITIONS } from '../services/restaurantPins.js';

/*
 * ADMIN: "Barcha restoranlar"da 1/2/3-o'ringa pin (Mijoz jalb qilish → Top joylar).
 * Ruxsat: marketing bo'limi (routes/index.js). Qoidalar: services/restaurantPins.js.
 *
 * Xato javobi: { error, code, conflict? } — 409 bo'lsa `conflict` ichida band qilgan
 * pin (restoran nomi va muddati): panel "kim va qachongacha band"ni ko'rsatadi.
 */

const idRe = /^[a-f\d]{24}$/i;

const createSchema = z.object({
  restaurantId: z.string().regex(idRe, 'Restoran noto‘g‘ri'),
  position: z.number().int(),
  startsAt: z.string().min(1),
  endsAt: z.string().min(1),
  note: z.string().max(200).optional().default(''),
});

const updateSchema = z.object({
  startsAt: z.string().min(1).optional(),
  endsAt: z.string().min(1).optional(),
  note: z.string().max(200).optional(),
});

async function actorOf(req) {
  const u = await User.findById(req.userId).select('firstName login').lean().catch(() => null);
  return { id: req.userId, name: u?.firstName || u?.login || 'Admin' };
}

const fail = (res, e) => {
  if (e instanceof PinError) return res.status(e.status).json({ error: e.message, code: e.code, ...e.extra });
  throw e;
};

export const restaurantPinsController = {
  /*
   * GET /admin/pins/restaurants?q=nom — pin qo'yish uchun restoran tanlash.
   * Mavjud /admin/restaurants `restaurants` bo'limi ruxsatini talab qiladi; marketing
   * xodimida u yo'q — shuning uchun alohida, FAQAT kerakli maydonlar (nom, rasm, tur):
   * moliya/shartnoma ma'lumoti chiqmaydi. Faqat mijozlarga KO'RINADIGAN restoranlar
   * (pin ma'nosiz bo'lmagan restoranga qo'yilmasin).
   */
  restaurants: asyncHandler(async (req, res) => {
    const q = String(req.query.q || '').trim().slice(0, 60);
    const filter = { isApproved: true, isActive: true, isBlocked: { $ne: true } };
    if (q) filter.name = { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    const rows = await Restaurant.find(filter).select('name imageUrl cuisine category').sort({ name: 1 }).limit(40).lean();
    res.json(rows.map((r) => ({ _id: String(r._id), name: r.name, imageUrl: r.imageUrl || '', cuisine: r.cuisine || '', category: r.category || '' })));
  }),

  // GET /admin/pins?history=1
  list: asyncHandler(async (req, res) => {
    const pins = await listPins({ history: req.query.history === '1' });
    res.json({ now: new Date(), positions: POSITIONS, pins });
  }),

  // POST /admin/pins  { restaurantId, position, startsAt, endsAt, note? }
  create: asyncHandler(async (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Ma‘lumot noto‘g‘ri', code: 'INVALID_BODY' });
    }
    try {
      const pin = await createPin({ ...parsed.data, actor: await actorOf(req) });
      const [item] = (await listPins({ history: true })).filter((p) => p._id === String(pin._id));
      res.status(201).json(item);
    } catch (e) { fail(res, e); }
  }),

  // PATCH /admin/pins/:id  { startsAt?, endsAt?, note? }
  update: asyncHandler(async (req, res) => {
    if (!idRe.test(req.params.id)) return res.status(404).json({ error: 'Pin topilmadi', code: 'PIN_NOT_FOUND' });
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Ma‘lumot noto‘g‘ri', code: 'INVALID_BODY' });
    try {
      const pin = await updatePin(req.params.id, parsed.data);
      const [item] = (await listPins({ history: true })).filter((p) => p._id === String(pin._id));
      res.json(item);
    } catch (e) { fail(res, e); }
  }),

  // DELETE /admin/pins/:id — pindan chiqarish / rejalashtirilganini bekor qilish
  cancel: asyncHandler(async (req, res) => {
    if (!idRe.test(req.params.id)) return res.status(404).json({ error: 'Pin topilmadi', code: 'PIN_NOT_FOUND' });
    try {
      const pin = await cancelPin(req.params.id);
      const [item] = (await listPins({ history: true })).filter((p) => p._id === String(pin._id));
      res.json(item || { _id: String(pin._id), status: 'cancelled' });
    } catch (e) { fail(res, e); }
  }),
};
