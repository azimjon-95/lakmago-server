/*
 * Restoran paneli: LokmaGo kuryeri ko'rinishi va yetkazish puli kimniki (services/panelOrderView.js).
 * Kuryer ulushi / LokmaGo foizi restoranga CHIQMAYDI. npm run test:panel-order-courier
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { toPanelOrder, lokmaCourierView } from '../src/services/panelOrderView.js';
import { computeOrderFinance, somToTiyin } from '../src/services/orderFinance.js';
import { applyDeliveryParty } from '../src/services/deliveryParty.js';

const fin = (party) => applyDeliveryParty(computeOrderFinance({ foodBaseTiyin: somToTiyin(100000), deliveryFeeTiyin: somToTiyin(30000), customerFeePercent: 3, restaurantCommissionPercent: 10 }), { party, percent: 10 });
const base = (over = {}) => ({ _id: 'o1', status: 'ready', fulfillment: 'delivery', userId: { _id: 'u1', firstName: 'Ali' }, ...over });

test('LokmaGo kuryeri olgan: ismi/telefoni ko\'rinadi, balansi/daromadi YO\'Q', () => {
  const o = toPanelOrder(base({ courierParty: 'lokma', finance: fin('lokma'), lokmaCourier: { courierId: { _id: 'k1', name: 'Vali', phone: '+998901234567', vehicle: 'moto' }, claimedAt: new Date(1), pickedUpAt: null } }));
  assert.deepEqual({ ...o.lokmaCourier, claimedAt: undefined }, { assigned: true, name: 'Vali', phone: '+998901234567', vehicle: 'moto', claimedAt: undefined, pickedUpAt: null });
  assert.equal(o.finance.courierParty, 'lokma');
  assert.equal(o.finance.restaurantDeliveryPayout, 0, 'yetkazish puli restoranga tushmaydi');
  assert.equal(o.finance.restaurantPayout, 90000, 'taom 100 000 − 10%');
  const json = JSON.stringify(o);
  for (const hidden of ['courierPayout', 'lokmaDeliveryCommission', 'deliverySubsidy', 'courierCommissionPercent', 'lokmaNetCommission']) {
    assert.ok(!json.includes(hidden), `${hidden} restoranga chiqmasin`);
  }
});

test('qutida (hali olinmagan) va populate qilinmagan holat — bir xil shakl, buzilmaydi', () => {
  assert.deepEqual(lokmaCourierView({ courierParty: 'lokma', lokmaCourier: { courierId: null } }), { assigned: false, name: '', phone: '', vehicle: '', claimedAt: null, pickedUpAt: null });
  assert.equal(lokmaCourierView({ courierParty: 'lokma', lokmaCourier: { courierId: '65f0c0ffee0000000000abcd' } }).assigned, true);
  assert.equal(lokmaCourierView({ courierParty: 'restaurant' }), null);
  assert.equal(toPanelOrder(base({ courierParty: 'restaurant', finance: fin('restaurant') })).finance.restaurantDeliveryPayout, 30000);
});
