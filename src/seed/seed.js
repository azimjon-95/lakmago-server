import mongoose from 'mongoose';
import { config } from '../config/index.js';
import { Restaurant } from '../models/Restaurant.js';
import { Dish } from '../models/Dish.js';
import { Banner, User } from '../models/User.js';

async function seed() {
  await mongoose.connect(config.mongoUri);
  console.log('Seed boshlandi...');

  await Promise.all([
    Restaurant.deleteMany({}),
    Dish.deleteMany({}),
    Banner.deleteMany({}),
    User.deleteMany({ role: { $in: ['admin', 'restaurant'] } }),
  ]);

  // ===== Default admin (dastur egasi) =====
  await User.create({
    login: config.adminLogin.toLowerCase(),
    passwordHash: User.hashPassword(config.adminPassword),
    role: 'admin',
    firstName: 'Administrator',
  });
  console.log(`✓ Admin: login="${config.adminLogin}" parol="${config.adminPassword}"`);

  // ===== Bannerlar =====
  await Banner.create([
    { kind: 'platform', eyebrow: 'TANLANGAN AKSIYA', title: 'Birinchi buyurtmaga −30% chegirma', cta: 'Olish', bg: '#411E00', accentText: '#FAC775', ctaBg: '#EF9F27', ctaText: '#2C1400', icon: 'ti-gift', order: 0 },
    { kind: 'platform', eyebrow: 'BEPUL YETKAZISH', title: '100 000 so\u2018mdan ortiq buyurtmaga', cta: 'Buyurtma', bg: '#993C1D', accentText: '#F5C4B3', ctaBg: '#F0997B', ctaText: '#4A1B0C', icon: 'ti-bike', order: 1 },
    { kind: 'platform', eyebrow: 'REKLAMA', title: 'Sushi Star \u2014 yangi ochildi', cta: 'Ko\u2018rish', bg: '#0F6E56', accentText: '#9FE1CB', ctaBg: '#5DCAA5', ctaText: '#04342C', icon: 'ti-fish', order: 2 },
  ]);

  // ===== Restoran + akkaunt yaratuvchi yordamchi =====
  async function makeRestaurant(data, login, password) {
    const restaurant = await Restaurant.create({ ...data, isApproved: true, isActive: true });
    const owner = await User.create({
      login,
      passwordHash: User.hashPassword(password),
      role: 'restaurant',
      restaurantId: restaurant._id,
      firstName: data.name,
    });
    restaurant.ownerId = owner._id;
    await restaurant.save();
    console.log(`\u2713 ${data.name}: login="${login}" parol="${password}"`);
    return restaurant;
  }

  const milliy = await makeRestaurant(
    { name: 'Milliy Taomlar', cuisine: 'Milliy oshxona', rating: 4.8, reviewCount: 320, deliveryMin: 25, deliveryMax: 35, deliveryFee: 0, category: 'milliy', kind: 'restaurant', tint: '#FAEEDA', icon: 'ti-tools-kitchen-2', discount: 30 },
    'milliy', 'milliy123',
  );
  await makeRestaurant(
    { name: 'Sushi Star', cuisine: 'Yapon oshxonasi', rating: 4.7, reviewCount: 154, deliveryMin: 30, deliveryMax: 45, deliveryFee: 12000, category: 'sushi', kind: 'restaurant', tint: '#E1F5EE', icon: 'ti-fish', isFresh: true },
    'sushi', 'sushi123',
  );
  await makeRestaurant(
    { name: 'Sweet Corner Kafe', cuisine: 'Kafe \u00b7 Shirinliklar', rating: 4.6, reviewCount: 210, deliveryMin: 15, deliveryMax: 20, deliveryFee: 8000, category: 'kafe', kind: 'cafe', tint: '#FBEAF0', icon: 'ti-coffee' },
    'kafe', 'kafe123',
  );

  // ===== Milliy Taomlar menyusi =====
  await Dish.create([
    {
      restaurantId: milliy._id, section: 'Milliy taomlar', name: 'Osh (Palov)',
      description: 'Toshkent uslubidagi an\u2019anaviy palov: mol go\u2018shti, sabzi, guruch va ziravorlar bilan qozonda tayyorlangan.',
      price: 38000, tint: '#FAEEDA', icon: 'ti-bowl', calories: 620, weightGram: 320,
      ingredients: ['Guruch', 'Mol go\u2018shti', 'Sabzi', 'Piyoz', 'Zira'], isHit: true, isTrending: true,
      optionGroups: [
        { title: 'Porsiya hajmi', required: true, multiple: false, options: [{ name: 'Oddiy (320 g)', price: 0 }, { name: 'Katta (450 g)', price: 12000 }] },
        { title: 'Qo\u2018shimchalar', required: false, multiple: true, options: [{ name: 'Achchiq qalampir', price: 3000 }, { name: 'Qo\u2018shimcha go\u2018sht', price: 15000 }, { name: 'Achichuk salat', price: 8000 }] },
      ],
    },
    { restaurantId: milliy._id, section: 'Milliy taomlar', name: 'Lag\u2018mon', description: 'Qo\u2018lda cho\u2018zilgan, sabzavotli, achchiq lag\u2018mon.', price: 32000, oldPrice: 40000, tint: '#FAEEDA', icon: 'ti-soup', calories: 480, weightGram: 400, isDiscounted: true },
    { restaurantId: milliy._id, section: 'Shashlik', name: 'Kabob set (assorti)', description: 'Mol, qo\u2018y va tovuq shashlik.', price: 45000, oldPrice: 60000, tint: '#FCEBEB', icon: 'ti-meat', calories: 720, weightGram: 300, isTrending: true, isDiscounted: true },
  ]);

  console.log('\u2713 Seed tugadi');
  await mongoose.disconnect();
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
