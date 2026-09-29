import { config } from '../config/index.js';
import { BffEvent } from '../models/BffEvent.js';

/*
 * ═══════════════════════════════════════════════════════════
 * BFF GA BUYURTMA HODISALARI
 * ═══════════════════════════════════════════════════════════
 *
 *   POST {BFF_BASE_URL}/internal/orders/events
 *   x-webhook-secret: {BFF_WEBHOOK_SECRET}
 *   {"event":"created|updated|cancelled|delivered","restaurantId":"…","orderId":"…"}
 *
 * Body AYNAN shu uch maydon (BFF sxemasi qat'iy bo'lishi mumkin).
 * Qo'shimcha ma'lumot sarlavhalarda: x-event-id (navbat yozuvi id'si —
 * BFF takroriy yetkazishni shu bilan ajratadi), x-event-attempt.
 *
 * HODISA MA'NOSI (models/orderEvents.js hamma yo'lni ushlaydi):
 *   created   — buyurtma restoranga KO'RINADIGAN bo'ldi (naqd: yaratilganda;
 *               karta: to'lov o'tgach). To'lanmagan (awaiting_payment) yo'q.
 *   updated   — accepted/preparing/ready/delivering, to'lov belgisi,
 *               yetkazish tasdig'i eslatmasi yuborildi
 *   cancelled — bekor qilindi (kim qilganidan qat'i nazar)
 *   delivered — yetkazildi (restoran/kuryer/mijoz/avto-yakunlash)
 * Zal (dinein) buyurtmalari yubormaydi — gateway'da ular yo'q.
 *
 * KAFOLAT: kamida bir marta (at-least-once). Yuborilmasa qayta uriniladi
 * (5s, 15s, 45s, 2m, 5m, 10m, keyin har 15m; jami 12 urinish ≈ 1.5 soat).
 * Undan keyin `failed` va log — BFF qaytgach GET /orders/history bilan
 * o'tkazib yuborilganini oladi.
 * Tartib KAFOLATLANMAYDI: hodisa signal, BFF tafsilotni qayta o'qiydi.
 *
 * created / cancelled / delivered — buyurtma uchun BIR MARTA (dedupeKey);
 * updated — yuborilmagan updated bor bo'lsa qo'shilmaydi (birlashtiriladi).
 */

export const BFF_EVENT_PATH = '/internal/orders/events';
const MAX_ATTEMPTS = 12;
const BACKOFF_MS = [5_000, 15_000, 45_000, 120_000, 300_000, 600_000, 900_000];
const CREATED_DELAY_MS = 1_500; // buyurtma raqami (dailyNumber) yozib bo'linsin — BFF o'qiganda bo'sh chiqmasin
const LEASE_MS = 30_000;
const SEND_TIMEOUT_MS = 5_000;

export const isBffEventsEnabled = () => Boolean(config.bffBaseUrl && config.bffWebhookSecret);

let autoKick = true;
/** Faqat testlar uchun: avtomatik yuborishni o'chirish (test o'zi flush qiladi). */
export function setBffAutoKick(v) { autoKick = Boolean(v); }

function kick(delayMs = 0) {
  if (!autoKick) return;
  const t = setTimeout(() => { flushBffEvents().catch(() => {}); }, delayMs + 30);
  t.unref?.();
}

