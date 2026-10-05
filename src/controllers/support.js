import { z } from 'zod';
import { asyncHandler } from '../middleware/error.js';
import { SupportChat } from '../models/SupportChat.js';
import { User } from '../models/User.js';
import { getIO, getSupportPresence } from '../sockets/io.js';
import { notify } from '../services/notifications.js';
import { tgCall } from '../services/telegramApi.js';
import { config } from '../config/index.js';
import { notifySupportGroup, markSupportGroupReplied, markSupportGroupClosed } from '../services/supportGroupNotify.js';

const messageSchema = z.object({
  text: z.string().min(1).max(2000),
});

const isObjectId = (v) => /^[a-f\d]{24}$/i.test(String(v || ''));

const escHtml = (s = '') => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/*
 * Mijozga bot orqali yuboriladigan javob matni. Admin yozgan matn
 * ESCAPE qilinadi — avval xom holda HTML rejimida ketardi va "<", "&"
 * belgilari bo'lgan javobni Telegram rad etib, mijozga yetmay qolardi.
 */
const botReplyText = (text) =>
  `💬 <b>Yordam xizmati</b>\n\n${escHtml(text)}\n\n<i>Javob berish uchun ilovani oching</i>`;

/** Suhbatning oxirgi xabari bo'yicha ro'yxat maydonlari (tahrir/o'chirishdan keyin). */
function lastFields(messages) {
  const last = messages[messages.length - 1];
  return last
    ? { lastMessageAt: last.createdAt, lastMessageText: String(last.text || '').slice(0, 120) }
    : { lastMessageText: '' };
}

// Mijoz ma'lumotlarini suhbatga nusxalaymiz (admin ko'rishi uchun).
// FAQAT xabar yozilganda chaqiriladi (sendMessage) — mijoz panelni
// ochib, hech narsa yozmasa suhbat UMUMAN yaratilmaydi.
async function ensureChat(userId) {
  let chat = await SupportChat.findOne({ userId });
  if (chat) return chat;

  const user = await User.findById(userId)
    .select('telegramId firstName lastName username photoUrl phone').lean();

  try {
    return await SupportChat.create({
      userId,
      telegramId: user?.telegramId || '',
      firstName: user?.firstName || '',
      lastName: user?.lastName || '',
      username: user?.username || '',
      photoUrl: user?.photoUrl || '',
      phone: user?.phone || '',
      messages: [],
    });
  } catch (e) {
    /*
     * Mijoz "Yuborish"ni qo'sh bosdi: ikkala so'rov ham suhbat yo'qligini
     * ko'rib yaratmoqchi bo'ladi, userId unique — ikkinchisi E11000 bilan
     * yiqilib mijozga 500 qaytardi. Yaratib ulgurgan suhbatni olamiz.
     */
    if (e?.code === 11000) return SupportChat.findOne({ userId });
    throw e;
  }
}

