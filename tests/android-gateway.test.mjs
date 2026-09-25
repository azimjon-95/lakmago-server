/*
 * ═══════════════════════════════════════════════════════════
 * ANDROID GATEWAY — PIN AUTENTIFIKATSIYASI VA IZOLYATSIYA
 * ═══════════════════════════════════════════════════════════
 *
 * TZ: GET /app/:pincode/:restaurantId
 *
 * Bu yerda tekshiriladi:
 *   - PIN noto'g'ri bo'lsa rad etiladi, 3 xatodan keyin 30 soniya
 *     bloklanadi (kiosk bilan bir xil naqsh)
 *   - Bitta restoranning PIN'i ikkinchisiga ISHLAMAYDI
 *   - orders/orderDetail FAQAT shu restaurantId'ga tegishli
 *     buyurtmalarni qaytaradi, moliyaviy ichki maydonlar
 *     (LokmaGo netto, shlyuz residual) YASHIRILGAN
 *   - PIN yoki uning hash'i HECH QANDAY javobda ko'rinmaydi
 *   - Socket.IO uchun ishlatiladigan verifyAndroidPin HTTP
 *     middleware bilan bir xil natija beradi
 *
 * Ishga tushirish: npm run test:android
 */
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/lokma_android_gw';
const mongoose = (await import('mongoose')).default;
await mongoose.connect(process.env.MONGO_URI);
await mongoose.connection.db.dropDatabase();

const { Restaurant } = await import('../src/models/Restaurant.js');
const { Order } = await import('../src/models/Order.js');
const { User } = await import('../src/models/User.js');
const { androidGatewayAuth, verifyAndroidPin } = await import('../src/middleware/androidGatewayAuth.js');
const { restaurantPanelController } = await import('../src/controllers/restaurantPanel.js');

let fails = 0;
const ok = (c, m) => { console.log(c ? '  ✓' : '  ✗ FAIL:', m); if (!c) fails++; };

/* asyncHandler promise qaytarmaydi — har chaqiruvdan keyin kutamiz */
const wait = (ms = 250) => new Promise((r) => setTimeout(r, ms));

function mockRes() {
  return {
    _c: 200,
    status(c) { this._c = c; return this; },
    json(b) { this._body = b; return this; },
  };
}

/* ═══ TAYYORGARLIK: ikkita restoran, ikkitasida ham buyurtma ═══ */
const restA = await Restaurant.create({
  name: 'Osh Markazi', cuisine: 'milliy', category: 'restoran', isActive: true,
});
const restB = await Restaurant.create({
  name: 'Pizza Uy', cuisine: 'pitsa', category: 'restoran', isActive: true,
});
const userA = await User.create({ firstName: 'Aziz', phone: '+998901110000' });

const orderA = await Order.create({
  userId: userA._id, restaurantId: restA._id, restaurantName: restA.name,
  items: [{ name: 'Osh', quantity: 2, unitPrice: 25000 }],
  subtotal: 50000, total: 50000, status: 'pending', phone: '+998901110000',
  finance: {
    model: 'v2', foodSubtotal: 5000000, restaurantCommissionPercent: 10,
    restaurantCommissionAmount: 500000, restaurantPayout: 4500000,
    deliveryFee: 0, totalCharged: 5000000,
    // ICHKI — restoranga KO'RINMASLIGI kerak
    lokmaNetCommission: 350000, lokmaCashNet: 300000,
  },
});
const orderB = await Order.create({
  userId: userA._id, restaurantId: restB._id, restaurantName: restB.name,
  items: [{ name: 'Pitsa', quantity: 1, unitPrice: 60000 }],
  subtotal: 60000, total: 60000, status: 'pending', phone: '+998901110000',
});

/* Gateway hali sozlanmagan */
console.log('\n[1] Gateway sozlanmagan restoranda — 404');
{
  const req = { params: { pincode: '1234', restaurantId: String(restA._id) } };
  const res = mockRes();
  await androidGatewayAuth(req, res, () => { res._nextCalled = true; });
  ok(res._c === 404 && !res._nextCalled, `sozlanmagan gateway: ${res._c}`);
}

