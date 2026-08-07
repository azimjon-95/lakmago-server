import QRCode from 'qrcode';
import { config } from '../config/index.js';

/**
 * QR kod kartasi — "Digital Menu" dizayni.
 *
 * Dizayn QAT'IY BIR XIL — restoran faqat quyidagilarni o'zgartira oladi:
 *   • fon rasmi (yuqoridagi foto)
 *   • logo
 *   • matnlar (eyebrow, menyu so'zi, sarlavha, izoh)
 *
 * Ranglar va joylashuv o'zgarmaydi — barcha restoranlarda
 * bir xil, tanish ko'rinish chiqadi.
 *
 * MUHIM: QR doim OQ kvadrat ichida turadi. Fon rasmi unga
 * hech qachon tushmaydi — skaner har doim o'qiy oladi.
 */

/* ═══════════ Qat'iy palitra ═══════════ */
const C = {
  band: '#17635E',        // pastki to'q yashil-ko'k maydon
  bandDeep: '#124F4B',    // pastki chekka
  accent: '#EE7A2B',      // to'q sariq — QR ramkasi
  accentDark: '#D96A20',
  hero: '#201915',        // fon rasmi bo'lmasa
  white: '#FFFFFF',
  ink: '#14100E',
};

/* ═══════════ Standart matnlar ═══════════ */
const T = {
  eyebrow: 'DIGITAL',
  menuWord: 'MENYU',
  headline: 'QR KODNI SKANERLANG',
  footnote: 'Telefon kamerangizni QR kodga tuting va buyurtma bering',
};

/** Stol uchun to'liq havola. */
export function buildTableUrl(qrToken) {
  const base = config.customerBaseUrl || 'https://lokma.uz';
  return `${base}/d/${qrToken}`;
}

/** QR ni PNG data URL sifatida qaytaradi. */
export async function generateQrPng(qrToken, size = 640) {
  return QRCode.toDataURL(buildTableUrl(qrToken), {
    width: size,
    margin: 0,
    errorCorrectionLevel: 'H',
    color: { dark: '#000000', light: '#FFFFFF' },
  });
}

/** QR ni SVG sifatida — cheksiz kattalashtirish uchun. */
export async function generateQrSvg(qrToken) {
  return QRCode.toString(buildTableUrl(qrToken), {
    type: 'svg',
    margin: 0,
    errorCorrectionLevel: 'H',
  });
}

/* ═══════════ Yordamchilar ═══════════ */

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/** Matnni bir necha qatorga bo'lish (SVG o'zi wrap qilmaydi). */
function wrap(text, maxChars, maxLines = 2) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const lines = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (next.length <= maxChars) { cur = next; continue; }
    if (cur) lines.push(cur);
    cur = w;
    if (lines.length >= maxLines) break;
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  return lines.slice(0, maxLines);
}

/**
 * PDFKit standart shriftlari (Helvetica) faqat WinAnsi ni biladi.
 * O'zbekcha `ʻ` (U+02BB) kabi belgilar xatolik beradi — almashtiramiz.
 */
function pdfSafe(s) {
  return String(s || '')
    .replace(/[\u02BB\u02BC\u0027\u2018]/g, '\u2018')
    .replace(/[\u02B9\u02BD\u2019]/g, '\u2019')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/[^\u0020-\u007E\u00A0-\u00FF\u2018\u2019\u201C\u201D\u2022]/g, '');
}

/** Cloudinary URL ni jpg ga majburlash — PDFKit webp ni bilmaydi. */
function toJpegUrl(url) {
  if (!url) return url;
  if (url.includes('res.cloudinary.com') && url.includes('/upload/')) {
    return url.replace('/upload/', '/upload/f_jpg,q_auto:good,w_1400/');
  }
  return url;
}

