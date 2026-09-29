import crypto from 'node:crypto';
import net from 'node:net';
import { config } from '../config/index.js';
import { Restaurant } from '../models/Restaurant.js';
import { isValidId } from './androidGatewayAuth.js';

/*
 * ═══════════════════════════════════════════════════════════
 * ANDROID GATEWAY — SERVIS-SERVIS KIRISH (BFF)
 * ═══════════════════════════════════════════════════════════
 *
 *   /app/service/:restaurantId/...        sarlavha: x-gateway-key: <kalit>
 *
 * NEGA PIN YETARLI EMAS: PIN 4 xonali, URL'da turadi va IP bo'yicha
 * `loginLimiter` ostida (10 ta muvaffaqiyatsiz so'rov / 15 daq). BFF
 * barcha restoranlar uchun BITTA IP bo'lgani uchun 10 ta biznes xatosi
 * (400 WRONG_STATE, 404) — masalan bitta restoranning ikki marta
 * bosilgan tugmasi — butun kanalni 15 daqiqaga o'chirardi (haqiqiy
 * so'rov bilan o'lchangan). PIN esa nginx access log'iga tushadi.
 *
 * BU YERDA:
 *   • kalit sarlavhada, URL'da emas;
 *   • BFF IP ro'yxati (allowlist) — kalit sizib chiqsa ham boshqa
 *     manzildan ishlamaydi;
 *   • PIN va loginLimiter'dan CHIQARILGAN: faqat XATO KALIT urinishlari
 *     sanaladi (biznes xatolari — yo'q);
 *   • `restaurantId` yo'lda QOLADI — har so'rov aniq restoranga bog'lanadi,
 *     restaurantPanelController ning tayyor handlerlari shu bilan ishlaydi.
 *
 * FAIL-CLOSED: kalit ham, IP ro'yxati ham to'lmagan bo'lsa marshrut
 * "yo'q" (404). Kalit bor-u ro'yxat bo'sh bo'lsa ham ochilmaydi.
 *
 * MUHIM (deploy): `req.ip` nginx qo'shgan X-Forwarded-For'ning O'NG
 * elementi (trust proxy 1). Node portiga tashqaridan to'g'ridan-to'g'ri
 * kirib bo'lmasligi shart (127.0.0.1 ga bog'lang / xavfsizlik devori) —
 * aks holda mijoz o'z X-Forwarded-For'ini yozib, IP ro'yxatini aldardi.
 */

const MIN_KEY_LENGTH = 24;
const FAIL_LIMIT = 30;              // xato kalit urinishlari
const FAIL_WINDOW_MS = 10 * 60_000; // 10 daqiqada

/** '::ffff:1.2.3.4' → '1.2.3.4'; zona (%eth0) va registr tozalanadi. */
export function normalizeIp(ip) {
  let v = String(ip || '').trim().toLowerCase().replace(/%.*$/, '');
  const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) v = mapped[1];
  return v;
}

/**
 * IP ro'yxati. Yozuvlar: "203.0.113.5", "10.0.0.0/24", "::1", "2001:db8::/48".
 * Juda keng diapazonlar (/0…/7 IPv4, /0…/15 IPv6) RAD ETILADI — bitta
 * xato yozuv ("0.0.0.0/0") butun himoyani yo'q qilardi.
 * @returns {{ matches: (ip: string) => boolean, count: number, invalid: string[] }}
 */
export function buildIpMatcher(entries) {
  const list = new net.BlockList();
  const invalid = [];
  let count = 0;
  for (const raw of entries) {
    const [addrRaw, prefixRaw] = String(raw).trim().split('/');
    const addr = normalizeIp(addrRaw);
    const family = net.isIPv4(addr) ? 'ipv4' : net.isIPv6(addr) ? 'ipv6' : null;
    if (!family) { invalid.push(raw); continue; }
    if (prefixRaw === undefined) {
      list.addAddress(addr, family);
    } else {
      const bits = Number(prefixRaw);
      const [min, max] = family === 'ipv4' ? [8, 32] : [16, 128];
      if (!/^\d+$/.test(prefixRaw) || bits < min || bits > max) { invalid.push(raw); continue; }
      list.addSubnet(addr, bits, family);
    }
    count++;
  }
  return {
    count,
    invalid,
    matches(ip) {
      const v = normalizeIp(ip);
      const family = net.isIPv4(v) ? 'ipv4' : net.isIPv6(v) ? 'ipv6' : null;
      return family ? list.check(v, family) : false;
    },
  };
}

/* Sozlama o'zgarganda (test) qayta quriladi; oddiy ishlashda bir marta */
let matcherCache = { key: null, matcher: null };
function ipMatcher() {
  const key = config.gatewayAllowedIps.join(',');
  if (matcherCache.key !== key) {
    const matcher = buildIpMatcher(config.gatewayAllowedIps);
    if (matcher.invalid.length) {
      console.error(`[gateway] GATEWAY_ALLOWED_IPS da yaroqsiz/juda keng yozuvlar e'tiborsiz: ${matcher.invalid.join(', ')}`);
    }
    matcherCache = { key, matcher };
  }
  return matcherCache.matcher;
}

