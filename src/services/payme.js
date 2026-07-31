import { config } from '../config/index.js';
import { Order } from '../models/Order.js';
import { Transaction } from '../models/Transaction.js';
import { getIO } from '../sockets/io.js';

/**
 * Payme Merchant API.
 * Hujjat: developer.help.paycom.uz/metody-merchant-api
 *
 * Payme bizga JSON-RPC so'rov yuboradi, biz javob beramiz.
 * Summa TIYINDA keladi (1 so'm = 100 tiyin).
 */

// Rasmiy xatolik kodlari
export const PaymeError = {
  TransportError: -32300,
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  AuthError: -32504,
  SystemError: -32400,
  // Merchant xatolari
  InvalidAmount: -31001,
  TransactionNotFound: -31003,
  CantDoOperation: -31008,
  // Account xatolari (-31050 .. -31099)
  OrderNotFound: -31050,
  OrderAlreadyPaid: -31051,
  OrderCancelled: -31052,
};

const MSG = {
  [PaymeError.AuthError]: {
    uz: 'Avtorizatsiya xatosi', ru: 'Ошибка авторизации', en: 'Authorization error',
  },
  [PaymeError.InvalidAmount]: {
    uz: "Noto'g'ri summa", ru: 'Неверная сумма', en: 'Invalid amount',
  },
  [PaymeError.TransactionNotFound]: {
    uz: 'Tranzaksiya topilmadi', ru: 'Транзакция не найдена', en: 'Transaction not found',
  },
  [PaymeError.CantDoOperation]: {
    uz: 'Operatsiyani bajarib bo\u2018lmaydi', ru: 'Невозможно выполнить операцию', en: 'Cannot perform operation',
  },
  [PaymeError.OrderNotFound]: {
    uz: 'Buyurtma topilmadi', ru: 'Заказ не найден', en: 'Order not found',
  },
  [PaymeError.OrderAlreadyPaid]: {
    uz: "Buyurtma allaqachon to'langan", ru: 'Заказ уже оплачен', en: 'Order already paid',
  },
  [PaymeError.OrderCancelled]: {
    uz: 'Buyurtma bekor qilingan', ru: 'Заказ отменён', en: 'Order cancelled',
  },
  [PaymeError.SystemError]: {
    uz: 'Tizim xatosi', ru: 'Системная ошибка', en: 'System error',
  },
};

const err = (code, id = null, data = null) => ({
  error: { code, message: MSG[code] || MSG[PaymeError.SystemError], data },
  result: null,
  id,
});

const ok = (result, id = null) => ({ error: null, result, id });

// Basic auth tekshiruvi: login "Paycom", parol — kabinetdan
function checkAuth(header) {
  if (!header?.startsWith('Basic ')) return false;
  try {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const sep = decoded.indexOf(':');
    const login = decoded.slice(0, sep);
    const password = decoded.slice(sep + 1);
    if (login !== (config.payme.login || 'Paycom')) return false;
    // Test rejimida ikkala parol ham qabul qilinadi
    return password === config.payme.key || password === config.payme.testKey;
  } catch {
    return false;
  }
}

// Buyurtmani account'dan topamiz. Kalit nomi kabinetda sozlanadi.
async function findOrder(account) {
  const orderId = account?.order_id || account?.orderId || account?.order;
  if (!orderId || !/^[a-f\d]{24}$/i.test(String(orderId))) return null;
  return Order.findById(orderId);
}

// ===== METODLAR =====

async function checkPerformTransaction(params, id) {
  const order = await findOrder(params.account);
  if (!order) return err(PaymeError.OrderNotFound, id);
  if (order.status === 'cancelled') return err(PaymeError.OrderCancelled, id);
  if (order.isPaid) return err(PaymeError.OrderAlreadyPaid, id);

  // Summa tiyinda solishtiriladi
  if (Number(params.amount) !== order.total * 100) {
    return err(PaymeError.InvalidAmount, id);
  }
  return ok({ allow: true }, id);
}

async function createTransaction(params, id) {
  // Takroriy so'rov — birinchi javob qaytariladi
  const existing = await Transaction.findOne({
    provider: 'payme', providerTransId: params.id,
  });
  if (existing) {
    if (existing.state !== 1) return err(PaymeError.CantDoOperation, id);
    return ok({
      create_time: existing.createTime,
      transaction: String(existing._id),
      state: existing.state,
    }, id);
  }

  const check = await checkPerformTransaction(params, id);
  if (check.error) return check;

  const order = await findOrder(params.account);

  // Shu buyurtma uchun boshqa faol tranzaksiya bormi
  const active = await Transaction.findOne({ orderId: order._id, state: 1 });
  if (active) return err(PaymeError.CantDoOperation, id);

  const tx = await Transaction.create({
    provider: 'payme',
    providerTransId: params.id,
    orderId: order._id,
    userId: order.userId,
    amount: params.amount,
    state: 1,
    createTime: params.time || Date.now(),
  });

  return ok({
    create_time: tx.createTime,
    transaction: String(tx._id),
    state: tx.state,
  }, id);
}