/** Rasmni yuklab olish. Xato bo'lsa — null (dizayn baribir chiqadi). */
async function fetchImage(url, { forJpeg = false } = {}) {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  try {
    const res = await fetch(forJpeg ? toJpegUrl(url) : url, {
      signal: AbortSignal.timeout(10000),
      redirect: 'follow',
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > 10 * 1024 * 1024) return null;

    // Magic bytes orqali formatni aniqlaymiz
    let mime = null;
    if (buf[0] === 0x89 && buf[1] === 0x50) mime = 'image/png';
    else if (buf[0] === 0xff && buf[1] === 0xd8) mime = 'image/jpeg';
    else if (buf.slice(8, 12).toString() === 'WEBP') mime = 'image/webp';
    else if (buf.slice(0, 4).toString() === '<svg' || buf.slice(0, 5).toString() === '<?xml') mime = 'image/svg+xml';
    if (!mime) return null;

    // PDF faqat png/jpeg ni qabul qiladi
    if (forJpeg && mime !== 'image/png' && mime !== 'image/jpeg') return null;

    return { buf, mime };
  } catch {
    return null;
  }
}

const dataUri = (img) => (img ? `data:${img.mime};base64,${img.buf.toString('base64')}` : '');

/** Stol yorlig'i — "Stol 1" yoki "VIP · 3". */
function tableLabel(table) {
  const num = table?.tableNumber ?? '';
  return table?.tableName ? `${table.tableName} \u00B7 ${num}` : `Stol ${num}`;
}

/** Uzun nom sig'ishi uchun shrift o'lchamini moslash. */
function fitSize(text, base, maxChars) {
  const len = String(text || '').length;
  if (len <= maxChars) return base;
  return Math.max(base * 0.55, base * (maxChars / len));
}

/** Mavzuni standart qiymatlar bilan to'ldirish. */
function normalizeTheme(theme = {}) {
  return {
    backgroundImage: theme.backgroundImage || '',
    logoUrl: theme.logoUrl || '',
    eyebrow: (theme.eyebrow || T.eyebrow).toUpperCase(),
    menuWord: (theme.menuWord || T.menuWord).toUpperCase(),
    headline: (theme.headline || T.headline).toUpperCase(),
    footnote: theme.footnote || T.footnote,
  };
}

/**
 * Butun dizayn geometriyasi — SVG va PDF bir xil formuladan foydalanadi,
 * shuning uchun ikkalasi ham piksel darajasida bir xil chiqadi.
 */
function computeLayout(W, H) {
  const heroH = H * 0.40;

  const badgeW = W * 0.60;
  const badgeX = (W - badgeW) / 2;
  const badgeY = H * 0.24;
  const pad = badgeW * 0.055;
  const qrBoxW = badgeW - pad * 2;
  const labelH = badgeW * 0.155;
  const badgeH = pad + qrBoxW + labelH;
  const badgeBottom = badgeY + badgeH;

  const quiet = qrBoxW * 0.08;
  const qrSize = qrBoxW - quiet * 2;

  const side = W * 0.09;
  const headSize = W * 0.062;
  const headY = badgeBottom + H * 0.075;
  const footSize = W * 0.029;

  return {
    heroH, badgeX, badgeY, badgeW, badgeH, badgeBottom,
    pad, qrBoxW, labelH, quiet, qrSize,
    side, headSize, headY, footSize,
    radius: W * 0.038,
    qrRadius: W * 0.028,
  };
}

/* ═══════════════════ SVG karta ═══════════════════ */

export async function renderQrCard(table, restaurant, theme = {}) {
  const th = normalizeTheme(theme);
  const W = 720;
  const H = 1080;
  const L = computeLayout(W, H);

  const [qrPng, bgImg, logoImg] = await Promise.all([
    generateQrPng(table.qrToken, 720),
    fetchImage(th.backgroundImage),
    fetchImage(th.logoUrl),
  ]);

  const label = tableLabel(table);
  const labelSize = fitSize(label, W * 0.082, 9);

  const headLines = wrap(th.headline, 22, 2);
  const footLines = wrap(th.footnote, 46, 3);

  const eyebrowX = W - L.side;
  const dividerX = eyebrowX - W * 0.27;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Helvetica, Arial, system-ui, sans-serif">
  <defs>
    <clipPath id="heroClip"><rect x="0" y="0" width="${W}" height="${L.heroH}"/></clipPath>
    <linearGradient id="heroShade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#000000" stop-opacity="0.62"/>
      <stop offset="45%" stop-color="#000000" stop-opacity="0.28"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0.55"/>
    </linearGradient>
    <linearGradient id="bandFill" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${C.band}"/>
      <stop offset="100%" stop-color="${C.bandDeep}"/>
    </linearGradient>
    <filter id="badgeShadow" x="-30%" y="-30%" width="160%" height="160%">
      <feDropShadow dx="0" dy="10" stdDeviation="18" flood-opacity="0.34"/>
    </filter>
    <clipPath id="logoClip">
      <circle cx="${W - L.side - W * 0.045}" cy="${H * 0.072}" r="${W * 0.045}"/>
    </clipPath>
  </defs>

  <!-- Pastki maydon -->
  <rect x="0" y="${L.heroH}" width="${W}" height="${H - L.heroH}" fill="url(#bandFill)"/>

  <!-- Hero: fon rasmi -->
  <rect x="0" y="0" width="${W}" height="${L.heroH}" fill="${C.hero}"/>
  ${bgImg ? `<g clip-path="url(#heroClip)">
    <image href="${dataUri(bgImg)}" x="0" y="0" width="${W}" height="${L.heroH}"
           preserveAspectRatio="xMidYMid slice"/>
  </g>` : ''}
  <rect x="0" y="0" width="${W}" height="${L.heroH}" fill="url(#heroShade)"/>

  <!-- Stol raqami -->
  <text x="${L.side}" y="${H * 0.115}" font-size="${labelSize}" font-weight="700"
        fill="${C.white}" letter-spacing="-0.5">${esc(label)}</text>

  <!-- Ajratuvchi chiziq -->
  <rect x="${dividerX}" y="${H * 0.062}" width="2" height="${H * 0.062}"
        fill="${C.white}" opacity="0.55"/>

  <!-- DIGITAL / MENYU -->
  <text x="${eyebrowX}" y="${H * 0.085}" text-anchor="end" font-size="${W * 0.028}"
        font-weight="600" fill="${C.accent}" letter-spacing="3.5">${esc(th.eyebrow)}</text>
  <text x="${eyebrowX}" y="${H * 0.118}" text-anchor="end" font-size="${W * 0.042}"
        font-weight="700" fill="${C.white}" letter-spacing="1">${esc(th.menuWord)}</text>

  ${logoImg ? `
  <circle cx="${W - L.side - W * 0.045}" cy="${H * 0.072}" r="${W * 0.048}"
          fill="${C.white}" opacity="0.001"/>` : ''}

  <!-- Sariq ramka -->
  <rect x="${L.badgeX}" y="${L.badgeY}" width="${L.badgeW}" height="${L.badgeH}"
        rx="${L.radius}" fill="${C.accent}" filter="url(#badgeShadow)"/>

  <!-- OQ maydon: QR shu yerda, kontrast kafolatlangan -->
  <rect x="${L.badgeX + L.pad}" y="${L.badgeY + L.pad}" width="${L.qrBoxW}" height="${L.qrBoxW}"
        rx="${L.qrRadius}" fill="${C.white}"/>

  <image href="${qrPng}"
         x="${L.badgeX + L.pad + L.quiet}" y="${L.badgeY + L.pad + L.quiet}"
         width="${L.qrSize}" height="${L.qrSize}"/>

  <!-- Sariq ramkadagi so'z -->
  <text x="${W / 2}" y="${L.badgeY + L.pad + L.qrBoxW + L.labelH * 0.68}"
        text-anchor="middle" font-size="${W * 0.042}" font-weight="700"
        fill="${C.white}" letter-spacing="2.5">${esc(th.menuWord)}</text>

  <!-- Sarlavha -->
  ${headLines.map((ln, i) => `<text x="${W / 2}" y="${L.headY + i * L.headSize * 1.18}"
        text-anchor="middle" font-size="${L.headSize}" font-weight="700"
        fill="${C.white}" letter-spacing="0.5">${esc(ln)}</text>`).join('\n  ')}

  <!-- Izoh -->
  ${footLines.map((ln, i) => `<text x="${W / 2}" y="${L.headY + headLines.length * L.headSize * 1.18 + H * 0.028 + i * L.footSize * 1.5}"
        text-anchor="middle" font-size="${L.footSize}" fill="${C.white}"
        opacity="0.82">${esc(ln)}</text>`).join('\n  ')}

  <!-- Footer -->
  <text x="${W / 2}" y="${H - H * 0.038}" text-anchor="middle" font-size="${W * 0.026}"
        fill="${C.white}" opacity="0.55" letter-spacing="2">lokma.uz</text>
</svg>`;
}

/* ═══════════════════ PDF (chop etish) ═══════════════════ */

export async function renderQrPdf(tables, restaurant, theme = {}) {
  const PDFDocument = (await import('pdfkit')).default;
  const th = normalizeTheme(theme);

  const doc = new PDFDocument({
    size: 'A4',
    margin: 0,
    info: { Title: `${restaurant?.name || 'Restoran'} \u2014 QR kodlar`, Author: 'LokmaGo' },
  });

  const chunks = [];
  doc.on('data', (c) => chunks.push(c));

  const W = doc.page.width;
  const H = doc.page.height;
  const L = computeLayout(W, H);

  // Rasmlarni bir marta yuklaymiz — har sahifada qayta ishlatiladi
  const bgImg = await fetchImage(th.backgroundImage, { forJpeg: true });

  const BOLD = 'Helvetica-Bold';
  const REG = 'Helvetica';

  for (let i = 0; i < tables.length; i++) {
    if (i > 0) doc.addPage();
    const t = tables[i];

    /* ── Pastki maydon ── */
    doc.save();
    const band = doc.linearGradient(0, L.heroH, 0, H);
    band.stop(0, C.band).stop(1, C.bandDeep);
    doc.rect(0, L.heroH, W, H - L.heroH).fill(band);
    doc.restore();

    /* ── Hero ── */
    doc.save();
    doc.rect(0, 0, W, L.heroH).fill(C.hero);
    if (bgImg) {
      doc.save();
      doc.rect(0, 0, W, L.heroH).clip();
      doc.image(bgImg.buf, 0, 0, {
        cover: [W, L.heroH], align: 'center', valign: 'center',
      });
      doc.restore();
    }
    const shade = doc.linearGradient(0, 0, 0, L.heroH);
    shade.stop(0, '#000000', 0.62).stop(0.45, '#000000', 0.28).stop(1, '#000000', 0.55);
    doc.rect(0, 0, W, L.heroH).fill(shade);
    doc.restore();

    /* ── Stol raqami ── */
    const label = pdfSafe(tableLabel(t));
    const labelSize = fitSize(label, W * 0.082, 9);
    doc.fillColor(C.white).font(BOLD).fontSize(labelSize)
      .text(label, L.side, H * 0.115 - labelSize * 0.82, {
        width: W * 0.5, align: 'left', lineBreak: false,
      });

    /* ── Ajratuvchi chiziq ── */
    const eyebrowRight = W - L.side;
    doc.save().opacity(0.55)
      .rect(eyebrowRight - W * 0.27, H * 0.062, 1.6, H * 0.062).fill(C.white)
      .restore();

    /* ── DIGITAL / MENYU ── */
    const ebW = W * 0.26;
    doc.fillColor(C.accent).font(BOLD).fontSize(W * 0.026)
      .text(pdfSafe(th.eyebrow), eyebrowRight - ebW, H * 0.085 - W * 0.024, {
        width: ebW, align: 'right', characterSpacing: 3, lineBreak: false,
      });
    doc.fillColor(C.white).font(BOLD).fontSize(W * 0.042)
      .text(pdfSafe(th.menuWord), eyebrowRight - ebW, H * 0.118 - W * 0.036, {
        width: ebW, align: 'right', characterSpacing: 1, lineBreak: false,
      });

    /* ── Sariq ramka + oq QR maydoni ── */
    doc.save().opacity(0.3)
      .roundedRect(L.badgeX, L.badgeY + 6, L.badgeW, L.badgeH, L.radius).fill('#000000')
      .restore();
    doc.roundedRect(L.badgeX, L.badgeY, L.badgeW, L.badgeH, L.radius).fill(C.accent);
    doc.roundedRect(L.badgeX + L.pad, L.badgeY + L.pad, L.qrBoxW, L.qrBoxW, L.qrRadius)
      .fill(C.white);

    const qrData = await generateQrPng(t.qrToken, 900);
    const qrBuf = Buffer.from(qrData.split(',')[1], 'base64');
    doc.image(qrBuf, L.badgeX + L.pad + L.quiet, L.badgeY + L.pad + L.quiet, {
      width: L.qrSize, height: L.qrSize,
    });

    doc.fillColor(C.white).font(BOLD).fontSize(W * 0.042)
      .text(pdfSafe(th.menuWord), L.badgeX,
        L.badgeY + L.pad + L.qrBoxW + L.labelH * 0.68 - W * 0.036, {
        width: L.badgeW, align: 'center', characterSpacing: 2.5, lineBreak: false,
      });

    /* ── Sarlavha ── */
    const headLines = wrap(pdfSafe(th.headline), 22, 2);
    doc.fillColor(C.white).font(BOLD).fontSize(L.headSize);
    headLines.forEach((ln, k) => {
      doc.text(ln, 0, L.headY + k * L.headSize * 1.18 - L.headSize * 0.82, {
        width: W, align: 'center', lineBreak: false,
      });
    });

    /* ── Izoh ── */
    const footTop = L.headY + headLines.length * L.headSize * 1.18 + H * 0.02;
    doc.save().opacity(0.82)
      .fillColor(C.white).font(REG).fontSize(L.footSize)
      .text(pdfSafe(th.footnote), W * 0.12, footTop, {
        width: W * 0.76, align: 'center', lineGap: L.footSize * 0.45,
      })
      .restore();

    /* ── Footer ── */
    doc.save().opacity(0.55)
      .fillColor(C.white).font(REG).fontSize(W * 0.024)
      .text('lokma.uz', 0, H - H * 0.05, {
        width: W, align: 'center', characterSpacing: 2, lineBreak: false,
      })
      .restore();

    doc.opacity(1);
  }

  doc.end();

  return new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}
