import { Router } from 'express';
import { restaurantController, dishController } from '../controllers/catalog.js';
import { bannerController, authController, orderController } from '../controllers/misc.js';
import { reservationController, paymentController } from '../controllers/services.js';
import { adminController } from '../controllers/admin.js';
import { panelAuthController } from '../controllers/panelAuth.js';
import { notificationController } from '../controllers/notifications.js';
import { agreementController } from '../controllers/agreements.js';
import { restaurantPanelController } from '../controllers/restaurantPanel.js';
import { uploadController } from '../controllers/upload.js';
import { referralController } from '../controllers/referralController.js';
import { addressController } from '../controllers/address.js';
import { supportController } from '../controllers/support.js';
import { cardController } from '../controllers/cards.js';
import { paymentController as gatewayController } from '../controllers/payments.js';
import { billingController } from '../controllers/billing.js';
import { mapsController } from '../controllers/maps.js';
import { catalogProductController } from '../controllers/catalogProducts.js';
import { menuTransferController } from '../controllers/menuTransfer.js';
import { promotionController } from '../controllers/promotions.js';
import { promoAdminController } from '../controllers/promoAdmin.js';
import { publicPromoController } from '../controllers/publicPromo.js';
import { dineInController } from '../controllers/dineIn.js';
import { dineInOrderController } from '../controllers/dineInOrder.js';
import { waiterController } from '../controllers/waiter.js';
import { dineInLiveController } from '../controllers/dineInLive.js';
import { auth, requireRole, waiterAuth } from '../middleware/auth.js';

export const router = Router();

// Qisqartmalar — takrorlanmasin
const A = [auth, requireRole('admin')];        // Super Admin
const R = [auth, requireRole('restaurant')];   // Restoran paneli

// ===== Autentifikatsiya =====
router.post('/auth/telegram', authController.telegram);       // mijoz (webapp)
router.post('/auth/login', panelAuthController.login);         // admin/restoran (panel)
router.get('/auth/me', auth, panelAuthController.me);

// ===== Ochiq katalog (mijoz webapp) =====
router.get('/banners', bannerController.list);
router.get('/restaurants', restaurantController.list);
router.get('/restaurants/:id', restaurantController.getOne);
router.get('/restaurants/:id/dishes', restaurantController.getDishes);
router.get('/dishes/trending', dishController.trending);
router.get('/dishes/discounted', dishController.discounted);
router.get('/dishes/all', dishController.all);
router.get('/dishes/:id', restaurantController.getDishById);

// ===== Mijoz buyurtmalari (JWT) =====
router.post('/orders', auth, orderController.create);
router.get('/orders', auth, orderController.myOrders);
router.patch('/orders/:id/cancel', auth, orderController.cancelOrder);
router.get('/orders/active', auth, orderController.active);
router.get('/orders/group/:groupId', auth, orderController.getGroup);
router.get('/orders/:id', auth, orderController.getOne);
router.patch('/orders/:id/confirm', auth, orderController.confirmDelivery);

router.post('/payments/create', auth, paymentController.create);
router.post('/payments/callback', paymentController.callback);

router.get('/reservations/my', auth, reservationController.myReservations);
router.patch('/reservations/:id/cancel', auth, reservationController.cancelMine);
router.post('/reservations', auth, reservationController.create);
router.get('/reservations', auth, reservationController.myReservations);

