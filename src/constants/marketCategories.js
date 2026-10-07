/*
 * ═══ LOKMA MARKET — MAHSULOT KATEGORIYALARI (yagona manba) ═══
 *
 * Oziq-ovqat do'konlari (supermarket, mini-market, meva-sabzavot,
 * go'sht, sut do'konlari) uchun. Restoran taom kategoriyalaridan
 * (constants/dishCategories.js) BUTUNLAY ALOHIDA: do'kon mahsuloti
 * `Dish.marketCategory` da saqlanadi, restoran taomlari bilan
 * aralashmaydi.
 *
 * Mijoz ilovasi va admin panel ro'yxatni GET /api/market/categories
 * dan oladi — kategoriya qo'shish/o'zgartirish faqat SHU faylda.
 * `value` — bazada saqlanadi, HECH QACHON o'zgartirilmaydi
 * (o'zgarsa eski mahsulotlar kategoriyasiz qoladi). Yangi qo'shish,
 * nom/emoji/tartibni o'zgartirish — xavfsiz.
 */

export const MARKET_GROUPS = [
  { value: 'fresh', label: 'Yangi mahsulotlar', ru: 'Свежие продукты' },
  { value: 'meat', label: "Go'sht va baliq", ru: 'Мясо и рыба' },
  { value: 'dairy', label: 'Sut va tuxum', ru: 'Молочное и яйца' },
  { value: 'bakery', label: 'Non va shirinliklar', ru: 'Хлеб и сладости' },
  { value: 'grocery', label: 'Bakaleya', ru: 'Бакалея' },
  { value: 'frozen', label: 'Muzlatilgan', ru: 'Заморозка' },
  { value: 'drinks', label: 'Ichimliklar', ru: 'Напитки' },
  { value: 'special', label: 'Maxsus', ru: 'Особое' },
  { value: 'home', label: 'Uy uchun', ru: 'Для дома' },
];

