/*
 * MIJOZGA QAYTADIGAN BUYURTMA — moliya snapshotisiz + xarita uchun geo.
 */
export function customerOrderView(order, restaurantExtra = null) {
  if (!order) return order;
  const o = typeof order.toJSON === 'function' ? order.toJSON() : { ...order };
  delete o.finance;

  // Xarita: restoran nuqtasi (client TrackMap ishlatadi)
  if (restaurantExtra) {
    if (Number.isFinite(restaurantExtra.lat)) o.restaurantLat = restaurantExtra.lat;
    if (Number.isFinite(restaurantExtra.lng)) o.restaurantLng = restaurantExtra.lng;
    if (restaurantExtra.phone) o.restaurantPhone = restaurantExtra.phone;
    if (restaurantExtra.imageUrl) o.restaurantImage = restaurantExtra.imageUrl;
    if (restaurantExtra.address) o.restaurantAddress = restaurantExtra.address;
  }
  return o;
}

/** Bir nechta order uchun restoranlarni bir so'rovda yuklab biriktiradi */
export async function attachRestaurantGeo(orders) {
  if (!orders?.length) return orders.map((o) => customerOrderView(o));
  const { Restaurant } = await import('../models/Restaurant.js');
  const ids = [...new Set(orders.map((o) => String(o.restaurantId)).filter(Boolean))];
  const rests = await Restaurant.find({ _id: { $in: ids } })
    .select('lat lng phone imageUrl address')
    .lean();
  const map = new Map(rests.map((r) => [String(r._id), r]));
  return orders.map((o) => customerOrderView(o, map.get(String(o.restaurantId)) || null));
}