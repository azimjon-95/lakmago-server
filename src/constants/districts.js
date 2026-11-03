/*
 * ═══ HUDUDLAR: NAMANGAN VILOYATI (shahar va tumanlar) ═══
 *
 * Manba: Namangan viloyati statistika boshqarmasi (namstat.uz) hisobotlaridagi hududiy kesim:
 * Namangan shahri (tarkibida Davlatobod va Yangi Namangan tumanlari) + 11 tuman.
 *
 * Kalit (`id`) — bazada saqlanadi, HECH QACHON o'zgartirilmaydi (restoran, kuryer va buyurtma shu kalit bilan bog'langan).
 * Yangi viloyat/tuman qo'shilsa — faqat SHU ro'yxatga qo'shiladi (frontend ham shu ro'yxatni API'dan oladi).
 *
 * `group` — admin/kuryer ilovasida guruhlab ko'rsatish uchun ("Namangan shahri" ichidagi tumanlar alohida tanlanadi:
 * shahar katta, kuryer faqat o'z qismida ishlashi mumkin).
 */
export const REGION_ID = 'namangan';
export const DEFAULT_DISTRICT = 'pop';

export const DISTRICTS = [
  { id: 'namangan_sh', group: 'city', uz: 'Namangan shahri', uzc: 'Наманган шаҳри', ru: 'г. Наманган' },
  { id: 'davlatobod', group: 'city', uz: 'Davlatobod tumani', uzc: 'Давлатобод тумани', ru: 'Давлатабадский район' },
  { id: 'yangi_namangan', group: 'city', uz: 'Yangi Namangan tumani', uzc: 'Янги Наманган тумани', ru: 'Янгинаманганский район' },
  { id: 'pop', group: 'district', uz: 'Pop tumani', uzc: 'Поп тумани', ru: 'Папский район' },
  { id: 'chust', group: 'district', uz: 'Chust tumani', uzc: 'Чуст тумани', ru: 'Чустский район' },
  { id: 'kosonsoy', group: 'district', uz: 'Kosonsoy tumani', uzc: 'Косонсой тумани', ru: 'Касансайский район' },
  { id: 'mingbuloq', group: 'district', uz: 'Mingbuloq tumani', uzc: 'Мингбулоқ тумани', ru: 'Мингбулакский район' },
  { id: 'namangan_t', group: 'district', uz: 'Namangan tumani', uzc: 'Наманган тумани', ru: 'Наманганский район' },
  { id: 'norin', group: 'district', uz: 'Norin tumani', uzc: 'Норин тумани', ru: 'Нарынский район' },
  { id: 'toraqorgon', group: 'district', uz: "To'raqo'rg'on tumani", uzc: 'Тўрақўрғон тумани', ru: 'Туракурганский район' },
  { id: 'uychi', group: 'district', uz: 'Uychi tumani', uzc: 'Уйчи тумани', ru: 'Уйчинский район' },
  { id: 'uchqorgon', group: 'district', uz: "Uchqo'rg'on tumani", uzc: 'Учқўрғон тумани', ru: 'Учкурганский район' },
  { id: 'chortoq', group: 'district', uz: 'Chortoq tumani', uzc: 'Чортоқ тумани', ru: 'Чартакский район' },
  { id: 'yangiqorgon', group: 'district', uz: "Yangiqo'rg'on tumani", uzc: 'Янгиқўрғон тумани', ru: 'Янгикурганский район' },
];

export const DISTRICT_IDS = DISTRICTS.map((d) => d.id);
const BY_ID = new Map(DISTRICTS.map((d) => [d.id, d]));

export const isDistrict = (id) => BY_ID.has(id);
export const districtOf = (id) => BY_ID.get(id) || null;
export const districtLabel = (id, lang = 'uz') => BY_ID.get(id)?.[lang] || BY_ID.get(id)?.uz || id || '';

/** Ro'yxatni tozalaydi: faqat haqiqiy kalitlar, takrorsiz, ro'yxatdagi tartibda. */
export function normalizeDistricts(list) {
  const want = new Set((Array.isArray(list) ? list : []).map(String));
  return DISTRICT_IDS.filter((id) => want.has(id));
}
