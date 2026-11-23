import { resolvePeriod, deliveredWindow } from './billingPeriod.js';
import { Types } from 'mongoose';
import { Ledger } from '../models/Ledger.js';
import { Order } from '../models/Order.js';
import { Restaurant } from '../models/Restaurant.js';
import { Payout } from '../models/Payout.js';
import { getSettings } from '../models/Settings.js';
import { getIO } from '../sockets/io.js';
import { tiyinToSom } from './orderFinance.js';
import { runFinanceTx, isDuplicateKey } from './financeTx.js';

/**
 * Hisob-kitob tizimi.
 *
 * OQIM (Yandex Eda / Wolt / Uzum Tezkor modeli):
 *
 *   1. Mijoz to'laydi          → pul platformada, jurnalga yoziladi
 *   2. Restoran qabul qiladi   → hech nima o'zgarmaydi
 *   3. Buyurtma YETKAZILADI    → restoran ulushi balansga qo'shiladi
 *   4. Admin to'laydi          → balansdan yechiladi
 *
 *   Restoran rad etsa yoki bekor bo'lsa → pul mijozga qaytariladi,
 *   restoranga hech nima hisoblanmaydi.
 *
 * BALANS mantiqi:
 *   musbat  → biz restoranga qarzdormiz (karta to'lovlari)
 *   manfiy  → restoran bizga qarzdor (naqd to'lovlar komissiyasi)
 */

/*
 * ═══════════════════════════════════════════════════════════
 * MOLIYA MODULI — KUNLIK HISOB-KITOB (barcha restoranlar)
 * ═══════════════════════════════════════════════════════════
 *
 * Bu bo'lim ilgari `settlement.js` kontrollerida, `Payment`
 * degan ALOHIDA (va hech kim to'ldirmaydigan) kolleksiyadan
 * o'qirdi — natijada sahifa har doim BO'SH qaytardi. Endi
 * xuddi shu ma'lumot yuqoridagi `Ledger` dan — ya'ni real
 * pul harakati yozilayotgan YAGONA manbadan — hisoblanadi.
 */

/**
 * Kalendar sananing O'zbekiston vaqti bo'yicha boshi/oxiri.
 *
 * NIMA UCHUN QATTIQ +05:00: Intl orqali "qaysi kun" ekanini
 * to'g'ri aniqlash mumkin (restaurantTime.js dagi zoneNow shuni
 * qiladi), lekin TESKARI yo'nalish — "shu kun boshi qaysi UTC
 * onga to'g'ri keladi" — IANA zonalarida DST bo'lsa qiyin
 * hisoblanadi. O'zbekiston 2016-yildan beri qishki vaqtga
 * o'tmaydi va doim UTC+5 da turadi, shuning uchun qattiq
 * offset xavfsiz va aniq — server qaysi mintaqada ishlashidan
 * qat'i nazar. Server vaqtiga (`new Date().getHours()`) ISHONISH
 * xato edi (TZ 25-band) — bu yerda serverning O'ZI umuman
 * ishlatilmaydi.
 */
function uzDayRange(dateStr) {
  const base = dateStr || new Date().toISOString().slice(0, 10); // 'YYYY-MM-DD'
  const start = new Date(`${base}T00:00:00.000+05:00`);
  const end = new Date(`${base}T23:59:59.999+05:00`);
  return { start, end, dateStr: base };
}

/**
 * Bitta restoran uchun bitta kunlik hisobot — Click/Paynet/Naqd
 * alohida, TZ 9-band formulasi bo'yicha.
 *
 * MUHIM: bu FAQAT ko'rsatish (reporting) uchun. Haqiqiy
 * "restoranga qancha to'lash kerak" — restaurant.balance (u
 * kun bilan cheklanmagan, umumiy holat). Ikkalasi ataylab
 * mos: netPayable shu kunning o'zgarishi emas, UMUMIY balans.
 */
export async function getRestaurantDailyBreakdown(restaurantId, dateStr) {
  const { start, end } = uzDayRange(dateStr);

  const rows = await Ledger.aggregate([
    {
      $match: {
        restaurantId: new Types.ObjectId(String(restaurantId)),
        createdAt: { $gte: start, $lte: end },
        type: { $in: ['payment_in', 'commission', 'restaurant_due', 'bonus_compensation'] },
      },
    },
    {
      $group: {
        _id: { type: '$type', provider: '$provider', isCash: '$isCash' },
        total: { $sum: '$amount' },
        count: { $sum: 1 },
      },
    },
  ]);

  const bucket = (name) => ({ count: 0, total: 0 });
  const out = {
    click: bucket(), paynet: bucket(), payme: bucket(), uzum: bucket(), cash: bucket(),
    platformCommission: 0,
    electronicCommission: 0,
    cashCommissionDue: 0,
    restaurantShare: 0, // elektron to'lovdan restoranga tegishli sof summa
    bonusCompensation: 0, // LokmaGo sovg'a-bonusi uchun restoranga qoplangan summa
    ordersCount: 0,
  };

  for (const r of rows) {
    const { type, provider, isCash } = r._id;
    if (type === 'payment_in') {
      const key = isCash ? 'cash' : (provider || 'click');
      if (out[key]) { out[key].total += r.total; out[key].count += r.count; }
      out.ordersCount += r.count;
    } else if (type === 'commission') {
      out.platformCommission += r.total;
      if (isCash) out.cashCommissionDue += r.total;
      else out.electronicCommission += r.total;
    } else if (type === 'restaurant_due' && !isCash) {
      // Faqat elektron buyurtmalarning restoranga tegishli qismi.
      // Naqd uchun restaurant_due — komissiya QARZI (manfiy), u
      // "restoranga tegishli elektron tushum" emas.
      out.restaurantShare += r.total;
    } else if (type === 'bonus_compensation') {
      out.bonusCompensation += r.total;
    }
  }

  const grossSales = out.click.total + out.paynet.total + out.payme.total
    + out.uzum.total + out.cash.total;

  return {
    restaurantId: String(restaurantId),
    date: uzDayRange(dateStr).dateStr,
    ordersCount: out.ordersCount,
    click: out.click,
    paynet: out.paynet,
    cash: out.cash,
    grossSales,
    platformCommission: out.platformCommission,
    cashCommissionDue: out.cashCommissionDue,
    restaurantShare: out.restaurantShare,
    bonusCompensation: out.bonusCompensation,
  };
}

/**
 * Admin "Moliya → Kunlik hisob-kitob" sahifasi uchun — BARCHA
 * faol restoranlar, bitta kun, bitta so'rovda (N+1 muammosi
 * bo'lmasin).
 *
 * `netPayable` — restoranning HOZIRGI umumiy balansi
 * (getRestaurantPendingPayout bilan bir xil manba). Bu shu
 * kunning emas, umumiy holat — chunki to'lov aynan shu summaga
 * qarab chiqariladi (eski qarz + bugungi o'zgarish − oldingi
 * to'lovlar allaqachon balansda hisobga olingan).
 */
