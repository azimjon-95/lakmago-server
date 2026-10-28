# Restoran mobil ilovasiga push (yangi buyurtma)

## Muammo (ildiz sababi)
Restoran ilovasi (Android/iOS) yangi buyurtmani faqat **Socket.IO** orqali olardi. Serverda mobil push umuman yo'q edi
(faqat brauzer paneli uchun Web Push), ilova esa FCM tokenini serverga yubormasdi. Telefon qulflansa, ilova fonda yoki yopiq
bo'lsa OS soketni to'xtatadi → buyurtma faqat ilova **qo'lda ochilganda** kelardi.

## Yechim
`src/services/mobilePush.js` — FCM HTTP v1 (Android) va APNs HTTP/2 (iOS), **yangi kutubxonasiz** (node:crypto, node:http2).

* **Qayerdan:** faqat `services/orderSocket.js → emitOrderToRestaurant()` (yagona chiqish nuqtasi). U 1-QOIDA
  (`awaiting_payment`) tekshiruvidan keyin chaqiriladi; push o'zi ham **alohida** tekshiradi.
* **Android:** faqat `data` + `priority: HIGH` → Doze'da ham uyg'otadi; ilova o'zi takrorlanuvchi signal chaladi
  (foreground service, alarm ovozi), qabul qilinguncha.
* **iOS:** OS ko'rsatadigan ovozli xabar (`order_alert.wav`, `interruption-level: time-sensitive`), bir buyurtma = bitta
  xabar (`apns-collapse-id`). iOS ilova fonda o'zi ovoz chala olmaydi → server **qabul qilinmaguncha qayta yuboradi**
  (`MOBILE_PUSH_REPEAT_SEC`=30, `MOBILE_PUSH_MAX_SENDS`=10).
