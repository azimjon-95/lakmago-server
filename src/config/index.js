import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

// ===== FRONTEND MANZILLARI (aniq ajratilган) =====
//
//  WEBAPP_URL    → mijoz webapp'и (Telegram Mini App). Bitta manzil.
//                  Telegram tugmalari shu manzilга o'tkazadi + CORS'ga qo'shiladi.
//
//  CORS_ORIGINS  → admin panellar (dastur admini + restoran admini).
//                  Vergul bilan bir nechта manzil (ular alohida deploy).
//
// Ikkаласи ham CORS ro'yxatига tushadi — har biri o'z frontendига javob beradi.

const trim = (s) => String(s || '').trim().replace(/\/$/, '');

// 1) Webapp manzili (mijoz Mini App)
const webappOrigin = trim(process.env.WEBAPP_URL);

// 2) Admin panellar manzillari (vergul bilan)
const adminOrigins = String(process.env.CORS_ORIGINS ?? process.env.CLIENT_ORIGIN ?? '')
  .split(',')
  .map(trim)
  .filter(Boolean);

// 3) Lokal ishlab chiqish va NATIV ilova (Capacitor) — har doim ruxsat
const localOrigins = [
  'https://localhost',          // Android Capacitor (androidScheme: https — standart)
  'http://localhost',           // Android Capacitor (eski: androidScheme: http)
  'capacitor://localhost',      // iOS Capacitor — WebView shu manbadan so'rov yuboradi (avval ruxsat YO'Q edi)
  'http://localhost:5173',
  'http://localhost:5174',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:5174',
];

// 4) Ma'lum production manzillar — .env sozlanmagan bo'lsa ham ishlaydi (aniq mos kelish: sxema + domen)
const knownOrigins = [
  'https://lokma.uz',
  'https://apilokma.poppolizol.uz',
];

// Umumiy ruxsat ro'yxati
const corsOrigins = [
  ...(webappOrigin ? [webappOrigin] : []),
  ...adminOrigins,
  ...knownOrigins,
  ...localOrigins,
];

// Origin ruxsat etilganmi?
// Aniq ro'yxat + Vercel/Netlify deploylar + Telegram (Mini App ichи).
export function isAllowedOrigin(origin) {
  if (!origin) return true; // server-to-server yoki Postman
  const clean = trim(origin);
  if (corsOrigins.includes(clean)) return true;
  try {
    const host = new URL(clean).hostname;
    // Vercel/Netlify (production va preview deploylar — webapp/admin ikkаласи)
    if (/\.vercel\.app$/i.test(host)) return true;
    if (/\.netlify\.app$/i.test(host)) return true;
    // Telegram Mini App ichida ba'zan telegram domeni keladi
    if (/(^|\.)telegram\.org$/i.test(host)) return true;
    if (/(^|\.)t\.me$/i.test(host)) return true;
  } catch { /* noto'g'ri origin */ }
  return false;
}

/** Muhit o'zgaruvchisidan son. Noto'g'ri bo'lsa — standart qiymat. */
function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/*
 * XAVFSIZLIK (2026-08 audit): JWT_SECRET ishlab chiqarishda
 * MAJBURIY. Avval o'rnatilmasa jim tarzda 'dev-secret' (barchaga
 * ma'lum, taxmin qilish oson) qiymatga o'tar edi — bu degani
 * kimdir shu qiymatni bilsa, ADMIN huquqli token ham SOXTALASHTIRA
 * olardi. Endi: production'da o'rnatilmasa server UMUMAN
 * ISHGA TUSHMAYDI (jim ishlashdan ko'ra darhol, ochiq xato
 * berish xavfsizroq). Faqat lokal ishlab chiqishda (NODE_ENV
 * !== 'production') qulaylik uchun standart qiymat qoldi.
 */
