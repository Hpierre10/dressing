// Moteur de suggestions : à partir d'une pièce de départ et d'un contexte,
// compose des tenues complètes (haut + bas + chaussures, + veste / accessoire si pertinent)
// et les note selon les couleurs, le contexte, la saison et l'historique.
import { colorInfo, harmony } from './color.js?v=3';

const BASE = ['haut', 'bas', 'chaussures'];
const ORDER = ['veste', 'haut', 'bas', 'chaussures', 'accessoire'];
const MAX_COMBOS = 5000;
// Préférences de type de chaussures selon le contexte.
const SHOE_FIT = {
  Work: { 'Chaussures de ville': 6, 'Boots / bottines': 4 },
  Sport: { Sneakers: 8, 'Chaussures de ville': -15, 'Boots / bottines': -10 },
  Soirée: { 'Chaussures de ville': 5, 'Boots / bottines': 4 },
  Casual: { Sneakers: 3 },
};

export function currentSeason(date = new Date()) {
  const m = date.getMonth();
  if (m === 11 || m < 2) return 'hiver';
  if (m < 5) return 'printemps';
  if (m < 8) return 'été';
  return 'automne';
}

const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

export function suggest({ items, outfits, lastWorn, daysSince, idleDays, forgottenDays = 30, anchorId, context, season, count = 3, rand = Math.random }) {
  const anchor = items.find((i) => i.id === anchorId) || null;
  const fits = (it) => it === anchor || !it.contexts?.length || it.contexts.includes(context);

  const usedInContext = new Set(outfits.filter((o) => o.context === context).flatMap((o) => o.itemIds));
  const likedPairs = new Map();
  for (const o of outfits) {
    if (!o.liked) continue;
    for (let i = 0; i < o.itemIds.length; i++) {
      for (let j = i + 1; j < o.itemIds.length; j++) {
        const k = pairKey(o.itemIds[i], o.itemIds[j]);
        likedPairs.set(k, (likedPairs.get(k) || 0) + 1);
      }
    }
  }

  // Note propre à chaque pièce, indépendante des autres.
  const meta = new Map();
  for (const it of items) {
    let s = 0;
    if (it.contexts?.includes(context)) s += 6;
    if (usedInContext.has(it.id)) s += 4;
    if (it.seasons?.length) s += it.seasons.includes(season) ? 4 : -20;
    if (it.category === 'chaussures' && it.subtype) s += SHOE_FIT[context]?.[it.subtype] || 0;
    const last = lastWorn(it.id);
    const age = last ? daysSince(last) : Infinity;
    const forgotten = idleDays(it) > forgottenDays;
    if (forgotten) s += 5;
    else if (age <= 1) s -= 12;
    else if (age <= 3) s -= 5;
    meta.set(it.id, { s, forgotten, info: colorInfo(it.color) });
  }

  // En Sport : sneakers (ou chaussures sans sous-type) uniquement.
  const sporty = (i) => i.category !== 'chaussures' || !i.subtype || i.subtype === 'Sneakers';
  const pool = (cat) => (anchor?.category === cat ? [anchor]
    : items.filter((i) => i.category === cat && fits(i) && (context !== 'Sport' || sporty(i))));
  const [tops, bottoms, shoes] = BASE.map(pool);
  const missing = BASE.filter((_, i) => ![tops, bottoms, shoes][i].length);
  if (missing.length) return { results: [], missing };

  function evaluate(pieces) {
    const h = harmony(pieces.map((p) => meta.get(p.id).info));
    let score = h.score;
    let contrast = false;
    for (const p of pieces) score += meta.get(p.id).s;

    const top = pieces.find((p) => p.category === 'haut');
    const bottom = pieces.find((p) => p.category === 'bas');
    if (top && bottom) {
      const a = meta.get(top.id).info;
      const b = meta.get(bottom.id).info;
      const dL = Math.abs(a.L - b.L);
      if (dL >= 25) { score += 6; contrast = true; }
      else if (dL < 8 && a.name !== b.name && a.neutral && b.neutral) score -= 4;
    }

    let liked = 0;
    for (let i = 0; i < pieces.length; i++) {
      for (let j = i + 1; j < pieces.length; j++) liked += likedPairs.get(pairKey(pieces[i].id, pieces[j].id)) || 0;
    }
    if (liked) score += Math.min(18, liked * 6);

    return { score, kind: h.kind, contrast, liked: liked > 0, warnings: h.warnings };
  }

  const combos = [];
  const push = (t, b, s) => {
    const pieces = [t, b, s];
    const jitter = rand() * 8; // varie les propositions d'un clic à l'autre
    const e = evaluate(pieces);
    combos.push({ pieces, ...e, jitter, score: e.score + jitter });
  };
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  if (tops.length * bottoms.length * shoes.length <= MAX_COMBOS) {
    for (const t of tops) for (const b of bottoms) for (const s of shoes) push(t, b, s);
  } else {
    for (let k = 0; k < MAX_COMBOS; k++) push(pick(tops), pick(bottoms), pick(shoes));
  }
  combos.sort((a, b) => b.score - a.score);

  // Couches optionnelles : veste (hors été, sauf Work/Soirée) et un accessoire.
  const jackets = anchor?.category === 'veste' ? [anchor] : items.filter((i) => i.category === 'veste' && fits(i));
  const accessories = anchor?.category === 'accessoire' ? [anchor] : items.filter((i) => i.category === 'accessoire' && fits(i));
  const wantJacket = anchor?.category === 'veste'
    || (context !== 'Sport' && (season !== 'été' || context === 'Work' || context === 'Soirée'));

  // Variantes de la tenue avec chaque pièce candidate, meilleures d'abord.
  function withEach(c, candidates) {
    return candidates.map((x) => {
      const pieces = [...c.pieces, x];
      const e = evaluate(pieces);
      return { pieces, ...e, jitter: c.jitter, score: e.score + c.jitter + rand() * 4 };
    }).sort((a, b) => b.score - a.score);
  }

  // Jusqu'à 2 variantes par tenue (2 vestes différentes) pour que la sélection reste variée.
  function addLayers(c) {
    let outs = [c];
    if (wantJacket && jackets.length) {
      const js = withEach(c, jackets).filter((j) => anchor?.category === 'veste' || j.score > c.score - 12).slice(0, 2);
      if (js.length) outs = js;
    }
    if (!accessories.length) return outs;
    return outs.map((o) => {
      const a = withEach(o, accessories)[0];
      return anchor?.category === 'accessoire' || a.score >= o.score - 2 ? a : o;
    });
  }

  const candidates = combos.slice(0, 40).flatMap(addLayers);

  // Sélection variée : on pénalise les pièces déjà proposées (hors pièce de départ).
  const chosen = [];
  while (chosen.length < count && candidates.length) {
    let bi = 0;
    let bs = -Infinity;
    candidates.forEach((c, i) => {
      const shared = chosen.reduce((n, o) => n + c.pieces.filter((p) => p !== anchor && o.pieces.includes(p)).length, 0);
      const s = c.score - 14 * shared;
      if (s > bs) { bs = s; bi = i; }
    });
    chosen.push(candidates.splice(bi, 1)[0]);
  }

  for (const c of chosen) {
    c.pieces.sort((a, b) => ORDER.indexOf(a.category) - ORDER.indexOf(b.category));
    c.explanation = explain(c);
  }

  // Une phrase qui cite les vraies couleurs et pièces de la tenue.
  function explain(c) {
    const info = (p) => meta.get(p.id).info;
    const color = (p) => info(p).name.toLowerCase();
    const shoes = (p) => SHOE_WORD[p.subtype] || 'chaussures';
    const ofPiece = (p) => (p.category === 'chaussures' ? `des ${shoes(p)}` : OF[p.category]);
    const colorOf = (p) => `${/^[aeiouyéè]/i.test(color(p)) ? "l'" : 'le '}${color(p)} ${ofPiece(p)}`;
    const yourPiece = (p) => (p.name ? `« ${p.name} »` : `${p.category === 'chaussures' ? `tes ${shoes(p)}` : YOUR[p.category]} ${color(p)}`);

    const neutrals = [...new Set(c.pieces.filter((p) => info(p).neutral).map(color))].slice(0, 3).join(', ');
    const accents = c.pieces.filter((p) => !info(p).neutral);
    const base = {
      neutral: `Base 100 % neutre (${neutrals}) : sobre et facile à porter`,
      single: `Neutres (${neutrals}) relevés par une seule couleur : ${accents[0] && colorOf(accents[0])}`,
      tonal: `Ton sur ton : ${list(accents.map(colorOf))}${neutrals ? `, sur une base ${neutrals}` : ''}`,
      complementary: `Contraste de couleurs maîtrisé entre ${list(accents.map(colorOf))}`,
      analogous: `Couleurs voisines qui s'accordent : ${list(accents.map(colorOf))}`,
    }[c.kind] || `Association audacieuse : ${list(accents.map(colorOf))}`;

    const extras = [];
    if (c.contrast) extras.push('un bon contraste clair / foncé entre le haut et le bas');
    if (c.liked) extras.push('une association que tu as déjà aimée');
    let s = base + (extras.length ? `, avec ${list(extras)}` : '');
    const forgotten = c.pieces.filter((p) => p !== anchor && meta.get(p.id).forgotten);
    if (forgotten.length) {
      const days = [...new Set(forgotten.map(idleDays))];
      s += days.length === 1
        ? `, et remet en jeu ${list(forgotten.map(yourPiece))} (au placard depuis ${days[0]} jours)`
        : `, et remet en jeu ${list(forgotten.map((p) => `${yourPiece(p)} (au placard depuis ${idleDays(p)} jours)`))}`;
    }
    if (c.warnings.length) s += ` (attention : ${list(c.warnings)})`;
    return `${s}.`;
  }

  return { results: chosen, missing: [] };
}

const SHOE_WORD = { Sneakers: 'sneakers', 'Boots / bottines': 'boots', 'Chaussures de ville': 'chaussures de ville' };
const OF = { haut: 'du haut', bas: 'du bas', veste: 'de la veste', accessoire: "de l'accessoire" };
const YOUR = { haut: 'ton haut', bas: 'ton bas', veste: 'ta veste', accessoire: 'ton accessoire' };
const list = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} et ${xs[xs.length - 1]}` : xs[0] || '');
