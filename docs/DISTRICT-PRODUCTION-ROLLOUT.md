# District — PRODUCTION'GA CHIQARISH (main'dan, bosqichma-bosqich)

Kod `main` da (barcha flag OFF). Alohida test branch/staging YO'Q: haqiqiy ilova, haqiqiy mijoz sifatida sinash.
Har qadam — **tasdiqdan keyin**. Restart: PM2 `lakmago-server`. Bu hujjat `docs/TUMAN-CHEGARALARI.md` ni to'ldiradi.

## 0. Muhim ogohlantirishlar

1. **Mijoz flagi (`VITE_DISTRICT_*`) Vercel Production'da — HAMMA mijozga ta'sir qiladi.** Server flaglari tuman chipini o'zi ko'rsatmaydi (ikki qulf: server + mijoz). Faqat o'zingiz sinash uchun alohida "pilot" yo'q — qarang 9-bo'lim (qaror kerak).
2. **`--apply` qilinmasa**, mavjud restoranlarning `serviceDistrictId` maydoni bo'sh va `LEGACY_POLICY=show` tufayli `?district=` har qanday tumanda BARCHA restoranni ko'rsatadi. Ya'ni Pop va Chust katalogi bir xil bo'lib qoladi (xato emas, kutilgan). Haqiqiy filtrlash — faqat migratsiyadan keyin. 8-bo'limda "--apply'siz nima ishlaydi" jadvali.
3. Katalog filtri yoqilgach adminda: koordinatasi qamrovdan tashqari (masalan boshqa viloyat) restoranni faollashtirish/tasdiqlash/koordinatasini o'zgartirish **409 `DISTRICT_UNRESOLVED`** beradi. Namangan viloyati ichidagi restoranlarga ta'sir qilmaydi.
4. Buyurtma, to'lov, yetkazish narxi/masofasi kodiga **tegilmagan** (`misc.js`, `paymentRecord.js`, `maps/delivery-quote`). Karta buyurtmasi to'lovsiz restoranga bormaydi (1-qoida) — district bunga aralashmaydi.

## 1. O'zgaruvchilar

```bash
export APP_DIR=~/projects/lakmago-server     # production papkasi — o'zingiznikini tekshiring
export PM2_NAME=lakmago-server
export API=https://apilokma.poppolizol.uz
```

## 2. PREFLIGHT (faqat o'qish)

```bash
cd $APP_DIR
git status -sb | head -5                       # toza bo'lishi kerak
export PREV_SHA=$(git rev-parse HEAD); echo "PREV_SHA=$PREV_SHA"   # ← ROLLBACK NUQTASI, yozib qo'ying
pm2 describe $PM2_NAME | grep -E "status|restarts|uptime|exec cwd"
curl -s -o /dev/null -w "health %{http_code}\n" $API/health
curl -s $API/api/districts | grep -c boundaries   # 0 bo'lishi kerak
grep -E '^(NODE_ENV|PORT|MONGO_URI|JWT_SECRET)=' .env | sed 's/=.*/=<bor>/'
grep -E '^DISTRICT_' .env || echo "DISTRICT_* yo'q (to'g'ri)"
git fetch origin main
git log --oneline $PREV_SHA..origin/main | cat          # nimalar kiradi (district'dan boshqa narsalar ham bo'lishi mumkin)
git diff --name-only $PREV_SHA origin/main -- package.json package-lock.json
```

`git log` ro'yxatini ko'ring: `PREV_SHA` bilan `main` orasida district'dan tashqari o'zgarishlar (masalan narx tuzatishi) ham kiradi.

## 3. BACKUP (bazaga yozmaydi)

```bash
mkdir -p ~/backups && chmod 700 ~/backups
cd $APP_DIR
node scripts/backup-now.js --file ~/backups/lokmago-pre-district-$(date +%F-%H%M).json
chmod 600 ~/backups/lokmago-pre-district-*.json
ls -lh ~/backups | tail -3
head -c 300 $(ls -t ~/backups/lokmago-pre-district-*.json | head -1); echo   # "full-database-backup" ko'rinishi kerak
```
Fayl BUTUN bazani (telefon, parol xeshlari) o'z ichiga oladi — repoga/chatga yubormang. Atlas'da snapshot bor-yo'qligini o'zingiz ko'ring (M0'da bo'lmaydi). Kunlik avtomatik zaxira: `pm2 logs $PM2_NAME --lines 300 --nostream | grep -i backup | tail -5`.

## 4. DRY-RUN (faqat hisobot; `--apply` YO'Q)

