# Test ma'lumotlari — to'liq yo'riqnoma

Dasturni to'liq sinash uchun bazaga real ma'lumot yozadi.

## Nima yaratiladi

| Nima | Soni | Izoh |
|---|---|---|
| Muassasalar | 30 | Restoran, choyxona, fast food, magazin, klub |
| Taomlar | 263 | Har muassasa o'z kategoriyasidan menyu oladi |
| Mijozlar | 40 | Manzil, telefon, bonus bilan |
| Buyurtmalar | 220 | Oxirgi 30 kun, turli holatlarda |
| Bronlar | 60 | O'tgan va kelajakdagi, turli holatlarda |
| Panel akkauntlari | 30 | Har muassasa uchun login/parol |

---

## Ishga tushirish

```bash
cd ~/projects/lakmago-server

# Qo'shish (mavjud ma'lumot saqlanadi)
node scripts/seed-full.js

# Yoki: hammasini tozalab, qaytadan yaratish
node scripts/seed-full.js --fresh
```

**Diqqat:** `--fresh` mavjud restoran, taom, buyurtma va mijozlarni
**o'chiradi**. Admin akkaunti saqlanadi. Production'da ehtiyot bo'ling.

---

## Restoran paneliga kirish

Har muassasa uchun akkaunt yaratiladi:

```
login: muassasa_nomi (kichik harf, pastki chiziq bilan)
parol: login + "123"
```

Namunalar:

| Muassasa | Login | Parol |
|---|---|---|
| Milliy Taomlar | `milliy_taomlar` | `milliy_taomlar123` |
| EVOS Namangan | `evos_namangan` | `evos_namangan123` |
| Oqtepa Lavash | `oqtepa_lavash` | `oqtepa_lavash123` |

Skript oxirida to'liq ro'yxat chiqadi.

---

## Rasmlar

Rasmsiz ham ishlaydi (gradient bilan chiroyli ko'rinadi).
Haqiqiy fotolar uchun: `scripts/RASMLAR.md` ni o'qing.

```bash
node scripts/seed-images.js ./rasmlar
```

---

## Nimalarni sinash mumkin

**Mijoz ilovasi**
- Kategoriya bo'yicha filtr (17 xil kategoriya)
- Qidiruv (taom va restoran nomi bo'yicha)
- Chegirmali taomlar, hit taomlar
- Savat, buyurtma berish, bonus bilan to'lash
- Stol bron qilish (15 ta muassasa qabul qiladi)

**Restoran paneli**
- Buyurtmalar oqimi (turli holatlarda 220 ta)
- Menyu boshqaruvi (STOP holati ham bor)
- Bronlar (60 ta, turli holatlarda)

**Admin panel**
- Muassasalar ro'yxati, sozlamalar
- Daromad hisoboti (220 buyurtma asosida)
- Buyurtmalar monitoringi

---

## Tozalash

Test ma'lumotlarini o'chirish:

```bash
node -e "
import('./src/config/index.js').then(async ({config}) => {
  const m = await import('mongoose');
  await m.default.connect(config.mongoUri);
  const db = m.default.connection.db;
  await Promise.all([
    db.collection('restaurants').deleteMany({}),
    db.collection('dishes').deleteMany({}),
    db.collection('orders').deleteMany({}),
    db.collection('reservations').deleteMany({}),
    db.collection('users').deleteMany({ role: { \$in: ['customer','restaurant'] } }),
  ]);
  console.log('Tozalandi');
  process.exit(0);
});
"
```