export const MARKET_CATEGORIES = [
  // Yangi mahsulotlar
  { value: 'meva', label: 'Mevalar', ru: 'Фрукты', emoji: '🍎', icon: 'ti-apple', group: 'fresh' },
  { value: 'sabzavot', label: 'Sabzavotlar', ru: 'Овощи', emoji: '🥕', icon: 'ti-carrot', group: 'fresh' },
  { value: 'kokat', label: "Ko'katlar", ru: 'Зелень', emoji: '🌿', icon: 'ti-leaf', group: 'fresh' },
  { value: 'rezavor', label: 'Rezavorlar', ru: 'Ягоды', emoji: '🍓', icon: 'ti-cherry', group: 'fresh' },
  { value: 'quruq_meva', label: "Quruq meva va yong'oq", ru: 'Сухофрукты и орехи', emoji: '🥜', icon: 'ti-seeding', group: 'fresh' },
  { value: 'tuzlama', label: 'Tuzlama va marinad', ru: 'Соленья', emoji: '🥒', icon: 'ti-bottle', group: 'fresh' },

  // Go'sht va baliq
  { value: 'gosht', label: "Mol va qo'y go'shti", ru: 'Говядина и баранина', emoji: '🥩', icon: 'ti-meat', group: 'meat' },
  { value: 'parranda', label: "Parranda go'shti", ru: 'Птица', emoji: '🍗', icon: 'ti-meat', group: 'meat' },
  { value: 'qiyma', label: "Qiyma va yarim tayyor", ru: 'Фарш и полуфабрикаты', emoji: '🍖', icon: 'ti-meat', group: 'meat' },
  { value: 'kolbasa', label: 'Kolbasa va sosiska', ru: 'Колбасы и сосиски', emoji: '🌭', icon: 'ti-sausage', group: 'meat' },
  { value: 'baliq', label: 'Baliq', ru: 'Рыба', emoji: '🐟', icon: 'ti-fish', group: 'meat' },
  { value: 'dengiz', label: 'Dengiz mahsulotlari', ru: 'Морепродукты', emoji: '🦐', icon: 'ti-fish', group: 'meat' },

  // Sut va tuxum
  { value: 'sut', label: 'Sut va qaymoq', ru: 'Молоко и сливки', emoji: '🥛', icon: 'ti-milk', group: 'dairy' },
  { value: 'qatiq', label: 'Qatiq, kefir, yogurt', ru: 'Кефир и йогурты', emoji: '🥣', icon: 'ti-bowl', group: 'dairy' },
  { value: 'tvorog', label: 'Tvorog va smetana', ru: 'Творог и сметана', emoji: '🍶', icon: 'ti-bowl', group: 'dairy' },
  { value: 'pishloq', label: 'Pishloqlar', ru: 'Сыры', emoji: '🧀', icon: 'ti-cheese', group: 'dairy' },
  { value: 'saryog', label: "Sariyog' va margarin", ru: 'Масло и маргарин', emoji: '🧈', icon: 'ti-butter', group: 'dairy' },
  { value: 'tuxum', label: 'Tuxum', ru: 'Яйца', emoji: '🥚', icon: 'ti-egg', group: 'dairy' },

  // Non va shirinliklar
  { value: 'non', label: 'Non', ru: 'Хлеб', emoji: '🍞', icon: 'ti-bread', group: 'bakery' },
  { value: 'pishiriq', label: 'Pishiriqlar', ru: 'Выпечка', emoji: '🥐', icon: 'ti-bread', group: 'bakery' },
  { value: 'tort', label: 'Tort va pirojniy', ru: 'Торты и пирожные', emoji: '🎂', icon: 'ti-cake', group: 'bakery' },
  { value: 'pechenye', label: 'Pechenye va vafli', ru: 'Печенье и вафли', emoji: '🍪', icon: 'ti-cookie', group: 'bakery' },
  { value: 'shokolad', label: 'Shokolad va konfet', ru: 'Шоколад и конфеты', emoji: '🍫', icon: 'ti-candy', group: 'bakery' },
  { value: 'sharqona', label: 'Sharq shirinliklari', ru: 'Восточные сладости', emoji: '🍯', icon: 'ti-candy', group: 'bakery' },

  // Bakaleya
  { value: 'guruch', label: 'Guruch va yormalar', ru: 'Рис и крупы', emoji: '🌾', icon: 'ti-grain', group: 'grocery' },
  { value: 'makaron', label: 'Makaron', ru: 'Макароны', emoji: '🍝', icon: 'ti-bowl', group: 'grocery' },
  { value: 'un', label: 'Un va qandolat uchun', ru: 'Мука и для выпечки', emoji: '🥖', icon: 'ti-wheat', group: 'grocery' },
  { value: 'yog', label: "O'simlik yog'i", ru: 'Растительное масло', emoji: '🫒', icon: 'ti-droplet', group: 'grocery' },
  { value: 'shakar', label: 'Shakar va tuz', ru: 'Сахар и соль', emoji: '🧂', icon: 'ti-salt', group: 'grocery' },
  { value: 'ziravor', label: 'Ziravorlar', ru: 'Специи', emoji: '🌶️', icon: 'ti-pepper', group: 'grocery' },
  { value: 'sous', label: 'Sous va ketchup', ru: 'Соусы и кетчуп', emoji: '🥫', icon: 'ti-bottle', group: 'grocery' },
  { value: 'konserva', label: 'Konservalar', ru: 'Консервы', emoji: '🥫', icon: 'ti-box', group: 'grocery' },
  { value: 'murabbo', label: "Murabbo va asal", ru: 'Варенье и мёд', emoji: '🍯', icon: 'ti-jar', group: 'grocery' },
  { value: 'tez_tayyor', label: 'Tez tayyorlanadigan', ru: 'Быстрого приготовления', emoji: '🍜', icon: 'ti-soup', group: 'grocery' },
  { value: 'nonushta', label: 'Nonushta uchun', ru: 'Для завтрака', emoji: '🥣', icon: 'ti-bowl', group: 'grocery' },
  { value: 'gazak', label: 'Chips va gazaklar', ru: 'Чипсы и снеки', emoji: '🍿', icon: 'ti-popcorn', group: 'grocery' },

  // Muzlatilgan
  { value: 'muzlatilgan', label: 'Muzlatilgan mahsulotlar', ru: 'Замороженные продукты', emoji: '🧊', icon: 'ti-snowflake', group: 'frozen' },
  { value: 'chuchvara', label: 'Chuchvara va manti', ru: 'Пельмени и манты', emoji: '🥟', icon: 'ti-snowflake', group: 'frozen' },
  { value: 'muzqaymoq', label: 'Muzqaymoq', ru: 'Мороженое', emoji: '🍦', icon: 'ti-ice-cream', group: 'frozen' },

  // Ichimliklar
  { value: 'suv', label: 'Suv', ru: 'Вода', emoji: '💧', icon: 'ti-droplet', group: 'drinks' },
  { value: 'gazli', label: 'Gazli ichimliklar', ru: 'Газированные напитки', emoji: '🥤', icon: 'ti-bottle', group: 'drinks' },
  { value: 'sharbat', label: 'Sharbatlar', ru: 'Соки', emoji: '🧃', icon: 'ti-glass-full', group: 'drinks' },
  { value: 'choy', label: 'Choy', ru: 'Чай', emoji: '🍵', icon: 'ti-cup', group: 'drinks' },
  { value: 'qahva', label: 'Qahva va kakao', ru: 'Кофе и какао', emoji: '☕', icon: 'ti-coffee', group: 'drinks' },
  { value: 'energetik', label: 'Energetik ichimliklar', ru: 'Энергетики', emoji: '⚡', icon: 'ti-bolt', group: 'drinks' },

  // Maxsus
  { value: 'bolalar', label: 'Bolalar ovqati', ru: 'Детское питание', emoji: '🍼', icon: 'ti-baby-bottle', group: 'special' },
  { value: 'sogom', label: "Sog'lom va parhez", ru: 'Здоровое питание', emoji: '🥗', icon: 'ti-salad', group: 'special' },
  { value: 'halol', label: 'Halol mahsulotlar', ru: 'Халяль', emoji: '🌙', icon: 'ti-moon', group: 'special' },

  // Uy uchun
  { value: 'uy_kimyo', label: "Uy-ro'zg'or kimyosi", ru: 'Бытовая химия', emoji: '🧴', icon: 'ti-spray', group: 'home' },
  { value: 'gigiyena', label: 'Shaxsiy gigiyena', ru: 'Гигиена', emoji: '🧼', icon: 'ti-wash', group: 'home' },
  { value: 'qogoz', label: "Qog'oz mahsulotlari", ru: 'Бумажная продукция', emoji: '🧻', icon: 'ti-file', group: 'home' },
  { value: 'bir_martalik', label: 'Bir martalik idishlar', ru: 'Одноразовая посуда', emoji: '🥡', icon: 'ti-box', group: 'home' },
  { value: 'uy_hayvon', label: 'Uy hayvonlari uchun', ru: 'Для животных', emoji: '🐾', icon: 'ti-paw', group: 'home' },
  { value: 'boshqa', label: 'Boshqa', ru: 'Другое', emoji: '🛒', icon: 'ti-shopping-cart', group: 'home' },
];

