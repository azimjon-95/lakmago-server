/*
 * ═══════════════════════════════════════════════════════════
 * RESTORAN O'ZI KO'RADIGAN HISOBOT (web panel → "Hisobotlar")
 * ═══════════════════════════════════════════════════════════
 *
 * NEGA ALOHIDA MODUL (2026-11-23 audit):
 *
 *  1. billing.js dagi eski funksiyalar (getRestaurantOrderStats,
 *     getRestaurantDailyLedger) `Order.aggregate` / `Ledger.aggregate`
 *     ga `req.restaurantId` ni STRING holida berardi. aggregate()
 *     Mongoose'da turni o'girmaydi → ObjectId maydon bilan HECH
 *     QACHON mos kelmasdi. Natija: hisobot qo'shilgan kundan
 *     (2026-08-31) beri restoran "0 ta buyurtma, 0 so'm, yozuv yo'q"
 *     ko'rardi, faqat `countDocuments` (o'giradi) dagi "Bekor
 *     qilingan" va Restaurant.balance to'g'ri chiqardi.
 *     Bu yerda ID har doim `toOid()` dan o'tadi va so'rovlar
 *     `find()` (turni o'giradi) bilan qilinadi.
 *
 *  2. Kun chegarasi server vaqt zonasiga bog'liq edi (`new Date(
 *     "2026-11-23T00:00:00")`). Endi — TOSHKENT kuni (billingPeriod.js,
 *     mobil ilovaning /panel/stats bilan bir xil qoida).
 *
 *  3. Buyurtma `updatedAt` bo'yicha kunga tushardi (baho qoldirilsa
 *     boshqa kunga "ko'chardi"). Endi — `deliveredAt` (deliveredWindow).
 *
 *  4. "Bekor qilingan" soni to'lanmay bekor bo'lgan karta
 *     buyurtmalarini ham sanardi — restoran ularni HECH QACHON
 *     ko'rmagan (CLAUDE.md 1-QOIDA). Endi RESTAURANT_HIDDEN.
 *
 *  5. Pul raqamlari buyurtmaning muzlatilgan moliya snapshot'idan
 *     (`finance`, v2) — restoran ko'rinishi (panelOrderView.js
 *     restaurantFinanceView bilan bir xil manba). LokmaGo sof
 *     daromadi va Click haqi BU YERDAN CHIQMAYDI.
 *
 * Faqat O'QISH. Hech narsa yozilmaydi, balans o'zgarmaydi.
 */
import { Types } from 'mongoose';
import { Order } from '../models/Order.js';
import { Ledger } from '../models/Ledger.js';
import { Restaurant } from '../models/Restaurant.js';
import { resolvePeriod, deliveredWindow } from './billingPeriod.js';
import { RESTAURANT_HIDDEN } from './restaurantVisibility.js';
import { zoneDate } from './restaurantTime.js';

export const REPORT_TZ = 'Asia/Tashkent';
const CAP = 20000;
const ACTIVE_STATUSES = ['pending', 'accepted', 'preparing', 'ready', 'delivering'];

/** String yoki ObjectId → ObjectId. Noto'g'ri qiymat — xato (jimgina "0 ta" emas). */
export function toOid(id) {
  if (id instanceof Types.ObjectId) return id;
  const s = String(id ?? '');
  if (!Types.ObjectId.isValid(s)) {
    const err = new Error('Restoran aniqlanmadi');
    err.status = 403;
    throw err;
  }
  return new Types.ObjectId(s);
}

export const tashkentYmd = (date = new Date()) => zoneDate(REPORT_TZ, date).ymd;

/*
 * Eski web panel sanani "YYYY-MM-DDT00:00:00" / "...T23:59:59" (zonasiz)
 * yuborardi — bu server vaqt zonasida talqin qilinardi. Shunday qiymat
 * TOSHKENT kuniga aylantiriladi (eski brauzer keshi ham to'g'ri ishlasin).
 * Aniq lahza (Z yoki +05:00 bilan) — o'zgarmaydi.
 */
export function normalizeEdge(v) {
  if (v == null || v === '') return undefined;
  const m = String(v).trim().match(/^(\d{4}-\d{2}-\d{2})(?:T(?:00:00:00|23:59:59)(?:\.\d+)?)?$/);
  return m ? m[1] : String(v).trim();
}

