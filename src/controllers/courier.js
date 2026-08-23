import { z } from 'zod';
import { asyncHandler } from '../middleware/error.js';
import { Courier } from '../models/Courier.js';
import { DeliveryAssignment, CourierInvite } from '../models/DeliveryAssignment.js';
import { Order } from '../models/Order.js';
import { dispatchToCouriers, getInviteView, acceptInvite, deliverInvite } from '../services/courierDispatch.js';

function rid(req) {
  return req.restaurantId;
}

/* ═══════════════════════════════════════════
   ADMIN/RESTORAN — kuryerlar ro'yxati
   ═══════════════════════════════════════════ */
export const courierAdminController = {
  // GET /panel/couriers yoki /admin/couriers
  list: asyncHandler(async (_req, res) => {
    const couriers = await Courier.find().sort({ isActive: -1, name: 1 }).lean();
    res.json(couriers);
  }),

  // POST — yangi kuryer qo'shish
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

  /*
   * POST /panel/orders/:id/dispatch-courier
   * { courierIds: [...] }  — bo'sh bo'lsa BARCHA faol kuryerlarga
   *
   * Buyurtmani bir yoki bir nechta kuryerga yuboradi. Talab
   * bo'yicha: "hohlagan kuryerga, misol 5 tasiga yuborsin, kim
   * birinchi qabul qilsa usha oladi".
   */
  dispatchOrder: asyncHandler(async (req, res) => {
    const order = await Order.findOne({ _id: req.params.id, restaurantId: rid(req) }).lean();
    if (!order) return res.status(404).json({ error: 'Buyurtma topilmadi' });

    let courierIds = req.body.courierIds;
    if (!courierIds || !courierIds.length) {
      const all = await Courier.find({ isActive: true }).select('_id').lean();
      courierIds = all.map((c) => c._id);
    }
    if (!courierIds.length) {
      return res.status(400).json({ error: 'Faol kuryer topilmadi. Avval kuryer qo\u2018shing.' });
    }

    const result = await dispatchToCouriers(order._id, courierIds);
    res.status(201).json({
      sentTo: result.sentTo,
      assignmentId: result.assignment._id,
    });
  }),

  // GET /panel/orders/:id/dispatch-status — kim qabul qilganini kuzatish
  dispatchStatus: asyncHandler(async (req, res) => {
    const assignment = await DeliveryAssignment.findOne({ orderId: req.params.id })
      .sort({ createdAt: -1 })
      .populate('assignedCourierId', 'name phone')
      .lean();
    if (!assignment) return res.json({ status: 'none' });

    const invites = await CourierInvite.find({ assignmentId: assignment._id })
      .populate('courierId', 'name')
      .lean();

    res.json({
      status: assignment.status,
      assignedCourier: assignment.assignedCourierId,
      invites: invites.map((i) => ({ courierName: i.courierId?.name, status: i.status })),
    });
  }),
};

/* ═══════════════════════════════════════════
   OCHIQ — kuryer portali (token asosida, login yo'q)
   ═══════════════════════════════════════════ */
export const courierPortalController = {
  // GET /courier-portal/:token
  view: asyncHandler(async (req, res) => {
    const result = await getInviteView(req.params.token);

    if (result.view === 'not_found') {
      return res.status(404).json({ view: 'not_found' });
    }

    /*
     * Faqat KERAKLI ma'lumot chiqariladi — kuryer sahifasi
     * Order hujjatining o'ziga emas, faqat deliverySnapshot'ga
     * (xavfsiz, oldindan tayyorlangan qism) kira oladi.
     */
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
        // Mijoz manzili — FAQAT qabul qilingandan keyin (result.view==='mine')
        // to'liq ko'rsatiladi. 'offer' holatida ham ko'rsatamiz —
        // kuryer qabul qilishdan oldin masofani baholay olsin.
        addressLabel: snap.addressLabel,
        addressNote: result.view === 'mine' ? snap.addressNote : undefined,
        customerPhone: result.view === 'mine' ? snap.customerPhone : undefined,
        lat: snap.lat,
        lng: snap.lng,
      } : null,
    });
  }),

  // POST /courier-portal/:token/accept
  accept: asyncHandler(async (req, res) => {
    const result = await acceptInvite(req.params.token);
    if (!result.ok) return res.status(409).json({ error: result.error });
    res.json({ ok: true });
  }),

  // POST /courier-portal/:token/deliver
  deliver: asyncHandler(async (req, res) => {
    const result = await deliverInvite(req.params.token);
    if (!result.ok) return res.status(409).json({ error: result.error });
    res.json({ ok: true, alreadyDelivered: !!result.alreadyDelivered });
  }),
};
