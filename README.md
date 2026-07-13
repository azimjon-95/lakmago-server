# LokmaGo — Backend API

Express + MongoDB (Mongoose) + Socket.IO, TypeScript.

## Ishga tushirish

### Docker bilan (tavsiya)
```bash
docker compose up --build
# MongoDB + API avtomatik ko'tariladi
docker compose exec api npm run seed   # demo ma'lumot
```

### Lokal
```bash
npm install
cp .env.example .env    # sozlamalarni to'ldiring
npm run seed            # demo ma'lumotlarni bazaga solish
npm run dev             # http://localhost:4000
```

## API endpointlari

### Auth
- `POST /api/auth/telegram` — Telegram WebApp initData bilan login, JWT qaytaradi

### Katalog (ochiq)
- `GET /api/banners`
- `GET /api/restaurants?category=milliy`
- `GET /api/restaurants/:id`
- `GET /api/restaurants/:id/dishes`
- `GET /api/dishes/trending`
- `GET /api/dishes/discounted`

### Buyurtmalar (JWT talab qilinadi)
- `POST /api/orders` — yangi buyurtma
- `GET /api/orders` — mening buyurtmalarim
- `GET /api/orders/:id`
- `PATCH /api/orders/:id/status` — status yangilash (restoran/admin)

## Real-time (Socket.IO)

Client hodisalari:
- `track:order` (orderId) — mijoz buyurtmani kuzatadi
- `join:restaurant` (restaurantId) — restoran buyurtmalarni eshitadi

Server hodisalari:
- `order:new` — restoranga yangi buyurtma
- `order:status` — mijozga status yangilanishi

## Modellar

`Restaurant`, `Dish` (qo'shimcha guruhlari bilan), `User` (rollar: customer/restaurant/admin),
`Order` (status oqimi), `Banner`.

## Xavfsizlik

- Telegram initData HMAC-SHA256 orqali tekshiriladi (`verifyTelegramInitData`)
- JWT 30 kun amal qiladi
- Rol asosida ruxsat (`requireRole`)
- helmet, cors, zod validatsiya

## Struktura

```
src/
├── config/       # env + MongoDB ulanish
├── models/       # Mongoose sxemalar
├── controllers/  # biznes logika
├── routes/       # endpoint xaritasi
├── middleware/   # auth, xatolik
├── sockets/      # Socket.IO real-time
├── seed/         # demo ma'lumot
└── index.ts      # server
```
