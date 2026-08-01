/**
 * Umumiy katalogni boshlang'ich mahsulotlar bilan to'ldiradi.
 * Ishga tushirish: npm run seed:catalog
 *
 * Mavjud mahsulotlar takrorlanmaydi — faqat yangilari qo'shiladi.
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { CatalogProduct } from '../src/models/CatalogProduct.js';

// Ichimliklar — O'zbekistonda eng ko'p uchraydiganlari
const DRINKS = [
  // Coca-Cola
  { brand: 'Coca-Cola', name: 'Coca-Cola', volume: '0.5 l', price: 8000 },
  { brand: 'Coca-Cola', name: 'Coca-Cola', volume: '1 l', price: 13000 },
  { brand: 'Coca-Cola', name: 'Coca-Cola', volume: '1.5 l', price: 16000 },
  { brand: 'Coca-Cola', name: 'Coca-Cola Zero', volume: '0.5 l', price: 8000 },
  { brand: 'Coca-Cola', name: 'Fanta', volume: '0.5 l', price: 8000 },
  { brand: 'Coca-Cola', name: 'Fanta', volume: '1 l', price: 13000 },
  { brand: 'Coca-Cola', name: 'Sprite', volume: '0.5 l', price: 8000 },
  { brand: 'Coca-Cola', name: 'Sprite', volume: '1 l', price: 13000 },
  { brand: 'Coca-Cola', name: 'Fuse Tea limon', volume: '0.5 l', price: 9000 },

  // Pepsi
  { brand: 'Pepsi', name: 'Pepsi', volume: '0.5 l', price: 8000 },
  { brand: 'Pepsi', name: 'Pepsi', volume: '1 l', price: 13000 },
  { brand: 'Pepsi', name: 'Mirinda', volume: '0.5 l', price: 8000 },
  { brand: 'Pepsi', name: '7UP', volume: '0.5 l', price: 8000 },
  { brand: 'Pepsi', name: 'Lipton Ice Tea', volume: '0.5 l', price: 9000 },

  // Suvlar
  { brand: 'Nestle', name: 'Nestle Pure Life', volume: '0.5 l', price: 4000 },
  { brand: 'Nestle', name: 'Nestle Pure Life', volume: '1 l', price: 6000 },
  { brand: 'Hydrolife', name: 'Hydrolife suv', volume: '0.5 l', price: 4000 },
  { brand: 'Hydrolife', name: 'Hydrolife suv', volume: '1 l', price: 6000 },
  { brand: 'Chortoq', name: 'Chortoq mineral suv', volume: '0.5 l', price: 5000 },
  { brand: 'Chortoq', name: 'Chortoq mineral suv', volume: '1 l', price: 7000 },

  // Sharbatlar
  { brand: 'Dena', name: 'Dena olma sharbati', volume: '1 l', price: 15000 },
  { brand: 'Dena', name: 'Dena apelsin sharbati', volume: '1 l', price: 15000 },
  { brand: 'Nectar', name: 'Nectar shaftoli', volume: '1 l', price: 14000 },
];

// Qahva va choy
const HOT = [
  { name: 'Amerikano', volume: '200 ml', price: 15000, category: 'koffe' },
  { name: 'Kapuchino', volume: '250 ml', price: 20000, category: 'koffe' },
  { name: 'Latte', volume: '300 ml', price: 22000, category: 'koffe' },
  { name: 'Espresso', volume: '50 ml', price: 12000, category: 'koffe' },
  { name: "Ko'k choy", volume: '1 choynak', price: 5000, category: 'choyxona' },
  { name: 'Qora choy', volume: '1 choynak', price: 5000, category: 'choyxona' },
  { name: 'Limonli choy', volume: '1 choynak', price: 8000, category: 'choyxona' },
];

async function run() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error('MONGO_URI topilmadi (.env)');
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log('MongoDB ulandi\n');

  const items = [
    ...DRINKS.map((d) => ({
      name: d.name,
      brand: d.brand,
      volume: d.volume,
      category: 'salqin',
      suggestedPrice: d.price,
      description: '',
    })),
    ...HOT.map((h) => ({
      name: h.name,
      brand: '',
      volume: h.volume,
      category: h.category,
      suggestedPrice: h.price,
      description: '',
    })),
  ];

  let added = 0;
  let skipped = 0;

  for (const item of items) {
    const exists = await CatalogProduct.findOne({
      name: item.name,
      volume: item.volume,
    });
    if (exists) {
      skipped++;
      continue;
    }
    await CatalogProduct.create(item);
    added++;
  }

  console.log(`✓ Qo'shildi: ${added}`);
  console.log(`  O'tkazildi (bor edi): ${skipped}`);
  console.log(`\nJami katalogda: ${await CatalogProduct.countDocuments()}`);
  console.log('\nRasm qo\'shish: admin panel → Katalog');

  await mongoose.disconnect();
}

run().catch((e) => {
  console.error('Xato:', e.message);
  process.exit(1);
});
