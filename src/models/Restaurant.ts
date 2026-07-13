import { Schema, model, InferSchemaType } from 'mongoose';

const restaurantSchema = new Schema(
  {
    name: { type: String, required: true },
    cuisine: { type: String, required: true },
    rating: { type: Number, default: 0 },
    reviewCount: { type: Number, default: 0 },
    deliveryMin: { type: Number, required: true },
    deliveryMax: { type: Number, required: true },
    deliveryFee: { type: Number, default: 0 },
    category: {
      type: String,
      enum: ['milliy', 'fastfood', 'sushi', 'kafe', 'shirinlik'],
      required: true,
    },
    tint: { type: String, default: '#FAEEDA' },
    icon: { type: String, default: 'ti-tools-kitchen-2' },
    discount: { type: Number },
    isNew: { type: Boolean, default: false },
    isApproved: { type: Boolean, default: false }, // admin tasdiqlashi kerak
    ownerId: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

export type RestaurantDoc = InferSchemaType<typeof restaurantSchema>;
export const Restaurant = model('Restaurant', restaurantSchema);
