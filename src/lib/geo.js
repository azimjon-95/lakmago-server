/*
 * ═══ GEO: nuqta-poligon va chegaragacha masofa (tashqi kutubxonasiz) ═══
 *
 * Nega Turf.js emas: bizga faqat 2 ta amal kerak (nuqta poligon ichidami + chegaragacha masofa), hudud — 12 ta poligon,
 * ~9 000 nuqta. Turf to'liq paketi ~600 KB va o'nlab bog'liqlik qo'shadi; bu 120 qatorlik kod bilan bir xil natija.
 * Koordinatalar GeoJSON tartibida: [lng, lat] (WGS84 / EPSG:4326).
 *
 * Masofa: nuqta atrofida mahalliy tekis proyeksiya (equirectangular). Namangan o'lchamida (≤ 150 km) xato < 0,5% —
 * 50 m chegara bufer uchun yetarli.
 */
const M_PER_DEG_LAT = 110_574;
const M_PER_DEG_LNG_EQ = 111_320;

/** Ray-casting: nuqta halqa (ring) ichidami. Chegaradagi nuqta natijasi ixtiyoriy — shuning uchun alohida masofa tekshiruvi bor. */
export function pointInRing(lng, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const xi = ring[i][0]; const yi = ring[i][1];
    const xj = ring[j][0]; const yj = ring[j][1];
    if (((yi > lat) !== (yj > lat)) && (lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

/** Polygon: [tashqi halqa, ...teshiklar]. Teshik ichidagi nuqta — tashqarida. */
export function pointInPolygon(lng, lat, polygon) {
  if (!polygon?.length || !pointInRing(lng, lat, polygon[0])) return false;
  for (let h = 1; h < polygon.length; h += 1) if (pointInRing(lng, lat, polygon[h])) return false;
  return true;
}

/** Geometry: Polygon yoki MultiPolygon. */
export function pointInGeometry(lng, lat, geometry) {
  if (!geometry) return false;
  if (geometry.type === 'Polygon') return pointInPolygon(lng, lat, geometry.coordinates);
  if (geometry.type === 'MultiPolygon') return geometry.coordinates.some((p) => pointInPolygon(lng, lat, p));
  return false;
}

const ringsOf = (geometry) => {
  if (!geometry) return [];
  if (geometry.type === 'Polygon') return geometry.coordinates;
  if (geometry.type === 'MultiPolygon') return geometry.coordinates.flat();
  return [];
};

/** Nuqtadan geometriyaning eng yaqin chegarasigacha masofa (metr). Ichkarida ham, tashqarida ham musbat. */
export function distanceToBoundaryMeters(lng, lat, geometry) {
  const kx = M_PER_DEG_LNG_EQ * Math.cos((lat * Math.PI) / 180);
  const ky = M_PER_DEG_LAT;
  let best = Infinity;
  for (const ring of ringsOf(geometry)) {
    for (let i = 1; i < ring.length; i += 1) {
      const ax = (ring[i - 1][0] - lng) * kx; const ay = (ring[i - 1][1] - lat) * ky;
      const bx = (ring[i][0] - lng) * kx; const by = (ring[i][1] - lat) * ky;
      const dx = bx - ax; const dy = by - ay;
      const len2 = dx * dx + dy * dy;
      const t = len2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
      const px = ax + t * dx; const py = ay + t * dy;
      const d = Math.hypot(px, py);
      if (d < best) best = d;
    }
  }
  return best;
}

/** [minLng, minLat, maxLng, maxLat] */
export function bboxOf(geometry) {
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (const ring of ringsOf(geometry)) {
    for (const [x, y] of ring) {
      if (x < minX) minX = x; if (y < minY) minY = y;
      if (x > maxX) maxX = x; if (y > maxY) maxY = y;
    }
  }
  return [minX, minY, maxX, maxY];
}

/** bbox'ni metr bo'yicha kengaytirish (bufer zonasini tez oldindan saralash uchun). */
export function expandBbox([minX, minY, maxX, maxY], meters) {
  const midLat = (minY + maxY) / 2;
  const dLat = meters / M_PER_DEG_LAT;
  const dLng = meters / (M_PER_DEG_LNG_EQ * Math.cos((midLat * Math.PI) / 180));
  return [minX - dLng, minY - dLat, maxX + dLng, maxY + dLat];
}

export const inBbox = (lng, lat, b) => lng >= b[0] && lng <= b[2] && lat >= b[1] && lat <= b[3];

/**
 * Geometriya tuzilishini tekshiradi. Xatolar ro'yxatini qaytaradi (bo'sh — yaroqli).
 * Tekshiriladi: tur, halqa yopiqligi, kamida 4 nuqta, koordinata diapazoni, son (NaN emas).
 */
export function validateGeometry(geometry) {
  const errors = [];
  if (!geometry || (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon')) {
    errors.push(`geometriya turi Polygon/MultiPolygon emas: ${geometry?.type}`);
    return errors;
  }
  const polys = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  if (!Array.isArray(polys) || !polys.length) errors.push("poligon yo'q");
  polys.forEach((poly, pi) => {
    if (!Array.isArray(poly) || !poly.length) { errors.push(`poligon ${pi}: halqa yo'q`); return; }
    poly.forEach((ring, ri) => {
      if (!Array.isArray(ring) || ring.length < 4) { errors.push(`poligon ${pi} halqa ${ri}: < 4 nuqta`); return; }
      const [f, l] = [ring[0], ring[ring.length - 1]];
      if (f[0] !== l[0] || f[1] !== l[1]) errors.push(`poligon ${pi} halqa ${ri}: yopilmagan`);
      for (const c of ring) {
        if (!Array.isArray(c) || !Number.isFinite(c[0]) || !Number.isFinite(c[1])) { errors.push(`poligon ${pi} halqa ${ri}: noto'g'ri koordinata`); break; }
        if (c[0] < -180 || c[0] > 180 || c[1] < -90 || c[1] > 90) { errors.push(`poligon ${pi} halqa ${ri}: diapazondan tashqari (lng,lat tartibi?)`); break; }
      }
    });
  });
  return errors;
}
