import { asyncHandler } from '../middleware/error.js';
import { Order } from '../models/Order.js';
import { confirmOrderDelivered } from '../services/deliveryCheck.js';
import { toPanelOrder } from '../services/panelOrderView.js';
import { confirmEligibility } from '../services/reminderRules.js';
import { tiyinToSom } from '../services/orderFinance.js';
import { resolvePeriod, deliveredWindow } from '../services/billingPeriod.js';
import { zoneDate } from '../services/restaurantTime.js';

/*
 * ═══════════════════════════════════════════════════════════
 * ANDROID GATEWAY — TARIX, STATISTIKA, "YETKAZILDI" TASDIQLASH
 * ═══════════════════════════════════════════════════════════
 *
 * `/orders` oxirgi 80 tani beradi (sana filtri ham, sahifalash ham yo'q)
 * — undan kunlik hisob chiqmaydi. Shu yerda:
 *   GET  /orders/history    — sana + sahifalash bilan ro'yxat
 *   GET  /stats             — kunlik (yoki oraliq) hisob, serverda
 *   POST /orders/:id/confirm-delivered — restoran "Yetkazildi"
 *
 * Hammasi FAQAT o'z restoraniga (req.restaurantId) va ro'yxat bilan bir
 * xil qoida: awaiting_payment (pul yechilmagan) va zal (dinein) chiqmaydi.
 * Javob shakli — toPanelOrder (ichki moliya va mijoz hujjati YO'Q).
 */

const rid = (req) => req.restaurantId;

// Restoran ko'radigan buyurtmalar (panel `orders()` bilan bir xil)
const visible = (req) => ({
  restaurantId: rid(req),
  status: { $ne: 'awaiting_payment' },
  fulfillment: { $ne: 'dinein' },
});

const STATUSES = ['pending', 'accepted', 'preparing', 'ready', 'delivering', 'delivered', 'cancelled'];
const som = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** "Bugun" — Toshkent kuni */
const todayYmd = () => zoneDate('Asia/Tashkent', new Date()).ymd;

/** from/to: ikkalasi yo'q — bugun; bittasi — o'sha kun. Noto'g'ri sana → 400 (PeriodError). */
function dayRange(q) {
  const from = q.from || q.to || todayYmd();
  const to = q.to || q.from || from;
  return { period: resolvePeriod(from, to), from, to };
}

