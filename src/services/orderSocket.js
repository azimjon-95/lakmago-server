import { User } from '../models/User.js';
import { toPanelOrder } from './panelOrderView.js';

/*
 * ═══════════════════════════════════════════════════════════
 * REAL-TIME: BUYURTMA RESTORAN XONASIGA — FAQAT XAVFSIZ KO'RINISHDA
 * ═══════════════════════════════════════════════════════════
 * Avval `order:new` / `order:update` restoran xonasiga XOM buyurtma hujjatini yuborardi:
 *   • finance — LokmaGo netto daromadi (lokmaNetCommission), Click haqi, shlyuz residuali;
 *   • populate qilingan bo'lsa — butun User hujjati (manzillar, kartalar, bonus balansi).
 * HTTP yo'li (`/api/panel/orders`) buni toPanelOrder bilan yashirardi, socket esa chetlab
 * o'tardi. Endi ikkalasi BIR XIL funksiyadan o'tadi — restoran paneli socket orqali ham,
 * ro'yxat orqali ham AYNAN bir xil shakldagi buyurtmani oladi (finance so'mda, customer obyekti).
 *
 * Admin xonasi (`admin`) xom ko'rinishni olaveradi — admin moliyani ko'rishi kerak.
 */

// Panel ro'yxati (restaurantPanel.js) mijozni aynan shu maydonlar bilan populate qiladi
const PANEL_USER = 'firstName lastName username telegramId phone photoUrl';

const isBareId = (u) => u && (u._bsontype === 'ObjectId' || typeof u === 'string');

/** Buyurtmaning restoran ko'radigan to'liq, xavfsiz ko'rinishi (mijoz ma'lumoti bilan). */
export async function restaurantOrderView(order) {
  const o = typeof order?.toObject === 'function' ? order.toObject() : { ...order };
  // userId populate qilinmagan bo'lsa — mijoz nomi/telefoni yo'qolmasligi uchun o'qiymiz
  if (isBareId(o.userId)) {
    try {
      const u = await User.findById(o.userId).select(PANEL_USER).lean();
      if (u) o.userId = u;
    } catch (e) {
      console.error('[orderSocket] mijozni o‘qib bo‘lmadi:', e.message);   // ko'rinishsiz davom etamiz — xabar baribir ketadi
    }
  }
  return toPanelOrder(o);
}

/**
 * Restoran xonasiga yuboradi. Xato bo'lsa XOM buyurtma YUBORILMAYDI — o'rniga minimal
 * { _id, status } (panel uni mavjud kartaga birlashtiradi, ro'yxat keyingi yangilanishda to'ladi).
 */
export async function emitOrderToRestaurant(io, event, order) {
  if (!io || !order) return;
  const room = `restaurant:${order.restaurantId}`;
  try {
    io.to(room).emit(event, await restaurantOrderView(order));
  } catch (e) {
    console.error('[orderSocket]', e.message);
    io.to(room).emit(event, { _id: String(order._id), status: order.status });
  }
}
