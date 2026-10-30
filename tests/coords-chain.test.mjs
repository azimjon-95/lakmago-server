/*
 * ═══════════════════════════════════════════════════════════
 * SAVATDAN KURYERGACHA — KOORDINATA ZANJIRI
 * ═══════════════════════════════════════════════════════════
 *
 * Mijoz savatda tanlagan manzilning koordinatasi BESH bosqichdan
 * o'tadi. Bironta joyda uzilsa, kuryer "Yo'l ko'rsatish" tugmasini
 * bosganda manzil MATNI bo'yicha qidiruv ochilib, butunlay boshqa
 * shaharga olib borishi mumkin (avval shunday bo'lgan).
 *
 *   1. POST /api/orders           — so'rov tanasida
 *   2. orders hujjati             — addressLat/addressLng
 *   3. deliverySnapshot           — kuryerga ulashilganda
 *   4. Kuryer API javobi          — qabul qilgandan KEYIN
 *   5. Xarita havolasi            — Google/Yandex/Apple
 *
 * DIQQAT: `asyncHandler` promise qaytarmaydi, shuning uchun
 * har chaqiruvdan keyin qisqa kutish bor.
 *
 * Ishga tushirish: npm run test:coords
 */
process.env.MONGO_URI='mongodb://127.0.0.1:27017/lokma_e2e';
process.env.JWT_SECRET='x'.repeat(40); process.env.NODE_ENV='development';
process.env.RESTAURANT_BOT_TOKEN='1:X';
globalThis.fetch=async()=>({status:200,json:async()=>({ok:true,result:{message_id:1}})});

const mongoose=(await import('mongoose')).default;
await mongoose.connect(process.env.MONGO_URI); await mongoose.connection.db.dropDatabase();
const {Restaurant}=await import('../src/models/Restaurant.js');
const {Dish}=await import('../src/models/Dish.js');
const {User}=await import('../src/models/User.js');
const {Order}=await import('../src/models/Order.js');
const {CommissionAgreement}=await import('../src/models/CommissionAgreement.js');
const {orderController}=await import('../src/controllers/misc.js');
const {createShareLink}=await import('../src/services/courierDispatch.js');
const {DeliveryAssignment}=await import('../src/models/DeliveryAssignment.js');

let f=0; const ok=(c,m)=>{console.log(c?'  ✓':'  ✗ FAIL:',m); if(!c)f++;};

// MIJOZ TANLAGAN MANZIL (Toshkent, Chilonzor)
const LAT=41.2856, LNG=69.2034;

/*
 * Ish vaqti 00:00–23:59: test SUTKANING ISTALGAN paytida
 * ishlashi kerak. Avval standart 09:00–23:00 qolgandi va test
 * kechqurun ishga tushirilganda "restoran yopiq" deb yiqilardi.
 */
const rest=await Restaurant.create({name:'TOTLI',cuisine:'milliy',category:'restoran',
  lat:41.3111,lng:69.2797,deliveryEnabled:true,deliveryFee:15000,
  delivery:{maxDistanceKm:0},address:'Sang senter',
  openTime:'00:00',closeTime:'23:59',isActive:true,isApproved:true,
  workingDays:['mon','tue','wed','thu','fri','sat','sun']});
await CommissionAgreement.create({restaurantId:rest._id,restaurantCommissionPercent:10,
  customerFeePercent:0,effectiveFrom:new Date()});
const dish=await Dish.create({restaurantId:rest._id,section:'menu',name:'Pasta',price:10000});
const user=await User.create({firstName:'Azimjon',telegramId:'55',phone:'+998901112233',
  addresses:[{label:'Uy',address:'улица Сохил',lat:LAT,lng:LNG}]});

/* ═══ 1-BOSQICH: mijoz buyurtma berdi ═══ */
console.log('\n[1] Buyurtma yaratish — client koordinata yubordi');
let created=null, errorBody=null;
const req={ userId:String(user._id), user:{_id:user._id}, body:{
  address:'Uy — улица Сохил', phone:'+998901112233', paymentMethod:'cash',
  paymentLabel:'Naqd', fulfillment:'delivery', timingMode:'asap',
  addressLat:LAT, addressLng:LNG, addressNote:'2-qavat, xon. 6',
  orders:[{restaurantId:String(rest._id),restaurantName:'TOTLI',
    items:[{dishId:String(dish._id),name:'Pasta',quantity:1,unitPrice:10000}],
    subtotal:10000}],
}};
const res={
  status(c){ this._c=c; return this; },
  json(b){ if(this._c>=400) errorBody=b; else created=b; return this; },
};
try { await orderController.create(req,res,(e)=>{errorBody={next:e?.message,stack:e?.stack?.split('\n')[1]}}); }
catch(e){ errorBody={thrown:e.message, at:e.stack?.split('\n')[1]}; }
/* asyncHandler promise'ni qaytarmaydi — ish fon rejimida tugaydi */
await new Promise((r)=>setTimeout(r,1200));
if(errorBody) console.log('    SABAB:', JSON.stringify(errorBody).slice(0,300));
ok(!!created,`buyurtma yaratildi ${errorBody?JSON.stringify(errorBody).slice(0,120):''}`);

