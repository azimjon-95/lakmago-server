# Moliyaviy tizim

## To'lov oqimi

Yandex Eda, Wolt va Uzum Tezkor ishlatadigan model:

```
1. Mijoz buyurtma beradi, karta tanlaydi
        ↓
2. Payme/Click sahifasi ochiladi
   Mijoz karta ma'lumotini va SMS kodni kiritadi
        ↓
3. Pul DARHOL yechiladi → platforma hisobiga
   Buyurtma "to'lov kutilmoqda" dan "yangi" ga o'tadi
        ↓
4. Restoran ko'radi va qabul qiladi
        ↓
5. Buyurtma YETKAZILADI
   Aynan shu paytda restoran ulushi balansga qo'shiladi
        ↓
6. Admin bank hisobiga o'tkazadi
```

**Muhim:** pul darhol yechiladi, lekin restoranga faqat **yetkazilgandan
keyin** hisoblanadi. Buyurtma bekor bo'lsa mijozga qaytariladi va
restoranga hech nima bormaydi.

### Nega bloklash (hold) emas

Payme va Click O'zbekistonda pulni bloklab qo'yishni to'liq
qo'llab-quvvatlamaydi. Shuning uchun darhol yechish standart.

## Naqd to'lov

Bu yerda pul restoranda qoladi — biz komissiyani qanday olamiz?

**Yechim: manfiy balans.**

```
Buyurtma: 100 000 so'm, komissiya 10%

Karta to'lovi:
  Pul bizda        → restoranga qarzimiz +90 000
Naqd to'lov:
  Pul restoranda   → restoran bizga qarz  −10 000
```

Balans manfiyga ketadi. Keyingi karta to'lovlarida avtomatik
yopiladi:

```
Naqd buyurtma:  −10 000  (komissiya qarzi)
Karta buyurtma: +90 000
                --------
Balans:          80 000  ← shu summa to'lanadi
```

Restoran faqat naqd bilan ishlasa balans manfiy qolaveradi —
u holda restoran o'zi to'laydi yoki shartnomada boshqa tartib
kelishiladi.

## Komissiya

### Har restoran alohida

Admin → Moliya → restoran → **Shartnoma**

- Foiz: 0 dan 100 gacha
- Bo'sh qoldirilsa umumiy sozlama ishlatiladi
- **0% ham to'g'ri qiymat** — ba'zi restoranlardan olinmaydi

### Ikki rejim

| Rejim | Mijoz to'laydi | Restoran oladi |
|---|---|---|
| **deduct** | 100 000 | 90 000 |
| **markup** | 110 000 | 100 000 |

**Tavsiya: `deduct`.** `markup` da narxlaringiz restoranning o'z
narxidan qimmat bo'ladi — mijoz sezadi. Raqobatchilar `deduct`
ishlatadi.

### Nimadan olinadi

Komissiya faqat **taomlar summasidan** (`subtotal`). Yetkazish haqi
va xizmat haqi to'liq platformaga tegishli.

## Moliyaviy jurnal

Har pul harakati yoziladi va **hech qachon o'chirilmaydi**. Xato
bo'lsa teskari yozuv qo'shiladi — buxgalteriya standarti.

| Turi | Qachon | Summa |
|---|---|---|
| `payment_in` | Mijoz to'ladi | + |
| `commission` | Buyurtma yetkazildi | + |
| `restaurant_due` | Buyurtma yetkazildi | + karta / − naqd |
| `payout` | Admin to'ladi | − |
| `refund` | Bekor qilindi | − |
| `adjustment` | Qo'lda tuzatish | ± |

Har yozuvda saqlanadi: buyurtma, restoran, mijoz, to'lov tizimi,
qo'llanilgan foiz va rejim.

## Admin panel

**Moliya → Restoranlar**
- Tushum, komissiya, to'langan, balans
- "Shartnoma" — foiz sozlash
- "To'lash" — bank hisobiga o'tkazish

**Moliya → Jurnal**
- Barcha harakatlar: sana, turi, restoran, summa

## Takrorlanishdan himoya

Har amal bir marta bajariladi:

- `recordPayment` — `payment_in` bor bo'lsa qaytadi
- `settleOrder` — `restaurant_due` bor bo'lsa qaytadi
- `recordRefund` — `refund` bor bo'lsa qaytadi

To'lov tizimi bir necha marta so'rov yuborsa ham pul ikki marta
yozilmaydi.

## Tekshirish

```
GET /api/admin/billing/overview
```

```json
{
  "tushum": 5000000,
  "komissiya": 500000,
  "restoranlargaQarz": 4200000,
  "platformaDaromadi": 500000,
  "qaytarilgan": 0
}
```

Tekshiruv: `tushum − komissiya − qaytarilgan ≈ restoranlargaQarz + tolangan`
