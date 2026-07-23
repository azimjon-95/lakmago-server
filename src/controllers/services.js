import { z } from 'zod';
import { asyncHandler } from '../middleware/error.js';
import { Reservation } from '../models/Reservation.js';
import { Order } from '../models/Order.js';
import { getIO } from '../sockets/io.js';
import { notifyUser } from '../services/telegram.js';

const reservationSchema = z.object({
  restaurantId: z.string(),
  restaurantName: z.string(),
  date: z.string(),
  time: z.string(),
  guests: z.number().int().positive(),
  name: z.string().min(2),
  phone: z.string().min(7),
  note: z.string().optional()
});

export const reservationController = {
  // POST /api/reservations
  create: asyncHandler(async (req, res) => {
    const parsed = reservationSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Ma‘lumot noto‘g‘ri', details: parsed.error.issues });
    }
    // Sana va vaqtni bitta Date ga birlashtiramiz (eslatmalar shu bo'yicha ishlaydi)
    const scheduledAt = new Date(`${parsed.data.date}T${parsed.data.time}:00`);

    const reservation = await Reservation.create({
      ...parsed.data,
      userId: req.userId,
      scheduledAt: isNaN(scheduledAt.getTime()) ? undefined : scheduledAt,
    });

    // Restoranga real-time xabar (to'liq ma'lumot bilan)
    getIO()?.
    to(`restaurant:${parsed.data.restaurantId}`).
    emit('reservation:new', {
      reservationId: String(reservation._id),
      name: reservation.name,
      phone: reservation.phone,
      date: reservation.date,
      time: reservation.time,
      guests: reservation.guests,
    });
    getIO()?.to('admin').emit('reservation:new', { reservationId: String(reservation._id) });

    res.status(201).json(reservation);
  }),

  // GET /api/reservations  (mening bronlarim)
  myReservations: asyncHandler(async (req, res) => {
    const list = await Reservation.find({ userId: req.userId }).sort({ createdAt: -1 });
    res.json(list);
  }),

  // GET /api/restaurants/:id/reservations  (restoran paneli)
  // GET /api/panel/reservations — restoran o'z bronlarini (token orqali)
  forRestaurantSelf: asyncHandler(async (req, res) => {
    const list = await Reservation.find({ restaurantId: req.restaurantId }).sort({ createdAt: -1 });
    res.json(list);
  }),

  forRestaurant: asyncHandler(async (req, res) => {
    const list = await Reservation.find({ restaurantId: req.params.id }).sort({ createdAt: -1 });
    res.json(list);
  }),

  // GET /api/reservations/my — mijozning bron tarixi
  myReservations: asyncHandler(async (req, res) => {
    const list = await Reservation.find({ userId: req.userId })
      .sort({ scheduledAt: -1 })
      .limit(50)
      .lean();
    res.json(list);
  }),

  // PATCH /api/reservations/:id/cancel — mijoz o'z bronini bekor qiladi
  cancelMine: asyncHandler(async (req, res) => {
    const reservation = await Reservation.findOne({
      _id: req.params.id,
      userId: req.userId,
    });
    if (!reservation) return res.status(404).json({ error: 'Bron topilmadi' });
    if (['completed', 'cancelled', 'rejected'].includes(reservation.status)) {
      return res.status(400).json({ error: 'Bu bronni bekor qilib bo\u2018lmaydi' });
    }
    reservation.status = 'cancelled';
    await reservation.save();

    // Restoranga real-time xabar
    getIO()?.to(`restaurant:${reservation.restaurantId}`).emit('reservation:update', {
      reservationId: String(reservation._id), status: 'cancelled',
    });
    getIO()?.to('admin').emit('reservation:update', { reservationId: String(reservation._id) });

    res.json(reservation);
  }),

  // PATCH /api/reservations/:id/status  (restoran tasdiqlaydi/rad etadi)
  updateStatus: asyncHandler(async (req, res) => {
    const { status, reason } = req.body;
    const ALLOWED = ['confirmed', 'rejected', 'cancelled', 'completed'];
    if (!ALLOWED.includes(status)) {
      return res.status(400).json({ error: 'Holat noto\u2018g\u2018ri' });
    }

    const update = { status };
    if (status === 'rejected' && reason) update.rejectReason = reason;

    const reservation = await Reservation.findByIdAndUpdate(
      req.params.id,
      update,
      { new: true },
    );
    if (!reservation) return res.status(404).json({ error: 'Bron topilmadi' });

    // Mijozga bot orqali batafsil xabar (tasdiq yoki rad + sabab)
    if (status === 'confirmed' || status === 'rejected') {
      try {
        const { notifyReservationDecision } = await import('../services/reservationReminder.js');
        await notifyReservationDecision(reservation, status, reason || '');
      } catch (e) {
        console.error('[reservation] xabar xatosi:', e.message);
      }
    }

    // Real-time: mijoz ilovasi va admin panel
    const io = getIO();
    io?.to(`user:${reservation.userId}`).emit('reservation:status', {
      reservationId: String(reservation._id), status,
    });
    io?.to('admin').emit('reservation:update', {
      reservationId: String(reservation._id), status,
    });

    res.json(reservation);
  })
};

export const paymentController = {
  // POST /api/payments/create  { orderId, provider }
  // Real integratsiyada Payme/Click checkout URL qaytariladi.
  create: asyncHandler(async (req, res) => {
    const { orderId, provider } = req.body;
    const order = await Order.findById(orderId);
    if (!order) return res.status(404).json({ error: 'Buyurtma topilmadi' });

    // Bu yerda Payme/Click SDK chaqiriladi. Demo — soxta checkout URL.
    const checkoutUrl = buildCheckoutUrl(provider, orderId, order.total);
    res.json({ checkoutUrl, provider, amount: order.total });
  }),

  // POST /api/payments/callback  (provider webhook — to'lov tasdiqlanishi)
  callback: asyncHandler(async (req, res) => {
    const { orderId, success } = req.body;
    if (success) {
      await Order.findByIdAndUpdate(orderId, { status: 'preparing' });
    }
    res.json({ received: true });
  })
};

// Payme/Click checkout URL yasovchi (real kalitlar env'dan olinadi)
function buildCheckoutUrl(provider, orderId, amountSom) {
  const amountTiyin = amountSom * 100; // Payme tiyinda ishlaydi
  if (provider === 'payme') {
    const merchantId = process.env.PAYME_MERCHANT_ID ?? 'DEMO';
    const params = Buffer.from(
      `m=${merchantId};ac.order_id=${orderId};a=${amountTiyin}`
    ).toString('base64');
    return `https://checkout.paycom.uz/${params}`;
  }
  if (provider === 'click') {
    const serviceId = process.env.CLICK_SERVICE_ID ?? 'DEMO';
    const merchantId = process.env.CLICK_MERCHANT_ID ?? 'DEMO';
    return `https://my.click.uz/services/pay?service_id=${serviceId}&merchant_id=${merchantId}&amount=${amountSom}&transaction_param=${orderId}`;
  }
  return `https://pay.demo/${provider}/${orderId}`;
}