/** Hodisani navbatga yozadi. Hech qachon xato tashlamaydi — buyurtma yozuvini buzmasligi kerak. */
export async function enqueueOrderEvent(event, { orderId, restaurantId }) {
  if (!isBffEventsEnabled() || !orderId || !restaurantId) return false;
  try {
    const orderIdS = String(orderId);
    const doc = { event, orderId: orderIdS, restaurantId: String(restaurantId), nextAttemptAt: new Date() };

    if (event === 'updated') {
      // Yuborilmagan updated bor — u yuborilganda BFF eng oxirgi holatni o'qiydi
      const pending = await BffEvent.exists({ orderId: orderIdS, event: 'updated', doneAt: null, attempts: 0 });
      if (pending) return false;
    } else {
      doc.dedupeKey = `${event}:${orderIdS}`;
    }
    if (event === 'created') doc.nextAttemptAt = new Date(Date.now() + CREATED_DELAY_MS);

    await BffEvent.create(doc);
    kick(event === 'created' ? CREATED_DELAY_MS : 0);
    return true;
  } catch (e) {
    if (e?.code === 11000) return false; // takroriy created/cancelled/delivered — kutilgan holat
    console.error('[bffEvents] navbatga yozib bo‘lmadi:', e.message);
    return false;
  }
}

async function defaultSend(ev) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SEND_TIMEOUT_MS);
  try {
    const res = await fetch(`${config.bffBaseUrl}${BFF_EVENT_PATH}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-webhook-secret': config.bffWebhookSecret,
        'x-event-id': String(ev._id),
        'x-event-attempt': String(ev.attempts),
      },
      body: JSON.stringify({ event: ev.event, restaurantId: ev.restaurantId, orderId: ev.orderId }),
      signal: ctrl.signal,
    });
    return { ok: res.ok, status: res.status };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? 'timeout' : e.message };
  } finally {
    clearTimeout(timer);
  }
}

let flushing = false;

/**
 * Vaqti kelgan hodisalarni yuboradi. Bir vaqtda bitta chaqiruv (ichki qulf);
 * bir nechta server nusxasi bo'lsa — `lockedUntil` ijarasi bilan bo'linadi.
 * @param {{limit?:number, now?:number, send?:Function}} [o] — now/send faqat testlar uchun
 */
export async function flushBffEvents({ limit = 25, now, send = defaultSend } = {}) {
  if (!isBffEventsEnabled() || flushing) return { sent: 0, retried: 0, failed: 0 };
  flushing = true;
  const out = { sent: 0, retried: 0, failed: 0 };
  try {
    for (let i = 0; i < limit; i++) {
      const at = now ?? Date.now();
      const ev = await BffEvent.findOneAndUpdate(
        { doneAt: null, nextAttemptAt: { $lte: new Date(at) }, lockedUntil: { $lt: new Date(at) } },
        { $set: { lockedUntil: new Date(at + LEASE_MS) }, $inc: { attempts: 1 } },
        { sort: { nextAttemptAt: 1 }, new: true },
      );
      if (!ev) break;

      const r = await send(ev);
      if (r.ok) {
        await BffEvent.updateOne({ _id: ev._id }, { doneAt: new Date(at), lastError: '', lockedUntil: new Date(0) });
        out.sent++;
      } else {
        const why = r.error || `HTTP ${r.status}`;
        if (ev.attempts >= MAX_ATTEMPTS) {
          await BffEvent.updateOne({ _id: ev._id }, { doneAt: new Date(at), failed: true, lastError: why, lockedUntil: new Date(0) });
          console.error(`[bffEvents] hodisa yuborilmadi (${ev.attempts} urinish): ${ev.event} ${ev.orderId} — ${why}`);
          out.failed++;
        } else {
          const wait = BACKOFF_MS[Math.min(ev.attempts - 1, BACKOFF_MS.length - 1)];
          await BffEvent.updateOne({ _id: ev._id }, { nextAttemptAt: new Date(at + wait), lastError: why, lockedUntil: new Date(0) });
          out.retried++;
        }
      }
    }
  } finally {
    flushing = false;
  }
  return out;
}

/** Ishchi: har 3 soniyada navbatni tekshiradi (index.js). */
export function startBffEventWorker() {
  if (!isBffEventsEnabled()) return null;
  const t = setInterval(() => { flushBffEvents().catch((e) => console.error('[bffEvents]', e.message)); }, 3_000);
  t.unref?.();
  console.log(`✓ BFF hodisalari: ${config.bffBaseUrl}${BFF_EVENT_PATH}`);
  return t;
}
