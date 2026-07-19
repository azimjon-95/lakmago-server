/**
 * TO'LIQ TEST MA'LUMOTLARI — MongoDB'ga yoziladi.
 *
 * Yaratadi:
 *   • 30 ta muassasa (restoran, choyxona, fast food, magazin...)
 *   • 300+ taom (har muassasa o'z kategoriyasidan menyu oladi)
 *   • 200+ buyurtma (turli holatlarda, oxirgi 30 kun)
 *   • 60+ stol broni (turli holatlarda)
 *   • 40 ta test mijoz
 *   • Har muassasa uchun panel akkaunti (login/parol)
 *
 * ISHLATISH:
 *   node scripts/seed-full.js           — qo'shadi (mavjudini o'chirmaydi)
 *   node scripts/seed-full.js --fresh   — avval hammasini tozalaydi
 *
 * MUHIM: --fresh mavjud ma'lumotni O'CHIRADI. Production'da ehtiyot bo'ling.
 */
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { config } from '../src/config/index.js';
import { Restaurant } from '../src/models/Restaurant.js';
import { Dish } from '../src/models/Dish.js';
import { Order } from '../src/models/Order.js';
import { Reservation } from '../src/models/Reservation.js';
import { User } from '../src/models/User.js';
import { RESTAURANTS } from './seed-data/restaurants.js';
import { DISH_TEMPLATES, DEFAULT_DISHES } from './seed-data/dishes.js';

const FRESH = process.argv.includes('--fresh');

// ===== Yordamchilar =====
const rnd = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const pick = (arr) => arr[rnd(0, arr.length - 1)];
const pickMany = (arr, n) => {
  const copy = [...arr];
  const out = [];
  for (let i = 0; i < n && copy.length; i++) out.push(copy.splice(rnd(0, copy.length - 1), 1)[0]);
  return out;
};
// Oxirgi N kun ichida tasodifiy sana
const daysAgo = (maxDays) => new Date(Date.now() - rnd(0, maxDays) * 86400000 - rnd(0, 86400000));
const slugify = (s) => s.toLowerCase()
  .replace(/[^a-z0-9\s]/g, '').trim().replace(/\s+/g, '_').slice(0, 20);

const UZ_NAMES = ['Aziz', 'Bekzod', 'Dilshod', 'Jasur', 'Sardor', 'Ulug\'bek', 'Shohruh', 'Farrux',
  'Nodira', 'Zilola', 'Malika', 'Gulnora', 'Sevara', 'Dilnoza', 'Kamola', 'Nigora'];
const UZ_SURNAMES = ['Karimov', 'Toshmatov', 'Rahimov', 'Yusupov', 'Abdullayev', 'Ergashev',
  'Nazarov', 'Sultonov', 'Qodirov', 'Mirzayev'];
const STREETS = ['Navoiy', 'Amir Temur', 'Bobur', 'Chilonzor', 'Yunusobod', 'Mustaqillik',
  'Do\'stlik', 'Nodira', 'Zirabuloq', 'Farg\'ona yo\'li'];
const COURIERS = ['Aziz', 'Bek', 'Dilshod', 'Jasur', 'Sardor', 'Ulug\'bek'];

// ===== 1. MUASSASALAR =====
async function seedRestaurants() {
  console.log('\n📍 Muassasalar yaratilmoqda...');
  const created = [];

  for (const data of RESTAURANTS) {
    const login = slugify(data.name);
    const exists = await Restaurant.findOne({ name: data.name });
    if (exists) {
      created.push(exists);
      continue;
    }

    const restaurant = await Restaurant.create({
      ...data,
      isApproved: true,
      isActive: true,
      isBlocked: false,
      address: `Namangan sh., ${pick(STREETS)} ko'chasi, ${rnd(1, 120)}-uy`,
      phone: `+998 9${rnd(0, 9)} ${rnd(100, 999)} ${rnd(10, 99)} ${rnd(10, 99)}`,
      legalName: `MCHJ "${data.name.toUpperCase()}"`,
      legalAddress: `Toshkent sh., Shayxontohur t., ${pick(STREETS)} ko'chasi ${rnd(1, 50)}`,
      inn: String(rnd(300000000, 399999999)),
    });

    // Panel akkaunti (restoran o'z kabinetiga kiradi)
    const userExists = await User.findOne({ login });
    if (!userExists) {
      await User.create({
        login,
        passwordHash: await bcrypt.hash(login + '123', 10),
        role: 'restaurant',
        restaurantId: restaurant._id,
        firstName: data.name,
        isActive: true,
      });
    }

    created.push(restaurant);
  }

  console.log(`   ✓ ${created.length} ta muassasa`);
  return created;
}

