import { NotifySettings } from '../models/NotifySettings.js';

/** Standart qiymatlar = tizimning hozirgi xatti-harakati (sozlama yozilmagan restoran o'zgarishni sezmaydi). */
export const DEFAULTS = Object.freeze({ sound: true, vibration: true, repeatEnabled: true, repeatIntervalSec: 30, repeatLimit: 10, soundType: 'custom', explicit: false });

const cache = new Map();            // restaurantId → { at, value }  (push yo'lini har buyurtmada bazaga urmaslik uchun)
const TTL_MS = 15_000;

const pick = (doc) => ({
  sound: doc?.sound ?? DEFAULTS.sound, vibration: doc?.vibration ?? DEFAULTS.vibration,
  repeatEnabled: doc?.repeatEnabled ?? DEFAULTS.repeatEnabled, repeatIntervalSec: doc?.repeatIntervalSec ?? DEFAULTS.repeatIntervalSec,
  repeatLimit: doc?.repeatLimit ?? DEFAULTS.repeatLimit, soundType: doc?.soundType ?? DEFAULTS.soundType,
  explicit: !!doc,          // restoran sozlamani o'zi yozganmi? Yo'q bo'lsa interval/limit server .env (MOBILE_PUSH_REPEAT_SEC / MAX_SENDS) dan olinadi
});

/** Hech qachon istisno otmaydi: baza xatosida standart qiymatlar (push baribir ketishi kerak). */
export async function getNotifySettings(restaurantId) {
  const key = String(restaurantId);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  try {
    const value = pick(await NotifySettings.findOne({ restaurantId }).lean());
    cache.set(key, { at: Date.now(), value });
    return value;
  } catch { return { ...DEFAULTS }; }
}

export const invalidateNotifySettings = (restaurantId) => cache.delete(String(restaurantId));
export const clearNotifySettingsCache = () => cache.clear();
