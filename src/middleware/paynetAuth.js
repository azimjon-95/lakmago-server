import { config } from '../config/index.js';

/*
 * ═══ IP OQ RO'YXATI ═══
 *
 * Hujjat talabi: "Sizning API'ingizga kirish FAQAT quyidagilar
 * uchun ochiq bo'lishi kerak: 213.230.106.112/28 va
 * 213.230.65.80/28".
 *
 * Bu himoya CIDR darajasida — hatto to'g'ri login/parolni
 * bilgan kishi ham boshqa IP'dan so'rov yubora olmaydi.
 */
const PAYNET_CIDRS = ['213.230.106.112/28', '213.230.65.80/28'];

function ipToInt(ip) {
  const parts = String(ip).split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function inCidr(ip, cidr) {
  const [range, bitsStr] = cidr.split('/');
  const bits = Number(bitsStr);
  const ipNum = ipToInt(ip);
  const rangeNum = ipToInt(range);
  if (ipNum === null || rangeNum === null) return false;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipNum & mask) === (rangeNum & mask);
}

/** IPv6-mapped IPv4 manzilini tozalaydi ("::ffff:1.2.3.4" -> "1.2.3.4"). */
function normalizeIp(ip) {
  return String(ip || '').replace(/^::ffff:/, '');
}

export function paynetIpWhitelist(req, res, next) {
  /*
   * Ishlab chiqarishda kerak, lekin SINOV bosqichida Paynet
   * vakili boshqa IP'dan (o'z ofisidan, VPN orqali) test
   * qilishi mumkin. Shuning uchun cheklov ATAYLAB muhit
   * o'zgaruvchisi bilan yoqilib-o'chiriladi — ishlab chiqarishga
   * chiqishdan oldin ENABLE qilinishi shart.
   */
  if (process.env.PAYNET_IP_WHITELIST_ENABLED !== 'true') return next();

  const ip = normalizeIp(req.ip || req.connection?.remoteAddress);
  const allowed = PAYNET_CIDRS.some((cidr) => inCidr(ip, cidr));

  if (!allowed) {
    console.warn(`[paynet:ip] ruxsat etilmagan manzildan so\u2018rov: ${ip}`);
    return res.status(403).json({ error: 'IP ruxsat etilmagan' });
  }
  return next();
}

/*
 * ═══ HTTP BASIC AUTH ═══
 *
 * Hujjat talabi: "Login/parol juftligi bo'lmaganda yoki mos
 * kelmaganda, sizning serveringiz HTTP 401 Unauthorized
 * qaytarishi shart (xato ko'rsatilgan 200 OK EMAS)."
 *
 * Bu JSON-RPC error emas — chunki autentifikatsiya HTTP
 * darajasida, protokol darajasidan OLDIN tekshiriladi.
 */
export function paynetBasicAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');

  if (scheme !== 'Basic' || !encoded) {
    res.set('WWW-Authenticate', 'Basic realm="paynet-uws"');
    return res.status(401).end();
  }

  let username = '';
  let password = '';
  try {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    username = decoded.slice(0, idx);
    password = decoded.slice(idx + 1);
  } catch {
    res.set('WWW-Authenticate', 'Basic realm="paynet-uws"');
    return res.status(401).end();
  }

  if (username !== config.paynet.username || password !== config.paynet.password) {
    res.set('WWW-Authenticate', 'Basic realm="paynet-uws"');
    return res.status(401).end();
  }

  return next();
}
