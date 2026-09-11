import { Types } from 'mongoose';
import { Ledger } from '../models/Ledger.js';
import { Order } from '../models/Order.js';
import { Restaurant } from '../models/Restaurant.js';
import { Payout } from '../models/Payout.js';
import { getSettings } from '../models/Settings.js';
import { getIO } from '../sockets/io.js';

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
        type: { $in: ['payment_in', 'commission', 'restaurant_due'] },
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
        type: { $in: ['payment_in', 'commission', 'restaurant_due'] },
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
  // Takroriy yozuvdan himoya
  const exists = await Ledger.findOne({ orderId: order._id, type: 'payment_in' });
  if (exists) return null;

  await Ledger.create({
    type: 'payment_in',
    amount: order.total,
    orderId: order._id,
    restaurantId: order.restaurantId,
    userId: order.userId,
    provider,
    isCash: provider === 'cash',
    transactionId,
    meta: { orderTotal: order.total, note: 'To‘lov qabul qilindi' },
  });

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
export async function settleOrder(orderId) {
  const order = await Order.findById(orderId);
  if (!order) return null;

  // Takroriy hisob-kitobdan himoya
  const already = await Ledger.findOne({ orderId: order._id, type: 'restaurant_due' });
  if (already) return null;

  const restaurant = await Restaurant.findById(order.restaurantId);
  if (!restaurant) {
    console.error(`[billing] Restoran topilmadi: ${order.restaurantId}`);
    return null;
  }

  const { percent, mode } = await resolveCommission(restaurant);
  const { commission, restaurantShare } = calcCommission(order.subtotal, percent, mode);

  const meta = {
    orderTotal: order.total,
    commissionPercent: percent,
    commissionMode: mode,
  };

  const isCash = order.paymentMethod === 'cash';
  /*
   * "Moliya" hisobotida Click/Paynet alohida ko'rsatilishi kerak
   * (TZ talabi). Order.paymentMethod allaqachon aniq qiymatga
   * ega — uni Ledger yozuviga ham qo'shamiz, faqat HISOBOT UCHUN,
   * hisob-kitob FORMULASI o'zgarmaydi.
   */
  const ledgerProvider = order.paymentMethod || null;

  // Komissiya yozuvi (bor bo'lsa)
  if (commission > 0) {
    await Ledger.create({
      type: 'commission',
      amount: commission,
      orderId: order._id,
      restaurantId: restaurant._id,
      provider: ledgerProvider,
      isCash,
      meta: { ...meta, note: `${percent}% · ${mode}${isCash ? ' · naqd' : ''}` },
    });
  }

  if (isCash) {
    // NAQD: pul restoranda qoldi. Bizga faqat komissiya qarz.
    // Balans manfiyga ketadi — keyingi karta to'lovlaridan yopiladi.
    if (commission > 0) {
      await Ledger.create({
        type: 'restaurant_due',
        amount: -commission,
        orderId: order._id,
        restaurantId: restaurant._id,
        provider: ledgerProvider,
        isCash,
        meta: { ...meta, note: 'Naqd to‘lov — komissiya qarzi' },
      });
      restaurant.balance = (restaurant.balance || 0) - commission;
    } else {
      // Komissiya yo'q — hech kim hech kimga qarzdor emas
      await Ledger.create({
        type: 'restaurant_due',
        amount: 0,
        orderId: order._id,
        restaurantId: restaurant._id,
        provider: ledgerProvider,
        isCash,
        meta: { ...meta, note: 'Naqd to‘lov — komissiyasiz' },
      });
    }
  } else {
    // KARTA: pul bizda. Restoran ulushini balansga qo'shamiz.
    await Ledger.create({
      type: 'restaurant_due',
      amount: restaurantShare,
      orderId: order._id,
      restaurantId: restaurant._id,
      provider: ledgerProvider,
      isCash,
      meta,
    });
    restaurant.balance = (restaurant.balance || 0) + restaurantShare;
  }

  restaurant.totalOrders = (restaurant.totalOrders || 0) + 1;
  await restaurant.save();

  // Mijozga bonus — buyurtma yetkazilgandan keyin
  if (order.userId) {
    const { grantBonus } = await import('./promotions.js');
    grantBonus(order.userId, restaurant._id, order.total)
      .catch((e) => console.error('[bonus]', e.message));
  }

  getIO()?.to('admin').emit('billing:update', {
    restaurantId: String(restaurant._id),
    balance: restaurant.balance,
  });

  return { commission, restaurantShare, percent, mode, isCash };
}

/**
 * Pul qaytarish — buyurtma bekor qilinganda yoki restoran rad etganda.
 * Asl yozuvlar o'chirilmaydi, teskari yozuv qo'shiladi.
 */