export async function getDailySettlementAllRestaurants(dateStr) {
  const { start, end, dateStr: normalizedDate } = uzDayRange(dateStr);

  const rows = await Ledger.aggregate([
    {
      $match: {
        createdAt: { $gte: start, $lte: end },
        type: { $in: ['payment_in', 'commission', 'restaurant_due', 'bonus_compensation'] },
        restaurantId: { $ne: null },
      },
    },
    {
      $group: {
        _id: {
          restaurantId: '$restaurantId',
          type: '$type',
          provider: '$provider',
          isCash: '$isCash',
        },
        total: { $sum: '$amount' },
        count: { $sum: 1 },
      },
    },
  ]);

  const byRestaurant = new Map();
  const ensure = (id) => {
    if (!byRestaurant.has(id)) {
      byRestaurant.set(id, {
        click: { count: 0, total: 0 },
        paynet: { count: 0, total: 0 },
        cash: { count: 0, total: 0 },
        platformCommission: 0,
        cashCommissionDue: 0,
        restaurantShare: 0,
        bonusCompensation: 0,
        ordersCount: 0,
      });
    }
    return byRestaurant.get(id);
  };

  for (const r of rows) {
    const { restaurantId, type, provider, isCash } = r._id;
    const row = ensure(String(restaurantId));
    if (type === 'payment_in') {
      const key = isCash ? 'cash' : (provider === 'paynet' ? 'paynet' : 'click');
      row[key].total += r.total;
      row[key].count += r.count;
      row.ordersCount += r.count;
    } else if (type === 'commission') {
      row.platformCommission += r.total;
      if (isCash) row.cashCommissionDue += r.total;
    } else if (type === 'restaurant_due' && !isCash) {
      row.restaurantShare += r.total;
    } else if (type === 'bonus_compensation') {
      row.bonusCompensation += r.total;
    }
  }

  const restIds = [...byRestaurant.keys()];
  const restaurants = await Restaurant.find({ _id: { $in: restIds } })
    .select('name balance commissionPercent commissionMode').lean();

  /*
   * ═══ IKKI KOMISSIYA TIZIMI O'RTASIDAGI MOSLIK TEKSHIRUVI ═══
   *
   * Kod bazasida IKKI xil komissiya manbasi bor:
   *   • Restaurant.commissionPercent — shu hisobot va
   *     Restaurant.balance shundan hisoblanadi (naqdni ham
   *     to'g'ri qamrab oladi)
   *   • CommissionAgreement — Click/Paynet webhook orqali
   *     Payment hujjatiga yoziladigan "gateway split" foizi
   *     (faqat karta to'lovlari uchun, naqdni bilmaydi)
   *
   * Ikkalasi HAR DOIM bir xil bo'lishi kerak edi, lekin kodda
   * ularni avtomatik sinxronlashtiruvchi hech narsa yo'q — biri
   * admin panelda o'zgartirilsa, ikkinchisi ESKI qolib ketishi
   * mumkin. Bu yerda ularni QIYOSLAYMIZ va farq bo'lsa admin
   * ko'rishi uchun `commissionMismatch` bayrog'ini qo'shamiz.
   *
   * Bu — ikkala tizimni "kim g'olib" deb hal qilishning
   * o'rniga, farqni KO'RINADIGAN qilish orqali xavfsizroq yechim:
   * noto'g'ri taxmin bilan ikkalasini birlashtirib, aslida
   * to'g'ri ishlayotgan narsani buzib qo'yishdan ko'ra.
   */
  const { activeAgreement } = await import('../models/CommissionAgreement.js');
  const agreementChecks = await Promise.all(
    restaurants.map(async (r) => {
      const agreement = await activeAgreement(r._id);
      if (!agreement) return [String(r._id), null];
      const ledgerPercent = r.commissionPercent ?? null;
      const agreementPercent = agreement.restaurantCommissionPercent;
      const mismatch = ledgerPercent != null
        && Math.abs(ledgerPercent - agreementPercent) > 0.01;
      return [String(r._id), { agreementPercent, mismatch }];
    }),
  );
  const agreementMap = new Map(agreementChecks);

  const result = restaurants.map((r) => {
    const row = byRestaurant.get(String(r._id));
    const agreementInfo = agreementMap.get(String(r._id));
    return {
      restaurantId: String(r._id),
      restaurantName: r.name,
      click: row.click,
      paynet: row.paynet,
      cash: row.cash,
      grossSales: row.click.total + row.paynet.total + row.cash.total,
      ordersCount: row.ordersCount,
      platformCommission: row.platformCommission,
      cashCommissionDue: row.cashCommissionDue,
      restaurantShare: row.restaurantShare,
      bonusCompensation: row.bonusCompensation,
      // Shu kunning o'zgarishi emas — restoranning HOZIRGI umumiy
      // balansi (yuqoridagi izohga qarang)
      netPayable: Math.max(0, r.balance || 0),
      currentBalance: r.balance || 0,
      // Ikki komissiya tizimi orasidagi farq — yuqoridagi izohga qarang
      commissionMismatch: agreementInfo?.mismatch || false,
      agreementCommissionPercent: agreementInfo?.agreementPercent ?? null,
    };
  }).sort((a, b) => b.netPayable - a.netPayable);

  const totals = result.reduce((acc, r) => {
    acc.click.total += r.click.total;
    acc.paynet.total += r.paynet.total;
    acc.cash.total += r.cash.total;
    acc.platformCommission += r.platformCommission;
    acc.cashCommissionDue += r.cashCommissionDue;
    acc.netPayable += r.netPayable;
    return acc;
  }, {
    click: { total: 0 }, paynet: { total: 0 }, cash: { total: 0 },
    platformCommission: 0, cashCommissionDue: 0, netPayable: 0,
  });

  return { date: normalizedDate, restaurants: result, totals };
}

/** Restoran uchun komissiya sozlamalari. */
export async function resolveCommission(restaurant) {
  const settings = await getSettings();

  // Restoranda o'z qiymati bo'lsa u ustun. 0 ham to'g'ri qiymat —
  // ba'zi restoranlardan komissiya olinmaydi.
  const percent = restaurant.commissionPercent != null
    ? restaurant.commissionPercent
    : (settings.commissionPercent || 0);

  const mode = restaurant.commissionMode
    || (settings.commissionMode !== 'none' ? settings.commissionMode : 'deduct');

  return { percent, mode };
}

/**
 * Komissiyani hisoblaydi.
 * Faqat TAOMLAR summasidan olinadi — yetkazish va xizmat haqi
 * platformaga tegishli.
 */
export function calcCommission(subtotal, percent, mode) {
  const p = Number(percent) || 0;
  if (p <= 0) {
    return { commission: 0, restaurantShare: subtotal, customerExtra: 0 };
  }

  if (mode === 'markup') {
    // Mijoz qo'shimcha to'laydi, restoran to'liq oladi
    const extra = Math.round(subtotal * p / 100);
    return { commission: extra, restaurantShare: subtotal, customerExtra: extra };
  }

  // deduct — restoran ulushidan yechiladi
  const commission = Math.round(subtotal * p / 100);
  return { commission, restaurantShare: subtotal - commission, customerExtra: 0 };
}

/**
 * 1-QADAM: mijoz to'ladi.
 * Faqat jurnalga yoziladi — balans HALI o'zgarmaydi.
 * Restoran buyurtmani bajarmagunicha pul "yo'lda" hisoblanadi.
 */
export async function recordPayment(order, provider, transactionId = null) {
  // Tezkor yo'l: allaqachon yozilgan bo'lsa (eski yozuvlarda postingKey yo'q — shu tekshiruv ularni ham qamraydi)
  const exists = await Ledger.findOne({ orderId: order._id, type: 'payment_in' });
  if (exists) return null;

  /*
   * Haqiqiy himoya — unique postingKey (audit F-19): ikki webhook/yo'l bir vaqtda kelsa ham IKKINCHI yozuv
   * baza tomonidan rad etiladi ("findOne → create" poygasiga ishonilmaydi).
   */
  try {
    await Ledger.create({
      type: 'payment_in',
      amount: order.total,
      orderId: order._id,
      restaurantId: order.restaurantId,
      userId: order.userId,
      provider,
      isCash: provider === 'cash',
      transactionId,
      postingKey: `payment_in:${order._id}`,
      meta: { orderTotal: order.total, note: 'To‘lov qabul qilindi' },
    });
  } catch (e) {
    if (isDuplicateKey(e)) return null;
    throw e;
  }

  getIO()?.to('admin').emit('billing:update', { orderId: String(order._id) });
  return { recorded: order.total };
}

