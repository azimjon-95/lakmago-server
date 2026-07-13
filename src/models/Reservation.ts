import { Schema, model, InferSchemaType } from 'mongoose';

const reservationSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    restaurantId: { type: Schema.Types.ObjectId, ref: 'Restaurant', required: true, index: true },
    restaurantName: { type: String, required: true },
    date: { type: String, required: true }, // YYYY-MM-DD
    time: { type: String, required: true }, // HH:mm
    guests: { type: Number, required: true, min: 1 },
    name: { type: String, required: true },
    phone: { type: String, required: true },
    note: { type: String },
    status: {
      type: String,
      enum: ['pending', 'confirmed', 'rejected', 'cancelled'],
      default: 'pending',
      index: true,
    },
  },
  { timestamps: true },
);

export type ReservationDoc = InferSchemaType<typeof reservationSchema>;
export const Reservation = model('Reservation', reservationSchema);