/** Servis kirishi ishlashga tayyormi (kalit yetarli uzun VA ro'yxatda kamida 1 ta yaroqli IP) */
export function isServiceGatewayEnabled() {
  return config.gatewayServiceKey.length >= MIN_KEY_LENGTH && ipMatcher().count > 0;
}

/** Ishga tushganda bir marta: sozlama holati haqida aniq log */
export function logServiceGatewayStatus() {
  const hasKey = Boolean(config.gatewayServiceKey);
  if (!hasKey && !config.gatewayAllowedIps.length) return;
  if (hasKey && config.gatewayServiceKey.length < MIN_KEY_LENGTH) {
    console.error(`✗ GATEWAY_SERVICE_KEY juda qisqa (${config.gatewayServiceKey.length} < ${MIN_KEY_LENGTH}) — servis kirishi O'CHIQ. Yarating: openssl rand -hex 32`);
    return;
  }
  if (isServiceGatewayEnabled()) {
    console.log(`✓ Servis gateway (/app/service/…): ${ipMatcher().count} ta ruxsat etilgan IP`);
  } else {
    console.error('✗ GATEWAY_SERVICE_KEY bor, lekin GATEWAY_ALLOWED_IPS bo‘sh/yaroqsiz — servis kirishi O‘CHIQ (fail-closed)');
  }
}

const digest = (s) => crypto.createHash('sha256').update(String(s)).digest();
const keyMatches = (provided) => crypto.timingSafeEqual(digest(provided), digest(config.gatewayServiceKey));

/* Xato kalit urinishlari (IP bo'yicha, xotirada). Biznes xatolari SANALMAYDI. */
const fails = new Map();
function failState(ip) {
  const now = Date.now();
  const s = fails.get(ip);
  if (!s || s.resetAt <= now) return null;
  return s;
}
function registerFail(ip) {
  const now = Date.now();
  const s = failState(ip) || { n: 0, resetAt: now + FAIL_WINDOW_MS };
  s.n += 1;
  fails.set(ip, s);
  if (fails.size > 1000) for (const [k, v] of fails) if (v.resetAt <= now) fails.delete(k);
  return s;
}

// Ruxsatsiz IP haqida log — sozlash xatosini (nginx X-Forwarded-For) topish uchun, spamsiz
const deniedLogged = new Map();
function logDenied(ip) {
  const now = Date.now();
  if ((deniedLogged.get(ip) || 0) > now - 60_000) return;
  deniedLogged.set(ip, now);
  if (deniedLogged.size > 500) deniedLogged.clear();
  console.warn(`[gateway] servis kirishi rad etildi — IP ro‘yxatda yo‘q: ${ip}`);
}

/** Express middleware: /app/service/:restaurantId/... */
export async function serviceGatewayAuth(req, res, next) {
  // Sozlanmagan — marshrut "yo'q" (mavjudligi ham sezilmasin)
  if (!isServiceGatewayEnabled()) return res.status(404).json({ error: 'Topilmadi' });

  const ip = normalizeIp(req.ip);
  if (!ipMatcher().matches(ip)) {
    logDenied(ip);
    return res.status(403).json({ error: 'Bu manzildan ruxsat yo‘q', code: 'SERVICE_IP_DENIED' });
  }

  const blocked = failState(ip);
  if (blocked && blocked.n >= FAIL_LIMIT) {
    const retryAfter = Math.ceil((blocked.resetAt - Date.now()) / 1000);
    res.set('Retry-After', String(retryAfter));
    return res.status(429).json({ error: 'Kalit noto‘g‘ri urinishlari ko‘p', code: 'SERVICE_AUTH_BLOCKED', retryAfter });
  }

  const provided = req.get('x-gateway-key');
  if (!provided || !keyMatches(provided)) {
    registerFail(ip);
    return res.status(401).json({ error: 'Servis kaliti noto‘g‘ri', code: 'SERVICE_KEY_INVALID' });
  }
  fails.delete(ip);

  const { restaurantId } = req.params;
  if (!isValidId(restaurantId)) {
    return res.status(400).json({ error: 'Noto‘g‘ri restoran ID', code: 'INVALID_RESTAURANT_ID' });
  }
  const restaurant = await Restaurant.findById(restaurantId).select('name isBlocked').lean();
  if (!restaurant) {
    return res.status(404).json({ error: 'Restoran topilmadi', code: 'RESTAURANT_NOT_FOUND' });
  }
  if (restaurant.isBlocked) {
    return res.status(403).json({ error: 'Restoran bloklangan', code: 'RESTAURANT_BLOCKED' });
  }

  req.restaurantId = String(restaurant._id);
  req.restaurantName = restaurant.name;
  req.gatewaySource = 'service';
  next();
}