/**
 * 2-QADAM: buyurtma YETKAZILDI — restoran ulushi hisoblanadi.
 *
 * Aynan shu paytda pul restoran balansiga qo'shiladi. Avval emas —
 * chunki buyurtma bekor bo'lishi mumkin.
 *
 * Naqd to'lovda: pul restoranda qolgan, shuning uchun komissiya
 * miqdorida restoran BIZGA qarzdor bo'ladi (balans manfiyga ketadi).
 */
/**
 * NAQD BUYURTMA YAKUNLANDI → AVTOMATIK "TO'LANGAN".
 *
 * Avval restoran/xodim "To'lov qabul qilindi" tugmasini QO'LDA bosishi kerak edi.
 * Unutilsa buyurtma "to'lanmagan" bo'lib qolardi va naqd to'lov moliya jurnaliga
 * (payment_in) tushmasdi. Endi buyurtma yakunlanishi (taom topshirildi / yetkazildi —
 * qaysi yo'l bilan bo'lmasin) naqd to'lovni ham yopadi: tugma KERAK EMAS.
 *
 * Panel tugmasi (restaurantPanel.markPaid) bilan AYNAN bir xil natija:
 *   isPaid + paidAt, va jurnalga payment_in (recordPayment o'zi takroriy yozuvdan himoyalangan).
 * Faqat naqd VA yakunlangan buyurtma: karta to'lovi o'z vaqtida (oldindan) qayd etilgan,
 * yakunlanmagan buyurtmaga hech narsa yozilmaydi. Takroriy chaqiruv xavfsiz.
 *
 * settleOrder boshida chaqiriladi — u BARCHA yakunlash yo'llarida (panel, bot, kuryer,
 * mijoz "Oldim", avto-yakunlash) ishlaydi, shuning uchun yo'llarni alohida yamash kerak emas.
 */
export async function finalizeCashPayment(orderId) {
  const order = await Order.findById(orderId);
  if (!order || order.paymentMethod !== 'cash' || order.status !== 'delivered') return null;

  let patch = null;
  if (!order.isPaid) {
    const paidAt = order.deliveredAt || new Date();
    // Atomik: ikki yo'l bir vaqtda yakunlasa ham bir marta
    const updated = await Order.findOneAndUpdate(
      { _id: order._id, isPaid: { $ne: true } },
      { isPaid: true, paidAt },
      { new: true },
    );
    if (updated) patch = { _id: String(updated._id), isPaid: true, paidAt: updated.paidAt };
  }

  // Jurnal: panel tugmasidagi bilan bir xil (idempotent)
  await recordPayment(order, 'cash').catch((e) => console.error('[billing] recordPayment (naqd, avto):', e.message));

  // Panel/admin ro'yxati darhol "To'langan" ko'rsin (kuryer yo'li status hodisasini minimal yuboradi)
  if (patch) {
    const io = getIO();
    io?.to(`restaurant:${order.restaurantId}`).emit('order:update', patch);
    io?.to('admin').emit('order:update', patch);
  }
  return { changed: Boolean(patch) };
}

export async function settleOrder(orderId) {
  const exists = await Order.exists({ _id: orderId });
  if (!exists) return null;

  // Naqd buyurtma — yakunlangan bo'lsa avtomatik "to'langan" (komissiya hisobidan MUSTAQIL)
  await finalizeCashPayment(orderId).catch((e) => console.error('[billing] finalizeCashPayment:', e.message));

  /*
   * LokmaGo kuryeri balansi — restoran hisobidan MUSTAQIL (o'z takror-himoyasi bor: lokmaCourier.settledAt + postingKey).
   * "Yetkazildi"ning BARCHA yo'llari (kuryer, mijoz "Oldim", avtomatik yakunlash) shu funksiyadan o'tadi.
   */
  const head = await Order.findById(orderId).select('courierParty').lean();
  if (head?.courierParty === 'lokma') {
    const { settleCourier } = await import('./courierPool.js');
    await settleCourier(orderId).catch((e) => console.error('[billing] settleCourier:', e.message));
  }

  const result = await runFinanceTx((session) => settleOrderCore(orderId, session));
  if (!result) return null;

  // ═══ Yon ta'sirlar — FAQAT muvaffaqiyatli hisob-kitobdan keyin, tranzaksiyadan TASHQARIDA ═══
  if (result.userId) {
    const { grantBonus } = await import('./promotions.js');
    grantBonus(result.userId, result.restaurantId, result.orderTotal)
      .catch((e) => console.error('[bonus]', e.message));
  }
  getIO()?.to('admin').emit('billing:update', {
    restaurantId: String(result.restaurantId),
    balance: result.balance,
  });

  const { commission, restaurantShare, percent, mode, isCash, bonusCompensation } = result;
  return { commission, restaurantShare, percent, mode, isCash, bonusCompensation };
}

/*
 * ═══ HISOB-KITOB YADROSI — bitta moliyaviy birlik (audit F-01, F-02, F-03) ═══
 *
 * ILGARI: `findOne(restaurant_due)` → yozuvlar → `restaurant.balance = eski + ulush; save()`.
 *   • ikki "yetkazildi" yo'li bir vaqtda kelsa — ikkalasi ham tekshiruvdan o'tib, komissiya va ulush IKKI marta yozilardi;
 *   • save() ESKI balans ustidan yozardi — shu oraliqda bajarilgan payout ($inc −X) o'chib ketardi va X qayta
 *     to'lanishi mumkin edi; bir restoranning ikki buyurtmasi bir vaqtda yakunlansa bitta ulush yo'qolardi.
 *
 * ENDI:
 *   1) Order.financeSettlement ATOMIK claim (findOneAndUpdate, state yo'q bo'lsa) — faqat BITTA so'rov o'tadi;
 *   2) har bir yozuv deterministik postingKey bilan (unique indeks — ikkinchi yozuv baza darajasida rad etiladi);
 *   3) balans faqat `$inc` (o'qib-qayta-yozish yo'q);
 *   4) replica set'da 1–3 bitta tranzaksiyada (hammasi yoki hech biri), standalone'da ketma-ket.
 * Hisob formulasi va yozuvlar tarkibi O'ZGARMAGAN.
 */
