import * as db from './db.js?v=6';
import { PALETTE, nearestColor, dominantColors } from './color.js?v=6';
import { suggest, currentSeason } from './suggest.js?v=6';

// ---------- Référentiels

const CATS = [
  { id: 'haut', label: 'Haut', plural: 'Hauts' },
  { id: 'bas', label: 'Bas', plural: 'Bas' },
  { id: 'chaussures', label: 'Chaussures', plural: 'Chaussures' },
  { id: 'veste', label: 'Veste', plural: 'Vestes' },
  { id: 'accessoire', label: 'Accessoire', plural: 'Accessoires' },
];
const CAT = Object.fromEntries(CATS.map((c) => [c.id, c]));
const CAT_ORDER = ['veste', 'haut', 'bas', 'chaussures', 'accessoire'];
const SHOE_TYPES = ['Sneakers', 'Boots / bottines', 'Chaussures de ville'];
// Marques proposées d'emblée dans l'autocomplétion (le champ reste libre).
const KNOWN_BRANDS = ['Arket', 'COS', 'Ami', 'About Blank', 'AllSaints', 'Aimé Leon Dore', 'Les Deux', 'Jacquemus', 'Lacoste', 'Asphalte', 'Uniqlo',
  'Kleman', 'Timberland', 'Clarks', 'Pompeii', 'Nike', 'Asics', 'Salomon'];
const SEASONS = ['printemps', 'été', 'automne', 'hiver'];
const CONTEXTS = ['Work', 'Casual', 'Sport', 'Soirée'];
const MATERIALS = ['Coton', 'Lin', 'Laine', 'Cachemire', 'Denim', 'Cuir', 'Daim', 'Soie', 'Velours', 'Maille', 'Polyester', 'Technique'];
const FORGOTTEN_DAYS = 30;

const state = {
  items: [],
  outfits: [],
  wears: new Map(), // id pièce -> dates (YYYY-MM-DD) triées, sans doublon
  filters: { cat: '', sub: '', brand: '', color: '' },
  queue: [], // photos en attente de saisie
  queueDone: 0,
  carry: null, // valeurs reprises d'une photo à l'autre dans un lot
  added: 0,
  draft: null, // pièce en cours de saisie / modification
  outfitDraft: null,
  outfitFilter: '',
  sugg: { anchor: '', context: 'Casual', picking: true, cat: '', results: null, missing: [] },
  exportFile: null,
  claudeText: '',
};

let lastHash = null;
let navDepth = 0;

// ---------- Utilitaires

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => (Date.now().toString(36) + Math.random().toString(36).slice(2, 6)).slice(-8);
const pad = (n) => String(n).padStart(2, '0');
const toISO = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = () => toISO(new Date());
const parseISO = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const daysSince = (iso) => { const t = new Date(); t.setHours(0, 0, 0, 0); return Math.round((t - parseISO(iso)) / 86400000); };
const fmtDate = (iso) => {
  const d = parseISO(iso);
  return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: d.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined });
};
const ago = (iso) => { const n = daysSince(iso); return n <= 0 ? "aujourd'hui" : n === 1 ? 'hier' : `il y a ${n} jours`; };
const plural = (n, word) => `${n} ${word}${n > 1 ? 's' : ''}`;
const isStandalone = () => navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent);

const byId = (id) => state.items.find((i) => i.id === id);
const titleOf = (it) => it.name?.trim() || `${(it.category === 'chaussures' && it.subtype) || CAT[it.category]?.label || 'Pièce'} ${(it.color?.name || '').toLowerCase()}`.trim();

function computeWears() {
  const m = new Map();
  const add = (id, d) => { if (!m.has(id)) m.set(id, new Set()); m.get(id).add(d); };
  state.items.forEach((it) => (it.wears || []).forEach((d) => add(it.id, d)));
  state.outfits.forEach((o) => o.date && o.itemIds.forEach((id) => add(id, o.date)));
  state.wears = new Map([...m].map(([id, s]) => [id, [...s].sort()]));
}
const wearsOf = (id) => state.wears.get(id) || [];
const lastWorn = (id) => { const w = wearsOf(id); return w[w.length - 1] || null; };

// Jours depuis la dernière fois portée, ou depuis l'ajout si jamais portée.
const idleDays = (it) => daysSince(lastWorn(it.id) || toISO(new Date(it.createdAt)));

function forgottenLists() {
  const old = [];
  const fresh = [];
  for (const it of state.items) {
    const last = lastWorn(it.id);
    const n = idleDays(it);
    if (n > FORGOTTEN_DAYS) old.push({ it, n, last });
    else if (!last) fresh.push({ it, n, last });
  }
  old.sort((a, b) => b.n - a.n);
  return { old, fresh };
}

// Marques réellement présentes dans le dressing, les plus fréquentes d'abord.
function brandList() {
  const count = new Map();
  for (const it of state.items) if (it.brand) count.set(it.brand, (count.get(it.brand) || 0) + 1);
  return [...count.keys()].sort((a, b) => count.get(b) - count.get(a) || a.localeCompare(b, 'fr'));
}
// Pour l'autocomplétion : marques saisies + marques connues.
function brandSuggestions() {
  const used = brandList();
  const lower = new Set(used.map((b) => b.toLowerCase()));
  return [...used, ...KNOWN_BRANDS.filter((b) => !lower.has(b.toLowerCase()))];
}
function materialList() {
  const set = new Set(MATERIALS);
  state.items.forEach((it) => it.material && set.add(it.material));
  return [...set];
}

// ---------- Images

const urls = new WeakMap();
function blobUrl(b) {
  if (!b) return '';
  if (!urls.has(b)) urls.set(b, URL.createObjectURL(b));
  return urls.get(b);
}

