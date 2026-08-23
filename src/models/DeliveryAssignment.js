import { Schema, model } from 'mongoose';
import crypto from 'crypto';

/**
 * ME'MORIY QAROR — nega HAR KURYERGA ALOHIDA TOKEN.
 *
 * Bitta buyurtma 5 ta kuryerga yuborilganda, hammasiga BITTA
 * umumiy havola (bitta token) YUBORILMAYDI. Buning o'rniga har
 * bir kuryer o'zining SHAXSIY tokeniga ega (bir xil buyurtmaga
 * ishora qiladi).
 *
 * NEGA MUHIM: kuryer o'z Telegram xabaridagi havolani QAYTA
 * ochsa (boshqa qurilma, boshqa brauzer — Chrome, Yandex,
 * Windows, iOS — farqi yo'q), token O'ZINING ekanligini SERVER
 * darhol biladi, chunki token boshidanoq shu KURYERGA
 * biriktirilgan edi. Qurilma identifikatori (device fingerprint,
 * cookie, localStorage) SAQLASH SHART EMAS — bu yondashuv ancha
 * ishonchli, chunki brauzer ma'lumotlari tozalanishi, boshqa
 * qurilmadan kirilishi mumkin, lekin Telegram xabaridagi havola
 * doim o'sha kuryerniki bo'lib qoladi.
 *
 * "Birinchi qabul qilgan oladi" mantig'i esa ASSIGNMENT
 * darajasida (pastda) — barcha 5 ta taklif BITTA Assignment'ga
 * ishora qiladi, va faqat BITTASI "accepted" bo'la oladi (atomik
 * yozuv, controllers/courierPortal.js dagi acceptInvite()ga
 * qarang).
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

    // Mijoz manzili — kuryer sahifasida xarita/koordinata uchun
    // (Order'dan nusxa — kuryer sahifasi Order'ga to'g'ridan-to'g'ri
    // kira olmasligi kerak, faqat shu yerga ko'chirilgan xavfsiz
    // qism)
    deliverySnapshot: {
      addressLabel: String,
      lat: Number,
      lng: Number,
      addressNote: String,
      customerPhone: String,
      restaurantName: String,
      restaurantAddress: String,
      restaurantLat: Number,
      restaurantLng: Number,
      itemsSummary: String,   // "2x Lag'moni, 1x Osh"
      total: Number,
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
