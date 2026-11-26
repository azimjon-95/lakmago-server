/*
 * ═══════════════════════════════════════════════════════════
 * TAOM TAKLIFLARI PUSH'I — mijoz ilovasi (Lokma Go, iOS/Android)
 * ═══════════════════════════════════════════════════════════
 *
 * Har daqiqa (index.js) tick(): faqat Settings.promoPush.enabled bo'lsa va tushlik/kechki oyna ochiq bo'lsa.
 *   1. Rozi (promoOptIn) + OS ruxsati bor + tokeni bor qurilmalardan o'z daqiqasi kelganlari olinadi
 *      (har qurilmaga oyna ichida o'z daqiqasi — hammaga bir paytda ketmaydi).
 *   2. Har biriga taom va matn tanlanadi (lib/promoPushPick.js: 14/7 kun takrorlanmaslik, aka-uka qurilmalar,
 *      hammaga har xil). Taom: hozir OCHIQ (va 45 daqiqadan keyin ham ochiq), yetkazadigan restoran, mijoz tumanida.
 *   3. Jurnalga (deviceId, day, slot) UNIQUE yozuv YUBORISHDAN OLDIN qo'yiladi — ikki marta ketmaydi
 *      (bir nechta pm2 nusxasi bo'lsa ham). So'ng FCM/APNs (services/mobilePush.js transporti).
 *
 * Xato hech qachon boshqa oqimni buzmaydi. Token logga yozilmaydi (6-qoida).
 * Buyurtma/to'lovga tegmaydi (1-qoida bu yerga tegishli emas: restoranga hech narsa yuborilmaydi).
 */
import { config } from '../config/index.js';
import { getSettings } from '../models/Settings.js';
import { CustomerDevice } from '../models/CustomerDevice.js';
import { PromoPushLog } from '../models/PromoPushLog.js';
import { Restaurant } from '../models/Restaurant.js';
import { Dish } from '../models/Dish.js';
import { User } from '../models/User.js';
import { sendFcm, sendApns, providers } from './mobilePush.js';
import { isRestaurantOpen } from './restaurantTime.js';
import { NOT_STORE, andWith } from './storeRules.js';
import { withDistrict } from './catalogDistrict.js';
import { districtFeatureOn } from './restaurantDistrict.js';
import { supportedDistrictIds } from './districtResolver.js';
import {
  pickPromo, tashkentParts, toMin, isDue, activeSlot, dayShift, TEMPLATE_COOLDOWN_DAYS, SLOTS,
} from '../lib/promoPushPick.js';
import { EXCLUDED_CATEGORIES } from '../lib/promoPushTemplates.js';

export const MAX_PER_TICK = 400;
const CONCURRENCY = 8;
const OPEN_AHEAD_MS = 45 * 60_000;
const FAIL_LIMIT = 5;

/* ───────── sozlamalar ───────── */
export const PROMO_DEFAULTS = { enabled: false, lunchFrom: '11:30', lunchTo: '12:30', dinnerFrom: '18:00', dinnerTo: '19:30' };

export async function getPromoSettings() {
  const s = await getSettings();
  return { ...PROMO_DEFAULTS, ...(s?.promoPush?.toObject?.() || s?.promoPush || {}) };
}

export function windowsOf(ps) {
  return {
    lunch: { from: toMin(ps.lunchFrom), to: toMin(ps.lunchTo) },
    dinner: { from: toMin(ps.dinnerFrom), to: toMin(ps.dinnerTo) },
  };
}

/** Admin kiritgan sozlamani tekshiradi; xato bo'lsa matn qaytaradi */
export function validatePromoSettings(ps) {
  const w = windowsOf(ps);
  for (const slot of SLOTS) {
    const { from, to } = w[slot];
    if (from == null || to == null) return 'Vaqt HH:MM ko‘rinishida bo‘lsin';
    if (to - from < 15) return 'Har oyna kamida 15 daqiqa bo‘lsin';
    if (from < 8 * 60 || to > 22 * 60) return 'Xabarlar faqat 08:00–22:00 oralig‘ida yuboriladi';
  }
  if (w.lunch.to > w.dinner.from) return 'Tushlik oynasi kechki oynadan oldin tugashi kerak';
  return null;
}

/* ───────── taom nomzodlari ───────── */
const districtOk = (d) => config.district?.catalogFilterEnabled && districtFeatureOn() && supportedDistrictIds().includes(d);

