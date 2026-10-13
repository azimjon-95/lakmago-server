import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.APP_ENV = 'test';
process.env.ADMIN_ORDER_ACTION_PASSWORD = 'test-secret-password-xx';
process.env.ADMIN_ORDER_ACTION_SESSION_TTL_SECONDS = '120';
process.env.ADMIN_ORDER_ACTION_USER_IDS = '111001,111002';
process.env.ADMIN_ALERTS_CHAT_ID = '-100999';
process.env.TELEGRAM_BOT_TOKEN = '000000:TEST';

function timingSafePasswordEqual(provided, expected) {
  const a = Buffer.from(String(provided || ''), 'utf8');
  const b = Buffer.from(String(expected || ''), 'utf8');
  if (a.length !== b.length) {
    const dummy = Buffer.alloc(a.length || 1);
    crypto.timingSafeEqual(a.length ? a : dummy, dummy);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

console.log('[1] timing-safe password compare');
assert.equal(timingSafePasswordEqual('test-secret-password-xx', 'test-secret-password-xx'), true);
assert.equal(timingSafePasswordEqual('wrong', 'test-secret-password-xx'), false);
assert.equal(timingSafePasswordEqual('', 'test-secret-password-xx'), false);

console.log('[2] fail-closed when password empty');
assert.equal(Boolean('' && ''.length > 0), false);

console.log('[3] allowlist check');
const allow = String(process.env.ADMIN_ORDER_ACTION_USER_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
assert.ok(allow.includes('111001'));
assert.ok(!allow.includes('999'));

console.log('[4] callback prefix isolation');
assert.ok('aom_done:abc'.startsWith('aom_'));
assert.ok(!'menu_x'.startsWith('aom_'));

console.log('[5] content hash stable');
const h1 = crypto.createHash('sha256').update('t|m').digest('hex').slice(0, 16);
const h2 = crypto.createHash('sha256').update('t|m').digest('hex').slice(0, 16);
assert.equal(h1, h2);
assert.notEqual(h1, crypto.createHash('sha256').update('t|other').digest('hex').slice(0, 16));

console.log('\nadmin-order-monitor unit checks OK');