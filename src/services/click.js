import crypto from 'node:crypto';
import { config } from '../config/index.js';
import { Order } from '../models/Order.js';
import { Transaction } from '../models/Transaction.js';
import { getIO } from '../sockets/io.js';

/**
 * Click SHOP API.
 * Hujjat: docs.click.uz/en/click-api-request
 *
 * Ikki bosqich: Prepare (action=0) va Complete (action=1).
 * Summa SO'MDA keladi (Payme'dan farqli).
 */

// Rasmiy javob kodlari
export const ClickError = {
  Success: 0,
  SignCheckFailed: -1,
  IncorrectAmount: -2,
  ActionNotFound: -3,
  AlreadyPaid: -4,
  UserNotFound: -5,
  TransactionNotFound: -6,
  BadRequest: -8,
  TransactionCancelled: -9,
};

const NOTE = {
  [ClickError.Success]: 'Success',
  [ClickError.SignCheckFailed]: 'SIGN CHECK FAILED',
  [ClickError.IncorrectAmount]: 'Incorrect parameter amount',
  [ClickError.ActionNotFound]: 'Action not found',
  [ClickError.AlreadyPaid]: 'Already paid',
  [ClickError.UserNotFound]: 'User does not exist',
  [ClickError.TransactionNotFound]: 'Transaction does not exist',
  [ClickError.BadRequest]: 'Error in request from click',
  [ClickError.TransactionCancelled]: 'Transaction cancelled',
};

const fail = (code) => ({ error: code, error_note: NOTE[code] });

/**
 * Imzo tekshiruvi.
 * Prepare:  md5(click_trans_id + service_id + SECRET + merchant_trans_id + amount + action + sign_time)
 * Complete: md5(click_trans_id + service_id + SECRET + merchant_trans_id + merchant_prepare_id + amount + action + sign_time)
 */
function verifySign(b) {
  const parts = [
    b.click_trans_id,
    b.service_id,
    config.click.secretKey,
    b.merchant_trans_id,
    // Complete bosqichida prepare_id ham qatnashadi
    ...(String(b.action) === '1' ? [b.merchant_prepare_id] : []),
    b.amount,
    b.action,
    b.sign_time,
  ];
  const expected = crypto.createHash('md5').update(parts.join('')).digest('hex');
  return expected === b.sign_string;
}

// Summa solishtiruvi — Click so'mda yuboradi, kasr bo'lishi mumkin
const sameAmount = (clickAmount, orderTotal) =>
  Math.abs(Number(clickAmount) - orderTotal) < 0.01;

// ===== PREPARE (action = 0) =====
export async function clickPrepare(body) {
  if (!verifySign(body)) return fail(ClickError.SignCheckFailed);

  const orderId = body.merchant_trans_id;
  if (!/^[a-f\d]{24}$/i.test(String(orderId))) {
    return fail(ClickError.UserNotFound);
  }

  const order = await Order.findById(orderId);
  if (!order) return fail(ClickError.UserNotFound);
  if (order.isPaid) return fail(ClickError.AlreadyPaid);
  if (order.status === 'cancelled') return fail(ClickError.TransactionCancelled);
  if (!sameAmount(body.amount, order.total)) return fail(ClickError.IncorrectAmount);

  // Takroriy so'rov — mavjud tranzaksiyani qaytaramiz
  let tx = await Transaction.findOne({
    provider: 'click', providerTransId: String(body.click_trans_id),
  });

  if (!tx) {
    tx = await Transaction.create({
      provider: 'click',
      providerTransId: String(body.click_trans_id),
      orderId: order._id,
      userId: order.userId,
      amount: Math.round(Number(body.amount) * 100),
      state: 1,
      clickPaydocId: String(body.click_paydoc_id || ''),
    });

    /*
     * Prepare ID — Complete bosqichida shu bilan tekshiriladi.
     *
     * ILGARI: Date.now() % 1e9 — bir millisekundda yaratilgan ikki
     * tranzaksiya BIR XIL id olardi. Ehtimolligi past, lekin
     * to'qnashuv yuz bersa Complete bosqichida NOTO'G'RI
     * tranzaksiya tasdiqlanishi mumkin edi.
     *
     * ENDI: MongoDB _id ning oxirgi 4 bayti (hisoblagich + tasodif)
     * dan olinadi. U tranzaksiyaning O'ZIGA bog'langan, vaqtga
     * emas — shuning uchun bir millisekundda nechta yaratilishidan
     * qat'i nazar takrorlanmaydi. Natija 10 xonadan oshmaydi,
     * Click talabiga mos.
     */
    tx.clickPrepareId = parseInt(String(tx._id).slice(-8), 16);
    await tx.save();
  }

  return {
    click_trans_id: body.click_trans_id,
    merchant_trans_id: String(order._id),
    merchant_prepare_id: tx.clickPrepareId,
    error: ClickError.Success,
    error_note: NOTE[ClickError.Success],
  };
}

