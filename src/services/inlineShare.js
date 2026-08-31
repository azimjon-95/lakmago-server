import { config } from '../config/index.js';
import { Dish } from '../models/Dish.js';
import { Restaurant } from '../models/Restaurant.js';
import { buildMiniAppLink } from './telegram.js';

/**
 * Inline rejim — taomni rasm va formatlangan matn bilan ulashish.
 *
 * Foydalanuvchi ilovada "Ulashish" bosadi → Telegram do'stlar
 * ro'yxatini ochadi → tanlangan chatga bot rasm + matn + tugma
 * yuboradi.
 *
 * Bu yagona yo'l: t.me/share/url orqali rasm yuborib bo'lmaydi
 * va HTML formatlash ishlamaydi.
 */

const TG_API = `https://api.telegram.org/bot${config.telegramBotToken}`;

// HTML uchun xavfsiz matn
function esc(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Cloudinary rasmini Telegram uchun moslashtiramiz
function photoUrl(url) {
  if (!url) return '';
  if (url.includes('/upload/')) {
    return url.replace('/upload/', '/upload/f_auto,q_auto,w_1000/');
  }
  return url;
}

// Bot username olish va deep link yasash endi markazda:
// services/telegram.js -> buildMiniAppLink(). Shu yerda takrorlanmaydi.
async function miniAppLink(dishId) {
  return buildMiniAppLink(`food_${dishId}`);
}

/**
 * Inline so'rovga javob beramiz.
 * So'rov formati: "food_<id>" yoki bo'sh (mashhur taomlar).
 */
export async function handleInlineQuery(inlineQuery) {
  if (!config.telegramBotToken) return;

  const q = String(inlineQuery.query || '').trim();
  const results = [];

  // food_<id> — aniq taom
  const m = q.match(/^food_([a-f\d]{24})$/i);

  if (m) {
    const dish = await Dish.findById(m[1]).lean().catch(() => null);
    if (dish) {
      const rest = await Restaurant.findById(dish.restaurantId)
        .select('name address').lean().catch(() => null);
      results.push(await buildResult(dish, rest));
    }
  } else {
    // Nom bo'yicha qidirish. So'rov bo'sh bo'lsa — mashhur taomlar
    // (foydalanuvchi hech nima yozmasa ham ro'yxat ko'rinadi).
    const filter = { isAvailable: true };
    if (q.length >= 2) filter.name = { $regex: q, $options: 'i' };

    const dishes = await Dish.find(filter)
      .sort(q.length >= 2 ? { createdAt: -1 } : { isHit: -1, createdAt: -1 })
      .limit(12)
      .lean()
      .catch(() => []);

    const restIds = [...new Set(dishes.map((d) => String(d.restaurantId)))];
    const rests = await Restaurant.find({ _id: { $in: restIds } })
      .select('name address').lean().catch(() => []);
    const restMap = new Map(rests.map((r) => [String(r._id), r]));

    for (const d of dishes) {
      results.push(await buildResult(d, restMap.get(String(d.restaurantId))));
    }
  }

  try {
    const res = await fetch(`${TG_API}/answerInlineQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        inline_query_id: inlineQuery.id,
        results,
        // Kesh 0 — taom narxi o'zgarsa darhol yangilanadi
        cache_time: 0,
        is_personal: false,
      }),
    });
    const data = await res.json();

    if (!data.ok) {
      console.error(`[inline] Telegram rad etdi: ${data.description}`);
    } else {
      console.log(`[inline] "${q}" → ${results.length} ta natija`);
    }
  } catch (e) {
    console.error('[inline] xato:', e.message);
  }
}

/*
 * Ichimlikmi — taom emasmi.
 *
 * Ichimlikda 'volume' ("0.5 l") bo'ladi, taomda 'weight'
 * ("150 г"). Ular BIR-BIRINI ALMASHTIRMAYDI: ichimlikda
 * kaloriya/oqsil odatda kiritilmaydi (admin panelda ham shu
 * qoidaga ko'ra forma o'zgaradi — src/lib/dishMeta.js,
 * lakmago-admin), shuning uchun bu yerda ham ular faqat
 * mos kelgan holatda ko'rsatiladi.
 */
function isDrink(dish) {
  return Boolean(dish.volume) && !dish.weight;
}

/** Bitta taom uchun inline natija. */
async function buildResult(dish, restaurant) {
  const link = await miniAppLink(dish._id);
  const price = dish.price
    ? `${dish.price.toLocaleString('ru-RU')} so'm`
    : '';
  const photo = photoUrl(dish.imageUrl || dish.images?.[0] || '');

  /*
   * "Buyurtma berish" MATN ICHIDA emas, TUGMA sifatida.
   *
   * XATO EDI: link `<a href="...">Buyurtma berish</a>` bo'lib
   * matnning o'zi ichida yozilgan edi. Telegram matn ichidagi
   * havolani bosishda — hatto u to'g'ri t.me/.../?startapp
   * bo'lsa ham — avval oraliq PREVIEW KARTASINI ko'rsatadi
   * ("Веб-приложение LokmaGO... ЗАПУСТИТЬ") va foydalanuvchi
   * Mini App'ni ochish uchun YANA bir marta bosishi kerak
   * bo'lardi — skrinshotdagi holat aynan shu edi.
   *
   * INLINE TUGMA (reply_markup) esa boshqacha ishlaydi:
   * Telegram uni maxsus tan oladi va bosilganda HECH QANDAY
   * oraliq karta ko'rsatmasdan, DARHOL Mini App'ni taom bilan
   * ochadi. Shuning uchun link endi matndan olib tashlanadi va
   * reply_markup orqali tugma sifatida qo'shiladi.
   */
  const button = {
    inline_keyboard: [[{ text: '🍽 Buyurtma berish', url: link }]],
  };

  /*
   * ═══ CAPTION — TARTIB BILAN ═══
   *
   * 1. Sarlavha (taom nomi)
   * 2. Tavsif — bo'lsa
   * 3. Narx — chegirma bo'lsa eski narx bilan chizib qo'yiladi
   * 4. Restoran — nomi VA manzili (ilgari faqat nomi bor edi)
   * 5. Miqdor/kaloriya/vaqt — BITTA QATORDA, faqat mavjudlari.
   *    Oqsil/yog'/uglevod ATAYLAB kiritilmadi: bu inline karta
   *    "reklama" vazifasini bajaradi, batafsil ozuqa jadvali
   *    "Buyurtma berish" bosilgach ilovaning o'zida to'liq
   *    ko'rinadi (screenshot 2) — bu yerda takrorlash caption'ni
   *    cho'zib, o'qishni qiyinlashtirardi.
   */
  const priceLine = price
    ? (dish.oldPrice > dish.price
      ? `💰 <b>${esc(price)}</b> <s>${esc(dish.oldPrice.toLocaleString('ru-RU'))} so'm</s>`
      : `💰 <b>${esc(price)}</b>`)
    : '';

  const restLine = restaurant?.name
    ? `📍 <b>${esc(restaurant.name)}</b>${restaurant.address ? ` — ${esc(restaurant.address)}` : ''}`
    : '';

  const factsParts = [];
  const amount = isDrink(dish) ? dish.volume : dish.weight;
  if (amount) factsParts.push(`⚖️ ${esc(amount)}`);
  if (!isDrink(dish) && dish.calories) factsParts.push(`🔥 ${dish.calories} kkal`);
  if (dish.prepMinutes) factsParts.push(`⏱ ${dish.prepMinutes} daq`);
  const factsLine = factsParts.join('   ');

  /*
   * Ikki blok: "asosiy matn" (nom + tavsif) va "faktlar"
   * (narx, restoran, o'lcham/kaloriya/vaqt). Ular orasida
   * BITTA bo'sh qator — o'qishga qulay, lekin ortiqcha
   * bo'shliq yig'ilib qolmaydi (murakkab filtr shart emas).
   */
  /*
   * Tavsif uzun bo'lsa qisqartiriladi — Telegram rasm captioni
   * uchun 1024 belgi chegarasi bor, undan oshsa Telegram
   * butun xabarni RAD ETADI (taom umuman ulashilmay qoladi).
   * Nom, narx, restoran va faktlar ustuvor — ular hech qachon
   * kesilmaydi, faqat tavsif joy bo'shatib beradi.
   */
  const desc = dish.description
    ? esc(dish.description.length > 220
      ? `${dish.description.slice(0, 220).trim()}…`
      : dish.description)
    : '';

  const header = [
    `🍽 <b>${esc(dish.name)}</b>`,
    desc,
  ].filter(Boolean).join('\n');

  const facts = [priceLine, restLine, factsLine].filter(Boolean).join('\n');

  const caption = [header, facts].filter(Boolean).join('\n\n');

  // Rasm bo'lsa — photo turi (rasm tepada chiqadi)
  if (photo) {
    return {
      type: 'photo',
      id: String(dish._id),
      photo_url: photo,
      thumbnail_url: photo,
      title: dish.name,
      description: [price, restaurant?.name].filter(Boolean).join(' · '),
      caption,
      parse_mode: 'HTML',
      reply_markup: button,
    };
  }

  // Rasmsiz — oddiy matn
  return {
    type: 'article',
    id: String(dish._id),
    title: dish.name,
    description: [price, restaurant?.name].filter(Boolean).join(' · '),
    input_message_content: {
      message_text: caption,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    },
    reply_markup: button,
  };
}
