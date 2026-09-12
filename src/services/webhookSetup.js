import { config, isTestEnv, APP_ENV, TEST_WEBHOOK_HOSTS } from '../config/index.js';
import { restaurantWebhookSecret, markWebhookSecretActive } from './restaurantBotApi.js';

// Bot to'g'ri ishlashi uchun ZARUR update turlari.
// callback_query bo'lmasa — barcha tugmalar ishlamaydi.
// my_chat_member bo'lmasa — guruh aniqlash ishlamaydi.
const REQUIRED = ['message', 'callback_query', 'inline_query', 'my_chat_member', 'chat_member'];

async function tg(method, params) {
  const res = await fetch(`https://api.telegram.org/bot${config.telegramBotToken}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params || {}),
  });
  return res.json();
}

// Webhook manzilini aniqlaymiz: WEBHOOK_BASE yoki WEBAPP_URL emas,
// balki API domeni kerak. .env da WEBHOOK_BASE bo'lsa o'shani olamiz.
function resolveBase() {
  const raw = process.env.WEBHOOK_BASE || process.env.API_PUBLIC_URL || '';
  const base = raw.trim().replace(/\/+$/, '');
  if (!base) return '';

  /*
   * HIMOYA: WEBHOOK_BASE faqat menyu eksporti uchun ajratilgan
   * domenga (J_ROUTE_HOSTS) qo'yilgan bo'lsa — webhook o'sha
   * domenga o'rnatilardi, u yerda esa /bot/webhook 404 qaytaradi
   * va BOT BUTUNLAY ISHLAMAY QOLARDI (tugmalar, buyurtma
   * xabarlari — hammasi). Bunday sozlamani qabul qilmaymiz:
   * mavjud webhook saqlanadi va logda aniq ogohlantirish chiqadi.
   */
  try {
    const host = new URL(base).hostname.toLowerCase();

    /*
     * ═══ QULF 1: TEST MUHITI — MANZIL TEKSHIRUVI ═══
     *
     * APP_ENV=test bo'lsa webhook FAQAT ruxsat etilgan test
     * domeniga o'rnatiladi (config.TEST_WEBHOOK_HOSTS →
     * standart: test-api.lokmago.uz).
     *
     * NIMA UCHUN: test .env ga adashib production WEBHOOK_BASE
     * yozilsa, server real botlarning webhook'ini o'ziga tortib
     * olardi va mijozlarning butun bot oqimi test serverga
     * ketardi. Endi bunday sozlamada webhook UMUMAN
     * o'rnatilmaydi — server ishlaydi, lekin hech kimga tegmaydi.
     */
    if (isTestEnv && !TEST_WEBHOOK_HOSTS.includes(host)) {
      console.error(
        `✗ [TEST MUHITI] WEBHOOK_BASE=${base} — ruxsat etilmagan manzil.\n`
        + `  Ruxsat etilgan: ${TEST_WEBHOOK_HOSTS.join(', ')}\n`
        + '  Webhook O‘RNATILMADI (production botlari himoyalandi).',
      );
      return '';
    }

    if (config.jRouteHosts.includes(host)) {
      console.error(
        `✗ WEBHOOK_BASE=${base} — bu domen J_ROUTE_HOSTS ro‘yxatida `
        + '(faqat menyu eksporti uchun). Webhook u yerda ishlamaydi.\n'
        + '  Yechim: WEBHOOK_BASE ni ASOSIY API domeniga qo‘ying.',
      );
      return '';
    }
  } catch {
    console.error(`✗ WEBHOOK_BASE noto‘g‘ri: ${base} (masalan https://api.domeningiz.uz)`);
    return '';
  }

  return base;
}

/**
 * Server ishga tushganda webhook'ni tekshiradi va kerak bo'lsa
 * AVTOMATIK to'g'rilaydi. Qo'lda buyruq yozish shart emas.
 */
/*
 * ═══ QULF 2: BOT KIMLIGINI TEKSHIRISH ═══
 *
 * Test muhitida bot username'ida "test" bo'lishi SHART.
 * Production muhitida esa "test" bo'lMASLIGI kerak.
 *
 * NIMA UCHUN: qulf 1 manzilni tekshiradi, bu esa TOKENni.
 * Ikkalasi birga ishlaganda:
 *   • test .env ga production tokeni yozilsa → username "test"
 *     emas → webhook o'rnatilmaydi, production bot omon qoladi;
 *   • production .env ga test tokeni yozilsa → ogohlantirish
 *     chiqadi (xodim darhol payqaydi).
 *
 * Token hech qayerda chop etilmaydi — faqat ochiq username.
 *
 * @returns {boolean} webhook o'rnatish mumkinmi
 */
function botMatchesEnv(username, label) {
  const looksTest = /test/i.test(String(username || ''));

  if (isTestEnv && !looksTest) {
    console.error(
      `✗ [TEST MUHITI] ${label}: @${username} — bu TEST boti emasga o‘xshaydi.\n`
      + '  Test muhitida faqat nomida "test" bo‘lgan bot ishlatiladi.\n'
      + '  Webhook O‘RNATILMADI (production botlari himoyalandi).\n'
      + '  Tekshiring: test .env dagi bot tokeni to‘g‘rimi?',
    );
    return false;
  }

  if (!isTestEnv && looksTest) {
    console.warn(
      `⚠ [PRODUCTION] ${label}: @${username} — nomida "test" bor.\n`
      + '  Production .env ga test boti tokeni yozilgan bo‘lishi mumkin.',
    );
  }

  return true;
}

export async function ensureWebhook() {
  if (!config.telegramBotToken) return;

  try {
    const me = await tg('getMe');
    if (!me.ok) {
      console.error(`✗ Mijoz boti tokeni NOTO‘G‘RI: ${me.description}`);
      return;
    }
    console.log(`✓ Mijoz boti: @${me.result.username} (muhit: ${APP_ENV})`);
    if (!botMatchesEnv(me.result.username, 'Mijoz boti')) return;

    const info = await tg('getWebhookInfo');
    const w = info.result || {};
    const allowed = w.allowed_updates || [];

    // Bo'sh ro'yxat = Telegram default, unda my_chat_member YO'Q
    const missing = allowed.length === 0
      ? ['my_chat_member', 'chat_member']
      : REQUIRED.filter((u) => !allowed.includes(u));

    const base = resolveBase();

    /*
     * Test muhitida mavjud webhook manzili QAYTA ISHLATILMAYDI:
     * u faqat resolveBase() tasdiqlagan test manzili bo'lishi
     * mumkin. Production'da esa avvalgidek — mavjud manzil
     * ustun turadi (qo'lda o'rnatilgan sozlama buzilmasin).
     */
    const wanted = base ? `${base}/bot/webhook` : '';
    const url = isTestEnv ? wanted : (w.url || wanted);

    // Hammasi joyida — tegmaymiz
    if (w.url && missing.length === 0 && (!isTestEnv || w.url === wanted)) {
      console.log('✓ Telegram webhook to‘g‘ri sozlangan');
      return;
    }

    if (!url) {
      console.warn(
        '⚠ Telegram webhook o‘rnatilmagan va WEBHOOK_BASE .env da yo‘q.\n' +
        '  Tugmalar va guruh aniqlash ISHLAMAYDI.\n' +
        '  Yechim: .env ga qo‘shing → WEBHOOK_BASE=https://api.domeningiz.uz\n' +
        '  yoki bir marta: npm run webhook https://api.domeningiz.uz',
      );
      return;
    }

    if (missing.length) {
      console.log(`⚠ Webhook'da yetishmayapti: ${missing.join(', ')} — tuzatilmoqda...`);
    }

    const set = await tg('setWebhook', {
      url,
      allowed_updates: REQUIRED,
      drop_pending_updates: false,
    });

    if (set.ok) {
      console.log(`✓ Telegram webhook avtomatik to‘g‘rilandi: ${url}`);
    } else {
      console.error(`✗ Webhook o‘rnatilmadi: ${set.description}`);
    }
  } catch (e) {
    console.error('✗ Webhook tekshiruvi xatosi:', e.message);
  }
}

/*
 * ═══════════════════════════════════════════════════════════
 * RESTORAN BOTI WEBHOOK'I
 * ═══════════════════════════════════════════════════════════
 *
 * NIMA UCHUN QO'SHILDI: bot javob bermayotgan edi. Sabab —
 * webhook qo'lda o'rnatilishi kerak edi va bu qadam
 * unutilgan. Mijoz boti uchun avtomatik sozlash bor edi,
 * restoran boti uchun esa yo'q edi.
 *
 * Endi server ishga tushganda o'zi tekshiradi va kerak bo'lsa
 * o'rnatadi — qo'lda buyruq yozish shart emas.
 *
 * KERAKLI UPDATE TURLARI: faqat message va callback_query.
 * Restoran boti guruhlarda ishlamaydi, inline so'rovlarni
 * qabul qilmaydi — ortiqcha turlarni so'rash keraksiz
 * trafik va xavfsizlik yuzasi qo'shardi.
 */
const RESTAURANT_REQUIRED = ['message', 'callback_query'];

async function tgRestaurant(method, params) {
  const res = await fetch(
    `https://api.telegram.org/bot${config.restaurantBotToken}/${method}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params || {}),
    },
  );
  return res.json();
}

export async function ensureRestaurantWebhook() {
  if (!config.restaurantBotToken) {
    console.log('· Restoran boti sozlanmagan (RESTAURANT_BOT_TOKEN yo‘q)');
    return;
  }

  try {
    // Token haqiqiyligini ham tekshiramiz — noto'g'ri token
    // eng ko'p uchraydigan sabab va uni darhol bilgan ma'qul
    const me = await tgRestaurant('getMe');
    if (!me.ok) {
      console.error(`✗ Restoran boti tokeni NOTO‘G‘RI: ${me.description}`);
      return;
    }
    console.log(`✓ Restoran boti: @${me.result.username} (muhit: ${APP_ENV})`);
    if (!botMatchesEnv(me.result.username, 'Restoran boti')) return;

    const info = await tgRestaurant('getWebhookInfo');
    const w = info.result || {};

    const base = resolveBase();
    const wanted = base ? `${base}/restaurant-bot/webhook` : '';
    // WEBHOOK_BASE yo'q, lekin webhook qo'lda o'rnatilgan — o'shani himoyalaymiz
    const target = wanted || w.url || '';

    if (!target) {
      console.warn(
        '⚠ Restoran boti webhook o‘rnatilmadi: WEBHOOK_BASE .env da yo‘q.\n'
        + '  Yechim: .env ga qo‘shing → WEBHOOK_BASE=https://api.domeningiz.uz',
      );
      return;
    }

    /*
     * HAR ISHGA TUSHISHDA qayta o'rnatiladi: Telegram secret_token
     * ni getWebhookInfo'da qaytarmaydi, ya'ni u o'rnatilganmi —
     * bilib bo'lmaydi. setWebhook idempotent va arzon.
     * Muvaffaqiyatli bo'lsagina qattiq tekshiruv yoqiladi
     * (restaurantBotApi.verifyRestaurantWebhook).
     */
    const set = await tgRestaurant('setWebhook', {
      url: target,
      allowed_updates: RESTAURANT_REQUIRED,
      secret_token: restaurantWebhookSecret(),
      drop_pending_updates: false,
    });

    if (set.ok) {
      markWebhookSecretActive();
      console.log(`✓ Restoran boti webhook himoyalangan holda o‘rnatildi: ${target}`);
    } else {
      console.error(`✗ Restoran boti webhook xatosi: ${set.description} — himoyasiz rejimda ishlaydi`);
    }
  } catch (e) {
    console.error('✗ Restoran boti webhook tekshiruvi:', e.message);
  }
}
