# District funksiyasi — PRODUCTION'DA CHEKLANGAN HAQIQIY TEST (runbook)

Branch: `feature/district-production-test` (server, client, admin). **`main` o'zgarmagan.**
Hammasini siz VPS terminalida o'zingiz kiritasiz. Har bosqichda **TASDIQ** belgisi bor: tasdiqsiz keyingisiga o'tmang.

> Eslatma: district kodi `main` ga allaqachon kirgan (flag OFF). Bu branch `main` + shu runbook + dry-run xulosasi.
> Branch "izolyatsiya" emas — izolyatsiya **flaglar** orqali (barchasi OFF boshlanadi) va **mijoz tomoni faqat Vercel Preview'da** yoqiladi.

## 0. Nega bu test "cheklangan"

| Qatlam | Nima cheklaydi |
|---|---|
| Server flag | `?district=` yubormagan eski mijozlar (hamma production foydalanuvchilar) eski natijani oladi — flag yoqilgan bo'lsa ham |
| Mijoz flag | `VITE_DISTRICT_*` faqat **Preview** muhitida, faqat shu branch uchun. `lokma.uz` (production) o'zgarmaydi |
| Buyurtma/to'lov/yetkazish | District kodi bu yo'llarga tegmagan (`misc.js`, `paymentRecord.js` o'zgarmagan) |

Cheklov: Telegram Mini App va iOS/Android ilovasi production bundle'ni ochadi — ularda Preview'ni sinab bo'lmaydi (qarang 7-bo'lim).

## 1. Qo'llanma: o'zgaruvchilar

```bash
# O'zingizning yo'llaringiz (production papkasi — TEST-SETUP.md ga ko'ra):
export APP_DIR=~/projects/lakmago-server
export PM2_NAME=lakmago-server
export API=https://apilokma.poppolizol.uz
export BR=feature/district-production-test
```

## 2. PREFLIGHT (faqat o'qish — hech narsa o'zgarmaydi)

```bash
cd $APP_DIR
# 2.1 Hozir nima ishlayapti — ROLLBACK NUQTASI. Shu qiymatni YOZIB QO'YING:
git rev-parse HEAD ; git branch --show-current ; git status -sb | head -5
pm2 describe $PM2_NAME | grep -E "status|restarts|uptime|script path|exec cwd"
export PREV_SHA=$(git rev-parse HEAD); echo "PREV_SHA=$PREV_SHA"

# 2.2 Sog'liq (BEFORE)
curl -s -o /dev/null -w "health %{http_code}\n" $API/health
curl -s $API/api/districts | head -c 300; echo      # "boundaries" maydoni BO'LMASLIGI kerak

# 2.3 ENV (QIYMATLARNI KO'RSATMAYDI — faqat bor/yo'qligi)
grep -E '^(NODE_ENV|APP_ENV|PORT|MONGO_URI|JWT_SECRET|REDIS_URL|BACKUP_GROUP_CHAT_ID|TELEGRAM_BOT_TOKEN)=' .env | sed 's/=.*/=<set>/'
grep -E '^DISTRICT_' .env || echo "DISTRICT_* yo'q (to'g'ri — hammasi OFF)"
```

Kutilgan: `health 200`, `/api/districts` da `boundaries` yo'q, `DISTRICT_*` yo'q.

## 3. BACKUP (bazaga YOZMAYDI) — migratsiya/yoqishdan oldin MAJBURIY

```bash
mkdir -p ~/backups && chmod 700 ~/backups
cd $APP_DIR
node scripts/backup-now.js --file ~/backups/lokmago-pre-district-$(date +%F-%H%M).json
chmod 600 ~/backups/lokmago-pre-district-*.json
ls -lh ~/backups | tail -3
```

- Fayl BUTUN bazani (mijoz telefonlari, parol xeshlari) o'z ichiga oladi: **repoga qo'shmang, Telegram/chatga yubormang**.
- Tekshiruv: fayl hajmi > 0 va `head -c 300 <fayl>` da `"kind":"full-database-backup"`, `summary` oxirida collectionlar soni.
- Tiklash faqat favqulodda (qo'lda, `EJSON.parse` + `insertMany`) — qarang `src/services/dbBackup.js` sarlavhasi.
- Qo'shimcha: Atlas → Database → Backup bo'limida snapshot bor-yo'qligini o'zingiz ko'ring (M0/Shared klasterda snapshot BO'LMAYDI — shunda yuqoridagi fayl yagona zaxira).
- Avtomatik kunlik zaxira (23:59 Toshkent, Telegram guruhiga) ishlayaptimi: `pm2 logs $PM2_NAME --lines 200 --nostream | grep -i backup | tail -5`.

## 4. DRY-RUN (faqat hisobot — `--apply` TAQIQ)

Flagni YOQMASDAN, faqat shu bitta buyruq uchun o'zgaruvchi beriladi (`.env` o'zgarmaydi):

```bash
cd $APP_DIR
DISTRICT_BOUNDARIES_ENABLED=true node scripts/migrate-service-districts.js | tee ~/backups/district-dryrun-$(date +%F-%H%M).txt
```

