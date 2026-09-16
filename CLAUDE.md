# ⛔ LokmaGo — O'ZGARMAS QOIDALAR (MAJBURIY O'QISH)

> **Bu fayl Claude Code tomonidan repoga kirganda AVTOMATIK o'qiladi.**
> Bu yerdagi qoidalar — muhokama predmeti EMAS. Ular haqiqiy moliyaviy
> zarar keltirgan xatolardan keyin yozilgan.

---

## 1-QOIDA (ENG MUHIM) — PUL YECHILMAGUNCHA BUYURTMA RESTORANGA BORMAYDI

### Qoida

**Mijoz kartasidan pul YECHILMAGUNCHA, buyurtma restoranga HECH QANDAY
yo'l bilan yetib bormasligi kerak.**

"Hech qanday yo'l" — bu quyidagilarning BARCHASI:

| Kanal | Fayl |
|---|---|
| Socket.io `order:new` emit | `src/controllers/misc.js` |
| `notify({ audience: 'restaurant' })` bildirishnoma | `src/controllers/misc.js` |
| Telegram bot xabari (`notifyNewOrder`) | `src/services/restaurantBotOrders.js` |
| REST `GET /panel/orders` javobi | `src/controllers/restaurantPanel.js` |
| Kunlik raqam (`assignDailyNumber`) | `src/services/orderNumber.js` |
| Push/SMS/boshqa har qanday yangi kanal | — |

### Texnik shart

Karta to'lovi tanlanganda buyurtma `status: 'awaiting_payment'` bilan
yaratiladi. **Restoranga yo'naltirilgan HAR QANDAY chiqish shu
tekshiruv bilan o'ralgan bo'lishi SHART:**

```js
if (doc.status !== 'awaiting_payment') {
  // ... faqat shu yerda restoranga xabar berish mumkin
}
```

To'lov muvaffaqiyatli bo'lgach, buyurtma restoranga TO'LIQ yuboriladi —
`src/services/paymentRecord.js` → `onPaymentSuccess()` (raqam beradi,
socket yuboradi, Telegram bot xabar qiladi). **Yaratilish paytida
to'xtatish hech narsa yo'qotmaydi, faqat kechiktiradi.**

### Nima uchun bu qoida yozilgan (real hodisa)

Mijoz karta bilan buyurtma berdi → to'lov sahifasini yopdi → **pul
yechilmadi** → lekin restoran panelida buyurtma jonli paydo bo'ldi →
oshpaz taom tayyorladi va jo'natdi → **restoran zarar ko'rdi.**

Sabab: `GET /panel/orders` REST endpointi to'g'ri filtrlagan
(`status: { $ne: 'awaiting_payment' }`) va Telegram bot ham to'g'ri
filtrlagan — **lekin socket emit bu filtrlarning IKKALASINI HAM
butunlay chetlab o'tib**, buyurtmani to'g'ridan-to'g'ri panel
ro'yxatiga qo'shib qo'ygan.

### Buzilish darsi (kelajakda takrorlanmasin)

> **Bitta joyda filtr qo'yish YETARLI EMAS.** Restoranga ma'lumot
> yetkazadigan har bir kanalni ALOHIDA tekshirish kerak. REST filtri
> bor deb socket'ga ishonib bo'lmaydi.

### Har safar tekshirish

Buyurtma yaratish yoki restoran bildirishnomalariga tegadigan
**har qanday** o'zgarishdan oldin:

```bash
grep -rn "order:new\|audience: 'restaurant'\|notifyNewOrder" src/
```

Topilgan har bir joy uchun savol: **"Bu to'lanmagan buyurtma uchun
ham ishlaydimi?"** Agar ha — bu BUG.

---

## 2-QOIDA — To'lov/buyurtma kodini "tozalash" uchun qayta yozmang

`src/controllers/misc.js` (orderController), `src/services/paymentRecord.js`,
`src/controllers/cardPayment.js`, `src/lib/pendingPayment.js` (frontend) —
bu fayllar ko'p marta, real xatolardan keyin sozlangan. Ulardagi
"g'alati ko'ringan" tartib va tekshiruvlar odatda **ataylab** shunday.

Tegishdan oldin: `git log -p <fayl>` bilan nima uchun shunday
qilinganini o'qing.

---

## 3-QOIDA — Frontend savatni to'lov tasdiqlanmaguncha tozalamaydi

`src/pages/Cart/CartPage.jsx` — karta to'lovida savat **saqlanadi**,
`orderId` esa `lib/pendingPayment.js` orqali localStorage'ga yoziladi.
Savat faqat server `isPaid: true` tasdiqlagandan keyin tozalanadi.

Sabab: mijoz to'lamasdan orqaga qaytsa, savati yo'qolmasligi kerak.

---

## 4-QOIDA — Guest-first: ilova ochilishida hech narsa so'ralmaydi

Ism, familiya, telefon, manzil, geolokatsiya, Telegram kanaliga obuna —
**bularning HECH BIRI** ilova ochilganda so'ralmaydi. Barchasi faqat
**transactional nuqtada** (buyurtma/bron yuborish) so'raladi:

- `useRequireAuth()` → `AuthGateModal`
- `useRequireSubscription()` → `SubscriptionGateModal`

`App.jsx` guest foydalanuvchini HECH QACHON bloklamasligi kerak.

---

## 5-QOIDA — Backend narxga ishonmaydi

Frontend yuborgan `price`, `total`, `commission`, `deliveryFee`,
`restaurantShare` qiymatlariga **ishonilmaydi**. Yakuniy hisob-kitob
har doim serverda qayta bajariladi.

---

## 6-QOIDA — Sirlarni log qilmang

Token, `initData`, parol, karta ma'lumotlari — hech qachon
`console.log`/`console.error`ga tushmasligi kerak.

---

## Repolar

| Repo | Vazifa |
|---|---|
| `lakmago-client` | Mijoz ilovasi (React + Vite, Telegram Mini App + web) |
| `lakmago-server` | Backend (Express + MongoDB) — **bu repo** |
| `lakmago-admin` | Admin va restoran paneli |
| `lokma-courier` | Kuryer ilovasi |

Frontend va backend **alohida** deploy qilinadi. Frontend — Vercel,
backend — VPS (pm2).
