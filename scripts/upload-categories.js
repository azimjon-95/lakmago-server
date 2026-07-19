/**
 * Kategoriya rasmlarini Cloudinary'ga yuklash.
 *
 * ISHLATISH:
 *   1. Taom fotolarini bitta papkaga yig'ing (oq fonli PNG tavsiya etiladi).
 *      Fayl nomlari kategoriya id'siga mos bo'lsin:
 *        milliy.png, choyxona.png, fastfood.png, lavash.png, burger.png,
 *        pitsa.png, sushi.png, shashlik.png, tovuq.png, shirinlik.png,
 *        salqin.png, magazin_oziq.png
 *
 *   2. Serverda ishga tushiring:
 *        node scripts/upload-categories.js ./path/to/images
 *
 *   3. Skript tayyor JS kodini chiqaradi — uni client'dagi
 *      src/data/categories.js fayliga ko'chirasiz.
 *
 * .env da CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET
 * bo'lishi shart.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { config } from '../src/config/index.js';

const FOLDER = 'lokmago/categories';

function sign(params, secret) {
  const toSign = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('&');
  return crypto.createHash('sha1').update(toSign + secret).digest('hex');
}

async function uploadOne(filePath, publicId) {
  const { cloudName, apiKey, apiSecret } = config.cloudinary;
  const timestamp = Math.round(Date.now() / 1000);
  const params = { folder: FOLDER, public_id: publicId, timestamp, overwrite: 'true' };
  const signature = sign(params, apiSecret);

  const form = new FormData();
  const buf = fs.readFileSync(filePath);
  form.append('file', new Blob([buf]), path.basename(filePath));
  form.append('api_key', apiKey);
  form.append('timestamp', String(timestamp));
  form.append('signature', signature);
  form.append('folder', FOLDER);
  form.append('public_id', publicId);
  form.append('overwrite', 'true');

  const res = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/image/upload`, {
    method: 'POST',
    body: form,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `HTTP ${res.status}`);
  return data.secure_url;
}

async function main() {
  const dir = process.argv[2];
  if (!dir) {
    console.error('Foydalanish: node scripts/upload-categories.js ./rasmlar-papkasi');
    process.exit(1);
  }
  const { cloudName, apiKey, apiSecret } = config.cloudinary;
  if (!cloudName || !apiKey || !apiSecret) {
    console.error('Xato: .env da CLOUDINARY_* sozlanmagan');
    process.exit(1);
  }

  const files = fs.readdirSync(dir).filter((f) => /\.(png|jpg|jpeg|webp)$/i.test(f));
  if (!files.length) {
    console.error(`Xato: ${dir} papkasida rasm topilmadi`);
    process.exit(1);
  }

  console.log(`${files.length} ta rasm yuklanmoqda...\n`);
  const result = {};
  for (const f of files) {
    const id = path.basename(f, path.extname(f));
    try {
      const url = await uploadOne(path.join(dir, f), id);
      result[id] = url;
      console.log(`  ✓ ${id}`);
    } catch (e) {
      console.error(`  ✗ ${id}: ${e.message}`);
    }
  }

  console.log('\n===== src/data/categories.js uchun =====\n');
  for (const [id, url] of Object.entries(result)) {
    console.log(`  ${id}: '${url}',`);
  }
  console.log('\nShu havolalarni categories.js dagi img maydonlariga qo\'ying.');
}

main();
