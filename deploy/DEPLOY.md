# LokmaGo — Deploy yo'riqnomasi

## 1. Backend (server + subdomen + HTTPS)

### DNS
Domen panelida A yozuv qo'shing:
```
Turi: A      Nomi: api      Qiymat: <SERVER-IP>
```
Natija: `api.SIZNING-DOMEN.uz` → serveringiz (5–30 daqiqada tarqaladi)

### Nginx + HTTPS
```bash
sudo apt update && sudo apt install -y nginx certbot python3-certbot-nginx

# deploy/nginx.conf.example ni nusxalang (server_name ni o'zgartiring)
sudo nano /etc/nginx/sites-available/lakmago

sudo ln -s /etc/nginx/sites-available/lakmago /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# HTTPS sertifikat (bepul, avtomatik yangilanadi)
sudo certbot --nginx -d api.SIZNING-DOMEN.uz
```

### Server .env
```dotenv
PORT=4000
MONGO_URI=mongodb://localhost:27017/lokmago
JWT_SECRET=<uzun-tasodifiy-satr>

# Mijoz webapp'i (Telegram Mini App)
WEBAPP_URL=https://lakmago-client.vercel.app

# Admin panellar (vergul bilan, bo'shliqsiz)
CORS_ORIGINS=https://lakmago-admin.vercel.app

TELEGRAM_BOT_TOKEN=<bot-token>
CLOUDINARY_CLOUD_NAME=...
CLOUDINARY_API_KEY=...
CLOUDINARY_API_SECRET=...
```

```bash
pm2 restart lakmago-server
```

### Tekshirish
```
https://api.SIZNING-DOMEN.uz/diag
```
`httpsReady: true` bo'lishi kerak.

---

## 2. Webapp (Vercel)

Settings → Environment Variables:
```
VITE_API_URL     = https://api.SIZNING-DOMEN.uz/api
VITE_SOCKET_URL  = https://api.SIZNING-DOMEN.uz
VITE_BOT_USERNAME = lakmagobot
VITE_WEBAPP_NAME  =            (bo'sh — t.me/bot?startapp ishlasa)
VITE_SHARE_BASE   = https://api.SIZNING-DOMEN.uz
```
**Muhim:** env o'zgargach **Redeploy** bosing (avtomatik qayta qurilmaydi).

---

## 3. Admin panel (Vercel — alohida loyiha)

```
VITE_API_URL     = https://api.SIZNING-DOMEN.uz/api
VITE_SOCKET_URL  = https://api.SIZNING-DOMEN.uz
```

---

## 4. Telegram webhook
```bash
curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://api.SIZNING-DOMEN.uz/bot/webhook&allowed_updates=\[\"message\",\"my_chat_member\",\"callback_query\"\]"
```

---

## Tez tashxis

| Belgi | Sabab | Yechim |
|---|---|---|
| `API: http://127.0.0.1:4000` | Vercel env noto'g'ri | `VITE_API_URL` ni to'g'rilab Redeploy |
| `Tur: network`, `Load failed` | HTTPS yo'q yoki server yetib bormaydi | Nginx + Certbot |
| `[CORS] rad etildi` (pm2 logs) | Domen ruxsat ro'yxatida yo'q | `.env` ga qo'shing |
| Socket ishlamaydi | Nginx'da Upgrade header yo'q | nginx.conf ni tekshiring |
