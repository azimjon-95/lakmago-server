import { asyncHandler } from '../middleware/error.js';
import { config } from '../config/index.js';
import { Dish } from '../models/Dish.js';
import { Restaurant } from '../models/Restaurant.js';

// ============================================================
//  TAOM ULASHISH SAHIFASI (Open Graph)
// ------------------------------------------------------------
//  Do'st Telegram'да havolani ochганда:
//    1) Telegram og:* meta'ларni o'qiydi
//    2) Rasm (yuqorида) + nom + narx + tavsif (pastда) — chiroyли karta
//    3) Karta bosilса — webapp'даgi AYNАN o'sha taom ochiladi
//  Havola matn ичида "Buyurtma berish" so'zига yashиринган.
// ============================================================

function esc(s = '') {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Cloudinary rasmни Telegram karta o'lchamига (1200×630) optimallash.
function toOgImage(dish) {
  let image = dish.imageUrl || (Array.isArray(dish.images) && dish.images[0]) || '';
  if (!image || !image.startsWith('http')) return '';
  if (image.includes('/upload/')) {
    return image.replace('/upload/', '/upload/f_jpg,q_auto,w_1200,h_630,c_fill/');
  }
  return image;
}

// Webapp'даgi taomга olib boruvchi havola (Telegram Mini App deep-link)
function buildAppLink(dishId) {
  const botUsername = config.botUsername || 'LokmaGoBot';
  const webappName = process.env.WEBAPP_NAME || 'app';
  return `https://t.me/${botUsername}/${webappName}?startapp=dish_${dishId}`;
}

export const shareController = {
  // GET /share/dish/:id
  dishPage: asyncHandler(async (req, res) => {
    const dish = await Dish.findById(req.params.id).lean();
    if (!dish) return res.status(404).send(renderNotFound());

    const restaurant = await Restaurant.findById(dish.restaurantId)
      .select('name isBlocked isActive').lean();
    if (!restaurant || restaurant.isBlocked || !restaurant.isActive) {
      return res.status(404).send(renderNotFound());
    }

    const appLink = buildAppLink(dish._id);
    const ogImage = toOgImage(dish);
    const priceStr = dish.price ? `${dish.price.toLocaleString('ru-RU')} so'm` : '';
    const hasDiscount = dish.oldPrice && dish.oldPrice > dish.price;

    const ogTitle = `${dish.name}${priceStr ? ' — ' + priceStr : ''}`;
    const ogDesc = dish.description
      ? `${dish.description} · ${restaurant.name}`
      : `${restaurant.name} — LokmaGo'da buyurtma bering`;

    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=300');
    res.send(renderSharePage({ appLink, ogImage, ogTitle, ogDesc, dish, restaurant, priceStr, hasDiscount }));
  }),
};

function renderSharePage({ appLink, ogImage, ogTitle, ogDesc, dish, restaurant, priceStr, hasDiscount }) {
  const oldPriceStr = hasDiscount ? `${dish.oldPrice.toLocaleString('ru-RU')} so'm` : '';
  const discountPct = hasDiscount ? Math.round((1 - dish.price / dish.oldPrice) * 100) : 0;

  return `<!DOCTYPE html>
<html lang="uz">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(ogTitle)}</title>

<meta property="og:type" content="website">
<meta property="og:site_name" content="LokmaGo">
<meta property="og:title" content="${esc(ogTitle)}">
<meta property="og:description" content="${esc(ogDesc)}">
<meta property="og:url" content="${esc(appLink)}">
${ogImage ? `<meta property="og:image" content="${esc(ogImage)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">` : ''}

<meta name="twitter:card" content="${ogImage ? 'summary_large_image' : 'summary'}">
<meta name="twitter:title" content="${esc(ogTitle)}">
<meta name="twitter:description" content="${esc(ogDesc)}">
${ogImage ? `<meta name="twitter:image" content="${esc(ogImage)}">` : ''}

<meta http-equiv="refresh" content="0; url=${esc(appLink)}">
<script>location.replace(${JSON.stringify(appLink)});</script>

<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:-apple-system,Segoe UI,Roboto,sans-serif; background:#0E0E10; color:#F2F1EE;
         min-height:100vh; display:flex; align-items:center; justify-content:center; padding:20px; }
  .card { max-width:400px; width:100%; background:#1A1A1E; border:1px solid #2A2A30;
          border-radius:20px; overflow:hidden; }
  .card__img { width:100%; aspect-ratio:16/10; object-fit:cover; background:#2A2A30; display:block; }
  .card__body { padding:18px; }
  .card__name { font-size:20px; font-weight:700; margin-bottom:6px; }
  .card__rest { font-size:13px; color:#9A9A96; margin-bottom:14px; }
  .card__price-row { display:flex; align-items:baseline; gap:10px; margin-bottom:16px; flex-wrap:wrap; }
  .card__price { font-size:22px; font-weight:800; color:#EF9F27; }
  .card__old { font-size:15px; color:#9A9A96; text-decoration:line-through; }
  .card__badge { background:#E24B4A; color:#fff; font-size:12px; font-weight:700; padding:3px 9px; border-radius:20px; }
  .card__desc { font-size:14px; color:#C8C7C3; line-height:1.5; margin-bottom:18px; }
  .card__btn { display:block; text-align:center; background:#EF9F27; color:#2C1400;
               font-size:16px; font-weight:700; padding:14px; border-radius:14px; text-decoration:none; }
</style>
</head>
<body>
  <div class="card">
    ${ogImage ? `<img class="card__img" src="${esc(ogImage)}" alt="${esc(dish.name)}">` : ''}
    <div class="card__body">
      <div class="card__name">${esc(dish.name)}</div>
      <div class="card__rest">🏪 ${esc(restaurant.name)}</div>
      <div class="card__price-row">
        <span class="card__price">${esc(priceStr)}</span>
        ${hasDiscount ? `<span class="card__old">${esc(oldPriceStr)}</span><span class="card__badge">-${discountPct}%</span>` : ''}
      </div>
      ${dish.description ? `<p class="card__desc">${esc(dish.description)}</p>` : ''}
      <a class="card__btn" href="${esc(appLink)}">🍽 Buyurtma berish</a>
    </div>
  </div>
</body>
</html>`;
}

function renderNotFound() {
  return `<!DOCTYPE html><html lang="uz"><head><meta charset="utf-8">
<title>Topilmadi</title></head>
<body style="font-family:sans-serif;text-align:center;padding:60px;background:#0E0E10;color:#F2F1EE">
<h2>🍽 Taom topilmadi</h2>
<p style="color:#9A9A96">Bu taom mavjud emas yoki olib tashlangan.</p>
</body></html>`;
}