async function settleOrderCore(orderId, session) {
  const opts = session ? { session } : {};
  const txMode = session ? 'tx' : 'no-tx';

  // 1) CLAIM
  const order = await Order.findOneAndUpdate(
    { _id: orderId, 'financeSettlement.state': { $exists: false } },
    { $set: { 'financeSettlement.state': 'SETTLING', 'financeSettlement.claimedAt': new Date(), 'financeSettlement.mode': txMode } },
    { new: true, ...opts },
  );
  if (!order) return null;   // boshqa so'rov allaqachon olgan yoki hisob-kitob qilingan

  // Shu o'zgarishdan OLDIN hisob-kitob qilingan buyurtma (financeSettlement yo'q, lekin yozuv bor) — qayta yozilmaydi
  const already = await Ledger.findOne({ orderId: order._id, type: 'restaurant_due' }, null, opts).lean();
  if (already) {
    await Order.updateOne({ _id: order._id }, {
      $set: { 'financeSettlement.state': 'SETTLED', 'financeSettlement.settledAt': new Date(), 'financeSettlement.mode': 'legacy-ledger' },
    }, opts);
    return null;
  }

  const restaurant = await Restaurant.findById(order.restaurantId, null, opts).select('_id balance').lean();
  if (!restaurant) {
    // Claim qaytariladi — restoran tiklansa qayta urinish mumkin bo'lsin
    await Order.updateOne({ _id: order._id }, { $unset: { financeSettlement: 1 } }, opts);
    console.error(`[billing] Restoran topilmadi: ${order.restaurantId}`);
    return null;
  }

  /*
   * ═══ KOMISSIYA MANBAI ═══ (o'zgarmagan)
   * YANGI buyurtmalarda hisob `order.finance` snapshot'idan o'qiladi (CommissionAgreement asosida muzlatilgan).
   * ESKI buyurtmalarda (snapshot yo'q) avvalgi mantiq saqlanadi, `financeModel: 'legacy'` bilan belgilanadi.
   */
  const fin = order.finance && order.finance.model === 'v2' ? order.finance : null;

  let commission;
  let restaurantShare;
  let percent;
  let mode;
  let meta;

  if (fin) {
    commission = tiyinToSom(fin.lokmaGrossCommission);
    restaurantShare = tiyinToSom(fin.restaurantPayout);
    percent = fin.restaurantCommissionPercent + fin.customerFeePercent;
    mode = 'agreement';
    meta = {
      orderTotal: order.total,
      commissionPercent: percent,
      commissionMode: mode,
      financeModel: 'v2',
      foodSubtotal: tiyinToSom(fin.foodSubtotal),
      customerFeeAmount: tiyinToSom(fin.customerFeeAmount),
      restaurantCommissionAmount: tiyinToSom(fin.restaurantCommissionAmount),
      lokmaNetCommission: tiyinToSom(fin.lokmaNetCommission),
      clickFoodFeeAmount: tiyinToSom(fin.clickFoodFeeAmount),
      commissionAgreementId: fin.commissionAgreementId || null,
    };
  } else {
    const restDoc = await Restaurant.findById(order.restaurantId, null, opts).select('commissionPercent commissionMode').lean();
    const resolved = await resolveCommission(restDoc || {});
    percent = resolved.percent;
    mode = resolved.mode;
    ({ commission, restaurantShare } = calcCommission(order.subtotal, percent, mode));
    meta = {
      orderTotal: order.total,
      commissionPercent: percent,
      commissionMode: mode,
      financeModel: 'legacy',
    };
  }

  /*
   * RESTORAN naqdni o'zi oldimi. LokmaGo kuryeri yetkazgan naqd buyurtmada pulni KURYER olgan, restoranga taom
   * ulushini LokmaGo to'laydi — restoran uchun bu KARTA buyurtmasidek (ulush +, komissiya qarzi emas).
   */
  const isCash = order.paymentMethod === 'cash' && order.courierParty !== 'lokma';
  const ledgerProvider = order.paymentMethod || null;
  const key = (suffix) => `settle:${order._id}:${suffix}`;

  const entries = [];
  let balanceDelta = 0;

  if (commission > 0) {
    entries.push({
      type: 'commission', amount: commission, orderId: order._id, restaurantId: restaurant._id,
      provider: ledgerProvider, isCash, postingKey: key('commission'),
      meta: { ...meta, note: `${percent}% · ${mode}${isCash ? ' · naqd' : ''}` },
    });
  }

  if (isCash) {
    // NAQD: pul restoranda qoldi. Bizga faqat komissiya qarz (balans manfiyga ketadi).
    entries.push({
      type: 'restaurant_due', amount: commission > 0 ? -commission : 0, orderId: order._id, restaurantId: restaurant._id,
      provider: ledgerProvider, isCash, postingKey: key('restaurant_due'),
      meta: { ...meta, note: commission > 0 ? 'Naqd to‘lov — komissiya qarzi' : 'Naqd to‘lov — komissiyasiz' },
    });
    if (commission > 0) balanceDelta -= commission;
  } else {
    // KARTA: pul bizda. Restoran ulushi balansga qo'shiladi.
    entries.push({
      type: 'restaurant_due', amount: restaurantShare, orderId: order._id, restaurantId: restaurant._id,
      provider: ledgerProvider, isCash, postingKey: key('restaurant_due'), meta,
    });
    balanceDelta += restaurantShare;
  }

  /*
   * ═══ LOKMAGO SOVG'A-BONUSI QOPLASH ═══ (o'zgarmagan) — restoran bergan bepul sovg'a puli LokmaGo hisobidan.
   * Summa buyurtma yaratilgan paytda MUZLATILGAN.
   */
  const bonusCompensation = (order.bonusItems || []).reduce(
    (s, g) => s + (Number(g.reimburse) || 0) * (Number(g.quantity) || 0), 0);
  if (bonusCompensation > 0) {
    entries.push({
      type: 'bonus_compensation', amount: bonusCompensation, orderId: order._id, restaurantId: restaurant._id,
      provider: ledgerProvider, isCash, postingKey: key('bonus_compensation'),
      meta: {
        note: `LokmaGo sovg‘a-bonusi: ${order.bonusItems.map((g) => `${g.quantity}× ${g.itemName}`).join(', ')}`,
        gifts: order.bonusItems.map((g) => ({
          ruleId: g.ruleId || null, itemName: g.itemName, quantity: g.quantity,
          reimburse: g.reimburse, amount: (g.reimburse || 0) * (g.quantity || 0),
        })),
      },
    });
    balanceDelta += bonusCompensation;
  }

  // 2) YOZUVLAR (unique postingKey)
  await Ledger.insertMany(entries, { ordered: true, ...opts });

  // 3) BALANS — faqat atomik $inc
  const updated = await Restaurant.findOneAndUpdate(
    { _id: restaurant._id },
    { $inc: { balance: balanceDelta, totalOrders: 1 } },
    { new: true, projection: { balance: 1 }, ...opts },
  ).lean();

  // 4) YAKUN
  await Order.updateOne({ _id: order._id }, {
    $set: { 'financeSettlement.state': 'SETTLED', 'financeSettlement.settledAt': new Date() },
  }, opts);

  return {
    commission, restaurantShare, percent, mode, isCash, bonusCompensation,
    balance: updated?.balance, restaurantId: restaurant._id,
    userId: order.userId || null, orderTotal: order.total,
  };
}

/**
 * Pul qaytarish — buyurtma bekor qilinganda yoki restoran rad etganda.
 * Asl yozuvlar o'chirilmaydi, teskari yozuv qo'shiladi.
 */
export async function recordRefund(order, provider, transactionId = null, options = {}) {
  /*
   * ═══ SNAPSHOT ASOSIDA QAYTARISH ═══ (mantiq o'zgarmagan)
   * `Order.finance` HECH QACHON o'zgartirilmaydi — qaytarish ALOHIDA teskari yozuv bo'lib tushadi.
   * Eski (snapshot'siz) buyurtmalarda avvalgi mantiq: to'liq summa bir marta qaytariladi.
   *
   * ═══ BIR VAQTDAGI QAYTARISHLAR (audit F-10) ═══
   * ILGARI: avvalgi qaytarishlar `find` bilan o'qilib, keyin `create` qilinardi — ikki so'rov bir vaqtda kelsa
   * ikkalasi ham "qolgan" summani ko'rib, jami asldan OSHIB qaytarilishi mumkin edi.
   * ENDI: Order.financeRefund.seq bo'yicha CAS rezerv (findOneAndUpdate, filtrda joriy seq). Faqat bitta so'rov
   * rezervni oladi; qolgani yangilangan holatni qayta o'qib hisoblaydi (qolgan 0 bo'lsa — hech narsa yozilmaydi).
   * Yozuvlar unique postingKey bilan; replica set'da rezerv + yozuvlar + balans bitta tranzaksiyada.
   *
   * @param options.foodBaseRefundTiyin  qisman qaytarish summasi
   * @param options.refundDelivery       yetkazish ham qaytarilsinmi
   */
  let res = REFUND_RETRY;
  for (let attempt = 0; attempt < 8 && res === REFUND_RETRY; attempt += 1) {
    res = await runFinanceTx((session) => recordRefundCore(order._id, provider, transactionId, options, session));
  }
  if (res === REFUND_RETRY) {
    console.error(`[billing] refund: ${order._id} — rezerv 8 urinishda olinmadi (juda ko'p parallel so'rov)`);
    return null;
  }
  if (!res) return null;

  getIO()?.to('admin').emit('billing:update', { restaurantId: String(res.restaurantId) });
  return res.out;
}

