import mongoose from 'mongoose';
import { FOOD_KINDS, GIFT_KINDS, GiftBonus } from '../models/GiftBonus.js';
import { Order } from '../models/Order.js';

/*
 * ═══ SOVG'A-BONUS: SOF MANTIQ + HISOB ═══
 * Narx/summa qarori FAQAT serverda: mijoz yuborgan "bonus bor" degan gapga ishonilmaydi.
 * Bonus buyurtmani HECH QACHON to'xtatmaydi: xato bo'lsa buyurtma bonussiz yaratiladi (resolveGifts null qaytaradi).
 */
export const MAX_ACTIVE_RULES = 5;
export const MAX_GIFT_LINES = 3;
const TZ_OFFSET_MS = 5 * 3600_000; // Toshkent UTC+5, yozgi vaqt yo'q
const ABANDONED_AFTER_MS = 30 * 60_000; // to'lanmagan karta buyurtmasi shundan keyin limitni band qilmaydi

/* ───────────── Toshkent vaqti ───────────── */
export const tashkent = (d = new Date()) => {
  const t = new Date(d.getTime() + TZ_OFFSET_MS);
  return { hour: t.getUTCHours(), weekday: t.getUTCDay(), dayStart: new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()) - TZ_OFFSET_MS) };
};

/* ───────────── Sanitizatsiya ───────────── */
const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u001F\u007F\u200B-\u200F\u2028-\u202E\uFEFF]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
const int = (v, min, max, def = 0) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def; };
const cleanUrl = (raw) => (/^https:\/\/[^\s<>"']+$/i.test(String(raw ?? '').trim()) ? String(raw).trim().slice(0, 500) : '');
const isOid = (v) => mongoose.isValidObjectId(v) && String(v).length === 24;
const uniq = (arr) => [...new Set(arr)];

/** @returns {{ data: object, error?: string }} */
export function sanitizeGift(input = {}, { partial = false } = {}) {
  const d = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(input, k);
  const want = (k) => !partial || has(k);

  if (want('name')) { d.name = clean(input.name, 80); if (d.name.length < 2) return { data: d, error: 'Qoida nomini yozing' }; }
  if (want('itemName')) { d.itemName = clean(input.itemName, 60); if (d.itemName.length < 2) return { data: d, error: 'Sovg‘a nomini yozing (masalan: 1 l Coca-Cola)' }; }
  if (want('imageUrl')) {
    d.imageUrl = cleanUrl(input.imageUrl);
    if (input.imageUrl && !d.imageUrl) return { data: d, error: 'Rasm havolasi noto‘g‘ri (https bo‘lishi kerak)' };
  }
  if (want('quantity')) d.quantity = int(input.quantity ?? 1, 1, 5, 1);
  if (want('reimburse')) d.reimburse = int(input.reimburse, 0, 2_000_000);
  if (want('minAmount')) d.minAmount = int(input.minAmount ?? 100_000, 0, 1_000_000_000, 100_000);
  if (want('maxAmount')) d.maxAmount = int(input.maxAmount, 0, 1_000_000_000);
  if (want('basis')) d.basis = input.basis === 'paid' ? 'paid' : 'menu';
  if (want('active')) d.active = Boolean(input.active);
  // Ro'yxat/tur maydonlari: berilmasa model standarti (faqat BERILGAN bo'sh ro'yxat xato)
  if (has('scope')) d.scope = ['include', 'exclude'].includes(input.scope) ? input.scope : 'all';
  if (has('restaurantIds')) {
    const ids = uniq((Array.isArray(input.restaurantIds) ? input.restaurantIds : []).map(String)).filter(isOid).slice(0, 300);
    d.restaurantIds = ids;
  }
  if (has('kinds')) {
    d.kinds = uniq((Array.isArray(input.kinds) ? input.kinds : []).filter((k) => GIFT_KINDS.includes(k)));
    if (!d.kinds.length) return { data: d, error: 'Kamida bitta muassasa turini tanlang' };
  }
  if (has('fulfillments')) {
    d.fulfillments = uniq((Array.isArray(input.fulfillments) ? input.fulfillments : []).filter((k) => ['delivery', 'pickup'].includes(k)));
    if (!d.fulfillments.length) return { data: d, error: 'Yetkazib berish yoki olib ketishdan kamida bittasini tanlang' };
  }
  if (want('paymentMethods')) d.paymentMethods = uniq((Array.isArray(input.paymentMethods) ? input.paymentMethods : []).filter((k) => ['cash', 'click', 'payme', 'paynet', 'uzum'].includes(k)));
  for (const k of ['startsAt', 'endsAt']) {
    if (want(k)) {
      if (!input[k]) { d[k] = null; continue; }
      const dt = new Date(input[k]);
      if (Number.isNaN(dt.getTime())) return { data: d, error: 'Sana noto‘g‘ri' };
      d[k] = dt;
    }
  }
  if (d.startsAt && d.endsAt && d.startsAt >= d.endsAt) return { data: d, error: 'Tugash sanasi boshlanishdan keyin bo‘lsin' };
  if (want('weekdays')) d.weekdays = uniq((Array.isArray(input.weekdays) ? input.weekdays : []).map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6)).sort();
  if (want('hourFrom') || want('hourTo')) {
    const f = input.hourFrom === '' || input.hourFrom == null ? null : int(input.hourFrom, 0, 23, 0);
    const t = input.hourTo === '' || input.hourTo == null ? null : int(input.hourTo, 1, 24, 24);
    if ((f === null) !== (t === null)) return { data: d, error: 'Vaqt oynasida ikkala soatni ham kiriting (yoki ikkalasini bo‘sh qoldiring)' };
    if (f !== null && f === t) return { data: d, error: 'Boshlanish va tugash soati bir xil bo‘lmasin' };
    d.hourFrom = f; d.hourTo = t;
  }
  for (const k of ['perCustomerPerDay', 'perCustomerTotal', 'dailyLimit', 'totalLimit']) if (want(k)) d[k] = int(input[k], 0, 1_000_000);
  if (want('budget')) d.budget = int(input.budget, 0, 100_000_000_000);

  const min = d.minAmount ?? (partial ? undefined : 100_000);
  if (d.maxAmount && min !== undefined && d.maxAmount <= min) return { data: d, error: 'Yuqori chegara pastki chegaradan katta bo‘lsin' };
  if (d.scope && d.scope !== 'all' && !(d.restaurantIds || []).length && (has('restaurantIds') || !partial)) return { data: d, error: 'Restoranlarni tanlang (yoki “Hammasi”ni tanlang)' };
  return { data: d };
}

/* ───────────── Qoida holati / mosligi (sof) ───────────── */
/** Vaqt bo'yicha hozir amal qiladimi (faol, sana, hafta kuni, soat) */
export function isLive(rule, now = new Date()) {
  if (!rule?.active) return false;
  if (rule.startsAt && new Date(rule.startsAt) > now) return false;
  if (rule.endsAt && new Date(rule.endsAt) <= now) return false;
  const { hour, weekday } = tashkent(now);
  if (rule.weekdays?.length && !rule.weekdays.includes(weekday)) return false;
  const f = rule.hourFrom; const t = rule.hourTo;
  if (f != null && t != null) {
    const inside = f < t ? (hour >= f && hour < t) : (hour >= f || hour < t); // f > t: tun oshadi
    if (!inside) return false;
  }
  return true;
}

/** Restoran, turi, yetkazish usuli, to'lov turi bo'yicha mosmi (summaga QARAMAY) */
export function scopeMatches(rule, ctx) {
  const rid = String(ctx.restaurantId);
  const listed = (rule.restaurantIds || []).some((x) => String(x) === rid);
  if (rule.scope === 'include' && !listed) return false;
  if (rule.scope === 'exclude' && listed) return false;
  const kinds = rule.kinds?.length ? rule.kinds : FOOD_KINDS;
  if (!kinds.includes(ctx.restaurantKind || 'restaurant')) return false;
  if (rule.fulfillments?.length && !rule.fulfillments.includes(ctx.fulfillment)) return false;
  if (rule.paymentMethods?.length && ctx.paymentMethod && !rule.paymentMethods.includes(ctx.paymentMethod)) return false;
  return true;
}

export const amountFor = (rule, ctx) => (rule.basis === 'paid' ? ctx.paidAmount : ctx.menuAmount);

/** Limitlar tugaganmi (usage — bazadan, rule.* chegaralari bilan solishtiriladi) */
export function limitsBlock(rule, usage = {}) {
  if (rule.totalLimit > 0 && (usage.total || 0) >= rule.totalLimit) return 'total_limit';
  if (rule.dailyLimit > 0 && (usage.today || 0) >= rule.dailyLimit) return 'daily_limit';
  if (rule.perCustomerTotal > 0 && (usage.customerTotal || 0) >= rule.perCustomerTotal) return 'customer_total';
  if (rule.perCustomerPerDay > 0 && (usage.customerToday || 0) >= rule.perCustomerPerDay) return 'customer_daily';
  const cost = (rule.reimburse || 0) * (rule.quantity || 1);
  if (rule.budget > 0 && (usage.spent || 0) + cost > rule.budget) return 'budget';
  return null;
}

/**
 * Bitta buyurtma uchun qaysi sovg'alar tegishli va qaysi biriga "yana X so'm qoldi".
 * @param rules   faol qoidalar (tartiblangan)
 * @param ctx     { restaurantId, restaurantKind, fulfillment, paymentMethod, menuAmount, paidAmount, now }
 * @param usageOf (rule) => usage obyekti (bazasiz testlarda soxta)
 */
export function evaluateGifts(rules, ctx, usageOf = () => ({})) {
  const now = ctx.now || new Date();
  const gifts = [];
  let next = null;
  for (const rule of rules) {
    if (!isLive(rule, now) || !scopeMatches(rule, ctx)) continue;
    if (limitsBlock(rule, usageOf(rule))) continue;
    const amount = amountFor(rule, ctx);
    if (amount >= rule.minAmount && (!rule.maxAmount || amount <= rule.maxAmount)) {
      if (gifts.length < MAX_GIFT_LINES) gifts.push(giftLine(rule));
    } else if (amount < rule.minAmount && amount > 0) {
      const missing = rule.minAmount - amount;
      if (!next || missing < next.missing) {
        next = { ruleId: String(rule._id), itemName: rule.itemName, imageUrl: rule.imageUrl || '', quantity: rule.quantity || 1, minAmount: rule.minAmount, missing, basis: rule.basis };
      }
    }
  }
  // Oldindan ko'rishda "yana qoldi" faqat tegishli sovg'a hali yo'q bo'lsa foydali
  return { gifts, next: gifts.length ? null : next };
}

/** Buyurtmaga MUZLATILADIGAN qator (qoida keyin o'zgarsa ham eski buyurtma o'zgarmaydi) */
export const giftLine = (rule) => ({
  ruleId: rule._id, name: rule.name, itemName: rule.itemName, imageUrl: rule.imageUrl || '',
  quantity: rule.quantity || 1, reimburse: rule.reimburse || 0,
});
export const giftsCost = (items = []) => items.reduce((s, g) => s + (Number(g.reimburse) || 0) * (Number(g.quantity) || 0), 0);

/* ───────────── Bazadan ───────────── */
let rulesCache = { at: 0, rows: null };
const CACHE_MS = 20_000;
export const invalidateGiftCache = () => { rulesCache = { at: 0, rows: null }; };

export async function loadLiveRules(now = new Date()) {
  if (!rulesCache.rows || now.getTime() - rulesCache.at > CACHE_MS) {
    rulesCache = { at: now.getTime(), rows: await GiftBonus.find({ active: true }).sort({ createdAt: 1 }).limit(MAX_ACTIVE_RULES * 4).lean() };
  }
  return rulesCache.rows.filter((r) => isLive(r, now));
}

/** Band qilingan buyurtmalar: bekor qilinmagan va (to'lanmagan bo'lsa) yaqinda yaratilgan */
const countedFilter = (ruleId, now) => ({
  'bonusItems.ruleId': ruleId,
  $or: [
    { status: { $nin: ['cancelled', 'awaiting_payment'] } },
    { status: 'awaiting_payment', createdAt: { $gte: new Date(now.getTime() - ABANDONED_AFTER_MS) } },
  ],
});

/** Faqat chegarasi bor qoidalar uchun so'rov yuboriladi (qolganlari bepul) */
export async function usageFor(rule, userId, now = new Date()) {
  const need = { total: rule.totalLimit > 0, today: rule.dailyLimit > 0, ct: rule.perCustomerTotal > 0 && userId, cd: rule.perCustomerPerDay > 0 && userId, spent: rule.budget > 0 };
  if (!Object.values(need).some(Boolean)) return {};
  const base = countedFilter(rule._id, now);
  const dayStart = tashkent(now).dayStart;
  const [agg, today, customerTotal, customerToday] = await Promise.all([
    (need.total || need.spent) ? Order.aggregate([{ $match: base }, { $group: { _id: null, n: { $sum: 1 }, spent: { $sum: '$bonusCost' } } }]) : [],
    need.today ? Order.countDocuments({ ...base, createdAt: { $gte: dayStart } }) : 0,
    need.ct ? Order.countDocuments({ ...base, userId }) : 0,
    need.cd ? Order.countDocuments({ ...base, userId, createdAt: { $gte: dayStart } }) : 0,
  ]);
  return { total: agg[0]?.n || 0, spent: agg[0]?.spent || 0, today, customerTotal, customerToday };
}

/**
 * Buyurtma yaratishda: sovg'alar ro'yxati (muzlatiladigan qatorlar) va ularning qoplash summasi.
 * Har qanday xatoda bo'sh natija: bonus buyurtmani HECH QACHON to'xtatmasligi kerak.
 */
export async function resolveGifts({ restaurant, userId, menuAmount, paidAmount, fulfillment, paymentMethod, now = new Date() }) {
  try {
    const rules = await loadLiveRules(now);
    if (!rules.length) return { items: [], cost: 0 };
    const ctx = { restaurantId: restaurant._id, restaurantKind: restaurant.kind, fulfillment, paymentMethod, menuAmount, paidAmount, now };
    const candidates = rules.filter((r) => scopeMatches(r, ctx));
    const usage = new Map();
    for (const r of candidates) usage.set(String(r._id), await usageFor(r, userId, now));
    const { gifts } = evaluateGifts(candidates, ctx, (r) => usage.get(String(r._id)));
    return { items: gifts, cost: giftsCost(gifts) };
  } catch (e) {
    console.error('[giftBonus] hisoblanmadi (buyurtma bonussiz davom etadi):', e.message);
    return { items: [], cost: 0 };
  }
}

/** Mijoz savati uchun: har restoran guruhiga sovg'a va "yana X so'm" */
export async function quoteGifts({ groups, userId, fulfillment, paymentMethod, now = new Date() }) {
  const rules = await loadLiveRules(now);
  const out = [];
  for (const g of groups) {
    const ctx = { restaurantId: g.restaurantId, restaurantKind: g.restaurantKind, fulfillment, paymentMethod, menuAmount: g.menuAmount, paidAmount: g.paidAmount, now };
    const candidates = rules.filter((r) => scopeMatches(r, ctx));
    const usage = new Map();
    for (const r of candidates) usage.set(String(r._id), await usageFor(r, userId, now));
    const { gifts, next } = evaluateGifts(candidates, ctx, (r) => usage.get(String(r._id)));
    out.push({
      restaurantId: String(g.restaurantId),
      gifts: gifts.map((x) => ({ ruleId: String(x.ruleId), itemName: x.itemName, imageUrl: x.imageUrl, quantity: x.quantity })),
      next,
    });
  }
  return out;
}
