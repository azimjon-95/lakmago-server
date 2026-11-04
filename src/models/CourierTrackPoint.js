import { Schema, model } from 'mongoose';
import { config } from '../config/index.js';

/*
 * KURYER YO'LI (breadcrumb): smena davomida har ~5 s da kelgan joylashuv nuqtalari — "kuryer qayerdan o'tdi" tarixi.
 * Redis faqat OXIRGI nuqtani saqlaydi (jonli xarita); bu yerda tarix: nazorat, nizo (kuryer buyurtmani olib keldimi?), masofa.
 * Hajm: harakatsiz turganda siyrak (har 60 s), harakatda har nuqta. TTL — 45 kun (config.courierTrackTtlDays).
 * `orderId` — nuqta olingan paytda kuryerda faol buyurtma bo'lsa (buyurtma yo'li shundan tiklanadi).
 */
const schema = new Schema({
  courierId: { type: Schema.Types.ObjectId, ref: 'CourierAccount', required: true },
  shiftId: { type: Schema.Types.ObjectId, ref: 'CourierShift', default: null },
  orderId: { type: Schema.Types.ObjectId, ref: 'Order', default: null },
  lat: { type: Number, required: true },
  lng: { type: Number, required: true },
  acc: { type: Number },
  spd: { type: Number },
  at: { type: Date, required: true },            // SERVER vaqti (telefon soatiga ishonilmaydi)
});
schema.index({ courierId: 1, at: -1 });
schema.index({ orderId: 1, at: 1 }, { sparse: true });
schema.index({ at: 1 }, { expireAfterSeconds: Math.max(1, config.courierTrackTtlDays) * 24 * 3600 });

export const CourierTrackPoint = model('CourierTrackPoint', schema);