console.log('\n[2] Noto‘g‘ri restaurantId format — 400');
{
  const req = { params: { pincode: '1234', restaurantId: 'notanid' } };
  const res = mockRes();
  await androidGatewayAuth(req, res, () => {});
  ok(res._c === 400, `format xatosi: ${res._c}`);
}

/* ═══ PIN yaratish — restoran o'zi ═══ */
console.log('\n[3] PIN yaratish (rotateAndroidPin)');
let pinA;
{
  const req = { restaurantId: String(restA._id) };
  const res = mockRes();
  await restaurantPanelController.rotateAndroidPin(req, res, () => {});
  await wait();
  pinA = res._body?.pin;
  ok(/^\d{4}$/.test(pinA || ''), `4 xonali PIN qaytdi: "${pinA}"`);
  ok(res._body?.enabled === true, 'enabled: true qaytdi');

  const fresh = await Restaurant.findById(restA._id).lean();
  ok(fresh.androidGateway?.enabled === true, 'bazada enabled=true');
  ok(fresh.androidGateway?.pinHash && fresh.androidGateway.pinHash !== pinA,
    'bazada FAQAT hash bor, ochiq PIN emas');
}

console.log('\n[4] Noto‘g‘ri PIN — rad etiladi, hisoblagich oshadi');
{
  const req = { params: { pincode: '0000', restaurantId: String(restA._id) } };
  const res = mockRes();
  await androidGatewayAuth(req, res, () => { req._passed = true; });
  ok(res._c === 401 && !req._passed, `noto‘g‘ri PIN rad etildi: ${res._c}`);
  const fresh = await Restaurant.findById(restA._id).lean();
  ok(fresh.androidGateway.pinFails === 1, `fails=1: ${fresh.androidGateway.pinFails}`);
}

console.log('\n[5] 3-xato — hali 401 (lekin retryAfter bilan, kiosk naqshiga mos)');
{
  /*
   * Kiosk naqshi bilan bir xil (kiosk.js verifyPin): 3-CHI xato
   * hali 401 PIN_WRONG qaytaradi, lekin `retryAfter` biriktirilgan
   * holda — bloklash SHU javobda boshlanadi. 429 PIN_BLOCKED esa
   * FAQAT KEYINGI (4-chi) urinishda ko'rinadi (pastda [6]-bosqich).
   */
  await androidGatewayAuth({ params: { pincode: '0000', restaurantId: String(restA._id) } }, mockRes(), () => {});
  const req = { params: { pincode: '0000', restaurantId: String(restA._id) } };
  const res = mockRes();
  await androidGatewayAuth(req, res, () => {});
  ok(res._c === 401 && res._body?.code === 'PIN_WRONG', `3-chi xato ham 401: ${res._c} ${res._body?.code}`);
  ok(res._body?.retryAfter === 30, `lekin blok boshlangani bildiriladi: retryAfter=${res._body?.retryAfter}`);
}

console.log('\n[6] Bloklangan paytda TO‘G‘RI PIN bilan ham kirib bo‘lmaydi');
{
  const req = { params: { pincode: pinA, restaurantId: String(restA._id) } };
  const res = mockRes();
  await androidGatewayAuth(req, res, () => { req._passed = true; });
  ok(res._c === 429 && !req._passed, `to‘g‘ri PIN ham blok davrida ishlamaydi: ${res._c}`);
}

