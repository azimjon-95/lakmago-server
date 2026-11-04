import { Schema, model } from 'mongoose';

/*
 * BUYURTMA BO'YICHA KURYER VOQEALARI (audit jurnali) — "taomni oldimi, topshirdimi" to'liq nazorat.
 * Har voqeada kuryerning o'sha paytdagi joylashuvi (server oxirgi nuqtasi) va maqsadgacha masofa saqlanadi:
 *   claimed / released — quti, picked_up — restorandan oldi (maqsad: restoran), delivered — mijozga topshirdi (maqsad: mijoz manzili),
 *   admin_assigned / admin_released — admin aralashuvi.
 * `flagged` — masofa chegaradan katta yoki joylashuv eskirgan/yo'q: BLOKLANMAYDI (GPS xato berishi mumkin), lekin adminga ko'rinadi.
 */
const schema = new Schema({
  orderId: { type: Schema.Types.ObjectId, ref: 'Order', required: true, index: true },
  courierId: { type: Schema.Types.ObjectId, ref: 'CourierAccount', default: null, index: true },
  restaurantId: { type: Schema.Types.ObjectId, ref: 'Restaurant', default: null },
  type: { type: String, enum: ['claimed', 'released', 'picked_up', 'delivered', 'admin_assigned', 'admin_released'], required: true },
  at: { type: Date, default: Date.now },
  lat: Number,
  lng: Number,
  accuracy: Number,
  locAgeSec: Number,                              // oxirgi nuqta necha soniya oldin kelgan (null = umuman yo'q)
  targetDistanceM: Number,                        // maqsadgacha masofa (m)
  flagged: { type: Boolean, default: false, index: true },
  flagReason: { type: String, default: '' },      // 'no_location' | 'stale_location' | 'far_from_restaurant' | 'far_from_customer'
  by: { type: String, default: '' },              // admin ID (admin_* voqealar)
});
schema.index({ orderId: 1, at: 1 });

export const CourierEvent = model('CourierEvent', schema);
