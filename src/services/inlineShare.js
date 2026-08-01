import { config } from '../config/index.js';
import { Dish } from '../models/Dish.js';
import { Restaurant } from '../models/Restaurant.js';

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

// Bot username Telegram'dan bir marta olinadi va keshlanadi.
// .env dagi qiymat noto'g'ri bo'lsa ham havola to'g'ri bo'ladi.
let cachedUsername = null;

async function getBotUsername() {
  if (cachedUsername) return cachedUsername;
  try {
    const r = await fetch(`${TG_API}/getMe`);
    const d = await r.json();
    if (d.ok && d.result?.username) {
      cachedUsername = d.result.username;
      return cachedUsername;
    }
  } catch { /* pastdagi zaxiraga o'tamiz */ }
  return config.botUsername;
}

async function miniAppLink(dishId) {
  const username = await getBotUsername();
  const base = config.webappName
    ? `https://t.me/${username}/${config.webappName}`
    : `https://t.me/${username}`;
  return `${base}?startapp=food_${dishId}`;
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
        .select('name').lean().catch(() => null);
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
      .select('name').lean().catch(() => []);
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

/** Bitta taom uchun inline natija. */
async function buildResult(dish, restaurant) {
  const link = await miniAppLink(dish._id);
  const price = dish.price
    ? `${dish.price.toLocaleString('ru-RU')} so'm`
    : '';
  const photo = photoUrl(dish.imageUrl || dish.images?.[0] || '');

  // Xabar matni — HTML formatida
  const lines = [
    `🍽 <b>${esc(dish.name)}</b>`,
    price && `💰 <b>${esc(price)}</b>`,
    restaurant?.name && `📍 ${esc(restaurant.name)}`,
    dish.description && `\n${esc(dish.description)}`,
    `\n👉 <a href="${link}">Buyurtma berish</a>`,
  ].filter(Boolean);

  const caption = lines.join('\n');

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
      disable_web_page_preview: false,
    },
  };
}