// ===== Restoran paneli (role: restaurant) =====
router.get('/panel/me', auth, requireRole('restaurant'), restaurantPanelController.profile);
router.patch('/panel/me', auth, requireRole('restaurant'), restaurantPanelController.updateProfile);
router.patch('/panel/me/active', auth, requireRole('restaurant'), restaurantPanelController.toggleActive);
router.get('/panel/dishes', auth, requireRole('restaurant'), restaurantPanelController.dishes);
// Aniq yo'llar :id dan OLDIN — aks holda 'stopped' id deb qabul qilinadi
router.get('/panel/dishes/stopped', auth, requireRole('restaurant'), restaurantPanelController.stoppedDishes);
router.get('/panel/dishes/stopped/count', auth, requireRole('restaurant'), restaurantPanelController.stoppedCount);
router.post('/panel/dishes', auth, requireRole('restaurant'), restaurantPanelController.createDish);
router.patch('/panel/dishes/:id', auth, requireRole('restaurant'), restaurantPanelController.updateDish);
router.patch('/panel/dishes/:id/stop', auth, requireRole('restaurant'), restaurantPanelController.toggleStop);
router.delete('/panel/dishes/:id', auth, requireRole('restaurant'), restaurantPanelController.deleteDish);
router.get('/panel/orders', auth, requireRole('restaurant'), restaurantPanelController.orders);
router.patch('/panel/orders/:id/status', auth, requireRole('restaurant'), restaurantPanelController.updateOrderStatus);
router.get('/panel/reservations', auth, requireRole('restaurant'), reservationController.forRestaurantSelf);
router.patch('/panel/reservations/:id/status', auth, requireRole('restaurant'), reservationController.updateStatus);
router.patch('/panel/orders/:id/paid', auth, requireRole('restaurant'), restaurantPanelController.markPaid);
router.get('/panel/banner', auth, requireRole('restaurant'), restaurantPanelController.getBanner);
router.put('/panel/banner', auth, requireRole('restaurant'), restaurantPanelController.setBanner);
router.delete('/panel/banner', auth, requireRole('restaurant'), restaurantPanelController.deleteBanner);

// ===== Cloudinary rasm yuklash imzosi =====
// Faqat kirgan foydalanuvchi (restoran yoki admin) rasm yuklay oladi.
router.get('/upload/signature', auth, uploadController.signature);

// ===== Referral tizimi =====
router.get('/referral/me', auth, referralController.me);
router.get('/referral/subscription', auth, referralController.subscription);

// ===== Manzillar (serverda saqlanadi — hamma qurilmada ko'rinadi) =====
router.get('/addresses', auth, addressController.list);
router.post('/addresses', auth, addressController.create);
router.patch('/addresses/:id', auth, addressController.update);
router.delete('/addresses/:id', auth, addressController.remove);
router.patch('/addresses/:id/default', auth, addressController.setDefault);

// ===== DINE-IN =====
// Mijoz: login TALAB QILINMAYDI
router.post('/dine-in/scan', dineInController.scan);
router.get('/dine-in/session/:id', dineInController.getSession);

router.get('/dine-in/menu/:restaurantId', dineInOrderController.menu);
router.post('/dine-in/orders', dineInOrderController.createFromQr);
router.get('/dine-in/orders/:sessionId', dineInOrderController.sessionOrders);
router.post('/dine-in/request', dineInLiveController.createRequest);
router.get('/dine-in/requests/:sessionId', dineInLiveController.mySessionRequests);
router.get('/dine-in/receipt/:sessionId', dineInLiveController.receipt);

// Ofitsiant — alohida autentifikatsiya
router.post('/waiter/login', waiterController.login);
router.get('/waiter/me', waiterAuth, waiterController.me);
router.get('/waiter/tables', waiterAuth, waiterController.myTables);
router.post('/waiter/orders', waiterAuth, dineInOrderController.createFromWaiter);
router.get('/waiter/orders', waiterAuth, dineInOrderController.waiterOrders);
router.get('/waiter/tables/:id', waiterAuth, waiterController.tableDetail);
router.patch('/waiter/tables/:id/guests', waiterAuth, waiterController.setGuests);
router.patch('/waiter/orders/:id/status', waiterAuth, dineInOrderController.updateStatus);
router.post('/waiter/tables/:tableId/close', waiterAuth, dineInLiveController.closeTable);
router.get('/waiter/requests', waiterAuth, dineInLiveController.listRequests);
router.patch('/waiter/requests/:id', waiterAuth, dineInLiveController.updateRequest);
router.get('/waiter/menu/:restaurantId', waiterAuth, dineInOrderController.menu);

