import { CourierDevice } from '../models/CourierDevice.js';
import { CourierAccount } from '../models/CourierAccount.js';
import { CourierOffer } from '../models/CourierOffer.js';
import { DeliveryAssignment } from '../models/DeliveryAssignment.js';
import { Order } from '../models/Order.js';
import { config } from '../config/index.js';
import { sendFcm, sendApns, providers } from './mobilePush.js';
import { nearby } from './courierPresence.js';
import { offerView } from './courierApp.js';

/**
 * KURYERGA TAKLIF PUSH'I. Kuryer ilovasi yopiq / telefon bloklangan bo'lsa ham OS orqali keladi (restoran push'i bilan bir xil
 * provayderlar va kalitlar). Restoran signalidan ALOHIDA MELODIYA (`courier_alert.wav`, iOS) va alohida tur (`courier_offer`).
 *
 * Kim oladi: SMENADA bo'lgan, joylashuvi yangi (Redis TTL), restoranga [courierOfferRadiusM] ichidagi, hozir band bo'lmagan kuryerlar —
 * eng yaqini birinchi. Har kuryerga bir taklif ko'pi bilan 3 marta, 30 soniya oralig'ida; atomik «egallash» (CourierOffer unikal indeks).
 * Taklif olingach qolganlarga «yopildi» yuboriladi. Payloadda MIJOZ MA'LUMOTI YO'Q (faqat restoran, masofa, yetkazish haqi).
 */
const REPEAT_MS = 30_000;
const MAX_ATTEMPTS = 3;
const MAX_AGE_MS = 20 * 60_000;
const OPEN_ORDER = ['accepted', 'preparing', 'ready'];
const som = (n) => `${String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} so'm`;
const km = (m) => (m == null ? '' : m < 950 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`);

export function offerMessages(v) {
  const body = [v.restaurantName, km(v.distanceM), v.deliveryFee ? `haq ${som(v.deliveryFee)}` : ''].filter(Boolean).join(' • ');
  return {
    android: {
      data: { type: 'courier_offer', assignmentId: v.id, orderCode: v.orderCode, title: '🛵 Yangi yetkazish', body, distanceM: String(v.distanceM ?? '') },
      android: { priority: 'HIGH', ttl: '120s', collapse_key: `offer-${v.id}` },
    },
    ios: {
      headers: { 'apns-push-type': 'alert', 'apns-priority': '10', 'apns-collapse-id': `offer-${v.id}`, 'apns-expiration': String(Math.floor(Date.now() / 1000) + 120) },
      payload: { aps: { alert: { title: '🛵 Yangi yetkazish', body }, sound: 'courier_alert.wav', 'interruption-level': 'time-sensitive', 'thread-id': 'courier-offers' }, type: 'courier_offer', assignmentId: v.id },
    },
  };
}

/** Kuryerning hamma telefoniga; yaroqsiz token (FCM UNREGISTERED / APNs 410) o'chiriladi, vaqtinchalik xato — yo'q. */
async function pushToCourier(courierId, build) {
  const p = providers();
  const devices = await CourierDevice.find({ courierId }).lean();
  let sent = 0;
  await Promise.all(devices.map(async (d) => {
    if (!p[d.platform]) return;
    const m = build(d.platform);
    if (!m) return;
    const r = d.platform === 'android' ? await sendFcm(d.token, m) : await sendApns(d.token, m.payload, m.headers, d.environment || null);
    if (r.ok) { sent += 1; return; }
    if (r.dead) await CourierDevice.deleteOne({ _id: d._id });
    else await CourierDevice.updateOne({ _id: d._id }, { $inc: { failCount: 1 }, $set: { lastError: String(r.error || '').slice(0, 200) } });
  }));
  return sent;
}

/** true = shu kuryerga shu taklifni HOZIR yuborish mumkin (va band qilindi). Ikki tick / ikki server nusxasi — faqat bittasi. */
async function claimOffer(assignmentId, courierId, now) {
  try {
    const r = await CourierOffer.findOneAndUpdate(
      { assignmentId, courierId, attempts: { $lt: MAX_ATTEMPTS }, $or: [{ lastSentAt: null }, { lastSentAt: { $lte: new Date(now - REPEAT_MS) } }] },
      { $inc: { attempts: 1 }, $set: { lastSentAt: new Date(now) } },
      { upsert: true, new: true },
    );
    return !!r;
  } catch (e) { if (e?.code === 11000) return false; throw e; }
}

/** Timer (5 s): ochiq takliflarni yaqin kuryerlarga yuboradi. Qaytaradi: yuborilgan push soni. */
export async function dispatchOffers(now = Date.now()) {
  const p = providers();
  if (!p.android && !p.ios) return 0;
  const open = await DeliveryAssignment.find({ status: 'searching', createdAt: { $gte: new Date(now - MAX_AGE_MS) } }).sort({ createdAt: -1 }).limit(30).lean();
  if (!open.length) return 0;
  const valid = new Set((await Order.find({ _id: { $in: open.map((a) => a.orderId) }, status: { $in: OPEN_ORDER } }).select('_id').lean()).map((o) => String(o._id)));
  let sent = 0;
  for (const a of open) {
    const s = a.deliverySnapshot || {};
    if (!valid.has(String(a.orderId)) || !Number.isFinite(s.restaurantLat) || !Number.isFinite(s.restaurantLng)) continue;
    const near = await nearby({ lat: s.restaurantLat, lng: s.restaurantLng }, config.courierOfferRadiusM, { limit: 20 });
    if (!near.length) continue;
    const ids = near.map((n) => n.id);
    const ok = new Set((await CourierAccount.find({ _id: { $in: ids }, isActive: true, activeShiftId: { $ne: null } }).select('_id').lean()).map((c) => String(c._id)));
    const busy = new Set((await DeliveryAssignment.find({ assignedAccountId: { $in: ids }, status: 'assigned' }).select('assignedAccountId').lean()).map((x) => String(x.assignedAccountId)));
    for (const c of near) {
      if (!ok.has(c.id) || busy.has(c.id)) continue;
      if (!(await claimOffer(a._id, c.id, now))) continue;
      const msgs = offerMessages(offerView(a, c.distanceM));
      sent += await pushToCourier(c.id, (platform) => msgs[platform]).catch(() => 0);
    }
  }
  return sent;
}

/** Taklif olindi: boshqa kuryerlarda signal / bildirishnoma to'xtasin (Android; iOS ro'yxatni ochganda yangilanadi). */
export async function notifyOfferClosed(assignmentId, exceptCourierId) {
  const offers = await CourierOffer.find({ assignmentId, courierId: { $ne: exceptCourierId } }).select('courierId').lean();
  let n = 0;
  for (const o of offers) {
    n += await pushToCourier(o.courierId, (platform) => platform === 'android' ? { data: { type: 'courier_offer_closed', assignmentId: String(assignmentId) }, android: { priority: 'HIGH', ttl: '60s' } } : null).catch(() => 0);
  }
  return n;
}

/** Test / diagnostika: kuryerning o'ziga test push. */
export async function testCourierPush(courierId) {
  const v = { id: 'test', orderCode: '', restaurantName: 'Test', distanceM: 500, deliveryFee: 10000 };
  const m = offerMessages(v);
  m.android.data.type = 'test'; m.android.data.title = 'Push ishlayapti ✓'; m.android.data.body = 'Yangi yetkazish shunday keladi';
  m.ios.payload.type = 'test'; m.ios.payload.aps.alert = { title: 'Push ishlayapti ✓', body: 'Yangi yetkazish shunday keladi' };
  return pushToCourier(courierId, (platform) => m[platform]);
}
