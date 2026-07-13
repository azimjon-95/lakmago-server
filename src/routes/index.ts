import { Router } from 'express';
import { restaurantController, dishController, dishManageController } from '../controllers/catalog.js';
import { bannerController, authController, orderController } from '../controllers/misc.js';
import { reservationController, paymentController } from '../controllers/services.js';
import { adminController } from '../controllers/admin.js';
import { auth, requireRole } from '../middleware/auth.js';

export const router = Router();

router.post('/auth/telegram', authController.telegram);

router.get('/banners', bannerController.list);
router.get('/restaurants', restaurantController.list);
router.get('/restaurants/:id', restaurantController.getOne);
router.get('/restaurants/:id/dishes', restaurantController.getDishes);
router.get('/dishes/trending', dishController.trending);
router.get('/dishes/discounted', dishController.discounted);

router.post('/orders', auth, orderController.create);
router.get('/orders', auth, orderController.myOrders);
router.get('/orders/:id', auth, orderController.getOne);

router.post('/payments/create', auth, paymentController.create);
router.post('/payments/callback', paymentController.callback);

router.post('/reservations', auth, reservationController.create);
router.get('/reservations', auth, reservationController.myReservations);

router.patch('/orders/:id/status', auth, requireRole('restaurant', 'admin'), orderController.updateStatus);
router.get('/restaurants/:id/orders', auth, requireRole('restaurant', 'admin'), restaurantController.getOrders);
router.get('/restaurants/:id/reservations', auth, requireRole('restaurant', 'admin'), reservationController.forRestaurant);
router.patch('/reservations/:id/status', auth, requireRole('restaurant', 'admin'), reservationController.updateStatus);
router.post('/restaurants/:id/dishes', auth, requireRole('restaurant', 'admin'), dishManageController.create);
router.patch('/dishes/:id', auth, requireRole('restaurant', 'admin'), dishManageController.update);

router.get('/admin/stats', auth, requireRole('admin'), adminController.stats);
router.get('/admin/restaurants', auth, requireRole('admin'), adminController.restaurants);
router.patch('/admin/restaurants/:id/approve', auth, requireRole('admin'), adminController.approveRestaurant);
router.get('/admin/users', auth, requireRole('admin'), adminController.users);
