import { asyncHandler } from '../middleware/error.js';
import { config } from '../config/index.js';
import { Dish } from '../models/Dish.js';
import { Restaurant } from '../models/Restaurant.js';

// HTML maxsus belgilarини xavfsiz qilish (XSS oldini olish)
function esc(s = '') {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Cloudinary rasmни OG uchun optimallash (1200x630 — Telegram/ijtimoiy tarmoq standarti)
function ogImage(url) {
  if (!url) return '';
  if (url.includes('/upload/')) {
    return url.replace('/upload/', '/upload/f_auto,q_auto,w_1200,h_630,c_fill/');
  }
  return url;
}

export const shareController = {
  // GET /d/:id  — taomни chiroyli ulashish sahifasi (Open Graph karta)
  // Telegram/WhatsApp shu sahifани o'qib rasm+nom preview yasaydi,
  // foydalanuvchи bosса Mini App'даgi o'sha taomга o'tadi.
  dishPage: asyncHandler(async (req, res) => {
    const dish = await Dish.findById(req.params.id).lean().catch(() => null);

    // Mini App deep-link (taomга olib boradi)
    const miniAppLink = `https://t.me/${config.botUsername}/${config.webappName}?startapp=dish_${req.params.id}`;

    // Taom topilmasa — to'g'ridan Mini App'ga yo'naltiramiz
    if (!dish) {
      return res.redirect(302, miniAppLink);
    }

    // Restoran nomи (ixtiyoriy)
    const restaurant = await Restaurant.findById(dish.restaurantId).select('name').lean().catch(() => null);

    const title = esc(dish.name || 'LokmaGo taomi');
    const priceText = dish.price ? `${dish.price.toLocaleString('ru-RU')} so'm` : '';
    const parts = [priceText, restaurant?.name && `${restaurant.name}da`, dish.description].filter(Boolean);
    const description = esc(parts.join(' · ').slice(0, 200));
    const image = ogImage(dish.imageUrl || (dish.images && dish.images[0]) || '');

    // OG teglari bilan HTML. Telegram bot havolани ochганда shu teglarni o'qiydi.
    const html = `<!DOCTYPE html>
<html lang="uz">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} — LokmaGo</title>
<meta property="og:type" content="website">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${description}">
${image ? `<meta property="og:image" content="${esc(image)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">` : ''}
<meta property="og:url" content="${esc(miniAppLink)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${title}">
<meta name="twitter:description" content="${description}">
${image ? `<meta name="twitter:image" content="${esc(image)}">` : ''}
<style>
  body { margin:0; font-family:-apple-system,Segoe UI,Roboto,sans-serif; background:#0E0E10; color:#F2F1EE;
         display:flex; align-items:center; justify-content:center; min-height:100vh; padding:24px; }
  .card { max-width:420px; width:100%; background:#1A1A1E; border:1px solid #2A2A30; border-radius:20px; overflow:hidden; text-align:center; }
  .card img { width:100%; height:230px; object-fit:cover; display:block; }
  .card__body { padding:22px; }
  .card__name { font-size:22px; font-weight:700; margin:0 0 6px; }
  .card__price { color:#EF9F27; font-size:18px; font-weight:700; margin-bottom:10px; }
  .card__desc { color:#9A9A96; font-size:14px; line-height:1.5; margin-bottom:22px; }
  .card__btn { display:block; background:#EF9F27; color:#2C1400; text-decoration:none; font-weight:700;
               padding:15px; border-radius:14px; font-size:16px; }
</style>
<script>
  // Foydalanuvchи (bot emas) ochса — darhol Mini App'ga o'tkazamiz
  setTimeout(function(){ window.location.href = ${JSON.stringify(miniAppLink)}; }, 1200);
</script>
</head>
<body>
  <div class="card">
    ${image ? `<img src="${esc(image)}" alt="${title}">` : ''}
    <div class="card__body">
      <h1 class="card__name">${title}</h1>
      ${priceText ? `<div class="card__price">${esc(priceText)}</div>` : ''}
      ${dish.description ? `<p class="card__desc">${esc(dish.description)}</p>` : ''}
      <a class="card__btn" href="${esc(miniAppLink)}">🍽 Buyurtma berish</a>
    </div>
  </div>
</body>
</html>`;

    res.set('Content-Type', 'text/html; charset=utf-8');
    // Telegram cache uchun qisqa muddat
    res.set('Cache-Control', 'public, max-age=300');
    res.send(html);
  }),
};
