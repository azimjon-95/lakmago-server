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

function miniAppLink(dishId) {
  const base = config.webappName
    ? `https://t.me/${config.botUsername}/${config.webappName}`
    : `https://t.me/${config.botUsername}`;
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
      results.push(buildResult(dish, rest));
    }
  } else if (q.length >= 2) {
    // Nom bo'yicha qidirish
    const dishes = await Dish.find({
      name: { $regex: q, $options: 'i' },
      isAvailable: true,
    }).limit(10).lean().catch(() => []);

    const restIds = [...new Set(dishes.map((d) => String(d.restaurantId)))];
    const rests = await Restaurant.find({ _id: { $in: restIds } })
      .select('name').lean().catch(() => []);
    const restMap = new Map(rests.map((r) => [String(r._id), r]));

    for (const d of dishes) {
      results.push(buildResult(d, restMap.get(String(d.restaurantId))));
    }
  }

  await fetch(`${TG_API}/answerInlineQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      inline_query_id: inlineQuery.id,
      results,
      cache_time: 60,
      is_personal: false,
    }),
  }).catch((e) => console.error('[inline]', e.message));
}

/** Bitta taom uchun inline natija. */
function buildResult(dish, restaurant) {
  const link = miniAppLink(dish._id);
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

  // Tugma — bosilganda ilova ochiladi
  const markup = {
    inline_keyboard: [[
      { text: '🍽 Buyurtma berish', url: link },
    ]],
  };

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
      reply_markup: markup,
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
    reply_markup: markup,
  };
}
