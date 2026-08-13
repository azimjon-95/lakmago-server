import { ClickProvider } from './clickProvider.js';
import { PaynetProvider } from './paynetProvider.js';
import { PaymeProvider } from './paymeProvider.js';

/**
 * Provayderlar registri.
 *
 * Kontroller endi `if (provider === 'click')` yozmaydi — shu
 * yerdan oladi. Yangi shlyuz qo'shish: fayl yozib, shu ro'yxatga
 * qo'shish kifoya.
 */
const registry = new Map([
  ['click', new ClickProvider()],
  ['paynet', new PaynetProvider()],
  ['payme', new PaymeProvider()],   // eskirgan, eski tranzaksiyalar uchun
]);

export function getProvider(name) {
  return registry.get(String(name || '').toLowerCase()) || null;
}

/** Mijozga ko'rsatiladigan provayderlar (sozlangan va yangi to'lovga ochiq). */
export function availableProviders() {
  return [...registry.values()]
    .filter((p) => {
      if (!p.isConfigured()) return false;
      // Payme'da qo'shimcha shart bor
      if (typeof p.acceptsNewPayments === 'function') return p.acceptsNewPayments();
      return true;
    })
    .map((p) => ({ name: p.name, supportsSplit: p.supportsSplit() }));
}

/** Har bir provayderning holati — panel uchun. */
export function providerStatus() {
  const out = {};
  registry.forEach((p, name) => {
    out[name] = {
      configured: p.isConfigured(),
      acceptsNew: typeof p.acceptsNewPayments === 'function'
        ? p.acceptsNewPayments() : p.isConfigured(),
      supportsSplit: p.supportsSplit(),
    };
  });
  return out;
}
