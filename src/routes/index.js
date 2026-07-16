import { Router } from 'express';
import { restaurantController, dishController } from '../controllers/catalog.js';
import { bannerController, authController, orderController } from '../controllers/misc.js';
import { reservationController, paymentController } from '../controllers/services.js';
import { adminController } from '../controllers/admin.js';
import { panelAuthController } from '../controllers/panelAuth.js';
import { restaurantPanelController } from '../controllers/restaurantPanel.js';
import { uploadController } from '../controllers/upload.js';
import { auth, requireRole } from '../middleware/auth.js';

export const router = Router();

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
router.get('/dishes/:id', restaurantController.getDishById);

// ===== Mijoz buyurtmalari (JWT) =====
router.post('/orders', auth, orderController.create);
router.get('/orders', auth, orderController.myOrders);
router.get('/orders/active', auth, orderController.active);
router.get('/orders/group/:groupId', auth, orderController.getGroup);
router.get('/orders/:id', auth, orderController.getOne);
router.patch('/orders/:id/confirm', auth, orderController.confirmDelivery);

router.post('/payments/create', auth, paymentController.create);
router.post('/payments/callback', paymentController.callback);

router.post('/reservations', auth, reservationController.create);
router.get('/reservations', auth, reservationController.myReservations);

// ===== Restoran paneli (role: restaurant) =====
router.get('/panel/me', auth, requireRole('restaurant'), restaurantPanelController.profile);
router.patch('/panel/me/active', auth, requireRole('restaurant'), restaurantPanelController.toggleActive);
router.get('/panel/dishes', auth, requireRole('restaurant'), restaurantPanelController.dishes);
router.post('/panel/dishes', auth, requireRole('restaurant'), restaurantPanelController.createDish);
router.patch('/panel/dishes/:id', auth, requireRole('restaurant'), restaurantPanelController.updateDish);
router.patch('/panel/dishes/:id/stop', auth, requireRole('restaurant'), restaurantPanelController.toggleStop);
router.delete('/panel/dishes/:id', auth, requireRole('restaurant'), restaurantPanelController.deleteDish);
router.get('/panel/orders', auth, requireRole('restaurant'), restaurantPanelController.orders);
router.patch('/panel/orders/:id/status', auth, requireRole('restaurant'), restaurantPanelController.updateOrderStatus);
router.get('/panel/reservations', auth, requireRole('restaurant'), reservationController.forRestaurantSelf);
router.patch('/panel/reservations/:id/status', auth, requireRole('restaurant'), reservationController.updateStatus);
router.get('/panel/banner', auth, requireRole('restaurant'), restaurantPanelController.getBanner);
router.put('/panel/banner', auth, requireRole('restaurant'), restaurantPanelController.setBanner);
router.delete('/panel/banner', auth, requireRole('restaurant'), restaurantPanelController.deleteBanner);

// ===== Cloudinary rasm yuklash imzosi =====
// Faqat kirgan foydalanuvchi (restoran yoki admin) rasm yuklay oladi.
router.get('/upload/signature', auth, uploadController.signature);

// ===== Admin paneli (role: admin) — dastur egasi =====
router.get('/admin/stats', auth, requireRole('admin'), adminController.stats);
router.get('/admin/restaurants', auth, requireRole('admin'), adminController.restaurants);
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
router.post('/admin/groups/:chatId/resend', auth, requireRole('admin'), adminController.resendPromo);
router.post('/admin/groups/:chatId/broadcast', auth, requireRole('admin'), adminController.broadcast);
router.post('/admin/groups/broadcast-all', auth, requireRole('admin'), adminController.broadcastAll);
router.post('/admin/groups/check', auth, requireRole('admin'), adminController.runGroupCheck);
// Buyurtmalar nazorati
router.get('/admin/orders', auth, requireRole('admin'), adminController.orders);
router.get('/admin/orders/live', auth, requireRole('admin'), adminController.liveOrders);
router.get('/admin/orders', auth, requireRole('admin'), adminController.allOrders);
router.get('/admin/users', auth, requireRole('admin'), adminController.users);