// Komissiya shartnomalari (admin) va yetkazish ustamasi (restoran)
router.get('/admin/agreements', ...A, agreementController.list);
router.put('/admin/agreements/:restaurantId', ...A, agreementController.upsert);
router.get('/admin/agreements/:restaurantId/history', ...A, agreementController.history);
router.get('/panel/agreement', ...R, agreementController.myAgreement);
router.patch('/panel/delivery-markup', ...R, agreementController.setDeliveryMarkup);

// Bildirishnomalar — admin ham, restoran ham (auth ichida ajratiladi)
router.get('/panel/notifications', auth, notificationController.list);
router.patch('/panel/notifications/:id', auth, notificationController.updateStatus);

// Web Push obunasi — qamrov tokendan olinadi
router.get('/panel/push/key', auth, notificationController.publicKey);
router.post('/panel/push/subscribe', auth, notificationController.subscribe);
router.post('/panel/push/unsubscribe', auth, notificationController.unsubscribe);

// Restoran paneli
router.get('/panel/dine-in', ...R, dineInController.getConfig);
router.get('/panel/dine-in/orders', ...R, dineInOrderController.panelOrders);
router.patch('/panel/dine-in/orders/:id/status', ...R, dineInOrderController.updateStatus);
router.get('/panel/dine-in/dashboard', ...R, dineInLiveController.dashboard);
router.get('/panel/dine-in/requests', ...R, dineInLiveController.listRequests);
router.patch('/panel/dine-in/requests/:id', ...R, dineInLiveController.updateRequest);
router.post('/panel/dine-in/tables/:tableId/close', ...R, dineInLiveController.closeTable);

router.get('/panel/waiters/earnings', ...R, dineInLiveController.waiterEarnings);
router.post('/panel/waiters/:id/payout', ...R, dineInLiveController.payWaiter);

router.get('/panel/waiters', ...R, waiterController.list);
router.post('/panel/waiters', ...R, waiterController.create);
router.patch('/panel/waiters/:id', ...R, waiterController.update);
router.post('/panel/waiters/:id/reset-device', ...R, waiterController.resetDevice);
router.delete('/panel/waiters/:id', ...R, waiterController.remove);
router.post('/panel/dine-in/request', ...R, dineInController.requestActivation);
router.patch('/panel/dine-in/settings', ...R, dineInController.updateSettings);
router.patch('/panel/dine-in/theme', ...R, dineInController.updateTheme);

router.get('/panel/tables', ...R, dineInController.listTables);
router.get('/panel/tables/qr/pdf', ...R, dineInController.getAllQrPdf);
router.post('/panel/tables', ...R, dineInController.createTable);
router.post('/panel/tables/bulk', ...R, dineInController.createBulk);
router.get('/panel/tables/:id/qr', ...R, dineInController.getQr);
router.post('/panel/tables/:id/regenerate', ...R, dineInController.regenerateQr);
router.patch('/panel/tables/:id', ...R, dineInController.updateTable);
router.delete('/panel/tables/:id', ...R, dineInController.deleteTable);

// Super Admin
router.get('/admin/dine-in', ...A, dineInController.adminList);
router.get('/admin/dine-in/tariff', ...A, dineInController.getTariff);
router.patch('/admin/dine-in/tariff', ...A, dineInController.updateTariff);
router.get('/admin/dine-in/billing/:restaurantId', ...A, dineInController.billingHistory);
router.post('/admin/dine-in/billing/:restaurantId/pay', ...A, dineInController.markPaid);
router.patch('/admin/dine-in/:restaurantId', ...A, dineInController.adminSetStatus);

// ===== Aksiya va reklama — Client va Dine-in uchun =====
router.get('/promotions', publicPromoController.list);
router.get('/ads', publicPromoController.ads);
router.post('/ads/:id/event', publicPromoController.trackEvent);

