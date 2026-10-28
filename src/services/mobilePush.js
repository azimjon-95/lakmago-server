import crypto from 'node:crypto';
import http2 from 'node:http2';
import { readFileSync } from 'node:fs';
import { config } from '../config/index.js';
import { MobileDevice } from '../models/MobileDevice.js';
import { OrderPushState } from '../models/OrderPushState.js';
import { Order } from '../models/Order.js';

/**
 * ═══════════════════════════════════════════════════════════
 * RESTORAN MOBIL ILOVASIGA PUSH (Android: FCM HTTP v1, iOS: APNs)
 * ═══════════════════════════════════════════════════════════
 *
 * Nima uchun: ilova faqat Socket.IO'ga tayanardi. Telefon qulflansa / ilova fonda yoki yopiq bo'lsa OS soketni
 * to'xtatadi → yangi buyurtma faqat ilova QO'LDA ochilganda kelardi. Push — OS'ning o'zi uyg'otadigan yagona kanal.
 *
 * Qayerdan chaqiriladi: faqat services/orderSocket.js → emitOrderToRestaurant(). U esa 1-QOIDA (awaiting_payment)
 * tekshiruvidan KEYINgina chaqiriladi; shunga qaramay bu yerda ham ALOHIDA tekshiriladi (CLAUDE.md: har kanal o'zi).
 *
 * Kafolatlar:
 *  • dublikat yo'q: bir buyurtma uchun "yangi" bir marta (OrderPushState.orderId unique), takrorlar faqat taymerdan;
 *  • qabul qilinmaguncha qayta yuboriladi (iOS o'zi takrorlay olmaydi): har MOBILE_PUSH_REPEAT_SEC, MOBILE_PUSH_MAX_SENDS gacha;
 *  • qabul / bekor qilinishi bilan to'xtaydi va boshqa telefonlarga "signalni to'xtat" yuboriladi;
 *  • faqat O'Z restoranining qurilmalariga; payloadda moliya yoki mijoz ma'lumoti yo'q (faqat raqam va summa);
 *  • xatosi buyurtma oqimini HECH QACHON buzmaydi (fire-and-forget, hammasi ushlanadi);
 *  • yaroqsiz token (FCM UNREGISTERED, APNs 410/BadDeviceToken) o'chiriladi, vaqtinchalik xato hisoblanadi.
 * Provayder "qabul qildi" degani telefonga yetdi degani EMAS — shuning uchun qabul qilinmaguncha qayta yuboriladi.
 */

const b64url = (v) => Buffer.from(v).toString('base64url');