// ===== 2. TAOMLAR =====
async function seedDishes(restaurants) {
  console.log('\n🍽 Taomlar yaratilmoqda...');
  let total = 0;

  for (const r of restaurants) {
    const existing = await Dish.countDocuments({ restaurantId: r._id });
    if (existing > 0) { total += existing; continue; }

    const templates = DISH_TEMPLATES[r.category] || DEFAULT_DISHES;
    const docs = templates.map((t, i) => ({
      restaurantId: r._id,
      section: t.section,
      name: t.name,
      description: t.description || '',
      price: t.price,
      // Ba'zilariga chegirma (eski narx)
      ...(t.oldPrice ? { oldPrice: t.oldPrice } : (Math.random() < 0.2
        ? { oldPrice: Math.round(t.price * 1.25 / 1000) * 1000 } : {})),
      weightGram: t.weightGram,
      calories: t.calories,
      isAvailable: Math.random() < 0.95,      // 5% STOP holatida
      isHit: i < 2,                            // birinchi 2 tasi hit
      isTrending: Math.random() < 0.15,
      isDiscounted: Boolean(t.oldPrice) || Math.random() < 0.2,
      tint: r.tint,
      icon: r.icon,
    }));

    await Dish.insertMany(docs);
    total += docs.length;
  }

  console.log(`   ✓ ${total} ta taom`);
  return total;
}

// ===== 3. MIJOZLAR =====
async function seedUsers(count = 40) {
  console.log('\n👥 Test mijozlar yaratilmoqda...');
  const users = [];

  for (let i = 0; i < count; i++) {
    const firstName = pick(UZ_NAMES);
    const lastName = pick(UZ_SURNAMES);
    const telegramId = String(900000000 + i);

    let user = await User.findOne({ telegramId });
    if (!user) {
      user = await User.create({
        telegramId,
        firstName,
        lastName,
        username: `test_${slugify(firstName)}${i}`,
        role: 'customer',
        phone: `+998 9${rnd(0, 9)} ${rnd(100, 999)} ${rnd(10, 99)} ${rnd(10, 99)}`,
        bonusBalance: Math.random() < 0.3 ? rnd(1, 10) * 5000 : 0,
        referralCount: Math.random() < 0.2 ? rnd(1, 5) : 0,
        isSubscribed: true,
        addresses: [{
          title: pick(['Uy', 'Ish', 'Boshqa']),
          address: `${pick(STREETS)} ko'chasi, ${rnd(1, 100)}-uy`,
          street: `${pick(STREETS)} ko'chasi`,
          city: 'Namangan',
          entrance: String(rnd(1, 6)),
          floor: String(rnd(1, 9)),
          flat: String(rnd(1, 80)),
          note: Math.random() < 0.4 ? 'Domofon ishlamaydi, qo\'ng\'iroq qiling' : '',
          labelId: 'home',
          lat: 40.99 + Math.random() * 0.1,
          lng: 71.63 + Math.random() * 0.1,
        }],
      });
      // Birinchi manzilni asosiy qilamiz
      user.defaultAddressId = user.addresses[0]._id;
      await user.save();
    }
    users.push(user);
  }

  console.log(`   ✓ ${users.length} ta mijoz`);
  return users;
}

// ===== 4. BUYURTMALAR =====
async function seedOrders(restaurants, users, count = 220) {
  console.log('\n📦 Buyurtmalar yaratilmoqda...');
  const STATUSES = ['delivered', 'delivered', 'delivered', 'delivered', 'cancelled',
    'pending', 'accepted', 'preparing', 'ready', 'delivering'];
  let created = 0;

  for (let i = 0; i < count; i++) {
    const user = pick(users);
    const restaurant = pick(restaurants);
    const dishes = await Dish.find({ restaurantId: restaurant._id, isAvailable: true }).limit(20).lean();
    if (!dishes.length) continue;

    const chosen = pickMany(dishes, rnd(1, 4));
    const items = chosen.map((d) => ({
      dishId: d._id,
      name: d.name,
      quantity: rnd(1, 3),
      unitPrice: d.price,
      selectedOptions: [],
    }));

    const subtotal = items.reduce((s, it) => s + it.unitPrice * it.quantity, 0);
    const deliveryFee = restaurant.deliveryFee || 0;
    const serviceFee = restaurant.serviceFeePercent
      ? Math.min(Math.max(Math.round(subtotal * restaurant.serviceFeePercent / 100),
          restaurant.serviceFeeMin || 0), restaurant.serviceFeeMax || 999999)
      : 0;
    const bonusUsed = Math.random() < 0.15 ? Math.min(rnd(1, 4) * 5000, subtotal) : 0;
    const status = pick(STATUSES);
    const createdAt = daysAgo(30);
    const addr = user.addresses?.[0];

    await Order.create({
      userId: user._id,
      restaurantId: restaurant._id,
      restaurantName: restaurant.name,
      groupId: 'G' + createdAt.getTime() + i,
      items,
      subtotal,
      deliveryFee,
      serviceFee,
      bonusUsed,
      total: subtotal + deliveryFee + serviceFee - bonusUsed,
      status,
      address: addr ? `${addr.title} — ${addr.address}` : 'Namangan sh.',
      phone: user.phone,
      paymentMethod: pick(['cash', 'payme', 'click']),
      etaMinutes: rnd(restaurant.deliveryMin, restaurant.deliveryMax),
      courierName: pick(COURIERS),
      ...(status === 'delivered' ? {
        rating: rnd(4, 5),
        comment: Math.random() < 0.4 ? pick([
          'Juda mazali, rahmat!', 'Tez yetkazishdi', 'Hammasi zo\'r',
          'Yaxshi, yana buyurtma qilaman', 'Issiq va mazali edi',
        ]) : '',
        ratedAt: createdAt,
        acceptedAt: createdAt,
        readyAt: createdAt,
        deliveredAt: createdAt,
      } : {}),
      createdAt,
      updatedAt: createdAt,
    });
    created++;
  }

  console.log(`   ✓ ${created} ta buyurtma`);
  return created;
}

