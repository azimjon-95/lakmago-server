import { z } from 'zod';
import { asyncHandler } from '../middleware/error.js';
import { SupportChat } from '../models/SupportChat.js';
import { User } from '../models/User.js';
import { getIO } from '../sockets/io.js';
import { notifyUser } from '../services/telegram.js';

const messageSchema = z.object({
  text: z.string().min(1).max(2000),
});

// Mijoz ma'lumotlarini suhbatga nusxalaymiz (admin ko'rishi uchun)
async function ensureChat(userId) {
  let chat = await SupportChat.findOne({ userId });
  if (chat) return chat;

  const user = await User.findById(userId)
    .select('telegramId firstName lastName username photoUrl phone').lean();

  return SupportChat.create({
    userId,
    telegramId: user?.telegramId || '',
    firstName: user?.firstName || '',
    lastName: user?.lastName || '',
    username: user?.username || '',
    photoUrl: user?.photoUrl || '',
    phone: user?.phone || '',
    messages: [],
  });
}

export const supportController = {
  // ===== MIJOZ TOMONI =====

  // GET /api/support/chat — mening suhbatim
  myChat: asyncHandler(async (req, res) => {
    const chat = await ensureChat(req.userId);
    // Mijoz ochdi — admin javoblari o'qilgan hisoblanadi
    if (chat.userUnreadCount > 0) {
      chat.userUnreadCount = 0;
      chat.messages.forEach((m) => { if (m.from === 'admin' && !m.readAt) m.readAt = new Date(); });
      await chat.save();
    }
    // Suhbat yakunlangan bo'lsa mijozda toza oyna ochiladi.
    // Xabarlar bazada saqlanadi — admin tarixni ko'ra oladi.
    res.json({
      messages: chat.isResolved ? [] : chat.messages,
      isResolved: chat.isResolved,
    });
  }),

  // POST /api/support/message — mijoz xabar yuboradi
  sendMessage: asyncHandler(async (req, res) => {
    const parsed = messageSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Xabar bo\u2018sh' });

    const chat = await ensureChat(req.userId);
    const text = parsed.data.text.trim();

    chat.messages.push({ from: 'user', text });
    chat.unreadCount += 1;
    chat.isResolved = false;               // yangi xabar — suhbat qayta ochiladi
    chat.lastMessageAt = new Date();
    chat.lastMessageText = text.slice(0, 120);
    await chat.save();

    // Adminga real-time signal (to'liq ma'lumot bilan)
    getIO()?.to('admin').emit('support:message', {
      chatId: String(chat._id),
      userId: String(chat.userId),
      telegramId: chat.telegramId,
      firstName: chat.firstName,
      lastName: chat.lastName,
      username: chat.username,
      photoUrl: chat.photoUrl,
      phone: chat.phone,
      text,
      at: new Date(),
      unreadCount: chat.unreadCount,
    });

    res.status(201).json({ ok: true, message: chat.messages[chat.messages.length - 1] });
  }),

  // ===== ADMIN TOMONI =====

  // GET /api/admin/support — barcha suhbatlar (o'qilmagan birinchi)
  list: asyncHandler(async (req, res) => {
    const filter = req.query.resolved === 'true' ? { isResolved: true } : { isResolved: false };
    const chats = await SupportChat.find(filter)
      .select('-messages')                 // ro'yxatda xabarlar shart emas (tez)
      .sort({ unreadCount: -1, lastMessageAt: -1 })
      .limit(100)
      .lean();

    const totalUnread = await SupportChat.aggregate([
      { $match: { isResolved: false } },
      { $group: { _id: null, total: { $sum: '$unreadCount' } } },
    ]);

    res.json({ chats, totalUnread: totalUnread[0]?.total || 0 });
  }),

  // GET /api/admin/support/:id — bitta suhbat (ochilganda o'qilgan bo'ladi)
  getOne: asyncHandler(async (req, res) => {
    const chat = await SupportChat.findById(req.params.id);
    if (!chat) return res.status(404).json({ error: 'Suhbat topilmadi' });

    // Admin ochdi — mijoz xabarlari o'qilgan, badge o'chadi
    if (chat.unreadCount > 0) {
      chat.unreadCount = 0;
      chat.messages.forEach((m) => { if (m.from === 'user' && !m.readAt) m.readAt = new Date(); });
      await chat.save();
      // Badge yangilanishi uchun signal
      getIO()?.to('admin').emit('support:read', { chatId: String(chat._id) });
    }

    res.json(chat);
  }),

  // POST /api/admin/support/:id/reply — admin javob beradi
  reply: asyncHandler(async (req, res) => {
    const parsed = messageSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Xabar bo\u2018sh' });

    const chat = await SupportChat.findById(req.params.id);
    if (!chat) return res.status(404).json({ error: 'Suhbat topilmadi' });

    const text = parsed.data.text.trim();
    const admin = await User.findById(req.userId).select('firstName login').lean();
    const adminName = admin?.firstName || admin?.login || 'Operator';

    chat.messages.push({ from: 'admin', text, adminName });
    chat.userUnreadCount += 1;
    chat.lastMessageAt = new Date();
    chat.lastMessageText = text.slice(0, 120);
    await chat.save();

    // Mijozga real-time (ilova ochiq bo'lsa)
    getIO()?.to(`user:${chat.userId}`).emit('support:reply', {
      text, adminName, at: new Date(),
    });

    // Ilova yopiq bo'lsa ham xabar yetib borsin — bot orqali
    if (chat.telegramId) {
      notifyUser(chat.telegramId,
        `💬 <b>Yordam xizmati</b>\n\n${text}\n\n<i>Javob berish uchun ilovani oching</i>`);
    }

    res.status(201).json({ ok: true, message: chat.messages[chat.messages.length - 1] });
  }),

  // PATCH /api/admin/support/:id/resolve — suhbatni yopish
  resolve: asyncHandler(async (req, res) => {
    const chat = await SupportChat.findByIdAndUpdate(
      req.params.id,
      { isResolved: req.body.resolved !== false },
      { new: true },
    ).select('-messages');
    if (!chat) return res.status(404).json({ error: 'Suhbat topilmadi' });

    getIO()?.to('admin').emit('support:resolved', { chatId: String(chat._id) });
    res.json(chat);
  }),
};
