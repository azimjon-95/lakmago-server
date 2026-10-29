import bcrypt from 'bcryptjs';
import { config } from '../config/index.js';
import { User } from '../models/User.js';
import { Restaurant } from '../models/Restaurant.js';
import { Dish } from '../models/Dish.js';
import { Order } from '../models/Order.js';
import { Session } from '../models/Session.js';
import { getIO } from '../sockets/io.js';
import { signToken, signAccessToken, generateRefreshToken, hashRefreshToken, refreshTokenExpiry } from '../middleware/auth.js';

/*
 * ═══ APP STORE TEKSHIRUVI UCHUN DEMO HISOB ═══
 *
 * Apple (App Review) Telegram orqali kira olmaydi, shuning uchun unga login/parol bilan DEMO hisob beriladi. Qoidalar:
 *
 *  1) Sukut bo'yicha O'CHIQ. DEMO_LOGIN_ENABLED=true bo'lmaguncha endpoint 404, ilovada forma ko'rinmaydi (capabilities).
 *  2) Login/parol — FAQAT env'da (DEMO_LOGIN / DEMO_PASSWORD), kodda emas. Parol bazada bcrypt xeshi.
 *  3) Demo hisob HAQIQIY dunyoga TEGMAYDI:
 *       • faqat "LokmaGo Demo" restoranidan buyurtma bera oladi (u nofaol — hech bir ro'yxatda ko'rinmaydi);
 *       • boshqa hech kim bu restoranga buyurtma bera olmaydi;
 *       • buyurtma `isDemo` bilan belgilanadi: restoran/admin/bot/push xabari YO'Q, hisobotlarga KIRMAYDI
 *         (models/plugins/demoScope.js), to'lov — faqat naqd (hech narsa olinmaydi);
 *       • holatlarni (qabul → tayyorlanmoqda → yetkazildi) SIMULYATOR yuritadi (~100 soniya);
 *       • 24 soatdan eski demo buyurtmalar o'chiriladi.
 *  4) Tekshiruv tugagach: DEMO_LOGIN_ENABLED=false (yoki parolni almashtirish) — demo kirish yopiladi.
 */
const DEMO_RESTAURANT_NAME = 'LokmaGo Demo';
export const DEMO_RESTAURANT_ONLY_MESSAGE = 'Demo rejimda buyurtma faqat «LokmaGo Demo» restoranidan beriladi';
const DEMO_PHONE = '+998900000000';
const DEMO_COORDS = { lat: 41.3115, lng: 69.2410 };
const DAY_MS = 24 * 60 * 60 * 1000;

const DEMO_MENU = [
  { section: 'Taomlar', name: 'Lagmon', price: 38000, description: 'Qo‘lda cho‘zilgan lagmon, mol go‘shti va sabzavotlar' },
  { section: 'Taomlar', name: 'Osh (Plov)', price: 45000, description: 'An’anaviy Toshkent oshi' },
  { section: 'Taomlar', name: 'Shashlik (mol)', price: 14000, description: 'Ko‘mirda pishirilgan, 1 shish' },
  { section: 'Taomlar', name: 'Chuchvara', price: 32000, description: 'Qaymoq bilan' },
  { section: 'Ichimliklar', name: 'Ko‘k choy', price: 8000, description: 'Choynak' },
  { section: 'Ichimliklar', name: 'Coca-Cola 0.5 l', price: 9000, description: '' },
  { section: 'Shirinliklar', name: 'Napoleon', price: 22000, description: 'Bir bo‘lak' },
  { section: 'Shirinliklar', name: 'Baklava', price: 18000, description: '' },
];

let ready = false;
/** Demo yoqilgan VA ma'lumotlar tayyor (ensureDemoData muvaffaqiyatli o'tgan). */
export const isDemoReady = () => config.demoLoginEnabled && ready;

/** Tez so'rov: bu foydalanuvchi demo hisobmi (buyurtma yaratishda). */
export async function isDemoUser(userId) {
  if (!userId) return false;
  const u = await User.findById(userId).select('isDemo').lean().catch(() => null);
  return Boolean(u?.isDemo);
}

/**
 * Demo hisob, demo restoran va menyuni yaratadi/yangilaydi (idempotent — har ishga tushishda xavfsiz).
 * Muammo bo'lsa (parol qisqa, login band) — demo YOPIQ qoladi (ready=false), server ishlashda davom etadi.
 */
