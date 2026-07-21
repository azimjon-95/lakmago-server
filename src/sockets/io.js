import { Server as HttpServer } from 'http';
import { Server as SocketServer } from 'socket.io';
import { config, isAllowedOrigin } from '../config/index.js';

let io = null;

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
    socket.on('join:admin', () => {
      socket.join('admin');
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
    });
  });

  return io;
}

export function getIO() {
  return io;
}
