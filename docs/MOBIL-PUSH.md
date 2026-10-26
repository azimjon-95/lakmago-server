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
| `GET /api/panel/devices` | monitoring |

## Sozlash (.env)
**Android (FCM):** Firebase Console → Project settings → Service accounts → *Generate new private key* →
`FCM_SERVICE_ACCOUNT_BASE64=$(base64 -w0 key.json)`. Loyiha ilovaning `google-services.json`i bilan BIR XIL bo'lishi shart.

**iOS (APNs):** developer.apple.com → Keys → *Apple Push Notifications service (APNs)* → `.p8` →
`APNS_KEY_BASE64=$(base64 -w0 AuthKey_XXXX.p8)`, `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_BUNDLE_ID=uz.lokmago.restaurant`,
`APNS_PRODUCTION=true` (App Store / TestFlight; Xcode'dan to'g'ridan o'rnatilgan build uchun `false`).

Ishga tushganda logda: `[mobilePush] Android(FCM): yoqilgan · iOS(APNs): yoqilgan (production)`.

## Testlar
`npm run test:mobile-push` — 45 tekshiruv: JWT imzolari (haqiqiy kalitlar), FCM v1 yo'li (soxta Google OAuth/FCM),
APNs yo'li (lokal HTTP/2 server), qurilma controller'i (izolyatsiya, ko'chish), 1-QOIDA, dublikat, qayta yuborish va to'xtash,
yaroqsiz tokenlarni tozalash, emitOrderToRestaurant ulanishi (teskari sinov: ulanish olib tashlansa 3 ta tekshiruv yiqiladi).
**Haqiqiy telefonga yetishi bu test bilan tekshirilmaydi** — qurilmada sinash kerak.
