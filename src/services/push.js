import webpush from 'web-push';
import { PushSubscription } from '../models/PushSubscription.js';
import { config } from '../config/index.js';

/**
 * Web Push — brauzer yopiq bo'lganda ham xabar yetkazish.
 *
 * Oqim:
 *   notify() → sendPush() → brauzer push xizmati → Service Worker
 *   → operatsion tizim bildirishnomasi
 *
 * Muhim cheklov: brauzer yopiq bo'lganda o'z MP3 faylimizni
 * chalib bo'lmaydi — bu platforma qoidasi. Shuning uchun OS ning
 * o'z bildirishnoma ovozi ishlatiladi.
 */

let ready = false;

export function initPush() {
  const { vapidPublicKey, vapidPrivateKey, vapidSubject } = config;
  if (!vapidPublicKey || !vapidPrivateKey) {
    console.warn('[push] VAPID kalitlari yo‘q — push o‘chirilgan');
    return false;
  }
  webpush.setVapidDetails(vapidSubject || 'mailto:support@lokma.uz', vapidPublicKey, vapidPrivateKey);
  ready = true;
  return true;
}

export const pushEnabled = () => ready;

/** Faqat muhim hodisalar push bo'ladi — telefonni behuda bezovta qilmaymiz. */
const PUSHABLE = new Set(['order', 'hall_order', 'reservation', 'waiter_call', 'bill_request']);

/**
 * Bildirishnomani tegishli qurilmalarga yuborish.
 *
 * Qamrov qat'iy: restoran bildirishnomasi faqat o'sha restoran
 * qurilmalariga boradi. Boshqa restoran hech qachon ko'rmaydi.
 */
export async function sendPush(notification) {
  if (!ready) return { sent: 0, skipped: 'push o‘chirilgan' };
  if (!PUSHABLE.has(notification.type)) return { sent: 0, skipped: 'push kerak emas' };

  const filter = notification.audience === 'admin'
    ? { role: 'admin' }
    : { role: 'restaurant', restaurantId: notification.restaurantId };

  // Filial ko'rsatilgan bo'lsa — faqat o'sha filial qurilmalari
  // yoki filialsiz (bosh) qurilmalar
  if (notification.branchId) {
    filter.$or = [{ branchId: notification.branchId }, { branchId: { $exists: false } }, { branchId: null }];
  }

  const subs = await PushSubscription.find(filter).lean();
  if (subs.length === 0) return { sent: 0 };

  // Payload kichik bo'lsin: maxfiy ma'lumot qo'shmaymiz,
  // faqat ochish uchun kerakli havolalar
  const payload = JSON.stringify({
    notificationId: notification.notificationId,
    type: notification.type,
    title: notification.title,
    body: notification.body,
    priority: notification.priority || 'NORMAL',
    refType: notification.refType,
    refId: notification.refId,
    url: routeFor(notification),
  });

  const options = {
    TTL: notification.priority === 'CRITICAL' ? 3600 : 900,
    urgency: notification.priority === 'CRITICAL' ? 'high' : 'normal',
  };

  let sent = 0;
  await Promise.all(subs.map(async (sub) => {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: sub.keys },
        payload,
        options,
      );
      sent += 1;
      if (sub.failCount) {
        await PushSubscription.updateOne({ _id: sub._id }, { failCount: 0, lastSeen: new Date() });
      }
    } catch (err) {
      await handleFailure(sub, err);
    }
  }));

  return { sent, total: subs.length };
}

/**
 * Xato bo'lganda. 404/410 — obuna butunlay yaroqsiz, darhol
 * o'chiramiz. Boshqa xatolar vaqtincha bo'lishi mumkin:
 * uch marta ketma-ket bo'lsagina o'chiramiz.
 */
async function handleFailure(sub, err) {
  const code = err?.statusCode;
  if (code === 404 || code === 410) {
    await PushSubscription.deleteOne({ _id: sub._id });
    return;
  }
  const fails = (sub.failCount || 0) + 1;
  if (fails >= 3) await PushSubscription.deleteOne({ _id: sub._id });
  else await PushSubscription.updateOne({ _id: sub._id }, { failCount: fails });
}

/** Bosilganda qaysi sahifa ochiladi. */
function routeFor(n) {
  if (n.refType === 'reservation') return '/reservations';
  if (n.refType === 'table' || n.type === 'hall_order') return '/dine-in-live';
  return '/orders';
}