export const supportController = {
  // GET /api/support/presence — boshlang'ich holat (socket ulanishidan oldin)
  presence: asyncHandler(async (_req, res) => {
    res.json(getSupportPresence());
  }),

  // ===== MIJOZ TOMONI =====

  /*
   * GET /api/support/chat — mening suhbatim.
   *
   * XATO TUZATILDI: avval bu ham ensureChat() chaqirar, ya'ni
   * mijoz panelni OCHISHNING O'ZIDA (hali bitta ham xabar
   * yozmasdan) bazada bo'sh suhbat yaratilib qolardi — admin
   * panelidagi "Faol" ro'yxati bunday bo'sh yozishmalar bilan
   * to'lib ketardi. Endi FAQAT MAVJUD suhbat o'qiladi;
   * yaratilishi sendMessage'gacha kechiktiriladi.
   */
  myChat: asyncHandler(async (req, res) => {
    const chat = await SupportChat.findOne({ userId: req.userId });
    if (!chat) {
      // Hali birorta ham xabar yo'q — bazada hech narsa yaratilmaydi
      return res.json({ messages: [], isResolved: false });
    }

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
    if (!parsed.success) return res.status(400).json({ error: 'Xabar bo‘sh' });

    const existing = await ensureChat(req.userId);
    const text = parsed.data.text.trim();

    /*
     * ATOMIK qo'shish ($push/$inc/$set BIR so'rovda). Avval `chat.messages.push()`
     * + `chat.save()` edi: o'qib-o'zgartirib-yozish, va `unreadCount += 1` MUTLAQ
     * qiymat sifatida yozilardi ($set), ya'ni mijoz "Yuborish"ni qo'sh bossa
     * o'qilmagan xabarlar hisobi 2 emas, 1 bo'lib qolardi. Endi $inc.
     * (Eslatma: FerretDB test bazasi parallel yozuvni atomik bajarmaydi —
     * shuning uchun qo'sh bosishda xabarlar SONI testda tekshirilmaydi;
     * real MongoDB'da $push/$inc atomik.)
     */
    const chat = await SupportChat.findOneAndUpdate(
      { _id: existing._id },
      {
        $push: { messages: { from: 'user', text } },
        $inc: { unreadCount: 1 },
        // yangi xabar — suhbat qayta ochiladi
        $set: { isResolved: false, lastMessageAt: new Date(), lastMessageText: text.slice(0, 120) },
      },
      { new: true },
    );

    // Markaziy bildirishnoma — yordam so'rovi ham boshqa
    // hodisalar kabi saqlanadi va uzilishdan keyin tiklanadi
    notify({
      // Har xabar alohida: bir suhbatdagi ikkinchi xabar ham
      // e'tibordan chetda qolmasligi kerak
      notificationId: `support:${chat._id}:${chat.messages.length}`,
      audience: 'admin',
      type: 'support',
      title: 'Yordam so‘rovi',
      body: `${chat.firstName || 'Mijoz'}: ${text.slice(0, 60)}`,
      refType: 'support',
      refId: chat._id,
      meta: { chatId: String(chat._id) },
    }).catch((e) => console.error('[notify:support]', e.message));

    // Ichki Telegram guruhga ham — admin panelni ochib
    // o'tirmasdan darhol bilinsin (SUPPORT_GROUP_CHAT_ID bo'sh
    // bo'lsa jimgina o'tkazib yuboriladi)
    notifySupportGroup(chat, text).catch((e) => console.error('[notify:supportGroup]', e.message));

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
    /*
     * "messages.0": { $exists: true } — kamida bitta xabar bor
     * suhbatlarni oladi. Buni qo'shishdan oldin panel bo'sh
     * (mijoz ochib hech narsa yozmagan) yozishmalar bilan to'lib
     * ketardi — ular hech qachon o'chirilmagan edi. Bu shart
     * ularni RO'YXATDA yashiradi, alohida tozalashga hojat yo'q.
     */
    const filter = {
      isResolved: req.query.resolved === 'true',
      'messages.0': { $exists: true },
    };
    const chats = await SupportChat.find(filter)
      .select('-messages')                 // ro'yxatda xabarlar shart emas (tez)
      .sort({ unreadCount: -1, lastMessageAt: -1 })
      .limit(100)
      .lean();

    const totalUnread = await SupportChat.aggregate([
      { $match: { isResolved: false, 'messages.0': { $exists: true } } },
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
    if (!parsed.success) return res.status(400).json({ error: 'Xabar bo‘sh' });

    const chat = await SupportChat.findById(req.params.id);
    if (!chat) return res.status(404).json({ error: 'Suhbat topilmadi' });

    const text = parsed.data.text.trim();
    const admin = await User.findById(req.userId).select('firstName login').lean();
    const adminName = admin?.firstName || admin?.login || 'Operator';

    // Atomik ($push/$inc) — sendMessage bilan bir xil sabab
    const updated = await SupportChat.findOneAndUpdate(
      { _id: chat._id },
      {
        $push: { messages: { from: 'admin', text, adminName } },
        $inc: { userUnreadCount: 1 },
        $set: { lastMessageAt: new Date(), lastMessageText: text.slice(0, 120) },
      },
      { new: true },
    );
    chat.messages = updated.messages;

    // Telegram guruhdagi shu mijozning posti: ✅✅ Javob berildi (tahrirlanadi)
    markSupportGroupReplied(chat._id, adminName).catch((e) => console.error('[supportGroup:reply]', e.message));

    const saved = chat.messages[chat.messages.length - 1];

    // Mijozga real-time (ilova ochiq bo'lsa). `id` — tahrir/o'chirish shu bilan topiladi
    getIO()?.to(`user:${chat.userId}`).emit('support:reply', {
      id: String(saved._id), text, adminName, at: saved.createdAt,
    });

    /*
     * Ilova yopiq bo'lsa ham xabar yetib borsin — bot orqali. Javobni
     * KUTMAYMIZ (admin tez javob oladi); Telegram xabar id'si keyin
     * saqlanadi, shunda tahrir/o'chirish bot xabarini ham yangilaydi.
     */
    if (chat.telegramId && config.telegramBotToken) {
      tgCall('sendMessage', { chat_id: chat.telegramId, text: botReplyText(text), parse_mode: 'HTML' })
        .then((r) => r?.message_id && SupportChat.updateOne(
          { _id: chat._id, 'messages._id': saved._id },
          { $set: { 'messages.$.tgMessageId': r.message_id } },
        ))
        .catch((e) => console.warn('[support:reply] botga yuborilmadi:', e.message));
    }

    res.status(201).json({ ok: true, message: saved });
  }),

  /*
   * PATCH /api/admin/support/:id/messages/:msgId — admin O'Z javobini tahrirlaydi.
   * Faqat `from: 'admin'` xabar. Mijozga jonli (support:edit) va bot xabari
   * ham tahrirlanadi (bo'lsa). Bot xabarini tahrirlab bo'lmasa — ilovada baribir
   * yangilanadi, javobda `telegram: 'failed'` qaytadi.
   */
  editMessage: asyncHandler(async (req, res) => {
    const parsed = messageSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Xabar bo‘sh' });
    const { id, msgId } = req.params;
    if (!isObjectId(id) || !isObjectId(msgId)) return res.status(404).json({ error: 'Xabar topilmadi' });

    const text = parsed.data.text.trim();
    if (!text) return res.status(400).json({ error: 'Xabar bo‘sh' });

    const chat = await SupportChat.findOne({ _id: id, 'messages._id': msgId }).select('userId telegramId messages');
    if (!chat) return res.status(404).json({ error: 'Xabar topilmadi' });
    const msg = chat.messages.id(msgId);
    if (msg.from !== 'admin') return res.status(403).json({ error: 'Faqat administrator javobini tahrirlash mumkin' });
    if (msg.text === text) return res.json({ ok: true, message: msg, telegram: 'unchanged' });

    const editedAt = new Date();
    // Atomik pozitsion yangilash — parallel javob/xabar bilan to'qnashmaydi
    await SupportChat.updateOne(
      { _id: id, 'messages._id': msgId },
      { $set: { 'messages.$.text': text, 'messages.$.editedAt': editedAt } },
    );
    msg.text = text; msg.editedAt = editedAt;
    const isLast = String(chat.messages[chat.messages.length - 1]._id) === String(msgId);
    if (isLast) await SupportChat.updateOne({ _id: id }, { $set: { lastMessageText: text.slice(0, 120) } });

    getIO()?.to(`user:${chat.userId}`).emit('support:edit', { id: String(msgId), text, editedAt });
    getIO()?.to('admin').emit('support:changed', { chatId: String(id) });

    let telegram = 'none';
    if (msg.tgMessageId && chat.telegramId && config.telegramBotToken) {
      try {
        await tgCall('editMessageText', {
          chat_id: chat.telegramId, message_id: msg.tgMessageId,
          text: botReplyText(text), parse_mode: 'HTML',
        });
        telegram = 'edited';
      } catch (e) {
        telegram = /not modified/i.test(e.message) ? 'edited' : 'failed';
        if (telegram === 'failed') console.warn('[support:edit] bot xabari tahrirlanmadi:', e.message);
      }
    }

    res.json({ ok: true, message: msg, telegram });
  }),

  /*
   * DELETE /api/admin/support/:id/messages/:msgId — admin O'Z javobini o'chiradi.
   * Bazadan olib tashlanadi, mijozdan jonli (support:delete) va bot xabari ham
   * o'chiriladi. Telegram bot xabarini faqat 48 soat ichida o'chira oladi —
   * undan eskisi ilovadan o'chadi, botda qoladi (`telegram: 'failed'`).
   */
  deleteMessage: asyncHandler(async (req, res) => {
    const { id, msgId } = req.params;
    if (!isObjectId(id) || !isObjectId(msgId)) return res.status(404).json({ error: 'Xabar topilmadi' });

    const chat = await SupportChat.findOne({ _id: id, 'messages._id': msgId }).select('userId telegramId messages');
    if (!chat) return res.status(404).json({ error: 'Xabar topilmadi' });
    const msg = chat.messages.id(msgId);
    if (msg.from !== 'admin') return res.status(403).json({ error: 'Faqat administrator javobini o‘chirish mumkin' });

    const unread = !msg.readAt;
    const updated = await SupportChat.findOneAndUpdate(
      { _id: id },
      { $pull: { messages: { _id: msg._id } } },
      { new: true },
    ).select('messages userUnreadCount');

    // Ro'yxatdagi oxirgi xabar va mijozning o'qilmaganlar soni
    const $set = lastFields(updated.messages);
    if (unread && updated.userUnreadCount > 0) $set.userUnreadCount = updated.userUnreadCount - 1;
    await SupportChat.updateOne({ _id: id }, { $set });

    getIO()?.to(`user:${chat.userId}`).emit('support:delete', { id: String(msgId) });
    getIO()?.to('admin').emit('support:changed', { chatId: String(id) });

    let telegram = 'none';
    if (msg.tgMessageId && chat.telegramId && config.telegramBotToken) {
      try {
        await tgCall('deleteMessage', { chat_id: chat.telegramId, message_id: msg.tgMessageId });
        telegram = 'deleted';
      } catch (e) {
        telegram = 'failed';
        console.warn('[support:delete] bot xabari o‘chirilmadi:', e.message);
      }
    }

    res.json({ ok: true, id: String(msgId), telegram });
  }),

  // PATCH /api/admin/support/:id/resolve — suhbatni yopish
  resolve: asyncHandler(async (req, res) => {
    const chat = await SupportChat.findByIdAndUpdate(
      req.params.id,
      { isResolved: req.body.resolved !== false },
      { new: true },
    ).select('-messages');
    if (!chat) return res.status(404).json({ error: 'Suhbat topilmadi' });

    // Sessiya yopildi (qayta ochilmagan bo'lsa): Telegram'dagi post "🔒 yopildi" bo'ladi,
    // mijozning keyingi xabari YANGI post bo'lib boshlanadi
    if (req.body.resolved !== false) {
      markSupportGroupClosed(chat._id).catch((e) => console.error('[supportGroup:close]', e.message));
    }

    getIO()?.to('admin').emit('support:resolved', { chatId: String(chat._id) });
    res.json(chat);
  }),
};
