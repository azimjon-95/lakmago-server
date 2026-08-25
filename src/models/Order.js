import { Schema, model } from 'mongoose';

const orderItemSchema = new Schema(
  {
    dishId: { type: Schema.Types.ObjectId, ref: 'Dish' },
    name: { type: String, required: true },
    quantity: { type: Number, required: true },
    unitPrice: { type: Number, required: true },
    selectedOptions: [{ name: String, price: Number }],

    // Taomga izoh: "avokadosiz", "achchiq qilmang"
    note: { type: String },

    /*
     * KURS (podacha) — taom qaysi navbatda kelishi.
     *
     * 1 = darhol, 2 = keyingi, 3 = keyinroq...
     * Oshxonaga BARCHA kurslar ko'rinadi (ular nima kelishini
     * oldindan bilishi kerak), lekin faqat "otilgan" kurs
     * tayyorlanadi — qolganlari "keyinroq tayyorlash" deb
     * turadi. Mijoz tayyor bo'lganda ofitsiant keyingi kursni
     * otadi.
     *
     * _id: false bo'lgani uchun elementlar indeks bo'yicha
     * ajratiladi — kurs shu yerda, elementning o'zida turadi.
     */
    course: { type: Number, default: 1, min: 1, max: 9 },

    /*
     * OLIB KETISH — shu TAOM uchun, butun buyurtma uchun emas.
     *
     * Sabab: bir mijoz bitta taomni shu yerda yeydi,
     * ikkinchisini olib ketadi. Buyurtma darajasidagi bayroq
     * bu holatni ifodalay olmaydi.
     */
    takeaway: { type: Boolean, default: false },
  },
  { _id: false },
);