/** Cloudinary rasmini push uchun kichraytiradi (FCM rasmi ≤ 1 MB, https) */
export function pushImage(url) {
  const u = String(url || '');
  if (!/^https:\/\//.test(u)) return '';
  if (u.includes('res.cloudinary.com') && u.includes('/upload/') && !/\/upload\/[a-z]_/.test(u)) {
    return u.replace('/upload/', '/upload/c_fill,w_720,h_360,q_auto,f_jpg/');
  }
  return u;
}

/**
 * Hozir taklif qilsa bo'ladigan taomlar (tuman bo'yicha). ignoreOpen — admin namunasi uchun (kechasi ham ko'rinsin).
 */
export async function loadCandidates({ district = '', now = new Date(), ignoreOpen = false } = {}) {
  const filter = andWith({
    isApproved: true, isActive: true, isBlocked: { $ne: true }, isDemo: { $ne: true }, deliveryEnabled: { $ne: false },
  }, NOT_STORE);
  const rests = await Restaurant.find(districtOk(district) ? withDistrict(filter, district) : filter)
    .select('_id name openTime closeTime workingDays timezone').lean();
  const open = ignoreOpen ? rests : rests.filter((r) => isRestaurantOpen(r, now) && isRestaurantOpen(r, new Date(now.getTime() + OPEN_AHEAD_MS)));
  if (!open.length) return [];
  const names = new Map(open.map((r) => [String(r._id), r.name]));
  const dishes = await Dish.find({
    restaurantId: { $in: open.map((r) => r._id) },
    isAvailable: { $ne: false },
    price: { $gt: 0 },
    category: { $nin: EXCLUDED_CATEGORIES },
  }).select('_id name price category imageUrl isHit restaurantId').limit(5000).lean();
  return dishes.map((d) => ({
    dishId: String(d._id),
    name: d.name,
    price: d.price,
    category: d.category,
    restaurantId: String(d.restaurantId),
    restaurantName: names.get(String(d.restaurantId)) || '',
    imageUrl: d.imageUrl || '',
    hit: Boolean(d.isHit),
  }));
}

/* ───────── yuborish ───────── */
/** Platformaga mos xabar (toza; test qilinadi). data qiymatlari — faqat matn. */
export function buildPayload(platform, msg, { url, pp, imageUrl = '', now = new Date() }) {
  const data = { type: 'promo', url, pp: String(pp) };
  if (platform === 'android') {
    const image = pushImage(imageUrl);
    return {
      notification: { title: msg.title, body: msg.body, ...(image ? { image } : {}) },
      data,
      android: {
        priority: 'NORMAL',
        ttl: '3600s',                       // tushlik taklifi kechqurun kelmasin
        notification: { channel_id: 'promo', icon: 'ic_stat_lokma', color: '#FF5A00', tag: 'promo' },
      },
    };
  }
  return {
    payload: {
      aps: { alert: { title: msg.title, body: msg.body }, sound: 'default', 'thread-id': 'promo', 'relevance-score': 0.4 },
      ...data,
    },
    headers: {
      'apns-push-type': 'alert',
      'apns-priority': '10',          // ko'rinadigan xabar: darhol yetkazilsin (5 — Apple kechiktirishi mumkin)
      'apns-topic': config.customerApnsBundleId,
      'apns-expiration': String(Math.floor(now.getTime() / 1000) + 3600),
      'apns-collapse-id': 'lokma-promo',
    },
  };
}

/** Bitta qurilmaga yuboradi. iOS muhiti noma'lum bo'lsa: production → (BadDeviceToken) → sandbox. */
export async function deliver(device, msg, meta) {
  if (device.platform === 'android') return sendFcm(device.token, buildPayload('android', msg, meta));
  const { payload, headers } = buildPayload('ios', msg, meta);
  if (device.environment) return sendApns(device.token, payload, headers, device.environment);
  const prod = await sendApns(device.token, payload, headers, 'production');
  if (prod.ok) return { ...prod, environment: 'production' };
  if (!/BadDeviceToken/.test(prod.error || '')) return prod;
  const dev = await sendApns(device.token, payload, headers, 'development');
  return dev.ok ? { ...dev, environment: 'development' } : dev;
}

/** Qurilmaning o'ziga bog'liq bo'lmagan xatolar (tarmoq, Apple/Google nosozligi, sozlama) qurilmani o'chirmaydi */
export function isDeviceFault(res) {
  if (!res || res.ok || res.transient) return false;
  return !/APNs 40[13]|APNs 429|APNs 5\d\d|TopicDisallowed|MissingTopic|BadCertificate|InvalidProviderToken|ExpiredProviderToken|FCM (401|403|429|5\d\d)|timeout|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/i.test(res.error || '');
}

async function finishDevice(device, res) {
  const now = new Date();
  if (res.ok) {
    await CustomerDevice.updateOne({ _id: device._id }, {
      $set: { lastSentAt: now, lastError: '', failCount: 0, ...(res.environment ? { environment: res.environment } : {}) },
    });
  } else if (res.dead && !/DeviceTokenNotForTopic/.test(res.error || '')) {
    await CustomerDevice.updateOne({ _id: device._id }, { $set: { token: '', lastError: String(res.error || '').slice(0, 200) } });
  } else {
    // Sozlama/tarmoq xatosi (masalan bundle id noto'g'ri) tokenni ham, hisobni ham buzmaydi: faqat qurilma aybi sanaladi
    await CustomerDevice.updateOne({ _id: device._id }, {
      $set: { lastError: String(res.error || '').slice(0, 200) },
      ...(isDeviceFault(res) ? { $inc: { failCount: 1 } } : {}),
    });
  }
}

/**
 * Bitta qurilma uchun: tanlash → jurnalga da'vo → yuborish → natija.
 * @returns { status: 'sent' | 'failed' | 'skipped' | 'dup', pick }
 */
export async function sendOne({ device, slot, day, dishes, history, siblings, usage, now = new Date() }) {
  const pick = pickPromo({ device, slot, day, dishes, history, siblings, usage });
  const base = { deviceId: device.deviceId, userId: device.userId || null, day, slot, lang: device.lang };
  let log;
  try {
    log = await PromoPushLog.create(pick
      ? { ...base, templateId: pick.templateId, dishId: pick.dish.dishId, restaurantId: pick.dish.restaurantId, title: pick.title, body: pick.body, status: 'sending' }
      : { ...base, status: 'skipped', error: 'mos taom yo‘q' });
  } catch (e) {
    if (e?.code === 11000) return { status: 'dup', pick: null };
    throw e;
  }
  if (!pick) return { status: 'skipped', pick: null };
  usage.set(pick.templateId, (usage.get(pick.templateId) || 0) + 1);

  const res = await deliver(device, pick, { url: `/food/${pick.dish.dishId}`, pp: log._id, imageUrl: pick.dish.imageUrl, now })
    .catch((e) => ({ ok: false, error: e.message }));
  await PromoPushLog.updateOne({ _id: log._id }, {
    $set: res.ok ? { status: 'sent', sentAt: new Date() } : { status: 'failed', error: String(res.error || '').slice(0, 200) },
  });
  await finishDevice(device, res).catch(() => {});
  return { status: res.ok ? 'sent' : 'failed', pick };
}

async function pool(items, n, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const it = items[i++]; await fn(it); }
  });
  await Promise.all(workers);
}