export async function ensureDemoData(log = console) {
  ready = false;
  if (!config.demoLoginEnabled) return { ok: false, reason: 'disabled' };
  if (!config.demoLogin || config.demoPassword.length < 10) {
    log.error('[demo] DEMO_LOGIN yo‘q yoki DEMO_PASSWORD 10 belgidan qisqa — demo kirish YOPIQ');
    return { ok: false, reason: 'config' };
  }

  // Demo restoran: nofaol (ro'yxatlarda ko'rinmaydi), doim "ochiq", har kuni
  let rest = await Restaurant.findOne({ isDemo: true });
  const restFields = {
    name: DEMO_RESTAURANT_NAME, cuisine: 'Demo', category: 'restoran', isDemo: true, isActive: false, isApproved: true, isBlocked: false,
    address: 'Toshkent, Demo ko‘cha 1', ...DEMO_COORDS, openTime: '00:00', closeTime: '23:59', workingDays: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
    deliveryEnabled: true, pickupEnabled: true, cashEnabled: true, deliveryFee: 8000, minOrderAmount: 0, prepMinutes: 15,
  };
  rest = rest || new Restaurant();
  rest.set(restFields);
  // Tekshiruvchi (AQSH) o'z manzilini kiritishi mumkin — yetkazish radiusi cheklanmaydi, narx esa bitta (deliveryFee)
  rest.set('delivery.maxDistanceKm', 0);
  rest.set('delivery.pricingMode', 'flat');
  await rest.save();

  for (const d of DEMO_MENU) {
    await Dish.updateOne(
      { restaurantId: rest._id, name: d.name },
      { $set: { restaurantId: rest._id, section: d.section, name: d.name, price: d.price, description: d.description, prepMinutes: 10, isAvailable: true } },
      { upsert: true },
    );
  }

  // Demo foydalanuvchi: boshqa (haqiqiy) hisobning loginini egallab olmaymiz
  const clash = await User.findOne({ login: config.demoLogin, isDemo: { $ne: true } }).select('_id').lean();
  if (clash) {
    log.error(`[demo] DEMO_LOGIN "${config.demoLogin}" boshqa hisobda band — demo kirish YOPIQ`);
    return { ok: false, reason: 'login-taken' };
  }
  let user = await User.findOne({ isDemo: true });
  const passwordChanged = !user?.passwordHash || !bcrypt.compareSync(config.demoPassword, user.passwordHash);
  if (!user) {
    user = await User.create({
      isDemo: true, role: 'customer', status: 'ACTIVE', login: config.demoLogin, passwordHash: User.hashPassword(config.demoPassword),
      firstName: 'Demo', lastName: 'Mijoz', phone: DEMO_PHONE, phoneVerified: true, languageCode: 'uz',
      addresses: [{ title: 'Uy', labelId: 'home', address: 'Toshkent, Demo ko‘cha 1', street: 'Demo ko‘cha', city: 'Toshkent', ...DEMO_COORDS }],
    });
    user.defaultAddressId = user.addresses[0]._id;
    await user.save();
  } else {
    user.login = config.demoLogin;
    user.status = 'ACTIVE';
    user.role = 'customer';
    if (passwordChanged) user.passwordHash = User.hashPassword(config.demoPassword);
    await user.save();
  }
  if (passwordChanged) await Session.updateMany({ userId: user._id, revokedAt: null }, { $set: { revokedAt: new Date() } }).catch(() => {});

  ready = true;
  log.log?.(`[demo] tayyor: hisob "${config.demoLogin}", restoran "${DEMO_RESTAURANT_NAME}", ${DEMO_MENU.length} ta taom`);
  return { ok: true, userId: String(user._id), restaurantId: String(rest._id) };
}

const DUMMY_HASH = bcrypt.hashSync('demo-dummy-password', 10);

/** Demo kirish. Xato: { status, message }. Vaqt farqi bilan login mavjudligini bildirmaydi (parol har doim tekshiriladi). */
export async function demoLogin({ login, password, platform, deviceId }) {
  const fail = (status, message) => Object.assign(new Error(message), { status });
  if (!isDemoReady()) throw fail(404, 'Topilmadi');
  const lg = String(login || '').trim().toLowerCase();
  const pw = String(password || '');
  if (!lg || !pw || pw.length > 200) throw fail(400, 'Login va parolni kiriting');

  const user = await User.findOne({ isDemo: true, login: lg });
  const ok = bcrypt.compareSync(pw, user?.passwordHash || DUMMY_HASH) && Boolean(user);
  if (!ok || user.status !== 'ACTIVE') throw fail(401, 'Login yoki parol noto‘g‘ri');

  user.lastLoginAt = new Date();
  await user.save();
  const token = signToken(String(user._id), 'customer');
  const accessToken = signAccessToken(String(user._id), 'customer');
  const refreshToken = generateRefreshToken();
  await Session.create({
    userId: user._id, refreshTokenHash: hashRefreshToken(refreshToken), deviceId: deviceId || '',
    platform: ['android', 'ios'].includes(platform) ? platform : 'ios', expiresAt: refreshTokenExpiry(),
  });
  return { token, accessToken, refreshToken, user, isNewUser: false, demo: true };
}

