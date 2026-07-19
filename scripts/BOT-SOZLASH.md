# Bot va guruh sozlash

Bot guruhga qo'shilganda ishlamayotgan bo'lsa, quyidagi tartibda tekshiring.

---

## 1. Webhook to'g'ri o'rnatilganmi

Eng ko'p uchraydigan sabab — webhook'da kerakli update turlari yoqilmagan.

**Avtomatik o'rnatish (tavsiya etiladi):**

```bash
cd ~/projects/lakmago-server
npm run webhook https://api.domeningiz.uz
```

Skript kerakli hamma narsani yoqadi va natijani ko'rsatadi.

**Tekshirish:**

```
https://api.domeningiz.uz/diag/telegram
```

Javobda `"muammo": null` bo'lishi kerak. Agar biror narsa yetishmasa,
u yerda aniq yozilgan bo'ladi.

---

## 2. Botga qanday huquq berish kerak

Guruhga qo'shganda **admin** qiling va bu huquqlarni bering:

| Huquq | Nima uchun |
|---|---|
| **Xabar yuborish** | Reklama xabarini yuborish uchun |
| **Xabarlarni mahkamlash** (Pin messages) | Xabarni tepaga qadash uchun |

Pin huquqi berilmasa: xabar yuboriladi, lekin pin qilinmaydi.
Server logida aniq yoziladi:

```
[bot] -1001234 — pin qilib bo'lmadi: not enough rights
      → Botga "Xabarlarni mahkamlash" huquqini bering
```

---

## 3. Nima bo'layotganini ko'rish

```bash
pm2 logs lakmago-server
```

Botni guruhga qo'shganda quyidagicha chiqishi kerak:

```
[bot] my_chat_member: chat=-1001234 (supergroup) "Mening guruhim" left → member
[bot] "Mening guruhim" — qo'shildi, lekin ADMIN EMAS. Pin qilish uchun admin huquqi kerak.

[bot] my_chat_member: chat=-1001234 (supergroup) "Mening guruhim" member → administrator
[bot] "Mening guruhim" — admin bo'ldi. Promo: yuborilmoqda...
[bot] -1001234 — xabar pin qilindi
[bot] "Mening guruhim" — promo yuborildi (msg 42)
```

**Hech narsa chiqmasa** — webhook ishlamayapti (1-bandga qarang).

---

## 4. Tez tashxis jadvali

| Belgi | Sabab | Yechim |
|---|---|---|
| Log bo'sh, hech narsa chiqmaydi | Webhook o'rnatilmagan yoki `my_chat_member` yoqilmagan | `npm run webhook <domen>` |
| "ADMIN EMAS" yozuvi | Bot qo'shilgan, lekin admin qilinmagan | Guruh sozlamalarida admin qiling |
| Xabar bor, pin yo'q | Pin huquqi berilmagan | Botga "Pin messages" huquqini bering |
| `/diag/telegram` da `lastError` | Telegram serveringizga yeta olmayapti | HTTPS va domen ishlayotganini tekshiring |
| Bot javob bermaydi | Token noto'g'ri yoki server o'chiq | `pm2 logs`, `.env` tekshiring |

---

## 5. Guruhlarni ko'rish

Admin panel → **Guruhlar** bo'limida barcha guruhlar ko'rinadi:
bot admin bo'lganmi, xabar yuborilganmi, pin qilinganmi.

U yerdan qo'lda qayta yuborish yoki reklama tarqatish mumkin.