/** Qurilmalar tarixi va aka-uka qurilmalar (bitta so'rov bilan) */
async function loadHistory(devices, day) {
  const ids = devices.map((d) => d.deviceId);
  const logs = await PromoPushLog.find({ deviceId: { $in: ids }, day: { $gt: dayShift(day, -TEMPLATE_COOLDOWN_DAYS) } })
    .select('deviceId day templateId dishId restaurantId').lean();
  const byDevice = new Map();
  for (const l of logs) { if (!byDevice.has(l.deviceId)) byDevice.set(l.deviceId, []); byDevice.get(l.deviceId).push(l); }
  const userIds = [...new Set(devices.map((d) => d.userId && String(d.userId)).filter(Boolean))];
  const sib = userIds.length
    ? await PromoPushLog.find({ userId: { $in: userIds }, day }).select('userId deviceId templateId dishId').lean()
    : [];
  return { byDevice, sib };
}

const usageMaps = new Map(); // `${day}|${slot}` → Map(templateId → n)
async function slotUsage(day, slot) {
  const key = `${day}|${slot}`;
  if (usageMaps.has(key)) return usageMaps.get(key);
  for (const k of usageMaps.keys()) if (!k.startsWith(day)) usageMaps.delete(k);
  const rows = await PromoPushLog.aggregate([
    { $match: { day, slot, templateId: { $gt: '' } } },
    { $group: { _id: '$templateId', n: { $sum: 1 } } },
  ]);
  const m = new Map(rows.map((r) => [r._id, r.n]));
  usageMaps.set(key, m);
  return m;
}

