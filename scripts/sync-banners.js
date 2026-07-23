/**
 * Mavjud restoran bannerlarini muassasa kartasiga ko'chiradi.
 *
 * Nima uchun: banner alohida kolleksiyada saqlanardi, mijoz ilovasi
 * esa restaurant.imageUrl ni o'qiydi. Shuning uchun saqlangan
 * bannerlar kartada ko'rinmasdi.
 *
 * Bir marta ishga tushiring:
 *   node scripts/sync-banners.js
 */
import mongoose from 'mongoose';
import { config } from '../src/config/index.js';
import { Banner } from '../src/models/User.js';
import { Restaurant } from '../src/models/Restaurant.js';

async function main() {
  await mongoose.connect(config.mongoUri);
  console.log('✓ MongoDB ulandi\n');

  const banners = await Banner.find({
    kind: 'restaurant',
    imageUrl: { $nin: ['', null] },
  }).lean();

  console.log(`${banners.length} ta restoran banneri topildi\n`);

  let updated = 0;
  for (const b of banners) {
    if (!b.restaurantId) continue;
    const r = await Restaurant.findByIdAndUpdate(
      b.restaurantId,
      { imageUrl: b.imageUrl, images: [b.imageUrl] },
      { new: true },
    ).select('name').lean();
    if (r) {
      console.log(`  ✓ ${r.name}`);
      updated++;
    }
  }

  console.log(`\n${updated} ta muassasa yangilandi`);
  await mongoose.disconnect();
  process.exit(0);
}

main().catch((e) => {
  console.error('✗ Xato:', e.message);
  process.exit(1);
});
