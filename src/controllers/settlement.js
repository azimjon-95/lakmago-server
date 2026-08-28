import { z } from 'zod';
import crypto from 'crypto';
import { asyncHandler } from '../middleware/error.js';
import { Payment } from '../models/Payment.js';
import { Payout } from '../models/Payout.js';
import { Restaurant } from '../models/Restaurant.js';

/**
 * Kunlik hisob-kitob (settlement) hisoboti.
 *
 * NEGA ALOHIDA KONTROLLER: eski billing.js umumiy Ledger
 * yozuvlariga tayanadi (provayder — Click/Paynet — farqini
 * bilmaydi). Bu yerda esa Payment hujjatining o'zidagi
 * (provider, providerFee, restaurantAmount, lokmaNetCommission)
 * maydonlaridan to'g'ridan-to'g'ri foydalaniladi — restoranga
 * QANCHA, QAYSI shlyuzdan tushgani aniq ko'rinadi.
 *
 * HOZIRGI HOLAT (2026-08-17): split ishlamaydi — Click ham,
 * Paynet ham to'liq summani (o'z haqini ushlab qolgandan keyin)
 * LokmaGo hisobiga o'tkazadi. Restoran ulushi har kuni QO'LDA
 * yuboriladi. Shu hisobot AYNAN shuni qulaylashtirish uchun:
 * "kimga qancha qarzmiz" — bir qarashda.
 */

/** Kunning boshi/oxiri (server vaqti — UTC serverlarda bu odatda
    Toshkent bilan mos, chunki server shu hudud uchun ishlaydi). */
function dayRange(dateStr) {
  const d = dateStr ? new Date(dateStr) : new Date();
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
  const end = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
  return { start, end };
}