let running = false;
/** Har daqiqa chaqiriladi. Natija — statistika (log/test uchun). */
export async function promoPushTick(now = new Date()) {
  if (running) return { busy: true };
  running = true;
  try {
    const ps = await getPromoSettings();
    if (!ps.enabled) return { off: true };
    const prov = providers();
    if (!prov.android && !prov.ios) return { noProvider: true };
    const { day, minutes } = tashkentParts(now);
    const windows = windowsOf(ps);
    const slot = activeSlot(minutes, windows);
    if (!slot) return { idle: true };

    const platforms = [prov.android && 'android', prov.ios && 'ios'].filter(Boolean);
    const all = await CustomerDevice.find({
      promoOptIn: true, osPermission: 'granted', token: { $gt: '' }, failCount: { $lt: FAIL_LIMIT }, platform: { $in: platforms },
    }).select('deviceId token platform environment userId lang district').lean();
    const dueAll = all.filter((d) => isDue({ deviceId: d.deviceId, day, minutes, slot, window: windows[slot] }));
    if (!dueAll.length) return { slot, due: 0 };
    const done = new Set(await PromoPushLog.distinct('deviceId', { day, slot, deviceId: { $in: dueAll.map((d) => d.deviceId) } }));
    const due = dueAll.filter((d) => !done.has(d.deviceId)).slice(0, MAX_PER_TICK);
    if (!due.length) return { slot, due: 0 };

    const { byDevice, sib } = await loadHistory(due, day);
    const usage = await slotUsage(day, slot);
    const candCache = new Map();
    const cands = async (district) => {
      const key = districtOk(district) ? district : '';
      if (!candCache.has(key)) candCache.set(key, await loadCandidates({ district: key, now }));
      return candCache.get(key);
    };

    const stat = { slot, due: due.length, sent: 0, failed: 0, skipped: 0, dup: 0 };
    await pool(due, CONCURRENCY, async (device) => {
      try {
        const siblings = device.userId
          ? sib.filter((s) => String(s.userId) === String(device.userId) && s.deviceId !== device.deviceId) : [];
        const { status, pick } = await sendOne({
          device, slot, day, dishes: await cands(device.district), history: byDevice.get(device.deviceId) || [], siblings, usage, now,
        });
        stat[status] += 1;
        // Shu tick'da mijozning keyingi qurilmasi ham bu shablon/taomni olmasin
        if (pick && device.userId) sib.push({ userId: device.userId, deviceId: device.deviceId, templateId: pick.templateId, dishId: pick.dish.dishId });
      } catch (e) {
        stat.failed += 1;
        console.error('[promoPush] qurilma:', e.message);
      }
    });
    if (stat.sent || stat.failed) console.log(`[promoPush] ${day} ${slot}: yuborildi ${stat.sent}, xato ${stat.failed}, taom yo‘q ${stat.skipped}`);
    return stat;
  } finally {
    running = false;
  }
}

/* ───────── admin: namuna, sinov, statistika ───────── */
export async function previewMessages({ district = '', lang = 'uz', count = 8, now = new Date() } = {}) {
  const { day, minutes } = tashkentParts(now);
  const ps = await getPromoSettings();
  const slot = activeSlot(minutes, windowsOf(ps)) || (minutes < 15 * 60 ? 'lunch' : 'dinner');
  const dishes = await loadCandidates({ district, now, ignoreOpen: true });
  const usage = new Map();
  const out = [];
  for (let i = 0; i < Math.min(20, Math.max(1, count)); i++) {
    const p = pickPromo({ device: { deviceId: `preview-${i}-${Date.now()}`, lang }, slot, day, dishes, usage });
    if (!p) break;
    usage.set(p.templateId, (usage.get(p.templateId) || 0) + 1);
    out.push({ templateId: p.templateId, title: p.title, body: p.body, dish: p.dish.name, restaurant: p.dish.restaurantName, url: `/food/${p.dish.dishId}` });
  }
  return { slot, candidates: dishes.length, items: out };
}