// ===== Mijozlarni jalb qilish — Super Admin =====
router.get('/admin/promo/overview', ...A, promoAdminController.overview);
router.get('/admin/promo/restaurants', ...A, promoAdminController.restaurants);
router.get('/admin/promo/billing/:restaurantId', ...A, promoAdminController.billingHistory);
router.post('/admin/promo/billing/:restaurantId/pay', ...A, promoAdminController.markPaid);
router.patch('/admin/promo/subscription/:restaurantId', ...A, promoAdminController.setStatus);
router.get('/admin/promo/tariff', ...A, promoAdminController.getTariff);
router.patch('/admin/promo/tariff', ...A, promoAdminController.updateTariff);
router.post('/admin/promo/billing/run', ...A, promoAdminController.runBilling);

// ===== Mijozlarni jalb qilish — restoran =====
router.get('/panel/promo/overview', ...R, promotionController.overview);

router.get('/panel/promotions', ...R, promotionController.listPromotions);
router.post('/panel/promotions', ...R, promotionController.createPromotion);
router.patch('/panel/promotions/:id', ...R, promotionController.updatePromotion);
router.delete('/panel/promotions/:id', ...R, promotionController.deletePromotion);

router.get('/panel/bonuses', ...R, promotionController.listBonuses);
router.post('/panel/bonuses', ...R, promotionController.createBonus);
router.patch('/panel/bonuses/:id', ...R, promotionController.updateBonus);
router.delete('/panel/bonuses/:id', ...R, promotionController.deleteBonus);

router.get('/panel/ads', ...R, promotionController.listAds);
router.post('/panel/ads', ...R, promotionController.createAd);
router.patch('/panel/ads/:id', ...R, promotionController.updateAd);
router.delete('/panel/ads/:id', ...R, promotionController.deleteAd);

// ===== Menyu ko'chirish =====
router.get('/panel/restaurants/search', auth, requireRole('restaurant'), menuTransferController.searchRestaurants);
router.get('/panel/menu-transfers/pending/count', auth, requireRole('restaurant'), menuTransferController.pendingCount);
router.get('/panel/menu-transfers', auth, requireRole('restaurant'), menuTransferController.list);
router.post('/panel/menu-transfers', auth, requireRole('restaurant'), menuTransferController.create);
router.get('/panel/menu-transfers/:id', auth, requireRole('restaurant'), menuTransferController.detail);
router.patch('/panel/menu-transfers/:id/respond', auth, requireRole('restaurant'), menuTransferController.respond);

// ===== Umumiy mahsulot katalogi =====
// Admin yaratadi, restoranlar tanlab narxini qo'yadi
router.get('/admin/catalog', auth, requireRole('admin'), catalogProductController.list);
router.post('/admin/catalog', auth, requireRole('admin'), catalogProductController.create);
router.patch('/admin/catalog/:id', auth, requireRole('admin'), catalogProductController.update);
router.delete('/admin/catalog/:id', auth, requireRole('admin'), catalogProductController.remove);

router.get('/panel/catalog', auth, requireRole('restaurant'), catalogProductController.forRestaurant);
router.post('/panel/catalog/:id/add', auth, requireRole('restaurant'), catalogProductController.addToMenu);

// ===== Xarita =====
router.get('/maps/config', mapsController.config);
router.get('/maps/geocode', mapsController.geocode);
router.get('/maps/reverse', mapsController.reverse);
router.get('/maps/delivery-quote', mapsController.deliveryQuote);

// ===== Moliya (admin) =====
router.get('/admin/billing/overview', auth, requireRole('admin'), billingController.overview);
router.get('/admin/billing/restaurants', auth, requireRole('admin'), billingController.byRestaurant);
router.get('/admin/billing/ledger', auth, requireRole('admin'), billingController.ledger);
router.get('/admin/billing/restaurant/:id', auth, requireRole('admin'), billingController.restaurantSummary);
router.post('/admin/billing/payout', auth, requireRole('admin'), billingController.payout);
router.patch('/admin/restaurants/:id/commission', auth, requireRole('admin'), billingController.setCommission);

