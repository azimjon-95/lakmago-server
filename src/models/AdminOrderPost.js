import { Schema, model } from 'mongoose';

/**
 * Admin Telegram guruhidagi buyurtma monitoring posti.
 *
 * Bitta orderId uchun faqat bitta post (unique index).
 * Status o'zgarganda xabar edit qilinadi, yangi post yaratilmaydi.
 */
const adminOrderPostSchema = new Schema(
  {
    orderId: {
      type: Schema.Types.ObjectId,
      ref: 'Order',
      required: true,
      unique: true,
      index: true,
    },
    chatId: { type: String, required: true },
    messageId: { type: Number, required: true },
    lastStatus: { type: String, default: '' },
    lastEditedAt: { type: Date, default: null },
    /** Oxirgi marta muvaffaqiyatli yuborilgan/edit qilingan matn hash */
    lastContentHash: { type: String, default: '' },
    /** Post o'chirilgan yoki edit qilib bo'lmaydigan holat */
    orphaned: { type: Boolean, default: false },
  },
  { timestamps: true },
);

adminOrderPostSchema.index({ lastStatus: 1, updatedAt: 1 });

export const AdminOrderPost = model('AdminOrderPost', adminOrderPostSchema);