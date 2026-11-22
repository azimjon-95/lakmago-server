// Banner/reklama tuman filtri — services/bannerDistrict.js (toza funksiyalar).  npm run test:banner-district
import assert from 'node:assert/strict';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(48);
process.env.DISTRICT_BOUNDARIES_ENABLED = 'true';
process.env.DISTRICT_CATALOG_FILTER_ENABLED = 'true';
process.env.DISTRICT_CATALOG_LEGACY_POLICY = 'show';
const { config } = await import('../src/config/index.js');
const { restaurantInDistrict, linkedRestaurantId, bannerVisibleInDistrict, sanitizeDistrictIds } = await import('../src/services/bannerDistrict.js');
const { supportedDistrictIds } = await import('../src/services/districtResolver.js');
let n = 0; const t = (name, fn) => { fn(); n += 1; console.log('  ✓', name); };

const POP = { serviceDistrictId: 'pop', serviceAreaDistrictIds: ['pop'] };
const CHUST = { serviceDistrictId: 'chust', serviceAreaDistrictIds: ['chust', 'pop'] };   // Popga ham xizmat qiladi
const NULLD = { serviceDistrictId: null };                                                 // migratsiyada aniqlanmagan
const LEGACY = {};                                                                         // migratsiya qilinmagan
const A = 'aaaaaaaaaaaaaaaaaaaaaaaa'; const B = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const map = new Map([[A, POP], [B, CHUST]]);

t('restoran tumani: o‘z tumani, xizmat hududi, aniqlanmagan', () => {
  assert.ok(restaurantInDistrict(POP, 'pop')); assert.ok(!restaurantInDistrict(POP, 'chust'));
  assert.ok(restaurantInDistrict(CHUST, 'pop'));
  assert.ok(!restaurantInDistrict(NULLD, 'pop'));
});
t('migratsiya qilinmagan restoran — legacyPolicy (show/hide)', () => {
  const old = config.district.legacyPolicy;
  config.district.legacyPolicy = 'show'; assert.ok(restaurantInDistrict(LEGACY, 'uychi'));
  config.district.legacyPolicy = 'hide'; assert.ok(!restaurantInDistrict(LEGACY, 'uychi'));
  config.district.legacyPolicy = old;
});
t('bog‘langan restoran: restaurantId yoki linkUrl /restaurant/<id>', () => {
  assert.equal(linkedRestaurantId({ restaurantId: A }), A);
  assert.equal(linkedRestaurantId({ linkUrl: `https://lokma.uz/restaurant/${B}?x=1` }), B);
  assert.equal(linkedRestaurantId({ linkUrl: `/restaurant/${B.toUpperCase()}` }), B);
  assert.equal(linkedRestaurantId({ linkUrl: '/market' }), null);
  assert.equal(linkedRestaurantId({ linkUrl: `/restaurant/${A}x` }), null);
});
t('tuman yo‘q — hamma banner ko‘rinadi (eski xatti-harakat)', () => {
  assert.ok(bannerVisibleInDistrict({ districtIds: ['chust'] }, null, map));
});
t('admin tanlagan tumanlar ustun', () => {
  const b = { districtIds: ['chust'], linkUrl: `/restaurant/${A}` };   // restoran Popda, lekin admin Chust dedi
  assert.ok(bannerVisibleInDistrict(b, 'chust', map)); assert.ok(!bannerVisibleInDistrict(b, 'pop', map));
});
t('restoran banneri — faqat o‘sha restoran tumanida', () => {
  const b = { linkUrl: `/restaurant/${A}` };
  assert.ok(bannerVisibleInDistrict(b, 'pop', map)); assert.ok(!bannerVisibleInDistrict(b, 'chust', map));
});
t('umumiy banner (restoransiz, tumansiz) — hamma tumanda; bo‘sh districtIds ham umumiy', () => {
  assert.ok(bannerVisibleInDistrict({ linkUrl: '/market' }, 'uychi', map));
  assert.ok(bannerVisibleInDistrict({ districtIds: [] }, 'uychi', map));
});
t('bog‘langan restoran topilmasa — ko‘rinadi (hech narsa yo‘qolmaydi)', () => {
  assert.ok(bannerVisibleInDistrict({ restaurantId: 'cccccccccccccccccccccccc' }, 'pop', map));
});
t('admin kiritmasi tozalanadi', () => {
  assert.deepEqual(sanitizeDistrictIds(undefined), { value: undefined });
  assert.deepEqual(sanitizeDistrictIds(null), { value: [] });
  assert.ok(sanitizeDistrictIds('pop').error);
  assert.ok(sanitizeDistrictIds(['Pop; drop']).error);
  assert.ok(sanitizeDistrictIds([{ $ne: 1 }]).error);
  const known = supportedDistrictIds();
  if (known.length) {
    assert.deepEqual(sanitizeDistrictIds([known[0], known[0]]), { value: [known[0]] });
    assert.ok(sanitizeDistrictIds(['atlantida']).error);
  }
});
console.log(`banner-district: ${n} ta test o'tdi`);