```bash
cd $APP_DIR
DISTRICT_BOUNDARIES_ENABLED=true node scripts/migrate-service-districts.js | tee ~/backups/district-dryrun-$(date +%F-%H%M).txt
```
Bu flagni yoqmaydi (faqat shu buyruq uchun). Bazaga yozmaydi. **XULOSA** blokini yuboring (jami / aniqlangan / koordinatasiz / qamrovdan tashqari / noaniq / hozir faol).

## 5. KOD YETKAZISH

```bash
cd $APP_DIR
git pull --ff-only origin main
git rev-parse HEAD            # ← bu SHA main'dagi bilan bir xil bo'lsin
git diff --quiet $PREV_SHA HEAD -- package.json package-lock.json && echo "dependency o'zgarmagan" || echo "o'zgargan → npm ci --omit=dev"
# faqat "o'zgargan" desa:
# npm ci --omit=dev
```

## 6. RESTART — FLAGSIZ (tasdiq B)

Kam yuk vaqtida (qisqa uzilish).
```bash
pm2 restart $PM2_NAME --update-env && sleep 5
curl -s -o /dev/null -w "health %{http_code}\n" $API/health
curl -s -D- -o /dev/null $API/api/districts | grep -i cache-control   # public, max-age=300
curl -s $API/api/districts | grep -c boundaries                        # 0
pm2 logs $PM2_NAME --lines 80 --nostream | grep -iE "error|unhandled|district|tuman" | tail -10
```
**Kuting ≥ 1 soat** keyingi qadamdan oldin: telefonlarda eski `/districts` javobi (1 soatlik kesh) tugashi uchun. O'z telefoningizda tezroq: brauzer saytini ma'lumotlarini tozalang.

## 7. FLAGLARNI YOQISH (har biri: o'zgartir → restart → tekshir → 10–15 daqiqa kuzat)

`.env` yordamchisi:
```bash
cd $APP_DIR
cp .env .env.bak-$(date +%F-%H%M)
setenv() { grep -q "^$1=" .env && sed -i "s|^$1=.*|$1=$2|" .env || echo "$1=$2" >> .env; }
```

### 7.1 Server: chegaralar (tasdiq C) — mijozga ko'rinmaydi
```bash
setenv DISTRICT_BOUNDARIES_ENABLED true
pm2 restart $PM2_NAME --update-env && sleep 5
pm2 logs $PM2_NAME --lines 30 --nostream | grep "Tuman chegaralari"              # "yuklandi: 12 ta, versiya 1"
curl -s "$API/api/location/resolve?lat=41.0035&lng=71.2378"                       # Chust
curl -s "$API/api/location/resolve?lat=41.3111&lng=69.2797"                       # OUTSIDE_COVERAGE
curl -s -o /dev/null -w "%{http_code}\n" "$API/api/location/resolve?lat=abc&lng=1" # 400
```
Rollback: `setenv DISTRICT_BOUNDARIES_ENABLED false` + restart.

### 7.2 Server: katalog filtri (tasdiq D) — faqat `?district=` yuboruvchiga ta'sir
```bash
setenv DISTRICT_CATALOG_FILTER_ENABLED true
setenv DISTRICT_CATALOG_LEGACY_POLICY show
pm2 restart $PM2_NAME --update-env && sleep 5
curl -s "$API/api/restaurants?limit=3" | head -c 200; echo
curl -s "$API/api/restaurants?limit=3&district=chust" | head -c 200; echo
```
Rollback: `setenv DISTRICT_CATALOG_FILTER_ENABLED false` + restart.

### 7.3 Admin (Vercel Production): `VITE_DISTRICT_BOUNDARIES_ENABLED=true` → Redeploy
Faqat bosh admin/xodimlar ko'radi; mijozga ta'siri yo'q. Faqat O'QISH bilan sinang (xaritada nuqta qo'yib tumani ko'rinishi). Restoran yaratmang/tahrirlamang.

### 7.4 Mijoz (Vercel Production): `VITE_DISTRICT_SELECTOR_ENABLED=true` → Redeploy  — **HAMMA mijozga chiqadi** (tasdiq E)
Faqat 7.1 VA 7.2 tugagach. Bosh sahifada manzil ostida tuman chipi paydo bo'ladi (qo'lda tanlash). Avto-aniqlash hali yo'q.

### 7.5 Avto-aniqlash (tasdiq F)
```bash
setenv DISTRICT_AUTO_DETECT_ENABLED true
pm2 restart $PM2_NAME --update-env && sleep 5
curl -s $API/api/districts | head -c 400           # boundaries.autoDetect.enabled=true
```
So'ng Vercel Production: `VITE_DISTRICT_AUTO_DETECT_ENABLED=true` → Redeploy.
Rollback: ikkalasini `false`.

## 8. "--apply"siz ishlaydigan va ishlamaydigan funksiyalar