Natijadagi **XULOSA** blokini menga yuboring (jami / aniqlangan / koordinatasiz / qamrovdan tashqari / noaniq / hozir faol). Skript bazaga yozmaydi (mahalliy tekshiruvda baza oldin/keyin baytma-bayt bir xil edi). **`--apply` ni bajarmang.**

## 5. KOD YETKAZISH (restartsiz) — TASDIQ A

```bash
cd $APP_DIR
git status --short | head           # toza bo'lishi kerak. Bo'lmasa TO'XTANG
git fetch origin $BR
git checkout $BR && git merge --ff-only origin/$BR   # fast-forward; main'ga TEGMAYDI
git rev-parse HEAD                  # ← SHA ni bu hujjatdagi/men bergan SHA bilan SOLISHTIRING
git diff --stat $PREV_SHA HEAD | tail -3
git diff --quiet $PREV_SHA HEAD -- package-lock.json package.json && echo "dependency o'zgarmagan" || echo "package*.json O'ZGARGAN → npm ci kerak"
```

Faqat oxirgi qator "o'zgargan" desa: `npm ci --omit=dev`. Aks holda o'rnatish shart emas.
**Bu bosqichda process hali eski kodda ishlayapti** (restart qilinmagan). Faylni almashtirish ishlayotgan Node'ga ta'sir qilmaydi.

## 6. BOSQICHMA-BOSQICH YOQISH (har biri: o'zgartir → restart → tekshir)  — har qadam TASDIQ

`.env` ga yozishdan oldin zaxira va yordamchi:

```bash
cd $APP_DIR
cp .env .env.bak-$(date +%F-%H%M)
setenv() { grep -q "^$1=" .env && sed -i "s|^$1=.*|$1=$2|" .env || echo "$1=$2" >> .env; }
```

### 6.0 Restart — FLAGSIZ (yangi kod yuklanadi, xatti-harakat o'zgarmaydi) — TASDIQ B
Kam yuk vaqtini tanlang (restart qisqa uzilish beradi).
```bash
pm2 restart $PM2_NAME --update-env && sleep 5
curl -s -o /dev/null -w "health %{http_code}\n" $API/health
curl -s $API/api/districts | grep -c boundaries      # 0 bo'lishi kerak
pm2 logs $PM2_NAME --lines 60 --nostream | grep -iE "error|unhandled|tuman|district" | tail -10
```

### 6.1 Chegaralar (resolver) — TASDIQ C
```bash
setenv DISTRICT_BOUNDARIES_ENABLED true
pm2 restart $PM2_NAME --update-env && sleep 5
pm2 logs $PM2_NAME --lines 30 --nostream | grep "Tuman chegaralari"          # "yuklandi: 12 ta, versiya 1"
curl -s "$API/api/location/resolve?lat=41.0035&lng=71.2378"                   # → chust
curl -s "$API/api/location/resolve?lat=41.3111&lng=69.2797"                   # → OUTSIDE_COVERAGE (Toshkent)
curl -s -o /dev/null -w "%{http_code}\n" "$API/api/location/resolve?lat=abc&lng=1"   # 400
```
Rollback: `setenv DISTRICT_BOUNDARIES_ENABLED false` + restart.

### 6.2 Katalog filtri — TASDIQ D  (faqat `?district=` yuboruvchilarga ta'sir)
```bash
setenv DISTRICT_CATALOG_FILTER_ENABLED true
setenv DISTRICT_CATALOG_LEGACY_POLICY show      # tumani yozilmagan (migratsiyasiz) restoran YO'QOLMAYDI
pm2 restart $PM2_NAME --update-env && sleep 5
# parametrsiz — eski natija bilan bir xil bo'lishi kerak (oldingi sonni 2.x da yozib oling)
curl -s "$API/api/restaurants" | head -c 200; echo
curl -s "$API/api/restaurants?district=chust" | head -c 200; echo
```
Eslatma: migratsiya (`--apply`) QILINMAGANI uchun hamma restoranning `serviceDistrictId`si bo'sh → `legacy=show` tufayli `?district=` har qanday tumanda ham BARCHA restoranni ko'rsatadi. Bu kutilgan; haqiqiy filtrlash migratsiya TASDIQLANGANDAN keyin. Shu bosqichda faqat "xato bermaydi va hech narsa yo'qolmaydi"ni tekshirasiz.
Rollback: `setenv DISTRICT_CATALOG_FILTER_ENABLED false` + restart.

### 6.3 Avtomatik aniqlash (server tomoni) — TASDIQ E
```bash
setenv DISTRICT_AUTO_DETECT_ENABLED true
pm2 restart $PM2_NAME --update-env && sleep 5
curl -s $API/api/districts | head -c 400      # boundaries.autoDetect.enabled=true
```
Rollback: `setenv DISTRICT_AUTO_DETECT_ENABLED false` + restart.

## 7. MIJOZ/ADMIN (Vercel Preview) — qarang `lakmago-client/docs/DISTRICT-PRODUCTION-TEST.md`

## 8. TEST MATRITSASI

