import crypto from 'node:crypto';
import { RestaurantTelegramStaff } from '../models/RestaurantTelegramStaff.js';
import { Restaurant } from '../models/Restaurant.js';
import {
  isRestaurantBotEnabled,
  tgCall,
  sendToStaff,
  editStaffMessage,
  answerCallback,
  esc,
  btn,
} from './restaurantBotApi.js';

/*
 * ═══════════════════════════════════════════════════════════
 * RESTORAN TELEGRAM BOTI — ULANISH QISMI
 * ═══════════════════════════════════════════════════════════
 *
 * Bu fayl faqat XODIMNI ULASH bilan shug'ullanadi:
 * deep-link, /start, username tekshiruvi, tasdiqlash.
 *
 * Buyurtma yuborish va status tugmalari alohida faylda
 * bo'ladi — shunda bu yerdagi mantiq sodda qoladi.
 */

/*
 * Telegram transporti (xabar yuborish/tahrirlash/callback javobi)
 * restaurantBotApi.js ga ko'chirildi — bot fayllari orasida
 * aylanma bog'liqlik bo'lmasligi uchun. Eski importlar buzilmasin
 * deb shu yerdan qayta eksport qilinadi.
 */
export { isRestaurantBotEnabled, sendToStaff, editStaffMessage, answerCallback };

let cachedUsername = null;

/** Bot username'i — deep-link qurish uchun. */
export async function getRestaurantBotUsername() {
  if (cachedUsername) return cachedUsername;
  if (!isRestaurantBotEnabled()) return null;
  const j = await tgCall('getMe', {});
  cachedUsername = j?.result?.username || null;
  return cachedUsername;
}

/*
 * ═══ ULANISH TOKENI ═══
 *
 * Admin panelda "Telegram botga ulash" bosilganda chaqiriladi.
 *
 * Token 24 soat yashaydi. Nima uchun muddat qo'yilgan: link
 * chatga yuborilib, keyin unutilib ketishi mumkin. Muddatsiz
 * token esa abadiy ochiq eshik bo'lib qolardi.
 */
export async function createConnectLink(staffId) {
  const token = crypto.randomBytes(16).toString('hex');

  const staff = await RestaurantTelegramStaff.findByIdAndUpdate(
    staffId,
    {
      connectToken: token,
      connectTokenExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    },
    { new: true },
  );
  if (!staff) return null;

  const botUsername = await getRestaurantBotUsername();
  if (!botUsername) return null;

  return `https://t.me/${botUsername}?start=${token}`;
}

/*
 * ═══ /start <token> ═══
 *
 * TZ 6-BAND — ENG MUHIM QOIDA:
 * Username admin panelda ro'yxatdan o'tmagan bo'lsa, bot
 * HECH QANDAY javob bermaydi. Salomlashmaydi, "siz kimsiz?"
 * demaydi, restoranlar ro'yxatini ko'rsatmaydi.
 *
 * Sabab xavfsizlik: bot havolasi ochiq, uni istalgan odam
 * bosishi mumkin. Har qanday javob — hatto "sizga ruxsat yo'q"
 * ham — botning mavjudligini va u restoranlar bilan
 * ishlashini oshkor qiladi. Jim turish eng xavfsizi.
 */
