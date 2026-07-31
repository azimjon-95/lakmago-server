import { asyncHandler } from '../middleware/error.js';
import { config } from '../config/index.js';
import { Order } from '../models/Order.js';
import { handlePaymeRequest, buildPaymeCheckoutUrl } from '../services/payme.js';
import { clickPrepare, clickComplete } from '../services/click.js';

export const paymentController = {
  // POST /api/payments/payme  — Payme webhook (JSON-RPC)
  paymeWebhook: asyncHandler(async (req, res) => {
    const result = await handlePaymeRequest(req);
    res.json(result);
  }),

  // POST /api/payments/click/prepare
  clickPrepare: asyncHandler(async (req, res) => {
    res.json(await clickPrepare(req.body));
  }),

  // POST /api/payments/click/complete
  clickComplete: asyncHandler(async (req, res) => {
    res.json(await clickComplete(req.body));
  }),

  // GET /api/payments/link/:orderId?provider=payme|click
  // Mijozga to'lov havolasini beradi
  getLink: asyncHandler(async (req, res) => {
    const order = await Order.findOne({
      _id: req.params.orderId,
      userId: req.userId,
    }).lean();
    if (!order) return res.status(404).json({ error: 'Buyurtma topilmadi' });
    if (order.isPaid) return res.status(400).json({ error: 'Allaqachon to\u2018langan' });

    const provider = req.query.provider === 'click' ? 'click' : 'payme';

    if (provider === 'click') {
      if (!config.click.serviceId) {
        return res.status(503).json({ error: 'Click hali ulanmagan' });
      }
      const { buildClickCheckoutUrl } = await import('../services/click.js');
      return res.json({ provider, url: buildClickCheckoutUrl(order._id, order.total) });
    }

    if (!config.payme.merchantId) {
      return res.status(503).json({ error: 'Payme hali ulanmagan' });
    }
    res.json({ provider, url: buildPaymeCheckoutUrl(order._id, order.total) });
  }),

  // GET /api/payments/status — qaysi tizimlar ulangan
  status: asyncHandler(async (_req, res) => {
    res.json({
      payme: Boolean(config.payme.merchantId && config.payme.key),
      click: Boolean(config.click.serviceId && config.click.secretKey),
    });
  }),
};
