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
import { shareController } from './controllers/share.js';
import { ensureDefaultAdmin } from './services/bootstrap.js';

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

    // Update turini logga yozamiz — nima kelayotgani ko'rinsin
    const u = req.body || {};
    const kind = u.message ? 'message'
      : u.callback_query ? 'callback_query'
      : u.my_chat_member ? 'my_chat_member'
      : u.chat_member ? 'chat_member'
      : Object.keys(u).filter((k) => k !== 'update_id')[0] || 'noma\u2018lum';
    console.log(`[bot] webhook ← ${kind}` +
      (u.message?.text ? ` "${u.message.text.slice(0, 40)}"` : '') +
      (u.callback_query?.data ? ` [${u.callback_query.data}]` : ''));

    // Xato jim yo'qolmasin — logga yozamiz
    handleBotUpdate(u).catch((e) => {
      console.error('[bot] webhook XATOSI:', e.message);
      console.error(e.stack);
    });
  });

  app.use('/api', router);

  // Taom ulashish sahifasi (Open Graph — Telegram/WhatsApp preview)
  // Ikki manzil ham ishlaydi: /d/:id (qisqa) va /share/dish/:id
  app.get('/d/:id', shareController.dishPage);
  app.get('/share/dish/:id', shareController.dishPage);

  app.use(notFound);
  app.use(errorHandler);

  initSocket(httpServer);

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
