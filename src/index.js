import express from 'express';
import { createServer } from 'http';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import { config, connectDB } from './config/index.js';
import { router } from './routes/index.js';
import { errorHandler, notFound } from './middleware/error.js';
import { initSocket } from './sockets/io.js';
import { handleBotUpdate } from './services/telegram.js';
import { ensureDefaultAdmin } from './services/bootstrap.js';

async function main() {
  await connectDB();

  // Default admin (dastur egasi) akkauntini yaratish/tekshirish
  await ensureDefaultAdmin();

  const app = express();
  const httpServer = createServer(app);

  app.use(helmet());
  app.use(compression()); // Gzip/Brotli — javoblar siqiladi (tarmoq tez)
  app.use(cors({ origin: config.corsOrigins }));
  app.use(express.json());
  app.use(morgan('dev'));

  app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'lokmago-api' }));

  // Telegram bot webhook
  app.post('/bot/webhook', (req, res) => {
    handleBotUpdate(req.body);
    res.sendStatus(200);
  });

  app.use('/api', router);

  app.use(notFound);
  app.use(errorHandler);

  initSocket(httpServer);

  httpServer.listen(config.port, () => {
    console.log(`✓ LokmaGo API http://localhost:${config.port}`);
  });
}

main();
