import crypto from 'crypto';
import { Payment } from '../models/Payment.js';
import { Payout } from '../models/Payout.js';
import { RestaurantPaymentAccount } from '../models/RestaurantPaymentAccount.js';
import { getBankProvider } from './bank/index.js';

/**
 * Restoranga pul o'tkazish.
 *
 * Faqat Click uchun kerak: Paynet pulni shlyuzning o'zi bo'ladi.
 *
 * Oqim:
 *   to'langan buyurtmalar (payoutStatus=PENDING)
 *   → restoran bo'yicha yig'iladi
 *   → bitta Payout hujjati
 *   → bank provayderi
 *   → holat yangilanadi
 *
 * Idempotentlik ikki qavatda:
 *   1. Payout.idempotencyKey — bir partiya ikki marta yaratilmaydi
 *   2. Bank chaqiruviga ham shu kalit uzatiladi — tarmoq uzilsa
 *      qayta urinish xavfsiz
 */

const MAX_ATTEMPTS = 5;

/** Partiya uchun barqaror kalit: bir xil to'lovlar → bir xil kalit. */
function batchKey(restaurantId, paymentIds) {
  const sorted = [...paymentIds].map(String).sort().join(',');
  const hash = crypto.createHash('sha256').update(sorted).digest('hex').slice(0, 32);
  return `payout:${restaurantId}:${hash}`;
}

/**
 * Restoranning to'lanmagan ulushlarini bitta partiyaga yig'adi.
 * @returns {Promise<object|null>} yaratilgan Payout yoki null
 */
export async function buildPayoutBatch(restaurantId) {
  const pending = await Payment.find({
    restaurantId,
    status: 'SUCCESS',
    payoutStatus: 'PENDING',
  }).select('_id restaurantAmount').lean();

  if (pending.length === 0) return null;

  const amount = pending.reduce((sum, p) => sum + (p.restaurantAmount || 0), 0);
  if (amount <= 0) return null;

  const ids = pending.map((p) => p._id);
  const key = batchKey(restaurantId, ids);

  // Shu partiya allaqachon yaratilganmi
  const existing = await Payout.findOne({ idempotencyKey: key });
  if (existing) return existing;

  const account = await RestaurantPaymentAccount.findOne({
    restaurantId, provider: 'click',
  }).lean();

  let payout;
  try {
    payout = await Payout.create({
      restaurantId,
      paymentIds: ids,
      amount,
      status: 'PENDING',
      idempotencyKey: key,
      bankProvider: getBankProvider().name,
      // Rekvizitlar nusxasi — keyin o'zgarsa ham tarix buzilmaydi
      snapshot: { bank: account?.bank || null },
    });
  } catch (err) {
    // Bir vaqtda ikki so'rov kelgan — unique indeks ushladi
    if (err?.code === 11000) return Payout.findOne({ idempotencyKey: key });
    throw err;
  }

  // To'lovlarni band qilamiz — ikkinchi partiyaga tushmasin
  await Payment.updateMany(
    { _id: { $in: ids } },
    { payoutStatus: 'PROCESSING', payoutId: payout._id },
  );

  return payout;
}

/**
 * Partiyani bankka yuborish.
 *
 * Xato bo'lsa qayta urinish rejalashtiriladi (eksponensial
 * kechikish). MAX_ATTEMPTS dan keyin FAILED va odam aralashuvi
 * kutiladi — pul masalasida cheksiz urinish xavfli.
 */
export async function sendPayout(payoutId) {
  const payout = await Payout.findById(payoutId);
  if (!payout) return null;

  // Yakunlangan holatga qayta tegmaymiz
  if (['CONFIRMED', 'CANCELLED'].includes(payout.status)) return payout;
  if (payout.attempts >= MAX_ATTEMPTS && payout.status === 'FAILED') return payout;

  const bank = getBankProvider(payout.bankProvider);
  if (!bank.isConfigured()) {
    payout.lastError = 'Bank provayderi sozlanmagan';
    await payout.save();
    return payout;
  }

  payout.status = 'PROCESSING';
  payout.attempts += 1;
  await payout.save();

  try {
    const res = await bank.send({
      idempotencyKey: payout.idempotencyKey,     // qayta urinish xavfsiz
      amount: payout.amount,
      account: payout.snapshot?.bank || null,
      description: `LokmaGo hisob-kitob ${payout._id}`,
    });

    payout.status = res.status === 'CONFIRMED' ? 'CONFIRMED' : 'SENT';
    payout.bankReference = res.reference || '';
    payout.sentAt = new Date();
    payout.lastError = '';
    payout.nextRetryAt = null;
    if (payout.status === 'CONFIRMED') payout.confirmedAt = new Date();
    await payout.save();

    await Payment.updateMany(
      { _id: { $in: payout.paymentIds } },
      {
        payoutStatus: payout.status === 'CONFIRMED' ? 'SETTLED' : 'PROCESSING',
        payoutReference: payout.bankReference,
      },
    );
  } catch (err) {
    payout.lastError = String(err?.message || err).slice(0, 300);

    if (payout.attempts >= MAX_ATTEMPTS) {
      payout.status = 'FAILED';
      payout.nextRetryAt = null;
      // To'lovlarni qaytarib qo'yamiz — keyingi partiyaga tushsin
      await Payment.updateMany(
        { _id: { $in: payout.paymentIds } },
        { payoutStatus: 'FAILED' },
      );
    } else {
      payout.status = 'PENDING';
      // 1, 2, 4, 8 daqiqa
      const delayMin = 2 ** (payout.attempts - 1);
      payout.nextRetryAt = new Date(Date.now() + delayMin * 60_000);
    }
    await payout.save();
  }

  return payout;
}

/** Bank tasdiqlaganda (webhook yoki qo'lda) chaqiriladi. */
export async function confirmPayout(payoutId, bankReference = '') {
  const payout = await Payout.findById(payoutId);
  if (!payout) return null;
  if (payout.status === 'CONFIRMED') return payout;   // idempotent

  payout.status = 'CONFIRMED';
  payout.confirmedAt = new Date();
  if (bankReference) payout.bankReference = bankReference;
  await payout.save();

  await Payment.updateMany(
    { _id: { $in: payout.paymentIds } },
    { payoutStatus: 'SETTLED', payoutReference: payout.bankReference },
  );

  return payout;
}

/** Qayta urinish vaqti kelgan partiyalar. */
export async function retryDuePayouts(limit = 20) {
  const due = await Payout.find({
    status: 'PENDING',
    nextRetryAt: { $lte: new Date() },
  }).select('_id').limit(limit).lean();

  const results = [];
  for (const p of due) results.push(await sendPayout(p._id));
  return results;
}
