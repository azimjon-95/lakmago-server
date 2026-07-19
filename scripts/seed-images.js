/**
 * TAOM RASMLARINI CLOUDINARY'GA YUKLASH VA BAZAGA BIRIKTIRISH.
 *
 * ISHLATISH:
 *   1. Taom fotolarini papkaga soling. Fayl nomi taom nomiga yaqin bo'lsin:
 *        osh.jpg, lavash.jpg, burger.jpg, pitsa.jpg, sushi.jpg,
 *        shashlik.jpg, somsa.jpg, manti.jpg, tort.jpg, qahva.jpg ...
 *
 *   2. node scripts/seed-images.js ./rasmlar
 *
 * Skript har rasmni Cloudinary'ga yuklaydi va nomi mos keladigan
 * BARCHA taomlarga biriktiradi (bir rasm — ko'p taom, tejamli).
 *
 * .env da CLOUDINARY_* sozlangan bo'lishi shart.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import mongoose from 'mongoose';
import { config } from '../src/config/index.js';
import { Dish } from '../src/models/Dish.js';
import { Restaurant } from '../src/models/Restaurant.js';

const FOLDER = 'lokmago/dishes';

function sign(params, secret) {
  const toSign = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('&');
  return crypto.createHash('sha1').update(toSign + secret).digest('hex');
}

async function upload(filePath, publicId) {
  const { cloudName, apiKey, apiSecret } = config.cloudinary;
  const timestamp = Math.round(Date.now() / 1000);
  const params = { folder: FOLDER, public_id: publicId, overwrite: 'true', timestamp };
  const signature = sign(params, apiSecret);

  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(filePath)]), path.basename(filePath));
  form.append('api_key', apiKey);
  form.append('timestamp', String(timestamp));
  form.append('signature', signature);
  form.append('folder', FOLDER);
  form.append('public_id', publicId);
  form.append('overwrite', 'true');

  const res = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/image/upload`, {
    method: 'POST', body: form,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `HTTP ${res.status}`);
  return data.secure_url;
}

// Fayl nomini taom nomiga moslash uchun kalit so'zlar
function keywordsOf(fileName) {
  return path.basename(fileName, path.extname(fileName))
    .toLowerCase().split(/[-_\s]+/).filter((w) => w.length >= 3);
}

async function main() {
  const dir = process.argv[2];
  if (!dir) {
    console.error('Foydalanish: node scripts/seed-images.js ./rasmlar-papkasi');
    process.exit(1);
  }
  const { cloudName, apiKey, apiSecret } = config.cloudinary;
  if (!cloudName || !apiKey || !apiSecret) {
    console.error('Xato: .env da CLOUDINARY_CLOUD_NAME / API_KEY / API_SECRET sozlanmagan');
    process.exit(1);
  }

  const files = fs.readdirSync(dir).filter((f) => /\.(png|jpe?g|webp)$/i.test(f));
  if (!files.length) {
    console.error(`Xato: ${dir} papkasida rasm topilmadi`);
    process.exit(1);
  }

  await mongoose.connect(config.mongoUri);
  console.log(`✓ MongoDB ulandi\n${files.length} ta rasm yuklanmoqda...\n`);

  let uploaded = 0;
  let linked = 0;

  for (const file of files) {
    const id = path.basename(file, path.extname(file));
    try {
      const url = await upload(path.join(dir, file), id);
      uploaded++;

      // Nomi mos keladigan taomlarni topamiz
      const words = keywordsOf(file);
      const regex = new RegExp(words.join('|'), 'i');
      const result = await Dish.updateMany(
        { name: regex, $or: [{ imageUrl: '' }, { imageUrl: { $exists: false } }] },
        { $set: { imageUrl: url, images: [url] } },
      );
      linked += result.modifiedCount;
      console.log(`  ✓ ${id}  →  ${result.modifiedCount} ta taomga biriktirildi`);
    } catch (e) {
      console.error(`  ✗ ${id}: ${e.message}`);
    }
  }

  // Restoran bannerlari — birinchi taom rasmidan olinadi
  const restaurants = await Restaurant.find({ $or: [{ imageUrl: '' }, { imageUrl: { $exists: false } }] });
  let banners = 0;
  for (const r of restaurants) {
    const dish = await Dish.findOne({ restaurantId: r._id, imageUrl: { $ne: '' } }).lean();
    if (dish?.imageUrl) {
      r.imageUrl = dish.imageUrl;
      r.images = [dish.imageUrl];
      await r.save();
      banners++;
    }
  }

  console.log(`\n═══════════════════════════════════`);
  console.log(`  Yuklandi     : ${uploaded} rasm`);
  console.log(`  Taomga bog'landi : ${linked} ta`);
  console.log(`  Restoran banneri : ${banners} ta`);
  console.log(`═══════════════════════════════════\n`);

  await mongoose.disconnect();
  process.exit(0);
}

main().catch((e) => {
  console.error('✗ Xato:', e.message);
  process.exit(1);
});
