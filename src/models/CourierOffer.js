import { Schema, model } from 'mongoose';

/**
 * «Bu kuryerga bu taklif necha marta yuborildi». (assignmentId, courierId) unikal → ikki server nusxasi yoki ikki tick bir kuryerga
 * bir taklifni qayta-qayta yubormaydi (atomik egallash: upsert + E11000 = «allaqachon band»). 2 kundan keyin o'zi o'chadi.
 */
const courierOfferSchema = new Schema({
  assignmentId: { type: Schema.Types.ObjectId, ref: 'DeliveryAssignment', required: true },
  courierId: { type: Schema.Types.ObjectId, ref: 'CourierAccount', required: true },
  attempts: { type: Number, default: 0 },
  lastSentAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now, expires: 2 * 24 * 3600 },
});
courierOfferSchema.index({ assignmentId: 1, courierId: 1 }, { unique: true });

export const CourierOffer = model('CourierOffer', courierOfferSchema);
