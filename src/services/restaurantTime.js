/**
 * Restoran ish vaqti — vaqt zonasi bilan.
 *
 * MUAMMO: new Date().getHours() serverning yoki brauzerning
 * vaqtini qaytaradi. Rossiyadan kirgan mijoz uchun soat 18:00,
 * O'zbekistonda esa 16:00 — restoran yopiq deb ko'rsatilardi.
 *
 * YECHIM: Intl.DateTimeFormat bilan restoran vaqt zonasidagi
 * soatni olamiz. Qurilma vaqtiga bog'liq emas.
 */

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/**
 * Berilgan vaqt zonasidagi hozirgi holat.
 *
 * @returns {{ minutes, day, hh, mm }}
 */
export function zoneNow(timezone = 'Asia/Tashkent', date = new Date()) {
  let parts;

  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
      hour12: false,
    }).formatToParts(date);
  } catch {
    // Noto'g'ri vaqt zonasi — Toshkentga qaytamiz
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Tashkent',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
      hour12: false,
    }).formatToParts(date);
  }

  const get = (type) => parts.find((p) => p.type === type)?.value || '';

  // 24:00 ba'zi muhitlarda 00 o'rniga qaytadi
  const hh = Number(get('hour')) % 24;
  const mm = Number(get('minute'));

  const weekday = get('weekday').toLowerCase().slice(0, 3);
  const day = DAYS.includes(weekday) ? weekday : DAYS[date.getUTCDay()];

  return { minutes: hh * 60 + mm, day, hh, mm };
}

/** "HH:MM" → daqiqalarda. */
function toMinutes(hhmm) {
  if (typeof hhmm !== 'string') return null;
  const m = hhmm.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * Restoran hozir ochiqmi.
 *
 * Ish kunlari va vaqt zonasi hisobga olinadi.
 * Yarim tundan oshadigan vaqt ham to'g'ri (10:00–02:00).
 */
export function isRestaurantOpen(restaurant, date = new Date()) {
  const open = toMinutes(restaurant?.openTime);
  const close = toMinutes(restaurant?.closeTime);

  // Vaqt belgilanmagan — doim ochiq
  if (open === null || close === null) return true;
  if (open === close) return true;

  const tz = restaurant?.timezone || 'Asia/Tashkent';
  const { minutes, day } = zoneNow(tz, date);

  // Ish kunlari tekshiruvi
  const days = restaurant?.workingDays;
  if (Array.isArray(days) && days.length > 0) {
    // Yarim tundan oshgan vaqtda kecha ochilgan bo'lishi mumkin
    if (open > close && minutes < close) {
      const yesterday = DAYS[(DAYS.indexOf(day) + 6) % 7];
      if (!days.includes(yesterday)) return false;
    } else if (!days.includes(day)) {
      return false;
    }
  }

  if (open < close) return minutes >= open && minutes < close;
  return minutes >= open || minutes < close;
}

/** Ish vaqti matni: "09:00 – 23:00" yoki "24 soat". */
export function workHoursLabel(restaurant) {
  const open = toMinutes(restaurant?.openTime);
  const close = toMinutes(restaurant?.closeTime);
  if (open === null || close === null) return null;
  if (open === close) return '24 soat';
  return `${restaurant.openTime} – ${restaurant.closeTime}`;
}

/* ═══════════════════════════════════════════════════════════
 * SANA + VAQT ZONASI YORDAMCHILARI
 * ═══════════════════════════════════════════════════════════
 *
 * Server qaysi zonada ishlashidan (UTC, Europe/...) qat'i
 * nazar, "bugun", "soat 10:00" kabi tushunchalar RESTORAN
 * vaqt zonasida hisoblanadi. `new Date('2026-09-12T10:00:00')`
 * server zonasida talqin qilinadi — UTC serverda bu Toshkent
 * bo'yicha 15:00 bo'lib chiqadi (5 soat xato).
 */

function safeTz(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return 'Asia/Tashkent';
  }
}

/** Zonadagi sana (YYYY-MM-DD) va kun boshidan o'tgan daqiqalar. */
export function zoneDate(timezone = 'Asia/Tashkent', date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: safeTz(timezone),
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t)?.value || '00';
  const hh = Number(get('hour')) % 24;
  return { ymd: `${get('year')}-${get('month')}-${get('day')}`, minutes: hh * 60 + Number(get('minute')) };
}

/** YYYY-MM-DD ga kun qo'shish (manfiy ham bo'ladi). */
export function addDaysYmd(ymd, days) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

/** "HH:MM" → daqiqa (noto'g'ri bo'lsa null). */
export function hhmmToMinutes(hhmm) {
  return toMinutes(hhmm);
}

/** Zonaning berilgan paytdagi UTC'dan farqi (daqiqa). */
function zoneOffsetMinutes(timezone, date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: safeTz(timezone),
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(date);
  const get = (t) => Number(parts.find((p) => p.type === t)?.value || 0);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60_000);
}

/**
 * Restoran zonasidagi "YYYY-MM-DD" + "HH:MM" → haqiqiy (UTC) Date.
 * Noto'g'ri qiymatda null.
 */
export function zonedToUtc(ymd, hhmm, timezone = 'Asia/Tashkent') {
  const dm = String(ymd || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const mins = toMinutes(hhmm || '00:00');
  if (!dm || mins === null) return null;
  const guess = Date.UTC(Number(dm[1]), Number(dm[2]) - 1, Number(dm[3]), Math.floor(mins / 60), mins % 60);
  // Ikki bosqich — yozgi/qishki vaqt almashadigan zonalarda ham aniq
  const off1 = zoneOffsetMinutes(timezone, new Date(guess));
  let ts = guess - off1 * 60_000;
  const off2 = zoneOffsetMinutes(timezone, new Date(ts));
  if (off2 !== off1) ts = guess - off2 * 60_000;
  return new Date(ts);
}

/** Restoran zonasidagi bir kunning UTC chegaralari [start, end). */
export function zoneDayRange(timezone = 'Asia/Tashkent', date = new Date()) {
  const { ymd } = zoneDate(timezone, date);
  return {
    ymd,
    start: zonedToUtc(ymd, '00:00', timezone),
    end: zonedToUtc(addDaysYmd(ymd, 1), '00:00', timezone),
  };
}
