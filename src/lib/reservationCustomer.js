/*
 * ═══ BRON: soxta mijozdan himoya + mijoz "izi" (toza funksiyalar, DB/tarmoqsiz) ═══
 *
 * Nega: bron — to'lovsiz. Soxta ism/telefon bilan qo'yilgan bron restoranni stolni band qilib qo'yishga
 * majbur qiladi. To'liq to'sib bo'lmaydi (mehmon boshqa odam uchun ham bron qila oladi), shuning uchun ikki qatlam:
 *   1) checkReservationRequest — aniq noto'g'ri / suiiste'mol so'rovlarni rad etadi;
 *   2) buildCustomerSnapshot — bron qo'yilgan paytdagi HISOB ma'lumotini (telegram, tasdiqlangan telefon,
 *      avvalgi bronlar tarixi) bronga muhrlaydi; restoran va admin guruhi qaror qilishi uchun ko'rsatiladi.
 * Tests: tests/reservation-guard.test.mjs
 */

export const MAX_GUESTS = 30;
export const MAX_DAYS_AHEAD = 30;
export const MAX_ACTIVE_PER_USER = 3;
export const MAX_PER_RESTAURANT_DAY = 2;
export const MAX_CREATED_24H = 6;
export const NOTE_MAX = 300;
const PAST_GRACE_MS = 10 * 60_000;

export const digitsOf = (v) => String(v || '').replace(/\D/g, '');

/** "+998 90 123 45 67" → "+998901234567"; yaroqsiz → '' */
export function normalizePhone(raw) {
  const d = digitsOf(raw);
  if (d.length < 9 || d.length > 15) return '';
  return `+${d.length === 9 ? `998${d}` : d}`;
}

/** 000000000, 111111111, 123456789, 987654321 kabi aniq soxta raqamlar */
export function looksFakePhone(raw) {
  const d = digitsOf(raw);
  const local = d.length > 9 ? d.slice(-9) : d;
  if (local.length < 9) return true;
  if (/^(\d)\1+$/.test(local)) return true;
  if ('0123456789012'.includes(local) || '9876543210987'.includes(local)) return true;
  return false;
}