export const MARKET_CATEGORY_VALUES = MARKET_CATEGORIES.map((c) => c.value);

/*
 * Sotish birligi — narx NIMA uchun ekanini bildiradi ("12 000 so'm / kg").
 * Miqdor savatda butun son bo'lib qoladi (1 kg, 2 kg, 3 dona) — savat va
 * buyurtma mantig'i restoran bilan bir xil ishlaydi.
 */
export const MARKET_UNITS = [
  { value: 'dona', label: 'dona', ru: 'шт' },
  { value: 'kg', label: 'kg', ru: 'кг' },
  { value: 'g', label: 'g', ru: 'г' },
  { value: 'l', label: 'l', ru: 'л' },
  { value: 'ml', label: 'ml', ru: 'мл' },
  { value: 'qadoq', label: 'qadoq', ru: 'уп.' },
  { value: 'bog', label: "bog'", ru: 'пучок' },
  { value: 'blok', label: 'blok', ru: 'блок' },
];
export const MARKET_UNIT_VALUES = MARKET_UNITS.map((u) => u.value);

/*
 * ═══ UMUMIY KATALOG → MARKET KATEGORIYASI ═══
 * Do'kon umumiy katalogdan (admin to'ldiradigan CatalogProduct, 70 ta
 * kategoriya — constants/catalogCategories.js) mahsulot qo'shganda,
 * Market kategoriyasi va sotish birligi shu jadvaldan TAKLIF qilinadi
 * (do'kon egasi qo'shish oynasida o'zgartirishi mumkin).
 */
