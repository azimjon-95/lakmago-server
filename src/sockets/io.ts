import { Server as HttpServer } from 'http';
import { Server as SocketServer } from 'socket.io';
import { config } from '../config/index.js';

let io: SocketServer | null = null;

export function initSocket(httpServer: HttpServer) {
  io = new SocketServer(httpServer, {
    cors: { origin: config.clientOrigin, methods: ['GET', 'POST'] },
  });

  io.on('connection', (socket) => {
    console.log('socket ulandi:', socket.id);

    // Mijoz o'z buyurtmasini kuzatish uchun xonaga qo'shiladi
    socket.on('track:order', (orderId: string) => {
      socket.join(`order:${orderId}`);
    });

    // Restoran o'z buyurtmalarini eshitish uchun
    socket.on('join:restaurant', (restaurantId: string) => {
      socket.join(`restaurant:${restaurantId}`);
    });

    // Mijoz o'z bronini kuzatishi
    socket.on('track:reservation', (reservationId: string) => {
      socket.join(`reservation:${reservationId}`);
    });

    socket.on('disconnect', () => {
      console.log('socket uzildi:', socket.id);
    });
  });

  return io;
}

export function getIO() {
  return io;
}
