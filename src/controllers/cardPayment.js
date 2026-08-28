import { z } from 'zod';
import { asyncHandler } from '../middleware/error.js';
import { User } from '../models/User.js';
import { Order } from '../models/Order.js';
import { Transaction } from '../models/Transaction.js';
import { payWithCardToken, getPaymentStatus, ClickApiError } from '../services/clickCardToken.js';
import { getIO } from '../sockets/io.js';

/**
 * SAQLANGAN KARTA BILAN TO'LOV.
 *
 * Oqim: mijoz kartani tanlaydi -> pul yechiladi -> buyurtma
 * restoranga chiqadi. Click sahifasiga o'tish yo'q, SMS ham
 * so'ralmaydi (karta bog'lanayotganda bir marta so'ralgan).
 *
 * ═══ NEGA BU KOD SHUNDAY YOZILGAN ═══
 *
 * Bu yerdagi asosiy xavf — IKKI MARTA PUL YECHISH. U ikki
 * yo'l bilan yuz berishi mumkin:
 *
 *   1) Mijoz tugmani ikki marta bosadi yoki tarmoq uzilib
 *      qayta yuboradi.
 *   2) So'rov Click'ga yetib boradi, pul yechiladi, lekin
 *      javob bizga qaytmaydi (timeout). Biz "xato" deb
 *      o'ylaymiz, mijoz qayta uradi — pul ikki marta ketadi.
 *
 * Birinchisiga qarshi: buyurtmaga 'paying' qulfi qo'yiladi
 * (atomik findOneAndUpdate).
 * Ikkinchisiga qarshi: har urinish Transaction sifatida
 * OLDINDAN yoziladi va tarmoq uzilganda holat Click'dan
 * so'raladi.
 */