/** from/to → Toshkent davri. Ikkalasi yo'q — `fallback` ('today' | 'month'). */
export function reportPeriod(q = {}, fallback = 'today') {
  let from = normalizeEdge(q.from);
  let to = normalizeEdge(q.to);
  if (!from && !to) {
    const today = tashkentYmd();
    to = today;
    from = fallback === 'month' ? `${today.slice(0, 8)}01` : today;
  }
  from = from || to;
  to = to || from;
  return { from, to, period: resolvePeriod(from, to) };
}

const toT = (som) => Math.round((Number(som) || 0) * 100);          // so'm → tiyin
const toSom = (tiyin) => Math.round(Number(tiyin) || 0) / 100;      // tiyin → so'm
const T = (v) => Math.round(Number(v) || 0);                         // snapshot tiyin

/** Restoran naqdni O'ZI oldimi (settleOrder bilan aynan bir xil qoida). */
export const isOwnCash = (o) => o.paymentMethod === 'cash' && o.courierParty !== 'lokma';

/**
 * Bitta buyurtmaning restoranga tegishli pul tasviri — TIYINDA (butun son).
 *
 *   food        — taom summasi (komissiya bazasi)
 *   commission  — RESTORAN komissiyasi (kelishuv foizi)
 *   customerFee — mijoz xizmat haqi: mijoz to'laydi, LokmaGo'niki
 *                 (restoran ulushidan ushlanmaydi)
 *   delivery    — restoranga tegadigan yetkazish puli
 *   share       — restoranga jami (food − commission + delivery)
 *   toLokma     — naqdni restoran olgan bo'lsa: LokmaGo'ga beriladigan
 *                 qism (= komissiya + mijoz xizmat haqi; ledger bilan bir xil)
 *   fromLokma   — karta (yoki LokmaGo kuryeri olgan naqd): LokmaGo
 *                 restoranga o'tkazadigan ulush
 *
 * Eski (snapshot'siz) buyurtmada faqat taom/jami ma'lum — qolgani null.
 */
export function orderMoneyT(o) {
  const f = o.finance;
  const ownCash = isOwnCash(o);
  if (f?.model === 'v2') {
    const commission = T(f.restaurantCommissionAmount);
    const customerFee = T(f.customerFeeAmount);
    const share = T(f.restaurantPayout);
    return {
      v2: true,
      ownCash,
      food: T(f.foodSubtotal),
      discount: T(f.discountAmount),
      commission,
      commissionPercent: f.restaurantCommissionPercent ?? null,
      customerFee,
      customerFeePercent: f.customerFeePercent ?? null,
      delivery: T(f.restaurantDeliveryPayout),
      share,
      charged: T(f.totalCharged),
      toLokma: ownCash ? T(f.lokmaGrossCommission ?? commission + customerFee) : 0,
      fromLokma: ownCash ? 0 : share,
    };
  }
  return {
    v2: false,
    ownCash,
    food: toT(o.subtotal),
    discount: 0,
    commission: null,
    commissionPercent: null,
    customerFee: null,
    customerFeePercent: null,
    delivery: toT(o.deliveryFee),
    share: null,
    charged: toT(o.total),
    toLokma: null,
    fromLokma: null,
  };
}

/** orderMoneyT → so'm (javob uchun). */
export function orderMoney(o) {
  const m = orderMoneyT(o);
  const out = { ...m };
  for (const k of ['food', 'discount', 'commission', 'customerFee', 'delivery', 'share', 'charged', 'toLokma', 'fromLokma']) {
    out[k] = m[k] == null ? null : toSom(m[k]);
  }
  return out;
}

const deliveredDay = (o) => tashkentYmd(new Date(o.deliveredAt || o.updatedAt));

function emptyMoney() {
  return { food: 0, discount: 0, commission: 0, customerFee: 0, delivery: 0, share: 0, charged: 0, toLokma: 0, fromLokma: 0, cashCollected: 0 };
}

function addMoney(acc, m) {
  acc.food += m.food;
  acc.discount += m.discount;
  acc.delivery += m.delivery;
  acc.charged += m.charged;
  if (m.v2) {
    acc.commission += m.commission;
    acc.customerFee += m.customerFee;
    acc.share += m.share;
    acc.toLokma += m.toLokma;
    acc.fromLokma += m.fromLokma;
  }
  if (m.ownCash) acc.cashCollected += m.charged;
}

function moneyToSom(acc) {
  return Object.fromEntries(Object.entries(acc).map(([k, v]) => [k, toSom(v)]));
}

