# Production'da moliyaviy auditni XAVFSIZ ishga tushirish (read-only)

Bu yo'riqnoma `scripts/finance-audit.mjs` ni production bazasida ishga tushirish uchun. U:
- **deploy qilmaydi**;
- **production papkasi (`~/projects/lakmago-server`) va uning kodiga tegmaydi**;
- **PM2 ni restart qilmaydi**;
- **bazaga hech narsa yozmaydi**.

> Skript fayli: `fix/finance-phase2` branch'i, `scripts/finance-audit.mjs`
> SHA-256: `2644f44cdd7fdcc4dc846b7a9536b3a951b7654ea7ea875c773fb6bb63b32c40`

---

## 1. Nima uchun xavfsiz

Uchta **mustaqil** qatlam bor. Bittasi ishlamay qolsa ham qolgan ikkitasi yozuvga yo'l qo'ymaydi.

| Qatlam | Qayerda tekshiriladi | Nima qiladi |
|---|---|---|
| 1. Read-only Atlas foydalanuvchisi | **Atlas serveri** | Foydalanuvchida yozish huquqi yo'q — har qanday yozuvni baza o'zi rad etadi |
| 2. Huquq darvozasi | Skript, kolleksiyalarga murojaatdan **oldin** | `connectionStatus { showPrivileges: true }` bilan foydalanuvchining haqiqiy huquqlarini o'qiydi. Faqat o'qish huquqlaridan boshqa birorta huquq bo'lsa (insert, update, createIndex, …) yoki foydalanuvchi aniqlanmasa — **ishga tushmaydi** (chiqish kodi 4) |
| 3. Buyruq ruxsat ro'yxati | Drayver, har bir buyruq **yuborilishidan oldin** | Faqat `hello`, `connectionStatus`, `find`, `aggregate`, `getMore`, `killCursors`, `endSessions` va autentifikatsiya buyruqlari. Boshqasi (`insert` va h.k.) yoki `$out`/`$merge` chiqsa — darhol to'xtaydi (chiqish kodi 3) |

**Qo'shimcha cheklovlar:**
- `.env` **o'qilmaydi** — ilovaning yozish huquqli `MONGO_URI` si tasodifan ishlatilmaydi. Manzil faqat `FINANCE_AUDIT_URI` dan olinadi.
- `FINANCE_AUDIT_URI` ilovaning `MONGO_URI` siga teng bo'lsa — rad.
- Mongoose va modellar yo'q, ya'ni indeks yoki kolleksiya avtomatik yaratilmaydi.
- O'qishlar ikkilamchi tugundan (`secondaryPreferred`) — asosiy tugunga yuk tushmaydi.
- Har bir operatsiyaga vaqt chegarasi (`maxTimeMS` 120 s).
- Natija faqat lokal faylga, `0600` huquq bilan; mavjud faylning ustidan yozmaydi.

**Isbot** — `tests/finance-audit-readonly.test.mjs` (41 tekshiruv), autentifikatsiyali replica set'da (Atlas kabi):
- read-only foydalanuvchi bilan to'liq audit → **oplog'da `lokmago.*` uchun yangi yozuv 0 ta**, `dbHash` o'zgarmadi, kolleksiyalar ro'yxati o'zgarmadi;
- readWrite foydalanuvchi, root va autentifikatsiyasiz ulanish → **rad** (4);
- skriptga ataylab `insertOne` kiritib, **yozish huquqli** foydalanuvchi bilan ishga tushirilganda ham → buyruq ro'yxati to'xtatdi (3), hujjat yozilmadi, oplog o'zgarmadi.

---

## 2. Atlas'da vaqtinchalik read-only foydalanuvchi yaratish

Bu Atlas **boshqaruv panelidagi** sozlama — production ma'lumotlariga tegmaydi.

1. Atlas → loyiha → **Database Access** → **Add New Database User**.
2. **Authentication Method:** Password. Username, masalan `lokma_audit_ro`. **Autogenerate Secure Password** → parolni nusxalang.
3. **Database User Privileges → Built-in Role:** **Only read any database**.
   - Yoki: Specific Privileges → `read` → baza nomi (ilova bazasi).
   - **readWrite, Atlas admin va boshqa rollarni BERMANG.**
4. **Restrict Access to Specific Clusters:** faqat production klaster.
5. **Temporary User:** yoqing → **6 hours**. Foydalanuvchi o'zi o'chadi.
6. **Add User.**

Network Access'da VPS IP'si allaqachon bor (ilova ulanadi), o'zgartirish shart emas.

---

## 3. VPS'da bajariladigan buyruqlar

Hammasi **alohida papkada** (`~/lokma-audit`). `~/projects/lakmago-server` da faqat **o'qish** buyruqlari ishlatiladi: `git remote get-url` va baza nomini aniqlash.