console.log('\n[7] Blok tugagach — to‘g‘ri PIN ishlaydi, hisoblagich tozalanadi');
{
  // Vaqtni orqaga suramiz — blok "tugagan" holatni simulyatsiya qilamiz
  await Restaurant.updateOne({ _id: restA._id }, { 'androidGateway.pinBlockedUntil': new Date(Date.now() - 1000) });
  const req = { params: { pincode: pinA, restaurantId: String(restA._id) } };
  const res = mockRes();
  let nextCalled = false;
  await androidGatewayAuth(req, res, () => { nextCalled = true; });
  ok(nextCalled && req.restaurantId === String(restA._id), 'to‘g‘ri PIN — o‘tdi, req.restaurantId to‘g‘ri');
  /*
   * Muvaffaqiyatdan keyingi Restaurant.updateOne() ATAYLAB
   * kutilmaydi (androidGatewayAuth.js: "javobni kutmaymiz" —
   * so'rov tezligi uchun). Shuning uchun testda darhol o'qisak
   * poyga sharoiti (race condition) bo'ladi — real xato emas,
   * shunchaki yozuv hali yetib bormagan bo'lishi mumkin.
   */
  await wait();
  const fresh = await Restaurant.findById(restA._id).lean();
  ok(fresh.androidGateway.pinFails === 0 && !fresh.androidGateway.pinBlockedUntil,
    'muvaffaqiyatdan keyin hisoblagich va blok tozalandi');
  ok(fresh.androidGateway.lastAccessAt instanceof Date, 'lastAccessAt yozildi');
}

console.log('\n[8] IZOLYATSIYA: A restoranning PIN’i B’ning ID’siga ishlamaydi');
{
  const req = { params: { pincode: pinA, restaurantId: String(restB._id) } };
  const res = mockRes();
  await androidGatewayAuth(req, res, () => { req._passed = true; });
  // B da gateway umuman sozlanmagan — 404 (A ning PIN'i B'ga tegishli emasligi
  // tasdiqlanadi, qaysi sabab bilan bo'lishidan qat'i nazar o'tkazib yubormaydi)
  ok(res._c !== 200 && !req._passed, `A PIN B ID bilan ishlamadi: ${res._c}`);
}

/* B ham o'z PIN'ini olsin — izolyatsiyani to'liq sinash uchun */
let pinB;
{
  const req = { restaurantId: String(restB._id) };
  const res = mockRes();
  await restaurantPanelController.rotateAndroidPin(req, res, () => {});
  await wait();
  pinB = res._body?.pin;
}
console.log('\n[9] IZOLYATSIYA (ikkinchi tomon): B PIN’i A ID’si bilan ishlamaydi');
{
  const req = { params: { pincode: pinB, restaurantId: String(restA._id) } };
  const res = mockRes();
  await androidGatewayAuth(req, res, () => { req._passed = true; });
  ok(res._c === 401 && !req._passed, `B PIN A ID bilan rad etildi: ${res._c}`);
}

console.log('\n[10] orders() — faqat o‘z buyurtmasi, moliya qisqartirilgan');
{
  // req.query — real Expressda har doim {} bo'ladi (URL'da bo'lmasa ham)
  const req = { restaurantId: String(restA._id), query: {} };
  const res = mockRes();
  await restaurantPanelController.orders(req, res, () => {});
  await wait();
  const list = res._body || [];
  ok(list.length === 1 && String(list[0]._id) === String(orderA._id), `faqat A ning buyurtmasi: ${list.length} ta`);
  ok(!('lokmaNetCommission' in (list[0]?.finance || {})), 'ichki moliyaviy maydon (lokmaNetCommission) YO‘Q');
  ok(!('lokmaCashNet' in (list[0]?.finance || {})), 'ichki moliyaviy maydon (lokmaCashNet) YO‘Q');
  ok(list[0]?.finance?.restaurantPayout === 45000, `restaurantPayout to‘g‘ri (so‘mda): ${list[0]?.finance?.restaurantPayout}`);
  ok(list[0]?.customer?.name === 'Aziz', `mijoz nomi shakllangan: "${list[0]?.customer?.name}"`);
}

console.log('\n[11] orderDetail() — boshqa restoran buyurtmasini OLIB BO‘LMAYDI');
{
  const req = { params: { id: String(orderB._id) }, restaurantId: String(restA._id) };
  const res = mockRes();
  await restaurantPanelController.orderDetail(req, res, () => {});
  await wait();
  ok(res._c === 404, `A restorani B ning buyurtmasini so‘rasa 404: ${res._c}`);
}
{
  const req = { params: { id: String(orderA._id) }, restaurantId: String(restA._id) };
  const res = mockRes();
  await restaurantPanelController.orderDetail(req, res, () => {});
  await wait();
  ok(res._body && String(res._body._id) === String(orderA._id), 'o‘z buyurtmasini to‘g‘ri oladi');
}