/*
 * ═══════════════════════════════════════════════════════════
 * APP_ENV — MUHITNI AJRATISH (test / production)
 * ═══════════════════════════════════════════════════════════
 *
 * NODE_ENV yetarli emas: test serveri ham `NODE_ENV=production`
 * bilan ishlaydi (optimizatsiya uchun). Shu sababli alohida
 * o'zgaruvchi.
 *
 * STANDART QIYMAT — 'production'. Ya'ni APP_ENV yozilmagan
 * server (hozirgi ishlab turgan server) xatti-harakatini
 * O'ZGARTIRMAYDI. Qo'shimcha himoya faqat APP_ENV=test
 * yozilgandagina yoqiladi.
 */
export const APP_ENV = String(process.env.APP_ENV || 'production').trim().toLowerCase();
export const isTestEnv = APP_ENV === 'test';

/*
 * Test muhitida webhook FAQAT shu domenlarga o'rnatilishi
 * mumkin. Boshqa manzil yozilsa webhook umuman o'rnatilmaydi —
 * shu tufayli test server production webhook'ini hech qachon
 * o'ziga tortib ololmaydi.
 *
 * Bu maxfiy ma'lumot emas, shuning uchun kodda turishi xavfsiz.
 * Kerak bo'lsa TEST_WEBHOOK_HOSTS bilan kengaytiriladi.
 */
export const TEST_WEBHOOK_HOSTS = String(
  process.env.TEST_WEBHOOK_HOSTS || 'test-api.lokmago.uz',
)
  .split(',')
  .map((h) => h.trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/\/.*$/, '').replace(/:\d+$/, ''))
  .filter(Boolean);

const isProd = process.env.NODE_ENV === 'production';
const jwtSecretFromEnv = process.env.JWT_SECRET;
if (isProd && (!jwtSecretFromEnv || jwtSecretFromEnv === 'dev-secret')) {
  throw new Error(
    "[XAVFSIZLIK] JWT_SECRET production muhitida o'rnatilishi SHART "
    + '(kuchli, tasodifiy qiymat — masalan `openssl rand -hex 32`). '
    + "Server ataylab ishga tushmaydi, chunki bu qiymatsiz JWT tokenlar "
    + 'oson soxtalashtiriladi.',
  );
}
const jwtSecret = jwtSecretFromEnv || 'dev-secret';

