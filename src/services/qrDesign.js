import QRCode from 'qrcode';
import { config } from '../config/index.js';

/**
 * QR kod generatsiyasi.
 *
 * MUHIM: QR o'qilishi uchun uning atrofida oq kontrast zonasi
 * bo'lishi SHART. Fon rasmi QR ustiga tushsa skaner o'qiy
 * olmaydi — shuning uchun QR doim oq maydonda joylashadi.
 */

const QR_SIZE = 420;
const QUIET_ZONE = 28;   // QR atrofidagi oq bo'shliq

/** Stol uchun to'liq havola. */
export function buildTableUrl(qrToken) {
  const base = config.customerBaseUrl || 'https://lokma.uz';
  return `${base}/d/${qrToken}`;
}

/** QR ni PNG data URL sifatida qaytaradi. */
export async function generateQrPng(qrToken, size = QR_SIZE) {
  return QRCode.toDataURL(buildTableUrl(qrToken), {
    width: size,
    margin: 1,
    errorCorrectionLevel: 'H',   // 30% xato tuzatish — logo qo'yish mumkin
    color: { dark: '#000000', light: '#FFFFFF' },
  });
}

/** QR ni SVG sifatida — cheksiz kattalashtirish uchun. */
export async function generateQrSvg(qrToken) {
  return QRCode.toString(buildTableUrl(qrToken), {
    type: 'svg',
    margin: 1,
    errorCorrectionLevel: 'H',
  });
}

/**
 * Chiroyli QR karta — SVG.
 *
 * Tuzilma:
 *   Fon (rang yoki rasm)
 *     └ Oq karta (QR shu yerda — kontrast kafolatlangan)
 *         ├ Restoran nomi
 *         ├ QR kod
 *         └ Stol raqami
 */
