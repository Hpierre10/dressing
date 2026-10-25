// Couleurs : extraction de la couleur dominante d'une photo (canvas, sans IA),
// palette nommée en français et règles d'harmonie utilisées par les suggestions.

// « neutral » = couleur qui se marie avec tout (base d'une tenue).
export const PALETTE = [
  { name: 'Noir', hex: '#1b1b1b', neutral: true },
  { name: 'Anthracite', hex: '#3d4045', neutral: true },
  { name: 'Gris', hex: '#808080', neutral: true },
  { name: 'Gris clair', hex: '#c4c4c4', neutral: true },
  { name: 'Blanc', hex: '#f7f7f4', neutral: true },
  { name: 'Écru', hex: '#ece3cf', neutral: true },
  { name: 'Beige', hex: '#d6c09c', neutral: true },
  { name: 'Camel', hex: '#b8874f', neutral: true },
  { name: 'Marron', hex: '#5f3d27', neutral: true },
  { name: 'Marine', hex: '#1f2b47', neutral: true },
  { name: 'Denim', hex: '#4b6688', neutral: true },
  { name: 'Kaki', hex: '#6b6a40', neutral: true },
  { name: 'Bleu roi', hex: '#2c48a6' },
  { name: 'Bleu', hex: '#2f6fd6' },
  { name: 'Bleu ciel', hex: '#a2c6e8' },
  { name: 'Turquoise', hex: '#2aa5a0' },
  { name: 'Vert', hex: '#3b8b4f' },
  { name: 'Vert sapin', hex: '#1f4a37' },
  { name: 'Jaune', hex: '#ebc53c' },
  { name: 'Moutarde', hex: '#c49a2a' },
  { name: 'Orange', hex: '#e5762d' },
  { name: 'Rouge', hex: '#c42a2a' },
  { name: 'Bordeaux', hex: '#6b1f2c' },
  { name: 'Rose', hex: '#eaa0b8' },
  { name: 'Violet', hex: '#6a4c93' },
];

export function hexToRgb(hex) {
  const n = parseInt(String(hex).replace('#', ''), 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex(rgb) {
  return '#' + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
}

function rgbToHsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h * 60, s, l];
}

function rgbToLab(rgb) {
  const [r, g, b] = rgb.map((v) => {
    v /= 255;
    return v > 0.04045 ? ((v + 0.055) / 1.055) ** 2.4 : v / 12.92;
  });
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const x = f((r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047);
  const y = f(r * 0.2126 + g * 0.7152 + b * 0.0722);
  const z = f((r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

const labDist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const hueDist = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

for (const p of PALETTE) p.lab = rgbToLab(hexToRgb(p.hex));

export function nearestColor(hex) {
  const lab = rgbToLab(hexToRgb(hex));
  let best = PALETTE[0];
  let bestD = Infinity;
  for (const p of PALETTE) {
    const d = labDist(lab, p.lab);
    if (d < bestD) { bestD = d; best = p; }
  }
  return best;
}

// Jusqu'à `max` couleurs dominantes d'une image (canvas ou <img>), la première étant la principale.
// Le fond est estimé à partir des bords de la photo puis ignoré, et le centre compte davantage.
export function dominantColors(source, max = 3) {
  const S = 64;
  const c = document.createElement('canvas');
  c.width = S; c.height = S;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, S, S);
  const d = ctx.getImageData(0, 0, S, S).data;
  const key = (i) => ((d[i] >> 5) << 6) | ((d[i + 1] >> 5) << 3) | (d[i + 2] >> 5);
  const add = (map, i, w) => {
    const k = key(i);
    const e = map.get(k) || { w: 0, r: 0, g: 0, b: 0 };
    e.w += w; e.r += d[i] * w; e.g += d[i + 1] * w; e.b += d[i + 2] * w;
    map.set(k, e);
  };

  const border = new Map();
  let borderN = 0;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      if (x > 2 && x < S - 3 && y > 2 && y < S - 3) continue;
      add(border, (y * S + x) * 4, 1);
      borderN++;
    }
  }
  const bg = [...border.values()].sort((a, b) => b.w - a.w)[0];
  const bgLab = rgbToLab([bg.r / bg.w, bg.g / bg.w, bg.b / bg.w]);
  const hasBg = bg.w / borderN > 0.3;

  const buckets = new Map();
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      if (d[i + 3] < 128) continue;
      const dx = ((x + 0.5) / S) * 2 - 1;
      const dy = ((y + 0.5) / S) * 2 - 1;
      let w = Math.max(0.15, 1 - (dx * dx + dy * dy) * 0.7);
      if (hasBg && labDist(rgbToLab([d[i], d[i + 1], d[i + 2]]), bgLab) < 14) w *= 0.03;
      add(buckets, i, w);
    }
  }

  const sorted = [...buckets.values()].sort((a, b) => b.w - a.w);
  const total = sorted.reduce((s, e) => s + e.w, 0) || 1;
  const out = [];
  for (const e of sorted) {
    const rgb = [e.r / e.w, e.g / e.w, e.b / e.w];
    const lab = rgbToLab(rgb);
    if (out.some((o) => labDist(o.lab, lab) < 15)) continue;
    out.push({ hex: rgbToHex(rgb), share: e.w / total, lab });
    if (out.length >= max) break;
  }
  return out.map(({ hex, share }) => ({ hex, share }));
}

// Infos utiles aux règles d'association. La neutralité suit le nom choisi (l'utilisateur a le dernier mot).
export function colorInfo(color) {
  const hex = color?.hex || '#808080';
  const entry = PALETTE.find((p) => p.name === color?.name) || nearestColor(hex);
  const [h, s] = rgbToHsl(hexToRgb(hex));
  return {
    name: entry.name,
    neutral: !!entry.neutral,
    h: s < 0.15 ? rgbToHsl(hexToRgb(entry.hex))[0] : h,
    L: rgbToLab(hexToRgb(hex))[0],
  };
}

// Note d'harmonie d'un ensemble de couleurs (sortie de colorInfo).
// kind : neutral | single | tonal | complementary | analogous | clash | many
export function harmony(infos) {
  const warnings = [];
  let score = 0;
  let kind;

  const accents = infos.filter((i) => !i.neutral);
  const clusters = [];
  for (const a of accents) {
    const c = clusters.find((cl) => hueDist(cl.h, a.h) <= 30);
    if (c) c.n++;
    else clusters.push({ h: a.h, n: 1 });
  }

  if (!clusters.length) {
    score += 14;
    kind = 'neutral';
  } else if (clusters.length === 1) {
    score += 20;
    kind = accents.length > 1 ? 'tonal' : 'single';
  } else if (clusters.length === 2) {
    const d = hueDist(clusters[0].h, clusters[1].h);
    if (d >= 150) { score += 8; kind = 'complementary'; }
    else if (d <= 60) { score += 10; kind = 'analogous'; }
    else { score -= 25; kind = 'clash'; warnings.push('deux couleurs qui se heurtent'); }
  } else {
    score -= 30 + 10 * (clusters.length - 3);
    kind = 'many';
    warnings.push('beaucoup de couleurs');
  }

  // Jamais plus de 3 pièces de couleur vive.
  if (accents.length > 3) { score -= 40; warnings.push('plus de 3 couleurs vives'); }

  const names = new Set(infos.map((i) => i.name));
  if (names.has('Noir') && names.has('Marron')) { score -= 6; warnings.push('noir et marron ensemble'); }
  if (names.has('Noir') && names.has('Marine')) score -= 3;

  return { score, kind, warnings };
}
