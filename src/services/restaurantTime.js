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