const REFUND_RETRY = Symbol('refund-retry');

async function recordRefundCore(orderId, provider, transactionId, options, session) {
  const opts = session ? { session } : {};
  const order = await Order.findById(orderId, null, opts).lean();
  if (!order) return null;

  const fin = order.finance && order.finance.model === 'v2' ? order.finance : null;
  const state = Number.isFinite(order.financeRefund?.seq) ? order.financeRefund : null;
  const casFilter = state
    ? { _id: order._id, 'financeRefund.seq': state.seq }
    : { _id: order._id, 'financeRefund.seq': { $exists: false } };

  // Shu o'zgarishdan OLDIN yozilgan qaytarishlar (financeRefund yo'q) — jurnaldan
  let prior = [];
  if (!state) {
    prior = await Ledger.find({ orderId: order._id, type: 'refund' }, null, opts).select('meta amount').lean();
  }

  // ═══ ESKI (snapshot'siz) buyurtma — to'liq, bir marta ═══
  if (!fin) {
    if (state?.legacyFull || prior.length) return null;
    const reserved = await Order.findOneAndUpdate(casFilter, {
      $set: { financeRefund: { seq: 1, legacyFull: true, totalSom: order.total } },
    }, opts);
    if (!reserved) return REFUND_RETRY;
    return recordLegacyRefundCore(order, provider, transactionId, opts);
  }

  const alreadyFood = state ? Number(state.foodBaseTiyin) || 0
    : prior.reduce((sum, l) => sum + (Number(l.meta?.refundedFoodBaseTiyin) || 0), 0);
  const deliveryAlready = state ? Boolean(state.deliveryRefunded)
    : prior.some((l) => l.meta?.deliveryRefunded === true);
  const totalBefore = state ? Number(state.totalSom) || 0
    : prior.reduce((sum, l) => sum + Math.abs(Number(l.amount) || 0), 0);
  const seq = state ? state.seq : 0;

  const { computeRefund, validateRefund } = await import('./refund.js');

  let calc;
  try {
    calc = computeRefund(fin, {
      foodBaseRefundTiyin: options.foodBaseRefundTiyin ?? null,
      refundDelivery: options.refundDelivery ?? null,
      alreadyRefundedFoodBaseTiyin: alreadyFood,
      deliveryAlreadyRefunded: deliveryAlready,
    });
  } catch (e) {
    console.error('[billing] refund hisobi:', e.message);
    return null;
  }

  const { refund, isFull, remaining } = calc;
  if (refund.totalCharged <= 0) return null;   // qaytariladigan narsa yo'q

  const check = validateRefund(fin, refund);
  if (!check.ok) {
    console.error('[billing] refund tekshiruvi:', check.problems.join('; '));
    return null;
  }

  const refundSom = tiyinToSom(refund.totalCharged);
  const nextSeq = seq + 1;

  // REZERV (CAS) — faqat bitta so'rov o'tadi
  const reserved = await Order.findOneAndUpdate(casFilter, {
    $set: {
      financeRefund: {
        seq: nextSeq,
        foodBaseTiyin: alreadyFood + refund.foodBase,
        deliveryRefunded: deliveryAlready || Boolean(calc.deliveryRefunded),
        totalSom: totalBefore + refundSom,
      },
    },
  }, opts);
  if (!reserved) return REFUND_RETRY;

  const key = (suffix) => `refund:${order._id}:${nextSeq}:${suffix}`;
  const entries = [{
    type: 'refund',
    amount: -refundSom,
    orderId: order._id,
    restaurantId: order.restaurantId,
    userId: order.userId,
    provider,
    transactionId,
    postingKey: key('refund'),
    meta: {
      orderTotal: order.total,
      financeModel: 'v2',
      note: isFull ? 'To‘liq qaytarildi' : 'Qisman qaytarildi',
      foodSubtotal: tiyinToSom(refund.foodSubtotal),
      customerFeeAmount: tiyinToSom(refund.customerFeeAmount),
      restaurantCommissionAmount: tiyinToSom(refund.restaurantCommissionAmount),
      lokmaNetCommission: tiyinToSom(refund.lokmaNetCommission),
      clickFoodFeeAmount: tiyinToSom(refund.clickFoodFeeAmount),
      // Keyingi qisman qaytarishlar shu asosda hisoblanadi
      refundedFoodBaseTiyin: refund.foodBase,
      remainingFoodBaseTiyin: remaining.foodBase,
      deliveryRefunded: calc.deliveryRefunded,
    },
  }];

  /*
   * Restoran qarzi teskari yoziladi — FAQAT qaytarilgan qism bo'yicha. Asl `restaurant_due` o'zgartirilmaydi.
   * RESTORAN naqdni o'zi olganmi — settleOrder bilan AYNAN bir xil ta'rif (audit F-22).
   */
  const settled = await Ledger.findOne({ orderId: order._id, type: 'restaurant_due' }, null, opts).lean();
  const isCash = order.paymentMethod === 'cash' && order.courierParty !== 'lokma';
  let reverseSom = 0;
  if (settled) {
    // Naqdda biz faqat komissiyani qarz qilgandik — u bekor qilinadi. Kartada restoran ulushi qaytariladi.
    reverseSom = isCash
      ? tiyinToSom(refund.lokmaGrossCommission)
      : -tiyinToSom(refund.restaurantPayout);
    if (reverseSom !== 0) {
      entries.push({
        type: 'restaurant_due', amount: reverseSom, orderId: order._id, restaurantId: order.restaurantId,
        provider: order.paymentMethod || null, isCash, postingKey: key('restaurant_due'),
        meta: { financeModel: 'v2', note: isFull ? 'Qaytarish — bekor qilindi' : 'Qisman qaytarish' },
      });
    }
  }

  /*
   * Komissiya teskari — FAQAT hisob-kitob bo'lgan buyurtmada (audit F-05): yetkazishdan OLDIN bekor qilingan
   * karta buyurtmasida komissiya hali yozilmagan, musbatsiz manfiy yozuv hisobotni buzardi.
   */
  if (settled && refund.lokmaGrossCommission > 0) {
    entries.push({
      type: 'commission', amount: -tiyinToSom(refund.lokmaGrossCommission), orderId: order._id,
      restaurantId: order.restaurantId, provider: order.paymentMethod || null, isCash, postingKey: key('commission'),
      meta: { financeModel: 'v2', note: 'Qaytarish — komissiya bekor qilindi' },
    });
  }

  await Ledger.insertMany(entries, { ordered: true, ...opts });
  if (reverseSom !== 0) {
    await Restaurant.updateOne({ _id: order.restaurantId }, { $inc: { balance: reverseSom } }, opts);
  }

  return {
    restaurantId: order.restaurantId,
    out: { refunded: refundSom, isFull, remainingFoodBaseTiyin: remaining.foodBase, refundFinance: refund },
  };
}

/**
 * Eski (snapshot'siz) buyurtmalar uchun qaytarish — avvalgi xatti-harakat (to'liq summa).
 * Rezerv chaqiruvchida olingan; balans endi `$inc` bilan (audit F-01: save() eski balans ustidan yozardi).
 */