export async function renderQrCard(table, restaurant, theme = {}) {
  const {
    backgroundColor = '#1C1815',
    backgroundImage = '',
    textColor = '#F7F2EA',
    accentColor = '#F5A524',
    logoUrl = '',
    headline = 'Menyuni oching',
    footnote = 'Kamerani QR ga to\u2018g\u2018rilang',
  } = theme;

  const W = 600;
  const H = 840;

  // QR ni SVG ichiga joylash uchun PNG data URL
  const qrPng = await generateQrPng(table.qrToken, QR_SIZE);

  // Oq karta o'lchamlari
  const cardW = QR_SIZE + QUIET_ZONE * 2;
  const cardX = (W - cardW) / 2;
  const cardY = 210;
  const cardH = cardW + 96;   // QR + stol raqami uchun joy

  const esc = (s) => String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const tableLabel = table.tableName
    ? `${table.tableName} · ${table.tableNumber}`
    : `Stol ${table.tableNumber}`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <clipPath id="cardClip">
      <rect x="${cardX}" y="${cardY}" width="${cardW}" height="${cardH}" rx="28"/>
    </clipPath>
    <filter id="cardShadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="8" stdDeviation="14" flood-opacity="0.28"/>
    </filter>
  </defs>

  <!-- Fon -->
  <rect width="${W}" height="${H}" fill="${esc(backgroundColor)}"/>
  ${backgroundImage ? `
  <image href="${esc(backgroundImage)}" width="${W}" height="${H}"
         preserveAspectRatio="xMidYMid slice" opacity="0.45"/>
  <rect width="${W}" height="${H}" fill="${esc(backgroundColor)}" opacity="0.5"/>` : ''}

  <!-- Logo -->
  ${logoUrl ? `
  <image href="${esc(logoUrl)}" x="${(W - 76) / 2}" y="52" width="76" height="76"
         preserveAspectRatio="xMidYMid meet"/>` : ''}

  <!-- Restoran nomi -->
  <text x="${W / 2}" y="${logoUrl ? 168 : 118}" text-anchor="middle"
        font-family="system-ui, -apple-system, sans-serif"
        font-size="34" font-weight="700" fill="${esc(textColor)}">
    ${esc(restaurant.name)}
  </text>

  <text x="${W / 2}" y="${logoUrl ? 196 : 152}" text-anchor="middle"
        font-family="system-ui, -apple-system, sans-serif"
        font-size="16" fill="${esc(accentColor)}">
    ${esc(headline)}
  </text>

  <!-- OQ KARTA: QR shu yerda, kontrast kafolatlangan -->
  <rect x="${cardX}" y="${cardY}" width="${cardW}" height="${cardH}"
        rx="28" fill="#FFFFFF" filter="url(#cardShadow)"/>

  <!-- QR kod -->
  <image href="${qrPng}"
         x="${cardX + QUIET_ZONE}" y="${cardY + QUIET_ZONE}"
         width="${QR_SIZE}" height="${QR_SIZE}"/>

  <!-- Stol raqami — oq karta ichida -->
  <text x="${W / 2}" y="${cardY + QUIET_ZONE + QR_SIZE + 52}"
        text-anchor="middle"
        font-family="system-ui, -apple-system, sans-serif"
        font-size="26" font-weight="700" fill="#1C1815">
    ${esc(tableLabel)}
  </text>

  <!-- Pastki matn -->
  <text x="${W / 2}" y="${cardY + cardH + 52}" text-anchor="middle"
        font-family="system-ui, -apple-system, sans-serif"
        font-size="15" fill="${esc(textColor)}" opacity="0.8">
    ${esc(footnote)}
  </text>

  <text x="${W / 2}" y="${H - 34}" text-anchor="middle"
        font-family="system-ui, -apple-system, sans-serif"
        font-size="13" fill="${esc(textColor)}" opacity="0.5">
    lokma.uz
  </text>
</svg>`;
}

/**
 * Barcha stollar uchun PDF — chop etish uchun.
 * Har sahifada bitta stol.
 */
export async function renderQrPdf(tables, restaurant, theme = {}) {
  const PDFDocument = (await import('pdfkit')).default;

  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: 40, bottom: 40, left: 40, right: 40 },
    info: {
      Title: `${restaurant.name} — QR kodlar`,
      Author: 'LokmaGo',
    },
  });

  const chunks = [];
  doc.on('data', (c) => chunks.push(c));

  const {
    backgroundColor = '#1C1815',
    textColor = '#F7F2EA',
    accentColor = '#F5A524',
    headline = 'Menyuni oching',
    footnote = 'Kamerani QR ga to\u2018g\u2018rilang',
  } = theme;

  const PW = doc.page.width;
  const PH = doc.page.height;
  const qrSize = 300;
  const cardPad = 24;
  const cardW = qrSize + cardPad * 2;
  const cardX = (PW - cardW) / 2;
  const cardY = 200;
  const cardH = cardW + 60;

  for (let i = 0; i < tables.length; i++) {
    if (i > 0) doc.addPage();
    const t = tables[i];

    // Fon
    doc.rect(0, 0, PW, PH).fill(backgroundColor);

    // Restoran nomi
    doc.fillColor(textColor)
      .fontSize(26).font('Helvetica-Bold')
      .text(restaurant.name, 0, 100, { width: PW, align: 'center' });

    doc.fillColor(accentColor)
      .fontSize(13).font('Helvetica')
      .text(headline, 0, 136, { width: PW, align: 'center' });

    // Oq karta — QR kontrasti uchun
    doc.roundedRect(cardX, cardY, cardW, cardH, 20).fill('#FFFFFF');

    // QR
    const qrData = await generateQrPng(t.qrToken, 600);
    const buf = Buffer.from(qrData.split(',')[1], 'base64');
    doc.image(buf, cardX + cardPad, cardY + cardPad, {
      width: qrSize, height: qrSize,
    });

    // Stol raqami
    const label = t.tableName
      ? `${t.tableName} · ${t.tableNumber}`
      : `Stol ${t.tableNumber}`;

    doc.fillColor('#1C1815')
      .fontSize(20).font('Helvetica-Bold')
      .text(label, cardX, cardY + cardPad + qrSize + 16, {
        width: cardW, align: 'center',
      });

    // Pastki matn
    doc.fillColor(textColor).opacity(0.8)
      .fontSize(12).font('Helvetica')
      .text(footnote, 0, cardY + cardH + 30, { width: PW, align: 'center' });

    doc.opacity(0.5)
      .fontSize(11)
      .text('lokma.uz', 0, PH - 60, { width: PW, align: 'center' });

    doc.opacity(1);
  }

  doc.end();

  return new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}
