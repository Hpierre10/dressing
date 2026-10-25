// Moteur de suggestions : à partir d'une pièce de départ et d'un contexte,
// compose des tenues complètes (haut + bas + chaussures, + veste / accessoire si pertinent)
// et les note selon les couleurs, le contexte, la saison et l'historique.
import { colorInfo, harmony } from './color.js';

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

export function suggest({ items, outfits, lastWorn, daysSince, isForgotten, anchorId, context, season, count = 3, rand = Math.random }) {
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
    const forgotten = isForgotten(it);
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
    const reasons = [...h.reasons];
    for (const p of pieces) score += meta.get(p.id).s;

    const top = pieces.find((p) => p.category === 'haut');
    const bottom = pieces.find((p) => p.category === 'bas');
    if (top && bottom) {
      const a = meta.get(top.id).info;
      const b = meta.get(bottom.id).info;
      const dL = Math.abs(a.L - b.L);
      if (dL >= 25) { score += 6; reasons.push('un bon contraste entre le haut et le bas'); }
      else if (dL < 8 && a.name !== b.name && a.neutral && b.neutral) score -= 4;
    }

    let liked = 0;
    for (let i = 0; i < pieces.length; i++) {
      for (let j = i + 1; j < pieces.length; j++) liked += likedPairs.get(pairKey(pieces[i].id, pieces[j].id)) || 0;
    }
    if (liked) { score += Math.min(18, liked * 6); reasons.push('une association que tu as déjà aimée'); }

    return { score, reasons, warnings: h.warnings };
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

  function bestWith(c, candidates) {
    let best = null;
    for (const x of candidates) {
      const pieces = [...c.pieces, x];
      const e = evaluate(pieces);
      const score = e.score + c.jitter + rand() * 4;
      if (!best || score > best.score) best = { pieces, ...e, jitter: c.jitter, score };
    }
    return best;
  }

  function addLayers(c) {
    let out = c;
    if (wantJacket && jackets.length) {
      const j = bestWith(out, jackets);
      if (anchor?.category === 'veste' || j.score > out.score - 12) out = j;
    }
    if (accessories.length) {
      const a = bestWith(out, accessories);
      if (anchor?.category === 'accessoire' || a.score >= out.score - 2) out = a;
    }
    return out;
  }

  const candidates = combos.slice(0, 40).map(addLayers);

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
    const forgotten = c.pieces.filter((p) => p !== anchor && meta.get(p.id).forgotten);
    c.bonus = forgotten.length ? [forgotten.length > 1 ? 'remet en jeu des pièces oubliées' : 'remet en jeu une pièce oubliée'] : [];
    c.pieces.sort((a, b) => ORDER.indexOf(a.category) - ORDER.indexOf(b.category));
  }

  return { results: chosen, missing: [] };
}