export const settlementController = {
  /**
   * GET /admin/settlement/daily?date=2026-08-17
   *
   * Restoran bo'yicha: shu kunda tushgan summalar (Click,
   * Paynet alohida), shlyuz haqlari, LokmaGo netto komissiyasi,
   * va restoranga TO'LANISHI KERAK bo'lgan summa — hali
   * to'lanmagan (Payout yozuvi yo'q) qismi alohida ko'rsatiladi.
   */
  daily: asyncHandler(async (req, res) => {
    const { start, end } = dayRange(req.query.date);

    const payments = await Payment.find({
      status: 'SUCCESS',
      paidAt: { $gte: start, $lte: end },
    })
      .select('restaurantId provider amount providerFee restaurantAmount lokmaGrossCommission lokmaNetCommission payoutStatus paidAt orderId')
      .lean();

    if (payments.length === 0) {
      return res.json({ date: start.toISOString().slice(0, 10), restaurants: [], totals: emptyTotals() });
    }

    const restIds = [...new Set(payments.map((p) => String(p.restaurantId)))];
    const restaurants = await Restaurant.find({ _id: { $in: restIds } })
      .select('name phone').lean();
    const restMap = new Map(restaurants.map((r) => [String(r._id), r]));

    // Restoran bo'yicha guruhlash
    const byRest = new Map();
    for (const p of payments) {
      const rid = String(p.restaurantId);
      if (!byRest.has(rid)) {
        byRest.set(rid, {
          restaurantId: rid,
          restaurantName: restMap.get(rid)?.name || 'Noma‘lum',
          click: { count: 0, total: 0, fee: 0 },
          paynet: { count: 0, total: 0, fee: 0 },
          payme: { count: 0, total: 0, fee: 0 },
          lokmaNet: 0,
          owedToRestaurant: 0,      // shu kun uchun jami qarz
          alreadyPaidOut: 0,        // Payout orqali allaqachon yopilgan
          paymentIds: [],
        });
      }
      const row = byRest.get(rid);
      const bucket = row[p.provider] || row.payme;
      bucket.count += 1;
      bucket.total += p.amount;
      bucket.fee += p.providerFee;
      row.lokmaNet += p.lokmaNetCommission;
      row.owedToRestaurant += p.restaurantAmount;
      row.paymentIds.push(String(p._id));
    }

    // Shu to'lovlar allaqachon qaysi Payout'larga kirgan — "to'langan"
    // deb belgilash uchun (bank orqali qo'lda yuborilib, tasdiqlangan)
    const allPaymentIds = payments.map((p) => p._id);
    const payouts = await Payout.find({
      paymentIds: { $in: allPaymentIds },
      status: { $in: ['SUCCESS', 'PROCESSING'] },
    }).select('paymentIds amount status restaurantId').lean();

    const paidPaymentIds = new Set();
    for (const po of payouts) {
      for (const pid of po.paymentIds) paidPaymentIds.add(String(pid));
    }

    const restaurantsOut = [...byRest.values()].map((row) => {
      const unpaidPaymentIds = row.paymentIds.filter((id) => !paidPaymentIds.has(id));
      const paidCount = row.paymentIds.length - unpaidPaymentIds.length;
      // Taxminiy: to'langan ulush proportsional (aniq summa Payout'da saqlanadi)
      const settled = row.paymentIds.length > 0
        ? Math.round((row.owedToRestaurant * paidCount) / row.paymentIds.length)
        : 0;
      return {
        ...row,
        unpaidPaymentIds,
        pendingAmount: row.owedToRestaurant - settled,
        alreadyPaidOut: settled,
        isFullySettled: unpaidPaymentIds.length === 0,
      };
    }).sort((a, b) => b.pendingAmount - a.pendingAmount);

    const totals = restaurantsOut.reduce((acc, r) => {
      acc.click.total += r.click.total; acc.click.fee += r.click.fee;
      acc.paynet.total += r.paynet.total; acc.paynet.fee += r.paynet.fee;
      acc.lokmaNet += r.lokmaNet;
      acc.owedToRestaurant += r.owedToRestaurant;
      acc.pendingAmount += r.pendingAmount;
      return acc;
    }, emptyTotals());

    res.json({ date: start.toISOString().slice(0, 10), restaurants: restaurantsOut, totals });
  }),

  /**
   * POST /admin/settlement/confirm
   * { restaurantId, paymentIds: [...], amount, bankReference? }
   *
   * Admin BANK ORQALI PULNI HAQIQATDA YUBORGANDAN KEYIN shu
   * yerni bosadi — tizim hech qanday pulni o'zi YUBORMAYDI,
   * faqat "yuborildi" deb QAYD ETADI. Shuning uchun frontend
   * tomonda albatta ogohlantirish dialogi bo'lishi kerak.
   */
  confirm: asyncHandler(async (req, res) => {
    const schema = z.object({
      restaurantId: z.string().length(24),
      paymentIds: z.array(z.string().length(24)).min(1),
      amount: z.number().positive(),
      bankReference: z.string().max(100).optional(),
      note: z.string().max(300).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Noto‘g‘ri ma‘lumot' });
    }
    const { restaurantId, paymentIds, amount, bankReference, note } = parsed.data;

    // Shu to'lovlar haqiqatan mavjud va SUCCESS ekanini tekshiramiz
    const found = await Payment.find({
      _id: { $in: paymentIds }, restaurantId, status: 'SUCCESS',
    }).select('_id').lean();
    if (found.length !== paymentIds.length) {
      return res.status(400).json({ error: 'Ba‘zi to‘lovlar topilmadi yoki noto‘g‘ri restoranga tegishli' });
    }

    // Idempotentlik — bir xil to'lovlar to'plami ikki marta
    // tasdiqlanib qo'yilmasin (masalan tugma ikki marta bosilsa)
    const idempotencyKey = crypto
      .createHash('sha256')
      .update([...paymentIds].sort().join(','))
      .digest('hex');

    const existing = await Payout.findOne({ idempotencyKey });
    if (existing) {
      return res.json({ ...existing.toObject(), alreadyExisted: true });
    }

    const payout = await Payout.create({
      restaurantId,
      paymentIds,
      amount,
      status: 'SUCCESS',
      idempotencyKey,
      bankProvider: 'manual',
      bankReference: bankReference || '',
      sentAt: new Date(),
      confirmedAt: new Date(),
      snapshot: { note: note || '', confirmedBy: req.userId || null },
    });

    await Payment.updateMany(
      { _id: { $in: paymentIds } },
      { $set: { payoutStatus: 'SUCCESS' } },
    );

    res.status(201).json(payout);
  }),
};

function emptyTotals() {
  return {
    click: { total: 0, fee: 0 },
    paynet: { total: 0, fee: 0 },
    lokmaNet: 0,
    owedToRestaurant: 0,
    pendingAmount: 0,
  };
}
