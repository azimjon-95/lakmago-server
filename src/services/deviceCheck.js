import { config } from '../config/index.js';
import { haversineMeters } from './courierDispatch.js';

/*
 * ═══ QURILMA QAYERDA ↔ YETKAZISH MANZILI (buyurtma dalili) ═══
 *
 * Muammo: mijoz saqlangan manzilini unutib, boshqa joyda yurib buyurtma beradi — taom noto'g'ri manzilga boradi, restoran/LokmaGo'ga
 * shikoyat. Mijoz ilovasi buyurtma bilan telefonning YANGI joylashuvini yuboradi; server yetkazish manzili bilan masofani hisoblab
 * `Order.deviceCheck` ga yozadi. Restoran paneli va boti "⚠ mijoz manzildan 8,2 km uzoqda" ni ko'radi — pishirishdan oldin
 * qo'ng'iroq qiladi. XOM KOORDINATA SAQLANMAYDI (maxfiylik): faqat masofa, aniqlik, vaqt va holat.
 *
 * Holatlar (xato — GPS aniqligi — ayirilgandan KEYIN masofa effektiv hisoblanadi):
 *   match   — manzilda (effektiv < nearM, standart 150 m)
 *   near    — biroz uzoq (150–500 m): ogohlantirilmaydi, faqat yoziladi
 *   far     — uzoq (≥ farM, standart 500 m) VA aniqlik yaxshi (≤ 100 m)
 *   unknown — nuqta yo'q / eskirgan (>15 daqiqa) / aniqlik past (>100 m: xulosa chiqarib bo'lmaydi — soxta "uzoq" bo'lmasin)
 * `confirmedFar` — mijoz uzoq manzilni AYNAN o'zi tasdiqlagan yoki bir martalik manzilni o'zi tanlagan (javobgarlik shu yerda).
 *
 * Toza funksiya (bazasiz sinaladi): tests/device-check.test.mjs.
 */
export const DEVICE = {
  get farM() { return config.deviceFarM; },
  get nearM() { return config.deviceNearM; },
  MAX_AGE_MS: 15 * 60 * 1000,
  FUTURE_SKEW_MS: 2 * 60 * 1000,    // telefon soati bir oz oldinda bo'lishi mumkin
  USABLE_ACC_M: 100,
  DEFAULT_ACC_M: 60,                // aniqlik berilmasa o'rtacha taxmin
  MAX_ACC_M: 5000,
};

const okCoord = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);

/** @returns {{ status, distanceM, accuracyM, fixAt, confirmedFar }} */
export function assessDevice(device = {}, target = {}, { now = Date.now(), confirmedFar = false } = {}) {
  const out = (status, extra = {}) => ({ status, distanceM: null, accuracyM: null, fixAt: null, confirmedFar: Boolean(confirmedFar), ...extra });
  const lat = Number(device.lat); const lng = Number(device.lng);
  const tLat = Number(target.lat); const tLng = Number(target.lng);
  if (!okCoord(lat, lng) || !okCoord(tLat, tLng)) return out('unknown');

  const at = device.at ? new Date(device.at).getTime() : NaN;
  if (!Number.isFinite(at)) return out('unknown');
  const age = now - at;
  if (age > DEVICE.MAX_AGE_MS || age < -DEVICE.FUTURE_SKEW_MS) return out('unknown');

  const accRaw = Number(device.accuracy);
  const acc = Number.isFinite(accRaw) && accRaw >= 0 ? Math.min(accRaw, DEVICE.MAX_ACC_M) : DEVICE.DEFAULT_ACC_M;
  const d = Math.round(haversineMeters({ lat, lng }, { lat: tLat, lng: tLng }));
  const base = { distanceM: d, accuracyM: Math.round(acc), fixAt: new Date(at) };

  const eff = Math.max(0, d - acc);
  if (eff >= DEVICE.farM) return acc <= DEVICE.USABLE_ACC_M ? out('far', base) : out('unknown', base);
  if (acc > DEVICE.USABLE_ACC_M) return out('unknown', base);          // aniqlik past — "manzilda" deb ham da'vo qilmaymiz
  return out(eff >= DEVICE.nearM ? 'near' : 'match', base);
}

/** Restoran paneli / bot uchun qisqa ko'rinish (koordinatasiz). `unknown`/`match`/`near` — null: ortiqcha shovqin yo'q. */
export function deviceCheckView(o) {
  const c = o?.deviceCheck;
  if (!c || !c.status) return null;
  return { status: c.status, distanceM: c.distanceM ?? null, confirmedFar: Boolean(c.confirmedFar) };
}

/** "8,2 km" / "640 m" */
export function formatMeters(m) {
  if (!Number.isFinite(m)) return '';
  return m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1).replace('.', ',')} km`;
}
