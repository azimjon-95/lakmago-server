import { asyncHandler } from '../middleware/error.js';
import { Order } from '../models/Order.js';
import { getProvider, availableProviders, providerStatus } from '../services/providers/index.js';

/**
 * To'lov kontrolleri.
 *
 * Endi provayder registri orqali ishlaydi — bu yerda
 * `if (provider === 'click')` yo'q. Yangi shlyuz qo'shilsa
 * shu fayl o'zgarmaydi.
 */
export const paymentController = {
  // POST /api/payments/payme  — eskirgan, eski tranzaksiyalar uchun
  paymeWebhook: asyncHandler(async (req, res) => {
    res.json(await getProvider('payme').handleWebhook(req));
  }),

  // POST /api/payments/paynet
  paynetWebhook: asyncHandler(async (req, res) => {
    res.json(await getProvider('paynet').handleWebhook(req));
  }),

  // POST /api/payments/click/prepare
  clickPrepare: asyncHandler(async (req, res) => {
    res.json(await getProvider('click').handleWebhook(req, 'prepare'));
  }),

  // POST /api/payments/click/complete
  clickComplete: asyncHandler(async (req, res) => {
    res.json(await getProvider('click').handleWebhook(req, 'complete'));
  }),

  /**
   * GET /api/payments/link/:orderId?provider=paynet|click
   *
   * Mijozga to'lov havolasi. Buyurtma egasi tekshiriladi.
   */
  getLink: asyncHandler(async (req, res) => {
    const order = await Order.findOne({
      _id: req.params.orderId,
      userId: req.userId,
    }).lean();
    if (!order) return res.status(404).json({ error: 'Buyurtma topilmadi' });
    if (order.isPaid) return res.status(400).json({ error: 'Allaqachon to\u2018langan' });

    const name = String(req.query.provider || '').toLowerCase();
    const provider = getProvider(name);
    if (!provider) return res.status(400).json({ error: 'Noma\u2018lum to\u2018lov tizimi' });
    if (!provider.isConfigured()) {
      return res.status(503).json({ error: `${provider.name} hali ulanmagan` });
    }

    try {
      const { url } = await provider.createCheckout(order);
      res.json({ provider: provider.name, url });
    } catch (err) {
      // Paynet hali tugallanmagan bo'lsa shu yerga tushadi
      res.status(503).json({ error: err.message });
    }
  }),

  /**
   * GET /api/payments/order/:orderId
   *
   * Mijoz to'lov holatini so'raydi. Manba — SERVER yozuvi,
   * mijozdan kelgan "to'ladim" emas.
   *
   * uiState mijoz ilovasi ko'rsatadigan xabar kalitini beradi.
   */
  orderStatus: asyncHandler(async (req, res) => {
    const order = await Order.findOne({
      _id: req.params.orderId, userId: req.userId,
    }).select('_id status isPaid total').lean();
    if (!order) return res.status(404).json({ error: 'Buyurtma topilmadi' });

    const { Payment } = await import('../models/Payment.js');
    const payment = await Payment.findOne({ orderId: order._id })
      .sort({ createdAt: -1 })
      .select('status provider amount paidAt metadata').lean();

    // Holat → mijozga ko'rsatiladigan xabar
    const UI = {
      PENDING: 'payment_pending',      // "Платёж обрабатывается"
      PROCESSING: 'payment_pending',
      SUCCESS: 'order_accepted',       // "Заказ принят"
      FAILED: 'payment_failed',        // "Оплата не прошла"
      CANCELLED: 'payment_failed',
      REFUNDED: 'payment_refunded',
    };

    res.json({
      orderId: String(order._id),
      orderStatus: order.status,
      isPaid: Boolean(order.isPaid),
      paymentStatus: payment?.status || (order.isPaid ? 'SUCCESS' : 'PENDING'),
      uiState: UI[payment?.status] || (order.isPaid ? 'order_accepted' : 'payment_pending'),
      provider: payment?.provider || null,
      paidAt: payment?.paidAt || null,
    });
  }),

  // GET /api/payments/status — qaysi tizimlar ulangan
  status: asyncHandler(async (_req, res) => {
    res.json({
      providers: providerStatus(),
      available: availableProviders(),
      // Eski mijozlar uchun moslik
      payme: providerStatus().payme.acceptsNew,
      click: providerStatus().click.acceptsNew,
    });
  }),
};
