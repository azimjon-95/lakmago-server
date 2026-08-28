import crypto from 'node:crypto';
import { config } from '../config/index.js';

/**
 * CLICK MERCHANT API — karta tokenlari.
 * Hujjat: docs.click.uz/merchant-api/requests
 *
 * SHOP API'dan (click.js) farqi:
 *   SHOP API   — Click BIZGA murojaat qiladi (Prepare/Complete
 *                webhooklari). Mijoz Click sahifasida to'laydi.
 *   MERCHANT API — BIZ Click'ka murojaat qilamiz. Mijoz ilovadan
 *                chiqmaydi: karta raqamini kiritadi, SMS kodni
 *                tasdiqlaydi, keyingi to'lovlar bir tegishda.
 *
 * Ikkalasi PARALLEL ishlaydi va bir-birini almashtirmaydi:
 * Click ilovasi bor mijoz havola orqali, karta saqlagan mijoz
 * esa token orqali to'laydi.
 */

const BASE = 'https://api.click.uz/v2/merchant';

/**
 * Auth sarlavhasi: merchant_user_id:sha1(timestamp+secret):timestamp
 *
 * Timestamp SONIYADA (10 xonali). Millisekund berilsa Click
 * imzoni rad etadi — bu eng ko'p uchraydigan xato.
 */
function authHeader() {
  const ts = Math.floor(Date.now() / 1000);
  const digest = crypto
    .createHash('sha1')
    .update(ts + config.click.secretKey)
    .digest('hex');
  return `${config.click.merchantUserId}:${digest}:${ts}`;
}

/** Click xatosi — kodini saqlaydi, chunki ba'zilariga alohida munosabat kerak. */
export class ClickApiError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
    this.name = 'ClickApiError';
  }
}

/*
 * Click xato kodlari -> mijozga ko'rinadigan matn.
 *
 * Click matnlari ruscha va texnik ("Ошибка в запросе"), mijoz
 * ularni tushunmaydi. Tarjima qilinmaganlari uchun umumiy
 * xabar beriladi, lekin kod logda qoladi.
 */
const MESSAGES = {
  '-1': 'So‘rovda xatolik',
  '-2': 'Noto‘g‘ri summa',
  '-3': 'Bunday amal yo‘q',
  '-4': 'Bu to‘lov allaqachon amalga oshirilgan',
  '-5': 'Karta topilmadi',
  '-6': 'Tranzaksiya topilmadi',
  '-7': 'Ma‘lumotni yangilab bo‘lmadi',
  '-8': 'So‘rovda xatolik',
  '-9': 'Tranzaksiya bekor qilingan',
  '-16': 'Kartada mablag‘ yetarli emas',
  '-31': 'SMS kod noto‘g‘ri yoki muddati tugagan',
  '-32': 'Karta bloklangan yoki muddati o‘tgan',
};

async function call(path, { method = 'POST', body, auth = true } = {}) {
  if (!config.click.serviceId || !config.click.secretKey) {
    throw new ClickApiError('Click sozlanmagan', 'NOT_CONFIGURED');
  }

  // Tarmoq osilib qolmasin — mijoz cheksiz kutmasligi kerak
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);

  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(auth ? { Auth: authHeader() } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: ctrl.signal,
    });
  } catch (e) {
    throw new ClickApiError(
      e.name === 'AbortError'
        ? 'Click javob bermadi, qayta urinib ko‘ring'
        : 'Click bilan aloqa yo‘q',
      'NETWORK',
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ClickApiError('Click javobi tushunarsiz', 'BAD_RESPONSE');
  }

  /*
   * Click HTTP 200 bilan ham xato qaytaradi — holat kodiga
   * emas, error_code maydoniga qarash SHART.
   */
  const code = Number(data.error_code ?? 0);
  if (code !== 0) {
    const msg = MESSAGES[String(code)] || data.error_note || 'To‘lov amalga oshmadi';
    console.error('[click:api]', path, code, data.error_note);
    throw new ClickApiError(msg, code);
  }

  return data;
}

/**
 * 1-QADAM: karta tokenini so'rash.
 *
 * Click kartaga bog'langan telefonga SMS yuboradi.
 * Token hali TASDIQLANMAGAN — u bilan pul yechib bo'lmaydi.
 *
 * @param {string} cardNumber - faqat raqamlar
 * @param {string} expireDate - MMYY
 * @param {boolean} save - true bo'lsa doimiy token (temporary=0)
 */
export async function requestCardToken(cardNumber, expireDate, save = true) {
  const data = await call('/card_token/request', {
    // Bu chaqiruvda Auth sarlavhasi TALAB QILINMAYDI —
    // hujjatda ham u ko'rsatilmagan
    auth: false,
    body: {
      service_id: Number(config.click.serviceId),
      card_number: String(cardNumber).replace(/\D/g, ''),
      expire_date: String(expireDate).replace(/\D/g, ''),
      temporary: save ? 0 : 1,
    },
  });

  return {
    cardToken: data.card_token,
    // Click niqoblab qaytaradi: 99890***1234
    phoneNumber: data.phone_number || '',
    temporary: Number(data.temporary) === 1,
  };
}

/**
 * 2-QADAM: SMS kod bilan tasdiqlash.
 * Shundan keyingina token bilan to'lov qilish mumkin.
 */
export async function verifyCardToken(cardToken, smsCode) {
  const data = await call('/card_token/verify', {
    body: {
      service_id: Number(config.click.serviceId),
      card_token: cardToken,
      sms_code: String(smsCode),
    },
  });

  return {
    // Click ba'zan niqoblangan raqamni shu yerda qaytaradi
    cardNumber: data.card_number || '',
  };
}

/**
 * 3-QADAM: token bilan pul yechish.
 *
 * @param {string} cardToken
 * @param {number} amountSom - SO'MDA (tiyinda emas)
 * @param {string} merchantTransId - bizning buyurtma ID
 */
export async function payWithCardToken(cardToken, amountSom, merchantTransId) {
  const data = await call('/card_token/payment', {
    body: {
      service_id: Number(config.click.serviceId),
      card_token: cardToken,
      amount: Number(amountSom),
      transaction_parameter: String(merchantTransId),
    },
  });

  return {
    paymentId: String(data.payment_id),
    paymentStatus: Number(data.payment_status ?? 0),
  };
}

/** Tokenni o'chirish — mijoz kartani ro'yxatdan olib tashlaganda. */
export async function deleteCardToken(cardToken) {
  await call(`/card_token/${config.click.serviceId}/${cardToken}`, {
    method: 'DELETE',
  });
}

/**
 * To'lov holatini tekshirish.
 *
 * Kerak bo'ladi: pul yechish so'rovi tarmoqda uzilib qolsa,
 * pul yechilgan-yechilmagani noma'lum qoladi. Bunda buyurtmani
 * ikki marta to'latmaslik uchun holat so'raladi.
 */
export async function getPaymentStatus(paymentId) {
  const data = await call(
    `/payment/status/${config.click.serviceId}/${paymentId}`,
    { method: 'GET' },
  );
  return Number(data.payment_status ?? 0);
}
