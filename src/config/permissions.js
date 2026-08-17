/**
 * Ruxsatlar xaritasi — qaysi bo'lim (department) qaysi panel
 * sahifalariga kira oladi.
 *
 * BITTA MARKAZIY JOY: yangi bo'lim yoki yangi sahifa qo'shilsa,
 * FAQAT shu yerga qo'shiladi — na backend route'larida, na
 * frontend sidebar'ida qattiq yozilgan mantiq yo'q, ikkalasi
 * ham shu ro'yxatdan o'qiydi (backend — middleware orqali,
 * frontend — sidebar render qilishda).
 *
 * 'admin' bo'limi maxsus: har doim BARCHA sahifalarga ruxsat
 * (pastda avtomatik to'ldiriladi) — alohida sanab o'tirish
 * shart emas va xato qilib biror narsani unutib qo'yish xavfi
 * yo'q.
 */

// Panelning barcha sahifa kalitlar — sidebar shu ro'yxat asosida
// filtrlaydi. Frontend'dagi haqiqiy marshrutlar bilan bir xil
// bo'lishi kerak (src/App.jsx).
export const ALL_PAGES = [
  'dashboard',        // Boshqaruv
  'restaurants',       // Muassasalar
  'orders',            // Buyurtmalar
  'revenue',           // Daromad
  'banners',           // Bannerlar
  'notifications',     // Xabarlar
  'groups',            // Guruhlar
  'catalog',           // Katalog
  'marketing',         // Mijoz jalb qilish
  'dinein',            // Dine-in
  'billing',           // Moliya
  'settings',          // Sozlamalar
  'staff',             // Xodimlar (yollash) — FAQAT admin
  'support',           // Yordam (chat)
];

/**
 * Bo'lim -> ruxsat etilgan sahifalar.
 *
 * 'admin' bu yerda YO'Q — u alohida, pastdagi getAllowedPages()
 * funksiyasida avtomatik "hammasi" deb hisoblanadi.
 */
export const DEPARTMENT_PAGES = {
  accountant: ['dashboard', 'billing', 'revenue'],
  developer: ['dashboard', 'settings', 'staff_readonly'],
  restaurant_ops: ['dashboard', 'restaurants', 'catalog'],
  order_control: ['dashboard', 'orders', 'revenue'],
  dinein_control: ['dashboard', 'dinein'],
  marketing: ['dashboard', 'banners', 'marketing', 'groups', 'notifications'],
  sysadmin: ['dashboard', 'settings', 'notifications'],
};

export const DEPARTMENT_LABELS = {
  admin: 'Administrator (barcha huquq)',
  accountant: 'Buxgalter',
  developer: 'Dasturchi',
  restaurant_ops: 'Restoranlar bilan ishlash',
  order_control: 'Buyurtmalar nazorati',
  dinein_control: 'Dine-in nazorati',
  marketing: 'Reklama va mijoz jalb qilish',
  sysadmin: 'Tizim administratori',
};

/**
 * Berilgan bo'lim (yoki 'admin'/'restaurant') qaysi sahifalarga
 * kira olishini qaytaradi.
 *
 * @param {string} role  'admin' | 'restaurant' | 'staff'
 * @param {string|null} department  faqat role==='staff' bo'lsa kerak
 */
export function getAllowedPages(role, department) {
  if (role === 'admin') return ALL_PAGES;               // dastur egasi — hammasi
  if (role === 'restaurant') return ['restaurant_panel']; // restoran o'z panelida
  if (role === 'staff') return DEPARTMENT_PAGES[department] || [];
  return [];
}

/** Berilgan sahifaga kira oladimi — backend middleware shu bilan tekshiradi. */
export function canAccessPage(role, department, page) {
  return getAllowedPages(role, department).includes(page);
}