/** Bosh sahifada demo foydalanuvchiga ko'rsatiladigan restoran kartochkasi (ro'yxat kartochkasi shaklida). */
export async function getDemoRestaurantCard() {
  const r = await Restaurant.findOne({ isDemo: true })
    .select('_id name cuisine category kind tint icon imageUrl address lat lng openTime closeTime workingDays timezone deliveryFee deliveryMin deliveryMax prepMinutes minOrderAmount deliveryEnabled pickupEnabled cashEnabled rating')
    .lean();
  return r ? { ...r, isOpen: true, isDemo: true } : null;
}

// ───────── SIMULYATOR: demo buyurtma holatlari ─────────
const FLOW_DELIVERY = [['pending', 0], ['accepted', 8], ['preparing', 22], ['ready', 55], ['delivering', 70], ['delivered', 100]];
const FLOW_PICKUP = [['pending', 0], ['accepted', 8], ['preparing', 22], ['ready', 50], ['delivered', 85]];
const RANK = { pending: 0, accepted: 1, preparing: 2, ready: 3, delivering: 4, delivered: 5 };
const STAMP = { accepted: 'acceptedAt', preparing: 'preparingAt', ready: 'readyAt', delivering: 'deliveringAt', delivered: 'deliveredAt' };
const ACTIVE = ['pending', 'accepted', 'preparing', 'ready', 'delivering'];

/** Yaratilganidan beri o'tgan vaqtga qarab holat (toza funksiya). speed — tezlashtirish (sinov uchun). */
export function demoStageAt(createdAt, fulfillment, now = Date.now(), speed = 1) {
  const elapsed = ((now - new Date(createdAt).getTime()) / 1000) * speed;
  const flow = fulfillment === 'pickup' ? FLOW_PICKUP : FLOW_DELIVERY;
  let stage = 'pending';
  for (const [name, at] of flow) if (elapsed >= at) stage = name;
  return stage;
}

let lastCleanup = 0;
/** Bir qadam: faol demo buyurtmalarni oldinga suradi va mijozga xabar beradi (restoran/adminga EMAS). */
export async function tickDemoOrders(now = Date.now(), speed = config.demoSimSpeed) {
  const rows = await Order.find({ isDemo: true, status: { $in: ACTIVE } }).select('status fulfillment createdAt userId').lean();
  let moved = 0;
  for (const row of rows) {
    const target = demoStageAt(row.createdAt, row.fulfillment, now, speed);
    if ((RANK[target] ?? 0) <= (RANK[row.status] ?? 0)) continue;
    // Sakrab o'tilgan oraliq bosqichlarning vaqti ham yoziladi (masalan accepted → ready bo'lsa preparingAt ham)
    const stamps = {};
    for (const [stage, rank] of Object.entries(RANK)) if (rank > (RANK[row.status] ?? 0) && rank <= RANK[target] && STAMP[stage]) stamps[STAMP[stage]] = new Date(now);
    // Faqat joriy holatdan: ko'p jarayonli muhitda faqat BITTASI yutadi va xabar beradi
    const res = await Order.updateOne({ _id: row._id, isDemo: true, status: row.status }, { $set: { status: target, ...stamps } });
    if (!res.modifiedCount) continue;
    moved += 1;
    const io = getIO();
    const payload = { orderId: String(row._id), status: target };
    io?.to(`order:${row._id}`).emit('order:status', payload);
    if (row.userId) io?.to(`user:${row.userId}`).emit('order:status', payload);
  }
  if (now - lastCleanup > 10 * 60 * 1000) {
    lastCleanup = now;
    await Order.deleteMany({ isDemo: true, createdAt: { $lt: new Date(now - DAY_MS) } }).catch(() => {});
  }
  return moved;
}

let timer = null;
export function startDemoSimulator() {
  if (timer) return;
  timer = setInterval(() => { tickDemoOrders().catch((e) => console.error('[demo] simulyator:', e.message)); }, 5000);
  timer.unref?.();
}
