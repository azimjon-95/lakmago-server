import { Schema, model } from 'mongoose';

const orderItemSchema = new Schema(
  {
    dishId: { type: Schema.Types.ObjectId, ref: 'Dish', required: true },
    name: { type: String, required: true },
    quantity: { type: Number, required: true },
    unitPrice: { type: Number, required: true },
    selectedOptions: [{ name: String, price: Number }],
    note: { type: String }
  },
  { _id: false }
);

const orderSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    restaurantId: { type: Schema.Types.ObjectId, ref: 'Restaurant', required: true, index: true },
    restaurantName: { type: String, required: true },
    items: [orderItemSchema],
    subtotal: { type: Number, required: true },
    deliveryFee: { type: Number, default: 0 },
    serviceFee: { type: Number, default: 0 },
    total: { type: Number, required: true },
    status: {
      type: String,
      enum: ['accepted', 'preparing', 'delivering', 'delivered', 'cancelled'],
      default: 'accepted',
      index: true
    },
    address: { type: String, required: true },
    paymentMethod: { type: String, enum: ['payme', 'click', 'uzum', 'cash'], default: 'cash' },
    courierName: { type: String }
  },
  { timestamps: true }
);


export const Order = model('Order', orderSchema);
