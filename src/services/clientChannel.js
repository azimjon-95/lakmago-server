import crypto from 'node:crypto';

/*
 * ═══════════════════════════════════════════════════════════
 * MIJOZ KANALI — buyurtma QAYERDAN keldi (iOS ilova, Android ilova,
 * Telegram Mini App, oddiy sayt)
 * ═══════════════════════════════════════════════════════════
 *
 * Ilova (lakmago-client) har so'rovga header qo'shadi:
 *   X-Lokma-Client       ios | android | telegram | web
 *   X-Lokma-App-Version  1.2.0        (faqat native ilova)
 *   X-Lokma-Device       qurilma ID   (faqat native ilova; @capacitor/device)
 *
 * Header yo'q — kanal NOMA'LUM (null). Bu asosan ESKI native ilova
 * (yangi veb-versiya har doim header yuboradi). Noma'lum kanal:
 *   • "ilova" sovg'asini olmaydi (qoida kanal talab qilsa),
 *   • "ilovani yuklab oling" oynasini ko'rmaydi (ilova ichida chiqib qolmasin).
 *
 * ISHONCH DARAJASI: header'ni texnik foydalanuvchi soxtalashtira oladi.
 * Shuning uchun ilova sovg'asi doim limitlar bilan beriladi (mijozga /
 * qurilmaga necha marta, kunlik, umumiy, byudjet — GiftBonus). Qattiq
 * tasdiq (Apple App Attest / Google Play Integrity) — keyingi bosqich.
 *
 * Qurilma ID bazaga XOM holda yozilmaydi — sha256 (16 bayt) izi.
 */
export const CHANNELS = ['ios', 'android', 'telegram', 'web'];
export const NATIVE_CHANNELS = ['ios', 'android'];
/** Qoida/oyna tanlovida ishlatiladigan guruhlar */
export const CHANNEL_TARGETS = ['app', 'ios', 'android', 'telegram', 'web'];

const header = (req, name) => {
  const v = req?.get ? req.get(name) : req?.headers?.[name.toLowerCase()];
  return typeof v === 'string' ? v.trim() : '';
};

export function normalizeVersion(v) {
  const s = String(v ?? '').trim();
  return /^\d{1,4}(\.\d{1,4}){0,3}$/.test(s) ? s : '';
}

/** Qurilma ID izi (bazaga xom ID yozilmaydi). Noto'g'ri qiymat — ''. */
export function deviceFingerprint(raw) {
  const s = String(raw ?? '').trim();
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(s)) return '';
  return crypto.createHash('sha256').update(`lokma-device:${s}`).digest('hex').slice(0, 32);
}

/** So'rovdan mijoz kanali. Header bo'lmasa channel = null (noma'lum). */
export function readClient(req) {
  const raw = header(req, 'X-Lokma-Client').toLowerCase();
  const channel = CHANNELS.includes(raw) ? raw : null;
  const native = NATIVE_CHANNELS.includes(channel);
  return {
    channel,
    appVersion: native ? normalizeVersion(header(req, 'X-Lokma-App-Version')) : '',
    deviceId: native ? deviceFingerprint(header(req, 'X-Lokma-Device')) : '',
  };
}

/** Qoida kanallari (bo'sh — hammasi) shu kanalga mosmi. 'app' = ios + android. Noma'lum kanal — faqat bo'sh ro'yxatga. */
export function channelMatches(targets, channel) {
  if (!Array.isArray(targets) || !targets.length) return true;
  if (!channel) return false;
  return targets.some((t) => t === channel || (t === 'app' && NATIVE_CHANNELS.includes(channel)));
}

/** Versiyalarni solishtirish: -1 | 0 | 1 ("1.10" > "1.9"). */
export function compareVersions(a, b) {
  const pa = String(a || '0').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '0').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}