function pic(it, big = false) {
  const blob = big ? it.photo || it.thumb : it.thumb || it.photo;
  if (blob) return `<img src="${blobUrl(blob)}" alt="${esc(titleOf(it))}" loading="lazy" decoding="async">`;
  return `<div class="nopic" style="--c:${esc(it.color?.hex || '#bbb')}">${esc(CAT[it.category]?.label || '')}</div>`;
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { resolve(img); setTimeout(() => URL.revokeObjectURL(url), 2000); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Image illisible')); };
    img.src = url;
  });
}
const toBlob = (canvas, q) => new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Encodage impossible'))), 'image/jpeg', q));
function scaled(src, w, h, max) {
  const k = Math.min(1, max / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.round(w * k);
  c.height = Math.round(h * k);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(src, 0, 0, c.width, c.height);
  return c;
}
// Photo réduite (1280 px) + vignette (400 px) + couleurs dominantes.
async function processImage(file) {
  const img = await loadImage(file);
  const big = scaled(img, img.naturalWidth, img.naturalHeight, 1280);
  const small = scaled(big, big.width, big.height, 400);
  const [photo, thumb] = await Promise.all([toBlob(big, 0.82), toBlob(small, 0.8)]);
  return { photo, thumb, colors: dominantColors(small) };
}

const blobToDataURL = (b) => new Promise((resolve, reject) => {
  if (!b) return resolve(null);
  const r = new FileReader();
  r.onload = () => resolve(r.result);
  r.onerror = () => reject(r.error);
  r.readAsDataURL(b);
});
const dataURLToBlob = async (u) => (u ? (await fetch(u)).blob() : null);

// ---------- Composants

const ICONS = {
  back: '<path d="M15 5l-7 7 7 7"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  heart: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21l7.8-7.5 1-1.1a5.5 5.5 0 0 0 0-7.8z"/>',
  camera: '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/>',
  check: '<path d="M20 6L9 17l-5-5"/>',
  x: '<path d="M18 6L6 18M6 6l12 12"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
};
const icon = (name, cls = '') => `<svg class="ic ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;

const dataAttrs = (data) => Object.entries(data).map(([k, v]) => ` data-${k}="${esc(v)}"`).join('');
const chip = (label, on, action, data = {}) => `<button type="button" class="chip${on ? ' on' : ''}" data-action="${action}"${dataAttrs(data)}>${label}</button>`;

function header(title, { back = '', right = '', sub = '' } = {}) {
  return `<header class="top">
    ${back ? `<a class="icon-btn" href="${back}" data-action="back" aria-label="Retour">${icon('back')}</a>` : ''}
    <div class="top-title"><h1>${esc(title)}</h1>${sub ? `<span class="sub">${sub}</span>` : ''}</div>
    ${right}
  </header>`;
}

function collage(pieces, photo) {
  const its = pieces.slice().sort((a, b) => CAT_ORDER.indexOf(a.category) - CAT_ORDER.indexOf(b.category));
  const n = its.length + (photo ? 1 : 0);
  const cols = photo ? 1 + Math.ceil(its.length / 2) : n <= 3 ? Math.max(n, 1) : n === 4 ? 2 : 3;
  return `<div class="collage${photo ? ' with-me' : ''}" style="--cols:${cols}">
    ${photo ? `<img class="me" src="${blobUrl(photo)}" alt="Photo de la tenue">` : ''}
    ${its.map((it) => pic(it)).join('')}
  </div>`;
}

const tile = (it, { href = `#/item/${it.id}`, action = '', sel = false } = {}) => (action
  ? `<button type="button" class="tile${sel ? ' sel' : ''}" data-action="${action}" data-id="${it.id}" aria-pressed="${sel}">${pic(it)}</button>`
  : `<a class="tile" href="${href}">${pic(it)}<span class="swatch mini" style="--c:${esc(it.color?.hex)}"></span></a>`);

function catFilterChips(current, action) {
  return `<div class="chips scroll">${chip('Tout', !current, action, { value: '' })}${CATS
    .map((c) => chip(esc(c.plural), current === c.id, action, { value: c.id })).join('')}</div>`;
}

// ---------- Écran : Dressing

function installHint() {
  if (!isIOS() || isStandalone()) return '';
  return `<div class="banner">${icon('info')}<div><strong>Installe l'app avant de remplir ton dressing</strong>
    Dans Safari : bouton Partager → « Sur l'écran d'accueil ». Les données enregistrées dans l'onglet Safari ne sont pas reprises par l'app installée.</div></div>`;
}

function backupHint() {
  if (state.items.length < 5) return '';
  let last = null;
  try { last = localStorage.getItem('lastExport'); } catch { /* stockage indisponible */ }
  if (last && daysSince(last) <= 30) return '';
  return `<a class="banner" href="#/settings" style="text-decoration:none;color:inherit">${icon('info')}<div><strong>Pense à sauvegarder</strong>
    ${last ? `Dernière sauvegarde ${ago(last)}.` : 'Aucune sauvegarde pour l’instant.'} Réglages → Exporter.</div></a>`;
}

function viewDressing() {
  const { cat, brand, color, sub } = state.filters;
  const right = `<a class="icon-btn" href="#/settings" aria-label="Réglages">${icon('gear')}</a>`;
  if (!state.items.length) {
    return header('Dressing', { right }) + installHint() + `<div class="empty">
      <p><strong>Ton dressing est vide.</strong></p>
      <p class="muted">Ajoute tes pièces au fur et à mesure : une photo à la fois ou plusieurs d'un coup.</p>
      <a class="btn primary" href="#/add">Ajouter une pièce</a></div>`;
  }
  const brands = brandList();
  const colors = [...new Map(state.items.filter((i) => i.color).map((i) => [i.color.name, i.color])).values()];
  const list = state.items
    .filter((i) => (!cat || i.category === cat) && (cat !== 'chaussures' || !sub || i.subtype === sub) && (!brand || i.brand === brand) && (!color || i.color?.name === color))
    .sort((a, b) => b.createdAt - a.createdAt);
  const counts = Object.fromEntries(CATS.map((c) => [c.id, state.items.filter((i) => i.category === c.id).length]));

  return header('Dressing', { right, sub: plural(state.items.length, 'pièce') }) + installHint() + backupHint() + `
    <div class="chips scroll">${chip('Tout', !cat, 'filter-cat', { value: '' })}${CATS
      .map((c) => chip(`${esc(c.plural)} <small>${counts[c.id]}</small>`, cat === c.id, 'filter-cat', { value: c.id })).join('')}</div>
    ${cat === 'chaussures' ? `<div class="chips scroll">${chip('Toutes', !sub, 'filter-sub', { value: '' })}${SHOE_TYPES
      .map((t) => chip(esc(t), sub === t, 'filter-sub', { value: t })).join('')}</div>` : ''}
    <div class="filter-row">
      ${brands.length ? `<select data-change="filter-brand" aria-label="Filtrer par marque">
        <option value="">Toutes marques</option>
        ${brands.map((b) => `<option value="${esc(b)}"${b === brand ? ' selected' : ''}>${esc(b)}</option>`).join('')}
      </select>` : ''}
      <div class="dots scroll">${colors.map((c) => `<button type="button" class="dot-btn${color === c.name ? ' on' : ''}" data-action="filter-color" data-value="${esc(c.name)}" aria-label="${esc(c.name)}"><span class="swatch" style="--c:${esc(c.hex)}"></span></button>`).join('')}</div>
    </div>
    ${color ? `<p class="hint">Couleur : <strong>${esc(color)}</strong> · <button class="link" data-action="filter-color" data-value="${esc(color)}">retirer</button></p>` : ''}
    ${list.length ? `<div class="grid">${list.map((it) => tile(it)).join('')}</div>` : '<p class="muted">Aucune pièce ne correspond à ces filtres.</p>'}`;
}

// ---------- Écran : fiche pièce

