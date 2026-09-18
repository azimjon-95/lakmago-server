import { z } from 'zod';
import { asyncHandler } from '../middleware/error.js';
import { BotBroadcast } from '../models/BotBroadcast.js';
import {
  sendBroadcast, getBroadcastStats, listBotRestaurants,
} from '../services/botBroadcast.js';

/*
 * ═══════════════════════════════════════════════════════════
 * RESTORAN BOTLARI — ADMIN BOSHQARUVI
 * ═══════════════════════════════════════════════════════════
 *
 * Faqat admin uchun. Mavjud endpointlarga tegilmaydi —
 * hammasi yangi `/admin/bot/...` yo'llari ostida.
 */

const buttonSchema = z.object({
  text: z.string().trim().min(1).max(64),
  kind: z.enum(['callback', 'url']).default('callback'),
  url: z.string().trim().max(500).optional().default(''),
}).refine(
  (b) => b.kind !== 'url' || /^https?:\/\//i.test(b.url),
  { message: 'Havola tugmasi uchun to‘g‘ri URL kerak (https://...)' },
);

const broadcastSchema = z.object({
  title: z.string().trim().max(120).optional().default(''),
  text: z.string().trim().min(1, 'Matn bo‘sh').max(3500),
  format: z.enum(['html', 'none']).default('html'),
  buttons: z.array(buttonSchema).max(6).optional().default([]),
  target: z.enum(['all', 'selected']).default('all'),
  restaurantIds: z.array(z.string().regex(/^[a-f\d]{24}$/i)).optional().default([]),
});

export const botBroadcastController = {
  /** GET /admin/bot/restaurants — botga ulangan restoranlar */
  restaurants: asyncHandler(async (_req, res) => {
    res.json(await listBotRestaurants());
  }),

  /** GET /admin/bot/broadcasts — yuborilgan xabarlar tarixi */
  list: asyncHandler(async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 30, 100);
    const items = await BotBroadcast.find()
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();
    res.json(items);
  }),

  /** GET /admin/bot/broadcasts/:id — statistika bilan */
  detail: asyncHandler(async (req, res) => {
    const data = await getBroadcastStats(req.params.id);
    if (!data) return res.status(404).json({ error: 'Xabar topilmadi' });
    res.json(data);
  }),

  /**
   * POST /admin/bot/broadcasts — yaratish va DARHOL yuborish.
   *
   * Yuborish javobni kutmaydi: 50+ xodimga yuborish bir necha
   * soniya olishi mumkin, admin esa darhol javob olishi kerak.
   * Holat `status` orqali kuzatiladi.
   */
  create: asyncHandler(async (req, res) => {
    const parsed = broadcastSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'Noto‘g‘ri ma‘lumot',
        details: parsed.error.flatten(),
      });
    }

    const data = parsed.data;
    if (data.target === 'selected' && !data.restaurantIds.length) {
      return res.status(400).json({ error: 'Kamida bitta restoran tanlang' });
    }

    // Tugmalarga barqaror kalit beramiz — statistika shu bo'yicha
    const buttons = data.buttons.map((b, i) => ({
      text: b.text,
      kind: b.kind,
      url: b.kind === 'url' ? b.url : '',
      key: `b${i + 1}`,
    }));

    const broadcast = await BotBroadcast.create({
      ...data,
      buttons,
      createdBy: req.userId || null,
      createdByName: req.user?.login || req.user?.firstName || 'admin',
    });

    // Fon rejimida yuboriladi
    sendBroadcast(broadcast._id).catch(async (e) => {
      console.error('[bot-broadcast] yuborish:', e.message);
      await BotBroadcast.updateOne(
        { _id: broadcast._id },
        { $set: { status: 'failed', error: e.message } },
      ).catch(() => {});
    });

    res.status(201).json(broadcast);
  }),

  /** DELETE /admin/bot/broadcasts/:id — tarixdan o'chirish */
  remove: asyncHandler(async (req, res) => {
    const doc = await BotBroadcast.findById(req.params.id).select('status').lean();
    if (!doc) return res.status(404).json({ error: 'Xabar topilmadi' });
    if (doc.status === 'sending') {
      return res.status(409).json({ error: 'Yuborilayotgan xabarni o‘chirib bo‘lmaydi' });
    }

    const { BotBroadcastDelivery } = await import('../models/BotBroadcast.js');
    await BotBroadcastDelivery.deleteMany({ broadcastId: req.params.id });
    await BotBroadcast.deleteOne({ _id: req.params.id });
    res.json({ ok: true });
  }),
};
