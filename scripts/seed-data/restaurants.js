// 30 ta real muassasa — O'zbekiston sharoiti (Namangan/Toshkent)
// Har biri turli kategoriya, ish tartibi, xizmat haqi bilan.

export const RESTAURANTS = [
  // ===== MILLIY OSHXONA =====
  { name: 'Milliy Taomlar', cuisine: 'Milliy oshxona · osh, shashlik', category: 'milliy', kind: 'restaurant',
    rating: 4.7, reviewCount: 234, deliveryMin: 25, deliveryMax: 40, deliveryFee: 0,
    openTime: '08:00', closeTime: '23:00', minOrderAmount: 30000, serviceFeePercent: 4,
    serviceFeeMin: 3000, serviceFeeMax: 8000, reservationEnabled: true, tint: '#3A2A18', icon: 'ti-bowl' },

  { name: 'Osh Markazi Namangan', cuisine: 'Devzira osh, milliy taomlar', category: 'osh', kind: 'restaurant',
    rating: 4.8, reviewCount: 412, deliveryMin: 30, deliveryMax: 45, deliveryFee: 0,
    openTime: '07:00', closeTime: '20:00', minOrderAmount: 25000, reservationEnabled: true,
    tint: '#35251C', icon: 'ti-bowl' },

  { name: 'Registon Milliy', cuisine: 'To\'y oshi, manti, somsa', category: 'milliy', kind: 'restaurant',
    rating: 4.5, reviewCount: 178, deliveryMin: 35, deliveryMax: 50, deliveryFee: 8000,
    openTime: '09:00', closeTime: '22:00', reservationEnabled: true, tint: '#3A2A18', icon: 'ti-bowl' },

  { name: 'Beshqozon', cuisine: 'Osh, norin, lag\'mon', category: 'osh', kind: 'restaurant',
    rating: 4.6, reviewCount: 289, deliveryMin: 25, deliveryMax: 40, deliveryFee: 0,
    openTime: '08:00', closeTime: '21:00', discount: 15, reservationEnabled: true,
    tint: '#35251C', icon: 'ti-bowl' },

  // ===== CHOYXONA =====
  { name: 'Chorsu Choyxona', cuisine: 'An\'anaviy choyxona', category: 'choyxona', kind: 'choyxona',
    rating: 4.4, reviewCount: 156, deliveryMin: 30, deliveryMax: 45, deliveryFee: 5000,
    openTime: '07:00', closeTime: '23:00', reservationEnabled: true, tint: '#2E2A18', icon: 'ti-tea' },

  { name: 'Bobur Choyxona', cuisine: 'Choy, somsa, milliy taomlar', category: 'choyxona', kind: 'choyxona',
    rating: 4.3, reviewCount: 98, deliveryMin: 20, deliveryMax: 35, deliveryFee: 0,
    openTime: '06:00', closeTime: '22:00', reservationEnabled: true, tint: '#2E2A18', icon: 'ti-tea' },

  { name: 'Zilola Choyxona', cuisine: 'Oilaviy choyxona', category: 'choyxona', kind: 'choyxona',
    rating: 4.6, reviewCount: 203, deliveryMin: 25, deliveryMax: 40, deliveryFee: 6000,
    openTime: '08:00', closeTime: '23:00', reservationEnabled: true, tint: '#2E2A18', icon: 'ti-tea' },

  // ===== SHASHLIK =====
  { name: 'Mangal Shashlik', cuisine: 'Shashlik, kabob, mangal', category: 'shashlik', kind: 'restaurant',
    rating: 4.7, reviewCount: 341, deliveryMin: 30, deliveryMax: 45, deliveryFee: 0,
    openTime: '11:00', closeTime: '00:00', minOrderAmount: 40000, reservationEnabled: true,
    tint: '#3A2A18', icon: 'ti-flame' },

  { name: 'Tandir Kabob', cuisine: 'Tandir go\'shti, shashlik', category: 'shashlik', kind: 'restaurant',
    rating: 4.5, reviewCount: 187, deliveryMin: 35, deliveryMax: 50, deliveryFee: 7000,
    openTime: '10:00', closeTime: '23:00', discount: 10, tint: '#3A2A18', icon: 'ti-flame' },

  // ===== FAST FOOD =====
  { name: 'EVOS Namangan', cuisine: 'Lavash, burger, kartoshka fri', category: 'fastfood', kind: 'fastfood',
    rating: 4.6, reviewCount: 892, deliveryMin: 20, deliveryMax: 35, deliveryFee: 0,
    openTime: '09:00', closeTime: '02:00', minOrderAmount: 20000, serviceFeePercent: 4,
    serviceFeeMin: 6900, serviceFeeMax: 9900, discount: 20, tint: '#3A2A18', icon: 'ti-pizza' },

  { name: 'Oqtepa Lavash', cuisine: 'Lavash, shaurma, kombo', category: 'lavash', kind: 'fastfood',
    rating: 4.7, reviewCount: 654, deliveryMin: 20, deliveryMax: 30, deliveryFee: 0,
    openTime: '08:00', closeTime: '01:00', minOrderAmount: 25000, discount: 15,
    tint: '#3A2A18', icon: 'ti-meat' },

  { name: 'Street Burger', cuisine: 'Burger, hot-dog, fri', category: 'burger', kind: 'fastfood',
    rating: 4.4, reviewCount: 276, deliveryMin: 25, deliveryMax: 40, deliveryFee: 5000,
    openTime: '10:00', closeTime: '23:00', tint: '#3A2A18', icon: 'ti-burger' },

  { name: 'Max Way', cuisine: 'Fast food, kombo setlar', category: 'fastfood', kind: 'fastfood',
    rating: 4.5, reviewCount: 421, deliveryMin: 25, deliveryMax: 40, deliveryFee: 0,
    openTime: '09:00', closeTime: '00:00', discount: 25, tint: '#3A2A18', icon: 'ti-pizza' },

  { name: 'Shaurma Baraka', cuisine: 'Shaurma, lavash, donar', category: 'lavash', kind: 'fastfood',
    rating: 4.3, reviewCount: 189, deliveryMin: 20, deliveryMax: 35, deliveryFee: 4000,
    openTime: '10:00', closeTime: '23:00', tint: '#3A2A18', icon: 'ti-meat' },

  // ===== PITSA =====
  { name: 'Pizza Roma', cuisine: 'Italyan pitsa, pasta', category: 'pitsa', kind: 'restaurant',
    rating: 4.6, reviewCount: 312, deliveryMin: 30, deliveryMax: 45, deliveryFee: 0,
    openTime: '10:00', closeTime: '23:00', minOrderAmount: 35000, reservationEnabled: true,
    tint: '#3A2A18', icon: 'ti-pizza' },

  { name: 'Dodo Pizza', cuisine: 'Pitsa, ichimliklar', category: 'pitsa', kind: 'fastfood',
    rating: 4.7, reviewCount: 578, deliveryMin: 25, deliveryMax: 40, deliveryFee: 0,
    openTime: '10:00', closeTime: '23:00', discount: 20, tint: '#3A2A18', icon: 'ti-pizza' },

  // ===== SUSHI =====
  { name: 'Sushi Star', cuisine: 'Yapon oshxonasi, rolllar', category: 'sushi', kind: 'restaurant',
    rating: 4.5, reviewCount: 234, deliveryMin: 35, deliveryMax: 55, deliveryFee: 10000,
    openTime: '11:00', closeTime: '23:00', minOrderAmount: 50000, reservationEnabled: true,
    tint: '#2E2A18', icon: 'ti-fish' },

  { name: 'Tokyo Sushi', cuisine: 'Sushi, rollar, wok', category: 'sushi', kind: 'restaurant',
    rating: 4.4, reviewCount: 167, deliveryMin: 40, deliveryMax: 60, deliveryFee: 12000,
    openTime: '12:00', closeTime: '22:00', tint: '#2E2A18', icon: 'ti-fish' },

  // ===== KAFE =====
  { name: 'Coffee House', cuisine: 'Qahva, deserт, nonushta', category: 'kafe', kind: 'cafe',
    rating: 4.8, reviewCount: 445, deliveryMin: 20, deliveryMax: 35, deliveryFee: 0,
    openTime: '07:00', closeTime: '22:00', reservationEnabled: true, tint: '#35251C', icon: 'ti-coffee' },

  { name: 'Sweet Cafe', cuisine: 'Tort, shirinlik, qahva', category: 'kafe', kind: 'cafe',
    rating: 4.6, reviewCount: 289, deliveryMin: 25, deliveryMax: 40, deliveryFee: 5000,
    openTime: '09:00', closeTime: '21:00', discount: 10, tint: '#35251C', icon: 'ti-coffee' },

  { name: 'Brunch Cafe', cuisine: 'Nonushta, salatlar, smuzi', category: 'kafe', kind: 'cafe',
    rating: 4.5, reviewCount: 156, deliveryMin: 25, deliveryMax: 40, deliveryFee: 6000,
    openTime: '08:00', closeTime: '20:00', reservationEnabled: true, tint: '#35251C', icon: 'ti-coffee' },

  // ===== SHIRINLIK =====
  { name: 'Non va Shirinlik', cuisine: 'Nonvoyxona, tortlar', category: 'shirinlik', kind: 'shop',
    rating: 4.7, reviewCount: 367, deliveryMin: 20, deliveryMax: 35, deliveryFee: 0,
    openTime: '06:00', closeTime: '21:00', tint: '#2E2A18', icon: 'ti-cake' },

  { name: 'Tort Baraka', cuisine: 'Buyurtma tortlar, deserт', category: 'shirinlik', kind: 'shop',
    rating: 4.9, reviewCount: 512, deliveryMin: 30, deliveryMax: 60, deliveryFee: 8000,
    openTime: '09:00', closeTime: '20:00', minOrderAmount: 50000, tint: '#2E2A18', icon: 'ti-cake' },

  // ===== RESTORAN (yevropa) =====
  { name: 'Panorama Restaurant', cuisine: 'Yevropa oshxonasi, steyk', category: 'restoran', kind: 'restaurant',
    rating: 4.8, reviewCount: 234, deliveryMin: 40, deliveryMax: 60, deliveryFee: 15000,
    openTime: '11:00', closeTime: '00:00', minOrderAmount: 80000, serviceFeePercent: 5,
    serviceFeeMin: 8000, serviceFeeMax: 15000, reservationEnabled: true,
    reservationNote: 'Kamida 2 soat oldin bron qiling', tint: '#35251C', icon: 'ti-tools-kitchen-2' },

  { name: 'Grand Cafe', cuisine: 'Yevropa va milliy taomlar', category: 'restoran', kind: 'restaurant',
    rating: 4.6, reviewCount: 189, deliveryMin: 35, deliveryMax: 55, deliveryFee: 10000,
    openTime: '10:00', closeTime: '23:00', reservationEnabled: true, tint: '#35251C', icon: 'ti-tools-kitchen-2' },

  // ===== TUNGI KLUB / BAR =====
  { name: 'Night Lounge', cuisine: 'Kokteyl, snack, jonli musiqa', category: 'klub', kind: 'club',
    rating: 4.3, reviewCount: 145, deliveryMin: 40, deliveryMax: 60, deliveryFee: 12000,
    openTime: '18:00', closeTime: '04:00', minOrderAmount: 100000, reservationEnabled: true,
    reservationNote: 'Faqat 18 yoshdan katta', tint: '#2E2A18', icon: 'ti-disco' },

  // ===== MAGAZIN =====
  { name: 'Korzinka Express', cuisine: 'Oziq-ovqat, ichimliklar', category: 'magazin_oziq', kind: 'shop',
    rating: 4.5, reviewCount: 678, deliveryMin: 30, deliveryMax: 50, deliveryFee: 8000,
    openTime: '08:00', closeTime: '23:00', minOrderAmount: 30000, tint: '#35251C', icon: 'ti-building-store' },

  { name: 'Meva Bozor', cuisine: 'Meva-sabzavot, ko\'katlar', category: 'magazin_meva', kind: 'shop',
    rating: 4.6, reviewCount: 234, deliveryMin: 25, deliveryMax: 45, deliveryFee: 5000,
    openTime: '07:00', closeTime: '20:00', tint: '#2E2A18', icon: 'ti-apple' },

  { name: 'Muzqaymoq Olami', cuisine: 'Muzqaymoq, salqin ichimlik', category: 'salqin', kind: 'shop',
    rating: 4.7, reviewCount: 312, deliveryMin: 20, deliveryMax: 35, deliveryFee: 4000,
    openTime: '10:00', closeTime: '23:00', discount: 15, tint: '#2E2A18', icon: 'ti-ice-cream' },

  { name: 'Tovuq House', cuisine: 'Fried chicken, strips, wings', category: 'tovuq', kind: 'fastfood',
    rating: 4.5, reviewCount: 423, deliveryMin: 25, deliveryMax: 40, deliveryFee: 0,
    openTime: '10:00', closeTime: '00:00', minOrderAmount: 30000, discount: 10,
    tint: '#3A2A18', icon: 'ti-meat' },
];
