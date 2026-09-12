# Signal ovozlari

Restoran botiga yangi buyurtma yoki bron kelganda xodimga
yuboriladigan ovozli signal fayllari.

| Fayl               | Qachon chalinadi   |
|--------------------|--------------------|
| `order.mp3`        | Yangi **buyurtma** |
| `reservation.mp3`  | Yangi **bron**     |

## Talablar

- Format: **MP3** (CBR yoki VBR, mono/stereo — farqi yo'q).
- Uzunlik: **1–3 soniya**. Signal xabarda **3 marta ketma-ket**
  chalinadi, ya'ni 2 soniyalik fayl 6 soniyalik signal beradi.
- Hajm: 1 MB dan kichik bo'lgani ma'qul.
- Nomlar aynan shunday bo'lishi shart (kichik harflarda).

## Almashtirish

Faylni shu papkaga qo'ying va serverni qayta ishga tushiring.
Telegram keshi (`file_id`) fayl mazmuni bo'yicha tekshiriladi —
yangi ovoz avtomatik yuklanadi, qo'lda hech narsa qilish kerak emas.

Papka joyini o'zgartirish uchun: `.env` da `SOUNDS_DIR=/path/to/sounds`.

## Fayl bo'lmasa

Bot oddiy ishlaydi, faqat ovozli signal yuborilmaydi. Server
ishga tushganda logda ogohlantirish chiqadi:
`[signal] ... topilmadi — ... ovozli signal yuborilmaydi`
