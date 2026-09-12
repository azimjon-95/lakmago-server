import { Schema, model } from 'mongoose';

/*
 * ═══════════════════════════════════════════════════════════
 * RESTORAN XODIMINING TELEGRAM AKKAUNTI
 * ═══════════════════════════════════════════════════════════
 *
 * Restoran xodimi buyurtmalarni panelga kirmasdan, Telegram bot
 * orqali qabul qilishi uchun.
 *
 * ─── NIMA UCHUN ALOHIDA MODEL, StaffUser EMAS ───
 * StaffUser — LokmaGo'ning O'Z xodimlari uchun (department
 * maydoni bilan: buxgalteriya, qo'llab-quvvatlash...). Restoran
 * xodimi butunlay boshqa narsa: u LokmaGo tizimiga kirmaydi,
 * paroli yo'q, faqat bitta restoran buyurtmalarini ko'radi.
 * Ikkisini bitta modelga tiqish keyinchalik huquqlar chalkashib
 * ketishiga olib kelardi.
 *
 * ─── USERNAME VA TELEGRAM ID ROLLARI ───
 * Bu ikkisi BIR XIL emas va ataylab har xil vazifa bajaradi:
 *
 *   username    — admin panelda QO'LDA kiritiladi. Faqat
 *                 dastlabki ulanish uchun: bot kelgan odamning
 *                 username'ini shu bilan solishtiradi.
 *                 Telegram'da username ISTALGAN VAQT
 *                 o'zgartirilishi mumkin, shuning uchun unga
 *                 uzoq muddat tayanib bo'lmaydi.
 *
 *   telegramUserId — bot AVTOMATIK oladi, tasdiqlangandan
 *                 keyin ASOSIY identifikator. U hech qachon
 *                 o'zgarmaydi. Barcha keyingi tekshiruvlar
 *                 (buyurtma yuborish, tugma bosilishi) faqat
 *                 shu bo'yicha.
 *
 * Shu sababli username keyin o'zgarsa ham ulanish buzilmaydi.
 */
const restaurantTelegramStaffSchema = new Schema(
  {
    restaurantId: {
      type: Schema.Types.ObjectId,
      ref: 'Restaurant',
      required: true,
      index: true,
    },

    // Admin kiritadi. @ belgisisiz, kichik harflarda saqlanadi —
    // Telegram username'lari registr sezmaydi, solishtirish
    // xatosining oldini oladi.
    username: { type: String, required: true, lowercase: true, trim: true },

    // Bot beradi. Ulanmaguncha null.
    // Indeks pastda (unique + partial) — bu yerda `index: true`
    // qo'yilmaydi, aks holda Mongoose "Duplicate schema index" ogohlantiradi
    telegramUserId: { type: String, default: null },

    // Ko'rsatish uchun — bot /start da oladi
    firstName: { type: String, default: '' },
    lastName: { type: String, default: '' },

    /*
     * BIR MARTALIK ULANISH TOKENI.
     *
     * Admin "Telegram botga ulash" bosganda yaratiladi va
     * deep-link ichiga qo'yiladi: t.me/BOT?start=<token>
     *
     * Nima uchun token kerak: linkni boshqa odam ham bosishi
     * mumkin. Token bo'lmasa, kim bo'lsa ham /start yozib
     * restoranga ulanib olardi. Token esa aynan qaysi yozuv
     * uchun ekanini bog'laydi va username bilan qo'shimcha
     * tekshiriladi — ikki qatlamli himoya.
     */
    connectToken: { type: String, default: null, index: true },
    connectTokenExpiresAt: { type: Date, default: null },

    /*
     * Faol emas = buyurtma yuborilmaydi.
     *
     * Admin "Telegramni uzish" bosganda yozuv O'CHIRILMAYDI,
     * shunchaki faolsizlanadi. Sabab: eski buyurtmalarda
     * "kim qabul qildi" ma'lumoti saqlanib qolishi kerak.
     */
    isActive: { type: Boolean, default: true },

    connectedAt: { type: Date, default: null },
    lastActionAt: { type: Date, default: null },

    /*
     * Pastki menyu (reply keyboard) versiyasi. Menyu o'zgarganda
     * MENU_VERSION oshiriladi va server ishga tushganda barcha
     * faol xodimlarga yangi menyu BIR MARTA yuboriladi
     * (restaurantBotMenu.ensureStaffMenus).
     */
    menuVersion: { type: Number, default: 0 },

    /*
     * ═══ OVOZLI SIGNAL SOZLAMASI (HAR XODIM O'ZI UCHUN) ═══
     *
     * Botdagi "⚙️ Sozlamalar" menyusidan yoqiladi/o'chiriladi.
     * Tanlov BAZADA — xodim uni bir marta o'chirsa, telefon
     * o'chib-yonsa ham, server qayta ishga tushsa ham esda
     * qoladi (xotiradagi belgi restartda yo'qolardi).
     *
     * Bu faqat OVOZLI SIGNALGA tegishli: buyurtma va bron
     * kartalari baribir keladi, hech narsa yo'qolmaydi.
     *
     * default: true — yangi xodim signalni oladi; eski
     * yozuvlarda maydon yo'q bo'lsa ham (undefined) kod uni
     * "yoqilgan" deb hisoblaydi.
     */
    signals: {
      order: { type: Boolean, default: true },
      reservation: { type: Boolean, default: true },
    },
  },
  { timestamps: true },
);

/*
 * Bitta Telegram akkaunt — bitta restoran (TZ 20-band).
 *
 * Busiz bir xodim ikki restoranga ulanib, Lorus buyurtmasini
 * Humo nomidan qabul qilishi mumkin bo'lardi. Indeks buni
 * baza darajasida to'sadi.
 *
 * partialFilterExpression: hali ulanmagan yozuvlarda
 * telegramUserId null bo'ladi va ular bir-biriga xalaqit
 * bermasligi kerak.
 */
restaurantTelegramStaffSchema.index(
  { telegramUserId: 1 },
  {
    unique: true,
    partialFilterExpression: { telegramUserId: { $type: 'string' } },
  },
);

// Bir restoranda bir username ikki marta qo'shilmasin
restaurantTelegramStaffSchema.index(
  { restaurantId: 1, username: 1 },
  { unique: true },
);

export const RestaurantTelegramStaff = model(
  'RestaurantTelegramStaff',
  restaurantTelegramStaffSchema,
);
