# LokmaGo — Tizim Arxitekturasi

Telegram Mini App orqali ishlaydigan restoran/ovqat yetkazish platformasi.
Uch mustaqil loyiha, bitta backend atrofida birlashgan.

---

## 1. Yuqori darajadagi ko'rinish

```
                    ┌─────────────────────────┐
                    │   MongoDB (Mongoose)    │
                    │  users · restaurants ·  │
                    │  dishes · orders ·      │
                    │  reservations · banners │
                    └───────────▲─────────────┘
                                │
                    ┌───────────┴─────────────┐
                    │   lakmago-server (API)   │
                    │  Express + Socket.IO     │
                    │  JWT auth · REST · WS    │
                    └───▲─────────▲─────────▲──┘
                        │ REST/WS │         │ REST/WS
          ┌─────────────┘         │         └─────────────┐
          │                       │                       │
┌─────────┴────────┐   ┌──────────┴─────────┐   ┌─────────┴────────┐
│  lakmago-client   │   │  lakmago-admin      │   │  lakmago-admin   │
│  (Mijoz webapp)   │   │  (Restoran roli)    │   │  (Admin roli)    │
│  Telegram Mini App│   │  login/parol        │   │  login/parol     │
│  dark theme       │   │  lakmago.uz         │   │  lakmago.uz/eka  │
└──────────────────┘   └────────────────────┘   └──────────────────┘
```

`lakmago-admin` — bitta ilova, foydalanuvchi roliga (`admin` yoki `restaurant`)
qarab tegishli panelni ko'rsatadi.

---

## 2. Rollar va autentifikatsiya

| Rol | Kirish | Metod | Nima qiladi |
|-----|--------|-------|-------------|
| `customer` | Telegram Mini App | `initData` → JWT | Buyurtma, bron |
| `restaurant` | lakmago.uz | login/parol → JWT | O'z menyusi, buyurtmalari |
| `admin` | lakmago.uz/eka | login/parol → JWT | Hamma narsani boshqarish |

- **Mijoz:** `POST /api/auth/telegram` — Telegram `initData` tekshiriladi, JWT beriladi.
- **Panel:** `POST /api/auth/login` — bcrypt bilan parol tekshiriladi, JWT beriladi.
- **JWT** ichида: `userId`, `role`, `restaurantId`. Har so'rovda `Authorization: Bearer` orqali.
- **Default admin** `.env` (`ADMIN_LOGIN`/`ADMIN_PASSWORD`) — server startда avtomatik yaratiladi.

---

## 3. Backend qatlamlari (lakmago-server)

```
src/
├── index.js              → kirish nuqtasi, Express + HTTP + Socket ulash
├── config/index.js       → .env o'qish, MongoDB ulanish, CORS, admin creds
├── models/               → Mongoose sxemalar (DB shakli)
│   ├── User.js           → mijoz + panel (login/passwordHash/role/restaurantId)
│   ├── Restaurant.js     → muassasa (isActive/kind/category)
│   ├── Dish.js           → taom (isAvailable = STOP)
│   ├── Order.js          → buyurtma
│   └── Reservation.js    → stol broni
├── controllers/          → biznes-mantiq (so'rovni qayta ishlash)
│   ├── catalog.js        → ochiq katalog (faqat faol muassasalar)
│   ├── misc.js           → mijoz auth, buyurtma, banner
│   ├── services.js       → bron, to'lov
│   ├── panelAuth.js      → login/parol auth (admin+restoran)
│   ├── restaurantPanel.js→ restoran paneli (menyu, STOP, buyurtma)
│   └── admin.js          → admin paneli (muassasa CRUD, global nazorat)
├── middleware/
│   ├── auth.js           → JWT tekshirish, requireRole, signToken
│   └── error.js          → asyncHandler, xato ushlash
├── routes/index.js       → barcha endpoint'lar bir joyda
├── sockets/io.js         → real-time xonalar (order/restaurant/admin)
├── services/
│   ├── telegram.js       → bot xabarlari
│   └── bootstrap.js      → default admin yaratish
└── seed/seed.js          → demo ma'lumot (admin+3 restoran+menyu)
```

**Oqim:** so'rov → route → auth middleware → controller → model → MongoDB → javob.

---

## 4. Real-time (Socket.IO xonalar)