export const gatewayOrdersController = {
  /*
   * GET /orders/history?from=YYYY-MM-DD&to=YYYY-MM-DD&status=&limit=&cursor=
   *
   * Sana — buyurtma YARATILGAN Toshkent kuni (ikkala chegara kiradi).
   * Tartib: yangisi birinchi. Sahifalash — `cursor` (oldingi javobdagi
   * nextCursor); offset EMAS: sahifalar orasida yangi buyurtma kelsa
   * takrorlanish yoki tushib qolish bo'lmaydi.
   * Javob: { items, nextCursor, hasMore } — `items` /orders bilan bir xil shakl.
   */
  history: asyncHandler(async (req, res) => {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const filter = { ...visible(req) };

    const status = req.query.status;
    if (status && status !== 'all') {
      if (!STATUSES.includes(status)) {
        return res.status(400).json({ error: 'Noto‘g‘ri status filtri', code: 'INVALID_STATUS_FILTER' });
      }
      filter.status = status;
    }

    const period = req.query.from || req.query.to ? dayRange(req.query).period : null;
    if (period) filter.createdAt = { ...period.cond };

    if (req.query.cursor) {
      const m = String(req.query.cursor).match(/^(\d{10,16})_([a-f\d]{24})$/i);
      if (!m) return res.status(400).json({ error: 'Noto‘g‘ri cursor', code: 'INVALID_CURSOR' });
      const t = new Date(Number(m[1]));
      // createdAt tenglashsa _id bilan ajratiladi (bir vaqtda yaratilgan buyurtmalar)
      filter.$and = [{
        $or: [{ createdAt: { $lt: t } }, { createdAt: t, _id: { $lt: m[2] } }],
      }];
    }

    const rows = await Order.find(filter)
      .populate('userId', 'firstName lastName username telegramId phone photoUrl')
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit + 1)
      .lean();

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    res.json({
      items: page.map((o) => toPanelOrder(o)),
      nextCursor: hasMore && last ? `${new Date(last.createdAt).getTime()}_${last._id}` : null,
      hasMore,
    });
  }),

  /*
   * GET /stats?from=&to=   (bo'sh — bugun, Toshkent)
   *
   * Uchta ALOHIDA ko'rsatkich (bittasi ikkinchisini almashtirmaydi):
   *   created   — davrda YARATILGAN buyurtmalar va ularning HOZIRGI holati;
   *   delivered — davrda YETKAZILGAN (deliveredAt) buyurtmalar: pul shu yerda;
   *   cancelled — davrda BEKOR QILINGAN (cancelledAt).
   * Pul so'mda, restoran ko'rinishi: LokmaGo ulushi/Click YO'Q. `restaurantPayout`
   * faqat v2 moliya snapshot'i bor buyurtmalar uchun; eskilari `legacyOrders` da
   * sanaladi (jimgina 0 deb yig'ilmaydi).
   * Hisob JS'da (aggregatsiya emas): kunlik hajm kichik va bu har MongoDB-mos
   * bazada bir xil ishlaydi. CAP oshsa `truncated: true`.
   */
  stats: asyncHandler(async (req, res) => {
    const CAP = 20000;
    const { period, from, to } = dayRange(req.query);
    const base = visible(req);

    const [created, delivered, cancelled] = await Promise.all([
      Order.find({ ...base, createdAt: period.cond })
        .select('status fulfillment').limit(CAP).lean(),
      Order.find({ ...base, status: 'delivered', ...deliveredWindow(period) })
        .select('fulfillment paymentMethod subtotal deliveryFee total finance.model finance.restaurantPayout')
        .limit(CAP).lean(),
      Order.find({ ...base, status: 'cancelled', cancelledAt: period.cond })
        .select('_id').limit(CAP).lean(),
    ]);

    const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0]));
    const createdByFulfillment = { delivery: 0, pickup: 0 };
    for (const o of created) {
      if (o.status in byStatus) byStatus[o.status] += 1;
      if (o.fulfillment in createdByFulfillment) createdByFulfillment[o.fulfillment] += 1;
    }

    const sum = { foodTotal: 0, deliveryFee: 0, total: 0, restaurantPayout: 0 };
    const byPayment = { cash: { count: 0, total: 0 }, card: { count: 0, total: 0 } };
    const byFulfillment = { delivery: { count: 0, total: 0 }, pickup: { count: 0, total: 0 } };
    let legacyOrders = 0;
    for (const o of delivered) {
      sum.foodTotal += Number(o.subtotal) || 0;
      sum.deliveryFee += Number(o.deliveryFee) || 0;
      sum.total += Number(o.total) || 0;
      if (o.finance?.model === 'v2') sum.restaurantPayout += tiyinToSom(o.finance.restaurantPayout);
      else legacyOrders += 1;
      // Naqd/karta — billing hisoblagichi bilan bir xil qoida ('cash' — naqd, qolgani karta)
      const pay = byPayment[o.paymentMethod === 'cash' ? 'cash' : 'card'];
      pay.count += 1; pay.total += Number(o.total) || 0;
      const ful = byFulfillment[o.fulfillment];
      if (ful) { ful.count += 1; ful.total += Number(o.total) || 0; }
    }

    res.json({
      period: { from, to, timezone: 'Asia/Tashkent' },
      created: { count: created.length, byStatus, byFulfillment: createdByFulfillment },
      delivered: {
        count: delivered.length,
        foodTotal: som(sum.foodTotal),
        deliveryFee: som(sum.deliveryFee),
        total: som(sum.total),
        restaurantPayout: som(sum.restaurantPayout),
        legacyOrders,
        byPayment: {
          cash: { count: byPayment.cash.count, total: som(byPayment.cash.total) },
          card: { count: byPayment.card.count, total: som(byPayment.card.total) },
        },
        byFulfillment: {
          delivery: { count: byFulfillment.delivery.count, total: som(byFulfillment.delivery.total) },
          pickup: { count: byFulfillment.pickup.count, total: som(byFulfillment.pickup.total) },
        },
      },
      cancelled: { count: cancelled.length },
      truncated: [created, delivered, cancelled].some((a) => a.length >= CAP),
    });
  }),

  /*
   * POST /orders/:id/confirm-delivered — restoran "Yetkazildi".
   *
   * PATCH delivered YETKAZIB BERISHDA rad etiladi (kuryer/mijoz yakunlaydi:
   * restoran o'zi darhol yakunlasa komissiya taom yetmay hisoblanardi).
   * Bu endpoint MAVJUD deliveryCheck.confirmOrderDelivered yo'li — Telegram
   * botdagi eslatmaning "✅ Yakunlandi" tugmasi bilan AYNAN bir xil funksiya
   * (atomik holat tekshiruvi, settleOrder, real-time, baho so'rovi,
   * confirmedBy: 'restaurant').
   *
   * Shart (yetkazib berishda): buyurtma holatiga o'tganidan REMINDER_RULES.
   * firstAfterMin daqiqa o'tgan bo'lishi (yoki eslatma allaqachon ketgan).
   * Erta bo'lsa 409 CONFIRM_TOO_EARLY + `eligibleAt`. Buyurtma JSON'idagi
   * `restaurantConfirm.{eligible,eligibleAt}` shuni oldindan ko'rsatadi.
   * Olib ketishda vaqt sharti yo'q.
   *
   * Javob: toPanelOrder + `changed` (PATCH bilan bir xil). Takroriy chaqiruv
   * — 200 changed:false (komissiya ikki marta yozilmaydi).
   */
  confirmDelivered: asyncHandler(async (req, res) => {
    const id = req.params.id;
    const order = await Order.findOne({ _id: id, restaurantId: rid(req) })
      .select('status fulfillment acceptedAt readyAt deliveringAt updatedAt createdAt scheduledFor restaurantReminder')
      .lean();
    // Zal buyurtmasi gateway'da yo'q (ro'yxat bilan bir xil qoida)
    if (!order || order.fulfillment === 'dinein') {
      return res.status(404).json({ error: 'Buyurtma topilmadi', code: 'NOT_FOUND' });
    }

    const reply = async (changed) => {
      const fresh = await Order.findById(id)
        .populate('userId', 'firstName lastName username telegramId phone photoUrl')
        .lean();
      return res.json({ ...toPanelOrder(fresh), changed });
    };

    if (order.status === 'delivered') return reply(false);
    if (order.status === 'cancelled') {
      return res.status(409).json({ error: 'Buyurtma bekor qilingan', code: 'ORDER_CANCELLED' });
    }
    if (order.status === 'pending' || order.status === 'awaiting_payment') {
      return res.status(400).json({ error: 'Buyurtma hali qabul qilinmagan', code: 'WRONG_STATE' });
    }

    const gate = confirmEligibility(order);
    if (!gate.eligible) {
      return res.status(409).json({
        error: 'Hali erta: kuryer yetkazishi uchun vaqt beriladi',
        code: 'CONFIRM_TOO_EARLY',
        eligibleAt: gate.eligibleAt,
      });
    }

    const done = await confirmOrderDelivered(order._id, 'restaurant', { restaurantId: rid(req) });
    if (!done) {
      // Oraliqda boshqa yo'l (kuryer/mijoz/avto) yakunlagan yoki bekor qilingan
      const now = await Order.findById(id).select('status').lean();
      if (now?.status === 'delivered') return reply(false);
      return res.status(409).json({
        error: 'Buyurtmani boshqa taraf shu onda o‘zgartirdi',
        code: now?.status === 'cancelled' ? 'ORDER_CANCELLED' : 'RACE_LOST',
      });
    }

    // Telegram: eslatmadagi eski "✅ Yakunlandi" tugmalari yopiladi, karta yangilanadi (bot yo'li bilan bir xil)
    import('../services/restaurantReminders.js')
      .then((m) => m.clearReminderButtons(order._id))
      .catch(() => {});
    import('../services/restaurantBotOrders.js')
      .then((m) => m.refreshOrderMessages(order._id))
      .catch(() => {});

    return reply(true);
  }),
};