// ── Kontroller darajasi: GET /banners va GET /ads/banner (modellar soxtalashtirilgan, DB kerak emas) ──
const { Banner } = await import('../src/models/User.js');
const { Restaurant } = await import('../src/models/Restaurant.js');
const { Ad } = await import('../src/models/Ad.js');
const { bannerController } = await import('../src/controllers/misc.js');
const { publicAdsController } = await import('../src/controllers/ads.js');
const q = (rows) => { const c = { sort: () => c, limit: () => c, populate: () => c, select: () => c, lean: async () => rows }; return c; };
const BANNERS = [
  { _id: '1', kind: 'platform', linkUrl: `/restaurant/${A}` },          // Pop restorani
  { _id: '2', kind: 'platform', linkUrl: `/restaurant/${B}` },          // Chust (+Pop xizmat hududi)
  { _id: '3', kind: 'platform', linkUrl: '' },                          // umumiy
  { _id: '4', kind: 'platform', districtIds: ['uychi'] },               // admin: faqat Uychi
];
Banner.find = () => q(BANNERS);
Restaurant.find = () => q([{ _id: A, ...POP }, { _id: B, ...CHUST }]);
const call = (h, query) => new Promise((resolve, reject) => { h({ query }, { json: resolve, status() { return this; }, set() { return this; } }, reject); });
const ids = (arr) => arr.map((b) => b._id).join(',');

const flags = { f: config.district.catalogFilterEnabled };
config.district.catalogFilterEnabled = true;
const featOn = supportedDistrictIds().length > 0;
if (featOn && supportedDistrictIds().includes('pop') && supportedDistrictIds().includes('chust')) {
  await (async () => {
    t('GET /banners?district=pop — Pop restorani, Popga xizmat qiluvchi Chust, umumiy; Uychi banneri YO‘Q', () => {});
    assert.equal(ids(await call(bannerController.list, { district: 'pop' })), '1,2,3');
    assert.equal(ids(await call(bannerController.list, { district: 'chust' })), '2,3');
    assert.equal(ids(await call(bannerController.list, { district: 'uychi' })), '3,4');
    t('GET /banners (tumansiz) va noma’lum tuman — hammasi (eski server/klient kabi)', () => {});
    assert.equal(ids(await call(bannerController.list, {})), '1,2,3,4');
    assert.equal(ids(await call(bannerController.list, { district: 'atlantida' })), '1,2,3,4');
    config.district.catalogFilterEnabled = false;
    t('flag o‘chiq — ?district= e‘tiborsiz', () => {});
    assert.equal(ids(await call(bannerController.list, { district: 'chust' })), '1,2,3,4');
    config.district.catalogFilterEnabled = true;

    const ad = (id, rest) => ({ _id: id, status: 'approved', imageUrl: 'x', targetType: 'restaurant', restaurantId: { _id: id, name: id, isActive: true, isBlocked: false, kind: 'restaurant', ...rest } });
    Ad.find = () => q([ad('a1', POP), ad('a2', CHUST), ad('a3', { serviceDistrictId: 'uychi', serviceAreaDistrictIds: ['uychi'] })]);
    t('GET /ads/banner?district=chust — faqat Chust restorani reklamasi', () => {});
    assert.deepEqual((await call(publicAdsController.banner, { district: 'chust' })).map((a) => a.id), ['a2']);
    assert.deepEqual((await call(publicAdsController.banner, { district: 'pop' })).map((a) => a.id), ['a1', 'a2']);
    assert.deepEqual((await call(publicAdsController.banner, {})).map((a) => a.id), ['a1', 'a2', 'a3']);
  })();
} else {
  console.log('  (chegaralar fayli yo‘q — kontroller testlari o‘tkazib yuborildi)');
}
config.district.catalogFilterEnabled = flags.f;
console.log(`banner-district: jami ${n} ta tekshiruv o'tdi`);