console.log('\n[12] updateOrderStatus() — boshqa restoran buyurtmasini O‘ZGARTIRIB BO‘LMAYDI');
{
  const req = { params: { id: String(orderB._id) }, body: { status: 'accepted' }, restaurantId: String(restA._id) };
  const res = mockRes();
  await restaurantPanelController.updateOrderStatus(req, res, () => {});
  await wait();
  ok(res._c === 404, `A restorani B ning buyurtmasini o‘zgartira olmaydi: ${res._c}`);
  const stillPending = await Order.findById(orderB._id).lean();
  ok(stillPending.status === 'pending', 'B ning buyurtmasi o‘zgarmagan');
}
{
  const req = { params: { id: String(orderA._id) }, body: { status: 'accepted' }, restaurantId: String(restA._id) };
  const res = mockRes();
  await restaurantPanelController.updateOrderStatus(req, res, () => {});
  await wait();
  const updated = await Order.findById(orderA._id).lean();
  ok(updated.status === 'accepted', `o‘z buyurtmasini o‘zgartira oladi: ${updated.status}`);
}

console.log('\n[13] profile() — PIN hash HECH QACHON javobda yo‘q');
{
  const req = { restaurantId: String(restA._id) };
  const res = mockRes();
  await restaurantPanelController.profile(req, res, () => {});
  await wait();
  /*
   * `res._body` — Mongoose hujjati (profile .lean() ishlatmaydi).
   * `in` operatori sxema darajasidagi getterlarni ham ko'radi va
   * noto'g'ri natija berishi mumkin — shuning uchun haqiqiy
   * JSON.stringify (Express res.json ICHIDA aynan shuni qiladi)
   * orqali tekshiramiz: simda maydon umuman yo'qligini bildiradi.
   */
  const wire = JSON.stringify(res._body);
  ok(!wire.includes('androidGateway') && !wire.includes('pinHash'),
    'profil javobida (haqiqiy JSON) androidGateway/pinHash umuman yo‘q');
}

console.log('\n[14] androidGatewayStatus() — holat ko‘rinadi, PIN o‘zi ko‘rinmaydi');
{
  const req = { restaurantId: String(restA._id) };
  const res = mockRes();
  await restaurantPanelController.androidGatewayStatus(req, res, () => {});
  await wait();
  ok(res._body?.enabled === true, 'enabled: true');
  ok(!('pin' in (res._body || {})) && !('pinHash' in (res._body || {})), 'pin/pinHash javobda yo‘q');
}

console.log('\n[15] disableAndroidPin() — o‘chirilgach gateway darhol ishlamaydi');
{
  const req = { restaurantId: String(restA._id) };
  await restaurantPanelController.disableAndroidPin(req, mockRes(), () => {});
  await wait();
  const check = { params: { pincode: pinA, restaurantId: String(restA._id) } };
  const res = mockRes();
  await androidGatewayAuth(check, res, () => { check._passed = true; });
  ok(res._c === 404 && !check._passed, `o‘chirilgandan keyin 404: ${res._c}`);
}

console.log('\n[16] verifyAndroidPin() — socket uchun ishlatiladigan funksiya, B PIN’i bilan B ID’si ishlaydi');
{
  const result = await verifyAndroidPin(String(restB._id), pinB);
  ok(result.ok === true && result.restaurant._id === String(restB._id), 'to‘g‘ri PIN+ID — muvaffaqiyat');
  const bad = await verifyAndroidPin(String(restB._id), '1111');
  ok(bad.ok === false && bad.status === 401, `noto‘g‘ri PIN — rad: ${bad.status}`);
}

console.log(fails ? `\n✗ ${fails} ta xato` : '\n✓ HAMMASI O‘TDI');
await mongoose.disconnect();
process.exit(fails ? 1 : 0);
