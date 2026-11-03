import { Schema, model } from 'mongoose';

/**
 * Kuryer — LokmaGo kuryerlari.
 *
 * 2026-08: oddiy reyestr (ism/telefon/Telegram chat ID) — havola orqali buyurtma yuborish uchun.
 * 2026-11: LokmaGo'ning O'Z kuryerlari — umumiy quti (kim ulgursa oladi), tumanlar, balans:
 *   status         — 'pending' (ro'yxatdan o'tdi, admin tasdig'ini kutadi) | 'active' | 'blocked'
 *                    (eski `isActive` saqlanadi va status bilan sinxron: faqat 'active' da true)
 *   workDistricts  — kuryer qaysi tumanlarda ishlaydi (constants/districts.js). Kuryer o'zi ilovada o'zgartira oladi
 *                    (masalan bugun Chust tumanida ishlayman), admin ham belgilay oladi.
 *   isOnline       — "Ishdaman" tugmasi: faqat onlayn kuryerga yangi buyurtma bildirishnomasi boradi.
 *   pinHash        — ilovaga kirish: telefon + PIN (scrypt, xom PIN hech qayerda saqlanmaydi).
 *   tokenVersion   — PIN almashsa / bloklansa eski tokenlar darhol bekor (middleware/courierAuth.js).
 *   debtLimitSom   — qo'lidagi naqd chegarasi (null = global Settings.courier.debtLimitSom).
 * BALANS bu yerda SAQLANMAYDI: yagona manba — Ledger (courierId bo'yicha yig'indi). Kesh yo'q → nomuvofiqlik ham yo'q.
 */
const courierSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    phone: { type: String, default: '' },
    // Telefonning normal kaliti (oxirgi 9 raqam) — kirish va takrorni tekshirish shu bo'yicha (normalizePhone)
    phoneKey: { type: String, default: '', index: true },
    // Telegram orqali havola yuborish (2026-08 oqimi). Ilova kuryerida bo'lmasligi mumkin.
    telegramChatId: { type: String, default: '', index: true },
    telegramUsername: { type: String, default: '' },

    isActive: { type: Boolean, default: true },
    status: { type: String, enum: ['pending', 'active', 'blocked'], default: 'active', index: true },
    blockedReason: { type: String, default: '' },

    workDistricts: { type: [String], default: [] },
    isOnline: { type: Boolean, default: false },
    onlineAt: { type: Date, default: null },
    vehicle: { type: String, enum: ['foot', 'bike', 'moto', 'car', ''], default: '' },

    pinHash: { type: String, default: '', select: false },
    tokenVersion: { type: Number, default: 0 },
    lastLoginAt: { type: Date, default: null },

    debtLimitSom: { type: Number, default: null, min: 0 },

    // Statistika — kelajakda reyting/hisobot uchun
    totalDeliveries: { type: Number, default: 0 },

    createdAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

/** Telefon — faqat raqamlar, oxirgi 9 tasi (+998 bilan ham, usiz ham bir xil kalit). */
export function normalizePhone(p) {
  const d = String(p || '').replace(/\D/g, '');
  return d.length >= 9 ? d.slice(-9) : d;
}

export const Courier = model('Courier', courierSchema);