### 3.1. Skriptni production papkasidan tashqarida olish

```bash
mkdir -p ~/lokma-audit && chmod 700 ~/lokma-audit && cd ~/lokma-audit

# Production repo'sining remote manzilini O'QIYMIZ (hech narsa o'zgarmaydi)
REPO_URL="$(git -C ~/projects/lakmago-server remote get-url origin)"

# Faqat bitta faylni, alohida papkaga (production papkasiga tegmaydi)
git clone --depth 1 --branch fix/finance-phase2 --filter=blob:none --no-checkout "$REPO_URL" repo
git -C repo sparse-checkout set --no-cone /scripts/finance-audit.mjs
git -C repo checkout fix/finance-phase2
unset REPO_URL

cp repo/scripts/finance-audit.mjs ./finance-audit.mjs

# Fayl aynan ko'rib chiqilgan versiya ekanini tekshiring:
sha256sum finance-audit.mjs
# kutilgan: 2644f44cdd7fdcc4dc846b7a9536b3a951b7654ea7ea875c773fb6bb63b32c40
```

**Hash mos kelmasa — TO'XTANG**, ishga tushirmang.

### 3.2. Faqat MongoDB drayverini o'rnatish (production `node_modules` ga tegmaydi)

```bash
cd ~/lokma-audit
printf '{"private":true,"type":"module"}\n' > package.json
npm install --no-save --ignore-scripts --no-audit --no-fund mongodb@6.20.0
node -v    # Node 18+ bo'lishi kerak
```

### 3.3. Baza nomini aniqlash (parol ko'rsatilmaydi)

```bash
grep -E '^MONGO_URI=' ~/projects/lakmago-server/.env | sed -E 's#(mongodb(\+srv)?://)[^@]*@#\1***:***@#'
# masalan: MONGO_URI=mongodb+srv://***:***@cluster0.xxxxx.mongodb.net/lokmago?retryWrites=true...
#                                          ^ klaster xosti          ^ baza nomi
```

### 3.4. Read-only manzilni xavfsiz kiritish

Parol buyruqlar tarixiga (`history`) tushmaydi:

```bash
read -rsp 'Read-only URI: ' FINANCE_AUDIT_URI; echo
export FINANCE_AUDIT_URI
```

Kiritiladigan manzil:
```
mongodb+srv://lokma_audit_ro:<PAROL>@<KLASTER_XOSTI>/<BAZA_NOMI>?retryWrites=false&appName=lokma-audit
```

Parolda `@ : / ? # %` belgilari bo'lsa, ularni URL-kodlang (masalan `@` → `%40`).

### 3.5. Avval qisqa tekshiruv (bitta kun), keyin to'liq audit

```bash
cd ~/lokma-audit

# 1) Tez tekshiruv: huquq darvozasidan o'tadimi, bitta kunlik ma'lumot bilan
nice -n 10 node finance-audit.mjs --db=test --from=$(date +%F) --to=$(date +%F) --out=audit-check-$(date +%F-%H%M).json
echo "chiqish kodi: $?"

# 2) To'liq audit (butun tarix) — JSON faylga
nice -n 10 node finance-audit.mjs --db=test --out=audit-full-$(date +%F-%H%M).json
echo "chiqish kodi: $?"

# Ixtiyoriy: davr bo'yicha (Toshkent vaqti)
# nice -n 10 node finance-audit.mjs --db=test --from=2026-11-01 --to=2026-11-22 --out=audit-nov.json
```

### 3.6. Chiqish kodlari

| Kod | Ma'nosi | Nima qilish kerak |
|---|---|---|
| **0** | Audit tugadi, JSON saqlandi | Faylni ko'rib chiqing yoki yuboring |
| **2** | Noto'g'ri parametr: URI yo'q, sana formati xato, `--out` fayli allaqachon bor | Parametrni tuzating |
| **3** | Ruxsat etilmagan buyruq ushlandi — **hech narsa yozilmadi** | To'xtang, xabarni yuboring |
| **4** | Foydalanuvchida o'qishdan boshqa huquq bor yoki foydalanuvchi aniqlanmadi — **skript ma'lumotga murojaat qilmadi** | Atlas'dagi rolni tekshiring (faqat "Only read any database"). **Boshqa foydalanuvchi bilan qayta urinmang** |
| **1** | Ulanish yoki vaqt xatosi (masalan, `maxTimeMS`) | Xabarni yuboring |

### 3.7. Natijani tekshirish

```bash
ls -l audit-*.json          # huquq: -rw------- (0600)
node -e "const j=require('./'+process.argv[1]); console.log(j.readOnly, j.commandsSent, j.summary, j.balanceDriftTotal)" "$(ls -t audit-full-*.json | head -1)"
```