| # | Tekshiruv | Qanday | Kutilgan |
|---|---|---|---|
| 1 | GPS avtomatik tuman | Preview'ni telefon brauzerida oching, joylashuv ruxsatini bering | Chip "… tumani · Avtomatik"; ruxsat ilova ochilganda SO'RALMAYDI |
| 2 | Qo'lda tuman | Chip → ro'yxatdan tanlang | Katalog yangilanadi; GPS uni o'zgartirmaydi |
| 3 | Pop ↔ Chust | Joylashuvni almashtiring (haqiqiy yoki DevTools Sensors) | 2 aniq o'lchovdan keyin almashadi; chegara (50 m) yonida sakramaydi |
| 4 | Restoran katalogi | Bosh sahifa, qidiruv | Xatosiz; `legacy=show` bo'lganda restoran yo'qolmaydi |
| 5 | Market | Market bo'limi | Do'konlar/mahsulotlar xatosiz yuklanadi (Market'da chip yo'q — tanlangan tuman so'rovga qo'shiladi) |
| 6 | Savat | Taom qo'shing, adres tanlang | Narx/miqdor to'g'ri; savat yo'qolmaydi |
| 7 | Buyurtma (NAQD) | O'zingiz kelishgan restorandan 1 ta buyurtma, darhol bekor qiling | Yaratiladi; narx = menyudagi narx |
| 8 | Buyurtma (KARTA) — TO'LAMANG | Karta tanlab to'lov sahifasini yoping | Restoran panelida/botida **ko'rinmasligi SHART** (`awaiting_payment`, CLAUDE.md 1-qoida); savat saqlanadi |
| 9 | To'lov | Faqat o'zingiz xohlasangiz: minimal summa, keyin qaytarish | Muvaffaqiyatdan keyingina restoranga boradi |
| 10 | Yetkazish masofasi | 3 ta (restoran, manzil) juftligi: `GET $API/api/maps/delivery-quote?...` flag OFF va ON | Narx/masofa **bir xil** (district bu yo'lga tegmagan) |
| 11 | Eski mijoz | `lokma.uz` (production) ni oching | Hech narsa o'zgarmagan, chip yo'q |

Haqiqiy buyurtma/to'lov sinovlarida restoran xodimiga oldindan ayting. Hech qachon notanish restoranga sinov buyurtmasi bermang.

## 9. TEZ-TEZ KUZATISH (har bosqichdan keyin 10–15 daqiqa)

```bash
pm2 logs $PM2_NAME --lines 100 --nostream | grep -iE "error|unhandled|ECONN|429" | tail -20
pm2 status | grep $PM2_NAME           # restart soni oshmasligi kerak
curl -s -o /dev/null -w "%{http_code} %{time_total}s\n" $API/health
```
Qizil belgilar: `restarts` oshishi, 5xx ko'payishi, buyurtmalar kamayishi, restoran paneli bo'sh qolishi.

## 10. ROLLBACK

**A. Tezkor (30 soniya, kod joyida qoladi) — barcha district flaglarini o'chirish:**
```bash
cd $APP_DIR
cp .env .env.bak-rollback-$(date +%F-%H%M)
for k in DISTRICT_BOUNDARIES_ENABLED DISTRICT_AUTO_DETECT_ENABLED DISTRICT_CATALOG_FILTER_ENABLED; do
  grep -q "^$k=" .env && sed -i "s|^$k=.*|$k=false|" .env
done
grep -E '^DISTRICT_' .env
pm2 restart $PM2_NAME --update-env && sleep 5
curl -s -o /dev/null -w "health %{http_code}\n" $API/health
curl -s $API/api/districts | grep -c boundaries      # 0
```
Mijoz: Vercel Preview env'larini o'chirish/`false` (production'da ular yo'q edi).

**B. To'liq (avvalgi barqaror commit'ga qaytish):**
```bash
cd $APP_DIR
git checkout $PREV_SHA          # 2.1 da yozib olingan SHA (yoki: git checkout main)
git diff --quiet $BR HEAD -- package-lock.json || npm ci --omit=dev
pm2 restart $PM2_NAME --update-env && sleep 5
git rev-parse HEAD ; curl -s -o /dev/null -w "health %{http_code}\n" $API/health
```
`.env` ni oldingi holatga: `cp .env.bak-<vaqt> .env` (faqat kerak bo'lsa) + restart.

**C. Ma'lumot:** district bazaga HECH NARSA yozmaydi (`--apply` qilinmagan) — tiklash kerak emas. Agar kelajakda `--apply` bajarilsa: `npm run district:migrate -- --rollback=backups/service-districts-<vaqt>.json`; eng so'nggi chora — `~/backups/lokmago-pre-district-*.json`.

## 11. CHEKLOVLAR (halollik)

- Tumanlararo yetkazish qoidasi YO'Q (mavjud masofa qoidasi saqlanadi).
- Davlatobod va Yangi Namangan poligoni yo'q — avtomatik aniqlanmaydi.
- Testlar FerretDB'da o'tgan; haqiqiy Atlas'da birinchi marta shu yerda ishlaydi.
- GitHub Actions CI billing sababli ishlamayapti — CI natijasi yo'q.