/** Admin: mijozning qurilmalariga hozir sinov push (kunlik hisobga kirmaydi) */
export async function sendTest({ userId, phone, now = new Date() }) {
  let uid = userId;
  if (!uid && phone) {
    const digits = String(phone).replace(/\D/g, '').slice(-9);
    const u = digits.length === 9 ? await User.findOne({ phone: { $regex: `${digits}$` } }).select('_id').lean() : null;
    uid = u?._id;
  }
  if (!uid) return { error: 'Mijoz topilmadi' };
  const devices = await CustomerDevice.find({ userId: uid, token: { $gt: '' } }).lean();
  if (!devices.length) return { error: 'Bu mijozning push yoqilgan qurilmasi yo‘q (ilovaga kirib, bildirishnomaga ruxsat bergan bo‘lishi kerak)' };
  const { day } = tashkentParts(now);
  const dishes = await loadCandidates({ district: devices[0].district, now, ignoreOpen: true });
  const results = [];
  const usage = new Map();
  const { byDevice } = await loadHistory(devices, day);
  for (const device of devices) {
    const pick = pickPromo({ device, slot: 'lunch', day, dishes, history: byDevice.get(device.deviceId) || [], usage });
    if (!pick) { results.push({ platform: device.platform, ok: false, error: 'mos taom yo‘q' }); continue; }
    usage.set(pick.templateId, 1);
    const log = await PromoPushLog.create({
      deviceId: device.deviceId, userId: device.userId, day, slot: 'test', lang: device.lang,
      templateId: pick.templateId, dishId: pick.dish.dishId, restaurantId: pick.dish.restaurantId, title: pick.title, body: pick.body,
    });
    const res = await deliver(device, pick, { url: `/food/${pick.dish.dishId}`, pp: log._id, imageUrl: pick.dish.imageUrl, now })
      .catch((e) => ({ ok: false, error: e.message }));
    await PromoPushLog.updateOne({ _id: log._id }, { $set: res.ok ? { status: 'sent', sentAt: new Date() } : { status: 'failed', error: String(res.error || '') } });
    await finishDevice(device, res).catch(() => {});
    results.push({ platform: device.platform, ok: res.ok, error: res.ok ? '' : res.error, title: pick.title, body: pick.body });
  }
  return { results };
}

export async function promoStats(now = new Date()) {
  const { day } = tashkentParts(now);
  const weekAgo = dayShift(day, -6);
  const [devices, reachable, byPlatform, todayRows, weekRows] = await Promise.all([
    CustomerDevice.countDocuments({}),
    CustomerDevice.countDocuments({ promoOptIn: true, osPermission: 'granted', token: { $gt: '' }, failCount: { $lt: FAIL_LIMIT } }),
    CustomerDevice.aggregate([{ $group: { _id: { p: '$platform', ok: { $and: ['$promoOptIn', { $eq: ['$osPermission', 'granted'] }] } }, n: { $sum: 1 } } }]),
    PromoPushLog.aggregate([
      { $match: { day, slot: { $in: SLOTS } } },
      { $group: { _id: { slot: '$slot', status: '$status' }, n: { $sum: 1 }, opened: { $sum: { $cond: [{ $ifNull: ['$openedAt', false] }, 1, 0] } } } },
    ]),
    PromoPushLog.aggregate([
      { $match: { day: { $gte: weekAgo }, slot: { $in: SLOTS }, status: 'sent' } },
      { $group: { _id: null, sent: { $sum: 1 }, opened: { $sum: { $cond: [{ $ifNull: ['$openedAt', false] }, 1, 0] } } } },
    ]),
  ]);
  const today = { lunch: { sent: 0, failed: 0, skipped: 0, opened: 0 }, dinner: { sent: 0, failed: 0, skipped: 0, opened: 0 } };
  for (const r of todayRows) {
    const t = today[r._id.slot];
    if (!t) continue;
    if (r._id.status in t) t[r._id.status] += r.n;
    t.opened += r.opened;
  }
  const platforms = { android: { all: 0, on: 0 }, ios: { all: 0, on: 0 } };
  for (const r of byPlatform) {
    const p = platforms[r._id.p];
    if (!p) continue;
    p.all += r.n;
    if (r._id.ok) p.on += r.n;
  }
  const w = weekRows[0] || { sent: 0, opened: 0 };
  return {
    day, devices, reachable, platforms, today,
    week: { sent: w.sent, opened: w.opened, ctr: w.sent ? Math.round((w.opened / w.sent) * 1000) / 10 : 0 },
    providers: providers(),
  };
}