async function performTransaction(params, id) {
  const tx = await Transaction.findOne({
    provider: 'payme', providerTransId: params.id,
  });
  if (!tx) return err(PaymeError.TransactionNotFound, id);

  // Takroriy so'rov — o'sha javob
  if (tx.state === 2) {
    return ok({
      transaction: String(tx._id),
      perform_time: tx.performTime,
      state: tx.state,
    }, id);
  }
  if (tx.state !== 1) return err(PaymeError.CantDoOperation, id);

  tx.state = 2;
  tx.performTime = Date.now();
  await tx.save();

  // Buyurtmani to'langan deb belgilaymiz
  const order = await Order.findByIdAndUpdate(
    tx.orderId,
    { isPaid: true, paidAt: new Date(), paymentMethod: 'payme' },
    { new: true },
  );

  const io = getIO();
  io?.to(`order:${tx.orderId}`).emit('order:paid', { orderId: String(tx.orderId) });
  io?.to('admin').emit('order:update', order);

  return ok({
    transaction: String(tx._id),
    perform_time: tx.performTime,
    state: tx.state,
  }, id);
}

async function cancelTransaction(params, id) {
  const tx = await Transaction.findOne({
    provider: 'payme', providerTransId: params.id,
  });
  if (!tx) return err(PaymeError.TransactionNotFound, id);

  // Allaqachon bekor qilingan — o'sha javob
  if (tx.state < 0) {
    return ok({
      transaction: String(tx._id),
      cancel_time: tx.cancelTime,
      state: tx.state,
    }, id);
  }

  // To'langandan keyin bekor qilish = pul qaytarish
  tx.state = tx.state === 2 ? -2 : -1;
  tx.cancelTime = Date.now();
  tx.reason = params.reason ?? null;
  await tx.save();

  if (tx.state === -2) {
    // Pul qaytarildi — buyurtmadan to'lov belgisini olib tashlaymiz
    const order = await Order.findByIdAndUpdate(
      tx.orderId,
      { isPaid: false, paidAt: null },
      { new: true },
    );
    getIO()?.to('admin').emit('order:update', order);
  }

  return ok({
    transaction: String(tx._id),
    cancel_time: tx.cancelTime,
    state: tx.state,
  }, id);
}

async function checkTransaction(params, id) {
  const tx = await Transaction.findOne({
    provider: 'payme', providerTransId: params.id,
  });
  if (!tx) return err(PaymeError.TransactionNotFound, id);

  return ok({
    create_time: tx.createTime,
    perform_time: tx.performTime,
    cancel_time: tx.cancelTime,
    transaction: String(tx._id),
    state: tx.state,
    reason: tx.reason,
  }, id);
}

async function getStatement(params, id) {
  const list = await Transaction.find({
    provider: 'payme',
    createTime: { $gte: params.from, $lte: params.to },
  }).lean();

  return ok({
    transactions: list.map((t) => ({
      id: t.providerTransId,
      time: t.createTime,
      amount: t.amount,
      account: { order_id: String(t.orderId) },
      create_time: t.createTime,
      perform_time: t.performTime,
      cancel_time: t.cancelTime,
      transaction: String(t._id),
      state: t.state,
      reason: t.reason,
    })),
  }, id);
}

// ===== ASOSIY BOSHQARUVCHI =====
export async function handlePaymeRequest(req) {
  const { method, params = {}, id = null } = req.body || {};

  if (!checkAuth(req.headers.authorization)) {
    return err(PaymeError.AuthError, id);
  }

  try {
    switch (method) {
      case 'CheckPerformTransaction': return await checkPerformTransaction(params, id);
      case 'CreateTransaction': return await createTransaction(params, id);
      case 'PerformTransaction': return await performTransaction(params, id);
      case 'CancelTransaction': return await cancelTransaction(params, id);
      case 'CheckTransaction': return await checkTransaction(params, id);
      case 'GetStatement': return await getStatement(params, id);
      default: return err(PaymeError.MethodNotFound, id);
    }
  } catch (e) {
    console.error('[payme]', method, e.message);
    return err(PaymeError.SystemError, id);
  }
}

// To'lov havolasi — mijozni Payme sahifasiga yuborish uchun
export function buildPaymeCheckoutUrl(orderId, amountSom) {
  const params = [
    `m=${config.payme.merchantId}`,
    `ac.order_id=${orderId}`,
    `a=${amountSom * 100}`,
    `c=${config.payme.returnUrl || ''}`,
  ].join(';');
  return `https://checkout.paycom.uz/${Buffer.from(params).toString('base64')}`;
}
