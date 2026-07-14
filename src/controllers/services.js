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
    const reservation = await Reservation.create({ ...parsed.data, userId: req.userId });

    // Restoranga real-time xabar
    getIO()?.
    to(`restaurant:${parsed.data.restaurantId}`).
    emit('reservation:new', { reservationId: reservation._id });

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

  // PATCH /api/reservations/:id/status  (restoran tasdiqlaydi)
  updateStatus: asyncHandler(async (req, res) => {
    const { status } = req.body;
    const reservation = await Reservation.findByIdAndUpdate(
      req.params.id,
      { status },
      { new: true }
    ).populate('userId');
    if (!reservation) return res.status(404).json({ error: 'Bron topilmadi' });

    // Mijozga Telegram push
    const user = reservation.userId;
    if (user?.telegramId) {
      const msg =
      status === 'confirmed' ?
      `✅ Stolingiz tasdiqlandi!\n${reservation.restaurantName}\n${reservation.date} ${reservation.time}, ${reservation.guests} kishi` :
      `❌ Kechirasiz, bron tasdiqlanmadi.\n${reservation.restaurantName}`;
      notifyUser(user.telegramId, msg);
    }

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
