import { Server as HttpServer } from 'http';
import { Server as SocketServer } from 'socket.io';
import { config, isAllowedOrigin } from '../config/index.js';
import { getRedis } from '../services/cache.js';
import { verifyAndroidPin } from '../middleware/androidGatewayAuth.js';

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


/**
 * Socket.io ni Redis adapteriga ulaydi (mavjud bo'lsa).
 * Xato bo'lsa — jim, bitta nusxa rejimida davom etadi.
 */
async function setupRedisAdapter() {
  try {
    const base = getRedis();
    if (!base) return;   // Redis yo'q — bitta nusxa rejimi

    const { createAdapter } = await import('@socket.io/redis-adapter');
    // Pub/Sub uchun ALOHIDA ulanishlar kerak: obuna bo'lgan
    // ulanishda oddiy buyruqlar ishlamaydi (Redis qoidasi)
    const pubClient = base.duplicate();
    const subClient = base.duplicate();
    io.adapter(createAdapter(pubClient, subClient));
    console.log('[socket] Redis adapter yoqildi (ko‘p nusxa rejimi)');
  } catch (e) {
    console.warn('[socket] Redis adapter ulanmadi, bitta nusxa rejimi:', e.message);
  }
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

  /*
   * Redis adapter — bir nechta server nusxasi uchun.
   *
   * NEGA KERAK: agar server 2+ nusxada ishlasa (yuk taqsimlash,
   * PM2 cluster, bir nechta konteyner), socket xonalari HAR
   * NUSXADA ALOHIDA bo'ladi. Natijada 1-nusxaga ulangan
   * restoranga 2-nusxada yaratilgan buyurtma haqida xabar
   * YETIB BORMAYDI — "buyurtma keldi, lekin restoran ko'rmadi"
   * kabi jiddiy nosozlik.
   *
   * Redis adapter barcha nusxalarni bitta kanalga ulaydi:
   * io.to(...).emit(...) qaysi nusxadan chaqirilishidan qat'i
   * nazar hamma joyga yetadi.
   *
   * Redis yo'q bo'lsa — bitta nusxa rejimida oddiy ishlayveradi.
   */
  setupRedisAdapter();

  io.on('connection', (socket) => {

    // Mijoz o'z buyurtmasini kuzatish uchun xonaga qo'shiladi
    socket.on('track:order', (orderId) => {
      socket.join(`order:${orderId}`);
    });

    // Restoran o'z buyurtmalarini eshitish uchun
    socket.on('join:restaurant', (restaurantId) => {
      socket.join(`restaurant:${restaurantId}`);
    });

    /*
     * ANDROID GATEWAY — yuqoridagi `join:restaurant` dan ATAYLAB
     * ALOHIDA: u HECH QANDAY tekshiruvsiz — restaurantId'ni bilgan
     * har qanday client istalgan restoran xonasiga qo'shilib olishi
     * mumkin (bu — ichki, ishonchli frontendlar uchun mavjud eski
     * xatti-harakat, shu TZ doirasida O'ZGARTIRILMAYDI).
     *
     * Android ilova esa kam ishonchli tashqi kanal (TZ 6-band:
     * "Bir restoran boshqa restoran ma'lumotlarini ola olmaydi"),
     * shuning uchun PIN tekshiruvidan o'tgandan KEYIN xuddi
     * o'sha `restaurant:<id>` xonasiga qo'shiladi — mavjud
     * order:new/order:update emitlariga HECH QANDAY o'zgartirish
     * kerak emas (TZ 4-band: "Mavjud Socket.IO mexanizmidan
     * foydalanish").
     *
     * PIN tekshiruvi androidGatewayAuth.js dagi BIR XIL funksiya —
     * brute-force blok (3 xato → 30 soniya) HTTP kanali bilan
     * baham ko'riladi.
     */
    socket.on('join:android:restaurant', async ({ restaurantId, pincode } = {}, ack) => {
      const result = await verifyAndroidPin(restaurantId, pincode);
      if (!result.ok) {
        if (typeof ack === 'function') ack({ ok: false, ...result.body });
        return;
      }
      socket.join(`restaurant:${result.restaurant._id}`);
      if (typeof ack === 'function') ack({ ok: true });
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
