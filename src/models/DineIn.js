import { Schema, model } from 'mongoose';
import crypto from 'node:crypto';

/**
 * Dine-in moduli.
 *
 * Restaurant o'zi filial vazifasini bajaradi — alohida Branch
 * modeli yaratilmadi, mavjud arxitektura saqlandi.
 */

// ═══ 1. Aktivatsiya ═══
const dineInConfigSchema = new Schema(
  {
    restaurantId: {
      type: Schema.Types.ObjectId, ref: 'Restaurant',
      required: true, unique: true, index: true,
    },

    // Pending → Approved → PaymentRequired → Active / Suspended
    status: {
      type: String,
      enum: ['pending', 'approved', 'payment_required', 'active', 'suspended'],
      default: 'pending',
      index: true,
    },

    requestedAt: { type: Date, default: Date.now },
    approvedAt: { type: Date, default: null },
    activatedAt: { type: Date, default: null },

    suspendedAt: { type: Date, default: null },
    suspendReason: { type: String, default: '' },

    // ===== XIZMAT HAQI =====
    // Faqat ofitsiant orqali berilgan buyurtmalarga qo'llanadi.
    // QR buyurtmasiga qo'llanmaydi — mijoz o'zi buyurtma bergan.
    serviceFeeEnabled: { type: Boolean, default: false },
    serviceFeeType: { type: String, enum: ['percentage', 'fixed'], default: 'percentage' },
    serviceFeeValue: { type: Number, default: 10 },

    // Global stop list ishlatilsinmi
    useGlobalStopList: { type: Boolean, default: true },

    // QR dizayni — barcha stollarga umumiy
    qrTheme: {
      backgroundColor: { type: String, default: '#1C1815' },
      backgroundImage: { type: String, default: '' },
      textColor: { type: String, default: '#F7F2EA' },
      accentColor: { type: String, default: '#F5A524' },
      logoUrl: { type: String, default: '' },
      headline: { type: String, default: '' },      // "Menyuni oching"
      footnote: { type: String, default: '' },      // "Skanerlang"
    },
  },
  { timestamps: true },
);

/** Dine-in ishlayaptimi — QR va buyurtma uchun. */
dineInConfigSchema.methods.isOperational = function () {
  return this.status === 'active';
};

export const DineInConfig = model('DineInConfig', dineInConfigSchema);

// ═══ 2. Stollar ═══
const tableSchema = new Schema(
  {
    restaurantId: {
      type: Schema.Types.ObjectId, ref: 'Restaurant',
      required: true, index: true,
    },
    // Filial — hozircha restaurantId bilan bir xil, kelajakda
    // alohida filiallar qo'shilsa ishlatiladi
    branchId: { type: Schema.Types.ObjectId, ref: 'Restaurant', index: true },

    tableName: { type: String, default: '' },       // "Deraza yonida"
    tableNumber: { type: String, required: true },  // "12", "A3"
    capacity: { type: Number, default: 4, min: 1, max: 50 },

    status: {
      type: String,
      enum: ['available', 'occupied', 'ordering', 'waiting', 'closed'],
      default: 'available',
      index: true,
    },

    // Xavfsiz tasodifiy token — URL'da ko'rinadi
    qrToken: { type: String, required: true, unique: true, index: true },

    isActive: { type: Boolean, default: true },

    // Statistika
    totalSessions: { type: Number, default: 0 },
    lastSessionAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// Bir restoranda stol raqami takrorlanmasin
tableSchema.index({ restaurantId: 1, tableNumber: 1 }, { unique: true });

/** Taxmin qilib bo'lmaydigan token. */
export function generateQrToken() {
  // 32 belgi, base64url — URL uchun xavfsiz
  return crypto.randomBytes(24).toString('base64url');
}

export const Table = model('Table', tableSchema);

// ═══ 3. Sessiya ═══
const dineInSessionSchema = new Schema(
  {
    restaurantId: { type: Schema.Types.ObjectId, ref: 'Restaurant', required: true, index: true },
    branchId: { type: Schema.Types.ObjectId, ref: 'Restaurant', index: true },
    tableId: { type: Schema.Types.ObjectId, ref: 'Table', required: true, index: true },

    /**
     * Qurilma identifikatori.
     *
     * MUHIM: IMEI, seriya raqami yoki boshqa qurilma
     * identifikatori OLINMAYDI. Bu faqat brauzerda yaratiladigan
     * tasodifiy qiymat — sessiyani tanish uchun.
     */
    deviceSessionId: { type: String, required: true, index: true },

    status: {
      type: String,
      enum: ['active', 'closing', 'closed'],
      default: 'active',
      index: true,
    },

    // Sessiya davomida qilingan buyurtmalar
    orderIds: [{ type: Schema.Types.ObjectId, ref: 'Order' }],

    closedAt: { type: Date, default: null },
    closeReason: { type: String, default: '' },
  },
  { timestamps: true },
);

// Bitta stolda bitta faol sessiya
dineInSessionSchema.index(
  { tableId: 1, status: 1 },
  { partialFilterExpression: { status: 'active' } },
);

export const DineInSession = model('DineInSession', dineInSessionSchema);
