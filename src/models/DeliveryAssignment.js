import { Schema, model } from 'mongoose';
import crypto from 'crypto';

/**
 * ME'MORIY QAROR — IKKI BOSQICHLI YONDASHUV.
 *
 * BOSQICH 1 (HOZIR, 2026-08): LokmaGo'da hali ro'yxatdan o'tgan
 * ishchi kuryerlar yo'q. Shuning uchun restoran/admin har
 * buyurtma uchun BITTA ulashiladigan havola oladi va uni O'ZINING
 * shaxsiy Telegram/WhatsApp akkaunti orqali xohlagan odam(lar)ga
 * yuboradi (bir nechtasiga forward qilishi ham mumkin — birinchi
 * "Qabul qilaman" bosgan yutadi). Bu model shu bosqich uchun
 * `token` + `acceptanceSecret` maydonlariga ega (pastda).
 *
 * BOSQICH 2 (KEYINGI VERSIYA): kuryerlar kuryer.lokma.uz'da
 * o'zlari ro'yxatdan o'tadi, LokmaGo admin ma'lumotlarini
 * tekshirib ruxsat beradi, keyin login/parol bilan kiradi. O'sha
 * paytda `assignedCourierId` (pastda, hozir ham bor, lekin
 * hozircha bo'sh qoladi) haqiqiy foydalanishga kiradi, va
 * `models/Courier.js` + `CourierInvite` (shu faylning davomida)
 * to'liq ishga tushadi.
 *
 * "Birinchi qabul qilgan oladi" mantig'i — atomik yozuv,
 * services/courierDispatch.js dagi acceptShare()ga qarang.
 */

const deliveryAssignmentSchema = new Schema(
  {
    orderId: { type: Schema.Types.ObjectId, ref: 'Order', required: true, index: true },
    restaurantId: { type: Schema.Types.ObjectId, ref: 'Restaurant', required: true },

    status: {
      type: String,
      enum: [
        'searching',   // takliflar yuborilgan, hech kim qabul qilmagan
        'assigned',    // bitta kuryer qabul qildi
        'delivered',   // kuryer "topshirdim" bosdi
        'expired',     // hech kim qabul qilmadi (kelajakda muddat tugashi uchun)
      ],
      default: 'searching',
      index: true,
    },

    assignedCourierId: { type: Schema.Types.ObjectId, ref: 'Courier', default: null },
    assignedAt: { type: Date, default: null },
    deliveredAt: { type: Date, default: null },

    /*
     * ULASHISH ORQALI YUBORISH (2026-08, hozirgi bosqich).
     *
     * Hozircha LokmaGo'da ro'yxatdan o'tgan ishchi kuryerlar
     * yo'q — shuning uchun restoran/admin BITTA havolani o'zi
     * xohlagan odam(lar)ga o'zining shaxsiy Telegram/WhatsApp
     * akkaunti orqali ULASHADI (pastdagi `token`). Bir nechta
     * odamga bir xil havola forward qilinishi mumkin — birinchi
     * "Qabul qilaman" bosgan yutadi.
     *
     * `token` — havoladagi ochiq qism (hammada bir xil bo'lishi
     * mumkin, chunki bir nechta odamga forward qilinadi).
     * `acceptanceSecret` — FAQAT qabul qilgan qurilmaga qaytariladi
     * (server javobida, URL'da EMAS). Shu qurilma keyingi
     * so'rovlarida shu maxfiy qiymatni yuboradi — shu orqali
     * server "bu haqiqatan o'sha qurilmami" deb tekshiradi,
     * login/akkaunt shart bo'lmasdan. Kelajakda haqiqiy kuryer
     * akkauntlari (ro'yxatdan o'tish + login) qo'shilganda bu
     * mexanizm kerak bo'lmay qoladi.
     */
    token: { type: String, required: true, unique: true, index: true },
    acceptanceSecret: { type: String, default: null },

    // Mijoz manzili — kuryer sahifasida xarita/koordinata uchun
    // (Order'dan nusxa — kuryer sahifasi Order'ga to'g'ridan-to'g'ri
    // kira olmasligi kerak, faqat shu yerga ko'chirilgan xavfsiz
    // qism)
    /*
     * NUSXA — buyurtma keyin o'zgarsa ham kuryer ko'rgan
     * ma'lumot o'zgarmasin. Shuning uchun ref emas, qiymat.
     */
    deliverySnapshot: {
      // Mijoz
      addressLabel: String,
      lat: Number,
      lng: Number,
      addressNote: String,
      customerPhone: String,
      customerName: String,
      customerUsername: String,      // Telegram @nomi
      customerTelegramId: String,

      // Restoran
      restaurantName: String,
      restaurantAddress: String,
      restaurantLat: Number,
      restaurantLng: Number,
      restaurantPhone: String,

      // Buyurtma
      items: [{ name: String, quantity: Number, total: Number }],
      itemsSummary: String,          // "2x Lag'moni, 1x Osh"
      subtotal: Number,
      deliveryFee: Number,
      total: Number,
      orderCode: String,
      note: String,

      /*
       * Pul yig'ish — kuryerning eng muhim savoli.
       * collectAmount: mijozdan olinadigan summa (to'langan
       * bo'lsa 0). Kuryer hisoblab o'tirmasin.
       */
      paymentMethod: String,
      isPaid: Boolean,
      collectAmount: Number,
    },
  },
  { timestamps: true },
);

export const DeliveryAssignment = model('DeliveryAssignment', deliveryAssignmentSchema);

/**
 * Har kuryerga alohida taklif — token shu yerda.
 */
const courierInviteSchema = new Schema(
  {
    assignmentId: { type: Schema.Types.ObjectId, ref: 'DeliveryAssignment', required: true, index: true },
    courierId: { type: Schema.Types.ObjectId, ref: 'Courier', required: true },

    token: { type: String, required: true, unique: true, index: true },

    /*
     * Bu YOZUVNING o'zining holati (assignment darajasidagi
     * status'dan FARQLI): shu KURYER ushbu taklifga qanday
     * javob berdi.
     */
    status: {
      type: String,
      enum: [
        'pending',    // hali ochilmagan yoki ochilgan, javob kutilmoqda
        'accepted',   // shu kuryer qabul qildi (assignment ham 'assigned' bo'ladi)
        'lost',       // boshqa kuryer birinchi bo'lib oldi
      ],
      default: 'pending',
    },

    sentAt: { type: Date, default: Date.now },
    respondedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

export const CourierInvite = model('CourierInvite', courierInviteSchema);

/** Xavfsiz, taxmin qilib bo'lmaydigan token — URL uchun. */
export function generateInviteToken() {
  return crypto.randomBytes(24).toString('base64url');   // ~32 belgi, URL-xavfsiz
}
