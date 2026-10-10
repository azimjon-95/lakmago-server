import { Schema, model } from 'mongoose';

/*
 * ═══ MUAMMOLI MIJOZ HODISASI ═══
 *
 * Restoran qabul qilgan (naqd: telefonda tasdiqlangan, taom tayyorlangan)
 * buyurtmani mijoz keyin rad etdi → restoran "Mijoz rad etdi" so'rovini
 * yuboradi → LokmaGo admini hal qiladi (bekor qilish / rad etish) va
 * xohlasa mijozning NAQD to'lovini o'chiradi va/yoki BLOKLAYDI.
 *
 * `snapshot` — hodisa paytidagi mijoz ma'lumoti NUSXASI (ism, telefon,
 * Telegram, rasm, manzillar): mijoz keyin profilini o'zgartirsa yoki
 * o'chirsa ham yozuv saqlanib qoladi.
 */
const incidentSchema = new Schema(
  {
    type: { type: String, enum: ['refused_after_accept'], default: 'refused_after_accept' },
    status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending', index: true },
    /*
     * approval — bekor qilish admin tasdig'ini kutadi (CANCEL_APPROVAL_REQUIRED=true);
     * post     — restoran darhol bekor qildi, admin KEYIN ko'rib chiqadi (standart, TZ).
     *   post rejimida: approved = "mijoz aybdor deb topildi", rejected = "asossiz".
     */
    mode: { type: String, enum: ['approval', 'post'], default: 'approval' },

    orderId: { type: Schema.Types.ObjectId, ref: 'Order', required: true, index: true },
    orderLabel: { type: String, default: '' },
    orderStatusAtRequest: { type: String, default: '' },
    restaurantId: { type: Schema.Types.ObjectId, ref: 'Restaurant', required: true, index: true },
    restaurantName: { type: String, default: '' },
    userId: { type: Schema.Types.ObjectId, ref: 'User', index: true },

    reasonCode: { type: String, default: 'other' },
    reason: { type: String, default: '' },
    note: { type: String, default: '' },
    requestedBy: { type: String, default: '' },

    order: {
      items: [{ _id: false, name: String, qty: Number, price: Number }],
      total: { type: Number, default: 0 },
      paymentMethod: { type: String, default: '' },
      isPaid: { type: Boolean, default: false },
      address: { type: String, default: '' },
      phone: { type: String, default: '' },
      fulfillment: { type: String, default: '' },
      createdAt: { type: Date },
      acceptedAt: { type: Date },
    },

    snapshot: {
      firstName: String,
      lastName: String,
      username: String,
      telegramId: String,
      phone: String,
      photoUrl: String,
      photoFileId: String, // Telegram profil rasmi (bot orqali qayta olish mumkin)
      addresses: [{ _id: false, title: String, address: String, city: String, lat: Number, lng: Number }],
      createdAt: Date,
      ordersCount: Number,
      previousIncidents: Number,
    },

    decision: {
      by: { type: String, default: '' },
      at: { type: Date },
      note: { type: String, default: '' },
      cashDisabled: { type: Boolean, default: false },
      blocked: { type: Boolean, default: false },
      customerMessage: { type: String, default: '' },
    },

    groupPost: { chatId: String, messageId: Number },
  },
  { timestamps: true },
);
incidentSchema.index({ status: 1, createdAt: -1 });
incidentSchema.index({ orderId: 1, status: 1 });

export const CustomerIncident = model('CustomerIncident', incidentSchema);