function viewItem([, id]) {
  const it = byId(id);
  if (!it) return notFound();
  const w = wearsOf(id);
  const last = w[w.length - 1];
  const wornToday = (it.wears || []).includes(today());
  const outfits = state.outfits.filter((o) => o.itemIds.includes(id)).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const row = (label, value) => (value ? `<dt>${label}</dt><dd>${value}</dd>` : '');

  return header(titleOf(it), { back: '#/', right: `<a class="icon-btn" href="#/edit/${id}">Modifier</a>` }) + `
    <div class="hero">${pic(it, true)}</div>
    <div class="actions">
      <button class="btn ${wornToday ? 'done' : 'primary'}" data-action="wear-today" data-id="${id}">${wornToday ? `${icon('check')} Portée aujourd'hui` : "Porté aujourd'hui"}</button>
      <a class="btn" href="#/suggest?item=${id}">Idées de tenues</a>
    </div>
    <div class="stat">${w.length ? `Portée ${w.length} fois · dernière fois ${ago(last)}` : 'Jamais portée pour l’instant'}</div>
    <dl class="props">
      ${row('Catégorie', esc(CAT[it.category]?.label + (it.subtype ? ` · ${it.subtype}` : '')))}
      ${row('Couleur', `<span class="swatch" style="--c:${esc(it.color?.hex)}"></span>${esc(it.color?.name)}`)}
      ${row('Marque', esc(it.brand))}
      ${row('Matière', esc(it.material))}
      ${row('Saison', it.seasons?.length ? esc(it.seasons.join(', ')) : 'Toutes saisons')}
      ${row('Contextes', it.contexts?.length ? esc(it.contexts.join(', ')) : 'Tous')}
      ${row('Notes', esc(it.notes).replace(/\n/g, '<br>'))}
      ${row('Ajoutée le', fmtDate(toISO(new Date(it.createdAt))))}
    </dl>
    ${outfits.length ? `<h2>Dans ${plural(outfits.length, 'tenue')}</h2>
      <div class="strip">${outfits.map((o) => `<a class="tile" href="#/outfit/${o.id}">${o.photo ? `<img src="${blobUrl(o.thumb || o.photo)}" alt="">` : pic(byId(o.itemIds.find((x) => x !== id)) || it)}</a>`).join('')}</div>` : ''}
    <div class="actions" style="margin-top:28px"><button class="btn danger ghost" data-action="delete-item" data-id="${id}">Supprimer cette pièce</button></div>`;
}

// ---------- Écran : ajout / modification de pièce

function draftFromItem(it) {
  return {
    mode: 'edit', id: it.id, photo: it.photo, thumb: it.thumb, detected: it.detected || [],
    category: it.category, subtype: it.subtype || '', brand: it.brand || '', name: it.name || '', material: it.material || '',
    seasons: [...(it.seasons || [])], contexts: [...(it.contexts || [])], notes: it.notes || '',
    color: it.color || { hex: '#808080', name: 'Gris' },
  };
}

function draftFromPhoto(ready) {
  const main = ready.colors[0]?.hex || '#808080';
  const carry = state.carry || {};
  return {
    mode: 'add', photo: ready.photo, thumb: ready.thumb, detected: ready.colors,
    category: carry.category || '', subtype: carry.subtype || '', brand: carry.brand || '', name: '', material: '',
    seasons: [...(carry.seasons || [])], contexts: [...(carry.contexts || [])], notes: '',
    color: { hex: main, name: nearestColor(main).name },
  };
}

function suggChips(field, value) {
  const list = field === 'brand' ? brandSuggestions() : materialList();
  const v = value.trim().toLowerCase();
  const matches = list.filter((x) => x.toLowerCase() !== v && (!v || x.toLowerCase().includes(v))).slice(0, 8);
  return matches.map((x) => chip(esc(x), false, 'pick-sugg', { field, value: x })).join('');
}

function swatchBtn(hex, name, on, wide = false) {
  return `<button type="button" class="swatch-btn${wide ? ' wide' : ''}${on ? ' on' : ''}" data-action="draft-color" data-hex="${esc(hex)}" data-name="${esc(name)}" aria-label="${esc(name)}">
    <span class="swatch" style="--c:${esc(hex)}"></span><span>${esc(name)}</span></button>`;
}

function itemForm(d) {
  const toggles = (field, values, hint) => `<div class="chips wrap">${values.map((v) => chip(esc(v), d[field].includes(v), 'draft-toggle', { field, value: v })).join('')}</div><p class="hint">${hint}</p>`;
  return `
    <section class="field">
      <h3>Catégorie</h3>
      <div class="chips wrap">${CATS.map((c) => chip(esc(c.label), d.category === c.id, 'draft-set', { field: 'category', value: c.id })).join('')}</div>
      ${d.category === 'chaussures' ? `<div class="chips wrap" style="margin-top:8px">${SHOE_TYPES.map((t) => chip(esc(t), d.subtype === t, 'draft-set', { field: 'subtype', value: t })).join('')}</div>` : ''}
    </section>
    <section class="field">
      <h3>Couleur dominante</h3>
      <div class="color-current"><span class="swatch lg" style="--c:${esc(d.color.hex)}"></span><strong>${esc(d.color.name)}</strong></div>
      ${d.detected?.length ? `<p class="hint">Détectée sur la photo :</p>
        <div class="chips wrap">${d.detected.map((c) => swatchBtn(c.hex, nearestColor(c.hex).name, d.color.hex === c.hex, true)).join('')}</div>` : ''}
      <p class="hint">Ou choisis dans la palette :</p>
      <div class="swatches">
        ${PALETTE.map((p) => swatchBtn(p.hex, p.name, d.color.hex === p.hex)).join('')}
        <label class="swatch-btn"><span class="swatch custom">+</span><span>Autre</span>
          <input type="color" class="vh" value="${esc(d.color.hex)}" data-change="draft-custom-color"></label>
      </div>
    </section>
    <section class="field">
      <h3>Marque</h3>
      <input data-scope="item" data-field="brand" data-sugg="brand" value="${esc(d.brand)}" autocomplete="off" autocapitalize="words" placeholder="ex. Uniqlo">
      <div class="sugg" data-for="brand">${suggChips('brand', d.brand)}</div>
    </section>
    <section class="field">
      <h3>Nom <span style="text-transform:none;letter-spacing:0">(facultatif)</span></h3>
      <input data-scope="item" data-field="name" value="${esc(d.name)}" autocomplete="off" autocapitalize="sentences" placeholder="ex. Chemise oxford, jean brut…">
    </section>
    <section class="field">
      <h3>Matière</h3>
      <input data-scope="item" data-field="material" data-sugg="material" value="${esc(d.material)}" autocomplete="off" autocapitalize="sentences" placeholder="ex. Coton">
      <div class="sugg" data-for="material">${suggChips('material', d.material)}</div>
    </section>
    <section class="field"><h3>Saison</h3>${toggles('seasons', SEASONS, 'Aucune sélection = toutes saisons.')}</section>
    <section class="field"><h3>Contextes adaptés</h3>${toggles('contexts', CONTEXTS, 'Facultatif. Aucune sélection = convient partout. Aide les suggestions.')}</section>
    <section class="field">
      <h3>Notes</h3>
      <textarea data-scope="item" data-field="notes" placeholder="Coupe, taille, avec quoi la porter…">${esc(d.notes)}</textarea>
    </section>`;
}

function viewAdd(_, __, entering) {
  if (entering && !state.queue.length) state.added = 0;
  if (!state.queue.length) {
    return header('Ajouter') + `
      ${state.added ? `<div class="success">${icon('check')} ${state.added > 1 ? `${state.added} pièces ajoutées` : '1 pièce ajoutée'} · <a href="#/">Voir le dressing</a></div>` : ''}
      <div class="add-choices">
        <label class="big-choice">${icon('camera')}<span>Prendre une photo</span>
          <input type="file" accept="image/*" capture="environment" class="vh" data-change="add-files"></label>
        <label class="big-choice">${icon('image')}<span>Choisir des photos<small>Plusieurs d'un coup, saisie une par une ensuite</small></span>
          <input type="file" accept="image/*" multiple class="vh" data-change="add-files"></label>
      </div>
      <p class="hint" style="margin-top:16px">Astuce : photographie la pièce à plat ou sur cintre, sur un fond uni, pour que la couleur soit bien détectée.</p>`;
  }

  const entry = state.queue[0];
  const total = state.queueDone + state.queue.length;
  const position = `Photo ${state.queueDone + 1} / ${total}`;
  if (!entry.ready) {
    if (!entry.loading) {
      entry.loading = true;
      processImage(entry.file)
        .then((ready) => { entry.ready = ready; state.draft = draftFromPhoto(ready); })
        .catch(() => { toast('Photo illisible, ignorée'); state.queue.shift(); state.queueDone++; })
        .finally(render);
    }
    return header('Nouvelle pièce', { sub: position }) + '<p class="loading" style="padding:20vh 0">Préparation de la photo…</p>';
  }

  const d = state.draft;
  const remaining = state.queue.length - 1;
  return header('Nouvelle pièce', { sub: position }) + `
    <div class="form-photo"><img src="${blobUrl(d.thumb)}" alt="Photo de la pièce"></div>
    ${itemForm(d)}
    <div class="sticky-actions">
      <button class="btn ghost" data-action="skip-photo">${remaining ? 'Passer' : 'Annuler'}</button>
      <button class="btn primary" data-action="save-item">${remaining ? 'Enregistrer · suivante' : 'Enregistrer'}</button>
    </div>
    ${remaining ? `<p class="hint" style="text-align:center"><button class="link" data-action="cancel-queue">Abandonner les ${plural(remaining + 1, 'photo')} restantes</button></p>` : ''}`;
}

function viewEdit([, id], _, entering) {
  const it = byId(id);
  if (!it) return notFound();
  if (entering || state.draft?.id !== id) state.draft = draftFromItem(it);
  const d = state.draft;
  return header('Modifier', { back: `#/item/${id}` }) + `
    <div class="form-photo">
      ${d.thumb || d.photo ? `<img src="${blobUrl(d.thumb || d.photo)}" alt="">` : ''}
      <label class="btn small">${icon('image')} Changer la photo<input type="file" accept="image/*" class="vh" data-change="edit-photo"></label>
    </div>
    ${itemForm(d)}
    <div class="sticky-actions">
      <a class="btn ghost" href="#/item/${id}" data-action="back">Annuler</a>
      <button class="btn primary" data-action="save-item">Enregistrer</button>
    </div>`;
}

// ---------- Écran : tenues

function outfitCard(o) {
  const pieces = o.itemIds.map(byId).filter(Boolean);
  return `<a class="card" href="#/outfit/${o.id}">
    ${collage(pieces, o.photo)}
    <div class="card-body">
      <div class="card-meta"><span class="tag accent">${esc(o.context)}</span>${o.date ? `<span class="muted">${fmtDate(o.date)}</span>` : ''}${o.liked ? `<span class="heart">${icon('heart', 'fill')}</span>` : ''}</div>
      ${o.note ? `<p class="card-note">${esc(o.note)}</p>` : ''}
    </div></a>`;
}

function viewOutfits() {
  const f = state.outfitFilter;
  const list = state.outfits
    .filter((o) => !f || (f === 'liked' ? o.liked : o.context === f))
    .sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.createdAt - a.createdAt);
  const right = `<a class="btn small primary" href="#/outfit/new">+ Tenue</a>`;
  if (!state.outfits.length) {
    return header('Tenues', { right }) + `<div class="empty"><p><strong>Aucune tenue enregistrée.</strong></p>
      <p class="muted">Enregistre ce que tu portes (pièces et/ou photo de toi) : l'app saura ce qui a été porté et ce que tu aimes.</p>
      <a class="btn primary" href="#/outfit/new">Enregistrer une tenue</a></div>`;
  }
  return header('Tenues', { right, sub: plural(state.outfits.length, 'tenue') }) + `
    <div class="chips scroll">${chip('Toutes', !f, 'outfit-filter', { value: '' })}${chip(`${icon('heart', 'fill')} J'aime`, f === 'liked', 'outfit-filter', { value: 'liked' })}${CONTEXTS
      .map((c) => chip(c, f === c, 'outfit-filter', { value: c })).join('')}</div>
    ${list.map(outfitCard).join('') || '<p class="muted">Aucune tenue pour ce filtre.</p>'}`;
}

function newOutfitDraft() {
  return { id: null, itemIds: [], photo: null, thumb: null, context: 'Casual', note: '', liked: false, date: today(), pickCat: '' };
}

function viewOutfitEdit([, id], _, entering) {
  const existing = id !== 'new' ? state.outfits.find((o) => o.id === id) : null;
  if (id !== 'new' && !existing) return notFound();
  if (entering) {
    if (state.outfitDraft?.pending) delete state.outfitDraft.pending;
    else state.outfitDraft = existing ? { ...existing, itemIds: [...existing.itemIds], pickCat: '' } : newOutfitDraft();
  }
  const d = state.outfitDraft;
  const selected = d.itemIds.map(byId).filter(Boolean);
  const pickable = state.items.filter((i) => !d.pickCat || i.category === d.pickCat)
    .sort((a, b) => CAT_ORDER.indexOf(a.category) - CAT_ORDER.indexOf(b.category) || b.createdAt - a.createdAt);

  return header(existing ? 'Modifier la tenue' : 'Nouvelle tenue', { back: '#/outfits' }) + `
    <section class="field">
      <h3>Photo de moi <span style="text-transform:none;letter-spacing:0">(facultatif)</span></h3>
      ${d.photo ? `<div class="me-photo"><img src="${blobUrl(d.thumb || d.photo)}" alt="Photo de la tenue"><button class="remove" data-action="outfit-remove-photo" aria-label="Retirer la photo">${icon('x')}</button></div>`
        : `<div class="actions" style="margin:0">
            <label class="btn">${icon('camera')} Photo<input type="file" accept="image/*" capture="user" class="vh" data-change="outfit-photo"></label>
            <label class="btn">${icon('image')} Galerie<input type="file" accept="image/*" class="vh" data-change="outfit-photo"></label>
          </div>`}
    </section>
    <section class="field">
      <h3>Pièces (${selected.length})</h3>
      ${selected.length ? `<div class="strip">${selected.map((it) => tile(it, { action: 'outfit-toggle-item', sel: true })).join('')}</div>` : '<p class="hint">Touche les pièces ci-dessous pour les ajouter.</p>'}
      ${state.items.length ? catFilterChips(d.pickCat, 'outfit-pick-cat') + `<div class="grid dense">${pickable.map((it) => tile(it, { action: 'outfit-toggle-item', sel: d.itemIds.includes(it.id) })).join('')}</div>`
        : '<p class="hint">Ton dressing est vide : tu peux enregistrer une tenue avec juste une photo.</p>'}
    </section>
    <section class="field"><h3>Contexte</h3><div class="chips wrap">${CONTEXTS.map((c) => chip(c, d.context === c, 'outfit-set', { field: 'context', value: c })).join('')}</div></section>
    <section class="field"><h3>Portée le</h3><input type="date" data-scope="outfit" data-field="date" value="${esc(d.date || '')}" max="${today()}"></section>
    <section class="field">
      <button type="button" class="toggle${d.liked ? ' on' : ''}" data-action="outfit-like"><span>J'aime cette association</span>${icon('heart', d.liked ? 'fill' : '')}</button>
    </section>
    <section class="field"><h3>Note</h3><textarea data-scope="outfit" data-field="note" placeholder="ex. j'aime cette association, top pour les rendez-vous clients…">${esc(d.note)}</textarea></section>
    <div class="sticky-actions">
      ${existing ? `<button class="btn danger ghost" data-action="outfit-delete">Supprimer</button>` : `<a class="btn ghost" href="#/outfits" data-action="back">Annuler</a>`}
      <button class="btn primary" data-action="outfit-save">Enregistrer</button>
    </div>`;
}

// ---------- Écran : suggestions

function viewSuggest(_, query, entering) {
  const s = state.sugg;
  if (entering) {
    s.results = null;
    s.missing = [];
    if (query.get('item') && byId(query.get('item'))) { s.anchor = query.get('item'); s.picking = false; }
    else s.picking = !s.anchor;
  }
  if (s.anchor && !byId(s.anchor)) s.anchor = '';
  const anchor = byId(s.anchor);
  if (!state.items.length) {
    return header('Idées de tenues') + `<div class="empty"><p class="muted">Ajoute au moins un haut, un bas et une paire de chaussures pour recevoir des suggestions.</p><a class="btn primary" href="#/add">Ajouter une pièce</a></div>`;
  }

  const pickList = state.items.filter((i) => !s.cat || i.category === s.cat)
    .sort((a, b) => CAT_ORDER.indexOf(a.category) - CAT_ORDER.indexOf(b.category) || b.createdAt - a.createdAt);

  return header('Idées de tenues', { sub: `Saison : ${currentSeason()}` }) + `
    <section class="field">
      <h3>Pièce de départ</h3>
      <div class="anchor">
        ${anchor ? `<span class="tile">${pic(anchor)}</span>` : '<span class="anchor-any">✦</span>'}
        <div class="anchor-text"><strong>${anchor ? esc(titleOf(anchor)) : 'Peu importe'}</strong><span class="muted">${anchor ? esc(anchor.brand || CAT[anchor.category].label) : "L'app choisit pour toi"}</span></div>
        <button class="btn small" data-action="sugg-picking">${s.picking ? 'Fermer' : 'Changer'}</button>
      </div>
      ${s.picking ? `<div style="margin-top:10px">
        ${catFilterChips(s.cat, 'sugg-cat')}
        <div class="grid dense">
          <button type="button" class="tile${!s.anchor ? ' sel' : ''}" data-action="sugg-anchor" data-id=""><span class="anchor-any" style="width:100%;height:100%">✦</span></button>
          ${pickList.map((it) => tile(it, { action: 'sugg-anchor', sel: s.anchor === it.id })).join('')}
        </div></div>` : ''}
    </section>
    <section class="field">
      <h3>Contexte</h3>
      <div class="chips wrap">${CONTEXTS.map((c) => chip(c, s.context === c, 'sugg-context', { value: c })).join('')}</div>
    </section>
    <button class="btn primary block" data-action="sugg-run">${s.results ? 'Proposer 3 autres tenues' : 'Proposer 3 tenues'}</button>
    ${suggestResults()}`;
}

function suggestResults() {
  const s = state.sugg;
  if (s.missing.length) {
    return `<div class="missing" style="margin-top:16px"><strong>Il manque des pièces pour composer une tenue ${esc(s.context)}</strong>
      <p class="muted" style="margin:6px 0 0">Aucune pièce disponible dans : ${s.missing.map((c) => CAT[c].label.toLowerCase()).join(', ')}.
      Ajoute-en, ou vérifie les « contextes adaptés » de tes pièces.</p></div>`;
  }
  if (!s.results) return '';
  return s.results.map((r, i) => `<div class="card">
      ${collage(r.pieces)}
      <div class="card-body">
        <div class="card-meta"><strong>Tenue ${i + 1}</strong><span class="muted">${r.pieces.map((p) => esc(titleOf(p))).join(' · ')}</span></div>
        <p class="card-note">${esc(r.explanation)}</p>
        <div class="actions" style="margin:4px 0 0">
          <button class="btn small ${r.saved ? 'done' : 'primary'}" data-action="sugg-wear" data-index="${i}"${r.saved ? ' disabled' : ''}>${r.saved ? `${icon('check')} Enregistrée` : 'Je la porte aujourd’hui'}</button>
          <button class="btn small" data-action="sugg-adjust" data-index="${i}">Ajuster</button>
        </div>
      </div></div>`).join('');
}

// ---------- Écran : pièces oubliées

function forgottenRow({ it, n, last }) {
  return `<div class="row">
    ${tile(it)}
    <div class="row-body"><strong>${esc(titleOf(it))}</strong>
      <span>${esc(it.brand ? `${it.brand} · ` : '')}${last ? `Portée ${ago(last)}` : `Jamais portée · ajoutée ${ago(toISO(new Date(it.createdAt)))}`}</span></div>
    <div class="row-actions">
      <button class="btn small primary" data-action="wear-today" data-id="${it.id}">Portée</button>
      <a class="btn small" href="#/suggest?item=${it.id}">Idées</a>
    </div></div>`;
}

function viewForgotten() {
  const { old, fresh } = forgottenLists();
  return header('Pièces oubliées', { sub: `Pas portées depuis plus de ${FORGOTTEN_DAYS} jours` }) + `
    ${old.length ? old.map(forgottenRow).join('') : `<div class="empty"><p><strong>Aucune pièce oubliée pour l'instant</strong></p><p class="muted">Une pièce apparaît ici quand elle n'a pas été portée depuis plus de ${FORGOTTEN_DAYS} jours.</p></div>`}
    ${fresh.length ? `<details><summary>Ajoutées récemment, jamais portées (${fresh.length})</summary>${fresh.map(forgottenRow).join('')}</details>` : ''}
    <p class="hint" style="margin-top:16px">Une pièce compte comme portée quand elle figure dans une tenue enregistrée ou que tu touches « Porté aujourd'hui ».</p>`;
}

