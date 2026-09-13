/*
 * ═══════════════════════════════════════════════════════════
 * PM2 — TEST NUSXASI (lakmago-test)
 * ═══════════════════════════════════════════════════════════
 *
 * Production process'iga (lakmago-server, :4000) UMUMAN
 * tegilmaydi — bu butunlay boshqa nom, boshqa papka, boshqa port.
 *
 * Ishga tushirish (test papkasi ichida):
 *   pm2 start ecosystem.test.config.cjs
 *   pm2 save
 *
 * Yangilash:
 *   git pull origin develop && npm ci --omit=dev
 *   pm2 reload lakmago-test        # uzilishsiz
 *
 * To'xtatish (production'ga ta'sir qilmaydi):
 *   pm2 stop lakmago-test
 *
 * MUHIM: sozlamalar .env dan o'qiladi. Bu faylga token,
 * parol yoki ulanish satrini YOZMANG — u git'da turadi.
 */
module.exports = {
  apps: [
    {
      name: 'lakmago-test',
      script: 'src/index.js',
      cwd: __dirname,

      /*
       * Bitta nusxa yetarli: test muhitida yuk yo'q, va bir
       * nechta nusxa jadval ishlarini (bron eslatmalari,
       * billing) takrorlashi mumkin.
       */
      instances: 1,
      exec_mode: 'fork',

      env: {
        NODE_ENV: 'production',   // Express optimizatsiyasi uchun
        APP_ENV: 'test',          // ← test himoyalarini yoqadi
        PORT: 4001,
      },

      // Xotira oshib ketsa qayta ishga tushadi (test muhitida
      // eksperimental kod bo'lishi mumkin)
      max_memory_restart: '400M',

      // Cheksiz qayta ishga tushish halqasidan himoya
      min_uptime: '20s',
      max_restarts: 10,
      restart_delay: 3000,

      // Loglar production loglari bilan ARALASHMASIN
      out_file: './logs/test-out.log',
      error_file: './logs/test-error.log',
      merge_logs: true,
      time: true,
    },
  ],
};
