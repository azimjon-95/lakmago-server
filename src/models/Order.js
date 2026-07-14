import { Schema, model } from 'mongoose';

const orderItemSchema = new Schema(
  {
    dishId: { type: Schema.Types.ObjectId, ref: 'Dish' },
    name: { type: String, required: true },
    quantity: { type: Number, required: true },
    unitPrice: { type: Number, required: true },
    selectedOptions: [{ name: String, price: Number }],
    note: { type: String },
  },
  { _id: false },
);

const orderSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    restaurantId: { type: Schema.Types.ObjectId, ref: 'Restaurant', required: true, index: true },
    restaurantName: { type: String, required: true },

    // Bir mijoz bir vaqtda bir necha restorandan buyurtma qilsa — hammasini bitta
    // groupId bog'laydi. Mijoz ekranida bitta buyurtma, lekin har restoranга alohida hujjat.
    groupId: { type: String, index: true },

    items: [orderItemSchema],
    subtotal: { type: Number, required: true },
    deliveryFee: { type: Number, default: 0 },
    serviceFee: { type: Number, default: 0 },
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
      enum: ['pending', 'accepted', 'preparing', 'ready', 'delivering', 'delivered', 'cancelled'],
      default: 'pending',
      index: true,
    },

    address: { type: String, required: true },
    phone: { type: String },
    paymentMethod: { type: String, enum: ['payme', 'click', 'uzum', 'cash'], default: 'cash' },
    paymentLabel: { type: String },
    courierName: { type: String },
    etaMinutes: { type: Number },

    // Mijoz bahosi (yakunlangач)
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