const DELIVERED_FIELDS =
  '_id dailyNumber createdAt deliveredAt updatedAt paymentMethod fulfillment courierParty subtotal deliveryFee total items.name items.quantity items.unitPrice finance';

/* ═══════════════════════════════════════════════════════════
 * GET /panel/billing/summary
 * ═══════════════════════════════════════════════════════════ */
export async function buildRestaurantSummary(restaurantId, query = {}) {
  const rid = toOid(restaurantId);
  const { from, to, period } = reportPeriod(query, 'today');
  const base = { restaurantId: rid, ...RESTAURANT_HIDDEN };

  const [delivered, cancelled, activeNow, ledger, restaurant, lastPayout] = await Promise.all([
    Order.find({ ...base, status: 'delivered', ...deliveredWindow(period) })
      .select(DELIVERED_FIELDS).limit(CAP).lean(),
    Order.find({
      ...base,
      status: 'cancelled',
      $or: [{ cancelledAt: period.cond }, { cancelledAt: null, updatedAt: period.cond }],
    }).select('subtotal cancelReason cancelReasonCode').limit(CAP).lean(),
    Order.countDocuments({ ...base, status: { $in: ACTIVE_STATUSES } }),
    Ledger.find({
      restaurantId: rid,
      createdAt: period.cond,
      type: { $in: ['payout', 'bonus_compensation', 'adjustment'] },
    }).select('type amount meta.note').lean(),
    Restaurant.findById(rid).select('balance totalPaidOut').lean(),
    Ledger.findOne({ restaurantId: rid, type: 'payout' }).sort({ createdAt: -1 }).select('amount createdAt').lean(),
  ]);

  // ── Buyurtmalar va pul ──
  const money = emptyMoney();
  const pay = { cash: { count: 0, amount: 0 }, card: { count: 0, amount: 0 } };
  const ful = { delivery: 0, pickup: 0, dinein: 0 };
  const dishes = new Map();
  const commissionPercents = new Set();
  const customerFeePercents = new Set();
  let legacyOrders = 0;
  let lokmaCourierCash = 0;

  for (const o of delivered) {
    const m = orderMoneyT(o);
    addMoney(money, m);
    if (!m.v2) legacyOrders += 1;
    if (m.commissionPercent != null) commissionPercents.add(m.commissionPercent);
    if (m.customerFeePercent != null) customerFeePercents.add(m.customerFeePercent);
    if (o.paymentMethod === 'cash' && !m.ownCash) lokmaCourierCash += 1;

    const p = pay[o.paymentMethod === 'cash' ? 'cash' : 'card'];
    p.count += 1;
    p.amount += toT(o.total);
    if (o.fulfillment in ful) ful[o.fulfillment] += 1;

    for (const it of o.items || []) {
      const d = dishes.get(it.name) || { name: it.name, qty: 0, amount: 0 };
      d.qty += Number(it.quantity) || 0;
      d.amount += toT((Number(it.unitPrice) || 0) * (Number(it.quantity) || 0));
      dishes.set(it.name, d);
    }
  }

  const ordersTotal = delivered.length;
  const revenueT = pay.cash.amount + pay.card.amount;
  const topDishes = [...dishes.values()]
    .sort((a, b) => b.qty - a.qty || b.amount - a.amount)
    .slice(0, 5)
    .map((d) => ({ name: d.name, qty: d.qty, amount: toSom(d.amount) }));

  // ── Bekor qilinganlar (faqat restoran ko'rgan buyurtmalar) ──
  const reasons = new Map();
  let cancelledFoodT = 0;
  for (const c of cancelled) {
    cancelledFoodT += toT(c.subtotal);
    const key = (c.cancelReason || '').trim() || 'Sabab ko‘rsatilmagan';
    reasons.set(key, (reasons.get(key) || 0) + 1);
  }

  // ── Davrdagi pul harakati (ledger) ──
  let payoutsT = 0;
  let payoutsCount = 0;
  let bonusT = 0;
  let adjustmentsT = 0;
  for (const l of ledger) {
    if (l.type === 'payout') { payoutsT += Math.abs(toT(l.amount)); payoutsCount += 1; }
    else if (l.type === 'bonus_compensation') bonusT += toT(l.amount);
    else if (l.type === 'adjustment') adjustmentsT += toT(l.amount);
  }

  const balance = Number(restaurant?.balance) || 0;
  const one = (set) => (set.size === 1 ? [...set][0] : null);

  return {
    period: { from, to, timezone: REPORT_TZ },
    orders: {
      // ── Eski maydonlar (orqaga moslik — shakli o'zgarmagan) ──
      from: period.start,
      to: period.end,
      ordersTotal,
      revenue: toSom(revenueT),
      avgCheck: ordersTotal ? Math.round(toSom(revenueT) / ordersTotal) : 0,
      cancelled: cancelled.length,
      delivery: ful.delivery,
      pickup: ful.pickup,
      dinein: ful.dinein,
      topDishes,
      cash: { count: pay.cash.count, amount: toSom(pay.cash.amount) },
      card: { count: pay.card.count, amount: toSom(pay.card.amount) },
      // ── Yangi ──
      active: activeNow,
      avgFood: ordersTotal ? Math.round(toSom(money.food) / ordersTotal) : 0,
      lokmaCourierCash,
      cancelledFood: toSom(cancelledFoodT),
      cancelReasons: [...reasons.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([reason, count]) => ({ reason, count })),
    },
    finance: {
      ...moneyToSom(money),
      commissionPercent: one(commissionPercents),
      customerFeePercent: one(customerFeePercents),
      legacyOrders,
      bonusCompensation: toSom(bonusT),
      adjustments: toSom(adjustmentsT),
      payouts: { amount: toSom(payoutsT), count: payoutsCount },
      // Davr natijasi: karta ulushi (LokmaGo o'tkazadi) − naqd bo'yicha LokmaGo qismi + sovg'a bonusi
      net: toSom(money.fromLokma - money.toLokma + bonusT),
    },
    payout: {
      // Eski maydonlar (umumiy holat — davrga bog'liq EMAS)
      balance,
      pendingToReceive: Math.max(0, balance),
      owedToLokma: Math.max(0, -balance),
      totalPaidOutSoFar: Number(restaurant?.totalPaidOut) || 0,
      // Yangi
      lastPayout: lastPayout ? { amount: Math.abs(Number(lastPayout.amount) || 0), at: lastPayout.createdAt } : null,
    },
    truncated: [delivered, cancelled].some((a) => a.length >= CAP),
  };
}

