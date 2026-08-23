import { z } from 'zod';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { asyncHandler } from '../middleware/error.js';
import { KioskToken } from '../models/KioskToken.js';
import { DineInConfig } from '../models/DineIn.js';
import { Restaurant } from '../models/Restaurant.js';
import { config } from '../config/index.js';

const rid = (req) => req.restaurantId;

/** Tokenning qisqartirilgan ko'rinishi — ro'yxatda ko'rsatish uchun. */
const short = (t) => `${t.slice(0, 6)}…${t.slice(-4)}`;

/**
 * Panelga qaytariladigan ko'rinish.
 * To'liq token FAQAT yaratilganda va "nusxalash" so'ralganda
 * beriladi — ro'yxatda qisqartirilgan holda turadi.
 */
function toPanel(doc, { withToken = false } = {}) {
  const o = doc.toObject ? doc.toObject() : doc;
  const expired = o.expiresAt && new Date(o.expiresAt).getTime() < Date.now();

  return {
    _id: o._id,
    label: o.label,
    tokenShort: short(o.token),
    ...(withToken && { token: o.token }),
    expiresAt: o.expiresAt,
    isActive: o.isActive,
    status: !o.isActive ? 'disabled' : expired ? 'expired' : 'active',
    deviceLimit: o.deviceLimit,
    deviceCount: o.devices?.length || 0,
    devices: (o.devices || []).map((d) => ({
      label: d.label,
      firstSeenAt: d.firstSeenAt,
      lastSeenAt: d.lastSeenAt,
    })),
    sections: o.sections,
    autoFullscreen: o.autoFullscreen,
    inactivitySec: o.inactivitySec,
    lastUsedAt: o.lastUsedAt,
    createdAt: o.createdAt,
  };
}

const pinSchema = z.string().regex(/^\d{4}$/, 'PIN 4 ta raqamdan iborat bo\u2018lishi kerak');

const settingsSchema = z.object({
  label: z.string().max(60).optional(),
  expiresInDays: z.number().int().min(1).max(365).optional(),
  pin: pinSchema.optional(),
  deviceLimit: z.number().int().min(0).max(20).optional(),
  sections: z.array(z.enum(['tables', 'stoplist', 'menu'])).min(1).optional(),
  autoFullscreen: z.boolean().optional(),
  inactivitySec: z.number().int().min(15).max(3600).optional(),
});

