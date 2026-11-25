/*
 * Bron: soxta mijozdan himoya, mijoz izi, admin guruhi posti.
 * npm run test:reservation-guard   (DB/tarmoq kerak emas)
 */
import assert from 'node:assert/strict';
import {
  checkReservationRequest, buildCustomerSnapshot, customerTrustText, cleanNote, looksFakePhone, normalizePhone,
  MAX_GUESTS, NOTE_MAX,
} from '../src/lib/reservationCustomer.js';
import { buildGroupText, shortDate } from '../src/services/reservationGroupNotify.js';

const now = new Date('2026-11-25T10:00:00Z');
const at = (h) => new Date(now.getTime() + h * 3_600_000);
const good = { name: 'Azimjon', phone: '+998 90 123 45 67', guests: 4 };
const chk = (over = {}, scheduledAt = at(5), counts = {}) =>
  checkReservationRequest({ data: { ...good, ...over }, scheduledAt, now, counts });

let n = 0;
const t = (name, fn) => { fn(); n += 1; console.log('  ✓', name); };

t('to‘g‘ri so‘rov o‘tadi', () => assert.equal(chk(), null));
t('ism: bir harf / faqat raqam rad', () => {
  assert.equal(chk({ name: 'A' }).code, 'BAD_NAME');
  assert.equal(chk({ name: '12345' }).code, 'BAD_NAME');
});
t('soxta telefon rad (0000, 1111, 123456789, qisqa)', () => {
  for (const p of ['+998 00 000 00 00', '111111111', '123456789', '+998 12345', '987654321']) {
    assert.equal(chk({ phone: p }).code, 'BAD_PHONE', p);
  }
  assert.equal(looksFakePhone('+998901234567'), false);
  assert.equal(normalizePhone('90 123 45 67'), '+998901234567');
});
t('mehmonlar soni chegarasi', () => {
  assert.equal(chk({ guests: 0 }).code, 'BAD_GUESTS');
  assert.equal(chk({ guests: MAX_GUESTS + 1 }).code, 'TOO_MANY_GUESTS');
  assert.equal(chk({ guests: MAX_GUESTS }), null);
});
t('vaqt: o‘tgan, juda uzoq, yaroqsiz', () => {
  assert.equal(chk({}, at(-1)).code, 'PAST_TIME');
  assert.equal(chk({}, at(-0.1)), null); // 6 daqiqa — imkon (grace)
  assert.equal(chk({}, at(24 * 31)).code, 'TOO_FAR');
  assert.equal(chk({}, null).code, 'BAD_TIME');
  assert.equal(chk({}, new Date('x')).code, 'BAD_TIME');
});
t('takror / kunlik / faol / 24 soat chegaralari', () => {
  assert.equal(chk({}, at(5), { duplicate: true }).code, 'RESERVATION_DUPLICATE');
  assert.equal(chk({}, at(5), { sameDay: 2 }).code, 'RESERVATION_SAME_DAY');
  assert.equal(chk({}, at(5), { sameDay: 1 }), null);
  assert.equal(chk({}, at(5), { activeUpcoming: 3 }).code, 'TOO_MANY_ACTIVE');
  assert.equal(chk({}, at(5), { created24h: 6 }).code, 'RATE_LIMIT');
});
t('izoh tozalanadi va uzunligi cheklanadi', () => {
  assert.equal(cleanNote('  salom\u0000   dunyo \n\n\n\n yana '), 'salom dunyo \n\n yana');
  assert.equal(cleanNote('x'.repeat(NOTE_MAX + 50)).length, NOTE_MAX);
  assert.equal(cleanNote(undefined), '');
});

const user = { firstName: 'Azimjon', username: '@azim', telegramId: '123456', phone: '+998901234567', phoneVerified: true, createdAt: new Date(now - 10 * 86_400_000) };
t('mijoz izi: yangi / ishonchli / xavfli', () => {
  const fresh = buildCustomerSnapshot({ user, contactPhone: good.phone, hist: {}, now });
  assert.equal(fresh.trust, 'new'); assert.equal(fresh.username, 'azim'); assert.equal(fresh.accountAgeDays, 10);
  assert.equal(fresh.otherPhone, false);
  const ok = buildCustomerSnapshot({ user, contactPhone: good.phone, hist: { total: 5, came: 4, cancelled: 1, deliveredOrders: 7 }, now });
  assert.equal(ok.trust, 'ok');
  const risk = buildCustomerSnapshot({ user, contactPhone: good.phone, hist: { total: 4, came: 1, cancelled: 3 }, now });
  assert.equal(risk.trust, 'risk');
  const other = buildCustomerSnapshot({ user, contactPhone: '+998 93 111 22 33', hist: {}, now });
  assert.equal(other.otherPhone, true);
  const unverified = buildCustomerSnapshot({ user: { ...user, phoneVerified: false, phone: '' }, contactPhone: good.phone, hist: {}, now });
  assert.equal(unverified.phoneVerified, false); assert.equal(unverified.otherPhone, false);
});
t('izoh matni: tasdiqlangan / tasdiqlanmagan / xavfli', () => {
  assert.match(customerTrustText({ phoneVerified: true, trust: 'new', accountAgeDays: 0 }), /tasdiqlangan.*yangi hisob/);
  assert.match(customerTrustText({ phoneVerified: false, trust: 'ok', prevCame: 3, deliveredOrders: 2, prevTotal: 4 }), /tasdiqlanmagan.*3 marta kelgan, 2 buyurtma/);
  assert.match(customerTrustText({ phoneVerified: true, trust: 'risk', prevCancelled: 3 }), /🚩 3 marta/);
  assert.equal(customerTrustText(null), '');
});

const resv = {
  restaurantName: 'Ziynat <Restaurant>', name: 'Xumora', phone: '+998 50 188 74 14', date: '2026-11-25', time: '20:00', guests: 6,
  note: 'Tug‘ilgan kun & tort bor', status: 'pending',
  customer: { username: 'Xumora_1122', phoneVerified: true, trust: 'ok', prevCame: 2, deliveredOrders: 1, prevTotal: 2 },
  preOrder: [{ name: 'Plov', quantity: 2, price: 50000 }, { name: 'Shashlik', quantity: 1, price: 20000 }],
};
t('guruh posti: qisqa, aniq, HTML xavfsiz', () => {
  const x = buildGroupText(resv);
  assert.match(x, /Yangi stol broni/);
  assert.match(x, /Ziynat &lt;Restaurant&gt;/);
  assert.match(x, /Xumora<\/b> · @Xumora_1122 · \+998 50 188 74 14/);
  assert.match(x, /25\.11 \(chor\) · <b>20:00<\/b> · 👥 6 kishi/);
  assert.match(x, /2× Plov, 1× Shashlik — <b>120 000 so‘m<\/b>/);
  assert.match(x, /Tug‘ilgan kun &amp; tort bor/);
  assert.ok(x.split('\n').length <= 7, 'post 7 qatordan oshmasin');
  assert.doesNotMatch(buildGroupText({ ...resv, preOrder: [], note: '' }), /🍽|📝/);
  assert.match(buildGroupText({ ...resv, status: 'confirmed' }), /Restoran qabul qildi/);
  assert.equal(shortDate('xato'), 'xato');
});

console.log(`\n✓ hammasi o‘tdi (${n})`);