/* ═══════════════════════════════════════════════════════════
 * GET /panel/billing/daily — kunlar kesimida (Toshkent kuni)
 * ═══════════════════════════════════════════════════════════ */
export async function buildRestaurantDaily(restaurantId, query = {}) {
  const rid = toOid(restaurantId);
  const { period } = reportPeriod(query, 'month');

  const [delivered, ledger] = await Promise.all([
    Order.find({ restaurantId: rid, ...RESTAURANT_HIDDEN, status: 'delivered', ...deliveredWindow(period) })
      .select('deliveredAt updatedAt paymentMethod courierParty subtotal deliveryFee total finance').limit(CAP).lean(),
    Ledger.find({ restaurantId: rid, createdAt: period.cond }).select('type amount createdAt').limit(CAP * 4).lean(),
  ]);

  const byDay = new Map();
  const row = (day) => {
    if (!byDay.has(day)) {
      byDay.set(day, {
        day,
        orders: 0, cashOrders: 0, cardOrders: 0, money: emptyMoney(),
        tushum: 0, komissiya: 0, restoranUlushi: 0, bonusKompensatsiya: 0, tolangan: 0, qaytarilgan: 0,
      });
    }
    return byDay.get(day);
  };

  for (const o of delivered) {
    const r = row(deliveredDay(o));
    r.orders += 1;
    if (o.paymentMethod === 'cash') r.cashOrders += 1; else r.cardOrders += 1;
    addMoney(r.money, orderMoneyT(o));
  }

  for (const l of ledger) {
    const r = row(tashkentYmd(new Date(l.createdAt)));
    const a = toT(l.amount);
    if (l.type === 'payment_in') r.tushum += a;
    else if (l.type === 'commission') r.komissiya += a;
    else if (l.type === 'restaurant_due') r.restoranUlushi += a;
    else if (l.type === 'payout') r.tolangan += Math.abs(a);
    else if (l.type === 'refund') r.qaytarilgan += Math.abs(a);
    else if (l.type === 'bonus_compensation') r.bonusKompensatsiya += a;
  }

  return [...byDay.values()]
    .sort((a, b) => b.day.localeCompare(a.day))
    .map((r) => ({
      day: r.day,
      // Eski maydonlar (ledger bo'yicha)
      tushum: toSom(r.tushum),
      komissiya: toSom(r.komissiya),
      restoranUlushi: toSom(r.restoranUlushi),
      bonusKompensatsiya: toSom(r.bonusKompensatsiya),
      tolangan: toSom(r.tolangan),
      qaytarilgan: toSom(r.qaytarilgan),
      // Yangi: shu kuni YETKAZILGAN buyurtmalar (snapshot bo'yicha)
      orders: r.orders,
      cashOrders: r.cashOrders,
      cardOrders: r.cardOrders,
      ...Object.fromEntries(Object.entries(moneyToSom(r.money)).map(([k, v]) => [`o_${k}`, v])),
    }));
}