// ---------- Écran : réglages

function viewSettings() {
  let last = null;
  try { last = localStorage.getItem('lastExport'); } catch { /* stockage indisponible */ }
  return header('Réglages', { back: '#/' }) + `
    <div class="section">
      <h2>Copier mon dressing pour Claude</h2>
      <p>Génère un texte complet de ton dressing (pièces, couleurs, tenues, pièces oubliées) à coller dans une conversation avec Claude pour lui demander des conseils.</p>
      <button class="btn primary block" data-action="copy-claude">Copier mon dressing pour Claude</button>
      ${state.claudeText ? `<textarea readonly data-select-all>${esc(state.claudeText)}</textarea>` : ''}
    </div>
    <div class="section">
      <h2>Sauvegarde</h2>
      <p>Tes données restent uniquement sur ce téléphone. Exporte régulièrement un fichier JSON (photos comprises) dans Fichiers ou iCloud Drive.
      <br>${last ? `<strong>Dernière sauvegarde : ${fmtDate(last)}</strong>` : '<strong>Aucune sauvegarde pour l’instant.</strong>'}</p>
      <div class="stack">
        ${state.exportFile ? `<button class="btn primary" data-action="export-save">Enregistrer ${esc(state.exportFile.name)} (${(state.exportFile.size / 1048576).toFixed(1)} Mo)</button>`
          : `<button class="btn primary" data-action="export-prepare">Exporter la sauvegarde</button>`}
        <label class="btn">Importer une sauvegarde<input type="file" accept="application/json,.json" class="vh" data-change="import-file"></label>
      </div>
    </div>
    <div class="section">
      <h2>Stockage</h2>
      <p id="storage-info">${plural(state.items.length, 'pièce')}, ${plural(state.outfits.length, 'tenue')}.</p>
      <button class="btn block" data-action="persist">Protéger mes données contre l'effacement automatique</button>
    </div>
    <div class="section">
      <h2>Zone sensible</h2>
      <p>Efface toutes les pièces et tenues de ce téléphone. Exporte d'abord une sauvegarde.</p>
      <button class="btn danger block" data-action="wipe">Tout effacer</button>
    </div>
    <p class="hint" style="text-align:center">Dressing · données 100 % locales · aucune connexion requise</p>`;
}

