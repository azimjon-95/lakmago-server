# To'lov tizimlari — ulash yo'riqnomasi

Kod tayyor, faqat kalitlarni `.env` ga qo'yish qoladi.

## Qaysi tizim tanlandi va nega

O'zbekistonda eng ko'p ishlatiladigan ikkitasi:

| Tizim | Ulush | Nima uchun |
|---|---|---|
| **Payme** | ~45% | Eng katta qamrov, ishonchli API |
| **Click** | ~40% | Ikkinchi o'rinda, Click Up ekotizimi |

Paynet uchinchi o'rinda va asosan kommunal to'lovlarda ishlatiladi —
ovqat yetkazishda kam uchraydi. Keyinroq qo'shish mumkin, arxitektura
tayyor.

## Muhim: yuridik talab

Ikkala tizimga ham **yuridik shaxs yoki YATT** nomidan ulanish mumkin.
Jismoniy shaxs ulanolmaydi.

Kerak bo'ladi: STIR, bank rekvizitlari, shartnoma.

---

## Payme

### 1. Ro'yxatdan o'tish
[business.payme.uz](https://business.payme.uz) → Merchant yaratish

### 2. Kabinetdan olinadi
```
Merchant ID       → PAYME_MERCHANT_ID
Kalit (key)       → PAYME_KEY
Test kalit        → PAYME_TEST_KEY
```

### 3. Kabinetga kiritiladi
```
Endpoint: https://api.SIZNING-DOMEN.uz/api/payments/payme
Kalit nomi (account): order_id
```

`order_id` — muhim. Biz shu nom bilan buyurtmani topamiz.

### 4. Qanday ishlaydi

Payme bizga JSON-RPC so'rov yuboradi, biz javob beramiz:

| Metod | Nima qiladi |
|---|---|
| `CheckPerformTransaction` | To'lov mumkinmi — buyurtma bor, summa to'g'ri |
| `CreateTransaction` | Tranzaksiya ochiladi |
| `PerformTransaction` | To'lov tasdiqlanadi, buyurtma `isPaid: true` |
| `CancelTransaction` | Bekor qilish yoki pul qaytarish |
| `CheckTransaction` | Holat so'raladi |
| `GetStatement` | Davr bo'yicha hisobot |

**Summa tiyinda** keladi: 25 000 so'm = `2500000`.

### 5. Sinov
Kabinetdagi "Песочница" bo'limida barcha metodlar tekshiriladi.
Hammasi yashil bo'lgach ishlab chiqarishga o'tkaziladi.

---

## Click

### 1. Ro'yxatdan o'tish
[merchant.click.uz](https://merchant.click.uz) → Xizmat yaratish

### 2. Kabinetdan olinadi
```
Service ID        → CLICK_SERVICE_ID
Merchant ID       → CLICK_MERCHANT_ID
Merchant User ID  → CLICK_MERCHANT_USER_ID
Secret Key        → CLICK_SECRET_KEY
```

### 3. Kabinetga kiritiladi
```
Prepare URL:  https://api.SIZNING-DOMEN.uz/api/payments/click/prepare
Complete URL: https://api.SIZNING-DOMEN.uz/api/payments/click/complete
```

### 4. Qanday ishlaydi

Ikki bosqich:

**Prepare** (`action=0`) — Click so'raydi: bu buyurtma bormi, summa
to'g'rimi? Biz `merchant_prepare_id` qaytaramiz.

**Complete** (`action=1`) — pul yechildi, tasdiqlang. Biz buyurtmani
`isPaid: true` qilamiz.

**Summa so'mda** keladi (Payme'dan farqli).

### 5. Imzo tekshiruvi

Har so'rovda `sign_string` bor — MD5 xesh:

```
Prepare:  md5(click_trans_id + service_id + SECRET + merchant_trans_id + amount + action + sign_time)
Complete: md5(click_trans_id + service_id + SECRET + merchant_trans_id + merchant_prepare_id + amount + action + sign_time)
```

Kod buni avtomatik tekshiradi. Mos kelmasa `-1 SIGN CHECK FAILED`.

---

## Tekshirish

Kalitlar qo'yilgach:

```
GET /api/payments/status
```

```json
{ "payme": true, "click": true }
```

`false` bo'lsa — kalit yetishmayapti.

## To'lov havolasi olish

```
GET /api/payments/link/:orderId?provider=payme
GET /api/payments/link/:orderId?provider=click
```

Javob:
```json
{ "provider": "payme", "url": "https://checkout.paycom.uz/..." }
```

Mijozni shu havolaga yuborasiz.

---

## Xavfsizlik eslatmalari

1. **Secret kalitlarni hech kimga bermang** — ular `.env` da, git'ga
   tushmaydi
2. Webhook endpointlari `auth` siz — bu **to'g'ri**, tizimlar o'z
   imzosi bilan tasdiqlanadi
3. Payme Basic auth, Click MD5 imzo ishlatadi — ikkalasi ham kodda bor
4. Takroriy so'rovlar to'g'ri boshqariladi (idempotentlik) — ikki
   marta to'lov yozilmaydi

## Keyingi qadam

Integratsiya paytida:
- Kalitlarni `.env` ga qo'yish
- Kabinetlarga endpoint manzillarini kiritish
- Sinov rejimida tekshirish
- Mijoz ilovasida to'lov tugmasini ulash