/* ═══════════════════════════════════════════════════════════
 * GET /panel/billing/orders — davrdagi har bir buyurtma (pul bilan)
 * ═══════════════════════════════════════════════════════════ */
export async function buildRestaurantOrderList(restaurantId, query = {}) {
  const rid = toOid(restaurantId);
  const { from, to, period } = reportPeriod(query, 'today');
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 300, 1), 500);
  const base = { restaurantId: rid, ...RESTAURANT_HIDDEN };

  const [delivered, cancelled] = await Promise.all([
    Order.find({ ...base, status: 'delivered', ...deliveredWindow(period) })
      .select(DELIVERED_FIELDS).sort({ deliveredAt: -1, updatedAt: -1 }).limit(limit + 1).lean(),
    Order.find({
      ...base,
      status: 'cancelled',
      $or: [{ cancelledAt: period.cond }, { cancelledAt: null, updatedAt: period.cond }],
    }).select('_id dailyNumber createdAt cancelledAt updatedAt paymentMethod fulfillment subtotal total cancelReason')
      .sort({ cancelledAt: -1 }).limit(limit + 1).lean(),
  ]);

  const items = delivered.slice(0, limit).map((o) => ({
    _id: String(o._id),
    status: 'delivered',
    dailyNumber: o.dailyNumber ?? null,
    createdAt: o.createdAt,
    deliveredAt: o.deliveredAt || o.updatedAt,
    paymentMethod: o.paymentMethod,
    payGroup: o.paymentMethod === 'cash' ? 'cash' : 'card',
    fulfillment: o.fulfillment,
    courierParty: o.courierParty ?? null,
    itemsCount: (o.items || []).reduce((s, it) => s + (Number(it.quantity) || 0), 0),
    total: Number(o.total) || 0,
    money: orderMoney(o),
  }));

  const cancelledItems = cancelled.slice(0, limit).map((o) => ({
    _id: String(o._id),
    status: 'cancelled',
    dailyNumber: o.dailyNumber ?? null,
    createdAt: o.createdAt,
    cancelledAt: o.cancelledAt || o.updatedAt,
    paymentMethod: o.paymentMethod,
    payGroup: o.paymentMethod === 'cash' ? 'cash' : 'card',
    fulfillment: o.fulfillment,
    food: Number(o.subtotal) || 0,
    total: Number(o.total) || 0,
    cancelReason: o.cancelReason || '',
  }));

  return {
    period: { from, to, timezone: REPORT_TZ },
    items,
    cancelled: cancelledItems,
    hasMore: delivered.length > limit || cancelled.length > limit,
  };
}

/*
 * Ledger yozuvining restoranga ko'rinadigan shakli. `meta` ichida
 * LokmaGo sof daromadi (lokmaNetCommission) va Click haqi
 * (clickFoodFeeAmount) bor — restoranga CHIQMAYDI (panelOrderView.js
 * bilan bir xil siyosat). Faqat izoh qoladi.
 */
export function restaurantLedgerView(l) {
  const order = l.orderId && typeof l.orderId === 'object' && '_id' in l.orderId ? l.orderId : null;
  return {
    _id: String(l._id),
    type: l.type,
    amount: Number(l.amount) || 0,
    createdAt: l.createdAt,
    provider: l.provider ?? null,
    isCash: Boolean(l.isCash),
    note: l.meta?.note || l.note || '',
    orderId: order ? String(order._id) : (l.orderId ? String(l.orderId) : null),
    order: order
      ? { total: order.total, status: order.status, paymentMethod: order.paymentMethod, dailyNumber: order.dailyNumber ?? null }
      : null,
  };
}