async function showStorageInfo() {
  const el = $('#storage-info');
  if (!el || !navigator.storage?.estimate) return;
  try {
    const { usage } = await navigator.storage.estimate();
    const persisted = navigator.storage.persisted ? await navigator.storage.persisted() : false;
    el.textContent = `${plural(state.items.length, 'pièce')}, ${plural(state.outfits.length, 'tenue')} · ${(usage / 1048576).toFixed(1)} Mo utilisés${persisted ? ' · protégé ✓' : ''}.`;
  } catch { /* estimation indisponible */ }
}

function usualContext(it) {
  if (it.contexts?.length) return it.contexts.join(', ');
  const count = new Map();
  state.outfits.filter((o) => o.itemIds.includes(it.id)).forEach((o) => count.set(o.context, (count.get(o.context) || 0) + 1));
  const best = [...count].sort((a, b) => b[1] - a[1])[0];
  return best ? best[0] : 'non précisé';
}

function claudeText() {
  // Une ligne par pièce : catégorie, marque, couleur, matière, contexte habituel (+ infos utiles).
  const describe = (it) => {
    const w = wearsOf(it.id);
    const parts = [
      CAT[it.category]?.label + (it.subtype ? ` (${it.subtype})` : ''),
      it.brand || 'marque ?',
      it.color?.name || 'couleur ?',
      it.material || 'matière ?',
      `contexte : ${usualContext(it)}`,
      it.seasons?.length ? `saison : ${it.seasons.join(', ')}` : null,
      it.name ? `« ${it.name} »` : null,
      w.length ? `portée ${w.length} fois, dernière le ${fmtDate(w[w.length - 1])}` : 'jamais portée',
      it.notes ? `note : ${it.notes.replace(/\s+/g, ' ')}` : null,
    ].filter(Boolean);
    return `- [${it.id}] ${parts.join(' · ')}`;
  };
  const lines = [
    `# Mon dressing — export du ${fmtDate(today())}`,
    '',
    `Voici l'inventaire complet de ma garde-robe (${plural(state.items.length, 'pièce')}, ${plural(state.outfits.length, 'tenue')} enregistrée${state.outfits.length > 1 ? 's' : ''}). Saison actuelle : ${currentSeason()}.`,
    'Mon style : minimaliste, urbain, scandinave et parisien, avec des basiques de qualité et quelques pièces statement. Je porte beaucoup de sneakers.',
    "Aide-moi à composer des tenues en utilisant uniquement ces pièces et en citant leurs identifiants entre crochets. Veille à la cohérence des couleurs, du style et du contexte (Work, Casual, Sport, Soirée), appuie-toi sur les associations que j'aime et remets en jeu les pièces que je n'ai pas portées depuis longtemps.",
    '',
  ];
  for (const c of CATS) {
    const its = state.items.filter((i) => i.category === c.id);
    if (!its.length) continue;
    lines.push(`## ${c.plural} (${its.length})`, ...its.map(describe), '');
  }
  const outfits = state.outfits.slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  if (outfits.length) {
    lines.push('## Tenues enregistrées');
    for (const o of outfits) {
      const pieces = o.itemIds.map(byId).filter(Boolean).map((p) => `[${p.id}] ${titleOf(p)}`);
      lines.push(`- ${o.date ? fmtDate(o.date) : 'sans date'} · ${o.context}${o.liked ? ' · ♥ j’aime' : ''} · ${pieces.join(' + ') || 'photo seule'}${o.note ? ` · note : ${o.note.replace(/\s+/g, ' ')}` : ''}`);
    }
    lines.push('');
  }
  const { old } = forgottenLists();
  if (old.length) {
    lines.push(`## Pièces oubliées (non portées depuis plus de ${FORGOTTEN_DAYS} jours)`);
    old.forEach(({ it, last }) => lines.push(`- [${it.id}] ${titleOf(it)} — ${last ? `dernière fois le ${fmtDate(last)}` : 'jamais portée'}`));
  }
  return lines.join('\n').trim();
}