export const CATALOG_TO_MARKET = {
  guruch_don: 'guruch', un_mahsulotlari: 'un', makaron_mahsulotlari: 'makaron',
  dukkakli_mahsulotlar: 'guruch', shakar_shirinlashtiruvchi: 'shakar', tuz: 'shakar',
  osimlik_yoglari: 'yog', sariyog_margarin: 'saryog', sut_mahsulotlari: 'sut',
  pishloq_mahsulotlari: 'pishloq', gosht_mahsulotlari: 'gosht', parranda_goshti: 'parranda',
  kolbasa_sosiska: 'kolbasa', baliq_dengiz_mahsulotlari: 'baliq', tuxum: 'tuxum',
  yangi_meva: 'meva', yangi_sabzavot: 'sabzavot', kokatlar: 'kokat',
  muzlatilgan_mahsulotlar: 'muzlatilgan', yarim_tayyor_mahsulotlar: 'qiyma',
  konserva_mahsulotlari: 'konserva', tuzlama_marinad: 'tuzlama', ziravorlar: 'ziravor',
  souslar: 'sous', ketchup_mayonez: 'sous', sirka: 'sous', tomat_mahsulotlari: 'sous',
  choy: 'choy', qahva: 'qahva', kakao: 'qahva', mineral_suv: 'suv', sharbatlar: 'sharbat',
  gazli_ichimliklar: 'gazli', energetik_ichimliklar: 'energetik', ichimliklar: 'gazli',
  shirinliklar: 'shokolad', konfetlar: 'shokolad', shokolad: 'shokolad',
  pechenye: 'pechenye', vafli: 'pechenye', keks_pishiriqlar: 'pishiriq',
  muzqaymoq: 'muzqaymoq', chips_snacklar: 'gazak', yongoqlar: 'quruq_meva',
  quruq_mevalar: 'quruq_meva', asal: 'murabbo', murabbo_jem: 'murabbo',
  non_mahsulotlari: 'non', bolalar_oziq_ovqatlari: 'bolalar', nonushta_mahsulotlari: 'nonushta',
  pishirish_mahsulotlari: 'un', qandolat_mahsulotlari: 'shokolad',
  fastfood_mahsulotlari: 'tez_tayyor', parhezbop_mahsulotlar: 'sogom',
  maishiy_kimyo: 'uy_kimyo', tozalash_vositalari: 'uy_kimyo', shaxsiy_gigiyena: 'gigiyena',
  bolalar_gigiyena: 'gigiyena', qogoz_salfetka: 'qogoz', bir_martalik_idishlar: 'bir_martalik',
  qadoqlash_materiallari: 'bir_martalik', uy_hayvonlari_ozuqasi: 'uy_hayvon',
};

// Odatda vazn bo'yicha sotiladigan kategoriyalar
const BY_WEIGHT = new Set(['meva', 'sabzavot', 'rezavor', 'gosht', 'parranda', 'baliq', 'qiyma']);

/** Katalog kategoriyasi → { marketCategory, unit } taklifi. */
export function marketSuggestion(catalogCategory) {
  const marketCategory = CATALOG_TO_MARKET[catalogCategory] || 'boshqa';
  const unit = BY_WEIGHT.has(marketCategory) ? 'kg' : marketCategory === 'kokat' ? 'bog' : 'dona';
  return { marketCategory, unit };
}