JSON ichida isbot uchun quyidagilar bor:
- `readOnly` — qaysi foydalanuvchi, qaysi rollar, qaysi huquqlar bilan ishlagani (faqat o'qish);
- `commandsSent` — bazaga yuborilgan **barcha** buyruqlar (faqat `connectionStatus`, `hello`, `aggregate`, `find`, `getMore`, …);
- `summary` — har bir tekshiruv bo'yicha topilganlar soni;
- `balanceDriftTotal` — restoran balanslari va jurnal orasidagi jami farq.

JSON'da restoran nomlari, ID'lar va summalar bor. Mijozlarning shaxsiy ma'lumotlari (telefon, manzil, ism) **yo'q**. Shunday bo'lsa ham faylni faqat ishonchli kanal orqali yuboring.

### 3.8. Tozalash

```bash
unset FINANCE_AUDIT_URI
cd ~ && rm -rf ~/lokma-audit/repo ~/lokma-audit/node_modules ~/lokma-audit/package.json ~/lokma-audit/finance-audit.mjs
# audit-*.json fayllari ~/lokma-audit da qoladi (kerak bo'lmasa o'chiring)
```

Atlas → Database Access → `lokma_audit_ro` → **Delete**. Vaqtinchalik foydalanuvchi 6 soatdan keyin o'zi ham o'chadi.

---

> **Baza nomi.** Atlas manzilida baza nomi yo'q bo'lsa, ilova mongoose standarti bo'yicha `test` bazasiga yozadi. Haqiqiy bazani `--db=` bilan bering
> (production'da: `--db=test`, 2026-11-22 da `ledgers`/`orders` mavjudligi tekshirilgan).

## 4. Bu yo'riqnomada QILINMAYDIGAN narsalar

- `~/projects/lakmago-server` da `git pull`, `git checkout`, `npm install` — **yo'q**
- `pm2 restart` / `reload` — **yo'q**
- `main` ga merge yoki deploy — **yo'q**
- Ilovaning `MONGO_URI` si yoki o'qish-yozish huquqli foydalanuvchi bilan ishga tushirish — **yo'q** (skript buni rad etadi)
- Audit topgan muammolarni tuzatish — **yo'q** (faqat ko'rib chiqilgan reja bilan, alohida)

---

## 5. Chuqurlashtirilgan audit (3 restoran + 4 buyurtma)

`scripts/finance-audit-drilldown.mjs` — birinchi audit topgan 3 ta restoran (balans ≠ jurnal) va 4 ta buyurtma (musbatsiz manfiy komissiya) uchun.
Doira (SCOPE) kod ichida qat'iy belgilangan, parametr bilan kengaytirib bo'lmaydi (`--restaurants`/`--orders` → chiqish kodi 2).

Himoya: yuqoridagi uchta qatlam aynan saqlangan (huquq darvozasi → 4, buyruq ro'yxati / `$out`/`$merge` → 3, kodda yozish metodlari yo'q).
Shaxsiy ma'lumotlar (telefon, manzil, ism, `userId`, karta rekvizitlari, bekor qilish matni) so'ralmaydi.
Hisobot har bir restoran va buyurtma uchun **FAKT / TAXMIN / NOMA'LUM** bo'limlariga ajratilgan. Hech narsa tuzatilmaydi.

```bash
cd ~/lokma-audit
# Yangi faylni olish (production papkasiga tegmaydi)
git -C repo fetch --depth 1 origin fix/finance-phase2
git -C repo sparse-checkout set --no-cone /scripts/finance-audit.mjs /scripts/finance-audit-drilldown.mjs
git -C repo checkout -q --detach FETCH_HEAD
cp repo/scripts/finance-audit-drilldown.mjs ./finance-audit-drilldown.mjs
sha256sum finance-audit-drilldown.mjs
# kutilgan: 6a592b1a755fe654ebf1209fa78331988d451e1ef35510356105e8fda9376a0b   (mos kelmasa — TO'XTANG)

# FINANCE_AUDIT_URI o'rnatilgan bo'lishi kerak (3.4 bo'limi; faqat "Only read any database" foydalanuvchisi)
nice -n 10 node finance-audit-drilldown.mjs --db=test --out=drilldown-$(date +%F-%H%M).json
echo "chiqish kodi: $?"
```

Chiqish kodlari 3.6 bo'limidagi bilan bir xil. Isbot: `tests/finance-drilldown-readonly.test.mjs` (118 tekshiruv; oplog/dbHash o'zgarmasligi, readWrite/root/autentifikatsiyasiz rad, inject va `$out` ushlanishi).
