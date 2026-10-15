/*
 * BUYURTMA KUZATUVI — haqiqiy ETA, vaqt chizig'i, kuryer ma'lumoti, maxfiylik.
 * Baza KERAK EMAS (sof funksiyalar). npm run test:track
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(40);
const { buildSteps, estimateEta, courierView, travelMinutes, haversineKm, TRACK } = await import('../src/services/orderTrack.js');
const { haversineMeters } = await import('../src/services/courierDispatch.js');

let fails = 0;
const ok = (c, m) => { console.log(c ? '  ✓' : '  ✗ FAIL:', m); if (!c) fails++; };
const MIN = 60_000;
const NOW = Date.now();
const ago = (m) => new Date(NOW - m * MIN);
const base = { status: 'accepted', fulfillment: 'delivery', createdAt: ago(10), acceptedAt: ago(5) };

console.log('\n[1] Masofa va yo‘l vaqti');
{
  const d = haversineKm({ lat: 41.3111, lng: 69.2405 }, { lat: 41.3211, lng: 69.2405 });
  ok(d > 1.05 && d < 1.17, `1° ≈ 0.01 kenglik ≈ 1.11 km (${d.toFixed(2)})`);
  ok(Math.round(haversineMeters({ lat: 41.3, lng: 69.2 }, { lat: 41.3, lng: 69.2 })) === 0, 'bir xil nuqta — 0 m');
  ok(travelMinutes(1.2) === 4 && travelMinutes(5) === 17, `yo‘l vaqti masofaga mos (1.2 km → ${travelMinutes(1.2)}, 5 km → ${travelMinutes(5)} daq)`);
  ok(travelMinutes(null) === 10 && travelMinutes(0) === 10, 'masofa noma’lum — 10 daq');
  ok(travelMinutes(500) === 90, 'juda uzoq — 90 daq bilan chegaralangan');
}

console.log('\n[2] Vaqt chizig‘i (haqiqiy vaqt belgilari)');
{
  let r = buildSteps({ ...base, status: 'accepted' });
  ok(r.steps.map((s) => s.key).join() === 'accepted,preparing,delivering,arrived,delivered', 'yetkazish: 5 qadam (qabul, tayyorlash, kuryer yo‘lda, yetib keldi, tugadi)');
  ok(r.current === 'accepted' && r.steps[0].active && !r.steps[0].done, 'qabul qilindi — faol');
  ok(r.steps[0].at === base.acceptedAt.toISOString() && r.steps[1].at === null, 'vaqt faqat haqiqiy bo‘lsa (tayyorlanish vaqti hali yo‘q — null)');
  r = buildSteps({ ...base, status: 'preparing', preparingAt: ago(3) });
  ok(r.current === 'preparing' && r.steps[0].done && r.steps[1].active && r.steps[1].at, 'tayyorlanmoqda: birinchi qadam bajarilgan, vaqti bor');
  r = buildSteps({ ...base, status: 'ready', preparingAt: ago(3), readyAt: ago(1) });
  ok(r.current === 'preparing', 'tayyor, kuryer hali olmagan — "tayyorlanmoqda" qadamida (yolg‘on "yo‘lda" yo‘q)');
  r = buildSteps({ ...base, status: 'delivering', deliveringAt: ago(2) });
  ok(r.current === 'delivering' && r.steps[2].active && r.steps[1].done, 'kuryer yo‘lda — 3-qadam faol');
  r = buildSteps({ ...base, status: 'delivering', deliveringAt: ago(5), arrivedAt: ago(1) });
  ok(r.current === 'arrived' && r.steps[3].active && r.steps[2].done, 'GPS yetib kelganini aniqlasa — "yetib keldi"');
  r = buildSteps({ ...base, status: 'delivered', deliveredAt: ago(0) });
  ok(r.steps.every((s) => s.done) && !r.steps.some((s) => s.active), 'tugadi — hammasi bajarilgan');
  r = buildSteps({ ...base, fulfillment: 'pickup', status: 'ready' });
  ok(r.steps.map((s) => s.key).join() === 'accepted,preparing,ready,delivered' && r.current === 'ready', 'olib ketish: kuryersiz 4 qadam');
}

console.log('\n[3] Taxminiy yetib kelish vaqti — HISOBLANGAN');
{
  const ctx = { prepMinutes: 20, distanceKm: 1.2, now: NOW };
  let e = estimateEta({ ...base, status: 'accepted', acceptedAt: ago(5) }, ctx);
  ok(e.minutes === 15 + 4 && e.basis === 'estimate', `qabul qilingan, 5 daq o‘tgan: 15 (tayyorlash) + 4 (yo‘l) = ${e.minutes}`);
  e = estimateEta({ ...base, status: 'preparing', acceptedAt: ago(40) }, ctx);
  ok(e.minutes === 2 + 4, `tayyorlash muddati o‘tib ketgan — kamida 2 daq + yo‘l (${e.minutes})`);
  e = estimateEta({ ...base, status: 'ready' }, ctx);
  ok(e.minutes === 4 + TRACK.courierWaitMin, `tayyor, kuryer kutilmoqda: yo‘l + ${TRACK.courierWaitMin} daq (${e.minutes})`);
  e = estimateEta({ ...base, status: 'delivering', deliveringAt: ago(1) }, ctx);
  ok(e.minutes === 3 && e.basis === 'estimate', `yo‘lda, joylashuv yo‘q: yo‘l vaqti − o‘tgan (${e.minutes})`);
  const live = estimateEta({ ...base, status: 'delivering', deliveringAt: ago(1) }, { ...ctx, courierPoint: { lat: 41.31, lng: 69.24 }, customerPoint: { lat: 41.32, lng: 69.24 } });
  ok(live.basis === 'live' && live.minutes >= 3 && live.minutes <= 5, `kuryer joylashuvi bor: qolgan masofa bo‘yicha jonli (${live.minutes} daq, basis=live)`);
  e = estimateEta({ ...base, status: 'delivering', arrivedAt: ago(0) }, ctx);
  ok(e.minutes === 0, 'kuryer yetib kelgan — 0 daq');
  e = estimateEta({ ...base, status: 'delivered' }, ctx);
  ok(e.minutes === null && e.at === null, 'yakunlangan — ETA yo‘q');
  e = estimateEta({ ...base, status: 'cancelled' }, ctx);
  ok(e.minutes === null, 'bekor qilingan — ETA yo‘q');
  e = estimateEta({ ...base, status: 'accepted' }, { now: NOW });
  ok(e.minutes === 10 + 10, `taom vaqti/masofa noma’lum — standart (15 − 5 o‘tgan + 10 yo‘l) = ${e.minutes}`);
  e = estimateEta({ ...base, timingMode: 'scheduled', scheduledFor: new Date(NOW + 90 * MIN) }, ctx);
  ok(e.basis === 'scheduled' && e.minutes === 90, 'rejalashtirilgan buyurtma — belgilangan vaqt');
  e = estimateEta({ ...base, fulfillment: 'pickup', status: 'accepted', acceptedAt: ago(5) }, ctx);
  ok(e.minutes === 15, `olib ketish: faqat tayyorlash vaqti (${e.minutes})`);
}

console.log('\n[4] Kuryer ma’lumoti va maxfiylik');
{
  const asg = (over = {}) => ({ status: 'assigned', courier: { name: 'Abdulloh', phone: '+998901112233', vehicle: 'scooter' }, location: { lat: 41.3, lng: 69.2, heading: 90, at: new Date(NOW - 20_000) }, ...over });
  ok(courierView(null, base, null, NOW) === null, 'kuryer yo‘q — null');
  ok(courierView({ status: 'searching' }, base, null, NOW) === null, 'qidirilmoqda — null');
  ok(courierView(asg({ courier: { name: '', phone: '' } }), base, null, NOW) === null, 'ismi kiritilmagan kuryer — ko‘rsatilmaydi (soxta ism yo‘q)');
  let c = courierView(asg(), { ...base, status: 'delivering' }, { deliveries: 324, rating: 4.86, ratingCount: 120 }, NOW);
  ok(c.name === 'Abdulloh' && c.phone === '+998901112233' && c.vehicleLabel === 'Skuter', 'yo‘lda: ism, telefon, transport');
  ok(c.deliveries === 324 && c.rating === 4.9 && c.ratingCount === 120, 'real statistika: 324 ta yetkazib berish, reyting 4.9');
  ok(c.location && c.location.lat === 41.3, 'yangi joylashuv ko‘rsatiladi');
  c = courierView(asg(), { ...base, status: 'ready' }, { deliveries: 3, rating: 5, ratingCount: 2 }, NOW);
  ok(c.phone === null && c.location === null, 'tayyor, hali yo‘lga chiqmagan — telefon va joylashuv BERILMAYDI');
  ok(c.rating === null && c.deliveries === 3, `baholar ${TRACK.minRatingCount} tadan kam — reyting ko‘rsatilmaydi (ishonchsiz)`);
  c = courierView(asg({ location: { lat: 41.3, lng: 69.2, at: new Date(NOW - 5 * MIN) } }), { ...base, status: 'delivering' }, null, NOW);
  ok(c.location === null, 'joylashuv 5 daqiqa eski — ko‘rsatilmaydi (eskirgan nuqta yolg‘on joyni ko‘rsatmasin)');
  const keys = Object.keys(courierView(asg(), { ...base, status: 'delivering' }, null, NOW));
  ok(!keys.some((k) => /secret|token|snapshot/i.test(k)), 'maxfiy maydonlar (token/secret) javobda yo‘q');
}

console.log('\n[5] To‘liq javob (modellar soxta): maxfiylik va shakl');
{
  const { Order } = await import('../src/models/Order.js');
  const { Dish } = await import('../src/models/Dish.js');
  const { Restaurant } = await import('../src/models/Restaurant.js');
  const { DeliveryAssignment } = await import('../src/models/DeliveryAssignment.js');
  const { getOrderTrack } = await import('../src/services/orderTrack.js');
  const chain = (v) => { const c = { select: () => c, sort: () => c, limit: () => c, lean: async () => v }; return c; };
  const doc = { _id: 'a'.repeat(24), groupId: 'G1790936916585187', userId: 'u1', restaurantId: 'r1', status: 'delivering', fulfillment: 'delivery',
    createdAt: ago(20), acceptedAt: ago(18), preparingAt: ago(12), deliveringAt: ago(4), addressLat: 41.3, addressLng: 69.25, address: 'Mirzo Ulug‘bek 12',
    items: [{ dishId: 'd1', name: 'Rafaelo «Romantik»', quantity: 1, unitPrice: 85000 }], subtotal: 85000, deliveryFee: 25000, total: 110000, distanceKm: 1.2, paymentMethod: 'cash' };
  let seenFilter = null;
  Order.findOne = (f) => { seenFilter = f; return chain(f.userId === 'u1' ? doc : null); };
  Order.aggregate = async () => [{ avg: 4.9, n: 120 }];
  Restaurant.findById = () => chain({ _id: 'r1', name: 'TOTLI Tortlari', imageUrl: 'https://x/r.jpg', address: 'Amir Temur 5', phone: '+998712000000', lat: 41.31, lng: 69.24 });
  Dish.find = () => chain([{ _id: 'd1', imageUrl: 'https://x/d.jpg', prepMinutes: 20 }]);
  DeliveryAssignment.findOne = () => chain({ status: 'assigned', token: 'SECRET_TOKEN', acceptanceSecret: 'SECRET', courier: { name: 'Abdulloh', phone: '+998901112233', vehicle: 'scooter' }, location: { lat: 41.305, lng: 69.245, at: new Date(NOW - 5000) } });
  DeliveryAssignment.find = () => chain(Array.from({ length: 324 }, (_, i) => ({ orderId: `o${i}` })));
  const r = await getOrderTrack(doc._id, 'u1', NOW);
  ok(r && r.groupId === 'G1790936916585187' && r.status === 'delivering' && r.currentStep === 'delivering', 'asosiy maydonlar');
  ok(seenFilter.userId === 'u1', 'buyurtma FAQAT egasi uchun qidiriladi');
  ok((await getOrderTrack(doc._id, 'boshqa', NOW)) === null, 'boshqa mijoz — null (404)');
  ok(r.restaurant.name === 'TOTLI Tortlari' && r.restaurant.point.lat === 41.31 && r.restaurant.phone, 'restoran: nom, nuqta, telefon');
  ok(r.customer.point.lng === 69.25 && r.distanceKm === 1.2, 'mijoz nuqtasi va masofa (buyurtmadagi real qiymat)');
  ok(r.courier.name === 'Abdulloh' && r.courier.deliveries === 324 && r.courier.rating === 4.9 && r.courier.location, 'kuryer: ism, 324 yetkazib berish, reyting 4.9, joylashuv');
  ok(r.eta.basis === 'live' && r.eta.minutes >= 1, `jonli ETA (${r.eta.minutes} daq)`);
  ok(r.items[0].imageUrl === 'https://x/d.jpg' && r.items[0].total === 85000, 'taom rasmi va summa');
  ok(r.subtotal === 85000 && r.deliveryFee === 25000 && r.total === 110000, 'summalar');
  const json = JSON.stringify(r);
  ok(!/SECRET|token|acceptanceSecret|finance|telegramId/i.test(json), 'javobda maxfiy ma’lumot (token, secret, moliya) YO‘Q');
}

console.log('\n[6] Qabul qilinmagan buyurtmada "Qabul qilindi" vaqti yo‘q');
{
  const r = buildSteps({ status: 'pending', fulfillment: 'delivery', createdAt: ago(3) });
  ok(r.steps[0].at === null && !r.steps[0].done && !r.steps[0].active, 'kutilmoqda: hech qaysi qadam bajarilmagan va vaqtsiz');
}

console.log('\n[7] Yo‘l chizig‘i: Yandex → OSRM → to‘g‘ri chiziq');
{
  const { routeBetween } = await import('../src/services/routeGeometry.js');
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('router.project-osrm.org')) return { ok: true, json: async () => ({ routes: [{ distance: 2900, duration: 480, geometry: { coordinates: [[69.24, 41.31], [69.245, 41.308], [69.25, 41.304]] } }] }) };
    return { ok: false, json: async () => ({}) };
  };
  let r = await routeBetween({ lat: 41.31, lng: 69.24 }, { lat: 41.304, lng: 69.25 });
  ok(r.source === 'osrm' && r.points.length === 3 && r.points[1][0] === 41.308, `OSRM: ko‘chalar bo‘ylab ${r.points.length} nuqta, [lat,lng] tartibida`);
  ok(r.distanceKm === 2.9 && r.durationMin === 8, 'masofa va vaqt');
  globalThis.fetch = async () => { throw new Error('network'); };
  r = await routeBetween({ lat: 41.2, lng: 69.1 }, { lat: 41.21, lng: 69.11 });
  ok(r.source === 'straight' && r.points.length === 2, 'tarmoq yo‘q — to‘g‘ri chiziq (ilova shunga qarab chizadi)');
  globalThis.fetch = realFetch;
}

console.log(fails ? `\n✗ ${fails} ta xato` : '\n✓ Hammasi o‘tdi');
process.exit(fails ? 1 : 0);
