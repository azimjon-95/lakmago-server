/*
 * O'zbek lotin → kirill (push matnlari uchun). Emoji, raqam, tinish belgilari o'zgarmaydi.
 * Qoidalar: o‘→ў, g‘→ғ, sh→ш, ch→ч, yo→ё, yu→ю, ya→я, ye→е, so‘z boshidagi e→э, tutuq belgisi→ъ.
 * «{dish}» kabi o'rinbosarlar tegilmaydi (taom/restoran nomi o'z holicha qoladi).
 */
const APOS = "'‘’ʻʼ`";
const isApos = (c) => APOS.includes(c);
const isLetter = (c) => !!c && /\p{L}/u.test(c);

const SINGLE = {
  a: 'а', b: 'б', d: 'д', e: 'е', f: 'ф', g: 'г', h: 'ҳ', i: 'и', j: 'ж', k: 'к', l: 'л', m: 'м',
  n: 'н', o: 'о', p: 'п', q: 'қ', r: 'р', s: 'с', t: 'т', u: 'у', v: 'в', x: 'х', y: 'й', z: 'з',
  c: 'ц', w: 'в',
};

const up = (cyr, src) => (src === src.toUpperCase() && src !== src.toLowerCase() ? cyr.toUpperCase() : cyr);

/** Brend nomlari o'girilmaydi */
const KEEP = /(LokmaGo|Lokma Go|Lokma)/g;

export function latinToCyrillic(text) {
  return String(text || '').split(KEEP).map((part, i) => (i % 2 ? part : convert(part))).join('');
}

function convert(s) {
  let out = '';
  let i = 0;
  while (i < s.length) {
    // o'rinbosar {..} — o'zgarmaydi
    if (s[i] === '{') {
      const j = s.indexOf('}', i);
      if (j > i) { out += s.slice(i, j + 1); i = j + 1; continue; }
    }
    const c = s[i];
    const lc = c.toLowerCase();
    const n = s[i + 1] || '';
    const ln = n.toLowerCase();
    const prev = i > 0 ? s[i - 1] : '';
    const wordStart = !isLetter(prev) && !isApos(prev);

    if ((lc === 'o' || lc === 'g') && isApos(n)) { out += up(lc === 'o' ? 'ў' : 'ғ', c); i += 2; continue; }
    if (lc === 's' && ln === 'h') { out += up('ш', c); i += 2; continue; }
    if (lc === 'c' && ln === 'h') { out += up('ч', c); i += 2; continue; }
    if (lc === 'y' && ['o', 'u', 'a', 'e'].includes(ln)) {
      // yo‘ → йў (yo + tutuq = y + o‘)
      if (ln === 'o' && isApos(s[i + 2] || '')) { out += up('й', c); i += 1; continue; }
      const map = { o: 'ё', u: 'ю', a: 'я', e: 'е' };
      out += up(map[ln], c); i += 2; continue;
    }
    if (lc === 'e' && wordStart) { out += up('э', c); i += 1; continue; }
    if (isApos(c) && isLetter(prev) && isLetter(n)) { out += 'ъ'; i += 1; continue; }
    if (SINGLE[lc]) { out += up(SINGLE[lc], c); i += 1; continue; }
    out += c; i += 1;
  }
  return out;
}
