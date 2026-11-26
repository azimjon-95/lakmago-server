import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { config } from '../config/index.js';
import { getSettings } from '../models/Settings.js';
import { CustomerDevice } from '../models/CustomerDevice.js';
import { PromoPushLog } from '../models/PromoPushLog.js';
import { readClient } from '../services/clientChannel.js';
import { asyncHandler } from '../middleware/error.js';
import {
  getPromoSettings, validatePromoSettings, previewMessages, sendTest, promoStats, PROMO_DEFAULTS,
} from '../services/promoPush.js';

/*
 * Mijoz ilovasi push'i API.
 *   POST /app/push/register  — token + til + tuman + rozilik (mehmon ham: hisob shart emas, 4-qoida)
 *   POST /app/push/prefs     — rozilikni yoqish/o'chirish, til/tuman yangilash
 *   POST /app/push/opened    — bildirishnoma bosildi (statistika)
 * Qurilma — FAQAT X-Lokma-Device izidan (native ilova); body'dagi qurilma ID'siga ishonilmaydi.
 */

const LANGS = ['uz', 'uzc', 'ru'];
const PERMS = ['granted', 'denied', 'prompt', 'unknown'];

/** Bearer bo'lsa — mijoz userId (bo'lmasa null; xato token ham null — ro'yxatdan o'tish to'xtamaydi) */
function softUserId(req) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) return null;
  try {
    const p = jwt.verify(h.slice(7), config.jwtSecret);
    if (p?.role && p.role !== 'customer') return null;
    return mongoose.isValidObjectId(p?.userId) ? p.userId : null;
  } catch { return null; }
}

function commonFields(body) {
  const set = {};
  if (LANGS.includes(body?.lang)) set.lang = body.lang;
  if (typeof body?.district === 'string' && /^[a-z0-9_-]{0,40}$/.test(body.district)) set.district = body.district;
  if (PERMS.includes(body?.permission)) set.osPermission = body.permission;
  return set;
}

export const promoPushController = {
  register: asyncHandler(async (req, res) => {
    const client = readClient(req);
    if (!client.deviceId || !['ios', 'android'].includes(client.channel)) {
      return res.status(400).json({ error: 'Faqat Lokma Go ilovasidan' });
    }
    const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
    if (!/^[A-Za-z0-9_:.\-]{20,4096}$/.test(token)) return res.status(400).json({ error: 'Token noto‘g‘ri' });

    const set = {
      ...commonFields(req.body), token, platform: client.channel, lastSeen: new Date(), failCount: 0, lastError: '',
    };
    if (client.appVersion) set.appVersion = client.appVersion;
    const uid = softUserId(req);
    if (uid) set.userId = uid;
    if (typeof req.body?.optIn === 'boolean') set.promoOptIn = req.body.optIn;
    // Token yangilansa iOS muhiti qayta aniqlanadi
    const prev = await CustomerDevice.findOne({ deviceId: client.deviceId }).select('token consentAt').lean();
    if (prev && prev.token !== token) set.environment = null;
    if (set.promoOptIn && !prev?.consentAt) set.consentAt = new Date();

    // Shu token boshqa qurilma yozuvida bo'lsa (qayta o'rnatish) — u yerdan olinadi
    await CustomerDevice.updateMany({ token, deviceId: { $ne: client.deviceId } }, { $set: { token: '' } });
    await CustomerDevice.updateOne({ deviceId: client.deviceId }, { $set: set, $setOnInsert: { deviceId: client.deviceId } }, { upsert: true });
    res.json({ ok: true });
  }),

  prefs: asyncHandler(async (req, res) => {
    const client = readClient(req);
    if (!client.deviceId) return res.status(400).json({ error: 'Faqat Lokma Go ilovasidan' });
    const set = { ...commonFields(req.body), lastSeen: new Date() };
    if (typeof req.body?.optIn === 'boolean') {
      set.promoOptIn = req.body.optIn;
      if (req.body.optIn) set.consentAt = new Date();
    }
    const uid = softUserId(req);
    if (uid) set.userId = uid;
    const r = await CustomerDevice.updateOne({ deviceId: client.deviceId }, { $set: set });
    res.json({ ok: true, known: r.matchedCount > 0 });
  }),

  opened: asyncHandler(async (req, res) => {
    const client = readClient(req);
    const pp = String(req.body?.pp || '');
    if (!client.deviceId || !mongoose.isValidObjectId(pp)) return res.json({ ok: false });
    const now = new Date();
    const r = await PromoPushLog.updateOne({ _id: pp, deviceId: client.deviceId, openedAt: null }, { $set: { openedAt: now } });
    if (r.modifiedCount) await CustomerDevice.updateOne({ deviceId: client.deviceId }, { $set: { lastOpenedAt: now } });
    res.json({ ok: true });
  }),

  /* ─── admin ─── */
  adminGet: asyncHandler(async (req, res) => {
    const [settings, stats] = await Promise.all([getPromoSettings(), promoStats()]);
    res.json({ settings, stats });
  }),

  adminUpdate: asyncHandler(async (req, res) => {
    const cur = await getPromoSettings();
    const next = { ...cur };
    for (const k of Object.keys(PROMO_DEFAULTS)) {
      if (k === 'enabled') { if (typeof req.body?.enabled === 'boolean') next.enabled = req.body.enabled; }
      else if (typeof req.body?.[k] === 'string') next[k] = req.body[k].trim();
    }
    const err = validatePromoSettings(next);
    if (err) return res.status(400).json({ error: err });
    const s = await getSettings();
    s.promoPush = next;
    await s.save();
    res.json({ settings: await getPromoSettings() });
  }),

  adminPreview: asyncHandler(async (req, res) => {
    const lang = LANGS.includes(req.body?.lang) ? req.body.lang : 'uz';
    const district = typeof req.body?.district === 'string' ? req.body.district : '';
    res.json(await previewMessages({ lang, district, count: Number(req.body?.count) || 8 }));
  }),

  adminTest: asyncHandler(async (req, res) => {
    const userId = mongoose.isValidObjectId(req.body?.userId) ? req.body.userId : null;
    const phone = typeof req.body?.phone === 'string' ? req.body.phone : '';
    const r = await sendTest({ userId, phone });
    if (r.error) return res.status(404).json({ error: r.error });
    res.json(r);
  }),
};
