# Taom rasmlarini qo'shish

Seed skript rasmsiz ham ishlaydi — taomlar chiroyli gradient bilan
ko'rinadi. Lekin haqiqiy fotolar bilan ancha jozibali bo'ladi.

---

## Rasmlarni qayerdan olish

**1. O'z restoranlaringizdan (eng yaxshi)**
Hamkor restoranlardan taom fotolarini so'rang. Bu eng to'g'ri yo'l —
mijoz aynan o'sha taomni ko'radi.

**2. Bepul stok saytlar (tijorat uchun ruxsat berilgan)**

| Sayt | Izoh |
|---|---|
| unsplash.com | Yuqori sifat, bepul, atribut shart emas |
| pexels.com | Ko'p O'zbek/Osiyo taomlari bor |
| pixabay.com | Katta baza |
| freepik.com | PNG (fon shaffof) bor, bepulida atribut kerak |

**Qidiruv so'zlari:** `pilaf`, `uzbek plov`, `shashlik`, `kebab`,
`lavash`, `shawarma`, `burger`, `pizza`, `sushi roll`, `somsa`,
`manti`, `lagman`, `cheesecake`, `coffee latte`

**3. AI bilan yaratish**
Midjourney, DALL-E yoki Leonardo.ai — "professional food photography
of uzbek plov, white background, studio lighting" kabi so'rov bilan.

---

## Fayl nomlari

Skript fayl nomi bo'yicha taomni topadi. Shuning uchun nom taom
nomiga yaqin bo'lsin:

```
osh.jpg          → "To'y oshi", "Devzira osh", "Chayonli osh"
lavash.jpg       → "Mol go'shtli lavash", "Tovuqli lavash"
shashlik.jpg     → "Mol go'shti shashlik", "Qo'y shashlik"
burger.jpg       → "Chizburger", "Double burger"
pitsa.jpg        → "Margarita", "Pepperoni"  (yoki: margarita.jpg)
sushi.jpg        → "Filadelfiya", "Kaliforniya"  (yoki: filadelfiya.jpg)
somsa.jpg        → "Tandir somsa"
manti.jpg        → "Manti (5 dona)"
lagmon.jpg       → "Lag'mon"
norin.jpg        → "Norin"
chizkeyk.jpg     → "Chizkeyk"
qahva.jpg        → "Amerikano", "Kapuchino", "Latte"
```

**Tavsiya:** 15–25 ta rasm yetarli. Bir rasm bir necha taomga
biriktiriladi (Cloudinary trafigi tejaladi).

---

## Rasm qo'shishning 2 usuli

### A) Admin panel orqali — bittalab (eng oson)

Rasm keyinroq qo'shmoqchi bo'lsangiz shu qulay:

**Taom rasmi:**
1. Restoran paneliga kiring (login/parol seed oxirida chiqadi)
2. **Menyu** bo'limiga o'ting
3. Taom yonidagi **rasm kvadratini bosing**
4. Rasm tanlang → Saqlash

**Restoran banneri:**
1. Admin panel → **Muassasalar**
2. Restoran yonidagi ⚙️ tugmasi
3. Yuqorida **"Muassasa rasmi"** → rasm tanlang → Saqlash

Rasmlar Cloudinary'ga avtomatik yuklanadi va optimallashtiriladi.

### B) Skript orqali — ommaviy (ko'p rasm uchun)

```bash
cd ~/projects/lakmago-server

# 1. Avval ma'lumotlarni yarating
npm run seed

# 2. Keyin rasmlarni yuklang
npm run seed:images ./rasmlar
```

Bir rasm nomi mos keladigan barcha taomlarga biriktiriladi.

Skript har rasmni Cloudinary'ga yuklaydi va nomi mos keladigan
barcha taomlarga biriktiradi. Restoran bannerlari ham avtomatik
to'ldiriladi (o'z taomlarining birinchi rasmidan).

---

## Natija

```
✓ osh          →  8 ta taomga biriktirildi
✓ lavash       →  6 ta taomga biriktirildi
✓ shashlik     →  5 ta taomga biriktirildi
...
═══════════════════════════════════
  Yuklandi         : 18 rasm
  Taomga bog'landi : 87 ta
  Restoran banneri : 24 ta
═══════════════════════════════════
```

Rasm topilmagan taomlar gradient bilan ko'rinishda qoladi —
ilova baribir chiroyli ishlaydi.
