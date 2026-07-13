import mongoose from 'mongoose';
import { config } from '../config/index.js';
import { Restaurant } from '../models/Restaurant.js';
import { Dish } from '../models/Dish.js';
import { Banner } from '../models/User.js';
import { User } from '../models/User.js';

async function seed() {
  await mongoose.connect(config.mongoUri);
  console.log('Seed boshlandi...');

  await Promise.all([
  Restaurant.deleteMany({}),
  Dish.deleteMany({}),
  Banner.deleteMany({}),
  User.deleteMany({ role: { $in: ['admin', 'restaurant'] } })]
  );

  // Admin va restoran foydalanuvchilari
  await User.create([
  { telegramId: 'admin-demo', firstName: 'Admin', role: 'admin' },
  { telegramId: 'rest-demo', firstName: 'Restoran', role: 'restaurant' }]
  );

  // Tasdiqlanmagan restoranlar (admin panel uchun)
  await Restaurant.create([
  {
    name: 'Osh Markazi',
    cuisine: 'Milliy oshxona',
    deliveryMin: 20,
    deliveryMax: 30,
    category: 'milliy',
    icon: 'ti-bowl',
    isApproved: false
  },
  {
    name: 'Pizza Time',
    cuisine: 'Italyan',
    deliveryMin: 25,
    deliveryMax: 40,
    category: 'fastfood',
    icon: 'ti-pizza',
    isApproved: false
  }]
  );

  await Banner.create([
  {
    eyebrow: 'TANLANGAN AKSIYA',
    title: 'Birinchi buyurtmaga −30% chegirma',
    cta: 'Olish',
    bg: '#411E00',
    accentText: '#FAC775',
    ctaBg: '#EF9F27',
    ctaText: '#2C1400',
    icon: 'ti-gift',
    order: 0
  },
  {
    eyebrow: 'BEPUL YETKAZISH',
    title: '100 000 so‘mdan ortiq buyurtmaga',
    cta: 'Buyurtma',
    bg: '#993C1D',
    accentText: '#F5C4B3',
    ctaBg: '#F0997B',
    ctaText: '#4A1B0C',
    icon: 'ti-bike',
    order: 1
  },
  {
    eyebrow: 'REKLAMA',
    title: 'Sushi Star — yangi ochildi',
    cta: 'Ko‘rish',
    bg: '#0F6E56',
    accentText: '#9FE1CB',
    ctaBg: '#5DCAA5',
    ctaText: '#04342C',
    icon: 'ti-fish',
    order: 2
  }]
  );

  const milliy = await Restaurant.create({
    name: 'Milliy Taomlar',
    cuisine: 'Milliy oshxona',
    rating: 4.8,
    reviewCount: 320,
    deliveryMin: 25,
    deliveryMax: 35,
    deliveryFee: 0,
    category: 'milliy',
    tint: '#FAEEDA',
    icon: 'ti-tools-kitchen-2',
    discount: 30,
    isApproved: true
  });

  await Restaurant.create([
  {
    name: 'Sushi Star',
    cuisine: 'Yapon oshxonasi',
    rating: 4.7,
    reviewCount: 154,
    deliveryMin: 30,
    deliveryMax: 45,
    deliveryFee: 12000,
    category: 'sushi',
    tint: '#E1F5EE',
    icon: 'ti-fish',
    isNew: true,
    isApproved: true
  },
  {
    name: 'Sweet Corner Kafe',
    cuisine: 'Kafe · Shirinliklar',
    rating: 4.6,
    reviewCount: 210,
    deliveryMin: 15,
    deliveryMax: 20,
    deliveryFee: 8000,
    category: 'kafe',
    tint: '#FBEAF0',
    icon: 'ti-coffee',
    isApproved: true
  }]
  );

  await Dish.create([
  {
    restaurantId: milliy._id,
    section: 'Milliy taomlar',
    name: 'Osh (Palov)',
    description:
    'Toshkent uslubidagi an’anaviy palov: mol go‘shti, sabzi, guruch va ziravorlar bilan qozonda tayyorlangan.',
    price: 38000,
    tint: '#FAEEDA',
    icon: 'ti-bowl',
    calories: 620,
    weightGram: 320,
    ingredients: ['Guruch', 'Mol go‘shti', 'Sabzi', 'Piyoz', 'Zira'],
    isHit: true,
    isTrending: true,
    optionGroups: [
    {
      title: 'Porsiya hajmi',
      required: true,
      multiple: false,
      options: [
      { name: 'Oddiy (320 g)', price: 0 },
      { name: 'Katta (450 g)', price: 12000 }]

    },
    {
      title: 'Qo‘shimchalar',
      required: false,
      multiple: true,
      options: [
      { name: 'Achchiq qalampir', price: 3000 },
      { name: 'Qo‘shimcha go‘sht', price: 15000 },
      { name: 'Achichuk salat', price: 8000 }]

    }]

  },
  {
    restaurantId: milliy._id,
    section: 'Milliy taomlar',
    name: 'Lag‘mon',
    description: 'Qo‘lda cho‘zilgan, sabzavotli, achchiq lag‘mon.',
    price: 32000,
    oldPrice: 40000,
    tint: '#FAEEDA',
    icon: 'ti-soup',
    calories: 480,
    weightGram: 400,
    isDiscounted: true
  },
  {
    restaurantId: milliy._id,
    section: 'Shashlik',
    name: 'Kabob set (assorti)',
    description: 'Mol, qo‘y va tovuq shashlik.',
    price: 45000,
    oldPrice: 60000,
    tint: '#FCEBEB',
    icon: 'ti-meat',
    calories: 720,
    weightGram: 300,
    isTrending: true,
    isDiscounted: true
  }]
  );

  console.log('✓ Seed tugadi');
  await mongoose.disconnect();
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
