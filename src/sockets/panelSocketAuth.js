import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';
import { User } from '../models/User.js';
import { StaffUser } from '../models/StaffUser.js';
import { CourierAccount } from '../models/CourierAccount.js';
import { restaurantRoomFromToken } from './restaurantSocketAuth.js';

/*
 * ═══ SOKET XONALARIGA KIRISH HUQUQI (XAVFSIZLIK TUZATISHI, 2026-11) ═══
 *
 * AVVAL: `join:admin` va `join:restaurant` HECH QANDAY tekshiruvsiz qo'shardi — istalgan odam brauzer konsolidan
 * `socket.emit('join:admin')` yozib BARCHA buyurtmalar yangilanishini (mijoz telefoni/manzili bilan) eshita olardi,
 * `join:restaurant` ga istalgan ID berib — boshqa restoranning buyurtmalarini.
 *
 * ENDI token talab qilinadi (handshake `auth.token` yoki hodisa argumentida { token }), bazadan qayta tekshiriladi:
 *   admin xonasi       — role 'admin' (User faol) yoki 'staff' (StaffUser faol)
 *   restoran xonasi    — o'sha restoranning foydalanuvchisi (restaurantSocketAuth) yoki admin/xodim
 *   kuryer xonalari    — LokmaGo kuryeri (faol, tokenVersion mos): `courier:<id>` + har ish tumani `courier-district:<tuman>`
 * Bog'liqliklar argument bilan almashtiriladi — testda bazasiz sinaladi (tests/socket-auth.test.mjs).
 */
const defaults = {
  verify: (t) => jwt.verify(t, config.jwtSecret),
  findUser: (id) => User.findById(id).select('role isActive').lean(),
  findStaff: (id) => StaffUser.findById(id).select('isActive department').lean(),
  verifyCourier: (t) => jwt.verify(t, config.courierJwtSecret),          // kuryer tokeni BOSHQA kalit bilan imzolanadi
  findCourier: (id) => CourierAccount.findById(id).select('isActive tokenVersion workDistricts').lean(),
};

function payloadOf(token, verify) {
  if (typeof token !== 'string' || !token) return null;
  try { return verify(token); } catch { return null; }
}

export async function canJoinAdmin(token, deps = {}) {
  const d = { ...defaults, ...deps };
  const p = payloadOf(token, d.verify);
  if (!p?.userId) return false;
  if (p.role === 'admin') {
    const u = await d.findUser(p.userId).catch(() => null);
    return Boolean(u && u.isActive !== false && u.role === 'admin');
  }
  if (p.role === 'staff') {
    const s = await d.findStaff(p.userId).catch(() => null);
    return Boolean(s && s.isActive !== false);
  }
  return false;
}

export async function canJoinRestaurant(token, restaurantId, deps = {}) {
  if (!restaurantId) return false;
  const d = { ...defaults, ...deps };
  if (await canJoinAdmin(token, d)) return true;                       // admin paneli restoran sahifasini ko'radi
  // restaurantRoomFromToken o'z foydalanuvchi so'rovidan foydalanadi (role isActive restaurantId) — testda findRestaurantUser beriladi
  const room = await restaurantRoomFromToken(token, { verify: d.verify, ...(deps.findRestaurantUser ? { findUser: deps.findRestaurantUser } : {}) }).catch(() => null);
  return room === `restaurant:${restaurantId}`;
}

/** Kuryer tokeni (courierAuth bilan bir xil qoidalar) → qo'shiladigan xonalar ro'yxati (yaroqsiz/bloklangan bo'lsa bo'sh). */
export async function courierRoomsFromToken(token, deps = {}) {
  const d = { ...defaults, ...deps };
  const p = payloadOf(token, d.verifyCourier);
  const cid = p?.cid;
  if (p?.role !== 'courier' || !cid) return [];
  const c = await d.findCourier(cid).catch(() => null);
  if (!c || !c.isActive || Number(c.tokenVersion || 0) !== Number(p.v || 0)) return [];
  return [`courier:${cid}`, ...(c.workDistricts || []).map((x) => `courier-district:${x}`)];
}
