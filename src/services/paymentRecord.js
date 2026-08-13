import { Payment, buildIdempotencyKey, canTransition } from '../models/Payment.js';
import { Order } from '../models/Order.js';
import { computeSplit } from './paymentSplit.js';
import { getProvider } from './providers/index.js';
import { getIO } from '../sockets/io.js';

/**
 * To'lov muvaffaqiyatini qayd etish.
 *
 * BU YAGONA JOY, buyurtmani oshxonaga chiqaradigan.
 * Mijozdan kelgan "to'ladim" ga hech qachon ishonilmaydi —
 * faqat shlyuz webhooki (imzosi tekshirilgan) shu funksiyani
 * chaqiradi.
 *
 * Idempotent: bir webhook ikki marta kelsa ikkinchisida hech
 * narsa o'zgarmaydi va buyurtma ikki marta oshxonaga tushmaydi.
 */
export async function recordSuccess({
  order, provider, providerTransactionId, transactionId, amountTiyin, lokmaPercent,
}) {
  const key = buildIdempotencyKey(order._id, provider, providerTransactionId);

  /*
   * Bo'linish foizi restoran bilan tuzilgan KELISHUVDAN olinadi:
   * restoran komissiyasi + mijoz haqi = shlyuzga ketadigan yagona
   * foiz. Kelishuv bo'lmasa standart qiymat ishlatiladi.
   */
  let percent = lokmaPercent;
  if (percent === undefined || percent === null) {
    const { activeAgreement } = await import('../models/CommissionAgreement.js');
    const agreement = await activeAgreement(order.restaurantId);
    percent = agreement?.totalSplitPercent;
  }

  // Allaqachon qayd etilganmi
  const existing = await Payment.findOne({ idempotencyKey: key });
  if (existing && existing.status === 'SUCCESS') return existing;

  const split = computeSplit(provider, amountTiyin, percent);
  const gateway = getProvider(provider);

  // Paynet o'zi bo'ladi → o'tkazma kerak emas.
  // Click → LokmaGo qarzdor, bank orqali yuboriladi.
  const payoutStatus = gateway?.supportsSplit() ? 'NOT_REQUIRED' : 'PENDING';

  let payment;
  try {
    payment = await Payment.findOneAndUpdate(
      { idempotencyKey: key },
      {
        $setOnInsert: {
          orderId: order._id,
          restaurantId: order.restaurantId,
          userId: order.userId,
          provider,
          providerTransactionId: providerTransactionId || '',
          transactionId: transactionId || undefined,
          amount: split.total,
          currency: 'UZS',
          status: 'SUCCESS',
          providerFee: split.providerFee,
          restaurantAmount: split.restaurantAmount,
          lokmaGrossCommission: split.lokmaGrossCommission,
          lokmaNetCommission: split.lokmaNetCommission,
          lokmaPercentApplied: percent ?? 0,
          payoutStatus,
          idempotencyKey: key,
          paidAt: new Date(),
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
  } catch (err) {
    if (err?.code === 11000) return Payment.findOne({ idempotencyKey: key });
    throw err;
  }

  /*
   * Buyurtmani oshxonaga chiqarish.
   *
   * MUHIM: bu qadam yiqilsa ham to'lov SUCCESS bo'lib qoladi —
   * pul olingan, uni "yo'q" deb bo'lmaydi. Buyurtma
   * dispatchPending bo'lib belgilanadi va qayta urinish
   * mexanizmi (retryPendingDispatch) uni oshxonaga chiqaradi.
   * Admin panelda bu holat ko'rinadi.
   */
  try {
    await releaseOrderToKitchen(order._id, provider);
    await Payment.updateOne(
      { _id: payment._id },
      { $set: { 'metadata.dispatched': true, 'metadata.dispatchError': '' } },
    );
  } catch (err) {
    console.error('[payment] buyurtma oshxonaga chiqmadi:', err.message);
    await Payment.updateOne(
      { _id: payment._id },
      {
        $set: {
          'metadata.dispatched': false,
          'metadata.dispatchError': String(err.message).slice(0, 200),
          'metadata.dispatchAttempts': (payment.metadata?.dispatchAttempts || 0) + 1,
        },
      },
    );
  }

  return payment;
}

/**
 * Oshxonaga chiqmay qolgan buyurtmalarni qayta yuborish.
 *
 * To'lov o'tgan, lekin dispatch paytida texnik xato bo'lgan
 * holatlar uchun. Rejalashtiruvchi chaqiradi.
 *
 * Yangi to'lov YARATMAYDI va buyurtmani takrorlamaydi —
 * faqat mavjud buyurtma holatini to'g'rilaydi.
 */
export async function retryPendingDispatch(limit = 50) {
  const stuck = await Payment.find({
    status: 'SUCCESS',
    'metadata.dispatched': false,
  }).limit(limit).lean();

  const fixed = [];
  for (const p of stuck) {
    try {
      await releaseOrderToKitchen(p.orderId, p.provider);
      await Payment.updateOne({ _id: p._id }, { $set: { 'metadata.dispatched': true } });
      fixed.push(String(p._id));
    } catch (err) {
      await Payment.updateOne(
        { _id: p._id },
        {
          $set: { 'metadata.dispatchError': String(err.message).slice(0, 200) },
          $inc: { 'metadata.dispatchAttempts': 1 },
        },
      );
    }
  }
  return fixed;
}

/**
 * Buyurtmani oshxonaga chiqarish.
 *
 * Faqat 'awaiting_payment' holatidan 'pending' ga o'tkazadi.
 * Shart muhim: buyurtma allaqachon qabul qilingan yoki bekor
 * qilingan bo'lsa, takroriy webhook uni orqaga qaytarmasligi
 * kerak.
 */
async function releaseOrderToKitchen(orderId, provider) {
  const order = await Order.findOneAndUpdate(
    { _id: orderId, status: 'awaiting_payment' },
    { isPaid: true, paidAt: new Date(), paymentMethod: provider, status: 'pending' },
    { new: true },
  );

  if (!order) {
    // Holat boshqacha edi — faqat to'langan belgisini qo'yamiz
    await Order.updateOne(
      { _id: orderId, isPaid: { $ne: true } },
      { isPaid: true, paidAt: new Date(), paymentMethod: provider },
    );
    return;
  }

  const io = getIO();
  io?.to(`order:${orderId}`).emit('order:paid', { orderId: String(orderId) });
  io?.to(`restaurant:${order.restaurantId}`).emit('order:new', order);
  io?.to('admin').emit('order:new', order);
}

/**
 * To'lov muvaffaqiyatsiz yoki bekor qilinganda.
 *
 * SUCCESS bo'lgan to'lovni FAILED qilmaydi: kechikkan yoki
 * takroriy webhook allaqachon bajarilgan buyurtmani bekor
 * qilmasligi kerak. Qaytarish alohida oqim (refund).
 */
export async function recordFailure({ order, provider, providerTransactionId, reason }) {
  const key = buildIdempotencyKey(order._id, provider, providerTransactionId);
  const payment = await Payment.findOne({ idempotencyKey: key });
  if (!payment) return null;

  const next = reason === 'PAYMENT_FAILED' ? 'FAILED' : 'CANCELLED';
  if (!canTransition(payment.status, next)) {
    console.warn(`[payment] ${payment.status} → ${next} rad etildi (${key})`);
    return payment;
  }

  payment.status = next;
  payment.refundReason = reason;
  await payment.save();
  return payment;
}