async function recordLegacyRefundCore(order, provider, transactionId, opts) {
  const key = (suffix) => `refund:${order._id}:1:${suffix}`;
  const entries = [{
    type: 'refund', amount: -order.total, orderId: order._id, restaurantId: order.restaurantId, userId: order.userId,
    provider, transactionId, postingKey: key('refund'),
    meta: { orderTotal: order.total, financeModel: 'legacy', note: 'Mijozga qaytarildi' },
  }];
  const settled = await Ledger.findOne({ orderId: order._id, type: 'restaurant_due' }, null, opts).lean();
  const reverse = settled && settled.amount !== 0 ? -settled.amount : 0;
  if (reverse !== 0) {
    entries.push({
      type: 'restaurant_due', amount: reverse, orderId: order._id, restaurantId: order.restaurantId,
      postingKey: key('restaurant_due'), meta: { financeModel: 'legacy', note: 'Qaytarish sababli bekor qilindi' },
    });
  }
  await Ledger.insertMany(entries, { ordered: true, ...opts });
  if (reverse !== 0) {
    await Restaurant.updateOne({ _id: order.restaurantId }, { $inc: { balance: reverse } }, opts);
  }
  return { restaurantId: order.restaurantId, out: { refunded: order.total, isFull: true } };
}

/*
 * Restoranga pul o'tkazildi — admin qo'lda belgilaydi.
 *
 * ═══ TZ 17-BAND: BIR VAQTDA IKKI SO'ROV MUAMMOSI ═══
 *
 * ILGARI: `Restaurant.findById()` bilan balans o'qilardi, tekshirilardi,
 * keyin ALOHIDA `restaurant.save()` bilan yozilardi. Ikki so'rov
 * orasida boshqa so'rov ham xuddi shu balansni o'qib ulgursa —
 * IKKALASI HAM "balans yetarli" deb topib, ikkalasi ham to'lovni
 * amalga oshirardi. Buxgalter ikki marta tugmani bosgan yoki
 * ikkita SEKINDA bir vaqtda ishlagan bo'lsa — pul ikki marta
 * "to'langan" deb yozilib qolardi.
 *
 * ENDI: bitta ATOMIK `findOneAndUpdate`. Filtrda `balance: { $gte: amount }`
 * bor — MongoDB bitta hujjat ustidagi yozishlarni navbat bilan
 * bajaradi, shuning uchun ikkinchi so'rov birinchisi allaqachon
 * kamaytirgan balansga qarab tekshiriladi. Yetarli bo'lmasa
 * natija `null` bo'ladi va xato qaytariladi — HECH QANDAY
 * qo'shimcha qulf yoki tranzaksiya kerak emas.
 *
 * ═══ TZ 12-13-BAND: PAYOUT HUJJATI + REKVIZIT SNAPSHOT ═══
 *
 * ILGARI bu funksiya faqat Ledger yozuvi qo'shardi — "qaysi
 * kartaga, kim tomonidan" degan alohida tarix yo'q edi. Endi
 * har bir to'lov uchun `Payout` hujjati yaratiladi va restoran
 * REKVIZITINING O'SHA PAYTDAGI holati (`destinationSnapshot`)
 * ichiga nusxalanadi — keyin restoran kartasini almashtirsa ham,
 * eski to'lov tarixi eski kartani ko'rsatib turaveradi.
 *
 * ═══ TZ 16-BAND: TAKRORIY YUBORISHDAN HIMOYA ═══
 *
 * `idempotencyKey` endi majburiy parametr. Uni chaqiruvchi
 * (controller) generatsiya qiladi va DIQQAT — qayta urinishda
 * (masalan tarmoq uzilib javob kelmasa) AYNAN O'SHA kalitni
 * qayta yuboradi. `Payout.idempotencyKey` unique indeksga ega,
 * shuning uchun bir xil kalit bilan ikkinchi urinish DB
 * darajasida rad etiladi — frontenddagi "disabled tugma" ga
 * ishonilmaydi (TZ 17-band aynan shuni talab qildi).
 */
export async function recordPayout(restaurantId, amount, adminId, note = '', idempotencyKey) {
  if (!idempotencyKey) {
    throw new Error('idempotencyKey majburiy — takroriy to‘lovdan himoya uchun');
  }
  if (amount <= 0) throw new Error('Summa musbat bo‘lishi kerak');

  const restaurant = await Restaurant.findById(restaurantId)
    .select('name balance totalPaidOut payout').lean();
  if (!restaurant) throw new Error('Restoran topilmadi');

  const destinationSnapshot = restaurant.payout?.method === 'card'
    ? { method: 'card', card: restaurant.payout.card }
    : restaurant.payout?.method === 'bank'
      ? { method: 'bank', bank: restaurant.payout.bank }
      : { method: null, note: 'Rekvizit belgilanmagan edi' };

  /*
   * ═══ KALITNI BIRINCHI NAVBATDA "BAND" QILISH ═══
   *
   * MUHIM TARTIB: `Payout.create()` BALANS TEKSHIRUVIDAN OLDIN
   * chaqiriladi, keyin emas. Sabab — bir xil idempotencyKey bilan
   * IKKITA so'rov chinakam bir vaqtda kelsa (masalan mijoz
   * tugmani ikki marta bosib ulgursa, javob qaytmasdan turib):
   *
   *   Agar avval balansni tekshirib, KEYIN Payout yaratilsa —
   *   ikkalasi ham "kalit hali yo'q" deb balansni kamaytirishga
   *   ulgurishi mumkin edi, va faqat OXIRIDA, Payout.create()
   *   bosqichida ikkinchisi rad etilardi — lekin balans ALLAQACHON
   *   ikki marta kamaygan bo'lardi.
   *
   *   Endi: unique indeksga ega Payout hujjatini yaratish —
   *   MongoDB darajasidagi ATOMIK "band qilish". Ikkala so'rovdan
   *   faqat BITTASI bu yerdan muvaffaqiyatli o'tadi. G'olib bo'lgan
   *   so'rovgina balansga tegadi.
   */
  let payout;
  try {
    payout = await Payout.create({
      restaurantId,
      amount, // dastlabki so'ralgan summa — pastda promo qarz chegirilsa yangilanadi
      status: 'PROCESSING',
      idempotencyKey,
      bankProvider: 'manual',
      snapshot: { ...destinationSnapshot, note, confirmedBy: adminId || null },
    });
  } catch (e) {
    if (e?.code === 11000) {
      // Kalit band — bu YANGI to'lov emas, qayta urinish (yoki poyga yutqazgan so'rov)
      const existing = await Payout.findOne({ idempotencyKey }).lean();
      return {
        alreadyExisted: true,
        payoutId: existing?._id,
        balance: null,
        paidOut: existing?.amount ?? 0,
      };
    }
    throw e;
  }

  /*
   * ═══ BALANS VA YOZUV — BITTA MOLIYAVIY BIRLIK (audit F-01, F-11) ═══
   *
   * ILGARI: avval promo qarzi ushlanardi (markDebtPaid + jurnal), KEYIN balans tekshirilardi. Balans yetmasa
   * payout FAILED bo'lardi, lekin promo qarz "to'langan" bo'lib qolardi. Balans `amount` ga kamayib, jurnalga
   * ALOHIDA so'rov bilan yozilardi (oraliqda yiqilsa — balans kamaygan, yozuv yo'q).
   *
   * ENDI:
   *   1) [tranzaksiya] balans atomik yechiladi (`balance ≥ amount` filtri) va Payout'ga "balans olindi" belgisi;
   *   2) shundan KEYIN promo qarzi ushlanadi (balans yetmasa promo'ga umuman tegilmaydi);
   *   3) [tranzaksiya] payout yozuvi (postingKey = payout:<id>), totalPaidOut va Payout SUCCESS — birga.
   * 1 va 3 orasida jarayon uzilsa Payout PROCESSING + balanceClaimed bo'lib qoladi — finance:audit ko'rsatadi
   * (pul hali yuborilmagan, balans esa band — qo'lda yakunlanadi; ikki marta to'lanmaydi).
   */
  let claimed;
  try {
    claimed = await runFinanceTx(async (session) => {
      const opts = session ? { session } : {};
      const upd = await Restaurant.findOneAndUpdate(
        { _id: restaurantId, balance: { $gte: amount } },
        { $inc: { balance: -amount } },
        { new: true, projection: { balance: 1 }, ...opts },
      ).lean();
      if (!upd) return null;
      await Payout.updateOne({ _id: payout._id, status: 'PROCESSING' }, { $set: { 'snapshot.balanceClaimed': true } }, opts);
      return upd;
    });
  } catch (e) {
    await Payout.updateOne({ _id: payout._id, status: 'PROCESSING' }, { $set: { status: 'FAILED', lastError: String(e.message).slice(0, 200) } }).catch(() => {});
    throw e;
  }

  if (!claimed) {
    await Payout.updateOne({ _id: payout._id, status: 'PROCESSING' }, { $set: { status: 'FAILED', lastError: 'Balansda yetarli emas' } });
    const fresh = await Restaurant.findById(restaurantId).select('balance').lean();
    throw new Error(`Balansda yetarli emas. Hozir: ${fresh?.balance ?? 0} so‘m`);
  }

  // Mijozlarni jalb qilish qarzi — balans tasdiqlangandan KEYIN (sozlama yoqilgan bo'lsa)
  let deducted = 0;
  try {
    const { deductFromSettlement } = await import('./promoBilling.js');
    deducted = await deductFromSettlement(restaurantId, amount);
  } catch (e) {
    console.error('[billing] promo qarzi ushlanmadi (payout davom etadi):', e.message);
    deducted = 0;
  }
  const payoutAmount = amount - deducted;

  const final = await runFinanceTx(async (session) => {
    const opts = session ? { session } : {};
    if (payoutAmount > 0) {
      await Ledger.create([{
        type: 'payout',
        amount: -payoutAmount,
        restaurantId,
        createdBy: adminId,
        postingKey: `payout:${payout._id}`,
        meta: {
          note: note || 'Bank hisobiga o‘tkazildi',
          ...(deducted > 0 ? { promoDebtDeducted: deducted } : {}),
        },
      }], opts);
    }
    const r = await Restaurant.findOneAndUpdate(
      { _id: restaurantId },
      { $inc: { totalPaidOut: payoutAmount } },
      { new: true, projection: { balance: 1 }, ...opts },
    ).lean();
    const now = new Date();
    await Payout.updateOne({ _id: payout._id }, {
      $set: {
        amount: payoutAmount, status: 'SUCCESS', sentAt: now, confirmedAt: now,
        'snapshot.promoDebtDeducted': deducted,
      },
    }, opts);
    return r;
  });

  getIO()?.to('admin').emit('billing:update', {
    restaurantId: String(restaurantId),
    balance: final?.balance,
  });

  return {
    payoutId: payout._id,
    balance: final?.balance,
    paidOut: payoutAmount,
    promoDebtDeducted: deducted,
  };
}

