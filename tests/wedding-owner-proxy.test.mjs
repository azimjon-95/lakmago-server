/*
 * Egasi proksisi: faqat ruxsat etilgan yo'llar o'tadi (bazasiz). npm run test:wedding-proxy
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(40);
const { OWNER_ALLOWED } = await import('../src/controllers/weddingProxy.js');
let fails = 0;
const ok = (c, m) => { console.log(c ? '  ✓' : '  ✗ FAIL:', m); if (!c) fails++; };
const id = 'a'.repeat(24);
console.log('\n[1] Ruxsat etilgan yo‘llar');
for (const p of ['me', 'calendar', 'reservations', `reservations/${id}`, `bookings/${id}`, 'transactions', `transactions/${id}`, 'employees', 'finance/summary',
  'inbox', 'inbox/summary', `inbox/${id}`, `inbox/${id}/seen`, `inbox/${id}/agree`, `inbox/${id}/reject`, `inbox/${id}/advance`, `inbox/${id}/confirm`, `inbox/${id}/cancel`, 'notifications', 'notifications/read']) {
  ok(OWNER_ALLOWED.test(p), p);
}
console.log('\n[2] Yopiq yo‘llar (404)');
for (const p of ['', 'inbox/', 'inbox/zzz', `inbox/${id}/delete`, `inbox/${id}/seen/x`, `inbox/${id}/../me`, '../me', 'notifications/read/x', 'notifications/abc', 'owner-app', 'admin', `inbox/${id}/agree?x=1`, 'inbox/summary/x', `bookings/${id}/agree`, `inbox/${'a'.repeat(23)}`]) {
  ok(!OWNER_ALLOWED.test(p), JSON.stringify(p));
}
console.log(fails ? `\n✗ ${fails} ta xato` : '\n✓ Hammasi o‘tdi');
process.exit(fails ? 1 : 0);
