/*
 * ═══════════════════════════════════════════════════════════
 * REAL-TIME: MENYU O'ZGARGANDA (STOP, QO'SHISH, O'CHIRISH) HODISA KETADI
 * ═══════════════════════════════════════════════════════════
 * Oldin faqat `updateDish` hodisa yuborardi. `announceDish` bilan STOP almashtirgich, taom qo'shish va o'chirish ham
 * `dish:stop` (restoran xonasi, stoppedCount bilan) va `dish:update` (hammaga) yuboradi. Ma'lumotlar bazasi KERAK EMAS:
 * Dish va io almashtiriladi. npm run test:dish-realtime
 */
import { readFileSync } from 'node:fs';
const { announceDish } = await import('../src/services/dishEvents.js');

let fails = 0;
const ok = (c, m) => { console.log(c ? '  ✓' : '  ✗ ' + m, c ? m : ''); if (!c) fails++; };

function fakeIo() {
  const log = [];
  const io = {
    log,
    to(room) { return { emit: (ev, payload) => log.push({ room, ev, payload }) }; },
    emit(ev, payload) { log.push({ room: '*', ev, payload }); },
  };
  return io;
}
const fakeDish = (count, fail = false) => ({ countDocuments: async (q) => { if (fail) throw new Error('db down'); fakeDish.last = q; return count; } });
const dish = { _id: 'd1', isAvailable: false };

console.log('\n1) Hodisalar updateDish bilan AYNAN bir xil shaklda');
{
  const io = fakeIo();
  const n = await announceDish('r1', dish, { Dish: fakeDish(3), io });
  ok(n === 3, 'to\'xtatilgan taomlar soni qaytadi (3)');
  ok(fakeDish.last.restaurantId === 'r1' && fakeDish.last.isAvailable === false, 'faqat SHU restoranning to\'xtatilganlari sanaladi');
  const stop = io.log.find((e) => e.ev === 'dish:stop');
  ok(stop && stop.room === 'restaurant:r1', 'dish:stop faqat shu restoran xonasiga ketadi');
  ok(stop.payload.dishId === 'd1' && stop.payload.isAvailable === false && stop.payload.stoppedCount === 3, 'payload: { dishId, isAvailable, stoppedCount }');
  const upd = io.log.find((e) => e.ev === 'dish:update');
  ok(upd && upd.room === '*' && upd.payload.restaurantId === 'r1', 'dish:update hammaga: { restaurantId }');
  ok(io.log.length === 2, 'ortiqcha hodisa yo\'q');
}

console.log('\n2) Ob\'ekt id string bo\'lib ketadi (ObjectId ham ishlaydi)');
{
  const io = fakeIo();
  await announceDish({ toString: () => 'r2' }, { _id: { toString: () => 'd9' }, isAvailable: true }, { Dish: fakeDish(0), io });
  ok(io.log[0].room === 'restaurant:r2' && io.log[0].payload.dishId === 'd9' && io.log[0].payload.stoppedCount === 0, 'ObjectId → string, son 0');
}

console.log('\n3) Soket yo\'q yoki baza xato: API javobi BUZILMAYDI');
{
  ok(await announceDish('r1', dish, { Dish: fakeDish(1), io: null }) === 1, 'io yo\'q (test/CLI) — xatosiz, son qaytadi');
  const io = fakeIo();
  const warn = console.warn; let warned = false; console.warn = () => { warned = true; };
  const n = await announceDish('r1', dish, { Dish: fakeDish(0, true), io });
  console.warn = warn;
  ok(n === null && io.log.length === 0 && warned, 'baza xatosi: istisno otilmaydi, hodisa yuborilmaydi, log yoziladi');
}

console.log('\n4) Controller\'lar haqiqatan ulangan');
{
  const src = readFileSync(new URL('../src/controllers/restaurantPanel.js', import.meta.url), 'utf8');
  const body = (name) => src.slice(src.indexOf(`${name}: asyncHandler`), src.indexOf('}),', src.indexOf(`${name}: asyncHandler`)));
  for (const fn of ['createDish', 'toggleStop', 'deleteDish']) ok(/await announceDish\(rid\(req\), dish\)/.test(body(fn)), `${fn} → announceDish`);
  ok(/announceDish/.test(src.slice(0, src.indexOf('export'))) || /import \{ announceDish \}/.test(src), 'announceDish import qilingan');
}

console.log(fails ? `\n✗ ${fails} xato` : '\n✓ hammasi o\'tdi');
process.exit(fails ? 1 : 0);