/** Izoh: boshqaruv belgilari tozalanadi, uzunlik cheklanadi */
export function cleanNote(raw) {
  return String(raw || '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, NOTE_MAX);
}

/**
 * Bron so'rovini tekshiradi. Xato bo'lsa { status, code, error }, aks holda null.
 * @param {object} p
 *  data: { name, phone, guests }, scheduledAt: Date|undefined, now: Date,
 *  counts: { duplicate:boolean, activeUpcoming:number, sameDay:number, created24h:number }
 */
export function checkReservationRequest({ data, scheduledAt, now = new Date(), counts = {} }) {
  const name = String(data?.name || '').trim();
  if (name.length < 2 || !/\p{L}/u.test(name)) {
    return { status: 400, code: 'BAD_NAME', error: 'Ismingizni to‘liq yozing' };
  }
  if (!normalizePhone(data?.phone) || looksFakePhone(data?.phone)) {
    return { status: 400, code: 'BAD_PHONE', error: 'Telefon raqam noto‘g‘ri — haqiqiy raqamingizni kiriting' };
  }
  if (!Number.isInteger(data?.guests) || data.guests < 1) {
    return { status: 400, code: 'BAD_GUESTS', error: 'Mehmonlar soni noto‘g‘ri' };
  }
  if (data.guests > MAX_GUESTS) {
    return { status: 400, code: 'TOO_MANY_GUESTS', error: `${MAX_GUESTS} kishidan ko‘p bo‘lsa, restoranga qo‘ng‘iroq qilib kelishing` };
  }
  if (!(scheduledAt instanceof Date) || Number.isNaN(scheduledAt.getTime())) {
    return { status: 400, code: 'BAD_TIME', error: 'Sana yoki vaqt noto‘g‘ri' };
  }
  if (scheduledAt.getTime() < now.getTime() - PAST_GRACE_MS) {
    return { status: 400, code: 'PAST_TIME', error: 'O‘tib ketgan vaqtga bron qilib bo‘lmaydi' };
  }
  if (scheduledAt.getTime() > now.getTime() + MAX_DAYS_AHEAD * 86_400_000) {
    return { status: 400, code: 'TOO_FAR', error: `Bron ${MAX_DAYS_AHEAD} kundan keyingi sanaga qilinmaydi` };
  }
  if (counts.duplicate) {
    return { status: 409, code: 'RESERVATION_DUPLICATE', error: 'Bu restoranga shu vaqtga bron allaqachon yuborilgan' };
  }
  if ((counts.sameDay || 0) >= MAX_PER_RESTAURANT_DAY) {
    return { status: 409, code: 'RESERVATION_SAME_DAY', error: 'Shu restoranga bir kunga ko‘pi bilan 2 ta bron qilinadi' };
  }
  if ((counts.activeUpcoming || 0) >= MAX_ACTIVE_PER_USER) {
    return { status: 429, code: 'TOO_MANY_ACTIVE', error: `Bir vaqtda ${MAX_ACTIVE_PER_USER} tadan ortiq faol bron bo‘lmaydi — avval bironini bekor qiling yoki kuting` };
  }
  if ((counts.created24h || 0) >= MAX_CREATED_24H) {
    return { status: 429, code: 'RATE_LIMIT', error: 'Juda ko‘p bron yuborildi — keyinroq urinib ko‘ring' };
  }
  return null;
}

/**
 * Bron paytidagi hisob izi (bronga muhrlanadi).
 * @param user  User hujjati (telegramId, username, firstName, lastName, phone, phoneVerified, createdAt)
 * @param hist  { total, came, cancelled, deliveredOrders } — shu mijozning oldingi bronlari/buyurtmalari
 */
export function buildCustomerSnapshot({ user, contactPhone, hist = {}, now = new Date() }) {
  const total = hist.total || 0;
  const came = hist.came || 0;
  const cancelled = hist.cancelled || 0;
  const deliveredOrders = hist.deliveredOrders || 0;
  const accountPhone = normalizePhone(user?.phone);
  const contact = normalizePhone(contactPhone);
  const ageDays = user?.createdAt
    ? Math.max(0, Math.floor((now.getTime() - new Date(user.createdAt).getTime()) / 86_400_000)) : null;

  let trust = 'ok';
  if (cancelled >= 2 && cancelled > came) trust = 'risk';
  else if (total === 0 && deliveredOrders === 0) trust = 'new';

  return {
    accountName: [user?.firstName, user?.lastName].filter(Boolean).join(' ').trim(),
    username: String(user?.username || '').replace(/^@/, ''),
    telegramId: String(user?.telegramId || ''),
    accountPhone,
    phoneVerified: Boolean(user?.phoneVerified),
    // Bron boshqa odam telefoni bilan — ayb emas, lekin restoran bilishi kerak
    otherPhone: Boolean(accountPhone && contact && accountPhone !== contact),
    accountAgeDays: ageDays,
    prevTotal: total,
    prevCame: came,
    prevCancelled: cancelled,
    deliveredOrders,
    trust,
  };
}

/** Bir qatorli "mijoz kim" izohi — restoran boti va admin guruhi uchun (HTML emas, matn; chaqiruvchi esc qiladi) */
export function customerTrustText(c) {
  if (!c || typeof c !== 'object') return '';
  const parts = [];
  parts.push(c.phoneVerified ? '✅ telefon tasdiqlangan' : '⚠️ telefon tasdiqlanmagan');
  if (c.trust === 'new') {
    parts.push(c.accountAgeDays != null && c.accountAgeDays <= 1 ? 'yangi hisob, birinchi bron' : 'birinchi bron');
  } else if (c.trust === 'risk') {
    parts.push(`🚩 ${c.prevCancelled} marta bekor qilgan/kelmagan`);
  } else {
    const bits = [];
    if (c.prevCame) bits.push(`${c.prevCame} marta kelgan`);
    if (c.deliveredOrders) bits.push(`${c.deliveredOrders} buyurtma`);
    parts.push(bits.length ? bits.join(', ') : `${c.prevTotal} bron`);
  }
  if (c.otherPhone) parts.push('bron boshqa raqam bilan');
  return parts.join(' · ');
}
