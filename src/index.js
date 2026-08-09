import express from 'express';
import { createServer } from 'http';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import { config, connectDB, isAllowedOrigin } from './config/index.js';
import { router } from './routes/index.js';
import { errorHandler, notFound } from './middleware/error.js';
import { initSocket } from './sockets/io.js';
import { handleBotUpdate } from './services/telegram.js';
import { ensureDefaultAdmin } from './services/bootstrap.js';
import { initPush } from './services/push.js';

async function main() {
  await connectDB();

  // Default admin (dastur egasi) akkauntini yaratish/tekshirish
  await ensureDefaultAdmin();

  const app = express();
  // Nginx orqali ishlaganда (reverse proxy) — haqiqий protokol/IP ni oladi.
  // Shu tufayli req.protocol 'https' bo'ladi va /diag to'g'ri ko'rsatadi.
  app.set('trust proxy', 1);
  const httpServer = createServer(app);

  app.use(helmet());
  app.use(compression()); // Gzip/Brotli — javoblar siqiladi (tarmoq tez)
  // CORS — ruxsat etilmagan domen uchun XATO TASHLAMAYMIZ.
  // Xato tashlansa Express uni ushlamaydi: log to'ladi va 500 qaytadi.
  // To'g'ri yo'l — cb(null, false): brauzer o'zi bloklaydi, server tinch.
  const rejectedOrigins = new Set(); // takroriy logni oldini olish
  app.use(cors({
    origin: (origin, cb) => {
      if (isAllowedOrigin(origin)) return cb(null, true);
      // Har domen uchun bir marta ogohlantiramiz
      if (origin && !rejectedOrigins.has(origin)) {
        rejectedOrigins.add(origin);
        console.warn(`[CORS] ruxsat etilmagan domen: ${origin}\n` +
          '        Ruxsat berish uchun .env ga qo\'shing:\n' +
          `        CORS_ORIGINS=${origin}   (admin panel uchun)\n` +
          `        WEBAPP_URL=${origin}     (mijoz webapp uchun)`);
      }
      return cb(null, false);
    },
    credentials: true,
  }));
  app.use(express.json());
  app.use(morgan('dev'));

  // Ildiz — server ishlayotganini bildiradi (404 log to'ldirmasin)
  app.get('/', (_req, res) => res.json({
    service: 'LokmaGo API',
    status: 'ok',
    docs: '/health · /diag · /diag/telegram',
  }));

  app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'lokmago-api' }));

  // Diagnostika — sozlamаlar to'g'rimi tekshirish (maxfiy ma'lumot ko'rsatilmaydi)
  // Telegram webhook holatini tekshirish — guruh muammosini topish uchun
  // Taom modeli qaysi maydonlarni biladi — server yangilanganini tekshirish
  // Inline ulashish tayyormi — barcha shartlarni tekshiradi
  // Restoran sahifasi nima qaytarayotganini tekshirish
  // Server vaqti — client soati noto'g'ri bo'lsa ham ish vaqti
  // to'g'ri hisoblanadi. Yengil, keshsiz.
  app.get('/api/time', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ now: Date.now() });
  });

  app.get('/diag/restaurant/:id', async (req, res) => {
    const out = { id: req.params.id, bosqichlar: [] };
    try {
      const { Restaurant } = await import('./models/Restaurant.js');
      const { Dish } = await import('./models/Dish.js');
      const { Order } = await import('./models/Order.js');

      const r = await Restaurant.findById(req.params.id).lean();
      out.bosqichlar.push({ restoran: r ? 'topildi' : 'TOPILMADI' });
      if (!r) return res.json(out);

      out.restoran = {
        nom: r.name,
        faol: r.isActive,
        bloklangan: r.isBlocked,
        tasdiqlangan: r.isApproved,
        ishVaqti: `${r.openTime || '—'}–${r.closeTime || '—'}`,
      };

      const dishes = await Dish.countDocuments({ restaurantId: r._id });
      out.bosqichlar.push({ taomlar: dishes });

      const rated = await Order.find({ restaurantId: r._id, rating: { $gte: 1 } })
        .select('rating ratedAt userId')
        .populate('userId', 'firstName')
        .limit(5)
        .lean();
      out.bosqichlar.push({ sharhlar: rated.length });

      // Sana formatlash sinovi
      out.sanaSinovi = rated.map((x) => ({
        xom: x.ratedAt,
        yaroqli: x.ratedAt ? !Number.isNaN(new Date(x.ratedAt).getTime()) : false,
      }));

      out.ok = true;
    } catch (e) {
      out.ok = false;
      out.xato = e.message;
      out.stack = e.stack?.split('\n').slice(0, 3);
    }
    res.json(out);
  });

  app.get('/diag/inline', async (_req, res) => {
    const out = { ok: true, muammolar: [] };

    if (!config.telegramBotToken) {
      out.ok = false;
      out.muammolar.push('Bot tokeni sozlanmagan (.env: TELEGRAM_BOT_TOKEN)');
      return res.json(out);
    }

    const api = `https://api.telegram.org/bot${config.telegramBotToken}`;

    try {
      // 1. Bot kim
      const me = await (await fetch(`${api}/getMe`)).json();
      out.bot = me.result?.username || '—';
      out.envBotUsername = config.botUsername;

      if (me.result?.username &&
          me.result.username.toLowerCase() !== String(config.botUsername).toLowerCase()) {
        out.muammolar.push(
          `.env dagi BOT_USERNAME (${config.botUsername}) haqiqiy bot ` +
          `(${me.result.username}) bilan mos emas. Havolalar noto'g'ri bo'lishi mumkin.`,
        );
      }

      // 2. Webhook holati
      const wh = await (await fetch(`${api}/getWebhookInfo`)).json();
      const allowed = wh.result?.allowed_updates || [];
      out.webhookUrl = wh.result?.url || '(o\'rnatilmagan)';
      out.allowedUpdates = allowed.length ? allowed : '(default)';

      if (!wh.result?.url) {
        out.ok = false;
        out.muammolar.push('Webhook o\'rnatilmagan');
      } else if (allowed.length && !allowed.includes('inline_query')) {
        out.ok = false;
        out.muammolar.push(
          'inline_query webhook\'da YOQILMAGAN — bot inline so\'rovlarni olmaydi. ' +
          'Serverni qayta ishga tushiring, avtomatik tuzatiladi.',
        );
      } else if (!allowed.length) {
        out.ok = false;
        out.muammolar.push(
          'allowed_updates bo\'sh (default) — inline_query default ro\'yxatda YO\'Q. ' +
          'Serverni qayta ishga tushiring.',
        );
      }

      // 3. Mini App nomi
      out.webappName = config.webappName;
      out.namunaHavola =
        `https://t.me/${out.bot}/${config.webappName}?startapp=food_<id>`;

    } catch (e) {
      out.ok = false;
      out.muammolar.push(`Telegram bilan aloqa xatosi: ${e.message}`);
    }

    if (out.ok && !out.muammolar.length) {
      out.xulosa = 'Hammasi tayyor. BotFather\'da /setinline yoqilganini ham tekshiring.';
    }
    res.json(out);
  });

  app.get('/diag/dish', async (_req, res) => {
    const { Dish } = await import('./models/Dish.js');
    const paths = Object.keys(Dish.schema.paths);
    const need = ['weight', 'protein', 'fat', 'carbs', 'calories', 'prepMinutes'];
    const missing = need.filter((f) => !paths.includes(f));
    res.json({
      ok: missing.length === 0,
      mavjud: need.filter((f) => paths.includes(f)),
      yetishmayapti: missing,
      xulosa: missing.length
        ? `Server ESKI kod bilan ishlayapti. Yechim: git pull && pm2 restart lakmago-server`
        : 'Server yangi — barcha maydonlar mavjud',
    });
  });

  app.get('/diag/telegram', async (_req, res) => {
    if (!config.telegramBotToken) {
      return res.json({ error: 'TELEGRAM_BOT_TOKEN sozlanmagan' });
    }
    try {
      const [infoRes, meRes] = await Promise.all([
        fetch(`https://api.telegram.org/bot${config.telegramBotToken}/getWebhookInfo`),
        fetch(`https://api.telegram.org/bot${config.telegramBotToken}/getMe`),
      ]);
      const info = (await infoRes.json()).result || {};
      const me = (await meRes.json()).result || {};

      const allowed = info.allowed_updates || [];
      // Bo'sh massiv = hammasi yoqilgan (Telegram qoidasi)
      const all = allowed.length === 0;
      const need = ['message', 'my_chat_member', 'callback_query'];
      const missing = all ? [] : need.filter((u) => !allowed.includes(u));

      const { GroupChat } = await import('./models/GroupChat.js');
      const groups = await GroupChat.find().select('title chatId isBotAdmin promoMessageId isPinned').lean();

      res.json({
        bot: { username: me.username, id: me.id },
        webhook: {
          url: info.url || '(o\u2018rnatilmagan)',
          ok: Boolean(info.url),
          pendingUpdates: info.pending_update_count,
          lastError: info.last_error_message || null,
          lastErrorAt: info.last_error_date
            ? new Date(info.last_error_date * 1000).toISOString() : null,
        },
        updates: {
          allowed: all ? '(hammasi)' : allowed,
          missing,
          ok: missing.length === 0,
        },
        groups: groups.map((g) => ({
          title: g.title,
          chatId: g.chatId,
          botAdmin: g.isBotAdmin,
          promoSent: Boolean(g.promoMessageId),
          pinned: g.isPinned,
        })),
        muammo: !info.url
          ? 'Webhook o\u2018rnatilmagan — bot hech narsa qabul qilmaydi'
          : missing.length
            ? `Webhook'da yetishmayapti: ${missing.join(', ')}`
            : info.last_error_message
              ? `Telegram xatosi: ${info.last_error_message}`
              : null,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/diag', (req, res) => {
    res.json({
      status: 'ok',
      origin: req.headers.origin || '(yo\u2018q)',
      originAllowed: isAllowedOrigin(req.headers.origin),
      protocol: req.protocol,              // https bo'lishi kerak (Vercel uchun)
      behindProxy: Boolean(req.headers['x-forwarded-proto']), // Nginx sozlanganmi
      httpsReady: req.protocol === 'https', // true bo'lsa Vercel bilan ishlaydi
      // Frontend manzillari (aniq ajratilган)
      webapp: config.webappOrigin || '(sozlanmagan — WEBAPP_URL)',
      adminPanels: config.adminOrigins.length ? config.adminOrigins : '(sozlanmagan — CORS_ORIGINS)',
      allAllowed: config.corsOrigins,
      // Boshqa sozlamаlar
      mainChannel: config.mainChannel || '(sozlanmagan)',
      hasBotToken: Boolean(config.telegramBotToken),
      hasCloudinary: Boolean(config.cloudinary?.apiSecret),
    });
  });

  // Telegram bot webhook
  app.post('/bot/webhook', (req, res) => {
    // Telegram'ga darhol javob beramiz (aks holda u qayta yuboraveradi)
    res.sendStatus(200);

    // Xato jim yo'qolmasin — faqat xato holatida log
    handleBotUpdate(req.body || {}).catch((e) => {
      console.error('[bot] webhook XATOSI:', e.message);
      console.error(e.stack);
    });
  });

  app.use('/api', router);

  // Taom ulashish sahifasi (Open Graph — Telegram/WhatsApp preview)

  app.use(notFound);
  app.use(errorHandler);

  initSocket(httpServer);

  // Web Push. VAPID kalitlari bo'lmasa jim o'chadi — qolgan
  // tizim ishlayveradi, faqat brauzer yopiq holatda xabar
  // bormaydi.
  initPush();

  httpServer.listen(config.port, () => {
    console.log(`✓ LokmaGo API http://localhost:${config.port}`);
  });

  // Bron eslatmalari — har 5 daqiqada tekshiriladi
  // (1.5 soat / 1 soat / 30 daqiqa / vaqt keldi)
  if (config.telegramBotToken) {
    const { checkReservationReminders } = await import('./services/reservationReminder.js');
    setTimeout(() => checkReservationReminders().catch((e) => console.error('Bron eslatma:', e.message)), 20_000);
    setInterval(() => checkReservationReminders().catch((e) => console.error('Bron eslatma:', e.message)), 5 * 60_000);
  }

  // Webhook'ni tekshirib, kerak bo'lsa avtomatik to'g'rilaymiz.
  // Bu tugmalar va guruh aniqlash ishlashini kafolatlaydi.
  if (config.telegramBotToken) {
    const { ensureWebhook } = await import('./services/webhookSetup.js');
    ensureWebhook().catch((e) => console.error('Webhook sozlash:', e.message));
  }

  // Yetkazish tasdiqlash — har 2 daqiqada
  // (kuryer olib ketgach 20 → 10 → 30 daqiqada so'raydi)
  if (config.telegramBotToken) {
    const { checkDeliveries } = await import('./services/deliveryCheck.js');
    setTimeout(() => checkDeliveries().catch((e) => console.error('Yetkazish tekshiruvi:', e.message)), 30_000);
    setInterval(() => checkDeliveries().catch((e) => console.error('Yetkazish tekshiruvi:', e.message)), 2 * 60_000);
  }

  // Dine-in billingi — soatiga bir marta
  {
    const { runDineInBilling } = await import('./services/dineInBilling.js');
    setTimeout(() => runDineInBilling().catch((e) => console.error('Dine-in billing:', e.message)), 120_000);
    setInterval(() => runDineInBilling().catch((e) => console.error('Dine-in billing:', e.message)), 60 * 60_000);
  }

  // Mijozlarni jalb qilish billingi — soatiga bir marta.
  // 24 soatlik davrni o'tkazib yubormaslik uchun yetarli.
  {
    const { runBillingCycle } = await import('./services/promoBilling.js');
    setTimeout(() => runBillingCycle().catch((e) => console.error('Promo billing:', e.message)), 90_000);
    setInterval(() => runBillingCycle().catch((e) => console.error('Promo billing:', e.message)), 60 * 60_000);
  }

  // Muddati tugagan aksiya va reklamalarni o'chirish — soatiga bir marta
  {
    const { deactivateExpired } = await import('./services/promotions.js');
    setTimeout(() => deactivateExpired().catch(() => {}), 60_000);
    setInterval(() => deactivateExpired().catch(() => {}), 60 * 60_000);
  }

  // Kunlik guruh tekshiruvi (reklama yuborilganmi + pin qilinganmi)
  // Server ishga tushганда 1 marta, keyin har 24 soatda.
  if (config.telegramBotToken) {
    const { dailyGroupCheck } = await import('./services/telegramGroup.js');
    // Startda 30 soniyadan keyin (server barqarorlashsin)
    setTimeout(() => dailyGroupCheck().catch((e) => console.error('Guruh tekshiruv:', e.message)), 30_000);
    // Keyin har 24 soatda
    setInterval(() => dailyGroupCheck().catch((e) => console.error('Guruh tekshiruv:', e.message)), 24 * 60 * 60 * 1000);
  }
}

main();
