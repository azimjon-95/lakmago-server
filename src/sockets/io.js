import { Server as HttpServer } from 'http';
import { Server as SocketServer } from 'socket.io';
import { config, isAllowedOrigin } from '../config/index.js';

let io = null;

/*
 * Yordam xizmati "online" holati.
 *
 * Bitta operator (super admin) qo'llab-quvvatlash sahifasini
 * boshqaradi. "Online" degani — sahifa ochiq VA oyna faol
 * (Telegram kabi: chatni ochib, boshqa oynaga o'tsangiz "oxirgi
 * marta N daqiqa oldin" ko'rinadi).
 *
 * Xotirada saqlanadi — bazaga yozilmaydi, chunki bu vaqtinchalik
 * holat, server qayta ishga tushsa boshidan boshlanaveradi.
 */
let supportPresence = { online: false, lastSeenAt: null, socketId: null };

function broadcastPresence() {
  io?.emit('support:presence', {
    online: supportPresence.online,
    lastSeenAt: supportPresence.lastSeenAt,
  });
}

export function initSocket(httpServer) {
  io = new SocketServer(httpServer, {
    // Bir nechta frontend (client/admin/Vercel) — moslashuvchan CORS
    cors: {
      origin: (origin, cb) => cb(null, isAllowedOrigin(origin)),
      methods: ['GET', 'POST'],
      credentials: true,
    },
  });

  io.on('connection', (socket) => {

    // Mijoz o'z buyurtmasini kuzatish uchun xonaga qo'shiladi
    socket.on('track:order', (orderId) => {
      socket.join(`order:${orderId}`);
    });

    // Restoran o'z buyurtmalarini eshitish uchun
    socket.on('join:restaurant', (restaurantId) => {
      socket.join(`restaurant:${restaurantId}`);
    });

    // Admin barcha buyurtmalarni live eshitadi
    // Dine-in sessiyasi — mijoz buyurtma holatini kuzatadi
    socket.on('join:session', (sessionId) => {
      if (sessionId) socket.join(`session:${sessionId}`);
    });

    socket.on('join:admin', () => {
      socket.join('admin');
    });

    /*
     * Qo'llab-quvvatlash sahifasi ochiq va oyna faol ekanini
     * bildiradi. Admin panel bu hodisani: (1) sahifa ochilganda,
     * agar oyna faol bo'lsa, (2) oyna qayta faollashganda
     * (foydalanuvchi boshqa oynadan qaytganda) yuboradi.
     */
    socket.on('support:presence:online', () => {
      supportPresence = { online: true, lastSeenAt: null, socketId: socket.id };
      broadcastPresence();
    });

    /*
     * Oyna fonga o'tganda yoki sahifadan chiqilganda. Faqat
     * HOZIRGI online holatni ushbu socket o'rnatgan bo'lsa
     * o'chiramiz — aks holda ikkinchi oyna/qurilma noto'g'ri
     * offline qilib qo'yishi mumkin.
     */
    socket.on('support:presence:offline', () => {
      if (supportPresence.socketId === socket.id) {
        supportPresence = { online: false, lastSeenAt: new Date(), socketId: null };
        broadcastPresence();
      }
    });

    // Mijoz o'z xonasiga qo'shiladi — qo'llab-quvvatlash javoblari,
    // bron holati va shaxsiy bildirishnomalar shu orqali keladi.
    socket.on('join:user', (userId) => {
      if (userId) socket.join(`user:${userId}`);
    });

    // Mijoz o'z bronini kuzatishi
    socket.on('track:reservation', (reservationId) => {
      socket.join(`reservation:${reservationId}`);
    });

    socket.on('disconnect', () => {
      /*
       * Admin bildirishnomasiz uzilib qolsa (internet uzilishi,
       * brauzer yopilishi) ham "online" bo'lib qolib ketmasin —
       * shu socket "online" sifatida qayd etilgan bo'lsa, darhol
       * offline qilamiz.
       */
      if (supportPresence.socketId === socket.id) {
        supportPresence = { online: false, lastSeenAt: new Date(), socketId: null };
        broadcastPresence();
      }
    });
  });

  return io;
}

/** REST orqali boshlang'ich holatni olish uchun (birinchi yuklanish). */
export function getSupportPresence() {
  return { online: supportPresence.online, lastSeenAt: supportPresence.lastSeenAt };
}

export function getIO() {
  return io;
}