function notFound() {
  return header('Introuvable', { back: '#/' }) + '<p class="muted">Cet élément n’existe plus.</p>';
}

// ---------- Routeur

const ROUTES = [
  [/^\/?$/, viewDressing, 'dressing'],
  [/^\/item\/(\w+)$/, viewItem, 'dressing'],
  [/^\/edit\/(\w+)$/, viewEdit, 'dressing'],
  [/^\/add$/, viewAdd, 'add'],
  [/^\/outfits$/, viewOutfits, 'outfits'],
  [/^\/outfit\/(\w+)$/, viewOutfitEdit, 'outfits'],
  [/^\/suggest$/, viewSuggest, 'suggest'],
  [/^\/forgotten$/, viewForgotten, 'forgotten'],
  [/^\/settings$/, viewSettings, 'dressing'],
];

function render() {
  const hash = location.hash || '#/';
  const [path, qs = ''] = hash.slice(1).split('?');
  const entering = hash !== lastHash;
  lastHash = hash;
  let html = notFound();
  let tab = '';
  for (const [re, view, t] of ROUTES) {
    const m = path.match(re);
    if (m) { html = view(m, new URLSearchParams(qs), entering); tab = t; break; }
  }
  $('#view').innerHTML = html;
  if (entering) window.scrollTo(0, 0);
  document.querySelectorAll('.tabbar a').forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));
  const n = forgottenLists().old.length;
  const badge = $('.tabbar .badge');
  badge.hidden = !n;
  badge.textContent = n > 99 ? '99+' : n;
  if (path === '/settings') showStorageInfo();
}

function refresh() {
  computeWears();
  render();
}

let toastTimer;
function toast(msg, duration = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), duration);
}

// ---------- Actions

function normalizeBrand(brand) {
  const b = brand.trim().replace(/\s+/g, ' ');
  return brandSuggestions().find((x) => x.toLowerCase() === b.toLowerCase()) || b;
}

async function requestPersistence() {
  try { return navigator.storage?.persist ? await navigator.storage.persist() : false; } catch { return false; }
}