export const kioskController = {
  // ═══════════════ RESTORAN PANELI ═══════════════

  // GET /api/panel/kiosk
  list: asyncHandler(async (req, res) => {
    const items = await KioskToken.find({ restaurantId: rid(req) })
      .sort({ createdAt: -1 });
    res.json(items.map((d) => toPanel(d)));
  }),

  // POST /api/panel/kiosk
  create: asyncHandler(async (req, res) => {
    const parsed = settingsSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: parsed.error.issues[0]?.message || 'Ma\u2018lumot noto\u2018g\u2018ri',
      });
    }

    // Dine-in yoqilmagan bo'lsa kiosk ma'nosiz — stollar yo'q
    const cfg = await DineInConfig.findOne({ restaurantId: rid(req) }).lean();
    if (!cfg || cfg.status !== 'active') {
      return res.status(403).json({ error: 'Dine-in xizmati faol emas' });
    }

    // Cheklov: bitta restoranda 20 tadan ko'p faol link kerak emas,
    // bu — tasodifan yuzlab token yaratib qo'yishdan himoya
    const count = await KioskToken.countDocuments({ restaurantId: rid(req) });
    if (count >= 20) {
      return res.status(400).json({ error: 'Kiosk linklar soni chegarasi (20) to\u2018ldi' });
    }

    const days = parsed.data.expiresInDays ?? 30;
    const pin = parsed.data.pin ?? String(Math.floor(1000 + Math.random() * 9000));

    const doc = await KioskToken.create({
      restaurantId: rid(req),
      label: parsed.data.label || '',
      token: KioskToken.generateToken(),
      pinHash: await bcrypt.hash(pin, 10),
      expiresAt: new Date(Date.now() + days * 86400_000),
      deviceLimit: parsed.data.deviceLimit ?? 0,
      sections: parsed.data.sections ?? ['tables', 'stoplist', 'menu'],
      autoFullscreen: parsed.data.autoFullscreen ?? true,
      inactivitySec: parsed.data.inactivitySec ?? 120,
      createdBy: req.userId || null,
    });

    // PIN faqat SHU JAVOBDA ochiq ko'rinadi — keyin bazada
    // faqat hash qoladi va qayta ko'rsatib bo'lmaydi
    res.status(201).json({ ...toPanel(doc, { withToken: true }), pin });
  }),

  // GET /api/panel/kiosk/:id/reveal — to'liq linkni olish
  reveal: asyncHandler(async (req, res) => {
    const doc = await KioskToken.findOne({ _id: req.params.id, restaurantId: rid(req) });
    if (!doc) return res.status(404).json({ error: 'Link topilmadi' });
    res.json(toPanel(doc, { withToken: true }));
  }),

  // PATCH /api/panel/kiosk/:id
  update: asyncHandler(async (req, res) => {
    const schema = settingsSchema.extend({ isActive: z.boolean().optional() });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: parsed.error.issues[0]?.message || 'Ma\u2018lumot noto\u2018g\u2018ri',
      });
    }

    const doc = await KioskToken.findOne({ _id: req.params.id, restaurantId: rid(req) });
    if (!doc) return res.status(404).json({ error: 'Link topilmadi' });

    const d = parsed.data;
    if (d.label !== undefined) doc.label = d.label;
    if (d.deviceLimit !== undefined) doc.deviceLimit = d.deviceLimit;
    if (d.sections) doc.sections = d.sections;
    if (d.autoFullscreen !== undefined) doc.autoFullscreen = d.autoFullscreen;
    if (d.inactivitySec !== undefined) doc.inactivitySec = d.inactivitySec;
    if (d.isActive !== undefined) doc.isActive = d.isActive;
    if (d.expiresInDays) doc.expiresAt = new Date(Date.now() + d.expiresInDays * 86400_000);

    if (d.pin) {
      doc.pinHash = await bcrypt.hash(d.pin, 10);
      // Yangi PIN qo'yilganda bloklash tushiriladi
      doc.pinFails = 0;
      doc.pinBlockedUntil = null;
    }

    // Qurilma chegarasi kichraytirilsa — ortiqchalari uziladi.
    // Aks holda eski planshetlar chegaradan tashqarida ishlab
    // turaverardi va cheklovning ma'nosi qolmasdi.
    if (doc.deviceLimit > 0 && doc.devices.length > doc.deviceLimit) {
      doc.devices = doc.devices
        .sort((a, b) => new Date(b.lastSeenAt) - new Date(a.lastSeenAt))
        .slice(0, doc.deviceLimit);
    }

    await doc.save();
    res.json(toPanel(doc));
  }),

  /**
   * POST /api/panel/kiosk/:id/rotate
   *
   * Eski token DARHOL bekor bo'ladi — planshet yo'qolganda
   * yoki link tarqalib ketganda ishlatiladi.
   */
  rotate: asyncHandler(async (req, res) => {
    const doc = await KioskToken.findOne({ _id: req.params.id, restaurantId: rid(req) });
    if (!doc) return res.status(404).json({ error: 'Link topilmadi' });

    doc.token = KioskToken.generateToken();
    doc.devices = [];          // bog'langan qurilmalar ham uziladi
    doc.pinFails = 0;
    doc.pinBlockedUntil = null;
    await doc.save();

    res.json(toPanel(doc, { withToken: true }));
  }),

  // POST /api/panel/kiosk/:id/reset-devices
  resetDevices: asyncHandler(async (req, res) => {
    const doc = await KioskToken.findOneAndUpdate(
      { _id: req.params.id, restaurantId: rid(req) },
      { devices: [] },
      { new: true },
    );
    if (!doc) return res.status(404).json({ error: 'Link topilmadi' });
    res.json(toPanel(doc));
  }),

  // DELETE /api/panel/kiosk/:id
  remove: asyncHandler(async (req, res) => {
    const doc = await KioskToken.findOneAndDelete({
      _id: req.params.id, restaurantId: rid(req),
    });
    if (!doc) return res.status(404).json({ error: 'Link topilmadi' });
    res.json({ deleted: true });
  }),

  // ═══════════════ KIOSK SAHIFASI ═══════════════

  /**
   * GET /api/kiosk/validate/:token
   *
   * Sahifa ochilishida chaqiriladi. Sir ma'lumot qaytarmaydi —
   * faqat "ishlaydimi yoki yo'q" va ko'rinish sozlamalari.
   */
  validate: asyncHandler(async (req, res) => {
    const doc = await KioskToken.findOne({ token: String(req.params.token || '') });
    if (!doc) {
      return res.status(404).json({ error: 'Link topilmadi', code: 'NOT_FOUND' });
    }

    const reason = doc.usableReason();
    if (reason) {
      return res.status(403).json({
        error: reason === 'expired'
          ? 'Link muddati tugagan'
          : 'Link o\u2018chirilgan',
        code: reason.toUpperCase(),
      });
    }

    const cfg = await DineInConfig.findOne({ restaurantId: doc.restaurantId }).lean();
    if (!cfg || cfg.status !== 'active') {
      return res.status(403).json({
        error: 'Dine-in xizmati faol emas', code: 'DINEIN_INACTIVE',
      });
    }

    const restaurant = await Restaurant.findById(doc.restaurantId)
      .select('name imageUrl').lean();

    res.json({
      valid: true,
      label: doc.label,
      restaurant: { id: String(doc.restaurantId), name: restaurant?.name || '', imageUrl: restaurant?.imageUrl },
      sections: doc.sections,
      autoFullscreen: doc.autoFullscreen,
      inactivitySec: doc.inactivitySec,
    });
  }),

  /**
   * POST /api/kiosk/session  { token, deviceId, deviceLabel }
   *
   * Kiosk JWT beradi. PIN SO'RALMAYDI — TZ bo'yicha yaroqli
   * link darhol ochiladi, PIN faqat uzoq tegilmagandan keyin
   * qulfni ochish uchun kerak.
   */
  session: asyncHandler(async (req, res) => {
    const { token, deviceId, deviceLabel } = req.body || {};
    if (!token || !deviceId) {
      return res.status(400).json({ error: 'Ma\u2018lumot yetarli emas' });
    }

    const doc = await KioskToken.findOne({ token: String(token) });
    if (!doc) return res.status(404).json({ error: 'Link topilmadi', code: 'NOT_FOUND' });

    const reason = doc.usableReason();
    if (reason) {
      return res.status(403).json({
        error: reason === 'expired' ? 'Link muddati tugagan' : 'Link o\u2018chirilgan',
        code: reason.toUpperCase(),
      });
    }

    const cfg = await DineInConfig.findOne({ restaurantId: doc.restaurantId }).lean();
    if (!cfg || cfg.status !== 'active') {
      return res.status(403).json({ error: 'Dine-in xizmati faol emas', code: 'DINEIN_INACTIVE' });
    }

    const device = String(deviceId).slice(0, 120);
    const existing = doc.devices.find((d) => d.deviceId === device);

    // ===== QURILMA CHEKLOVI =====
    if (!existing && doc.deviceLimit > 0 && doc.devices.length >= doc.deviceLimit) {
      return res.status(403).json({
        error: `Bu link ${doc.deviceLimit} ta qurilmaga bog\u2018langan. `
          + 'Administrator qurilmalarni tozalashi kerak.',
        code: 'DEVICE_LIMIT',
      });
    }

    if (existing) {
      existing.lastSeenAt = new Date();
      if (deviceLabel) existing.label = String(deviceLabel).slice(0, 100);
    } else {
      doc.devices.push({
        deviceId: device,
        label: String(deviceLabel || '').slice(0, 100),
      });
    }

    doc.lastUsedAt = new Date();
    await doc.save();

    const restaurant = await Restaurant.findById(doc.restaurantId)
      .select('name imageUrl').lean();

    // Muddati tokenning o'z muddatidan OSHMAYDI — link
    // muddati tugagach eski JWT bilan ishlab bo'lmasin
    const ttlSec = Math.max(
      60,
      Math.floor((new Date(doc.expiresAt).getTime() - Date.now()) / 1000),
    );

    const jwtToken = jwt.sign(
      {
        role: 'kiosk',
        kioskId: String(doc._id),
        restaurantId: String(doc.restaurantId),
        deviceId: device,
        sections: doc.sections,
      },
      config.jwtSecret,
      { expiresIn: Math.min(ttlSec, 30 * 86400) },
    );

    res.json({
      token: jwtToken,
      label: doc.label,
      restaurant: { id: String(doc.restaurantId), name: restaurant?.name || '', imageUrl: restaurant?.imageUrl },
      sections: doc.sections,
      autoFullscreen: doc.autoFullscreen,
      inactivitySec: doc.inactivitySec,
    });
  }),

  /**
   * POST /api/kiosk/pin  { pin }   (kioskAuth)
   *
   * Qulfni ochish. Brute-force himoyasi SERVERDA:
   * 3 xato → 30 soniya blok. Brauzerdagi hisobni tozalash
   * yordam bermaydi.
   */
  verifyPin: asyncHandler(async (req, res) => {
    const doc = await KioskToken.findById(req.kioskId);
    if (!doc) return res.status(404).json({ error: 'Link topilmadi' });

    const reason = doc.usableReason();
    if (reason) {
      return res.status(403).json({
        error: reason === 'expired' ? 'Link muddati tugagan' : 'Link o\u2018chirilgan',
        code: reason.toUpperCase(),
      });
    }

    if (doc.pinBlockedUntil && doc.pinBlockedUntil.getTime() > Date.now()) {
      const sec = Math.ceil((doc.pinBlockedUntil.getTime() - Date.now()) / 1000);
      return res.status(429).json({
        error: `Ko\u2018p marta xato. ${sec} soniyadan keyin urinib ko\u2018ring.`,
        code: 'PIN_BLOCKED',
        retryAfter: sec,
      });
    }

    const pin = String(req.body?.pin || '');
    const ok = /^\d{4}$/.test(pin) && await bcrypt.compare(pin, doc.pinHash);

    if (!ok) {
      doc.pinFails += 1;
      if (doc.pinFails >= 3) {
        doc.pinBlockedUntil = new Date(Date.now() + 30_000);
        doc.pinFails = 0;
      }
      await doc.save();

      return res.status(401).json({
        error: 'PIN noto\u2018g\u2018ri',
        code: 'PIN_WRONG',
        ...(doc.pinBlockedUntil && { retryAfter: 30 }),
      });
    }

    doc.pinFails = 0;
    doc.pinBlockedUntil = null;
    doc.lastUsedAt = new Date();
    await doc.save();

    res.json({ ok: true });
  }),

  /**
   * GET /api/kiosk/me  (kioskAuth)
   *
   * Sahifa "tirikligini" tekshiradi — admin tokenni o'chirsa
   * yoki muddati tugasa kiosk buni bilib, qulflanadi.
   */
  me: asyncHandler(async (req, res) => {
    const doc = await KioskToken.findById(req.kioskId).lean();
    if (!doc) return res.status(404).json({ error: 'Link topilmadi', code: 'NOT_FOUND' });

    const expired = new Date(doc.expiresAt).getTime() < Date.now();
    if (!doc.isActive || expired) {
      return res.status(403).json({
        error: expired ? 'Link muddati tugagan' : 'Link o\u2018chirilgan',
        code: expired ? 'EXPIRED' : 'DISABLED',
      });
    }

    const restaurant = await Restaurant.findById(doc.restaurantId)
      .select('name imageUrl').lean();

    res.json({
      label: doc.label,
      restaurantId: String(doc.restaurantId),
      restaurant: { name: restaurant?.name || '', imageUrl: restaurant?.imageUrl },
      sections: doc.sections,
      autoFullscreen: doc.autoFullscreen,
      inactivitySec: doc.inactivitySec,
    });
  }),
};