/* ═══ 2-BOSQICH: bazadagi buyurtma ═══ */
console.log('\n[2] orders hujjatida koordinata');
const order=await Order.findOne({restaurantId:rest._id}).lean();
ok(order?.addressLat===LAT&&order?.addressLng===LNG,
  `addressLat/Lng: ${order?.addressLat}, ${order?.addressLng}`);
ok(typeof order?.addressLat==='number','son turida');
ok(order?.addressNote==='2-qavat, xon. 6',`izoh: "${order?.addressNote}"`);
ok(order?.deliveryFee===15000,`yetkazish narxi: ${order?.deliveryFee}`);

/* ═══ 3-BOSQICH: kuryerga ulashish ═══ */
console.log('\n[3] deliveryassignments.deliverySnapshot');
await Order.updateOne({_id:order._id},{status:'ready'});
const link=await createShareLink(order._id);
const asg=await DeliveryAssignment.findOne({orderId:order._id}).lean();
ok(asg?.deliverySnapshot?.lat===LAT&&asg?.deliverySnapshot?.lng===LNG,
  `snapshot: ${asg?.deliverySnapshot?.lat}, ${asg?.deliverySnapshot?.lng}`);
ok(asg?.deliverySnapshot?.restaurantLat===41.3111,
  `restoran koordinatasi ham bor: ${asg?.deliverySnapshot?.restaurantLat}`);

/* ═══ 4-BOSQICH: kuryer sahifasi ═══ */
console.log('\n[4] Kuryer API javobi');
const {courierPortalController:CP}=await import('../src/controllers/courier.js');
const pub={ params:{token:asg.token}, query:{}, body:{}, headers:{} };
let payload=null;
await CP.view(pub,{status(){return this},json(b){payload=b;return this}},()=>{});
await new Promise((r)=>setTimeout(r,300));
ok(payload?.order,'taklif ko‘rindi');
ok(payload.order.lat===undefined,'qabul qilmasdan oldin koordinata YASHIRIN (maxfiylik)');

// Kuryer qabul qildi
let accepted=null;
await CP.accept(
  {params:{token:asg.token},body:{name:'Kuryer',phone:'+998901234567'},headers:{}},
  {status(){return this},json(b){accepted=b;return this}},()=>{});
await new Promise((r)=>setTimeout(r,500));
ok(accepted?.secret,'kuryer qabul qildi');

let mine=null;
await CP.view(
  {params:{token:asg.token},query:{secret:accepted.secret},body:{},headers:{}},
  {status(){return this},json(b){mine=b;return this}},()=>{});
await new Promise((r)=>setTimeout(r,300));
ok(mine?.order?.lat===LAT&&mine?.order?.lng===LNG,
  `kuryerga koordinata bordi: ${mine?.order?.lat}, ${mine?.order?.lng}`);
ok(mine?.order?.restaurantLat===41.3111,'restoran nuqtasi ham bor');

/* ═══ 5-BOSQICH: xarita havolasi ═══ */
console.log('\n[5] Kuryer ilovasi xarita havolasini yasaydi');
const {googleMapsUrl,yandexMapsUrl,appleMapsUrl}=await import('/home/claude/lokma-courier/src/lib/maps.js');
const to={lat:mine.order.lat,lng:mine.order.lng};
const from={lat:41.29,lng:69.24};   // kuryerning joriy GPS
const g=googleMapsUrl(to,from);
ok(g.includes('destination=41.2856%2C69.2034'),`Google: mijoz nuqtasi`);
ok(g.includes('origin=41.29%2C69.24'),'Google: kuryer joylashuvidan');
ok(yandexMapsUrl(to,from).includes('41.2856'),'Yandex ishlaydi');
ok(appleMapsUrl(to,from).includes('daddr=41.2856'),'Apple ishlaydi');
ok(!g.includes('%D1%83%D0%BB')&&!/Сохил/.test(g),'manzil MATNI ishlatilmadi');

await mongoose.disconnect();
console.log(f?`\n✗ ${f} ta xato`:'\n✓ ZANJIR TO‘LIQ ISHLAYDI'); process.exit(f?1:0);