async function saveItem() {
  const d = state.draft;
  if (!d.category) { toast('Choisis une catégorie'); return; }
  const fields = {
    category: d.category,
    subtype: d.category === 'chaussures' ? d.subtype : '',
    brand: normalizeBrand(d.brand),
    name: d.name.trim(),
    material: d.material.trim(),
    seasons: SEASONS.filter((s) => d.seasons.includes(s)),
    contexts: CONTEXTS.filter((c) => d.contexts.includes(c)),
    notes: d.notes.trim(),
    color: d.color,
    detected: d.detected || [],
    photo: d.photo,
    thumb: d.thumb,
  };
  if (d.mode === 'edit') {
    const it = byId(d.id);
    Object.assign(it, fields);
    await db.put('items', it);
    state.draft = null;
    location.hash = `#/item/${it.id}`;
    toast('Pièce modifiée');
    return;
  }
  const it = { id: uid(), createdAt: Date.now(), wears: [], ...fields };
  await db.put('items', it);
  state.items.push(it);
  if (state.items.length === 1) requestPersistence();
  state.carry = { category: fields.category, subtype: fields.subtype, brand: fields.brand, seasons: fields.seasons, contexts: fields.contexts };
  state.added++;
  nextInQueue();
  toast('Pièce ajoutée');
}

function nextInQueue() {
  state.queue.shift();
  state.queueDone++;
  state.draft = null;
  if (!state.queue.length) { state.queueDone = 0; state.carry = null; }
  window.scrollTo(0, 0);
  refresh();
}

async function deleteItem(id) {
  const it = byId(id);
  if (!it || !confirm(`Supprimer « ${titleOf(it)} » ? Elle sera aussi retirée des tenues.`)) return;
  await db.remove('items', id);
  state.items = state.items.filter((i) => i.id !== id);
  for (const o of state.outfits.filter((x) => x.itemIds.includes(id))) {
    o.itemIds = o.itemIds.filter((x) => x !== id);
    if (!o.itemIds.length && !o.photo) {
      await db.remove('outfits', o.id);
      state.outfits = state.outfits.filter((x) => x !== o);
    } else await db.put('outfits', o);
  }
  location.hash = '#/';
  toast('Pièce supprimée');
  refresh();
}

async function toggleWearToday(id) {
  const it = byId(id);
  const t = today();
  it.wears = it.wears || [];
  const i = it.wears.indexOf(t);
  if (i >= 0) it.wears.splice(i, 1);
  else it.wears.push(t);
  await db.put('items', it);
  toast(i >= 0 ? 'Annulé' : `« ${titleOf(it)} » notée comme portée aujourd'hui`);
  refresh();
}

async function saveOutfit() {
  const d = state.outfitDraft;
  if (!d.itemIds.length && !d.photo) { toast('Ajoute au moins une pièce ou une photo'); return; }
  const o = {
    id: d.id || uid(), createdAt: d.createdAt || Date.now(), itemIds: d.itemIds, photo: d.photo, thumb: d.thumb,
    context: d.context, note: d.note.trim(), liked: d.liked, date: d.date || null,
  };
  await db.put('outfits', o);
  const i = state.outfits.findIndex((x) => x.id === o.id);
  if (i >= 0) state.outfits[i] = o;
  else state.outfits.push(o);
  state.outfitDraft = null;
  location.hash = '#/outfits';
  toast('Tenue enregistrée');
  refresh();
}

function runSuggest() {
  const s = state.sugg;
  const { results, missing } = suggest({
    items: state.items, outfits: state.outfits, lastWorn, daysSince, idleDays, forgottenDays: FORGOTTEN_DAYS,
    anchorId: s.anchor, context: s.context, season: currentSeason(),
  });
  s.results = results;
  s.missing = missing;
  s.picking = false;
  render();
  $('.card, .missing')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Presse-papiers : l'API moderne exige https ; sinon (test en http), ancienne méthode par sélection.
async function copyText(text) {
  if (window.isSecureContext && navigator.clipboard) {
    try { await navigator.clipboard.writeText(text); return true; } catch { /* méthode de secours */ }
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;font-size:16px';
  document.body.appendChild(ta);
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  return ok;
}

async function prepareExport() {
  toast('Préparation de la sauvegarde…');
  const conv = (list) => Promise.all(list.map(async (x) => ({ ...x, photo: await blobToDataURL(x.photo), thumb: await blobToDataURL(x.thumb) })));
  const data = { app: 'dressing', version: 1, exportedAt: new Date().toISOString(), items: await conv(state.items), outfits: await conv(state.outfits) };
  state.exportFile = new File([JSON.stringify(data)], `dressing-${today()}.json`, { type: 'application/json' });
  render();
}

async function saveExport() {
  const file = state.exportFile;
  try {
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: 'Sauvegarde Dressing' });
    } else {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(file);
      a.download = file.name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    }
  } catch (e) {
    if (e.name === 'AbortError') return;
    toast('Export impossible : ' + e.message);
    return;
  }
  try { localStorage.setItem('lastExport', today()); } catch { /* stockage indisponible */ }
  state.exportFile = null;
  toast('Sauvegarde exportée');
  render();
}

async function importFile(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { toast('Fichier illisible'); return; }
  if (data?.app !== 'dressing' || !Array.isArray(data.items) || !Array.isArray(data.outfits)) { toast("Ce fichier n'est pas une sauvegarde Dressing"); return; }
  const replace = state.items.length || state.outfits.length
    ? confirm(`Importer ${plural(data.items.length, 'pièce')} et ${plural(data.outfits.length, 'tenue')}.\n\nOK : remplacer tout le dressing actuel.\nAnnuler : fusionner avec l'existant.`)
    : true;
  toast('Import en cours…');
  const conv = (list) => Promise.all(list.map(async (x) => ({ ...x, photo: await dataURLToBlob(x.photo), thumb: await dataURLToBlob(x.thumb) })));
  const [items, outfits] = await Promise.all([conv(data.items), conv(data.outfits)]);
  if (replace) await db.clearAll();
  await db.putMany('items', items);
  await db.putMany('outfits', outfits);
  await loadAll();
  toast(`Import terminé : ${plural(items.length, 'pièce')}, ${plural(outfits.length, 'tenue')}`);
  refresh();
}