export const cardPaymentController = {
  /**
   * POST /api/orders/:id/pay-card  { cardId }
   */
  payWithSavedCard: asyncHandler(async (req, res) => {
    const parsed = z.object({ cardId: z.string().min(1) }).safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Karta tanlanmagan' });
    }

    const user = await User.findById(req.userId).select('+cards.clickToken');
    if (!user) return res.status(404).json({ error: 'Foydalanuvchi topilmadi' });

    const card = user.cards.id(parsed.data.cardId);
    if (!card) return res.status(404).json({ error: 'Karta topilmadi' });
    if (!card.verified || !card.clickToken) {
      return res.status(400).json({ error: 'Karta tasdiqlanmagan' });
    }

    /*
     * QULF — atomik.
     *
     * Faqat to'lanmagan va qulflanmagan buyurtma 'paying'
     * holatiga o'tadi. Ikkinchi so'rov shu shartni
     * bajarmaydi va null oladi. `findOneAndUpdate` bitta
     * amalda bajarilgani uchun ikki so'rov orasiga
     * "tirqish" tushmaydi — `find` keyin `save` qilsak
     * shunday tirqish bo'lardi.
     */
    const order = await Order.findOneAndUpdate(
      {
        _id: req.params.id,
        userId: req.userId,
        isPaid: { $ne: true },
        status: { $in: ['awaiting_payment', 'pending'] },
        /*
         * 'unknown' ham to'sadi — testda topilgan xato.
         *
         * $ne: 'paying' faqat bitta qiymatni to'sardi, ya'ni
         * tarmoq uzilib qulf 'unknown' bo'lgandan keyin mijoz
         * qayta to'lay olardi — pul esa allaqachon yechilgan
         * bo'lishi mumkin edi. Endi qulf BOR bo'lsa yetarli.
         */
        paymentLock: null,
      },
      { paymentLock: 'paying', paymentLockAt: new Date() },
      { new: true },
    );

    if (!order) {
      // Sabab aniqlanadi — mijozga tushunarli xabar berish uchun
      const existing = await Order.findOne({ _id: req.params.id, userId: req.userId })
        .select('isPaid status paymentLock').lean();

      if (!existing) return res.status(404).json({ error: 'Buyurtma topilmadi' });
      if (existing.isPaid) return res.status(400).json({ error: 'Bu buyurtma allaqachon to‘langan' });
      if (existing.paymentLock === 'paying') {
        return res.status(409).json({
          error: 'To‘lov amalga oshirilmoqda, kuting',
          code: 'IN_PROGRESS',
        });
      }
      if (existing.paymentLock === 'unknown') {
        return res.status(409).json({
          error: 'Oldingi to‘lov holati aniqlanmagan. Tekshirilmoqda — '
            + 'pul ikki marta yechilmasligi uchun qayta urinish to‘xtatildi.',
          code: 'UNKNOWN_PENDING',
        });
      }
      return res.status(400).json({ error: 'Bu buyurtmani to‘lab bo‘lmaydi' });
    }

    // Har urinish OLDINDAN yoziladi — javob kelmasa ham iz qoladi
    const tx = await Transaction.create({
      provider: 'click',
      providerTransId: `card:${order._id}:${Date.now()}`,
      orderId: order._id,
      userId: order.userId,
      amount: Math.round(order.total * 100),
      state: 1,
    });

    let payment;
    try {
      payment = await payWithCardToken(card.clickToken, order.total, String(order._id));
    } catch (e) {
      const err = e instanceof ClickApiError ? e : null;

      /*
       * TARMOQ XATOSI — eng xavfli holat.
       *
       * Pul yechilgan bo'lishi HAM mumkin. Buyurtmani
       * "to'lanmagan" deb ochib qo'ysak mijoz qayta to'laydi
       * va pul ikki marta ketadi. Shuning uchun qulf
       * QOLDIRILADI va tekshirish uchun belgilanadi.
       */
      if (err?.code === 'NETWORK') {
        tx.state = 0;                 // noaniq
        tx.reason = 'network';
        await tx.save();
        await Order.findByIdAndUpdate(order._id, { paymentLock: 'unknown' });

        return res.status(502).json({
          error: 'To‘lov holati noaniq. Pul yechilgan bo‘lishi mumkin — '
            + 'buyurtmalar bo‘limini tekshiring yoki qo‘llab-quvvatlashga murojaat qiling.',
          code: 'UNKNOWN',
        });
      }

      // Aniq xato — pul yechilmagan, qulf ochiladi
      tx.state = -1;
      tx.cancelTime = Date.now();
      tx.reason = String(err?.code ?? 'unknown');
      await tx.save();
      await Order.findByIdAndUpdate(order._id, { paymentLock: null });

      return res.status(400).json({
        error: err?.message || 'To‘lov amalga oshmadi',
        code: err?.code,
      });
    }

    tx.providerTransId = payment.paymentId;
    tx.state = 2;
    tx.performTime = Date.now();
    await tx.save();

    /*
     * Moliyaviy yozuv MARKAZIY joyda — click.js dagi webhook
     * bilan bir xil yo'l. Ikki xil hisob-kitob bo'lmasligi
     * uchun bu yerda alohida hisoblanmaydi.
     */
    const { recordSuccess } = await import('../services/paymentRecord.js');
    await recordSuccess({
      order,
      provider: 'click',
      providerTransactionId: payment.paymentId,
      transactionId: tx._id,
      amountTiyin: Math.round(order.total * 100),
    });

    // Endi restoranga ko'rinadi
    const updated = await Order.findByIdAndUpdate(
      order._id,
      {
        isPaid: true,
        paidAt: new Date(),
        paymentMethod: 'click',
        status: 'pending',
        paymentLock: null,
      },
      { new: true },
    );

    const { recordPayment } = await import('../services/billing.js');
    await recordPayment(updated, 'click', tx._id);

    const io = getIO();
    io?.to(`order:${order._id}`).emit('order:paid', { orderId: String(order._id) });
    io?.to(`restaurant:${updated.restaurantId}`).emit('order:new', updated);
    io?.to('admin').emit('order:new', updated);

    res.json({
      ok: true,
      orderId: String(order._id),
      paymentId: payment.paymentId,
      total: order.total,
    });
  }),

  /**
   * POST /api/orders/:id/payment-recheck
   *
   * Tarmoq uzilgan to'lovni aniqlash. Mijoz "holatni
   * tekshirish" bosganda yoki fon vazifasi chaqiradi.
   */
  recheck: asyncHandler(async (req, res) => {
    const order = await Order.findOne({ _id: req.params.id, userId: req.userId });
    if (!order) return res.status(404).json({ error: 'Buyurtma topilmadi' });
    if (order.isPaid) return res.json({ paid: true });

    const tx = await Transaction.findOne({
      orderId: order._id, provider: 'click', state: 0,
    }).sort({ createdAt: -1 });

    if (!tx) return res.json({ paid: false, pending: false });

    // Click tomonidagi haqiqiy holat
    let status;
    try {
      status = await getPaymentStatus(tx.providerTransId);
    } catch {
      return res.json({ paid: false, pending: true });
    }

    // 2 = muvaffaqiyatli
    if (status === 2) {
      tx.state = 2;
      tx.performTime = Date.now();
      await tx.save();

      const { recordSuccess } = await import('../services/paymentRecord.js');
      await recordSuccess({
        order,
        provider: 'click',
        providerTransactionId: String(tx.providerTransId),
        transactionId: tx._id,
        amountTiyin: Math.round(order.total * 100),
      });

      await Order.findByIdAndUpdate(order._id, {
        isPaid: true, paidAt: new Date(), paymentMethod: 'click',
        status: 'pending', paymentLock: null,
      });

      return res.json({ paid: true });
    }

    tx.state = -1;
    await tx.save();
    await Order.findByIdAndUpdate(order._id, { paymentLock: null });
    res.json({ paid: false, pending: false });
  }),
};