export async function handleStart(msg, token) {
  const from = msg.from || {};
  const tgUserId = String(from.id);
  const username = (from.username || '').toLowerCase();

  /*
   * ═══ DIAGNOSTIKA ═══
   * Foydalanuvchiga HECH NARSA ko'rsatilmaydi (TZ 6-band),
   * lekin server logida sabab yoziladi. Busiz "bot javob
   * bermayapti" muammosini topib bo'lmaydi — hamma yo'l
   * jim `return` bilan tugaydi va qaysi biri ishlagani
   * noma'lum qoladi.
   */
  const skip = (why) => console.log(`[restaurantBot] /start e'tiborsiz: ${why} (@${username || '—'}, id=${tgUserId})`);

  // Token yo'q — oddiy /start (botni qidiruvdan topib bosgan). Jim.
  if (!token) { skip('token yo‘q — havolasiz ochilgan'); return; }

  const staff = await RestaurantTelegramStaff.findOne({
    connectToken: token,
    connectTokenExpiresAt: { $gt: new Date() },
  });

  if (!staff) {
    /*
     * Ikki xil holatni ajratamiz: token umuman yo'qmi yoki
     * muddati o'tganmi. Ikkinchisi tez-tez uchraydi va
     * yechimi boshqacha — panelda yangi havola olish.
     */
    const expired = await RestaurantTelegramStaff.findOne({ connectToken: token }).lean();
    skip(expired ? 'havola muddati tugagan (24 soat)' : 'token topilmadi');
    return;
  }

  /*
   * IKKINCHI QATLAM: token to'g'ri bo'lsa ham, username mos
   * kelishi shart. Link boshqa odamga yuborilgan bo'lishi
   * mumkin — o'shanda u ulanib olmasligi kerak.
   */
  if (!username) {
    skip('Telegram akkauntida username yo‘q — avval Telegram sozlamalarida qo‘ying');
    return;
  }
  if (username !== staff.username) {
    skip(`username mos emas: panelda "@${staff.username}", kelgan "@${username}"`);
    return;
  }

  // Bu Telegram akkaunt boshqa restoranga ulanganmi (TZ 20-band)
  const taken = await RestaurantTelegramStaff.findOne({
    telegramUserId: tgUserId,
    isActive: true,
    _id: { $ne: staff._id },
  });
  if (taken) {
    await sendToStaff(
      tgUserId,
      'Bu Telegram akkaunt allaqachon boshqa restoranga ulangan.\n'
      + 'Avval o‘sha restoran panelidan uzing.',
    );
    return;
  }

  const restaurant = await Restaurant.findById(staff.restaurantId).select('name').lean();
  if (!restaurant) return;

  // Vaqtincha saqlab qo'yamiz — tasdiqlash tugmasi uchun
  staff.telegramUserId = tgUserId;
  staff.firstName = from.first_name || '';
  staff.lastName = from.last_name || '';
  await staff.save();

  await sendToStaff(
    tgUserId,
    `👋 Assalomu alaykum, ${esc(from.first_name || username)}!\n\n`
    + `🏪 Siz <b>${esc(restaurant.name)}</b> restorani xodimisiz?`,
    {
      inline_keyboard: [[
        btn('✅ Ha', `connect:yes:${staff._id}`, 'success'),
        btn('❌ Yo‘q', `connect:no:${staff._id}`, 'danger'),
      ]],
    },
  );
}

/*
 * ═══ TASDIQLASH TUGMASI ═══
 */
export async function handleConnectCallback(cq) {
  const [, answer, staffId] = String(cq.data || '').split(':');
  const tgUserId = String(cq.from?.id);

  if (!/^[a-f\d]{24}$/i.test(staffId || '')) {
    await answerCallback(cq.id);
    return;
  }
  const staff = await RestaurantTelegramStaff.findById(staffId);
  if (!staff || staff.telegramUserId !== tgUserId) {
    await answerCallback(cq.id, 'Havola eskirgan — paneldan yangisini oling', { alert: true });
    return;
  }
  // Allaqachon tasdiqlangan (tugma ikki marta bosildi) — qayta ishlanmaydi
  if (staff.isActive && staff.connectedAt && !staff.connectToken) {
    await answerCallback(cq.id, '✅ Allaqachon ulangansiz');
    return;
  }

  if (answer === 'no') {
    // Bog'lanishni bekor qilamiz — yozuv qoladi, lekin ulanmagan
    staff.telegramUserId = null;
    staff.connectToken = null;
    await staff.save();

    await answerCallback(cq.id, 'Bekor qilindi');
    await editStaffMessage(tgUserId, cq.message?.message_id, 'Ulanish bekor qilindi.');
    return;
  }

  const restaurant = await Restaurant.findById(staff.restaurantId).select('name').lean();

  /*
   * Token BIR MARTALIK: tasdiqlangach o'chiriladi, shunda
   * o'sha link bilan ikkinchi marta ulanib bo'lmaydi.
   */
  staff.connectToken = null;
  staff.connectTokenExpiresAt = null;
  staff.isActive = true;
  staff.connectedAt = new Date();
  const { MENU_VERSION, sendMainMenu } = await import('./restaurantBotMenu.js');
  staff.menuVersion = MENU_VERSION;
  await staff.save();

  await answerCallback(cq.id, '✅ Ulandi');
  await editStaffMessage(
    tgUserId,
    cq.message?.message_id,
    `✅ Telegram akkauntingiz <b>${esc(restaurant?.name || '')}</b> restoraniga ulandi.\n\n`
    + 'Endi bu restoranga keladigan buyurtmalar shu bot orqali sizga yuboriladi.',
  );
  // Pastki menyu (Faol bronlar / Bugungi dostavkalar)
  await sendMainMenu(tgUserId, { restaurantName: restaurant?.name });
}

