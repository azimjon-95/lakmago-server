import { asyncHandler } from '../middleware/error.js';
import { z } from 'zod';
import { Courier } from '../models/Courier.js';
import { createShareLink, getShareView, acceptShare, deliverShare, buildShareUrls } from '../services/courierDispatch.js';

function rid(req) {
  return req.restaurantId;
}

/*
 * KURYERLAR REYESTRI (BOSQICH 2 uchun tayyorlab qo'yilgan).
 *
 * Hozircha bu CRUD FAOL ISHLATILMAYDI — restoran/admin buyurtmani
 * kuryerga yuborishda bu ro'yxatdan tanlamaydi (pastdagi
 * createDeliveryLink orqali, ro'yxatsiz, ulashish havolasi
 * bilan ishlaydi). Lekin admin panelidagi "Kuryerlar" sahifasi
 * bu endpointlarga tayyor — kelajakda kuryerlar o'zlari
 * ro'yxatdan o'tib, admin ularni shu yerda ko'rib "ruxsat"
 * bergandan keyin, bu ro'yxat FAOL ishlatila boshlanadi.
 */
export const courierRegistryController = {
  list: asyncHandler(async (_req, res) => {
    const couriers = await Courier.find().sort({ isActive: -1, name: 1 }).lean();
    res.json(couriers);
  }),
  create: asyncHandler(async (req, res) => {
    const schema = z.object({
      name: z.string().min(2).max(80),
      phone: z.string().optional(),
      telegramChatId: z.string().min(1),
      telegramUsername: z.string().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Noto\u2018g\u2018ri ma\u2018lumot', details: parsed.error.flatten() });
    }
    const courier = await Courier.create(parsed.data);
    res.status(201).json(courier);
  }),
  update: asyncHandler(async (req, res) => {
    const allowed = ['name', 'phone', 'telegramChatId', 'telegramUsername', 'isActive'];
    const update = {};
    for (const k of allowed) if (k in req.body) update[k] = req.body[k];
    const courier = await Courier.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!courier) return res.status(404).json({ error: 'Kuryer topilmadi' });
    res.json(courier);
  }),
  remove: asyncHandler(async (req, res) => {
    await Courier.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
  }),
};

/* ═══════════════════════════════════════════
   RESTORAN — havola yaratish (ulashish uchun)
   ═══════════════════════════════════════════ */
export const courierAdminController = {
  /*
   * POST /panel/orders/:id/create-delivery-link
   *
   * BOSQICH 1 (2026-08): ro'yxatdan tanlash YO'Q — bitta havola
   * yaratiladi, restoran/admin uni o'zining Telegram/WhatsApp
   * akkaunti orqali xohlagan odam(lar)ga ulashadi.
   */
  createDeliveryLink: asyncHandler(async (req, res) => {
    const { Order } = await import('../models/Order.js');
    const order = await Order.findOne({ _id: req.params.id, restaurantId: rid(req) }).lean();
    if (!order) return res.status(404).json({ error: 'Buyurtma topilmadi' });

    const { token } = await createShareLink(order._id);
    const urls = buildShareUrls(token);

    res.status(201).json(urls);
  }),

  // GET /panel/orders/:id/dispatch-status — kuzatish uchun (ixtiyoriy)
  dispatchStatus: asyncHandler(async (req, res) => {
    const { DeliveryAssignment } = await import('../models/DeliveryAssignment.js');
    const assignment = await DeliveryAssignment.findOne({ orderId: req.params.id })
      .sort({ createdAt: -1 })
      .lean();
    if (!assignment) return res.json({ status: 'none' });
    res.json({ status: assignment.status, assignedAt: assignment.assignedAt, deliveredAt: assignment.deliveredAt });
  }),
};

/* ═══════════════════════════════════════════
   OCHIQ — kuryer sahifasi (token asosida, login yo'q)
   ═══════════════════════════════════════════ */
export const courierPortalController = {
  // GET /courier-portal/:token?secret=...
  view: asyncHandler(async (req, res) => {
    const secret = req.query.secret || null;
    const result = await getShareView(req.params.token, secret);

    if (result.view === 'not_found') {
      return res.status(404).json({ view: 'not_found' });
    }

    const snap = result.assignment?.deliverySnapshot || {};
    res.json({
      view: result.view,
      order: ['offer', 'mine'].includes(result.view) ? {
        itemsSummary: snap.itemsSummary,
        total: snap.total,
        restaurantName: snap.restaurantName,
        restaurantAddress: snap.restaurantAddress,
        restaurantLat: snap.restaurantLat,
        restaurantLng: snap.restaurantLng,
        addressLabel: snap.addressLabel,
        // Aniq manzil/telefon — FAQAT to'g'ri secret bilan ('mine')
        addressNote: result.view === 'mine' ? snap.addressNote : undefined,
        customerPhone: result.view === 'mine' ? snap.customerPhone : undefined,
        lat: snap.lat,
        lng: snap.lng,
      } : null,
    });
  }),

  // POST /courier-portal/:token/accept
  accept: asyncHandler(async (req, res) => {
    const result = await acceptShare(req.params.token);
    if (!result.ok) return res.status(409).json({ error: result.error });
    // MUHIM: secret FAQAT shu javobda qaytariladi — URL'da EMAS,
    // loglarda/tarixda qolib ketmasligi uchun
    res.json({ ok: true, secret: result.secret });
  }),

  // POST /courier-portal/:token/deliver  { secret }
  deliver: asyncHandler(async (req, res) => {
    const result = await deliverShare(req.params.token, req.body.secret);
    if (!result.ok) return res.status(409).json({ error: result.error || 'Ruxsat yo\u2018q' });
    res.json({ ok: true, alreadyDelivered: !!result.alreadyDelivered });
  }),
};