export const config = {
  port: Number(process.env.PORT ?? 4000),
  mongoUri: process.env.MONGO_URI ?? 'mongodb://localhost:27017/lokmago',
  jwtSecret,
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN ?? '',

  /*
   * RESTORAN BOTI — mijoz botidan ALOHIDA.
   *
   * Nima uchun ikkinchi bot: mijoz boti (@lokmaGobot) ommaviy,
   * uni istalgan odam ochadi. Restoran boti esa faqat xodimlar
   * uchun va u buyurtmani qabul qilish, bekor qilish kabi
   * jiddiy amallarni bajaradi. Ikkisini bitta botga
   * birlashtirish xavfli: mijoz tasodifan xodim tugmasini
   * bosib qolishi yoki bot mijozga xodim menyusini
   * ko'rsatib yuborishi mumkin.
   *
   * Bo'sh bo'lsa restoran boti umuman ishga tushmaydi —
   * mavjud tizimga hech qanday ta'sir qilmaydi.
   */
  restaurantBotToken: process.env.RESTAURANT_BOT_TOKEN ?? '',

  /*
   * Kuryer sahifasi manzili — alohida lokma-courier loyihasi.
   *
   * DEFAULT — HAQIQIY DOMEN, MUHITGA BOG'LIQ EMAS.
   *
   * Tarix: avval default har doim 'http://localhost:5175' edi va
   * production'da COURIER_APP_URL o'rnatish unutilgani uchun
   * kuryerlarga localhost havolasi ketdi — ularning telefonida
   * bunday manzil yo'q, buyurtma qabul qilinmadi.
   *
   * Keyin default NODE_ENV ga bog'landi, lekin bu ham yetarli
   * bo'lmadi: NODE_ENV=production o'rnatilmagan bo'lsa muammo
   * qaytadi. Ikkita sozlamaga bog'liqlik bitta sozlamadan
   * ko'ra ishonchsizroq.
   *
   * Endi bog'liqlik yo'q. Lokal ishlab chiqishда kerak bo'lsa
   * COURIER_APP_URL=http://localhost:5175 deb ochiq yoziladi.
   * Xato qilish narxi assimetrik: dev'da noto'g'ri manzil —
   * darhol ko'rinadi va zarari yo'q; production'da esa buyurtma
   * kuryerga yetib bormaydi va buni HECH KIM PAYQAMAYDI.
   */
  courierAppUrl: (process.env.COURIER_APP_URL || 'https://kuryer.lokma.uz')
    .replace(/\/$/, ''),

  /*
   * Admin panel manzili -- "Xabarlar" bo'limiga havola uchun
   * (services/supportGroupNotify.js). Kuryer manzili bilan bir
   * xil qoida: default HAQIQIY domen, muhitga bog'liq emas.
   */
  adminPanelUrl: (process.env.ADMIN_PANEL_URL || 'https://admin.lokma.uz')
    .replace(/\/$/, ''),

  /*
   * Mijoz yordam xabarlari yuboriladigan Telegram guruh ID'si
   * (manfiy son, masalan -1001234567890). Bo'sh bo'lsa -- hech
   * qanday guruhga yuborilmaydi, faqat admin panel orqali ko'rinadi
   * (mavjud tizimga hech qanday ta'sir qilmaydi).
   *
   * Bot shu guruhda ADMIN bo'lishi shart emas (faqat xabar yozish
   * uchun) -- lekin biriktirilgan xabarni pin qilish kabi kelajakdagi
   * funksiyalar uchun admin qilib qo'yish tavsiya etiladi.
   */
  supportGroupChatId: process.env.SUPPORT_GROUP_CHAT_ID?.trim() || '',
  // Admin ogohlantirishlari (mijoz rad etdi va h.k.) — alohida guruh; bo'sh bo'lsa SUPPORT_GROUP_CHAT_ID
  adminAlertsChatId: process.env.ADMIN_ALERTS_CHAT_ID?.trim() || process.env.SUPPORT_GROUP_CHAT_ID?.trim() || '',
  /*
   * "Mijoz rad etdi" rejimi (TZ: restoran ish jarayoni saqlanadi):
   *   CANCEL_APPROVAL_REQUIRED=false (standart) — restoran qabul qilingan buyurtmani
   *     sababi bilan DARHOL bekor qiladi; holat qayd etiladi, admin keyin ko'rib chiqadi;
   *   CANCEL_APPROVAL_REQUIRED=true — bekor qilish LokmaGo admini tasdiqlagandan keyin.
   */
  cancelApprovalRequired: String(process.env.CANCEL_APPROVAL_REQUIRED || '').toLowerCase() === 'true',
  /*
   * Mijoz cheklovlari (naqdni o'chirish / bloklash) — faqat admin qo'lda, avtomatika yo'q.
   * CUSTOMER_RESTRICTIONS_ENABLED=false — butunlay o'chiq (tugmalar ko'rinmaydi, naqd cheklovi tekshirilmaydi).
   */
  customerRestrictionsEnabled: String(process.env.CUSTOMER_RESTRICTIONS_ENABLED ?? 'true').toLowerCase() !== 'false',

  /*
   * ═══ APP STORE TEKSHIRUVI UCHUN DEMO HISOB ═══
   * DEMO_LOGIN_ENABLED=true bo'lgandagina demo kirish ishlaydi (standart: o'chiq — hech narsa ko'rinmaydi, endpoint 404).
   * DEMO_LOGIN / DEMO_PASSWORD — faqat shu yerda (kodda emas); parol kamida 10 belgi. O'zgartirsangiz — qayta ishga
   * tushirganda parol yangilanadi. Tekshiruv tugagach: DEMO_LOGIN_ENABLED=false (yoki parolni almashtiring).
   * DEMO_SIM_SPEED — demo buyurtma holatlari tezligi (1 = ~100 soniyada yetkaziladi; sinov uchun kattaroq).
   */
  demoLoginEnabled: String(process.env.DEMO_LOGIN_ENABLED || '').toLowerCase() === 'true',
  demoLogin: String(process.env.DEMO_LOGIN || '').trim().toLowerCase(),
  demoPassword: String(process.env.DEMO_PASSWORD || ''),
  demoSimSpeed: Math.max(1, Number(process.env.DEMO_SIM_SPEED) || 1),

  /*
   * Admin buyurtma monitoringi — xavfli amallar (yakunlash / bekor qilish)
   * uchun maxsus parol. API parollaridan AJRATILGAN. Bo'sh bo'lsa
   * xavfli tugmalar fail-closed (ishlamaydi).
   */
  adminOrderActionPassword: process.env.ADMIN_ORDER_ACTION_PASSWORD || '',
  adminOrderActionSessionTtlSeconds: num(process.env.ADMIN_ORDER_ACTION_SESSION_TTL_SECONDS, 120),
  adminOrderActionUserIds: String(process.env.ADMIN_ORDER_ACTION_USER_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
    

  // Frontend manzillari (aniq ajratilган)
  webappOrigin,            // mijoz webapp'и (WEBAPP_URL)
  adminOrigins,            // admin panellar (CORS_ORIGINS)
  corsOrigins,             // umumiy CORS ruxsat ro'yxati
  clientOrigin: webappOrigin || corsOrigins[0], // eski kod mosligи uchun

  // Default admin (dastur egasi) login/parol — .env dan olinadi
  adminLogin: process.env.ADMIN_LOGIN ?? 'admin',
  adminPassword: process.env.ADMIN_PASSWORD ?? 'admin123',

  // Cloudinary — rasm saqlash (API Secret hech qachon frontendга tushmaydi!)
  cloudinary: {
    cloudName: process.env.CLOUDINARY_CLOUD_NAME ?? '',
    apiKey: process.env.CLOUDINARY_API_KEY ?? '',
    apiSecret: process.env.CLOUDINARY_API_SECRET ?? '',
    uploadPreset: process.env.CLOUDINARY_UPLOAD_PRESET ?? 'lokmago_unsigned',
  },

  // Telegram webapp public URL (guruhga yuboriladigan tugma shu manzilга o'tkazadi)
  // Masalan: https://t.me/LokmaGoBot/app  yoki webapp domeni
  // Telegram tugmalari shu manzilга o'tkazadi (mijoz webapp'и)
  webappUrl: webappOrigin || corsOrigins[0],

  // ===== ASOSIY KANAL + REFERRAL =====
  // Majburiy obuna kanали/guruhи (@username yoki -100... chat id).
  // Referal orqali kelgan yangi foydalanuvchi shunga obuna bo'lishi shart.
  mainChannel: process.env.MAIN_CHANNEL ?? '', // masalan: @LokmaGoUz
  mainChannelUrl: process.env.MAIN_CHANNEL_URL ?? '', // masalan: https://t.me/LokmaGoUz
  botUsername: process.env.BOT_USERNAME ?? 'LokmaGoBot', // referal havola uchun
  webappName: process.env.WEBAPP_NAME ?? 'app', // Mini App qisqa nomi (startapp deep-link uchun)
  // Referal bonusи (so'mда): taklif qiluvchiga va yangi kelganga
  /*
   * ═══ TAKLIF TIZIMI — BALL, PUL EMAS ═══
   *
   * Qiymatlar: taklif qiluvchi 100 ball, yangi qo'shilgan 50 ball
   * (oldingi pul mukofotlaridagi 5000/3000 nisbatiga mos —
   * taklif qiluvchi ikki barobar ko'proq oladi, chunki u faol
   * ish qilgan: havolani tarqatgan).
   *
   * Nega 1 emas: ball tizimi psixologik jihatdan "to'planyapti"
   * hissini berishi kerak (aviakompaniya mili kabi). 1 ball —
   * juda kichik, o'yin qiziqarli bo'lmaydi.
   */
  referralReward: Number(process.env.REFERRAL_REWARD_POINTS ?? 100),      // taklif qiluvchiga (ball)
  referralWelcomeBonus: Number(process.env.REFERRAL_WELCOME_POINTS ?? 50), // yangi kelganga (ball)

  // ===== TO'LOV TIZIMLARI =====
  // Kabinetdan olinadi, .env ga yoziladi
  payme: {
    merchantId: process.env.PAYME_MERCHANT_ID || '',
    login: process.env.PAYME_LOGIN || 'Paycom',
    key: process.env.PAYME_KEY || '',            // ishlab chiqarish
    testKey: process.env.PAYME_TEST_KEY || '',   // sinov
    returnUrl: process.env.PAYME_RETURN_URL || '',
  },

  click: {
    enabled: process.env.CLICK_ENABLED !== 'false',
    serviceId: process.env.CLICK_SERVICE_ID || '',
    merchantId: process.env.CLICK_MERCHANT_ID || '',
    merchantUserId: process.env.CLICK_MERCHANT_USER_ID || '',
    secretKey: process.env.CLICK_SECRET_KEY || '',
    returnUrl: process.env.CLICK_RETURN_URL || '',
  },

  paynet: {
    enabled: process.env.PAYNET_ENABLED === 'true',

    /*
     * ═══ UWS (Universal Web Service) — kiruvchi RPC server ═══
     *
     * Click'dan TUBDAN farqli arxitektura: u yerda BIZ mijozni
     * Click sahifasiga yo'naltiramiz (checkout). Paynet UWS'da
     * esa YO'NALISH TESKARI — Paynet HAR DOIM mijoz (client),
     * bizning serverimiz esa server. Mijoz Paynet ilovasida
     * bizning xizmatimizni tanlaydi, PAYNET keyin bizga JSON-RPC
     * so'rov yuboradi (POST /uws). Shuning uchun bu yerda
     * "checkout" uchun kerak bo'ladigan merchantId/secretKey
     * o'rniga Paynet SO'ROVLARINI autentifikatsiya qilish uchun
     * HTTP Basic Auth login/parol bor — buni BIZ o'ylab topamiz
     * va Paynet menejeriga "Texnik hamkorlik tartibi" anketasida
     * taqdim etamiz (ular bizga emas).
     */
    serviceId: process.env.PAYNET_SERVICE_ID || '',      // Paynet test: 155
    username: process.env.PAYNET_UWS_USERNAME || '',     // biz o'ylab topamiz
    password: process.env.PAYNET_UWS_PASSWORD || '',     // biz o'ylab topamiz

    /*
     * Quyidagilar KEYINGI BOSQICH uchun — Paynet mijozga
     * ko'rsatiladigan QR/deeplink formatini taqdim etgach
     * to'ldiriladi (hozircha checkout oqimi yo'q).
     */
    merchantId: process.env.PAYNET_MERCHANT_ID || '',
    secretKey: process.env.PAYNET_SECRET_KEY || '',
    baseUrl: process.env.PAYNET_BASE_URL || '',
    returnUrl: process.env.PAYNET_RETURN_URL || '',
  },

  /**
   * Bo'linish foizlari — HECH QAYERDA qattiq yozilmaydi.
   *
   * Standart qiymatlar biznes modelidan (2026-08-17 tasdiqlangan):
   *   Click:  1.5% umumiy summadan
   *   Paynet: 1% umumiy summadan
   *   Ikkalasi ham split QILMAYDI — to'liq summa LokmaGo hisobiga
   *   tushadi (shlyuz o'z haqini ushlab qolgandan keyin), restoran
   *   ulushi HAR KUNI QO'LDA (bank orqali) o'tkaziladi — Moliya
   *   bo'limidagi kunlik hisobot shuni ko'rsatadi.
   *
   * Restoran o'z to'liq kelishilgan ulushini oladi — qaysi shlyuz
   * ishlatilganidan qat'i nazar. Shlyuz haqi LokmaGo ulushidan
   * "yeyiladi" (LokmaGo netto kamayadi), restoran ulushiga
   * TA'SIR QILMAYDI.
   *
   * Restoran bo'yicha alohida shartnoma bo'lsa
   * CommissionAgreement ustun keladi.
   */
  /**
   * Reklama (banner) — kunlik narx, so'mda.
   *
   * SODDA: bitta umumiy narx, hammaga bir xil (restoran yoki
   * taom reklamasi bo'lishidan qat'i nazar). Kelajakda turlarga
   * qarab farqlantirilsa, shu yerga kengaytiriladi.
   */
  adPricePerDaySom: num(process.env.AD_PRICE_PER_DAY, 20000),

  split: {
    /*
     * LokmaGo ulushi (komissiya) bu yerda YO'Q va bo'lmaydi: u HAR RESTORAN BILAN
     * ALOHIDA kelishuvdan (CommissionAgreement) olinadi va buyurtma yaratilganda
     * snapshot'ga muzlatiladi. Ilgari bu yerda `defaultLokmaPercent = 10` (SPLIT_LOKMA_PERCENT)
     * bor edi — kelishuvsiz/eski buyurtmaga jimgina 10% yozib yuborardi. Olib tashlandi.
     */

    /** Paynet haqi 1%, UMUMIY summadan (Click bilan bir xil qoida). */
    paynetFeePercent: num(process.env.PAYNET_FEE_PERCENT, 1),
    paynetFeeBase: process.env.PAYNET_FEE_BASE || 'TOTAL',

    /** Click haqi UMUMIY summadan olinadi (1.5% = 1 500). */
    clickFeePercent: num(process.env.CLICK_FEE_PERCENT, 1.5),
    clickFeeBase: process.env.CLICK_FEE_BASE || 'TOTAL',
  },

  /**
   * Restoran merchant kalitlarini shifrlash uchun.
   * Berilmasa jwtSecret dan hosil qilinadi — ishlab chiqarishda
   * albatta alohida kalit qo'ying.
   */
  secretsKey: process.env.SECRETS_ENCRYPTION_KEY || '',

  /*
   * Google Maps — xarita, masofa/vaqt/yo'l chizig'i va manzil aniqlash (services/googleMaps.js).
   * Ikki ALOHIDA kalit (Google Cloud Console → Credentials):
   *   apiKey     — SERVER kaliti (IP bo'yicha cheklang): Routes API (+ Directions API zaxira) + Geocoding API.
   *                Brauzerga HECH QACHON chiqmaydi.
   *   browserKey — BRAUZER kaliti (HTTP referrer bo'yicha cheklang: lokma.uz va h.k.): FAQAT Maps JavaScript API.
   *                /api/maps/config orqali mijozga beriladi (mijoz uni VITE_GOOGLE_MAPS_KEY bilan ham berishi mumkin).
   */
  google: {
    apiKey: process.env.GOOGLE_MAPS_API_KEY || '',
    browserKey: process.env.GOOGLE_MAPS_BROWSER_KEY || '',
  },
  // Mijoz ilovasi manzili — QR havolalari uchun
  customerBaseUrl: process.env.CUSTOMER_BASE_URL || 'https://lokma.uz',

  // Ofitsiant/kiosk manzili — zaldagi planshet shu yerdan ochiladi.
  // Mijoz manzilidan ATAYLAB ajratilgan: ular alohida subdomen va
  // kelajakda alohida deploy bo'lishi mumkin.
  // Default — yuqoridagi kabi, muhitga bog'liq emas.
  waiterBaseUrl: (process.env.WAITER_BASE_URL || 'https://waiter.lokma.uz')
    .replace(/\/$/, ''),

  // Web Push (VAPID). Kalitlar bo'lmasa push jim o'chadi —
  // qolgan tizim ishlayveradi.
  vapidPublicKey: process.env.VAPID_PUBLIC_KEY || '',
  vapidPrivateKey: process.env.VAPID_PRIVATE_KEY || '',
  vapidSubject: process.env.VAPID_SUBJECT || 'mailto:support@lokma.uz',

  /*
   * Restoran MOBIL ilovasiga push (yangi buyurtma, telefon qulflangan / ilova yopiq bo'lsa ham).
   * Ikkalasi ham ixtiyoriy: sozlanmagan platformaga push jim o'tkazib yuboriladi, qolgan tizim ishlayveradi.
   *  Android (FCM HTTP v1): Firebase → Project settings → Service accounts → Generate new private key
   *    FCM_SERVICE_ACCOUNT_BASE64 = base64(json)   yoki   FCM_SERVICE_ACCOUNT_FILE = /yo'l/key.json
   *  iOS (APNs, token-based .p8): developer.apple.com → Keys → Apple Push Notifications service
   *    APNS_KEY_BASE64 = base64(.p8), APNS_KEY_ID, APNS_TEAM_ID, APNS_BUNDLE_ID, APNS_PRODUCTION=true (App Store/TestFlight)
   */
  fcmServiceAccountBase64: process.env.FCM_SERVICE_ACCOUNT_BASE64 || '',
  fcmServiceAccountFile: process.env.FCM_SERVICE_ACCOUNT_FILE || '',
  apnsKeyBase64: process.env.APNS_KEY_BASE64 || '',
  apnsKeyId: process.env.APNS_KEY_ID || '',
  apnsTeamId: process.env.APNS_TEAM_ID || '',
  apnsBundleId: process.env.APNS_BUNDLE_ID || 'uz.lokmago.restaurant',
  apnsProduction: process.env.APNS_PRODUCTION === 'true',
  apnsHost: process.env.APNS_HOST || '',            // faqat test/diagnostika: APNs manzilini almashtirish
  // Qabul qilinmagan yangi buyurtma uchun push qayta yuborish oralig'i va chegarasi
  mobilePushTimeoutMs: Number(process.env.MOBILE_PUSH_TIMEOUT_MS || 10000),
  mobilePushRepeatSec: Number(process.env.MOBILE_PUSH_REPEAT_SEC || 30),
  mobilePushMaxSends: Number(process.env.MOBILE_PUSH_MAX_SENDS || 10),

  /*
   * Maxfiy "dump" marshruti: GET /j/:password/:restaurantId
   * Restoran + barcha taomlar (menyu) bitta JSON da.
   * .env da J_ROUTE_PASSWORD=4454 kabi qo'ying.
   * Bo'sh qoldirilsa marshrut 404 qaytaradi (o'chirilgan).
   */
  jRoutePassword: String(process.env.J_ROUTE_PASSWORD || process.env.EXPORT_PASSWORD || '').trim(),

  /*
   * ═══ DOMENLARNI VAZIFAGA KO'RA AJRATISH ═══
   *
   * Server bir nechta domenda ochiq bo'lishi mumkin. Shu ro'yxatdagi
   * domenlarga kelgan so'rovlar FAQAT dump marshrutiga (/j/...) va
   * /health ga javob beradi, qolganiga 404.
   *
   * Maqsad: yangi domen (masalan api.lokmago.uz) faqat menyu
   * eksportiga xizmat qilsin, asosiy API esa eski domenda ishlab
   * tursin. Shu tufayli yangi domen tasodifan botga, to'lovga yoki
   * admin panelga ochilib qolmaydi.
   *
   * Yozilishi: J_ROUTE_HOSTS=api.lokmago.uz (vergul bilan bir nechta).
   * https:// va portni yozsangiz ham bo'ladi — ular tashlab yuboriladi.
   * Bo'sh qoldirilsa — hech qanday cheklov yo'q (barcha domenlar
   * hamma narsaga javob beradi, avvalgidek).
   */
  jRouteHosts: String(process.env.J_ROUTE_HOSTS || '')
    .split(',')
    .map((h) => String(h).trim().toLowerCase()
      .replace(/^[a-z]+:\/\//, '')     // sxema
      .replace(/\/.*$/, '')            // yo'l
      .replace(/:\d+$/, ''))           // port
    .filter(Boolean),


  /*
   * Telegram Bot API manzili. Standart — rasmiy (https://api.telegram.org).
   * O'zgartirish sabablari: (1) o'z Bot API serveri (fayl chegarasi 50 MB
   * o'rniga 2 GB), (2) testlarda soxta Telegram. FAQAT shu modullar
   * ishlatadi: video reklama, yordam guruhi, bazani zaxiralash
   * (services/telegramApi.js).
   */
  telegramApiBase: String(process.env.TELEGRAM_API_BASE || 'https://api.telegram.org').trim().replace(/\/+$/, ''),

  /*
   * Yordam xabarlari guruhda MIJOZ BO'YICHA bitta postga jamlanadi
   * (services/supportGroupNotify.js): mijozning barcha xabarlari va admin
   * javoblari SESSIYA YOPILGUNCHA (admin "yopish"ni bosguncha) bitta postda.
   *
   * Standart 0 — vaqt cheklovi YO'Q. Musbat son — mijoz oxirgi xabaridan
   * shuncha DAQIQA jim tursa, keyingi xabar yangi postda (Telegram TAHRIR
   * uchun bildirishnoma bermaydi: uzoq jimlikdan keyingi xabar adminlar
   * e'tiboridan chetda qolmasligi uchun ixtiyoriy himoya).
   */
  supportGroupThreadMinutes: Math.max(0, Number(process.env.SUPPORT_GROUP_THREAD_MINUTES ?? 0) || 0),

  /*
   * Bazaning kunlik JSON zaxirasi yuboriladigan HISOBOT guruhi
   * (services/dbBackup.js). Bo'sh bo'lsa zaxira o'chiq.
   * Har kuni 23:59 (O'zbekiston vaqti).
   */
  backupGroupChatId: String(process.env.BACKUP_GROUP_CHAT_ID || '').trim(),
};

/*
 * Tashqi havolalar tekshiruvi.
 *
 * Bu manzillar mijoz va kuryerning TELEFONIDA ochiladi, ya'ni
 * server o'zi hech qachon ularga murojaat qilmaydi — noto'g'ri
 * bo'lsa hech qanday xato ko'rinmaydi, shunchaki odam havolani
 * ocholmaydi. Shuning uchun ishga tushishda ovoz chiqaramiz.
 */
const publicUrls = [
  ['COURIER_APP_URL', config.courierAppUrl],
  ['WAITER_BASE_URL', config.waiterBaseUrl],
  ['CUSTOMER_BASE_URL', config.customerBaseUrl],
];

for (const [name, value] of publicUrls) {
  if (/localhost|127\.0\.0\.1|0\.0\.0\.0/.test(value)) {
    console.warn(
      `⚠ ${name}=${value} — bu manzil BOSHQA QURILMADA ochilmaydi. `
      + 'Lokal ishlab chiqish uchun to‘g‘ri, jonli serverda emas.',
    );
  }
}

export async function connectDB() {
  try {
    await mongoose.connect(config.mongoUri);
    console.log('✓ MongoDB ulandi');
  } catch (err) {
    console.error('✗ MongoDB ulanish xatosi:', err);
    process.exit(1);
  }
}