/*
 * Barcha restoranlar bo'yicha naqd/karta buyurtma soni —
 * LokmaGo admin paneli uchun (yagona so'rovda hammasi, N+1
 * so'rov muammosi bo'lmasin).
 */
export async function getAllRestaurantsOrderCounts(from, to) {
  /*
   * Sana — YETKAZILGAN sana (deliveredAt), updatedAt emas: baho
   * yoki "To'lov qilindi" bosilganda updatedAt o'zgarib, eski
   * buyurtma boshqa kunga ko'chib ketardi (billingPeriod.js).
   */
  const match = { status: 'delivered', ...deliveredWindow(resolvePeriod(from, to)) };

  /*
   * To'lov turi bo'yicha guruhlanadi, naqd/karta ajratish esa JS'da
   * (paymentGroupFilter bilan AYNAN bir xil qoida: 'cash' — naqd,
   * qolgani — karta). Avval $group ichida $cond ishlatilardi — natija
   * bir xil, lekin ba'zi MongoDB-mos bazalarda qo'llanmaydi.
   */
  const rows = await Order.aggregate([
    { $match: match },
    {
      $group: {
        _id: { restaurantId: '$restaurantId', paymentMethod: '$paymentMethod' },
        count: { $sum: 1 },
      },
    },
  ]);

  const byRestaurant = new Map();
  for (const r of rows) {
    const id = String(r._id.restaurantId);
    if (!byRestaurant.has(id)) byRestaurant.set(id, { cashCount: 0, cardCount: 0 });
    const bucket = byRestaurant.get(id);
    if (r._id.paymentMethod === 'cash') bucket.cashCount += r.count;
    else bucket.cardCount += r.count;
  }
  return byRestaurant;
}

/** Restoran bo'yicha moliyaviy xulosa. */
export async function getRestaurantSummary(restaurantId, from, to) {
  const match = { restaurantId };
  if (from || to) {
    match.createdAt = {};
    if (from) match.createdAt.$gte = new Date(from);
    if (to) match.createdAt.$lte = new Date(to);
  }

  const rows = await Ledger.aggregate([
    { $match: match },
    { $group: { _id: '$type', total: { $sum: '$amount' }, count: { $sum: 1 } } },
  ]);

  const byType = Object.fromEntries(rows.map((r) => [r._id, r.total]));
  const restaurant = await Restaurant.findById(restaurantId)
    .select('name balance totalPaidOut commissionPercent commissionMode')
    .lean();

  return {
    restaurant,
    tushum: byType.payment_in || 0,
    komissiya: byType.commission || 0,
    restoranUlushi: byType.restaurant_due || 0,
    bonusKompensatsiya: byType.bonus_compensation || 0,
    tolangan: Math.abs(byType.payout || 0),
    qaytarilgan: Math.abs(byType.refund || 0),
    balans: restaurant?.balance || 0,
  };
}

/*
 * ═══════════════════════════════════════════════════════════
 * RESTORAN O'ZI KO'RADIGAN HISOBOT
 *
 * Yuqoridagi getRestaurantSummary() LokmaGo admini uchun edi
 * (Ledger tur bo'yicha yig'indi). Bu yerdagilar esa RESTORAN
 * paneliga xos: "nechta buyurtma", "nechtasi naqd/karta",
 * "qachon qancha o'tkazildi" — savolga JAVOB shaklida.
 *
 * XAVFSIZLIK: bu funksiyalar restaurantId ni har doim
 * controller orqali (auth token'dan, rid(req)) oladi —
 * so'rovdan emas. Restoran boshqa restoran ID'sini yozib
 * kira olmasligi shu yerda emas, controller darajasida
 * ta'minlanadi (controllers/restaurantBilling.js).
 * ═══════════════════════════════════════════════════════════
 */

/**
 * Sana oralig'ini "kun" chegaralariga aylantiradi.
 *
 * `from`/`to` berilmasa — BUGUN (restoran o'z mahalliy vaqtida
 * kiritadi, server esa UTC bilan ishlaydi; frontend allaqachon
 * to'g'ri ISO sanalarni yuboradi, bu yerda faqat standart
 * qiymat qo'yiladi).
 */
function dayRange(from, to) {
  const start = from ? new Date(from) : new Date();
  const end = to ? new Date(to) : new Date();
  if (!from) start.setHours(0, 0, 0, 0);
  if (!to) end.setHours(23, 59, 59, 999);
  return { start, end };
}