* **To'xtatish:** buyurtma qabul / bekor qilinishi bilan takror to'xtaydi; Android telefonlarga `order_updated` /
  `order_cancelled` (signal o'chadi), iOS'da ovozli xabar ovozsiz "qabul qilindi" bilan almashadi.
* **Dublikat yo'q:** `OrderPushState.orderId` unique; ikki server nusxasi bo'lsa ham takrorni bittasi yuboradi.
* **Monitoring:** `GET /api/panel/devices` — qurilmalar, oxirgi yuborish, oxirgi xato; logda har yuborish natijasi.
  Yaroqsiz token (FCM `UNREGISTERED`, APNs `410`) o'chiriladi; 5 marta ketma-ket xato — token o'chiriladi.
  Provayder qabul qilgani telefonga yetganini anglatmaydi — shuning uchun qayta yuborish bor.

## API
| | |
|---|---|
| `POST /api/panel/devices` `{token, platform: 'android'\|'ios'}` | ro'yxatga olish (204). restaurantId faqat tokendan |
| `DELETE /api/panel/devices` `{token}` | chiqishda (faqat o'z restoranining tokeni) |
| `GET /api/panel/devices` | monitoring: `providers` (server FCM/APNs sozlanganmi) va qurilmalar |
| `POST /api/panel/devices/test` | **diagnostika**: o'z telefonlariga test push, har qurilma uchun natija va provayderning aniq xatosi (10 s da 1 marta). Ilovadagi «Push tekshiruvi» shuni chaqiradi |

## Sozlash (.env)
**Android (FCM):** Firebase Console → Project settings → Service accounts → *Generate new private key* →
`FCM_SERVICE_ACCOUNT_BASE64=$(base64 -w0 key.json)`. Loyiha ilovaning `google-services.json`i bilan BIR XIL bo'lishi shart.

**iOS (APNs):** developer.apple.com → Keys → *Apple Push Notifications service (APNs)* → `.p8` →
`APNS_KEY_BASE64=$(base64 -w0 AuthKey_XXXX.p8)`, `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_BUNDLE_ID=uz.lokmago.restaurant`,
`APNS_PRODUCTION=true` (App Store / TestFlight; Xcode'dan to'g'ridan o'rnatilgan build uchun `false`).

Ishga tushganda logda: `[mobilePush] Android(FCM): yoqilgan · iOS(APNs): yoqilgan (production)`.

## Testlar
`npm run test:mobile-push` — 53 tekshiruv: JWT imzolari (haqiqiy kalitlar), FCM v1 yo'li (soxta Google OAuth/FCM),
APNs yo'li (lokal HTTP/2 server), qurilma controller'i (izolyatsiya, ko'chish), 1-QOIDA, dublikat, qayta yuborish va to'xtash,
yaroqsiz tokenlarni tozalash, emitOrderToRestaurant ulanishi (teskari sinov: ulanish olib tashlansa 3 ta tekshiruv yiqiladi).
**Haqiqiy telefonga yetishi bu test bilan tekshirilmaydi** — qurilmada sinash kerak.


## Konfiguratsiyani tekshirish (telefonsiz, production'ga tegmasdan)
Server ishga tushganda logda:
```
[mobilePush] Android(FCM): yoqilgan · iOS(APNs): yoqilgan (production)
[mobilePush] tekshiruv: Android=ok · iOS=kalit ochildi (Apple bilan tekshirish: «Test push»)
```
* **Android**: Google OAuth + FCM `validate_only` (xabar YUBORILMAYDI). `ok` = service account va loyiha to'g'ri.
  `xato: FCM 403` = Cloud Messaging API (FCM HTTP v1) yoqilmagan yoki kalit boshqa loyihadan; `401` = kalit yaroqsiz; `404` = project_id xato.
* **iOS**: .p8 ochiladi va imzo chiqadi. Apple bilan haqiqiy tekshiruv faqat telefon tokeni bilan mumkin → ilovada «Push tekshiruvi → Test push».
* Natija `GET /api/panel/devices` → `check` da ham ko'rinadi. Sir (kalit, token) logga yozilmaydi (testlangan).

**Muhit (iOS):** ilova `POST /api/panel/devices` da `environment: development|production` yuboradi. Xcode build tokeni sandbox APNs'ga,
TestFlight/App Store tokeni production APNs'ga ketadi — `BadDeviceToken` (sandbox/production mos emas) xatosi tugaydi.
Muhit yubormagan eski ilova uchun `APNS_PRODUCTION` ishlatiladi (oldingi xatti-harakat).

## Production xavfsizligi
* Faqat yangi `mobiledevices` va `orderpushstates` kolleksiyalari; mavjud kolleksiyalar, buyurtma, to'lov, komissiya, payout kodi O'ZGARMAGAN.
  Migratsiya yo'q. `MobileDevice.environment` ixtiyoriy maydon (default null) — orqaga mos.
* Push xatosi buyurtma oqimiga ta'sir qilmaydi: `emitOrderToRestaurant` push'ni kutmaydi va uning istisnosini yutadi (testlangan: baza xatosida ham soket hodisasi ketadi).
* `awaiting_payment` buyurtmaga push ketmaydi (1-QOIDA) — push ichida alohida tekshiriladi.
* Sozlanmagan provayder = jim o'chiq; qolgan tizim ishlayveradi.

## Deploy va rollback (faqat SIZNING tasdig'ingiz bilan)
1. `git pull` → `npm ci` (yangi kutubxona yo'q; lock o'zgarmagan) → `.env` ga FCM/APNs kalitlarini qo'shing → `pm2 restart lakmago-server`.
2. Logda yuqoridagi 2 qatorni tekshiring; `GET /api/panel/devices` → `check`.
3. Ilovada «Push tekshiruvi» → «Test push».
**Rollback:** `.env` dan `FCM_SERVICE_ACCOUNT_BASE64` va `APNS_KEY_BASE64` ni olib tashlab restart qiling — push butunlay o'chadi, qolgan tizim avvalgidek
(yoki `git revert <commit>` + restart). Yangi kolleksiyalarni o'chirish shart emas (OrderPushState 2 kundan keyin o'zi tozalanadi).
