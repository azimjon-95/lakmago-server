import bcrypt from 'bcryptjs';
import { Restaurant } from '../models/Restaurant.js';

/*
 * ═══════════════════════════════════════════════════════════
 * ANDROID GATEWAY AUTENTIFIKATSIYASI
 * ═══════════════════════════════════════════════════════════
 *
 * TZ: GET https://api.lokma.uz/app/{pincode}/{restaurantId}
 *
 * Kiosk (src/middleware/auth.js → kioskAuth) dan farqi: u yerda
 * PIN faqat BIR MARTA kiritiladi va JWT sessiyaga almashtiriladi.
 * Bu yerda TZ o'zi PIN'ni HAR SO'ROVDA URL'da talab qiladi —
 * shuning uchun sessiya emas, har chaqiriqda to'g'ridan-to'g'ri
 * tekshiruv. Brute-force himoyasi esa KIOSK BILAN AYNAN BIR XIL:
 * 3 xato → 30 soniya blok, bazada hisoblanadi (client hisobini
 * tozalab aylanib o'tib bo'lmaydi).
 *
 * Muvaffaqiyatli bo'lsa req.restaurantId to'ldiriladi — shundan
 * keyin restaurantPanelController dagi TAYYOR handlerlar
 * (`orders`, `orderDetail`, `updateOrderStatus`, `profile`)
 * ISHLATILADI, biznes logika bu yerda TAKRORLANMAYDI (TZ 5-band).
 */

export const isValidId = (id) => typeof id === 'string' && /^[a-f\d]{24}$/i.test(id);
const PIN_RE = /^\d{4,8}$/; // 4 xonali standart, kelajakda uzunroq PIN uchun ham ochiq

/*
 * Yagona tekshiruv funksiyasi — HTTP middleware (pastda) VA
 * Socket.IO'dagi `join:android:restaurant` (sockets/io.js) IKKALASI
 * ham shundan foydalanadi. Ikki joyda bir xil bcrypt/blok mantig'ini
 * alohida yozish xato ehtimolini oshiradi (biri tuzatilib, ikkinchisi
 * unutilib qolishi mumkin) — shuning uchun BITTA joy.
 *
 * @returns {Promise<
 *   | { ok: true, restaurant: { _id, name } }
 *   | { ok: false, status: number, body: object }
 * >}
 */
export async function verifyAndroidPin(restaurantId, pincode) {
  if (!isValidId(restaurantId)) {
    return { ok: false, status: 400, body: { error: 'Noto‘g‘ri restoran ID' } };
  }
  if (!PIN_RE.test(String(pincode || ''))) {
    return { ok: false, status: 401, body: { error: 'PIN noto‘g‘ri' } };
  }

  const restaurant = await Restaurant.findById(restaurantId)
    .select('name androidGateway').lean();

  // Restoran yo'q YOKI gateway sozlanmagan — bitta xabar bilan
  // javob beramiz, ikkisini ajratib ko'rsatmaymiz (qidiruv qulayligini
  // kamaytiradi: mavjud restoranni "hali sozlanmagan"dan ajratish
  // tashqi client uchun qiziqarli ma'lumot emas).
  const g = restaurant?.androidGateway;
  if (!restaurant || !g?.enabled || !g?.pinHash) {
    return { ok: false, status: 404, body: { error: 'Gateway topilmadi' } };
  }

  if (g.pinBlockedUntil && new Date(g.pinBlockedUntil).getTime() > Date.now()) {
    const sec = Math.ceil((new Date(g.pinBlockedUntil).getTime() - Date.now()) / 1000);
    return {
      ok: false,
      status: 429,
      body: {
        error: `Ko‘p marta xato. ${sec} soniyadan keyin urinib ko‘ring.`,
        code: 'PIN_BLOCKED',
        retryAfter: sec,
      },
    };
  }

  const match = await bcrypt.compare(String(pincode), g.pinHash);

  if (!match) {
    const fails = (g.pinFails || 0) + 1;
    const blocked = fails >= 3;
    await Restaurant.updateOne({ _id: restaurantId }, {
      'androidGateway.pinFails': blocked ? 0 : fails,
      'androidGateway.pinBlockedUntil': blocked ? new Date(Date.now() + 30_000) : null,
    });
    return {
      ok: false,
      status: 401,
      body: { error: 'PIN noto‘g‘ri', code: 'PIN_WRONG', ...(blocked && { retryAfter: 30 }) },
    };
  }

  // Muvaffaqiyatli — hisoblagich tozalanadi. Javobni kutmaymiz:
  // so'rov tezligiga ta'sir qilmasin, xato bo'lsa ham keyingi
  // so'rovlarga to'sqinlik qilmaydi (faqat "oxirgi kirish" statistikasi).
  Restaurant.updateOne({ _id: restaurantId }, {
    'androidGateway.pinFails': 0,
    'androidGateway.pinBlockedUntil': null,
    'androidGateway.lastAccessAt': new Date(),
  }).catch(() => {});

  return { ok: true, restaurant: { _id: String(restaurant._id), name: restaurant.name } };
}

/** Express middleware — GET/PATCH /app/:pincode/:restaurantId/... */
export async function androidGatewayAuth(req, res, next) {
  const { pincode, restaurantId } = req.params;
  const result = await verifyAndroidPin(restaurantId, pincode);

  if (!result.ok) return res.status(result.status).json(result.body);

  req.restaurantId = result.restaurant._id;
  req.restaurantName = result.restaurant.name;
  next();
}
