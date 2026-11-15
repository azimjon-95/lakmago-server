# Tuman chegaralari: avtomatik tuman aniqlash va katalog filtri

Holat: kod tayyor, **hammasi flag bilan O'CHIQ**. Deploy qilinganda production xatti-harakati o'zgarmaydi.

## Nima qo'shildi

| Qism | Fayl |
|---|---|
| Chegaralar (12 poligon, 192 KB) | `data/uzbekistan/namangan-districts.geojson` (+ audit, README) |
| Ajratish/audit skripti | `scripts/extract-district-boundaries.js` |
| Kod ↔ tuman kaliti jadvali | `src/constants/districtBoundaryMap.js` |
| Nuqta-poligon (kutubxonasiz) | `src/lib/geo.js` |
| Resolver | `src/services/districtResolver.js` |
| Restoran katalog hududi | `src/services/restaurantDistrict.js` |
| Katalog filtri | `src/services/catalogDistrict.js` |
| API | `src/controllers/location.js` |
| Migratsiya (dry-run standart) | `scripts/migrate-service-districts.js` |
| Testlar | `tests/district-resolver.test.mjs` (`npm run test:district`) |

`Restaurant.district` (kuryer tumani) ga **hech qayerda tegilmagan**.

## Ma'lumot auditi (versiya 1)

- 12/12 kod va nom mos (lotin/kirill/rus), geometriya yaroqli, teshik yo'q, har biri 1 poligonli MultiPolygon.
- Qamrov: viloyat ichida ~400 m to'r, 49 127 nuqta — bo'shliq **0**, ustma-ust **0**.
- **Davlatobod, Yangi Namangan — poligoni yo'q.** Avtomatik aniqlanmaydi; shahar ichidagi nuqta → `namangan_sh`. Katalog tanlagichida ham ko'rsatilmaydi (kuryer uchun avvalgidek ishlaydi).

## API

- `GET /api/location/resolve?lat=&lng=&lang=uz|uzc|ru` → `{ success, data: { districtId, districtName, matched, boundaryVersion, reason? } }`
  - `reason`: `OUTSIDE_COVERAGE`, `BOUNDARY_UNCERTAIN` (chegaradan 50 m ichida yoki ustma-ust), 400 — noto'g'ri koordinata, 503 — resolver o'chiq.
  - Rate limit: 30/daqiqa/IP. Koordinata logga yozilmaydi.
- `GET /api/districts` — javob avvalgidek; flag yoqilsa ixtiyoriy `boundaries` (`supported`, `noBoundary`, `autoDetect`, `catalogFilterEnabled`).
- Katalog: `?district=chust` — `/restaurants`, `/market/stores`, `/dishes/trending|discounted|all`, `/market/products`, `/promotions`. Parametr yo'q yoki flag o'chiq — eski natija va eski kesh kaliti.
- Admin: `GET /api/admin/district-preview?lat=&lng=` (xodim), `PATCH /api/admin/restaurants/:id/service-district` `{ districtId|null, reason }` (faqat bosh admin, audit).
- `POST/PATCH /api/admin/restaurants`: ixtiyoriy `serviceAreaDistrictIds`. `serviceDistrictId` faqat server koordinatadan hisoblaydi.

## Sozlamalar (.env)

```
DISTRICT_BOUNDARIES_ENABLED=false          # resolver + /location/resolve
DISTRICT_BOUNDARIES_PATH=./data/uzbekistan/namangan-districts.geojson
DISTRICT_BOUNDARIES_VERSION=1              # fayl metadata.version bilan mos kelmasa — ishlatilmaydi
DISTRICT_AUTO_DETECT_ENABLED=false         # mijozga "avtomatik aniqlash" ruxsati (/districts orqali)
DISTRICT_AUTO_DETECT_MIN_ACCURACY_METERS=50
DISTRICT_AUTO_DETECT_CONFIRMATION_READINGS=2
DISTRICT_AUTO_DETECT_BOUNDARY_BUFFER_METERS=50
DISTRICT_CATALOG_FILTER_ENABLED=false      # ?district= filtri
DISTRICT_CATALOG_LEGACY_POLICY=show        # tumani hali yozilmagan eski restoranlar: show — hamma tumanda, hide — ko'rinmaydi
```
Mijoz (Vercel): `VITE_DISTRICT_SELECTOR_ENABLED`, `VITE_DISTRICT_AUTO_DETECT_ENABLED`. Admin: `VITE_DISTRICT_BOUNDARIES_ENABLED`.

## Yoqish tartibi (bosqichma-bosqich)

1. Server: `DISTRICT_BOUNDARIES_ENABLED=true` → restart. Tekshirish: `curl ".../api/location/resolve?lat=41.0035&lng=71.2378"` → chust.
2. `npm run district:migrate` (dry-run) → hisobotdagi "ko'rib chiqish" ro'yxati. Keyin `npm run district:migrate -- --apply` (zaxira `backups/` ga).
3. Admin: tumani aniqlanmagan restoranlar nuqtasini tuzatish yoki bosh admin override.
4. `DISTRICT_CATALOG_FILTER_ENABLED=true` → restart. Eski mijozlar (`district` yubormaydi) eski natijani oladi.
5. Mijoz: `VITE_DISTRICT_SELECTOR_ENABLED=true` (Vercel) — header'da tuman tanlagich.
6. `DISTRICT_AUTO_DETECT_ENABLED=true` (server) + `VITE_DISTRICT_AUTO_DETECT_ENABLED=true` (mijoz) — avtomatik almashish.

## Orqaga qaytarish

- Flaglarni `false` qilib restart → eski xatti-harakat. Yangi maydonlar ixtiyoriy, eski kod ularni o'qimaydi.
- Migratsiya: `npm run district:migrate -- --rollback=backups/service-districts-<vaqt>.json`.

## Hali qilinmagan (qaror kerak)

- Buyurtma/yetkazish narxida `serviceAreaDistrictIds` tekshiruvi qo'shilmadi — hozirgi masofa (radius) qoidalari amal qiladi. Tumanlararo yetkazish siyosati aniqlangach alohida flag bilan qo'shiladi.
- Ma'lumot yangi versiyasi: skriptni qayta ishga tushirib, auditni ko'rib, `DISTRICT_BOUNDARIES_VERSION`ni oshirib alohida chiqariladi.
