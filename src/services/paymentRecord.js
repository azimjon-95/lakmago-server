import { Payment, buildIdempotencyKey } from '../models/Payment.js';
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

  // Allaqachon qayd etilganmi
  const existing = await Payment.findOne({ idempotencyKey: key });
  if (existing && existing.status === 'SUCCESS') return existing;

  const split = computeSplit(provider, amountTiyin, lokmaPercent);
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
          lokmaPercentApplied: lokmaPercent ?? 0,
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

  await releaseOrderToKitchen(order._id, provider);
  return payment;
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

/** To'lov muvaffaqiyatsiz yoki bekor qilinganda. */
export async function recordFailure({ order, provider, providerTransactionId, reason }) {
  const key = buildIdempotencyKey(order._id, provider, providerTransactionId);
  return Payment.findOneAndUpdate(
    { idempotencyKey: key },
    { status: reason === 'PAYMENT_FAILED' ? 'FAILED' : 'CANCELLED', refundReason: reason },
    { new: true },
  );
}