// ===== COMPLETE (action = 1) =====
export async function clickComplete(body) {
  if (!verifySign(body)) return fail(ClickError.SignCheckFailed);

  const tx = await Transaction.findOne({
    provider: 'click', providerTransId: String(body.click_trans_id),
  });
  if (!tx) return fail(ClickError.TransactionNotFound);

  // Prepare ID mos kelishi shart
  if (Number(body.merchant_prepare_id) !== tx.clickPrepareId) {
    return fail(ClickError.TransactionNotFound);
  }

  // Allaqachon bekor qilingan
  if (tx.state < 0) return fail(ClickError.TransactionCancelled);

  // Click xato yuborgan — to'lov bekor qilinadi
  if (Number(body.error) < 0) {
    tx.state = -1;
    tx.cancelTime = Date.now();
    tx.reason = Number(body.error);
    await tx.save();
    return fail(ClickError.TransactionCancelled);
  }

  const order = await Order.findById(tx.orderId);
  if (!order) return fail(ClickError.UserNotFound);

  /*
   * ═══ "ALLAQACHON TO'LANGAN" TEKSHIRUVI — IKKI SHART ═══
   *
   * ILGARI bu yerda faqat `tx.state === 2` tekshirilardi va bu
   * JIDDIY XATOGA olib kelardi:
   *
   *   tx.state = 2 pastdagi yon ta'sirlardan (moliyaviy yozuv,
   *   buyurtmani faollashtirish, billing) OLDIN saqlanardi. Agar
   *   o'sha qadamlarning birida xato chiqsa (baza uzildi, timeout),
   *   webhook 500 qaytarardi va Click QAYTA YUBORARDI — lekin
   *   qayta so'rov shu yerda "allaqachon to'langan" deb rad
   *   etilardi. Click boshqa urinmasdi.
   *
   *   Natija: PUL MIJOZDAN YECHILGAN, buyurtma esa abadiy
   *   'awaiting_payment' da qolib, restoranga hech qachon
   *   chiqmasdi.
   *
   * ENDI: to'lov faqat buyurtmaning O'ZI ham to'langan bo'lsagina
   * yakunlangan hisoblanadi. Yarim qolgan holatda takroriy
   * webhook pastdagi ishni oxiriga yetkazadi — recordSuccess ham,
   * recordPayment ham idempotent, shuning uchun ikki marta
   * bajarilib ketmaydi.
   */
  if (tx.state === 2 && order.isPaid) return fail(ClickError.AlreadyPaid);

  if (!sameAmount(body.amount, order.total)) return fail(ClickError.IncorrectAmount);

  /*
   * Buyurtmani oshxonaga chiqarish va moliyaviy yozuvni yaratish
   * MARKAZIY joyda (paymentRecord.js) bajariladi:
   *   • idempotent — takroriy webhook ikki marta yubormaydi
   *   • bo'linish hisobi (restoran/LokmaGo ulushi) yoziladi
   *   • Click split qilmagani uchun payout navbatga qo'yiladi
   *   • dispatch yiqilsa to'lov SUCCESS qoladi va qayta urinadi
   */
  const { recordSuccess } = await import('./paymentRecord.js');
  await recordSuccess({
    order,
    provider: 'click',
    providerTransactionId: String(body.click_trans_id),
    transactionId: tx._id,
    amountTiyin: Math.round(order.total * 100),
  });

  const updated = await Order.findByIdAndUpdate(
    tx.orderId,
    {
      isPaid: true,
      // paidAt FAQAT birinchi marta yoziladi — takroriy webhook
      // to'lov vaqtini keyingi sanaga surib yubormasin
      ...(order.paidAt ? {} : { paidAt: new Date() }),
      paymentMethod: 'click',
      /*
       * Endi restoranga ko'rinadi. Agar buyurtma allaqachon
       * oldinga siljigan bo'lsa (masalan 'preparing'), uni
       * 'pending' ga QAYTARMAYMIZ — takroriy webhook oshxonadagi
       * ishni orqaga tashlab yuborishi mumkin edi.
       */
      ...(order.status === 'awaiting_payment' ? { status: 'pending' } : {}),
    },
    { new: true },
  );

  const { recordPayment } = await import('./billing.js');
  await recordPayment(updated, 'click', tx._id);

  /*
   * ═══ TRANZAKSIYA ENG OXIRIDA YAKUNLANADI ═══
   * Yuqoridagi hamma narsa muvaffaqiyatli tugagandan KEYIN.
   * Shu tartib tufayli yarim bajarilgan holat qolmaydi: xato
   * chiqsa tx.state 1 da qoladi va Click qayta yuborganda
   * jarayon oxiriga yetadi.
   */
  tx.state = 2;
  tx.performTime = Date.now();
  await tx.save();

  const io = getIO();
  io?.to(`order:${tx.orderId}`).emit('order:paid', { orderId: String(tx.orderId) });
  io?.to('admin').emit('order:update', updated);

  return {
    click_trans_id: body.click_trans_id,
    merchant_trans_id: String(order._id),
    merchant_confirm_id: tx.clickPrepareId,
    error: ClickError.Success,
    error_note: NOTE[ClickError.Success],
  };
}

// To'lov havolasi — mijozni Click sahifasiga yuborish uchun
export function buildClickCheckoutUrl(orderId, amountSom) {
  const u = new URL('https://my.click.uz/services/pay');
  u.searchParams.set('service_id', config.click.serviceId);
  u.searchParams.set('merchant_id', config.click.merchantId);
  u.searchParams.set('amount', String(amountSom));
  u.searchParams.set('transaction_param', String(orderId));
  if (config.click.returnUrl) u.searchParams.set('return_url', config.click.returnUrl);
  return u.toString();
}
