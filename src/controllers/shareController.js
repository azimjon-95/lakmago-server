import { asyncHandler } from '../middleware/error.js';
import { config } from '../config/index.js';
import { Dish } from '../models/Dish.js';
import { Restaurant } from '../models/Restaurant.js';

// Taom ulashish sahifаси — Open Graph meta bilan.
// Telegram/ijtimoiy tarmoq havolани ko'rганда chiroyли karta (rasm+nom+narx) ko'rsatади.
// Foydalanuvchи bosса — webapp'даgi o'sha taomга yo'naltiriladi.

function esc(s = '') {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export const shareController = {
  // GET /share/dish/:id
  dishPage: asyncHandler(async (req, res) => {
    const dish = await Dish.findById(req.params.id).lean();
    if (!dish) return res.status(404).send('Taom topilmadi');

    const restaurant = await Restaurant.findById(dish.restaurantId).select('name isBlocked isActive').lean();
    if (!restaurant || restaurant.isBlocked || !restaurant.isActive) {
      return res.status(404).send('Taom mavjud emas');
    }

    // Webapp'ga o'tuvchi havola (Telegram Mini App)
    const botUsername = config.botUsername || 'LokmaGoBot';
    const webappName = process.env.WEBAPP_NAME || 'app';
    const appLink = `https://t.me/${botUsername}/${webappName}?startapp=dish_${dish._id}`;

    const price = dish.price ? `${dish.price.toLocaleString('ru-RU')} so'm` : '';
    const title = `${dish.name}${price ? ' — ' + price : ''}`;
    const desc = dish.description || `${restaurant.name} — LokmaGo'da buyurtma bering`;
    let image = dish.imageUrl || (dish.images && dish.images[0]) || '';
    // Faqat to'liq HTTPS URL rasmни ishlatamiz (Telegram nisbiy yo'lni ololmaydi)
    if (image && !image.startsWith('http')) image = '';
    // Cloudinary rasmни Telegram karta o'lchamига optimallash (1200×630)
    const ogImage = image && image.includes('/upload/')
      ? image.replace('/upload/', '/upload/f_jpg,q_auto,w_1200,h_630,c_fill/')
      : image;

    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!DOCTYPE html>
<html lang="uz">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
${ogImage ? `<meta property="og:image" content="${esc(ogImage)}">` : ''}
<meta property="og:url" content="${esc(appLink)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(desc)}">
${ogImage ? `<meta name="twitter:image" content="${esc(ogImage)}">` : ''}
<meta http-equiv="refresh" content="0; url=${esc(appLink)}">
<script>window.location.href=${JSON.stringify(appLink)};</script>
</head>
<body style="font-family:sans-serif;text-align:center;padding:40px;background:#0E0E10;color:#F2F1EE">
<p>🍽 ${esc(dish.name)}</p>
<p>Ochilmoqda... <a href="${esc(appLink)}" style="color:#EF9F27">Ochish</a></p>
</body>
</html>`);
  }),
};
