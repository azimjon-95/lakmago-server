/*
 * ISHGA TUSHISH TEKSHIRUVI (muhim: fake-baza testlari ESM import xatolarini ko'rmaydi).
 *   1. src/ ichidagi HAR BIR modul import qilinadi (mavjud bo'lmagan export / sikl / sintaksis xatosi shu yerda ushlanadi);
 *   2. HAQIQIY server (src/index.js) ishga tushiriladi va /api/health (yoki ochiq yo'l) javob berishini kutadi — yiqilsa test yiqiladi.
 * MongoDB (yoki FerretDB) kerak. npm run test:boot
 */
process.env.JWT_SECRET = 'x'.repeat(40);
process.env.TELEGRAM_BOT_TOKEN = ''; process.env.RESTAURANT_BOT_TOKEN = '';
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const root = new URL('../', import.meta.url).pathname;
const walk = (d) => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : p.endsWith('.js') ? [p] : []; });
let fails = 0;
const ok = (c, m) => { console.log(c ? `  ✓ ${m}` : `  ✗ FAIL: ${m}`); if (!c) fails += 1; };

console.log('\n[1] Har bir modul import qilinadi');
const bad = [];
for (const f of walk(join(root, 'src')).filter((p) => !p.endsWith('/src/index.js'))) {
  try { await import(pathToFileURL(f).href); } catch (e) { bad.push(`${relative(root, f)}: ${String(e.message).split('\n')[0]}`); }
}
ok(bad.length === 0, `barcha modullar yuklandi${bad.length ? ` — XATO: ${bad.join(' | ')}` : ''}`);

console.log('\n[2] Haqiqiy server ishga tushadi va javob beradi');
const PORT = 4391;
const MONGO_URI = process.env.BOOT_MONGO_URI || 'mongodb://127.0.0.1:27017/lokma_boot_check';
const child = spawn('node', ['src/index.js'], { cwd: root, env: { ...process.env, PORT: String(PORT), NODE_ENV: 'development', MONGO_URI } });
let out = ''; let exited = null;
child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
child.on('exit', (c) => { exited = c; });
let up = false;
for (let i = 0; i < 60 && exited === null; i++) {
  await new Promise((r) => setTimeout(r, 500));
  try { const r = await fetch(`http://127.0.0.1:${PORT}/api/districts`); if (r.ok) { up = true; break; } } catch { /* hali ko'tarilmadi */ }
}
ok(up, `server ${PORT}-portda javob berdi${up ? '' : ` — chiqish kodi ${exited}; ${out.split('\n').filter((l) => /Error|SyntaxError|Cannot/.test(l)).slice(0, 2).join(' | ')}`}`);
if (up) {
  const d = await (await fetch(`http://127.0.0.1:${PORT}/api/districts`)).json();
  ok(d.districts?.length === 14 && d.defaultDistrict === 'pop', '/api/districts: 14 ta tuman, standart Pop');
  await new Promise((r) => setTimeout(r, 1500));
  ok(exited === null, 'server ishga tushgach (migratsiya, taymerlar) yiqilmadi');
}
child.kill('SIGKILL');
console.log(fails ? `\n✗ ${fails} ta xato` : '\n✓ hammasi o‘tdi');
process.exit(fails ? 1 : 0);