/** JWT (RS256 — Google OAuth, ES256 — APNs). Kutubxonasiz: node:crypto. */
export function signJwt(header, claims, privateKey, alg) {
  const data = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const sig = alg === 'RS256'
    ? crypto.sign('RSA-SHA256', Buffer.from(data), privateKey)
    : crypto.sign('sha256', Buffer.from(data), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  return `${data}.${b64url(sig)}`;
}

/* ─────────────── provayderlar ─────────────── */

let fcmAccount = null;                 // Firebase service account (client_email, private_key, project_id)
let fcmAccess = { value: '', exp: 0 };
let apnsKey = null;                    // .p8 (PEM)
let apnsJwt = { value: '', at: 0 };
const apnsSessions = new Map();         // host → http2 sessiya (sandbox va production alohida)
let transports = null;                 // faqat testlar uchun

export function initMobilePush() {
  fcmAccount = null; apnsKey = null; fcmAccess = { value: '', exp: 0 }; apnsJwt = { value: '', at: 0 };
  try {
    const raw = config.fcmServiceAccountBase64
      ? Buffer.from(config.fcmServiceAccountBase64, 'base64').toString('utf8')
      : (config.fcmServiceAccountFile ? readFileSync(config.fcmServiceAccountFile, 'utf8') : '');
    if (raw) {
      const a = JSON.parse(raw);
      if (a.client_email && a.private_key && a.project_id) fcmAccount = a;
      else console.warn('[mobilePush] FCM service account to‘liq emas — Android push o‘chiq');
    }
  } catch { console.warn('[mobilePush] FCM sozlamasi o‘qilmadi (base64 / JSON formatini tekshiring; sir logga yozilmaydi)'); }
  try {
    if (config.apnsKeyBase64 && config.apnsKeyId && config.apnsTeamId) apnsKey = Buffer.from(config.apnsKeyBase64, 'base64').toString('utf8');
  } catch { console.warn('[mobilePush] APNs kaliti o‘qilmadi (base64 formatini tekshiring; sir logga yozilmaydi)'); }
  OrderPushState.init().catch(() => {});
  lastCheck = { android: fcmAccount ? 'tekshirilmoqda' : 'off', ios: apnsKey ? 'tekshirilmoqda' : 'off' };
  if (fcmAccount || apnsKey) verifyProviders().catch(() => {});          // unique indeks dublikatni ushlashi uchun oldindan quriladi
  console.log(`[mobilePush] Android(FCM): ${fcmAccount ? 'yoqilgan' : 'o‘chiq'} · iOS(APNs): ${apnsKey ? (config.apnsProduction ? 'yoqilgan (production)' : 'yoqilgan (sandbox)') : 'o‘chiq'}`);
  return providers();
}

/**
 * Sozlamani ISHGA TUSHGANDA tekshiradi (telefonsiz): serverni qayta ishga tushirgach logda ko'rinadi, GET /api/panel/devices ham qaytaradi.
 *  Android: Google OAuth + FCM `validate_only` (xabar YUBORILMAYDI): 200/400 = kalit va loyiha to'g'ri, 401/403/404 = sozlama xato.
 *  iOS: .p8 kalit ochiladi va imzo chiqadi (Apple bilan haqiqiy tekshiruv faqat telefon tokeni bilan mumkin — «Test push»).
 */
let lastCheck = { android: 'off', ios: 'off' };
export const providerCheck = () => lastCheck;
export async function verifyProviders() {
  const out = { android: 'off', ios: 'off' };
  if (fcmAccount) {
    try {
      const access = await fcmToken();
      const r = await fetch(`https://fcm.googleapis.com/v1/projects/${fcmAccount.project_id}/messages:send`, {
        method: 'POST', headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' },
        body: JSON.stringify({ validate_only: true, message: { token: 'x'.repeat(40), data: { type: 'check' } } }),
        signal: AbortSignal.timeout(config.mobilePushTimeoutMs),
      });
      out.android = (r.status === 200 || r.status === 400) ? 'ok' : `xato: FCM ${r.status} (kalit/loyiha/Cloud Messaging API'ni tekshiring)`;
    } catch (e) { out.android = `xato: ${String(e.message || e).slice(0, 120)}`; }
  } else if (transports?.fcm) out.android = 'test';
  if (apnsKey) {
    try { apnsJwt = { value: '', at: 0 }; apnsAuth(); out.ios = 'kalit ochildi (Apple bilan tekshirish: «Test push»)'; }
    catch { out.ios = 'xato: .p8 kalit ochilmadi (APNS_KEY_BASE64 formatini tekshiring)'; }
  } else if (transports?.apns) out.ios = 'test';
  lastCheck = out;
  console.log(`[mobilePush] tekshiruv: Android=${out.android} · iOS=${out.ios}`);
  return out;
}

export const providers = () => ({ android: !!(fcmAccount || transports?.fcm), ios: !!(apnsKey || transports?.apns) });
const anyEnabled = () => { const p = providers(); return p.android || p.ios; };

/** Testlar: haqiqiy FCM/APNs o'rniga soxta yuboruvchi. null → asl holat. */
export function _setTransportsForTest(t) { transports = t; }

async function fcmToken() {
  if (fcmAccess.value && Date.now() < fcmAccess.exp - 60_000) return fcmAccess.value;
  const now = Math.floor(Date.now() / 1000);
  const aud = fcmAccount.token_uri || 'https://oauth2.googleapis.com/token';
  const assertion = signJwt({ alg: 'RS256', typ: 'JWT' }, {
    iss: fcmAccount.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud, iat: now, exp: now + 3600,
  }, fcmAccount.private_key, 'RS256');
  const r = await fetch(aud, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
    signal: AbortSignal.timeout(config.mobilePushTimeoutMs),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(`FCM OAuth ${r.status} ${j.error || ''}`.trim());
  fcmAccess = { value: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return fcmAccess.value;
}

export async function sendFcm(token, message) {
  if (transports?.fcm) return transports.fcm(token, message);
  try {
    const access = await fcmToken();
    const r = await fetch(`https://fcm.googleapis.com/v1/projects/${fcmAccount.project_id}/messages:send`, {
      method: 'POST', headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' },
      body: JSON.stringify({ message: { token, ...message } }), signal: AbortSignal.timeout(config.mobilePushTimeoutMs),
    });
    if (r.ok) return { ok: true };
    const j = await r.json().catch(() => ({}));
    const status = j?.error?.status || '';
    const codes = (j?.error?.details || []).map((d) => d.errorCode).filter(Boolean).join(',');
    // Faqat TOKEN yaroqsiz bo'lsa o'chiramiz. INVALID_ARGUMENT payload xatosi ham bo'lishi mumkin — uni token deb hisoblamaymiz.
    const dead = r.status === 404 || status === 'UNREGISTERED' || /UNREGISTERED/.test(codes)
      || (r.status === 400 && /registration token/i.test(j?.error?.message || ''));
    if (r.status === 401) fcmAccess = { value: '', exp: 0 };
    return { ok: false, dead, error: `FCM ${r.status} ${status} ${codes}`.trim() };
  } catch (e) { return { ok: false, error: `FCM ${e.message}` }; }
}

function apnsAuth() {
  if (apnsJwt.value && Date.now() - apnsJwt.at < 50 * 60_000) return apnsJwt.value;   // Apple: 20–60 daqiqada yangilash
  apnsJwt = { value: signJwt({ alg: 'ES256', kid: config.apnsKeyId }, { iss: config.apnsTeamId, iat: Math.floor(Date.now() / 1000) }, apnsKey, 'ES256'), at: Date.now() };
  return apnsJwt.value;
}

/** Qurilma muhiti → APNs manzili. Muhit noma'lum bo'lsa APNS_PRODUCTION. APNS_HOST (faqat test) hammasini almashtiradi. */
export function apnsHostFor(environment) {
  if (config.apnsHost) return config.apnsHost;
  const prod = environment === 'production' || (environment !== 'development' && config.apnsProduction);
  return prod ? 'https://api.push.apple.com' : 'https://api.sandbox.push.apple.com';
}

function apnsConn(host) {
  let session = apnsSessions.get(host);
  if (!session || session.closed || session.destroyed) {
    session = http2.connect(host);
    const drop = () => { if (apnsSessions.get(host) === session) apnsSessions.delete(host); };
    session.on('error', drop); session.on('goaway', drop); session.on('close', drop);
    session.unref?.();
    apnsSessions.set(host, session);
  }
  return session;
}

export function sendApns(token, payload, headers, environment = null) {
  if (transports?.apns) return transports.apns(token, payload, headers, environment);
  return new Promise((resolve) => {
    let req;
    try {
      req = apnsConn(apnsHostFor(environment)).request({
        ':method': 'POST', ':path': `/3/device/${token}`, authorization: `bearer ${apnsAuth()}`,
        'apns-topic': config.apnsBundleId, 'content-type': 'application/json', ...headers,
      });
    } catch (e) { apnsSessions.delete(apnsHostFor(environment)); resolve({ ok: false, error: `APNs ${e.message}` }); return; }
    let status = 0; let body = '';
    req.setTimeout(config.mobilePushTimeoutMs, () => { req.close(); resolve({ ok: false, error: 'APNs timeout' }); });
    req.on('response', (h) => { status = h[':status']; });
    req.setEncoding('utf8');
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (status === 200) { resolve({ ok: true }); return; }
      let reason = ''; try { reason = JSON.parse(body).reason || ''; } catch { /* bo'sh javob */ }
      if (reason === 'ExpiredProviderToken') apnsJwt = { value: '', at: 0 };
      const dead = status === 410 || ['BadDeviceToken', 'Unregistered', 'DeviceTokenNotForTopic'].includes(reason);
      resolve({ ok: false, dead, error: `APNs ${status} ${reason}`.trim() });
    });
    req.on('error', (e) => { apnsSessions.delete(apnsHostFor(environment)); resolve({ ok: false, error: `APNs ${e.message}` }); });
    req.end(JSON.stringify(payload));
  });
}

/* ─────────────── xabarlar ─────────────── */

const label = (o) => (o.dailyNumber ? `#${o.dailyNumber}` : `#${String(o._id).slice(-4).toUpperCase()}`);
const som = (n) => `${String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} so'm`;
const STATUS_TEXT = {
  accepted: 'qabul qilindi', preparing: 'tayyorlanmoqda', ready: 'tayyor', delivering: 'yetkazilmoqda',
  delivered: 'yetkazildi', cancelled: 'bekor qilindi',
};

/** Android: faqat `data` + yuqori ustuvorlik → ilova yopiq bo'lsa ham uyg'onadi va o'zi takrorlanuvchi signal chaladi. */
export function androidMessage(kind, order, sendNo = 1) {
  const id = String(order._id);
  return {
    data: {
      type: kind, orderId: id, sendNo: String(sendNo),
      title: kind === 'order_new' ? '🔔 Yangi buyurtma' : `${label(order)} ${STATUS_TEXT[order.status] || order.status}`,
      body: kind === 'order_new' ? `${label(order)} • ${som(order.total)}` : '',
    },
    android: { priority: 'HIGH', ttl: kind === 'order_new' ? '600s' : '120s', collapse_key: `order-${id}` },
  };
}

/** iOS: OS o'zi ko'rsatadigan ovozli, "Time Sensitive" xabar. Bir buyurtmaning xabarlari bitta bo'lib turadi (collapse-id). */
export function iosMessage(kind, order, now = Date.now()) {
  const id = String(order._id);
  const headers = { 'apns-push-type': 'alert', 'apns-collapse-id': `order-${id}`, 'apns-expiration': String(Math.floor(now / 1000) + 600) };
  if (kind === 'order_new') {
    return {
      headers: { ...headers, 'apns-priority': '10' },
      payload: {
        aps: { alert: { title: '🔔 Yangi buyurtma', body: `${label(order)} • ${som(order.total)} — qabul qilinmagan` }, sound: 'order_alert.wav', 'interruption-level': 'time-sensitive', 'thread-id': 'orders' },
        type: kind, orderId: id,
      },
    };
  }
  // Holat o'zgardi: shu buyurtmaning ovozli xabari OVOZSIZ "qabul qilindi / bekor qilindi" bilan almashtiriladi.
  return {
    headers: { ...headers, 'apns-priority': '5' },
    payload: { aps: { alert: { title: `${label(order)} ${STATUS_TEXT[order.status] || order.status}`, body: '' }, 'interruption-level': 'passive', 'thread-id': 'orders' }, type: kind, orderId: id },
  };
}

/** Restoranning barcha telefonlariga yuboradi. Natija: { sent, failed, removed, total }. */
async function deliver(restaurantId, kind, order, sendNo) {
  const p = providers();
  const devices = await MobileDevice.find({ restaurantId }).lean();
  const out = { sent: 0, failed: 0, removed: 0, total: 0 };
  await Promise.all(devices.map(async (d) => {
    if (!p[d.platform]) return;
    out.total += 1;
    let r;
    if (d.platform === 'android') r = await sendFcm(d.token, androidMessage(kind, order, sendNo));
    else { const m = iosMessage(kind, order); r = await sendApns(d.token, m.payload, m.headers, d.environment || null); }
    if (r.ok) {
      out.sent += 1;
      await MobileDevice.updateOne({ _id: d._id }, { $set: { lastSentAt: new Date(), lastError: '', failCount: 0 } });
    } else if (r.dead) {
      out.removed += 1; out.failed += 1;
      await MobileDevice.deleteOne({ _id: d._id });
    } else {
      out.failed += 1;
      const fails = (d.failCount || 0) + 1;
      if (fails >= 5) await MobileDevice.deleteOne({ _id: d._id });      // 5 marta ketma-ket — token o'lik deb hisoblanadi
      else await MobileDevice.updateOne({ _id: d._id }, { $set: { failCount: fails, lastError: String(r.error || '').slice(0, 300) } });
    }
  }));
  if (out.total) console.log(`[mobilePush] ${kind} ${label(order)} (${sendNo || '-'}) → ${out.sent}/${out.total} qabul qilindi${out.failed ? `, ${out.failed} xato` : ''}${out.removed ? `, ${out.removed} token o'chirildi` : ''}`);
  return out;
}

/**
 * Diagnostika: "push ishlayaptimi?" — restoranning HAR BIR telefoniga test xabari yuboradi va provayder javobini aynan
 * qaytaradi (masalan "APNs 403 InvalidProviderToken", "FCM 401"). Ilovadagi «Push tekshiruvi» shuni chaqiradi: jimgina
 * ishlamayotgan pushning sababi ko'rinib qoladi. Buyurtmaga, to'lovga tegmaydi.
 * @returns [{ platform, token: '…abc123', ok, error? }]
 */
export async function sendTestPush(restaurantId) {
  const p = providers();
  const devices = await MobileDevice.find({ restaurantId }).lean();
  const out = [];
  await Promise.all(devices.map(async (d) => {
    const row = { platform: d.platform, token: `…${String(d.token).slice(-6)}`, ok: false };
    if (!p[d.platform]) { row.error = d.platform === 'ios' ? 'Serverda APNs sozlanmagan (APNS_KEY_BASE64, APNS_KEY_ID, APNS_TEAM_ID)' : 'Serverda FCM sozlanmagan (FCM_SERVICE_ACCOUNT_BASE64)'; out.push(row); return; }
    const r = d.platform === 'android'
      ? await sendFcm(d.token, { data: { type: 'test', title: 'Push ishlayapti ✓', body: 'Ilova yopiq bo\'lsa ham yangi buyurtma shunday keladi' }, android: { priority: 'HIGH', ttl: '60s' } })
      : await sendApns(d.token, { aps: { alert: { title: 'Push ishlayapti ✓', body: 'Ilova yopiq bo\'lsa ham yangi buyurtma shunday keladi' }, sound: 'order_alert.wav', 'interruption-level': 'time-sensitive' }, type: 'test' },
        { 'apns-push-type': 'alert', 'apns-priority': '10', 'apns-expiration': String(Math.floor(Date.now() / 1000) + 60) }, d.environment || null);
    row.ok = !!r.ok;
    if (!r.ok) row.error = r.error || 'noma\'lum xato';
    if (r.dead) { row.error = `${row.error} — token yaroqsiz, o'chirildi (ilova qayta ro'yxatdan o'tadi)`; await MobileDevice.deleteOne({ _id: d._id }); }
    out.push(row);
  }));
  return out;
}

/* ─────────────── hodisalar ─────────────── */

/**
 * services/orderSocket.js → emitOrderToRestaurant() dan chaqiriladi.
 *  order:new    — pending buyurtma: hammaga "yangi buyurtma" (bir marta)
 *  order:update — pending dan chiqdi: takrorlar to'xtaydi, telefonlarga "signalni to'xtat"
 */
export async function onOrderEvent(event, order) {
  if (!order?._id || !order.restaurantId || !anyEnabled()) return;
  const status = order.status;
  // 1-QOIDA: to'lov tasdiqlanmagan buyurtma restoranga HECH QANDAY yo'l bilan bormaydi (bu kanal ham o'zi tekshiradi).
  if (status === 'awaiting_payment') return;

  if (event === 'order:new') {
    if (status !== 'pending') return;
    let state;
    try {
      state = await OrderPushState.create({ orderId: order._id, restaurantId: order.restaurantId, sentCount: 1, lastSentAt: new Date() });
    } catch (e) {
      if (e?.code === 11000) return;            // shu buyurtma uchun "yangi" allaqachon yuborilgan (retry / ikki emit)
      throw e;
    }
    const r = await deliver(order.restaurantId, 'order_new', order, 1);
    await OrderPushState.updateOne({ _id: state._id }, { $inc: { delivered: r.sent, failed: r.failed } });
    return;
  }

  if (event === 'order:update' && status !== 'pending') {
    const st = await OrderPushState.findOneAndUpdate({ orderId: order._id, done: false }, { $set: { done: true } });
    if (!st) return;                             // biz signal yubormagan buyurtma — telefonni bezovta qilmaymiz
    await deliver(order.restaurantId, status === 'cancelled' ? 'order_cancelled' : 'order_updated', order, 0);
  }
}

/** Socket emit yo'lini HECH QACHON sekinlashtirmaydi va buzmaydi. */
export function pushOrderEvent(event, order) {
  onOrderEvent(event, order).catch((e) => console.error('[mobilePush]', e.message));
}

/**
 * Taymer (index.js, har 10 s): qabul qilinmagan buyurtma uchun pushni qayta yuboradi.
 * Bir nechta server nusxasi bo'lsa ham bitta yuboradi (atomik "egallash").
 */
export async function checkPendingOrderPushes(now = Date.now()) {
  if (!anyEnabled()) return 0;
  const repeatMs = Math.max(10, config.mobilePushRepeatSec) * 1000;
  const max = Math.max(1, config.mobilePushMaxSends);
  const due = await OrderPushState.find({ done: false, lastSentAt: { $lte: new Date(now - repeatMs) } }).limit(100).lean();
  let sent = 0;
  for (const s of due) {
    if (s.sentCount >= max) { await OrderPushState.updateOne({ _id: s._id }, { $set: { done: true } }); continue; }
    const claimed = await OrderPushState.findOneAndUpdate(
      { _id: s._id, done: false, sentCount: s.sentCount },
      { $inc: { sentCount: 1 }, $set: { lastSentAt: new Date(now) } },
      { new: true },
    );
    if (!claimed) continue;                      // boshqa nusxa ulgurdi
    const order = await Order.findById(s.orderId).select('status restaurantId dailyNumber total').lean();
    if (!order || order.status !== 'pending') { await OrderPushState.updateOne({ _id: s._id }, { $set: { done: true } }); continue; }
    const r = await deliver(order.restaurantId, 'order_new', order, claimed.sentCount);
    await OrderPushState.updateOne({ _id: s._id }, {
      $inc: { delivered: r.sent, failed: r.failed },
      ...(claimed.sentCount >= max ? { $set: { done: true } } : {}),
    });
    sent += 1;
  }
  return sent;
}