| Xona | Kim tinglaydi | Qachon xabar oladi |
|------|---------------|--------------------|
| `order:{id}` | Mijoz | O'z buyurtmasi statusi o'zgarganda |
| `restaurant:{id}` | Restoran paneli | Yangi buyurtma kelganda |
| `admin` | Admin paneli | Har qanday yangi buyurtma |

**Buyurtma oqimi (live):**
```
Mijoz "Buyurtma berish" → POST /api/orders
   → Order yaratiladi (status: accepted)
   → io.to('restaurant:{id}').emit('order:new', order)   ← restoranga
   → io.to('admin').emit('order:new', order)             ← adminga
Restoran statusni o'zgartiradi → PATCH /api/panel/orders/:id/status
   → io.to('order:{id}').emit('order:status')            ← mijozga qaytadi
   → Telegram push (agar token bo'lsa)
```

---

## 5. Ma'lumotlar modeli (asosiy bog'lanishlar)

```
User (customer) ──1:N──> Order ──N:1──> Restaurant ──1:N──> Dish
User (restaurant) ──1:1──> Restaurant
User (admin)      ── standalone
Order.items[]     → { dishId, name, quantity, unitPrice }
Reservation ──N:1──> Restaurant, ──N:1──> User
```

**STOP mexanizmi:** `Dish.isAvailable = false` → mijozga ko'rinmaydi.
`Restaurant.isActive = false` → butun muassasa mijozdan yashiriladi.

---

## 6. Frontend arxitekturasi

### Mijoz webapp (lakmago-client)
```
React 18 + Vite + Tailwind (dark) + TanStack Query + Zustand
├── pages/         → route sahifalari (Home, Restaurant, Cart, Track...)
├── components/    → qayta ishlatiluvchi (DishRow, RestaurantCard, DishModal)
├── store/         → Zustand holat (cart, orders, user, banners)
├── hooks/         → queries (TanStack), useOrderTracking (Socket)
├── api/index.js   → API klienti + mock fallback
├── data/mock.js   → demo ma'lumot (backend'siz ishlash uchun)
└── lib/telegram.js→ Telegram Mini App integratsiyasi
```

**Muhim:** `api/index.js` har doim avval haqiqiy backendga uradi, ulanmasa —
`data/mock.js` ga tushadi. Shu tufayli webapp backend'siz ham to'liq ishlaydi.

### Panel (lakmago-admin)
```
React 18 + Vite + Tailwind (light) + TanStack Query + Zustand
├── store/auth.js  → rol asosida kirish holati (init/login/logout)
├── api/           → client.js (token) + index.js (panelApi, adminApi)
├── pages/
│   ├── LoginPage           → umumiy login (admin+restoran)
│   ├── admin/              → Dashboard, Restaurants, Users
│   └── restaurant/         → Orders, Menu
└── App.jsx        → rol asosida routing (admin yoki restaurant)
```

---

## 7. Rejimlar (env orqali)

| Loyiha | O'zgaruvchi | Qiymat |
|--------|-------------|--------|
| server | `MONGO_URI` | MongoDB manzili (qo'lda) |
| server | `ADMIN_LOGIN/PASSWORD` | Default admin |
| client | `VITE_API_URL` | `mock` (demo) yoki backend URL |
| admin | `VITE_API_URL` | Backend URL |

---

## 8. Xavfsizlik prinsiplari

- Parollar **bcrypt** bilan hash (`passwordHash`), JSON'da hech qachon qaytmaydi.
- Har panel endpoint'i `requireRole` bilan himoyalangan.
- Restoran faqat **o'z** ma'lumotini ko'radi/o'zgartiradi (`restaurantId` token'dan).
- JWT 30 kun amal qiladi.
- Telegram `initData` HMAC bilan tekshiriladi.

---

## 9. Ishga tushirish tartibi

```bash
# 1. Backend
cd lakmago-server && cp .env.example .env   # MONGO_URI ni qo'ying
npm install && npm run seed && npm run dev  # :4000

# 2. Panel
cd lakmago-admin && npm install && npm run dev  # :5174

# 3. Mijoz webapp
cd lakmago-client && npm install && npm run dev # :5173
```

Kirish: admin `/eka` (admin/admin123), restoran `milliy/milliy123`.