// ===== To'lov tizimlari =====
// Webhook'lar — auth YO'Q (tizimlar o'z imzosi bilan tekshiriladi)
router.post('/payments/payme', gatewayController.paymeWebhook);   // eskirgan
router.post('/payments/paynet', gatewayController.paynetWebhook);
router.post('/payments/click/prepare', gatewayController.clickPrepare);
router.post('/payments/click/complete', gatewayController.clickComplete);
// Mijoz uchun
router.get('/payments/status', gatewayController.status);
router.get('/payments/link/:orderId', auth, gatewayController.getLink);
router.get('/payments/order/:orderId', auth, gatewayController.orderStatus);

// ===== To'lov kartalari =====
router.get('/cards', auth, cardController.list);
router.post('/cards', auth, cardController.create);
router.delete('/cards/:id', auth, cardController.remove);
router.patch('/cards/:id/default', auth, cardController.setDefault);

// ===== Qo'llab-quvvatlash chati =====
// Mijoz tomoni
router.get('/support/chat', auth, supportController.myChat);
router.get('/support/presence', supportController.presence);
router.post('/support/message', auth, supportController.sendMessage);
// Admin tomoni
router.get('/admin/support', auth, requireRole('admin'), supportController.list);
router.get('/admin/support/:id', auth, requireRole('admin'), supportController.getOne);
router.post('/admin/support/:id/reply', auth, requireRole('admin'), supportController.reply);
router.patch('/admin/support/:id/resolve', auth, requireRole('admin'), supportController.resolve);

// ===== Admin paneli (role: admin) — dastur egasi =====
router.get('/admin/stats', auth, requireRole('admin'), adminController.stats);
router.get('/admin/restaurants', auth, requireRole('admin'), adminController.restaurants);
router.get('/admin/restaurants/:id/dishes', auth, requireRole('admin'), adminController.restaurantDishes);
router.get('/admin/restaurants/:id/reservations', auth, requireRole('admin'), adminController.restaurantReservations);
router.post('/admin/restaurants', auth, requireRole('admin'), adminController.createRestaurant);
router.patch('/admin/restaurants/:id', auth, requireRole('admin'), adminController.updateRestaurant);
router.patch('/admin/restaurants/:id/password', auth, requireRole('admin'), adminController.resetRestaurantPassword);
router.delete('/admin/restaurants/:id', auth, requireRole('admin'), adminController.deleteRestaurant);
router.patch('/admin/restaurants/:id/block', auth, requireRole('admin'), adminController.toggleBlock);
router.get('/admin/settings', auth, requireRole('admin'), adminController.getSettingsData);
router.patch('/admin/settings', auth, requireRole('admin'), adminController.updateSettings);
router.get('/admin/revenue', auth, requireRole('admin'), adminController.revenue);
router.get('/admin/banners', auth, requireRole('admin'), adminController.banners);
router.post('/admin/banners', auth, requireRole('admin'), adminController.createBanner);
router.patch('/admin/banners/:id', auth, requireRole('admin'), adminController.updateBanner);
router.delete('/admin/banners/:id', auth, requireRole('admin'), adminController.deleteBanner);
// Telegram guruhlar
router.get('/admin/groups', auth, requireRole('admin'), adminController.groups);
router.post('/admin/groups/add', auth, requireRole('admin'), adminController.addGroup);
router.post('/admin/groups/:chatId/resend', auth, requireRole('admin'), adminController.resendPromo);
router.post('/admin/groups/:chatId/broadcast', auth, requireRole('admin'), adminController.broadcast);
router.post('/admin/groups/broadcast-all', auth, requireRole('admin'), adminController.broadcastAll);
router.post('/admin/groups/check', auth, requireRole('admin'), adminController.runGroupCheck);
// Buyurtmalar nazorati
router.get('/admin/orders', auth, requireRole('admin'), adminController.orders);
router.get('/admin/orders/live', auth, requireRole('admin'), adminController.liveOrders);
router.get('/admin/orders', auth, requireRole('admin'), adminController.allOrders);
router.get('/admin/users', auth, requireRole('admin'), adminController.users);