/*
 * ═══ WEBHOOK KIRISH NUQTASI ═══
 *
 * Marshrutlar:
 *   /start <token>    — xodimni ulash
 *   /start, matn      — ulangan xodimga menyu (begonaga — JIM, TZ 6)
 *   connect:*         — ulanishni tasdiqlash
 *   o:*               — buyurtma tugmalari
 *   r:*               — bron tugmalari
 *   m:*               — menyu ro'yxatlarini yangilash
 *
 * Bot faqat SHAXSIY chatda ishlaydi — guruhga qo'shib qo'yilsa
 * u yerdagi xabarlarga javob bermaydi.
 */
export async function handleRestaurantBotUpdate(update) {
  const cq = update?.callback_query;
  try {
    const msg = update?.message;
    if (msg) {
      if (msg.chat?.type && msg.chat.type !== 'private') return;
      const text = String(msg.text || '').trim();

      if (text.startsWith('/start')) {
        const token = text.split(/\s+/)[1] || '';
        if (token) {
          await handleStart(msg, token);
          return;
        }
      }
      if (!text) return;

      // Ulangan xodim — menyu; begona — jim (TZ 6-band)
      const { handleStaffMessage } = await import('./restaurantBotMenu.js');
      const handled = await handleStaffMessage(msg);
      if (!handled && text.startsWith('/start')) {
        console.log(`[restaurantBot] /start e'tiborsiz: token yo‘q, xodim emas (id=${msg.from?.id})`);
      }
      return;
    }

    if (cq) {
      const data = String(cq.data || '');

      if (data.startsWith('connect:')) {
        await handleConnectCallback(cq);
        return;
      }
      /*
       * Dinamik import: restaurantBotOrders orderFlow'ni chaqiradi,
       * orderFlow esa restaurantBotOrders'ni — statik import
       * aylanma bog'liqlik hosil qilardi.
       */
      if (data.startsWith('o:')) {
        const { handleOrderCallback } = await import('./restaurantBotOrders.js');
        await handleOrderCallback(cq);
        return;
      }
      if (data.startsWith('r:')) {
        const { handleReservationCallback } = await import('./restaurantBotOrders.js');
        await handleReservationCallback(cq);
        return;
      }
      if (data.startsWith('m:')) {
        const { handleMenuCallback } = await import('./restaurantBotMenu.js');
        await handleMenuCallback(cq);
        return;
      }
      // Noma'lum tugma (juda eski xabar) — "soat" belgisi qotib qolmasin
      await answerCallback(cq.id);
    }
  } catch (e) {
    console.error('[restaurantBot] update:', e.message);
    // Xato bo'lsa ham xodim tugma bosilganini sezsin
    if (cq?.id) await answerCallback(cq.id, '⚠️ Xatolik yuz berdi, qayta urinib ko‘ring', { alert: true });
  }
}