/**
 * Restoran uchun buyurtma statistikasi: jami, naqd, karta —
 * SON va SUMMA bilan. Faqat YAKUNLANGAN (yetkazilgan/topshirilgan)
 * buyurtmalar hisoblanadi — bekor qilinganlar kirmaydi, chunki
 * ularga hech qanday pul harakati bo'lmagan.
 */
export async function getRestaurantOrderStats(restaurantId, from, to) {
  const { start, end } = dayRange(from, to);

  /*
   * Faqat 'delivered' — Order modelidagi YAGONA yakunlangan
   * holat (models/Order.js). 'completed' bu sxemada UMUMAN
   * mavjud emas — settleOrder() ham faqat shu holatga
   * o'tishda chaqiriladi (controllers/restaurantPanel.js).
   */
  const rows = await Order.aggregate([
    {
      $match: {
        restaurantId,
        status: 'delivered',
        updatedAt: { $gte: start, $lte: end },
      },
    },
    {
      $group: {
        _id: { $cond: [{ $eq: ['$paymentMethod', 'cash'] }, 'cash', 'card'] },
        count: { $sum: 1 },
        total: { $sum: '$total' },
      },
    },
  ]);

  const cash = rows.find((r) => r._id === 'cash') || { count: 0, total: 0 };
  const card = rows.find((r) => r._id === 'card') || { count: 0, total: 0 };

  const ordersTotal = cash.count + card.count;
  const revenue = cash.total + card.total;

  /*
   * ═══ QO'SHIMCHA KO'RSATKICHLAR ═══
   *
   * Ilgari hisobot faqat "nechta buyurtma, qancha pul" ni
   * ko'rsatardi. Restoran uchun bu yetarli emas — u savdosini
   * BOSHQARISHI kerak, shunchaki kuzatishi emas. Quyidagilar
   * qo'shildi:
   *
   *   • o'rtacha chek — narx siyosati va aksiyalar ta'sirini
   *     ko'rsatadigan eng muhim raqam
   *   • bekor qilinganlar — muammo signali (oshxona ulgurmayaptimi,
   *     taom tugaganmi)
   *   • yetkazish/olib ketish — logistika yuklamasini tushunish
   *   • eng ko'p sotilgan taomlar — menyuni qisqartirish yoki
   *     aksiya tanlashda asos
   *
   * Hammasi BITTA vaqt oralig'i uchun va parallel hisoblanadi,
   * shuning uchun qo'shimcha kechikish deyarli yo'q.
   */
  const [cancelledRows, deliveryRows, topDishes] = await Promise.all([
    Order.countDocuments({
      restaurantId,
      status: 'cancelled',
      updatedAt: { $gte: start, $lte: end },
    }),

    Order.aggregate([
      { $match: { restaurantId, status: 'delivered', updatedAt: { $gte: start, $lte: end } } },
      {
        $group: {
          // Model maydoni 'fulfillment': delivery | pickup | dinein
          _id: '$fulfillment',
          count: { $sum: 1 },
        },
      },
    ]),

    Order.aggregate([
      { $match: { restaurantId, status: 'delivered', updatedAt: { $gte: start, $lte: end } } },
      { $unwind: '$items' },
      {
        $group: {
          _id: '$items.name',
          qty: { $sum: '$items.quantity' },
          // Model maydoni 'unitPrice' (item.price EMAS)
          amount: { $sum: { $multiply: ['$items.unitPrice', '$items.quantity'] } },
        },
      },
      { $sort: { qty: -1 } },
      { $limit: 5 },
      { $project: { _id: 0, name: '$_id', qty: 1, amount: 1 } },
    ]),
  ]);

  const pickup = deliveryRows.find((r) => r._id === 'pickup')?.count || 0;
  const delivery = deliveryRows.find((r) => r._id === 'delivery')?.count || 0;
  const dinein = deliveryRows.find((r) => r._id === 'dinein')?.count || 0;

  return {
    from: start,
    to: end,
    ordersTotal,
    revenue,
    // Buyurtma bo'lmasa 0 — bo'lishda NaN chiqmasligi uchun
    avgCheck: ordersTotal ? Math.round(revenue / ordersTotal) : 0,
    cancelled: cancelledRows,
    delivery,
    pickup,
    dinein,
    topDishes,
    cash: { count: cash.count, amount: cash.total },
    card: { count: card.count, amount: card.total },
  };
}

/**
 * Kunlik moliyaviy jadval — "qachon qancha o'tkazildi" savoliga
 * javob. Har kun uchun: shu kunda yozilgan tushum, komissiya,
 * o'tkazma (payout), va O'SHA KUN OXIRIDAGI balans.
 *
 * Balans oxirgi yozuv qiymatidan olinadi (Ledger yozuvlari
 * xronologik ketma-ketlikda kelgani uchun kunning so'nggi
 * o'zgarishi = kun oxiridagi holat).
 */
export async function getRestaurantDailyLedger(restaurantId, from, to) {
  const { start, end } = dayRange(from, to);

  const rows = await Ledger.aggregate([
    { $match: { restaurantId, createdAt: { $gte: start, $lte: end } } },
    {
      $group: {
        _id: {
          day: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
          type: '$type',
        },
        total: { $sum: '$amount' },
        count: { $sum: 1 },
      },
    },
    { $sort: { '_id.day': 1 } },
  ]);

  const byDay = new Map();
  for (const r of rows) {
    const day = r._id.day;
    if (!byDay.has(day)) {
      byDay.set(day, {
        day,
        tushum: 0, komissiya: 0, restoranUlushi: 0, bonusKompensatsiya: 0, tolangan: 0, qaytarilgan: 0,
      });
    }
    const bucket = byDay.get(day);
    if (r._id.type === 'payment_in') bucket.tushum = r.total;
    if (r._id.type === 'commission') bucket.komissiya = r.total;
    if (r._id.type === 'restaurant_due') bucket.restoranUlushi = r.total;
    if (r._id.type === 'payout') bucket.tolangan = Math.abs(r.total);
    if (r._id.type === 'refund') bucket.qaytarilgan = Math.abs(r.total);
    if (r._id.type === 'bonus_compensation') bucket.bonusKompensatsiya = r.total;
  }

  return [...byDay.values()].sort((a, b) => b.day.localeCompare(a.day));
}

/**
 * Karta orqali kelgan, lekin HALI restoranga o'tkazilmagan
 * summa — "karta orqali to'langan pullarni Lokma restoran
 * hisobiga o'tqazib berdimi" savoliga to'g'ridan-to'g'ri javob.
 *
 * Bu Restaurant.balance bilan BIR XIL EMAS: balans naqd
 * komissiya qarzini ham o'z ichiga oladi (manfiy tomonga
 * suradi). Bu yerda esa faqat "karta orqali kelib, hali
 * o'tkazilmagan" qismi ajratib ko'rsatiladi — restoran
 * "menga qachon pul kelishi kerak" deb so'raganda aniq
 * javob berish uchun.
 */
export async function getRestaurantPendingPayout(restaurantId) {
  const restaurant = await Restaurant.findById(restaurantId)
    .select('balance totalPaidOut')
    .lean();

  return {
    // Balans musbat bo'lsa — LokmaGo restoranga qarzdor (kelishi
    // kerak bo'lgan pul). Manfiy bo'lsa — restoran LokmaGoga
    // qarzdor (naqd buyurtmalar komissiyasi hali ushlanmagan).
    balance: restaurant?.balance || 0,
    pendingToReceive: Math.max(0, restaurant?.balance || 0),
    owedToLokma: Math.max(0, -(restaurant?.balance || 0)),
    totalPaidOutSoFar: restaurant?.totalPaidOut || 0,
  };
}