export async function recordRefund(order, provider, transactionId = null) {
  const exists = await Ledger.findOne({ orderId: order._id, type: 'refund' });
  if (exists) return null;

  await Ledger.create({
    type: 'refund',
    amount: -order.total,
    orderId: order._id,
    restaurantId: order.restaurantId,
    userId: order.userId,
    provider,
    transactionId,
    meta: { orderTotal: order.total, note: 'Mijozga qaytarildi' },
  });

  // Agar hisob-kitob qilingan bo'lsa — teskari yozamiz
  const settled = await Ledger.findOne({
    orderId: order._id, type: 'restaurant_due',
  });

  if (settled && settled.amount !== 0) {
    const restaurant = await Restaurant.findById(order.restaurantId);
    if (restaurant) {
      await Ledger.create({
        type: 'restaurant_due',
        amount: -settled.amount,
        orderId: order._id,
        restaurantId: restaurant._id,
        meta: { note: 'Qaytarish sababli bekor qilindi' },
      });
      restaurant.balance = (restaurant.balance || 0) - settled.amount;
      await restaurant.save();
    }
  }

  getIO()?.to('admin').emit('billing:update', {
    restaurantId: String(order.restaurantId),
  });

  return { refunded: order.total };
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

  try {
    // Mijozlarni jalb qilish qarzini ushlab qolamiz (sozlama yoqilgan bo'lsa)
    const { deductFromSettlement } = await import('./promoBilling.js');
    const deducted = await deductFromSettlement(restaurantId, amount);
    const payoutAmount = amount - deducted;

    /*
     * ATOMIK BALANS YECHISH. Filtrda `balance: { $gte: amount }`
     * bor — TZ 17-band talab qilgan himoya: ikkinchi (BOSHQA
     * kalit bilan, boshqa so'rov orqali kelgan) to'lov so'rovi
     * shu restoran uchun deyarli bir vaqtda kelsa, MongoDB
     * yozishlarni bitta hujjatda NAVBAT bilan bajaradi — ikkinchi
     * so'rov birinchisi ALLAQACHON kamaytirgan balansga qarab
     * tekshiriladi.
     */
    const updated = await Restaurant.findOneAndUpdate(
      { _id: restaurantId, balance: { $gte: amount } },
      { $inc: { balance: -amount, totalPaidOut: payoutAmount } },
      { new: true },
    ).select('balance').lean();

    if (!updated) {
      payout.status = 'FAILED';
      payout.lastError = 'Balansda yetarli emas';
      await payout.save();
      const fresh = await Restaurant.findById(restaurantId).select('balance').lean();
      throw new Error(`Balansda yetarli emas. Hozir: ${fresh?.balance ?? 0} so‘m`);
    }

    if (payoutAmount > 0) {
      await Ledger.create({
        type: 'payout',
        amount: -payoutAmount,
        restaurantId,
        createdBy: adminId,
        meta: {
          note: note || 'Bank hisobiga o‘tkazildi',
          ...(deducted > 0 ? { promoDebtDeducted: deducted } : {}),
        },
      });
    }

    payout.amount = payoutAmount;
    payout.status = 'SUCCESS';
    payout.sentAt = new Date();
    payout.confirmedAt = new Date();
    payout.snapshot = { ...payout.snapshot, promoDebtDeducted: deducted };
    await payout.save();

    getIO()?.to('admin').emit('billing:update', {
      restaurantId: String(restaurantId),
      balance: updated.balance,
    });

    return {
      payoutId: payout._id,
      balance: updated.balance,
      paidOut: payoutAmount,
      promoDebtDeducted: deducted,
    };
  } catch (e) {
    // Kutilmagan xato — Payout PENDING/PROCESSING holatida
    // qolib ketmasin, aks holda keyingi tekshiruvda chalkashlik
    // tug'diradi
    if (payout.status === 'PROCESSING') {
      payout.status = 'FAILED';
      payout.lastError = e.message;
      await payout.save().catch(() => {});
    }
    throw e;
  }
}

/*
 * Barcha restoranlar bo'yicha naqd/karta buyurtma soni —
 * LokmaGo admin paneli uchun (yagona so'rovda hammasi, N+1
 * so'rov muammosi bo'lmasin).
 */
export async function getAllRestaurantsOrderCounts(from, to) {
  const match = { status: 'delivered' };
  if (from || to) {
    match.updatedAt = {};
    if (from) match.updatedAt.$gte = new Date(from);
    if (to) match.updatedAt.$lte = new Date(to);
  }

  const rows = await Order.aggregate([
    { $match: match },
    {
      $group: {
        _id: {
          restaurantId: '$restaurantId',
          method: { $cond: [{ $eq: ['$paymentMethod', 'cash'] }, 'cash', 'card'] },
        },
        count: { $sum: 1 },
      },
    },
  ]);

  const byRestaurant = new Map();
  for (const r of rows) {
    const id = String(r._id.restaurantId);
    if (!byRestaurant.has(id)) byRestaurant.set(id, { cashCount: 0, cardCount: 0 });
    const bucket = byRestaurant.get(id);
    if (r._id.method === 'cash') bucket.cashCount = r.count;
    else bucket.cardCount = r.count;
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
        tushum: 0, komissiya: 0, restoranUlushi: 0, tolangan: 0, qaytarilgan: 0,
      });
    }
    const bucket = byDay.get(day);
    if (r._id.type === 'payment_in') bucket.tushum = r.total;
    if (r._id.type === 'commission') bucket.komissiya = r.total;
    if (r._id.type === 'restaurant_due') bucket.restoranUlushi = r.total;
    if (r._id.type === 'payout') bucket.tolangan = Math.abs(r.total);
    if (r._id.type === 'refund') bucket.qaytarilgan = Math.abs(r.total);
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
