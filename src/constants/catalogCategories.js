/**
 * Umumiy mahsulot katalogi uchun kategoriyalar.
 *
 * Bu ro'yxat ENDI faqat ichimlik/tayyor mahsulot uchun emas —
 * oziq-ovqat optom do'konlari (dukonlar) uchun to'liq assortiment
 * bazasi sifatida kengaytirildi (70 ta kategoriya).
 *
 * Muassasa turi bo'yicha ko'rinish qoidasi:
 *   - restoran / kafe / oshxona / choyxona / fastfood / klub —
 *     FAQAT "Ichimliklar" (DRINKS_CATEGORY) ko'rinadi. Bu turdagi
 *     muassasalar ovqat tayyorlaydi, katalogdan faqat tayyor
 *     ichimlik (Coca-Cola, suv va h.k.) tanlab qo'shadi.
 *   - do'kon (Restaurant.kind === 'shop') — barcha 70 kategoriya
 *     ko'rinadi, chunki do'kon o'zi ovqat tayyorlamaydi, faqat
 *     tayyor mahsulot sotadi.
 *
 * Bu qoida server tomonida (catalogProducts controller,
 * `forRestaurant` handler) qat'iy majburlanadi — mijoz (frontend)
 * so'ragan filtr e'tiborga olinmaydi, chunki bu biznes qoidasi,
 * ixtiyoriy UI tanlovi emas.
 */

// Muassasalarga (restoran/kafe/oshxona/choyxona) ko'rinadigan yagona kategoriya
export const DRINKS_CATEGORY = 'ichimliklar';

