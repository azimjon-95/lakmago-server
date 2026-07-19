/**
 * Telegram webhook'ni to'g'ri o'rnatadi.
 *
 * ISHLATISH:
 *   node scripts/setup-webhook.js https://api.sizning-domen.uz
 *
 * Yoki .env da WEBHOOK_BASE bo'lsa argument shart emas:
 *   node scripts/setup-webhook.js
 *
 * Nima qiladi:
 *   • Kerakli barcha update turlarini yoqadi (my_chat_member, callback_query...)
 *   • Eski webhook'ni almashtiradi
 *   • Natijani tekshirib ko'rsatadi
 */
import { config } from '../src/config/index.js';

// Bot ishlashi uchun ZARUR update turlari
const ALLOWED_UPDATES = [
  'message',           // /start va matnli xabarlar
  'my_chat_member',    // bot guruhga qo'shilgani/admin bo'lgani
  'callback_query',    // inline tugmalar (bron javoblari, menyu)
  'chat_member',       // guruh a'zolari o'zgarishi (ixtiyoriy)
];

async function tg(method, params = {}) {
  const url = `https://api.telegram.org/bot${config.telegramBotToken}/${method}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  return res.json();
}

async function main() {
  if (!config.telegramBotToken) {
    console.error('✗ .env da TELEGRAM_BOT_TOKEN yo\'q');
    process.exit(1);
  }

  const base = process.argv[2] || process.env.WEBHOOK_BASE || '';
  if (!base) {
    console.error('Foydalanish: node scripts/setup-webhook.js https://api.domeningiz.uz');
    console.error('(HTTPS shart — Telegram HTTP qabul qilmaydi)');
    process.exit(1);
  }
  if (!base.startsWith('https://')) {
    console.error('✗ Manzil HTTPS bo\'lishi shart. Telegram HTTP webhook qabul qilmaydi.');
    process.exit(1);
  }

  const webhookUrl = `${base.replace(/\/$/, '')}/bot/webhook`;

  // 1. Bot kimligini tekshiramiz
  const me = await tg('getMe');
  if (!me.ok) {
    console.error('✗ Bot token noto\'g\'ri:', me.description);
    process.exit(1);
  }
  console.log(`✓ Bot: @${me.result.username}\n`);

  // 2. Webhook o'rnatamiz
  console.log(`Webhook o'rnatilmoqda: ${webhookUrl}`);
  const set = await tg('setWebhook', {
    url: webhookUrl,
    allowed_updates: ALLOWED_UPDATES,
    drop_pending_updates: false,
  });

  if (!set.ok) {
    console.error('✗ Xato:', set.description);
    process.exit(1);
  }
  console.log('✓ O\'rnatildi\n');

  // 3. Tekshiramiz
  const info = await tg('getWebhookInfo');
  const r = info.result || {};
  console.log('═══════════════════════════════════');
  console.log('  Manzil    :', r.url);
  console.log('  Updates   :', (r.allowed_updates || []).join(', '));
  console.log('  Kutilmoqda:', r.pending_update_count || 0);
  if (r.last_error_message) {
    console.log('  ⚠ Oxirgi xato:', r.last_error_message);
    console.log('    Vaqt:', new Date(r.last_error_date * 1000).toLocaleString());
  }
  console.log('═══════════════════════════════════\n');

  console.log('Endi sinang:');
  console.log('  1. Botga /start yozing — menyu chiqishi kerak');
  console.log('  2. Botni guruhga qo\'shib admin qiling —');
  console.log('     darhol reklama yuborilib pin qilinadi');
  console.log(`  3. Tekshirish: ${base}/diag/telegram\n`);
}

main().catch((e) => {
  console.error('✗ Xato:', e.message);
  process.exit(1);
});
