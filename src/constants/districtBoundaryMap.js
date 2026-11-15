/*
 * ═══ CHEGARA MA'LUMOTI ↔ LOKMAGO TUMAN KALITLARI ═══
 *
 * Manba: github.com/negeloT/uzbekistan_borders (LVL_3, OpenStreetMap, CC BY 4.0) — `code` maydoni
 * O'zbekiston Statistika qo'mitasi (SOATO) kodi. Moslash KOD bo'yicha (nom bo'yicha emas — nomlar yozilishi turlicha);
 * nomlar faqat ikkinchi tekshiruv uchun (ajratish skripti kod va nom bir-biriga mosligini tasdiqlaydi).
 *
 * DIQQAT: Davlatobod va Yangi Namangan manbada ALOHIDA poligon sifatida YO'Q (ular Namangan shahri poligoni ichida).
 * TZ bo'yicha ularga taxminiy chegara chizilmaydi: avtomatik aniqlashda qo'llanmaydi, shahar ichidagi nuqta → namangan_sh.
 * Kuryer tumani (Restaurant.district) uchun ular avvalgidek ishlatiladi — bu jadval unga tegmaydi.
 */
export const BOUNDARY_SOURCE = {
  repo: 'https://github.com/negeloT/uzbekistan_borders',
  path: 'LVL_3/GEOJSON_LVL_3/UZB_OSM_BORDER_LVL_3.geojson',
  license: 'CC BY 4.0 — © OpenStreetMap contributors; dataset by Tolegen Akynzhanov',
  regionCode: 1714,   // Namangan viloyati (obl_code)
};

/** SOATO kodi → LokmaGo tuman kaliti (src/constants/districts.js). names — moslikni tekshirish uchun (lotin/kirill/rus). */
export const BOUNDARY_DISTRICTS = [
  { code: 1714401, id: 'namangan_sh', names: ['Namangan city', 'Наманган шаҳри', 'Город Наманган', 'Namangan shahri'] },
  { code: 1714219, id: 'pop', names: ['Pop district', 'Поп тумани', 'Папский район', 'Pop tumani'] },
  { code: 1714237, id: 'chust', names: ['Chust district', 'Чуст тумани', 'Чустский район', 'Chust tumani'] },
  { code: 1714207, id: 'kosonsoy', names: ['Kasansay district', 'Косонсой тумани', 'Касансайский район', 'Kosonsoy tumani'] },
  { code: 1714204, id: 'mingbuloq', names: ['Mingbulak district', 'Мингбулоқ тумани', 'Мингбулакский район', 'Mingbuloq tumani'] },
  { code: 1714212, id: 'namangan_t', names: ['Namangan district', 'Наманган тумани', 'Наманганский район', 'Namangan tumani'] },
  { code: 1714216, id: 'norin', names: ['Naryn district', 'Норин тумани', 'Нарынский район', 'Norin tumani'] },
  { code: 1714224, id: 'toraqorgon', names: ['Turakurgan district', 'Тўрақўрғон тумани', 'Туракурганский район', "To'raqo'rg'on tumani"] },
  { code: 1714229, id: 'uychi', names: ['Uychi district', 'Уйчи тумани', 'Уйчинский район', 'Uychi tumani'] },
  { code: 1714234, id: 'uchqorgon', names: ['Uchkurgan district', 'Учқўрғон тумани', 'Учкурганский район', "Uchqo'rg'on tumani"] },
  { code: 1714236, id: 'chortoq', names: ['Chartak district', 'Чортоқ тумани', 'Чартакский район', 'Chortoq tumani'] },
  { code: 1714242, id: 'yangiqorgon', names: ['Yangikurgan district', 'Янгиқўрғон тумани', 'Янгикурганский район', "Yangiqo'rg'on tumani"] },
];

/** Manbada alohida poligoni YO'Q tumanlar (avtomatik aniqlanmaydi; katalog tanlagichida ko'rsatilmaydi). */
export const NO_BOUNDARY_DISTRICTS = ['davlatobod', 'yangi_namangan'];

/** Lotin/kirill/rus nomlarini solishtirish uchun normallashtirish (apostrof, ў/ғ/қ/ҳ, "tumani/район" so'zlari). */
export function normalizeDistrictName(s) {
  const map = { ў: 'o', ғ: 'g', қ: 'q', ҳ: 'h', ё: 'e', й: 'y', ъ: '', ь: '' };
  return String(s || '')
    .toLowerCase()
    .replace(/[ʻʼ'`‘’]/g, '')
    .replace(/[ўғқҳёйъь]/g, (c) => map[c])
    .replace(/\b(tumani|shahri|district|city|город|район|туман[и]?|шаҳри|г\.)\b/gu, '')
    .replace(/(ский|ской|ий)\b/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}