// ===== 5. BRONLAR =====
async function seedReservations(restaurants, users, count = 60) {
  console.log('\n📅 Stol bronlari yaratilmoqda...');
  const bookable = restaurants.filter((r) => r.reservationEnabled);
  if (!bookable.length) { console.log('   ⚠ Bron qabul qiladigan muassasa yo\'q'); return 0; }

  const STATUSES = ['pending', 'confirmed', 'confirmed', 'coming', 'arrived',
    'completed', 'rejected', 'not_coming'];
  let created = 0;

  for (let i = 0; i < count; i++) {
    const user = pick(users);
    const restaurant = pick(bookable);
    // Yarmi o'tgan, yarmi kelajakda
    const offsetDays = rnd(-14, 7);
    const date = new Date(Date.now() + offsetDays * 86400000);
    const hour = rnd(12, 21);
    const minute = pick([0, 30]);
    date.setHours(hour, minute, 0, 0);

    const dateStr = date.toISOString().slice(0, 10);
    const timeStr = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    const status = offsetDays < 0 ? pick(['completed', 'completed', 'not_coming', 'rejected'])
      : pick(STATUSES);

    await Reservation.create({
      userId: user._id,
      restaurantId: restaurant._id,
      restaurantName: restaurant.name,
      date: dateStr,
      time: timeStr,
      scheduledAt: date,
      guests: rnd(2, 8),
      name: `${user.firstName} ${user.lastName}`,
      phone: user.phone,
      note: Math.random() < 0.3 ? pick([
        'Deraza yonida bo\'lsa', 'Tug\'ilgan kun', 'Bolalar bilan kelamiz',
      ]) : '',
      status,
      ...(status === 'rejected' ? { rejectReason: 'Bu vaqtda joy band' } : {}),
      createdAt: new Date(date.getTime() - rnd(1, 5) * 86400000),
    });
    created++;
  }

  console.log(`   ✓ ${created} ta bron`);
  return created;
}

// ===== ASOSIY =====
async function main() {
  console.log('═══════════════════════════════════════');
  console.log('  LokmaGo — test ma\'lumotlari');
  console.log('═══════════════════════════════════════');

  await mongoose.connect(config.mongoUri);
  console.log('✓ MongoDB ulandi');

  if (FRESH) {
    console.log('\n⚠️  --fresh: mavjud ma\'lumot tozalanmoqda...');
    await Promise.all([
      Restaurant.deleteMany({}),
      Dish.deleteMany({}),
      Order.deleteMany({}),
      Reservation.deleteMany({}),
      User.deleteMany({ role: { $in: ['customer', 'restaurant'] } }),
    ]);
    console.log('   ✓ Tozalandi (admin akkaunt saqlandi)');
  }

  const restaurants = await seedRestaurants();
  const dishCount = await seedDishes(restaurants);
  const users = await seedUsers(40);
  const orderCount = await seedOrders(restaurants, users, 220);
  const resvCount = await seedReservations(restaurants, users, 60);

  console.log('\n═══════════════════════════════════════');
  console.log('  YAKUN');
  console.log('═══════════════════════════════════════');
  console.log(`  Muassasalar : ${restaurants.length}`);
  console.log(`  Taomlar     : ${dishCount}`);
  console.log(`  Mijozlar    : ${users.length}`);
  console.log(`  Buyurtmalar : ${orderCount}`);
  console.log(`  Bronlar     : ${resvCount}`);
  console.log('───────────────────────────────────────');
  console.log('  Restoran paneliga kirish:');
  console.log(`    login: ${slugify(RESTAURANTS[0].name)}`);
  console.log(`    parol: ${slugify(RESTAURANTS[0].name)}123`);
  console.log('  (har muassasa uchun: login = nom, parol = login+123)');
  console.log('═══════════════════════════════════════\n');

  await mongoose.disconnect();
  process.exit(0);
}

main().catch((e) => {
  console.error('\n✗ Xato:', e.message);
  console.error(e.stack);
  process.exit(1);
});