| Funksiya | `--apply`siz |
|---|---|
| `/location/resolve` (koordinata → tuman) | ISHLAYDI |
| Mijozda tuman chipi, qo'lda tanlash, avto-aniqlash (2 aniq o'lchov, gisterezis) | ISHLAYDI |
| Chust ↔ Pop almashishi (chipda, saqlanadi) | ISHLAYDI |
| Admin xaritada "restoran qaysi tumanda" ko'rsatkichi (`district-preview`) | ISHLAYDI (o'qish) |
| Yangi/tahrirlangan restoranning `serviceDistrictId`si | Admin saqlaganda yoziladi (faqat o'sha restoran) |
| Katalog xatosiz yuklanadi, restoran yo'qolmaydi (`legacy=show`) | ISHLAYDI |
| **Mavjud restoranlarni tuman bo'yicha FILTRLASH** | ISHLAMAYDI — hamma tumanda hammasi ko'rinadi |
| Taom/aksiya/Market'ning tumanga mos bo'lishi (restoranga bog'liq) | ISHLAMAYDI (restoran maydoni bo'sh) |
| `LEGACY_POLICY=hide` | **YOQMANG** — migratsiyasiz hamma restoran filtrlangan ro'yxatdan yo'qoladi |

Haqiqiy filtrlashni sinash uchun keyinchalik `--apply` (zaxira + `--rollback` bor) — sizning alohida tasdig'ingiz bilan.

## 9. QAROR KERAK (arxitektura)

**Mijoz flagi hammaga chiqadi.** Faqat o'z telefoningizda sinash uchun "pilot" qulfi kerak bo'lsa (masalan, `VITE_DISTRICT_PILOT_ONLY=true` va chip faqat havoladagi `?district_pilot=1` bilan yoqilgan qurilmada ko'rinadi) — bu kichik, standart-o'chiq qo'shimcha, lekin yangi xatti-harakat. Men uni siz aytmaguncha qo'shmayman. Pilot'siz: 7.4–7.5 bosqichlari barcha mijozga chiqadi.

## 10. KUZATISH VA ROLLBACK

Har bosqichdan keyin:
```bash
pm2 logs $PM2_NAME --lines 100 --nostream | grep -iE "error|unhandled|ECONN|429" | tail -20
pm2 status | grep $PM2_NAME                       # restart soni oshmasin
curl -s -o /dev/null -w "%{http_code} %{time_total}s\n" $API/health
```

**A. Tezkor — barcha district flaglari o'chadi (kod qoladi):**
```bash
cd $APP_DIR
cp .env .env.bak-rollback-$(date +%F-%H%M)
for k in DISTRICT_BOUNDARIES_ENABLED DISTRICT_AUTO_DETECT_ENABLED DISTRICT_CATALOG_FILTER_ENABLED; do
  grep -q "^$k=" .env && sed -i "s|^$k=.*|$k=false|" .env
done
grep -E '^DISTRICT_' .env
pm2 restart $PM2_NAME --update-env && sleep 5
curl -s -o /dev/null -w "health %{http_code}\n" $API/health
curl -s $API/api/districts | grep -c boundaries   # 0
```
Vercel: `VITE_DISTRICT_*` o'zgaruvchilarni o'chiring (yoki `false`) → Redeploy (client va admin). Mijozlarda tuman tanlovi `localStorage`da qoladi, lekin flag o'chiq bo'lgach ishlatilmaydi.

**B. To'liq — avvalgi barqaror commit'ga:**
```bash
cd $APP_DIR
git checkout $PREV_SHA        # 2-bo'limda yozilgan SHA
git diff --quiet HEAD origin/main -- package-lock.json || npm ci --omit=dev
pm2 restart $PM2_NAME --update-env && sleep 5
git rev-parse HEAD; curl -s -o /dev/null -w "health %{http_code}\n" $API/health
```
Bundan keyin `main`ga qaytish: `git checkout main && git pull --ff-only origin main`.

**C. Ma'lumot:** district hozir bazaga yozmaydi (`--apply` yo'q); faqat adminda restoran saqlanganda shu restoranga maydonlar yoziladi — zararsiz (eski kod o'qimaydi). Favqulodda: `~/backups/lokmago-pre-district-*.json`.

## 11. Cheklovlar

- Tumanlararo buyurtma/yetkazish qoidasi QO'SHILMAGAN — hozirgi masofa qoidasi saqlanadi.
- Davlatobod va Yangi Namangan poligoni yo'q: avto-aniqlanmaydi; ularga override qilib bo'lmaydi (shahar ichida — `namangan_sh`).
- GitHub Actions CI billing sababli ishlamayapti. Testlar FerretDB'da o'tgan; Atlas'da birinchi marta shu yerda.
- Telegram Mini App / iOS / Android'da qurilma testi o'tkazilmagan.
