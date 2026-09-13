# TEST MUHITI — o'rnatish yo'riqnomasi

Production'ga **tegilmaydi**: boshqa papka, boshqa port, boshqa baza,
boshqa botlar. Har bosqichda "nima uchun xavfsiz" izohlangan.

| | Production | Test |
|---|---|---|
| PM2 | `lakmago-server` | `lakmago-test` |
| Port | 4000 | 4001 |
| Domen | apilokma.poppolizol.uz | test-api.lokmago.uz |
| Branch | `main` | `develop` |
| Baza | Atlas: `lokmago` | Atlas: `lokmago_test` |
| Redis | DB 0 | DB 1 |
| Botlar | real | @LokmaGoTestBot, @LokmaGoRestoranTestBot |

---

## 0. Oldindan tayyorgarlik

**DNS:** `test-api.lokmago.uz` → server IP (A yozuv). Tekshirish:

```bash
getent hosts test-api.lokmago.uz
```

**4001 port bo'shligini tekshiring:**

```bash
ss -ltn | grep ':4001 ' && echo "BAND — boshqa port tanlang" || echo "bo'sh"
```

---

## 1. MongoDB Atlas — test bazasi

Atlas'da **yangi klaster ochish shart emas**, o'sha klasterda yangi baza
yetarli. Lekin **alohida foydalanuvchi** yarating — bu eng kuchli himoya:

1. Atlas → Database Access → **Add New Database User**
2. Foydalanuvchi: `lokmago_test_user`
3. Parol: kuchli, production parolidan **boshqa**
4. Huquq: **Specific Privileges** → `readWrite` → baza: `lokmago_test`

Shundan keyin test server production bazasiga **texnik jihatdan ham**
ulana olmaydi: noto'g'ri `.env` bilan ham Atlas uni rad etadi.

> **Ma'lumot ko'chirmang.** Test bazasi **bo'sh** boshlanadi. Production
> nusxasi ko'chirilsa, test serverdagi jadval ishlari (bron eslatmalari,
> yetkazish tekshiruvi) **real mijozlarga Telegram xabar yuboradi**.

**Network Access:** server IP allaqachon ro'yxatda bo'lishi kerak
(production shu yerdan ulanadi), qo'shimcha o'zgarish shart emas.

---

## 2. Test papkasi

Production `~/projects/lakmago-server` da — test ham yonida turadi.

```bash
git clone -b develop https://github.com/azimjon-95/lakmago-server.git ~/projects/lakmago-test
cd ~/projects/lakmago-test
npm ci --omit=dev
mkdir -p logs
```

Production papkasiga tegilmaydi — bu butunlay boshqa joy.

> **Ehtiyot bo'ling:** test ishlari uchun `~/projects/lakmago-server`
> ichida `git pull` qilmang — u production papkasi. Test har doim
> `~/projects/lakmago-test` da.

---

## 3. Test `.env`

```bash
cp .env.test.example .env
nano .env
```

To'ldirilishi shart:

| Kalit | Qiymat |
|---|---|
| `APP_ENV` | `test` |
| `PORT` | `4001` |
| `MONGO_URI` | Atlas satri, oxirida `/lokmago_test` |
| `REDIS_URL` | `redis://localhost:6379/1` |
| `JWT_SECRET` | `openssl rand -hex 32` — production'dan **boshqa** |
| `TELEGRAM_BOT_TOKEN` | @LokmaGoTestBot |
| `RESTAURANT_BOT_TOKEN` | @LokmaGoRestoranTestBot |
| `WEBHOOK_BASE` | `https://test-api.lokmago.uz` |

```bash
chmod 600 .env     # faqat egasi o'qiy oladi
```

> `JWT_SECRET` ataylab boshqacha: test panelida olingan token
> production API'da ishlamaydi va aksincha.

**To'lov kalitlarini bo'sh qoldiring** yoki faqat Payme test kalitini
qo'ying. Production merchant kalitlari bilan real pul harakati bo'lishi mumkin.

---

## 4. Nginx

```bash
sudo cp deploy/nginx-test.conf.example /etc/nginx/sites-available/lakmago-test
sudo ln -s /etc/nginx/sites-available/lakmago-test /etc/nginx/sites-enabled/
sudo nginx -t
```

`nginx -t` **xato bersa to'xtang** va havolani o'chiring
(`sudo rm /etc/nginx/sites-enabled/lakmago-test`). Xatosiz bo'lsa:

```bash
sudo systemctl reload nginx      # reload — mavjud ulanishlar uzilmaydi
sudo certbot --nginx -d test-api.lokmago.uz
```

Mavjud production sayt fayliga tegilmaydi.

---

## 5. Ishga tushirish

```bash
cd ~/projects/lakmago-test
pm2 start ecosystem.test.config.cjs
pm2 save
pm2 logs lakmago-test --lines 40
```

**Loglarda shu qatorlar bo'lishi SHART:**

```
✓ Mijoz boti: @LokmaGoTestBot (muhit: test)
✓ Restoran boti: @LokmaGoRestoranTestBot (muhit: test)
✓ Telegram webhook ... test-api.lokmago.uz
```

Agar `✗ [TEST MUHITI]` deb xato chiqsa — bu **himoya ishlagani**:
`.env` da noto'g'ri token yoki manzil bor. Xato matnida sabab yozilgan.
Production botlariga hech narsa bo'lmagan.

---

## 6. Tekshiruv

```bash
# Test API tirikmi
curl https://test-api.lokmago.uz/health

# Production TEGILMAGANMI (eng muhim tekshiruv)
curl https://apilokma.poppolizol.uz/health
pm2 list                       # lakmago-server: online, restart soni oshmagan

# Production bot webhook'i o'zgarmaganini tasdiqlash
curl -s "https://api.telegram.org/bot<PROD_TOKEN>/getWebhookInfo"
#   → url: https://apilokma.poppolizol.uz/bot/webhook   ← o'zgarmasligi kerak

# Test bot webhook'i
curl -s "https://api.telegram.org/bot<TEST_TOKEN>/getWebhookInfo"
#   → url: https://test-api.lokmago.uz/...
```

---

## 7. Orqaga qaytarish

Biror narsa noto'g'ri ketsa:

```bash
pm2 stop lakmago-test
pm2 delete lakmago-test
sudo rm /etc/nginx/sites-enabled/lakmago-test
sudo nginx -t && sudo systemctl reload nginx
```

Production bundan **umuman ta'sirlanmaydi** — hech bir fayli,
process'i yoki bazasi o'zgartirilmagan.

---

## 8. Keyingi yangilash

```bash
cd ~/projects/lakmago-test
git pull origin develop
npm ci --omit=dev
pm2 reload lakmago-test
```
