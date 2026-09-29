# Android Gateway — BFF (servis-servis) ulash shartnomasi

Hammasi koddan va HAQIQIY server sinovlaridan (`npm run test:gateway`,
`npm run test:bff-events`). Boshqa hech qanday marshrut yo'q.

## Kirish

`/app/service/{restaurantId}/...` + sarlavha `x-gateway-key: <GATEWAY_SERVICE_KEY>`

| Holat | HTTP | `code` |
|---|---|---|
| Sozlanmagan (kalit yo'q / < 24 belgi / IP ro'yxati bo'sh) | 404 | — |
| IP ro'yxatda yo'q (kalit tekshirilmaydi) | 403 | `SERVICE_IP_DENIED` |
| Kalit yo'q / noto'g'ri | 401 | `SERVICE_KEY_INVALID` |
| 30 ta noto'g'ri kalit / 10 daq | 429 (+`Retry-After`) | `SERVICE_AUTH_BLOCKED` |
| restaurantId formati | 400 | `INVALID_RESTAURANT_ID` |
| Restoran yo'q | 404 | `RESTAURANT_NOT_FOUND` |
| Restoran bloklangan | 403 | `RESTAURANT_BLOCKED` |

PIN va IP `loginLimiter` bu yo'lda ISHLAMAYDI; biznes xatolari (400/404/409) kanalni
bloklamaydi. Restoranda PIN sozlangan bo'lishi SHART EMAS.
PIN yo'li (`/app/{pin}/{restaurantId}/...`) o'zgarmagan, xuddi shu marshrutlar.

## Marshrutlar (`{base}` = `/app/service/{restaurantId}`)

| Metod | Yo'l | Izoh |
|---|---|---|
| GET | `{base}` | Restoran profili |
| GET | `{base}/orders?status=` | Oxirgi 80 ta (yangisi birinchi). `pending` = `?status=pending` |
| GET | `{base}/orders/history?from&to&status&limit&cursor` | Sana (Toshkent kuni, ikkalasi kiradi) + sahifalash. `{items, nextCursor, hasMore}` |
| GET | `{base}/stats?from&to` | Bo'sh — bugun (Toshkent). created / delivered / cancelled alohida |
| GET | `{base}/orders/:id` | Bitta buyurtma |
| PATCH | `{base}/orders/:id/status` `{"status":"accepted"}` | Accept = `accepted`. Javob: buyurtma + `changed` |
| POST | `{base}/orders/:id/confirm-delivered` | Restoran "Yetkazildi" (eslatma yo'li) |

Barcha buyurtma javoblari BIR xil shaklda (`toPanelOrder`): `finance` so'mda, restoran
ko'rinishi; `customer` obyekti; `restaurantConfirm: {eligible, eligibleAt}|null`.

### Status o'tishlari
`pending → accepted → preparing → ready → delivering → delivered`; `accepted → ready`;
bekor: pending/accepted/preparing/ready dan. Yetkazib berishda `delivered` ni RESTORAN
PATCH bilan qo'ya olmaydi (kuryer/mijoz/avto/`confirm-delivered`); olib ketishda `ready → delivered` mumkin.
`delivering` ni kuryer havola orqali qabul qilganda ham o'zi qo'yadi.

### PATCH / confirm-delivered xatolari (`{error, code}`)
| HTTP | code | Ma'no |
|---|---|---|
| 200 `changed:true` | — | Shu so'rov o'zgartirdi |
| 200 `changed:false` | — | Allaqachon shu holatda (ikkinchi qurilma/qayta bosish). Xato EMAS |
| 409 | `RACE_LOST` | Aynan shu onda boshqa qurilma o'zgartirdi — GET bilan qayta o'qing |
| 409 | `CONFIRM_TOO_EARLY` (+`eligibleAt`) | Yetkazib berishda 30 daq o'tmagan |
| 409 | `ORDER_CANCELLED` | Bekor qilingan |
| 400 | `INVALID_STATUS` / `WRONG_STATE` | Noto'g'ri status / mumkin bo'lmagan o'tish |
| 404 | `NOT_FOUND` | Yo'q yoki boshqa restoranniki |

`confirm-delivered` yetkazib berishda: holatga o'tganidan `firstAfterMin` (30) daqiqa yoki
eslatma yuborilgan bo'lsa (`restaurantConfirm.eligible`). Olib ketishda vaqt sharti yo'q.

## Hodisalar (server → BFF)

`POST {BFF_BASE_URL}/internal/orders/events` · `x-webhook-secret: {BFF_WEBHOOK_SECRET}`
Body FAQAT `{"event","restaurantId","orderId"}`. Sarlavhalar: `x-event-id`, `x-event-attempt`.

| event | Qachon |
|---|---|
| `created` | Buyurtma restoranga ko'rindi (naqd: yaratilganda; karta: to'lov o'tgach). Yaratilgandan 1.5 s keyin |
| `updated` | accepted/preparing/ready/delivering; to'lov belgisi; yetkazish tasdig'i so'ralganda |
| `cancelled` | Bekor qilindi (kim qilganidan qat'i nazar) |
| `delivered` | Yetkazildi (restoran/kuryer/mijoz/avto-yakunlash) |

- Hodisa SIGNAL: tafsilotni `GET {base}/orders/:id` dan oling. Tartib kafolatlanmaydi.
- Kamida bir marta (at-least-once): 2xx bo'lmasa 5s, 15s, 45s, 2m, 5m, 10m, 15m… 12 urinish.
  Takroriy kelishi mumkin — `x-event-id` bilan ajrating. BFF o'zi qilgan o'zgarish uchun ham hodisa oladi.
- `created`/`cancelled`/`delivered` har buyurtma uchun 1 marta; ketma-ket `updated` birlashadi.
- Zal (dinein) va to'lanmagan (awaiting_payment) buyurtmalar uchun hodisa yo'q.
- BFF qaytgach o'tkazib yuborilganini `orders/history` bilan oling.

## Deploy
- `.env`: `GATEWAY_SERVICE_KEY` (openssl rand -hex 32), `GATEWAY_ALLOWED_IPS`, `BFF_BASE_URL`, `BFF_WEBHOOK_SECRET`.
- IP `req.ip` (trust proxy 1) dan olinadi: nginx `X-Forwarded-For $proxy_add_x_forwarded_for`
  qo'shishi va Node porti tashqaridan OCHIQ BO'LMASLIGI shart (aks holda IP ro'yxatini aldash mumkin).
- BFF Node'ga to'g'ridan-to'g'ri `127.0.0.1:4000` orqali ulansa, ro'yxatga `127.0.0.1` yoziladi.
- Nginx'da `/socket.io` va `/restaurant/v1` ni BFF ga yo'naltirish faqat gateway hostida (api.lokma.uz);
  asosiy API hostida `/socket.io` lakmago-server'da QOLISHI shart.