export const CATALOG_CATEGORIES = [
  { value: 'guruch_don', label: 'Guruch va don mahsulotlari' },
  { value: 'un_mahsulotlari', label: 'Un va un mahsulotlari' },
  { value: 'makaron_mahsulotlari', label: 'Makaron mahsulotlari' },
  { value: 'dukkakli_mahsulotlar', label: 'Dukkakli mahsulotlar' },
  { value: 'shakar_shirinlashtiruvchi', label: 'Shakar va shirinlashtiruvchilar' },
  { value: 'tuz', label: 'Tuz' },
  { value: 'osimlik_yoglari', label: "O'simlik yog'lari" },
  { value: 'sariyog_margarin', label: "Sariyog' va margarin" },
  { value: 'sut_mahsulotlari', label: 'Sut va sut mahsulotlari' },
  { value: 'pishloq_mahsulotlari', label: 'Pishloq mahsulotlari' },
  { value: 'gosht_mahsulotlari', label: "Go'sht mahsulotlari" },
  { value: 'parranda_goshti', label: "Parranda go'shti" },
  { value: 'kolbasa_sosiska', label: 'Kolbasa va sosiska mahsulotlari' },
  { value: 'baliq_dengiz_mahsulotlari', label: 'Baliq va dengiz mahsulotlari' },
  { value: 'tuxum', label: 'Tuxum' },
  { value: 'yangi_meva', label: 'Yangi meva' },
  { value: 'yangi_sabzavot', label: 'Yangi sabzavot' },
  { value: 'kokatlar', label: "Ko'katlar" },
  { value: 'muzlatilgan_mahsulotlar', label: 'Muzlatilgan mahsulotlar' },
  { value: 'yarim_tayyor_mahsulotlar', label: 'Yarim tayyor mahsulotlar' },
  { value: 'konserva_mahsulotlari', label: 'Konserva mahsulotlari' },
  { value: 'tuzlama_marinad', label: 'Tuzlama va marinadlar' },
  { value: 'ziravorlar', label: 'Ziravorlar' },
  { value: 'souslar', label: 'Souslar' },
  { value: 'ketchup_mayonez', label: 'Ketchup va mayonez' },
  { value: 'sirka', label: 'Sirka' },
  { value: 'tomat_mahsulotlari', label: 'Tomat mahsulotlari' },
  { value: 'choy', label: 'Choy' },
  { value: 'qahva', label: 'Qahva' },
  { value: 'kakao', label: 'Kakao' },
  { value: DRINKS_CATEGORY, label: 'Ichimliklar' },
  { value: 'mineral_suv', label: 'Mineral suv' },
  { value: 'sharbatlar', label: 'Sharbatlar' },
  { value: 'gazli_ichimliklar', label: 'Gazli ichimliklar' },
  { value: 'energetik_ichimliklar', label: 'Energetik ichimliklar' },
  { value: 'shirinliklar', label: 'Shirinliklar' },
  { value: 'konfetlar', label: 'Konfetlar' },
  { value: 'shokolad', label: 'Shokolad' },
  { value: 'pechenye', label: 'Pechenye' },
  { value: 'vafli', label: 'Vafli' },
  { value: 'keks_pishiriqlar', label: 'Keks va pishiriqlar' },
  { value: 'muzqaymoq', label: 'Muzqaymoq' },
  { value: 'chips_snacklar', label: 'Chips va snacklar' },
  { value: 'yongoqlar', label: "Yong'oqlar" },
  { value: 'quruq_mevalar', label: 'Quruq mevalar' },
  { value: 'asal', label: 'Asal' },
  { value: 'murabbo_jem', label: 'Murabbo va jem' },
  { value: 'non_mahsulotlari', label: 'Non va non mahsulotlari' },
  { value: 'bolalar_oziq_ovqatlari', label: 'Bolalar oziq-ovqatlari' },
  { value: 'nonushta_mahsulotlari', label: 'Nonushta mahsulotlari' },
  { value: 'pishirish_mahsulotlari', label: 'Pishirish mahsulotlari' },
  { value: 'qandolat_mahsulotlari', label: 'Qandolat mahsulotlari' },
  { value: 'fastfood_mahsulotlari', label: 'Fast-food mahsulotlari' },
  { value: 'parhezbop_mahsulotlar', label: 'Parhezbop mahsulotlar' },
  { value: 'milliy_oziq_ovqat', label: 'Milliy oziq-ovqat mahsulotlari' },
  { value: 'xorijiy_oziq_ovqat', label: 'Xorijiy oziq-ovqat mahsulotlari' },
  { value: 'maishiy_kimyo', label: 'Maishiy kimyo' },
  { value: 'shaxsiy_gigiyena', label: 'Shaxsiy gigiyena mahsulotlari' },
  { value: 'qogoz_salfetka', label: "Qog'oz va salfetka mahsulotlari" },
  { value: 'bir_martalik_idishlar', label: 'Bir martalik idishlar' },
  { value: 'oshxona_xojalik_buyumlari', label: "Oshxona va xo'jalik buyumlari" },
  { value: 'tozalash_vositalari', label: 'Tozalash vositalari' },
  { value: 'uy_rozgor_mahsulotlari', label: "Uy-ro'zg'or mahsulotlari" },
  { value: 'bolalar_gigiyena', label: 'Bolalar gigiyena mahsulotlari' },
  { value: 'uy_hayvonlari_ozuqasi', label: 'Uy hayvonlari ozuqasi' },
  { value: 'tamaki_mahsulotlari', label: 'Tamaki mahsulotlari' },
  { value: 'sovgalik_qadoqlangan', label: "Sovg'alik va qadoqlangan mahsulotlar" },
  { value: 'qadoqlash_materiallari', label: 'Qadoqlash materiallari' },
  { value: 'restoran_kafe_mahsulotlari', label: 'Restoran va kafe uchun mahsulotlar' },
  { value: 'ofis_korxona_oziq_ovqat', label: 'Ofis va korxonalar uchun oziq-ovqat mahsulotlari' },
];

export const CATALOG_CATEGORY_VALUES = CATALOG_CATEGORIES.map((c) => c.value);