const orderSchema = new Schema(
  {
    // Zal (dine-in) buyurtmasida mijoz login qilmaydi: QR skanerlagan
    // mehmon ham, ofitsiant kiritgan buyurtma ham userId'siz keladi.
    // Shuning uchun majburiylik faqat yetkazish/olib ketishga tegishli.
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: function () { return this.fulfillment !== 'dinein'; },
      index: true,
    },
    restaurantId: { type: Schema.Types.ObjectId, ref: 'Restaurant', required: true, index: true },
    restaurantName: { type: String, required: true },

    // Bir mijoz bir vaqtda bir necha restorandan buyurtma qilsa — hammasini bitta
    // groupId bog'laydi. Mijoz ekranida bitta buyurtma, lekin har restoranга alohida hujjat.
    groupId: { type: String, index: true },

    items: [orderItemSchema],
    subtotal: { type: Number, required: true },
    deliveryFee: { type: Number, default: 0 },
    serviceFee: { type: Number, default: 0 },
    bonusUsed: { type: Number, default: 0 }, // shu buyurtмада ishlatilган bonus (so'm)

    /*
     * OTILGAN KURSLAR — oshxonada tayyorlanishi boshlangan.
     *
     * Buyurtma yaratilganda faqat [1] bo'ladi. Ofitsiant
     * "2-kursni yuborish" bosganda 2 qo'shiladi va oshxonaga
     * "2-podachani tayyorlashni boshlang" signali ketadi.
     *
     * Nega alohida maydon, nega elementga 'fired' bayrog'i emas:
     * kurs — TAOMLAR GURUHI. Guruhni bir butun sifatida otish
     * kerak, aks holda bitta kursning yarmi tayyorlanib,
     * yarmi kutib qolishi mumkin.
     */
    firedCourses: { type: [Number], default: [1] },

    // Qo'llanilgan aksiya
    promotionId: { type: Schema.Types.ObjectId, ref: 'Promotion', default: null },
    promotionName: { type: String, default: '' },
    promotionDiscount: { type: Number, default: 0 },

    /*
     * OLIB KETISH CHEGIRMASI.
     *
     * Restoran o'zi olib ketuvchilarga foiz beradi (kuryer
     * xarajati yo'q, shuning uchun mijozga ham arzonroq).
     * Aksiyadan alohida saqlanadi — ular boshqa sabab bilan
     * beriladi va hisobotda ajratilishi kerak.
     */
    pickupDiscount: { type: Number, default: 0 },
    pickupDiscountPercent: { type: Number, default: 0 },

    // Reklama orqali kelganmi
    adCampaignId: { type: Schema.Types.ObjectId, ref: 'AdCampaign', default: null },
    total: { type: Number, required: true },

    // Status oqimi:
    // pending    → yangi, restoran hali ko'rmagan (signal chalinadi)
    // accepted   → restoran qabul qildi ("Qabul qildim")
    // preparing  → tayyorlanmoqda
    // ready      → tayyor bo'ldi
    // delivering → kuryer olib ketdi ("Kuryer oldi")
    // delivered  → mijoz qabul qildi
    // cancelled  → bekor qilindi
    status: {
      type: String,
      enum: [
        // Karta to'lovi: pul kelgunga qadar restoranga ko'rinmaydi
        'awaiting_payment',
        'pending', 'accepted', 'preparing', 'ready',
        'delivering', 'delivered', 'cancelled',
      ],
      default: 'pending',
      index: true,
    },

    // ===== YETKAZISH TURI =====
    // 'delivery' — kuryer yetkazadi, 'pickup' — mijoz o'zi olib ketadi
    fulfillment: { type: String, enum: ['delivery', 'pickup', 'dinein'], default: 'delivery', index: true },

    // ===== DINE-IN =====
    // Buyurtma manbai: QR (mijoz o'zi) yoki WAITER (ofitsiant)
    orderSource: { type: String, enum: ['qr', 'waiter', null], default: null, index: true },

    tableId: { type: Schema.Types.ObjectId, ref: 'Table', default: null, index: true },
    dineInSessionId: { type: Schema.Types.ObjectId, ref: 'DineInSession', default: null, index: true },
    deviceSessionId: { type: String, default: '' },

    waiterId: { type: Schema.Types.ObjectId, ref: 'Waiter', default: null, index: true },
    waiterName: { type: String, default: '' },

    // Zal buyurtmasi raqami — #A-124
    dineInNumber: { type: String, default: '' },

    // Manzil — yetkazishda majburiy, olib ketishda bo'sh bo'lishi mumkin
    address: { type: String, default: '' },
    // Yetkazish nuqtasi — kuryer xaritada ko'radi
    addressLat: { type: Number, default: null },
    addressLng: { type: Number, default: null },
    // Manzil tafsiloti (podez, qavat, xonadon)
    addressNote: { type: String, default: '' },
    // Restorandan manzilgacha masofa (km)
    distanceKm: { type: Number, default: null },

    // ===== VAQT REJALASHTIRISH =====
    // 'asap' — tayyor bo'lishi bilan (standart), 'scheduled' — belgilangan vaqtga
    timingMode: { type: String, enum: ['asap', 'scheduled'], default: 'asap' },
    // Mijoz tanlagan vaqt (scheduled bo'lsa) — yetkazish yoki olib ketish vaqti
    scheduledFor: { type: Date, default: null, index: true },
    phone: { type: String },
    // ===== AUDIT =====
    // Kim yaratdi va kim oxirgi o'zgartirdi.
    // Buyurtma O'CHIRILMAYDI — faqat bekor qilinadi.
    createdBy: { type: Schema.Types.ObjectId, default: null },
    createdByRole: { type: String, enum: ['user', 'waiter', 'restaurant', 'admin', 'system', null], default: null },
    updatedBy: { type: Schema.Types.ObjectId, default: null },
    updatedByRole: { type: String, default: '' },

    // Bekor qilish
    cancelledAt: { type: Date, default: null },
    cancelReason: { type: String, default: '' },

    // Qaysi karta bilan to'landi (oxirgi 4 raqam va turi)
    cardLast4: { type: String, default: '' },
    cardBrand: { type: String, default: '' },

    // To'lov holati: naqd — yetkazilganda, karta — oldindan
    /*
     * TO'LOV QULFI — bir vaqtda ikki marta pul yechilmasin.
     *
     *   'paying'  — so'rov Click'ga ketgan, javob kutilmoqda
     *   'unknown' — tarmoq uzildi, pul yechilgan bo'lishi mumkin;
     *               qulf ATAYLAB ochilmaydi, avval holat
     *               tekshirilishi kerak
     *   null      — qulf yo'q
     */
    paymentLock: { type: String, default: null },
    paymentLockAt: { type: Date, default: null },

    isPaid: { type: Boolean, default: false },
    paidAt: { type: Date, default: null },

    paymentMethod: { type: String, enum: ['payme', 'click', 'uzum', 'cash'], default: 'cash' },
    paymentLabel: { type: String },
    courierName: { type: String },
    etaMinutes: { type: Number },

    // Mijoz bahosi (yakunlangач)
    // ===== YETKAZISHNI TASDIQLASH (bot orqali) =====
    // Kuryer olib ketgach bot so'raydi: 20 daq → 10 daq → 30 daq
    deliveryCheck: {
      // Nechta so'rov yuborilgan (0-3)
      askedCount: { type: Number, default: 0 },
      // Oxirgi so'rov vaqti — keyingisini shundan hisoblaymiz
      lastAskedAt: { type: Date, default: null },
      // Mijoz tasdiqladimi
      confirmed: { type: Boolean, default: false },
      confirmedAt: { type: Date, default: null },
      // Sharh so'ralganmi (takror so'ramaslik uchun)
      reviewAsked: { type: Boolean, default: false },
      // Yulduz tanlangan, matn kutilmoqda
      pendingRating: { type: Number, default: null },
    },

    rating: { type: Number, min: 1, max: 5 },
    comment: { type: String },
    ratedAt: { type: Date },

    // Vaqt belgilari (jarayon nazorati uchun)
    acceptedAt: { type: Date },
    readyAt: { type: Date },
    deliveredAt: { type: Date },
  },
  { timestamps: true },
);

export const Order = model('Order', orderSchema);
