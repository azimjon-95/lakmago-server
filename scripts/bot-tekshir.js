/**
 * BOT DIAGNOSTIKASI — nima ishlamayotganini aniq topadi.
 *
 * ISHLATISH:
 *   node scripts/bot-tekshir.js
 *
 * Ketma-ket tekshiradi:
 *   1. Token to'g'rimi
 *   2. Webhook o'rnatilganmi va qaysi manzilga
 *   3. Telegram serveringizga yeta olayaptimi (oxirgi xato)
 *   4. Kerakli update turlari yoqilganmi
 *   5. WEBAPP_URL to'g'rimi (Mini App tugmasi uchun)
 *   6. Webhook manzili tashqaridan ochiladimi
 */
import { config } from '../src/config/index.js';

const ok = (t) => console.log(`  ✓ ${t}`);
const bad = (t) => console.log(`  ✗ ${t}`);
const warn = (t) => console.log(`  ⚠ ${t}`);

async function tg(method) {
  const res = await fetch(`https://api.telegram.org/bot${config.telegramBotToken}/${method}`);
  return res.json();
}

async function main() {
  console.log('\n═══════════════════════════════════════');
  console.log('  BOT DIAGNOSTIKASI');
  console.log('═══════════════════════════════════════\n');

  let muammo = [];

  // ---- 1. Token ----
  console.log('1. Bot tokeni');
  if (!config.telegramBotToken) {
    bad('TELEGRAM_BOT_TOKEN .env da yo\'q');
    muammo.push('Token sozlanmagan — .env ga TELEGRAM_BOT_TOKEN qo\'ying');
    console.log('\n═══════════════════════════════════════');
    console.log('  MUAMMO:', muammo[0]);
    console.log('═══════════════════════════════════════\n');
    process.exit(1);
  }
  const me = await tg('getMe');
  if (!me.ok) {
    bad(`Token noto'g'ri: ${me.description}`);
    muammo.push('Token noto\'g\'ri — BotFather dan yangisini oling');
  } else {
    ok(`@${me.result.username} (${me.result.first_name})`);
  }

  // ---- 2. Webhook ----
  console.log('\n2. Webhook');
  const info = await tg('getWebhookInfo');
  const w = info.result || {};

  if (!w.url) {
    bad('Webhook O\'RNATILMAGAN — bot hech narsa qabul qilmaydi');
    muammo.push('Webhook o\'rnatilmagan. Buyruq:\n' +
      '     npm run webhook https://SIZNING-DOMEN.uz');
  } else {
    ok(`Manzil: ${w.url}`);

    // Manzil to'g'ri formatdami
    if (!w.url.startsWith('https://')) {
      bad('Manzil HTTPS emas — Telegram HTTP qabul qilmaydi');
      muammo.push('Webhook HTTPS bo\'lishi shart');
    }
    if (!w.url.endsWith('/bot/webhook')) {
      warn(`Manzil "/bot/webhook" bilan tugamayapti — hozirgi: ${w.url}`);
      muammo.push('Webhook manzili noto\'g\'ri. To\'g\'risi: https://domen/bot/webhook');
    }
  }

  // ---- 3. Telegram yeta olayaptimi ----
  console.log('\n3. Telegram serveringizga yeta olayaptimi');
  if (w.last_error_message) {
    bad(`Oxirgi xato: ${w.last_error_message}`);
    console.log(`     Vaqt: ${new Date(w.last_error_date * 1000).toLocaleString()}`);

    const m = w.last_error_message.toLowerCase();
    if (m.includes('ssl') || m.includes('certificate')) {
      muammo.push('SSL sertifikat muammosi — Certbot bilan HTTPS o\'rnating');
    } else if (m.includes('timeout') || m.includes('unreachable') || m.includes('connect')) {
      muammo.push('Telegram serveringizga ULANA OLMAYAPTI.\n' +
        '     • Domen to\'g\'ri ishlayaptimi? Brauzerda oching\n' +
        '     • Nginx 443-portni tinglayaptimi?\n' +
        '     • Firewall 443-portni ochiqmi?');
    } else if (m.includes('404') || m.includes('not found')) {
      muammo.push('Server 404 qaytaryapti — /bot/webhook yo\'li mavjud emas.\n' +
        '     Nginx to\'g\'ri proxy qilayaptimi tekshiring');
    } else if (m.includes('502') || m.includes('bad gateway')) {
      muammo.push('502 — Nginx backendga ulana olmayapti.\n' +
        '     pm2 status bilan server ishlayotganini tekshiring');
    } else {
      muammo.push(`Telegram xatosi: ${w.last_error_message}`);
    }
  } else if (w.url) {
    ok('Xato yo\'q — Telegram yetib boryapti');
  }

  if (w.pending_update_count > 0) {
    warn(`${w.pending_update_count} ta update kutmoqda (yetkazilmagan)`);
  }

  // ---- 4. Update turlari ----
  console.log('\n4. Yoqilgan update turlari');
  const allowed = w.allowed_updates || [];
  const need = ['message', 'my_chat_member', 'callback_query'];

  if (allowed.length === 0) {
    ok('Hammasi yoqilgan (bo\'sh ro\'yxat = default)');
    warn('Lekin default da my_chat_member YO\'Q! Guruh aniqlash ishlamaydi');
    muammo.push('my_chat_member yoqilmagan (default ro\'yxatda yo\'q).\n' +
      '     npm run webhook https://SIZNING-DOMEN.uz');
  } else {
    const missing = need.filter((u) => !allowed.includes(u));
    if (missing.length) {
      bad(`Yetishmayapti: ${missing.join(', ')}`);
      muammo.push(`Update turlari yetishmayapti: ${missing.join(', ')}\n` +
        '     npm run webhook https://SIZNING-DOMEN.uz');
    } else {
      ok(allowed.join(', '));
    }
  }

  // ---- 5. WEBAPP_URL ----
  console.log('\n5. Mini App manzili (WEBAPP_URL)');
  if (!config.webappUrl) {
    bad('WEBAPP_URL .env da yo\'q');
    muammo.push('WEBAPP_URL sozlanmagan');
  } else if (!config.webappUrl.startsWith('https://')) {
    bad(`HTTPS emas: ${config.webappUrl}`);
    muammo.push('WEBAPP_URL HTTPS bo\'lishi shart (Mini App tugmasi uchun)');
  } else {
    ok(config.webappUrl);
    if (config.webappUrl.includes('t.me/')) {
      warn('t.me havolasi — bu Mini App tugmasi uchun ishlamaydi');
      muammo.push('WEBAPP_URL t.me emas, webapp DOMENI bo\'lishi kerak\n' +
        '     Masalan: https://lakmago-client.vercel.app');
    }
  }

  // ---- 6. Webhook manzili ochiladimi ----
  if (w.url) {
    console.log('\n6. Webhook manzili tashqaridan ochiladimi');
    try {
      const res = await fetch(w.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ update_id: 0 }),
        signal: AbortSignal.timeout(8000),
      });
      if (res.status === 200) ok(`Javob: ${res.status} — ishlayapti`);
      else {
        bad(`Javob: ${res.status}`);
        muammo.push(`Webhook manzili ${res.status} qaytardi (200 kutilgan)`);
      }
    } catch (e) {
      bad(`Ulanib bo'lmadi: ${e.message}`);
      muammo.push('Webhook manzili tashqaridan ochilmayapti.\n' +
        '     Domen, Nginx va SSL ni tekshiring');
    }
  }

  // ---- Xulosa ----
  console.log('\n═══════════════════════════════════════');
  if (muammo.length === 0) {
    console.log('  ✓ HAMMASI JOYIDA');
    console.log('═══════════════════════════════════════');
    console.log('\nBotga /start yozib ko\'ring.');
    console.log('Log ko\'rish: pm2 logs lakmago-server\n');
  } else {
    console.log(`  ${muammo.length} TA MUAMMO TOPILDI`);
    console.log('═══════════════════════════════════════\n');
    muammo.forEach((m, i) => console.log(`${i + 1}. ${m}\n`));
  }
}

main().catch((e) => {
  console.error('\n✗ Diagnostika xatosi:', e.message);
  process.exit(1);
});
