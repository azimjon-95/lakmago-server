import { ManualBankProvider } from './manualBank.js';

/**
 * Bank provayderlari registri.
 *
 * Haqiqiy bank API kelganda shu yerga qo'shiladi va
 * BANK_PROVIDER muhit o'zgaruvchisi bilan tanlanadi.
 */
const registry = new Map([
  ['manual', new ManualBankProvider()],
]);

export function getBankProvider(name = process.env.BANK_PROVIDER || 'manual') {
  return registry.get(name) || registry.get('manual');
}