const actions = {
  back(el) {
    if (navDepth > 0) history.back();
    else location.hash = el.getAttribute('href') || '#/';
  },
  'filter-cat': (el) => { state.filters.cat = el.dataset.value; state.filters.sub = ''; render(); },
  'filter-sub': (el) => { state.filters.sub = el.dataset.value; render(); },
  'filter-color': (el) => { state.filters.color = state.filters.color === el.dataset.value ? '' : el.dataset.value; render(); },
  'wear-today': (el) => toggleWearToday(el.dataset.id),
  'delete-item': (el) => deleteItem(el.dataset.id),

  'draft-set': (el) => { state.draft[el.dataset.field] = el.dataset.value; render(); },
  'draft-toggle': (el) => {
    const arr = state.draft[el.dataset.field];
    const i = arr.indexOf(el.dataset.value);
    if (i >= 0) arr.splice(i, 1); else arr.push(el.dataset.value);
    render();
  },
  'draft-color': (el) => { state.draft.color = { hex: el.dataset.hex, name: el.dataset.name }; render(); },
  'pick-sugg': (el) => {
    const { field, value } = el.dataset;
    state.draft[field] = value;
    const input = document.querySelector(`[data-field="${field}"]`);
    if (input) input.value = value;
    const box = document.querySelector(`.sugg[data-for="${field}"]`);
    if (box) box.innerHTML = suggChips(field, value);
  },
  'save-item': () => saveItem(),
  'skip-photo': () => nextInQueue(),
  'cancel-queue': () => { state.queue = []; state.queueDone = 0; state.draft = null; state.carry = null; render(); },

  'outfit-filter': (el) => { state.outfitFilter = el.dataset.value; render(); },
  'outfit-pick-cat': (el) => { state.outfitDraft.pickCat = el.dataset.value; render(); },
  'outfit-toggle-item': (el) => {
    const ids = state.outfitDraft.itemIds;
    const i = ids.indexOf(el.dataset.id);
    if (i >= 0) ids.splice(i, 1); else ids.push(el.dataset.id);
    render();
  },
  'outfit-set': (el) => { state.outfitDraft[el.dataset.field] = el.dataset.value; render(); },
  'outfit-like': () => { state.outfitDraft.liked = !state.outfitDraft.liked; render(); },
  'outfit-remove-photo': () => { state.outfitDraft.photo = null; state.outfitDraft.thumb = null; render(); },
  'outfit-save': () => saveOutfit(),
  async 'outfit-delete'() {
    if (!confirm('Supprimer cette tenue ?')) return;
    await db.remove('outfits', state.outfitDraft.id);
    state.outfits = state.outfits.filter((o) => o.id !== state.outfitDraft.id);
    state.outfitDraft = null;
    location.hash = '#/outfits';
    toast('Tenue supprimée');
    refresh();
  },

  'sugg-picking': () => { state.sugg.picking = !state.sugg.picking; render(); },
  'sugg-cat': (el) => { state.sugg.cat = el.dataset.value; render(); },
  'sugg-anchor': (el) => { state.sugg.anchor = el.dataset.id; state.sugg.picking = false; state.sugg.results = null; render(); },
  'sugg-context': (el) => { state.sugg.context = el.dataset.value; state.sugg.results = null; state.sugg.missing = []; render(); },
  'sugg-run': () => runSuggest(),
  async 'sugg-wear'(el) {
    const r = state.sugg.results[+el.dataset.index];
    const o = { id: uid(), createdAt: Date.now(), itemIds: r.pieces.map((p) => p.id), photo: null, thumb: null, context: state.sugg.context, note: '', liked: false, date: today() };
    await db.put('outfits', o);
    state.outfits.push(o);
    r.saved = true;
    toast('Tenue enregistrée et portée aujourd’hui');
    refresh();
  },
  'sugg-adjust': (el) => {
    const r = state.sugg.results[+el.dataset.index];
    state.outfitDraft = { ...newOutfitDraft(), itemIds: r.pieces.map((p) => p.id), context: state.sugg.context, pending: true };
    location.hash = '#/outfit/new';
  },

  async 'copy-claude'() {
    state.claudeText = claudeText();
    const ok = await copyText(state.claudeText);
    toast(ok ? 'Copié ! Colle-le dans Claude' : 'Copie automatique impossible : sélectionne le texte ci-dessous');
    render();
  },
  'export-prepare': () => prepareExport(),
  'export-save': () => saveExport(),
  async persist() {
    const ok = await requestPersistence();
    toast(ok ? 'Données protégées ✓' : "Le navigateur n'a pas accordé la protection (installe l'app sur l'écran d'accueil)");
    showStorageInfo();
  },
  async wipe() {
    if (!confirm('Effacer définitivement toutes les pièces et tenues ?')) return;
    if (!confirm('Vraiment ? Cette action est irréversible.')) return;
    await db.clearAll();
    state.items = [];
    state.outfits = [];
    location.hash = '#/';
    toast('Dressing effacé');
    refresh();
  },
};

const changeHandlers = {
  'filter-brand': (el) => { state.filters.brand = el.value; render(); },
  'add-files': (el) => {
    const files = [...el.files].filter((f) => f.type.startsWith('image/') || !f.type);
    if (!files.length) return;
    state.queue.push(...files.map((file) => ({ file })));
    state.added = 0;
    render();
  },
  async 'edit-photo'(el) {
    const file = el.files[0];
    if (!file) return;
    toast('Traitement de la photo…');
    const ready = await processImage(file);
    Object.assign(state.draft, { photo: ready.photo, thumb: ready.thumb, detected: ready.colors, color: { hex: ready.colors[0].hex, name: nearestColor(ready.colors[0].hex).name } });
    render();
  },
  'draft-custom-color': (el) => { state.draft.color = { hex: el.value, name: nearestColor(el.value).name }; render(); },
  async 'outfit-photo'(el) {
    const file = el.files[0];
    if (!file) return;
    toast('Traitement de la photo…');
    const ready = await processImage(file);
    state.outfitDraft.photo = ready.photo;
    state.outfitDraft.thumb = ready.thumb;
    render();
  },
  'import-file': (el) => el.files[0] && importFile(el.files[0]),
};

const showError = (err) => { console.error(err); toast(`Erreur : ${err?.message || err}`, 8000); };

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || !actions[el.dataset.action]) return;
  e.preventDefault();
  // Retour visuel immédiat sur les boutons d'enregistrement.
  if (el.tagName === 'BUTTON' && el.dataset.action.endsWith('save')) el.textContent = 'Enregistrement…';
  Promise.resolve(actions[el.dataset.action](el, e)).catch(showError);
});

window.addEventListener('error', (e) => showError(e.error || e.message));
window.addEventListener('unhandledrejection', (e) => showError(e.reason));

document.addEventListener('change', (e) => {
  const el = e.target.closest('[data-change]');
  if (!el || !changeHandlers[el.dataset.change]) return;
  Promise.resolve(changeHandlers[el.dataset.change](el, e))
    .catch(showError)
    .finally(() => { if (el.type === 'file') el.value = ''; });
});

document.addEventListener('input', (e) => {
  const el = e.target;
  const scope = el.dataset?.scope;
  if (!scope || !el.dataset.field) return;
  const target = scope === 'outfit' ? state.outfitDraft : state.draft;
  if (target) target[el.dataset.field] = el.value;
  if (el.dataset.sugg) {
    const box = document.querySelector(`.sugg[data-for="${el.dataset.sugg}"]`);
    if (box) box.innerHTML = suggChips(el.dataset.sugg, el.value);
  }
});

document.addEventListener('focusin', (e) => { if (e.target.matches('[data-select-all]')) e.target.select(); });

window.addEventListener('hashchange', () => { navDepth++; render(); });

// ---------- Démarrage

async function loadAll() {
  const [items, outfits] = await Promise.all([db.getAll('items'), db.getAll('outfits')]);
  state.items = items;
  state.outfits = outfits;
}

async function start() {
  try {
    await loadAll();
  } catch (e) {
    $('#view').innerHTML = `<div class="empty"><p><strong>Impossible d'ouvrir la base locale.</strong></p><p class="muted">${esc(e.message)}</p></div>`;
    return;
  }
  refresh();
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

start();
