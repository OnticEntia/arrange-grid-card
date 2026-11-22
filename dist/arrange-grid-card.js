/*
 * Arrange Grid Card
 *
 * A container card: any Home Assistant cards on a grid of cells, each placed
 * by hand. "Arrange" mode moves a card to any free cell, resizes it by cells,
 * leaves cells empty, and adds or removes columns and rows. On a narrow
 * screen the cards are a list instead, in an order of its own.
 *
 *   type: custom:arrange-grid-card
 *   columns: 12
 *   cards:
 *     - id: porch          # what a saved place is kept under
 *       type: tile
 *       entity: light.porch
 *
 * The arrangement is kept per Home Assistant user (frontend user data, with
 * a copy in the browser), on top of an optional `default_layout` in the card
 * config. The whole card is this one file: no build step, no dependencies.
 *
 * The arranging model (cells, places, Arrange mode, the one-column list, the
 * menu, the storage) is copied from camera-wall-card.js in protect-detections
 * and made general; the two files share no code at run time.
 *
 * https://github.com/OnticEntia/arrange-grid-card (MIT)
 */

const VERSION = "0.15.0";
const TAG = "arrange-grid-card";
const USER_KEY = "arrange_grid_card"; // frontend user data
const LOCAL_KEY = "arrange-grid-card:layout:"; // + layout name, in localStorage
const RESUME_KEY = "arrange-grid-card:resume:"; // + layout name, in sessionStorage: an Arrange a move interrupted
const FOLD_KEY = "arrange-grid-card:folded:"; // + layout name (only with `storage: config`)
const PREV_KEY = "arrange-grid-card:previous:"; // + the page's layout name: the arrangements before the last changes
const PREV_KEEP = 5; // that many previous arrangements are kept for each page
const EDIT_DIALOG = "hui-dialog-edit-card"; // Home Assistant's own dialog for editing a card
const UNDO_KEEP = 50; // steps of one Arrange that Undo can take back
const MAX_COLS = 48;
const MAX_ROWS = 400;
const SECTION_COLS = 12; // what `grid_options.columns` counts in
const DEFAULTS = { columns: 12, row_height: 56, gap: 8, min_width: 600, storage: "user", arrange_button: true, context_menu: true, groups: true, hide_add_menu: false };

// ------------------------------------------------------------ grid maths
//
// A grid is {cols, rows, tiles: [{id, c, r, w, h, ...}]}: column and row of a
// tile's first cell (from 0), and how many cells it is wide and high.

const Layout = {
  // The tiles of g with a cell in the given area (but for `skip`).
  hits(g, c, r, w, h, skip) {
    return g.tiles.filter((t) => t !== skip && t.c < c + w && c < t.c + t.w && t.r < r + h && r < t.r + t.h);
  },

  // The first free place for w x h cells, reading across then down, starting
  // at `from` ({c, r}) if given. Below the last row too if `grow` (there is
  // always one then), else maybe null.
  spot(g, w, h, grow, from) {
    const last = grow ? Infinity : g.rows - h;
    for (let r = from ? from.r : 0; r <= last; r++) {
      for (let c = from && r === from.r ? from.c : 0; c + w <= g.cols; c++) {
        if (!Layout.hits(g, c, r, w, h).length) return { c, r };
      }
    }
    return null;
  },

  // Items [{id, w, h}] put into a grid `cols` wide one after the other, each
  // in the first free place at or after the one before it: the order of the
  // config is the reading order of the page.
  flow(items, cols) {
    const g = { cols, rows: 0, tiles: [] };
    let from = { c: 0, r: 0 };
    for (const t of items) {
      const w = Math.max(1, Math.min(t.w, cols));
      const h = Math.max(1, t.h);
      const at = Layout.spot(g, w, h, true, from);
      g.tiles.push({ ...t, w, h, c: at.c, r: at.r });
      g.rows = Math.max(g.rows, at.r + h);
      from = at;
    }
    g.rows = Math.max(1, g.rows);
    return g;
  },

  // A saved arrangement {grid: {cols, rows}, tiles: [{id, c, r, w, h}]} as a
  // grid for the items there are now. A saved tile whose card is gone leaves
  // its cells empty; a card not in it, or saved where it cannot be (off the
  // grid, on top of another), takes the first free place at its own size, on
  // new rows if the grid is full. Nothing overlaps, nothing is left out.
  free(src, items) {
    const int = (v, min, max) => (Number.isInteger(v) && v >= min ? Math.min(v, max) : min);
    const g = { cols: int(src.grid && src.grid.cols, 1, MAX_COLS), rows: int(src.grid && src.grid.rows, 1, MAX_ROWS), tiles: [] };
    const byId = new Map(items.map((t) => [t.id, t]));
    const used = new Set();
    const later = [];
    for (const t of Array.isArray(src.tiles) ? src.tiles : []) {
      const item = t && byId.get(t.id);
      if (!item || used.has(t.id)) continue;
      used.add(t.id);
      const place = { ...item, c: int(t.c, 0, MAX_COLS), r: int(t.r, 0, MAX_ROWS), w: int(t.w, 1, MAX_COLS), h: int(t.h, 1, MAX_ROWS) };
      const fits = place.c + place.w <= g.cols && place.r + place.h <= g.rows;
      if (fits && !Layout.hits(g, place.c, place.r, place.w, place.h).length) g.tiles.push(place);
      else later.push(place);
    }
    for (const item of items) if (!used.has(item.id)) later.push(item);
    for (const t of later) {
      const w = Math.max(1, Math.min(t.w, g.cols));
      const h = Math.max(1, t.h);
      const at = Layout.spot(g, w, h, true);
      g.tiles.push({ ...t, w, h, c: at.c, r: at.r });
      g.rows = Math.max(g.rows, at.r + h);
    }
    return g;
  },

  // Can tile t of g take w x h cells where it is?
  // `t` made `h` rows tall, with what is under it moved down to make room
  // (and what is under that, and so on). Map of tile -> its new row, or
  // null when that would run past the last row there can be.
  push(g, t, h) {
    const moved = new Map();
    const row = (x) => (moved.has(x) ? moved.get(x) : x.r);
    const tall = (x) => (x === t ? h : x.h);
    const queue = [t];
    for (let guard = 0; queue.length && guard < 20000; guard++) {
      const a = queue.shift();
      for (const o of g.tiles) {
        if (o === a || o === t) continue;
        if (!(o.c < a.c + a.w && a.c < o.c + o.w)) continue;
        if (!(row(o) < row(a) + tall(a) && row(a) < row(o) + o.h)) continue;
        moved.set(o, row(a) + tall(a));
        queue.push(o);
      }
    }
    for (const [o, r] of moved) if (r + o.h > MAX_ROWS) return null;
    return t.r + h > MAX_ROWS ? null : moved;
  },

  fits(g, t, w, h) {
    return w >= 1 && h >= 1 && t.c + w <= g.cols && t.r + h <= g.rows && !Layout.hits(g, t.c, t.r, w, h, t).length;
  },

  // What putting tile t at (c, r) takes: [[tile, c, r], ...], or null when
  // there is no room. A free place: just that. A place taken by one other
  // tile: the two change places, if each fits where the other was.
  tryMove(g, t, c, r) {
    if (c < 0 || r < 0 || c + t.w > g.cols || r + t.h > g.rows) return null;
    const hits = Layout.hits(g, c, r, t.w, t.h, t);
    if (!hits.length) return [[t, c, r]];
    if (hits.length > 1) return null;
    const o = hits[0];
    if (t.c + o.w > g.cols || t.r + o.h > g.rows) return null;
    const rest = { ...g, tiles: g.tiles.filter((x) => x !== t && x !== o) };
    if (Layout.hits(rest, t.c, t.r, o.w, o.h).length || Layout.hits(rest, c, r, t.w, t.h).length) return null;
    const apart = t.c + o.w <= c || c + t.w <= t.c || t.r + o.h <= r || r + t.h <= t.r;
    return apart ? [[t, c, r], [o, t.c, t.r]] : null;
  },

  // Can the tiles `group` of g all go (dc, dr) cells further, as one? They
  // stay on the grid sideways and upwards (downwards the grid grows) and
  // land on nothing but each other's places.
  canShift(g, group, dc, dr) {
    const rest = { ...g, tiles: g.tiles.filter((t) => !group.includes(t)) };
    return group.every((t) => t.c + dc >= 0 && t.c + dc + t.w <= g.cols && t.r + dr >= 0 && t.r + dr + t.h <= MAX_ROWS && !Layout.hits(rest, t.c + dc, t.r + dr, t.w, t.h).length);
  },

  // The row after the last one with a tile in it (at least 1).
  bottom(tiles) {
    return Math.max(1, ...tiles.map((t) => t.r + t.h));
  },

  // What is worth keeping of a saved thing, or null: {tiles, grid?, list?, hidden?}.
  valid(a) {
    if (!a || typeof a !== "object" || Array.isArray(a)) return null;
    const out = { tiles: [] };
    if (a.grid && Number.isInteger(a.grid.cols) && Number.isInteger(a.grid.rows) && Array.isArray(a.tiles)) {
      out.grid = { cols: a.grid.cols, rows: a.grid.rows };
      out.tiles = a.tiles.filter((t) => t && typeof t.id === "string").map(({ id, c, r, w, h }) => ({ id, c, r, w, h }));
    }
    // the order of the one-column list, kept apart from the wide grid
    if (Array.isArray(a.list)) out.list = a.list.filter((id) => typeof id === "string");
    if (Array.isArray(a.hidden)) out.hidden = a.hidden.filter((id) => typeof id === "string");
    // the groups folded shut in the list
    if (Array.isArray(a.folded) && a.folded.length) out.folded = a.folded.filter((id) => typeof id === "string");
    return out.grid || out.list || out.hidden || out.folded ? out : null;
  },

  // The ids in the order of the list: those of `own` first, as it has them,
  // then the rest as the wide grid reads, row by row.
  listOrder(own, tiles) {
    const wide = [...tiles].sort((a, b) => a.r - b.r || a.c - b.c).map((t) => t.id);
    const rank = (id) => {
      const at = own.indexOf(id);
      return at < 0 ? own.length + wide.indexOf(id) : at;
    };
    return [...wide].sort((a, b) => rank(a) - rank(b));
  },
};

// What each child is known by: its `id`, else its place in the list.
function cardKeys(cards) {
  const seen = new Set();
  return cards.map((card, i) => {
    const id = card && (typeof card.id === "string" || typeof card.id === "number") ? String(card.id) : "";
    const key = id && !seen.has(id) ? id : `#${i}`;
    seen.add(key);
    return key;
  });
}

// A child's config as its own card gets it (`id` is ours, not the card's).
function childConfig(card) {
  const { id, ...rest } = card;
  return rest;
}

function cardName(card) {
  const type = String((card && card.type) || "card").replace(/^custom:/, "");
  const name = card && (card.title || card.name || card.heading || card.entity || (typeof card.id === "string" ? card.id : ""));
  return name ? `${name} · ${type}` : type;
}

// The name a card's arrangement is kept under: its `layout`, else the page.
function layoutName(config) {
  return String((config && config.layout) || (typeof location !== "undefined" && location.pathname) || "default");
}

function make(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  if (tag === "button") e.type = "button";
  return e;
}

function icon(name) {
  const i = document.createElement("ha-icon");
  i.setAttribute("icon", name);
  return i;
}

const STYLE = `
  :host { display: block; box-sizing: border-box; position: relative; padding: var(--arrange-grid-padding, 8px);
    color: var(--primary-text-color); font-family: var(--ha-font-family-body, Roboto, sans-serif); }
  /* one of these inside another is a group: a box with its title */
  :host([nested]) { height: 100%; padding: 6px; border-radius: var(--ha-card-border-radius, 12px);
    border: 1px solid var(--ha-card-border-color, var(--divider-color, #444)); }
  :host(.dropin) { outline: 2px solid var(--primary-color); outline-offset: -2px;
    background: color-mix(in srgb, var(--primary-color) 14%, transparent); }
  .bar .why.tip { color: var(--primary-text-color); }
  .head { display: flex; align-items: center; gap: 8px; min-height: 40px; padding: 0 4px 0 6px; margin: 0 0 var(--agc-gap, 8px);
    font-size: 16px; font-weight: 500; color: var(--primary-text-color); --mdc-icon-size: 20px; }
  .head[hidden], .head button[hidden], .grid[hidden], .badges[hidden] { display: none; }
  .head.shut { margin-bottom: 0; }
  .head .title { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .head ha-icon { color: var(--secondary-text-color); flex: none; }
  .head.can { cursor: pointer; }
  .head button { flex: none; width: 40px; height: 40px; padding: 0; display: grid; place-items: center; cursor: pointer; border: 0; border-radius: 50%;
    background: transparent; color: var(--secondary-text-color); }
  .head button:focus-visible { outline: 2px solid var(--primary-color); outline-offset: -2px; }
  .badges { display: flex; flex-wrap: wrap; justify-content: center; align-items: center; gap: 8px; margin: 0 0 var(--agc-gap, 8px); }
  .badges[hidden] { display: none; }
  .grid { display: grid; gap: var(--agc-gap, 8px); grid-auto-rows: minmax(var(--agc-row, 56px), auto); position: relative; }
  .slot { position: relative; z-index: 1; min-width: 0; display: flex; flex-direction: column; }
  .slot > :not(.arr) { flex: 1 1 auto; min-width: 0; }
  .slot[hidden], .bar[hidden], .empty[hidden], .foot[hidden] { display: none; }
  .slot.dragging { z-index: 5; opacity: .85; }
  .slot.drop .arr { background: color-mix(in srgb, var(--primary-color) 45%, transparent); border-style: solid; }
  .empty { padding: 32px 16px; text-align: center; color: var(--secondary-text-color); }
  .foot { display: flex; justify-content: flex-end; margin-top: var(--agc-gap, 8px); }
  .menu-btn { width: 40px; height: 40px; padding: 0; display: grid; place-items: center; cursor: pointer; border-radius: 50%;
    color: var(--secondary-text-color); background: var(--ha-card-background, var(--card-background-color, #1c1c1c));
    border: 1px solid var(--ha-card-border-color, var(--divider-color, #444)); opacity: .6; transition: opacity .15s, color .15s; }
  .menu-btn:hover, .menu-btn:focus-visible, .menu-btn.on { opacity: 1; color: var(--primary-color); outline: none; }
  .menu-btn:focus-visible, .bar button:focus-visible, .arr:focus-visible, .arr button:focus-visible { outline: 2px solid var(--primary-color); outline-offset: 2px; }

  .bar { position: sticky; top: calc(var(--header-height, 56px) + 8px); z-index: 6; display: flex; flex-wrap: wrap; gap: 8px; align-items: center;
    justify-content: center; margin: 0 auto var(--agc-gap, 8px); padding: 8px 12px; box-sizing: border-box; max-width: 100%; width: fit-content;
    border-radius: var(--ha-card-border-radius, 12px); background: var(--ha-card-background, var(--card-background-color, #1c1c1c));
    border: 1px solid var(--ha-card-border-color, var(--divider-color, #444)); box-shadow: var(--ha-card-box-shadow, 0 4px 14px rgba(0,0,0,.4)); font-size: 14px; }
  .bar span { color: var(--secondary-text-color); }
  .bar button { font: inherit; color: var(--primary-text-color); cursor: pointer; border-radius: 999px; padding: 6px 14px;
    border: 1px solid var(--divider-color, #444); background: transparent; }
  .bar button.main { border-color: var(--primary-color); background: color-mix(in srgb, var(--primary-color) 40%, transparent); }
  .bar .grp { display: inline-flex; align-items: center; gap: 4px; }
  .bar .grp button { padding: 4px 11px; font-weight: 600; }
  .bar .grp b { min-width: 20px; text-align: center; }
  .bar .why { flex-basis: 100%; text-align: center; color: var(--error-color, #f87171); }
  .bar .why:empty { display: none; }
  .bar textarea { flex-basis: 100%; min-height: 120px; box-sizing: border-box; font: 12px/1.4 var(--ha-font-family-code, monospace);
    color: var(--primary-text-color); background: var(--secondary-background-color, #000); border: 1px solid var(--divider-color, #444); border-radius: 8px; padding: 8px; }

  .arr { position: absolute; inset: 0; z-index: 3; box-sizing: border-box; container-type: size; border: 2px dashed var(--primary-color); cursor: grab;
    border-radius: var(--ha-card-border-radius, 12px); background: color-mix(in srgb, var(--primary-color) 14%, transparent);
    color: var(--text-primary-color, #fff); user-select: none; -webkit-user-select: none; transition: background .12s; }
  .slot.dragging .arr { cursor: grabbing; }
  .arr .grip, .arr .size { position: absolute; width: 32px; height: 32px; max-width: 45%; max-height: 100%; display: grid; place-items: center;
    --mdc-icon-size: 20px;
    touch-action: none; background: color-mix(in srgb, var(--primary-color) 80%, #000); }
  .arr .grip { left: 0; top: 0; border-radius: 10px 0 10px 0; cursor: grab; }
  .arr .size { right: 0; bottom: 0; border-radius: 10px 0 10px 0; cursor: nwse-resize; }
  .arr .dim { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); font-size: 12px; font-weight: 600; padding: 1px 6px;
    border-radius: 999px; background: rgba(0,0,0,.6); color: #fff; pointer-events: none; white-space: nowrap; }
  .arr .mv { position: absolute; right: 6px; top: 50%; transform: translateY(-50%); display: flex; gap: 6px; }
  .arr .mv button { width: 36px; height: 36px; padding: 0; display: grid; place-items: center; cursor: pointer; border-radius: 50%;
    border: 1px solid rgba(255,255,255,.5); background: rgba(0,0,0,.6); color: #fff; }
  @media (pointer: coarse) { .arr .grip, .arr .size { width: 40px; height: 40px; } }
  /* a card too small for its handles at full size */
  @container (max-width: 150px) {
    .arr .grip, .arr .size, .arr .pick { width: 30px; height: 30px; }
    .arr .pick { left: 31px; }
    .arr .mv { right: 3px; gap: 3px; }
    .arr .mv button { width: 28px; height: 28px; --mdc-icon-size: 18px; }
  }
  @container (max-width: 80px) { .arr .dim { display: none; } }
  .cell.under { visibility: hidden; }
  .cell.under.on, .cell.under.bad { visibility: visible; }
  /* a group while arranging: only its title bar and corner take hold of it, so the cards in it can be reached */
  .arr.frame { pointer-events: none; background: none; }
  .arr.frame .grip, .arr.frame .size, .arr.frame .pick, .arr.frame .mv { pointer-events: auto; }
  .arr.frame .grip { right: 0; width: auto; max-width: none; height: 40px; max-height: none; justify-content: start; padding-left: 8px; box-sizing: border-box;
    border-radius: 10px 10px 0 0; background: color-mix(in srgb, var(--primary-color) 45%, transparent); }
  .arr.frame .dim { left: auto; right: 8px; top: 20px; transform: translateY(-50%); }
  .arr.frame.list .mv { top: 20px; }
  .arr.sel { border-style: solid; background: color-mix(in srgb, var(--primary-color) 32%, transparent); }
  .arr .pick { position: absolute; left: 34px; top: 0; width: 32px; height: 32px; padding: 0; display: grid; place-items: center; cursor: pointer;
    border: 0; border-radius: 0 0 10px 10px; color: inherit; background: rgba(0,0,0,.55); --mdc-icon-size: 20px; }
  .arr .pick[aria-pressed="true"] { background: color-mix(in srgb, var(--primary-color) 80%, #000); }
  .fold { position: absolute; right: 4px; top: 50%; transform: translateY(-50%); z-index: 2; width: 40px; height: 40px; padding: 0; display: grid;
    place-items: center; cursor: pointer; border: 0; border-radius: 50%; background: transparent; color: var(--secondary-text-color); }
  .fold:hover, .fold:focus-visible { color: var(--primary-color); outline: none; background: color-mix(in srgb, var(--primary-color) 14%, transparent); }
  .fold[hidden] { display: none; }
  .cell { box-sizing: border-box; pointer-events: none; border: 1px dashed color-mix(in srgb, var(--primary-text-color) 30%, transparent);
    border-radius: 8px; transition: background .12s; }
  .cell.on { background: color-mix(in srgb, var(--primary-color) 40%, transparent); border-style: solid; border-color: var(--primary-color); }
  .cell.bad { background: color-mix(in srgb, var(--error-color, #e0102a) 35%, transparent); border-color: var(--error-color, #e0102a); }

  .menu-back { position: fixed; inset: 0; z-index: 9; }
  .menu { position: fixed; z-index: 10; min-width: 200px; max-width: min(320px, calc(100vw - 16px)); max-height: calc(100vh - 16px); overflow-y: auto;
    box-sizing: border-box; padding: 6px; border-radius: 12px; font-size: 14px; color: var(--primary-text-color);
    background: var(--ha-card-background, var(--card-background-color, #161616)); border: 1px solid var(--ha-card-border-color, var(--divider-color, #333));
    box-shadow: 0 12px 32px rgba(0,0,0,.6); }
  .menu .head { display: block; padding: 6px 10px 8px; margin-bottom: 4px; font-weight: 600; border-bottom: 1px solid var(--divider-color, #2a2a2a); }
  .menu .head small { display: block; font-weight: 400; font-size: 12px; color: var(--secondary-text-color); }
  .menu button { display: flex; align-items: center; gap: 10px; width: 100%; text-align: left; font: inherit; color: inherit; cursor: pointer;
    background: none; border: 0; border-radius: 8px; padding: 9px 10px; }
  .menu button:hover, .menu button:focus-visible { background: color-mix(in srgb, var(--primary-color) 22%, transparent); outline: none; }
  .menu button:disabled { opacity: .5; cursor: default; background: none; }
  .menu input { display: block; width: calc(100% - 16px); margin: 4px 8px 6px; padding: 8px 10px; box-sizing: border-box; font: inherit;
    color: var(--primary-text-color); background: var(--secondary-background-color, #000); border: 1px solid var(--divider-color, #444); border-radius: 8px; }
  .menu input:focus { outline: none; border-color: var(--primary-color); }
  .menu .note { display: block; padding: 2px 12px 8px; font-size: 13px; color: var(--secondary-text-color); }
  .menu .note[hidden] { display: none; }
  .menu hr { border: 0; border-top: 1px solid var(--divider-color, #2a2a2a); margin: 4px 0; }

  .bar .undo { flex-basis: 100%; display: flex; gap: 10px; align-items: center; justify-content: center; }
  .bar .undo[hidden] { display: none; }
  .bar button:disabled { opacity: .4; cursor: default; }
  .bar button.quiet { border-color: transparent; color: var(--secondary-text-color); }
  .bar .ask { flex-basis: 100%; display: flex; flex-wrap: wrap; gap: 8px 10px; align-items: center; justify-content: center; padding-top: 8px;
    border-top: 1px solid var(--divider-color, #444); }
  .bar .ask span { flex-basis: 100%; text-align: center; color: var(--primary-text-color); }
  .bar .ask button.danger { border-color: var(--error-color, #f87171); color: var(--error-color, #f87171); }
  .arr .mv .rm { border-color: var(--error-color, #f87171); }
  /* where a card being dragged is dropped to take it off the page */
  .trash { position: fixed; left: 50%; bottom: calc(16px + env(safe-area-inset-bottom, 0px)); transform: translateX(-50%); z-index: 8; display: none;
    align-items: center; gap: 8px; padding: 12px 22px; border-radius: 999px; font-size: 14px; white-space: nowrap; pointer-events: none;
    color: var(--error-color, #f87171); border: 2px dashed var(--error-color, #f87171);
    background: var(--ha-card-background, var(--card-background-color, #1c1c1c)); box-shadow: 0 4px 14px rgba(0,0,0,.5); transition: transform .12s; }
  .trash.show { display: flex; }
  .trash.over { border-style: solid; transform: translateX(-50%) scale(1.1);
    background: color-mix(in srgb, var(--error-color, #f87171) 35%, var(--card-background-color, #1c1c1c)); color: var(--primary-text-color); }
  @media (prefers-reduced-motion: reduce) {
    .menu-btn, .arr, .cell, .trash { transition: none; }
  }
`;

class ArrangeGridCard extends HTMLElement {
  static getConfigElement() {
    return document.createElement("arrange-grid-card-editor");
  }

  // (a name of its own, so that two of these on one page keep apart)
  static getStubConfig() {
    return { type: `custom:${TAG}`, layout: `grid-${Math.random().toString(36).slice(2, 8)}`, columns: DEFAULTS.columns, cards: [] };
  }

  setConfig(config) {
    if (!config || !Array.isArray(config.cards)) throw new Error("arrange-grid-card: `cards` must be a list of cards");
    config.cards.forEach((card, i) => {
      if (!card || typeof card !== "object" || typeof card.type !== "string" || !card.type) throw new Error(`arrange-grid-card: cards[${i}] needs a type`);
    });
    const num = (key, min, max) => {
      const v = config[key] == null ? DEFAULTS[key] : Number(config[key]);
      if (!Number.isFinite(v) || v < min || v > max) throw new Error(`arrange-grid-card: \`${key}\` must be a number from ${min} to ${max}`);
      return v;
    };
    const storage = config.storage == null ? DEFAULTS.storage : config.storage;
    if (storage !== "user" && storage !== "config") throw new Error("arrange-grid-card: `storage` must be `user` or `config`");
    const columns = num("columns", 1, MAX_COLS);
    if (!Number.isInteger(columns)) throw new Error("arrange-grid-card: `columns` must be a whole number");
    const was = this._config;
    this._raw = config;
    this._config = {
      cards: config.cards,
      columns,
      row_height: num("row_height", 16, 400),
      gap: num("gap", 0, 64),
      min_width: num("min_width", 0, 10000),
      storage,
      name: layoutName(config),
      arrange_button: config.arrange_button !== false,
      context_menu: config.context_menu !== false,
      groups: config.groups !== false,
      badges: Array.isArray(config.badges) ? config.badges : [],
      title: config.title ? String(config.title) : "",
      icon: config.icon ? String(config.icon) : "",
      nested: config.nested === true,
      hide_add_menu: config.hide_add_menu === true,
      default_layout: Layout.valid(config.default_layout),
    };
    this._keys = cardKeys(config.cards);
    this._cfgOver = undefined; // (the dashboard has what was saved to it)
    if (was && (was.name !== this._config.name || was.storage !== storage)) {
      this._asked = null;
      this._arr = null;
      this._arrAll = null;
    }
    if (this._arranging) this._arrExit("cancel", true);
    this._render();
    this._headerSync();
    this._sync();
    this._load();
  }

  set hass(hass) {
    this._hass = hass;
    for (const kid of this._kids || []) if (!kid.off) kid.el.hass = hass;
    for (const el of this._badgeEls || []) el.hass = hass;
    this._load();
  }

  get hass() {
    return this._hass;
  }

  getCardSize() {
    const c = this._config || DEFAULTS;
    const rows = (this._rows || ((c.cards && c.cards.length) || 1)) + (c.title ? 1 : 0);
    return Math.max(1, Math.ceil((rows * (c.row_height + c.gap)) / 50));
  }

  // (as a group it is as wide as a section, and as tall as what is in it)
  getGridOptions() {
    return this._config && this._config.nested ? { columns: SECTION_COLS, min_columns: 3 } : { columns: "full", min_columns: 6 };
  }

  connectedCallback() {
    if (typeof ResizeObserver !== "undefined" && !this._ro) {
      this._ro = new ResizeObserver(() => this._layout());
      this._ro.observe(this);
    }
    this._headerSync();
    this._layout();
  }

  disconnectedCallback() {
    if (this._ro) this._ro.disconnect();
    this._ro = null;
    this._headerSync();
    this._menuClose();
    if (this._arranging) this._arrExit("cancel", true);
  }

  // ------------------------------------------------------------ the page

  _render() {
    if (!this.shadowRoot) {
      const root = this.attachShadow({ mode: "open" });
      const style = document.createElement("style");
      style.textContent = STYLE;
      this._bar = make("div", "bar");
      this._bar.hidden = true;
      this._bar.setAttribute("role", "status");
      this._head = make("div", "head");
      this._head.hidden = true;
      this._headIcon = icon("mdi:folder-outline");
      this._headTitle = make("span", "title", "");
      this._fold = make("button", "shutter");
      this._foldIcon = icon("mdi:chevron-up");
      this._fold.appendChild(this._foldIcon);
      this._fold.hidden = true;
      this._head.append(this._headIcon, this._headTitle, this._fold);
      // (in the list a group folds shut by its title)
      this._head.addEventListener("click", () => {
        const outer = this._outerGrid();
        if (outer && !this._fold.hidden) outer._kidFold(this);
      });
      this._badges = make("div", "badges");
      this._badges.hidden = true;
      this._grid = make("div", "grid");
      this._empty = make("div", "empty");
      this._empty.hidden = true;
      this._foot = make("div", "foot");
      this._btn = make("button", "menu-btn");
      this._btn.title = "Arrange this page";
      this._btn.setAttribute("aria-label", "Arrange this page");
      this._btn.setAttribute("aria-haspopup", "menu");
      this._btn.appendChild(icon("mdi:view-dashboard-edit-outline"));
      this._btn.addEventListener("click", () => {
        const r = this._btn.getBoundingClientRect();
        this._context(r.left, r.top, null, this._btn);
      });
      this._foot.appendChild(this._btn);
      root.append(style, this._head, this._bar, this._badges, this._grid, this._empty, this._foot);
      this._wireMenu(root);
      this._kids = [];
    }
    const c = this._config;
    this.style.setProperty("--agc-gap", `${c.gap}px`);
    this.style.setProperty("--agc-row", `${c.row_height}px`);
    this._foot.hidden = !c.arrange_button;
    this._head.hidden = !c.title;
    this._headTitle.textContent = c.title;
    this._headIcon.hidden = !c.icon;
    this._headIcon.style.display = c.icon ? "" : "none";
    if (c.icon) this._headIcon.setAttribute("icon", c.icon);
    if (c.nested) this.setAttribute("nested", "");
    else if (this.removeAttribute) this.removeAttribute("nested");
  }

  // `hide_add_menu`: Home Assistant's dashboard header has an "add" menu
  // (device, automation, area, person) that adds nothing to this page and
  // is easily taken for a way to add to it. While this card is on screen
  // the menu's button is hidden; it is put back when the card leaves. This
  // reaches into the header, so a release that moves it only undoes the
  // hiding, nothing else.
  _headerSync() {
    const want = this.isConnected && this._config && this._config.hide_add_menu && !this._config.nested;
    const hid = (this._headerHid = this._headerHid || new Set());
    if (!want) {
      if (this._headerObs) this._headerObs.disconnect();
      this._headerObs = null;
      for (const el of hid) el.style.display = "";
      hid.clear();
      return;
    }
    let root = null;
    for (let n = this; n && !root; n = n.parentNode || n.host) if (n.localName === "hui-root") root = n;
    if (!root || !root.shadowRoot) return;
    const ours = (item) => /^ui\.panel\.lovelace\.menu\.(add_device|create_automation|create_area|add_person)$/.test(String(item.value || ""));
    const apply = (node) => {
      for (const el of node.children || []) {
        if (el.localName === "ha-dropdown" && el.getAttribute("slot") === "actionItems" && [...el.children].some((c) => c.localName === "ha-dropdown-item" && ours(c))) {
          if (el.style.display !== "none") el.style.display = "none";
          hid.add(el);
        } else apply(el);
      }
    };
    apply(root.shadowRoot);
    if (!this._headerObs && typeof MutationObserver !== "undefined") {
      this._headerObs = new MutationObserver(() => apply(root.shadowRoot));
      this._headerObs.observe(root.shadowRoot, { childList: true, subtree: true });
    }
  }

  // ------------------------------------------------------------ groups
  //
  // One of these cards among another's cards is a group: a box that holds
  // its own cards on its own grid, moved and sized in the outer grid as one
  // card. The outer one hands it a name for its arrangement, and decides
  // for it whether the page is a grid or a list. Groups can hold groups.

  _outerGrid() {
    if (!this._config || !this._config.nested || typeof this.getRootNode !== "function") return null;
    const root = this.getRootNode();
    const host = root && root.host;
    return host && host.localName === TAG ? host : null;
  }

  // What a group among this one's cards is given besides its own config.
  _groupConfig(cfg, key) {
    if (cfg.type !== `custom:${TAG}`) return cfg;
    const c = this._config;
    return {
      columns: SECTION_COLS, arrange_button: false, row_height: c.row_height, gap: c.gap, storage: c.storage, context_menu: c.context_menu,
      ...cfg,
      layout: cfg.layout || `${c.name}/${key}`,
      nested: true,
    };
  }

  _kidOf(el) {
    return (this._kids || []).find((k) => k.el === el) || null;
  }

  _kidFolded(el) {
    const kid = this._kidOf(el);
    return !!kid && this._folded().includes(kid.key);
  }

  _kidFold(el) {
    const kid = this._kidOf(el);
    if (kid) this._setFolded(kid.key, !this._folded().includes(kid.key));
  }

  // (a group's height changed: the outer grid's guess of it follows)
  _kidGrew(el) {
    const kid = this._kidOf(el);
    if (!kid) return;
    this._measure(kid);
    // while arranging its box follows it (it has a spare row then), so
    // that the rows it is in are not stretched, and its neighbours with them
    if (this._arranging && this._arrEdit && !kid.off && !(this._arrLead || this)._arrSpareGrid) this._arrFit(kid, false, true);
  }

  // ------------------------------------- moving a card between groups
  //
  // Which group a card is in is the dashboard's config (each group has its
  // own `cards`), so moving one rewrites the dashboard: for everyone, and
  // only by an administrator on a dashboard kept by Home Assistant's UI.

  _rootGrid() {
    let g = this;
    for (let o = g._outerGrid(); o; o = g._outerGrid()) g = o;
    return g;
  }

  // Where this grid is, counted in cards from the outermost one down.
  _pathFromRoot() {
    const path = [];
    for (let g = this, o = g._outerGrid(); o; g = o, o = g._outerGrid()) path.unshift(o._kids.indexOf(o._kidOf(g)));
    return path;
  }

  // Every grid of the page a card of this one could go to: [{grid, label}].
  // Not this one, and not into the card itself when it is a group.
  _moveTargets(kid) {
    const out = [];
    const visit = (g, label) => {
      if (kid && g === kid.el) return;
      if (g !== this) out.push({ grid: g, label });
      for (const k of g._kids || []) {
        if (k.el.localName !== TAG || !k.el._config) continue;
        const name = k.el._config.title || k.key;
        visit(k.el, g._outerGrid() ? `${label} › ${name}` : name);
      }
    };
    visit(this._rootGrid(), "The page");
    return out;
  }

  _mayMove() {
    const user = this._hass && this._hass.user;
    return !!(user && user.is_admin);
  }

  // Home Assistant's own handle on the dashboard, when it can be found
  // from here: saving through it redraws the page at once.
  _lovelace() {
    for (let n = this; n; n = n.parentNode || n.host) {
      const ll = n.lovelace;
      if (ll && ll.config && typeof ll.saveConfig === "function") return ll;
    }
    return null;
  }

  // Changes the dashboard's config: `change(page, down)` is given the
  // outermost grid's own config there and a way down from it by a path.
  async _dashEdit(change) {
    const root = this._rootGrid();
    const strip = (c) => {
      const { default_layout, ...rest } = c;
      return JSON.stringify(rest);
    };
    if (!this._mayMove()) throw new Error("not an administrator");
    const ll = this._lovelace();
    let conf, save;
    if (ll) {
      conf = JSON.parse(JSON.stringify(ll.config));
      save = (c) => ll.saveConfig(c);
    } else {
      const first = location.pathname.split("/")[1] || "";
      const url_path = !first || first === "lovelace" ? null : first;
      conf = await this._hass.callWS({ type: "lovelace/config", url_path, force: false });
      save = async (c) => {
        await this._hass.callWS({ type: "lovelace/config/save", url_path, config: c });
        this.dispatchEvent(new CustomEvent("config-refresh", { bubbles: true, composed: true }));
      };
    }
    const mine = strip(root._raw);
    let found = null;
    const walk = (node) => {
      if (found || !node || typeof node !== "object") return;
      if (!Array.isArray(node) && node.type === `custom:${TAG}` && Array.isArray(node.cards) && strip(node) === mine) {
        found = node;
        return;
      }
      for (const v of Array.isArray(node) ? node : Object.values(node)) walk(v);
    };
    walk(conf && conf.views);
    if (!found) throw new Error("card not found in the dashboard");
    change(found, (path) => path.reduce((n, i) => (n && Array.isArray(n.cards) ? n.cards[i] : null), found));
    await save(conf);
  }

  async _moveCard(kid, dest, as) {
    const root = this._rootGrid();
    const [fromPath, toPath, at] = [this._pathFromRoot(), dest._pathFromRoot(), this._kids.indexOf(kid)];
    const where = dest._outerGrid() ? dest._config.title || "the group" : "the page";
    try {
      await this._dashEdit((page, down) => {
        const [from, to] = [down(fromPath), down(toPath)];
        if (!from || !to || !Array.isArray(to.cards) || !from.cards[at] || from.cards[at].type !== kid.cfg.type) throw new Error("card not found in the dashboard");
        let [card] = from.cards.splice(at, 1);
        // (its id is what its place is kept under: one of its own in the new group)
        const id = as != null ? as : ArrangeGridCard.freeId(card.id, to.cards.map((c) => c.id));
        if (card.id == null || String(card.id) !== id) card = { ...card, id };
        to.cards.push(card);
      });
      root._note(`${kid.name} moved to ${where}`, 4000);
      return true;
    } catch (err) {
      root._note(`Couldn't move it to ${where}: that takes an administrator and a dashboard edited in Home Assistant's UI. Move it in the card's editor instead.`, 9000);
      return false;
    }
  }

  // A new tile for an entity among this grid's cards, written into the
  // dashboard. (Any other card, or other options, are the editor's.)
  async _addTile(entity, as) {
    const root = this._rootGrid();
    const path = this._pathFromRoot();
    const where = this._outerGrid() ? this._config.title || "the group" : "the page";
    try {
      await this._dashEdit((page, down) => {
        const to = down(path);
        if (!to || !Array.isArray(to.cards)) throw new Error("card not found in the dashboard");
        const id = as != null ? as : ArrangeGridCard.freeId(ArrangeGridCard.slug(entity), to.cards.map((c) => c.id));
        to.cards.push({ id, type: "tile", entity });
      });
      root._note(`${entity} added to ${where}`, 4000);
      return true;
    } catch (err) {
      root._note("Couldn't add the card: that takes an administrator and a dashboard edited in Home Assistant's UI. Add it in the card's editor instead.", 9000);
      return false;
    }
  }

  // ------------------------------------------------- editing a card
  //
  // "Edit this card…" opens Home Assistant's own edit-card dialog (the
  // card's visual editor or YAML, with the preview) for one of this grid's
  // cards, and writes what it saves back into the dashboard at the card's
  // place. The dialog is asked for as the frontend asks for it: a
  // `show-dialog` event naming it, with the card's config and a
  // `saveCardConfig` to call. None of that is a public API.

  // The frontend's own way of loading the dialog (it is not loaded until a
  // card is first edited). The view answers `ll-edit-card` by asking for
  // the dialog with it: that request is caught here before it is shown, and
  // only the loader is kept. Null when it cannot be had.
  _dialogImport(conf) {
    if (customElements.get(EDIT_DIALOG)) return () => Promise.resolve();
    let path = null;
    ((conf && conf.views) || []).some((v, i) => {
      if (!v || typeof v !== "object") return false;
      if (Array.isArray(v.cards) && v.cards.length) path = [i, 0];
      else (Array.isArray(v.sections) ? v.sections : []).some((sec, j) => (sec && Array.isArray(sec.cards) && sec.cards.length ? !!(path = [i, j, 0]) : false));
      return !!path;
    });
    if (!path) return null;
    let load = null;
    const grab = (ev) => {
      const d = ev.detail || {};
      if (d.dialogTag !== EDIT_DIALOG) return;
      ev.stopPropagation();
      if (typeof ev.stopImmediatePropagation === "function") ev.stopImmediatePropagation();
      load = d.dialogImport;
    };
    window.addEventListener("show-dialog", grab, true);
    try {
      this.dispatchEvent(new CustomEvent("ll-edit-card", { bubbles: true, composed: true, detail: { path } }));
    } finally {
      window.removeEventListener("show-dialog", grab, true);
    }
    return typeof load === "function" ? load : null;
  }

  // Opens the editor for one of this grid's cards (a group among them is
  // edited with this card's own editor: its title, icon and cards).
  async _editCard(kid) {
    const root = this._rootGrid();
    const at = this._kids.indexOf(kid);
    const raw = at >= 0 ? this._config.cards[at] : null;
    if (!raw) return false;
    if (!this._mayMove()) return root._note("Only an administrator can edit the dashboard's cards.", 6000), false;
    const ll = this._lovelace();
    if (ll && ll.mode === "yaml") return root._note("This dashboard is kept in YAML: edit the card there.", 8000), false;
    const path = this._pathFromRoot();
    let conf = ll && ll.config;
    if (!conf) {
      try {
        const first = location.pathname.split("/")[1] || "";
        conf = await this._hass.callWS({ type: "lovelace/config", url_path: !first || first === "lovelace" ? null : first, force: false });
      } catch (err) {
        return root._note("This dashboard cannot be saved from here (it is kept in YAML, or Home Assistant didn't answer): edit the card in its file.", 9000), false;
      }
    }
    const load = this._dialogImport(conf);
    if (!load) return root._note("Home Assistant's card editor could not be opened from here. Edit the card in the grid card's own editor: Edit dashboard, the grid card, then Cards.", 10000), false;
    const saveCardConfig = async (next) => {
      if (!next || typeof next !== "object" || Array.isArray(next) || !next.type) throw new Error("A card needs a type.");
      // (while arranging: what was arranged so far is kept, and the Arrange goes on after the redraw)
      const lead = this._arranging ? this._arrLead || this : null;
      if (lead && lead._arrSession) {
        const session = lead._arrSession;
        session.gone = lead._goneAll();
        session.saved = true;
        lead._resumeSave(session);
        lead._arrExit("save", true);
      }
      try {
        await this._dashEdit((page, down) => {
          const node = down(path);
          const cur = node && Array.isArray(node.cards) ? node.cards[at] : null;
          if (!cur || cur.type !== raw.type || String(cur.id) !== String(raw.id)) throw new Error("card not found in the dashboard");
          // (its id is what its place is kept under: it stays as it was)
          const { id, ...rest } = next;
          node.cards[at] = raw.id == null ? rest : { ...rest, id: raw.id };
        });
      } catch (err) {
        if (lead) lead._resumeSave(null);
        throw new Error("The card could not be saved: the dashboard has changed, or it cannot be saved from here. Reload the page and try again.");
      }
    };
    // (while it is open, Esc and Ctrl+Z are the dialog's, not the Arrange's)
    ArrangeGridCard._dialog = true;
    const closed = (ev) => {
      if (ev.detail && ev.detail.dialog && ev.detail.dialog !== EDIT_DIALOG) return;
      ArrangeGridCard._dialog = false;
      window.removeEventListener("dialog-closed", closed);
    };
    window.addEventListener("dialog-closed", closed);
    this.dispatchEvent(new CustomEvent("show-dialog", { bubbles: true, composed: true, detail: { dialogTag: EDIT_DIALOG, dialogImport: load, dialogParams: { lovelaceConfig: conf, cardConfig: childConfig(raw), saveCardConfig } } }));
    return true;
  }

  static slug(entity) {
    return String(entity).split(".").slice(1).join(".").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "card";
  }

  // While arranging: as a group is added, so is a card for an entity.
  async _arrAddTile(target, entity) {
    const lead = this._arrLead || this;
    const session = lead._arrSession || { moves: [], snap: null };
    const id = ArrangeGridCard.freeId(ArrangeGridCard.slug(entity), target._config.cards.map((c) => c.id));
    session.moves.push({ add: target._pathFromRoot(), id });
    lead._arrCfgStep(session);
    session.gone = lead._goneAll();
    lead._resumeSave(session);
    lead._arrExit("save", true);
    const ok = await target._addTile(entity, id);
    if (!ok) {
      session.moves.pop();
      (session.undo || []).pop();
      lead._resumeSave(null);
    }
    return ok;
  }

  // The id a card moved among `ids` goes by: its own while that is free.
  static freeId(own, ids) {
    const taken = new Set(ids.filter((v) => v != null).map(String));
    const base = own == null ? "card" : String(own);
    let id = base;
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
    return id;
  }

  // While arranging: a card dropped on another group. Where it lands there
  // is written into that group's arrangement, everything arranged so far is
  // kept as Done would, then the dashboard is told which group the card is
  // in. That redraws the page; the Arrange goes on afterwards, and Cancel
  // still takes it all back.
  async _arrMoveTo(kid, dest, x, y) {
    const lead = this._arrLead || this;
    const session = lead._arrSession || { moves: [], snap: null };
    const at = this._kids.indexOf(kid);
    const raw = this._config.cards[at] || {};
    const id = ArrangeGridCard.freeId(raw.id, dest._config.cards.map((c) => c.id));
    if (dest._arranging && dest._arrMode === "grid" && dest._arrEdit) {
      const e = dest._arrEdit;
      const g = dest._arrG();
      const size = dest._cells(kid, e.grid.cols);
      const [w, h] = [Math.max(1, Math.min(size.w, e.grid.cols)), Math.max(1, size.h)];
      const cell = dest._cellAt(x, y);
      let to = { c: Math.max(0, Math.min(e.grid.cols - w, cell.c)), r: Math.max(0, cell.r) };
      // (taken: the next free place after it)
      if (Layout.hits(g, to.c, to.r, w, h).length) to = Layout.spot(g, w, h, true, to);
      e.tiles.push({ id, c: to.c, r: to.r, w, h });
      e.grid.rows = Math.min(MAX_ROWS, Math.max(e.grid.rows, to.r + h));
    } else if (dest._arranging && dest._arrListEdit) {
      const under = dest._kids.find((k) => {
        if (k.off || k.slot.hidden) return false;
        const r = k.slot.getBoundingClientRect();
        return r.width > 0 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
      });
      const list = dest._arrListEdit;
      const i = under ? list.indexOf(under.key) : -1;
      list.splice(i < 0 ? list.length : i, 0, id);
    }
    if (this._arrEdit) this._arrEdit.tiles = this._arrEdit.tiles.filter((t) => t.id !== kid.key);
    if (this._arrListEdit) this._arrListEdit.splice(0, this._arrListEdit.length, ...this._arrListEdit.filter((key) => key !== kid.key));
    session.moves.push({ from: this._pathFromRoot(), to: dest._pathFromRoot(), at, id, orig: raw.id == null ? null : raw.id });
    lead._arrCfgStep(session);
    session.gone = lead._goneAll();
    lead._resumeSave(session);
    lead._arrExit("save", true);
    const ok = await this._moveCard(kid, dest, id);
    if (!ok) {
      session.moves.pop();
      (session.undo || []).pop();
      lead._resumeSave(null);
    }
    return ok;
  }

  // While arranging: a new, empty group in `target` (this grid or a group
  // in it). Like a card changing groups, it is the dashboard that is
  // told: what was arranged so far is kept, the page is redrawn, the
  // Arrange goes on, and Cancel takes the group away again.
  async _arrAddGroup(target, title) {
    const lead = this._arrLead || this;
    const session = lead._arrSession || { moves: [], snap: null };
    const name = String(title || "").trim() || "New group";
    const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "group";
    const id = ArrangeGridCard.freeId(base, target._config.cards.map((c) => c.id));
    session.moves.push({ add: target._pathFromRoot(), id });
    lead._arrCfgStep(session);
    session.gone = lead._goneAll();
    lead._resumeSave(session);
    lead._arrExit("save", true);
    const ok = await target._addGroup(name, id);
    if (!ok) {
      session.moves.pop();
      (session.undo || []).pop();
      lead._resumeSave(null);
    }
    return ok;
  }

  // An Arrange that a move interrupted: {at, moves, snap}, for a short while.
  _resumeSave(session) {
    try {
      const key = RESUME_KEY + this._config.name;
      if (session) sessionStorage.setItem(key, JSON.stringify({ ...session, at: Date.now(), gone: session.gone || {} }));
      else sessionStorage.removeItem(key);
    } catch (err) {}
  }

  _resumePeek() {
    try {
      const s = JSON.parse(sessionStorage.getItem(RESUME_KEY + this._config.name) || "null");
      return s && Date.now() - s.at < 30000 && Array.isArray(s.moves) ? s : null;
    } catch (err) {
      return null;
    }
  }

  _resumeTake() {
    const s = this._resumePeek();
    this._resumeSave(null);
    return s ? { ...s, snap: s.snap || null, gone: s.gone || {} } : null;
  }

  // Cancel, after cards changed groups: the arrangements go back to what
  // they were when Arrange was opened, and the cards to their groups.
  async _arrRevert(session) {
    const snap = session.snap || {};
    for (const g of this._tree()) {
      const name = g._config.name;
      if (!(name in snap) || g._config.storage !== "user") continue;
      g._arr = Layout.valid(snap[name]);
      g._local(g._arr, false);
      g._layout();
    }
    const names = Object.keys(snap);
    const run = async () => {
      try {
        const res = await this._hass.callWS({ type: "frontend/get_user_data", key: USER_KEY });
        const all = res && res.value && typeof res.value === "object" ? res.value : {};
        const layouts = { ...(all.layouts || {}) };
        for (const name of names) {
          if (snap[name]) layouts[name] = snap[name];
          else delete layouts[name];
        }
        await this._hass.callWS({ type: "frontend/set_user_data", key: USER_KEY, value: { ...all, v: 1, layouts } });
      } catch (err) {}
    };
    ArrangeGridCard._saving = (ArrangeGridCard._saving || Promise.resolve()).then(run, run);
    await ArrangeGridCard._saving;
    if (!session.moves.length) return; // (every card is in its group already)
    try {
      await this._dashEdit((page, down) => {
        for (const m of [...session.moves].reverse()) ArrangeGridCard.unmove(down, m);
      });
      this._note("Cancelled: the groups and their cards are as they were", 4000);
    } catch (err) {
      this._note("Couldn't put the cards back in their groups: move them back with a card's \"Move to…\".", 9000);
    }
  }

  // Takes back one change made to the dashboard while arranging (`m`, of
  // the Arrange's journal): a card back in its group, or a card or group
  // that was added gone again.
  static unmove(down, m) {
    if (m.add) {
      // (a group made while arranging: gone again, unless it has cards after all)
      const into = down(m.add);
      const at = into && Array.isArray(into.cards) ? into.cards.findIndex((c) => String(c.id) === String(m.id)) : -1;
      if (at >= 0 && !(into.cards[at].cards || []).length) into.cards.splice(at, 1);
      return;
    }
    const [to, from] = [down(m.to), down(m.from)];
    const i = to && Array.isArray(to.cards) ? to.cards.findIndex((c) => String(c.id) === String(m.id)) : -1;
    if (i < 0 || !from || !Array.isArray(from.cards)) return;
    let [card] = to.cards.splice(i, 1);
    if (m.orig == null) {
      const { id, ...rest } = card;
      card = rest;
    } else card = { ...card, id: m.orig };
    from.cards.splice(Math.min(m.at, from.cards.length), 0, card);
  }

  // A new, empty group among this grid's cards, written into the dashboard.
  async _addGroup(title, as) {
    const root = this._rootGrid();
    const name = String(title || "").trim() || "New group";
    const path = this._pathFromRoot();
    try {
      await this._dashEdit((page, down) => {
        const to = down(path);
        if (!to || !Array.isArray(to.cards)) throw new Error("card not found in the dashboard");
        const taken = new Set(to.cards.map((c) => String(c.id)));
        const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "group";
        let id = as != null ? as : base;
        for (let n = 2; as == null && taken.has(id); n++) id = `${base}-${n}`;
        to.cards.push({ id, type: `custom:${TAG}`, title: name, cards: [] });
      });
      root._note(`Group "${name}" added. Fill it with a card's "Move to…", or by dragging cards onto it in Arrange.`, 7000);
      return true;
    } catch (err) {
      root._note("Couldn't add the group: that takes an administrator and a dashboard edited in Home Assistant's UI. Add it in the card's editor instead.", 9000);
      return false;
    }
  }

  // The group under a point that a card dragged from this grid would go
  // into: the innermost one, anywhere on the page. Null: none, or this one.
  _dropTarget(x, y, kid) {
    if (!this._mayMove() || kid.el.localName === TAG) return null;
    let best = null;
    const visit = (g) => {
      const r = g.getBoundingClientRect();
      if (!(r.width > 0 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom)) return;
      best = g;
      for (const k of g._kids || []) if (!k.off && !k.slot.hidden && k.el.localName === TAG && k.el._config) visit(k.el);
    };
    visit(this._rootGrid());
    return best && best !== this ? best : null;
  }

  // A group's title bar: in the list it folds the group shut.
  _foldSync() {
    if (!this._fold) return;
    const outer = this._outerGrid();
    const can = !!outer && !this._arranging && this._isList();
    const shut = can && outer._kidFolded(this);
    this._fold.hidden = !can;
    this._head.classList.toggle("can", can);
    this._head.classList.toggle("shut", shut);
    this._fold.title = shut ? "Show this group's cards" : "Hide this group's cards";
    this._fold.setAttribute("aria-label", `${this._config.title || "Group"}: ${this._fold.title.toLowerCase()}`);
    this._fold.setAttribute("aria-expanded", shut ? "false" : "true");
    this._foldIcon.setAttribute("icon", shut ? "mdi:chevron-down" : "mdi:chevron-up");
    this._grid.hidden = shut;
    this._badges.hidden = shut || !(this._badgeEls && this._badgeEls.length);
    if (shut) this._empty.hidden = true;
  }

  // The row of badges over the grid, as a sections view has: centred pills.
  // An entity id alone is an entity badge. Made anew only when they change.
  _syncBadges(helpers) {
    const list = this._config.badges.map((b) => (typeof b === "string" ? { type: "entity", entity: b } : { type: "entity", ...b }));
    const json = JSON.stringify(list);
    if (json === this._badgeJson) return;
    this._badgeJson = json;
    this._badgeEls = [];
    for (const cfg of list) {
      try {
        let el;
        if (typeof helpers.createBadgeElement === "function") el = helpers.createBadgeElement(cfg);
        else {
          el = document.createElement(`hui-${cfg.type}-badge`);
          el.setConfig(cfg);
        }
        if (this._hass) el.hass = this._hass;
        this._badgeEls.push(el);
      } catch (err) {
        console.warn("arrange-grid-card: a badge could not be made", cfg, err);
      }
    }
    this._badges.replaceChildren(...this._badgeEls);
    this._badges.hidden = !this._badgeEls.length;
  }

  // Makes the children fit the config. A child whose config is unchanged
  // keeps its element (and so its stream, its state); one whose config
  // changed is given the new one, and only made anew if it will not take it.
  async _sync() {
    const run = (this._syncRun = (this._syncRun || 0) + 1);
    if (!this._helpers) this._helpers = Promise.resolve(window.loadCardHelpers());
    let helpers;
    try {
      helpers = await this._helpers;
    } catch (err) {
      this._helpers = null;
      console.error("arrange-grid-card: Home Assistant's card helpers did not load", err);
      return;
    }
    if (run !== this._syncRun) return;
    this._create = (cfg) => helpers.createCardElement(cfg);
    this._syncBadges(helpers);
    const pool = [...this._kids];
    const take = (test) => {
      const at = pool.findIndex(test);
      return at < 0 ? null : pool.splice(at, 1)[0];
    };
    const wanted = this._config.cards.map((card, i) => {
      const cfg = this._groupConfig(childConfig(card), this._keys[i]);
      return { key: this._keys[i], cfg, json: JSON.stringify(cfg), name: cardName(card) };
    });
    const next = wanted.map((w) => take((k) => k.key === w.key && k.json === w.json));
    // moved in the config, with no id to know it by (a card that has one is found by it below)
    const named = new Set(wanted.map((w) => w.key).filter((key) => key[0] !== "#"));
    wanted.forEach((w, i) => {
      if (!next[i]) next[i] = take((k) => k.json === w.json && !named.has(k.key));
    });
    wanted.forEach((w, i) => {
      let kid = next[i] || take((k) => k.key === w.key && k.cfg.type === w.cfg.type);
      if (kid && kid.json !== w.json) {
        try {
          kid.el.setConfig(w.cfg);
        } catch (err) {
          this._swap(kid, w.cfg);
        }
      }
      if (!kid) {
        kid = { slot: make("div", "slot") };
        this._grid.appendChild(kid.slot);
        this._swap(kid, w.cfg);
      }
      Object.assign(kid, w);
      this._measure(kid);
      next[i] = kid;
    });
    for (const gone of pool) gone.slot.remove();
    this._kids = next;
    // Groups: a heading card and the cards after it, up to the next heading.
    let head = null;
    for (const kid of next) {
      kid.group = null;
      kid.members = null;
      if (!this._config.groups) continue;
      if (kid.cfg.type === "heading") {
        head = kid;
        kid.members = [];
      } else if (head) {
        kid.group = head.key;
        head.members.push(kid);
      }
    }
    this._layout();
    // Arrange goes on: the page around this group is being arranged, or a
    // card was just moved between groups (which redraws the page)
    if (!this._arranging) {
      const outer = this._outerGrid();
      if (outer && outer._arranging) this._arrEnter(outer._arrLead || outer);
      else if (this._resumePeek()) this._arrEnter();
    }
  }

  // A new element for the child (its first, or after `ll-rebuild`).
  _swap(kid, cfg) {
    const el = this._create(cfg);
    el.layout = "grid"; // as in a sections view: fill the cells you are given
    if (this._hass) el.hass = this._hass;
    el.addEventListener("ll-rebuild", (ev) => {
      ev.stopPropagation();
      this._swap(kid, kid.cfg);
      this._measure(kid);
      this._layout();
    });
    if (kid.el && kid.el.parentNode === kid.slot) kid.el.replaceWith(el);
    else if (!kid.off) kid.slot.prepend(el);
    kid.el = el;
    kid.waited = false;
  }

  // The size a child asks for: `grid_options` in its config, else what its
  // card says (getGridOptions), else the full width and its card size.
  // {cols: of 12, rows, auto: the rows are a guess, the content decides}
  _measure(kid) {
    const el = kid.el;
    const own = kid.cfg.grid_options || {};
    let said = {};
    try {
      if (typeof el.getGridOptions === "function") said = el.getGridOptions() || {};
    } catch (err) {}
    const cols = own.columns != null ? own.columns : said.columns;
    const rows = own.rows != null ? own.rows : said.rows;
    const before = JSON.stringify(kid.nat);
    kid.nat = {
      cols: Number.isFinite(cols) ? Math.max(1, Math.min(SECTION_COLS, Math.round(cols))) : SECTION_COLS,
      rows: Number.isFinite(rows) ? Math.max(1, Math.round(rows)) : (kid.nat && kid.nat.auto && kid.nat.rows) || 1,
      auto: !Number.isFinite(rows),
    };
    if (kid.nat.auto && typeof el.getCardSize === "function") {
      Promise.resolve()
        .then(() => el.getCardSize())
        .then((size) => {
          if (kid.el !== el || !kid.nat.auto || !Number.isFinite(size)) return;
          const c = this._config;
          const guess = Math.max(1, Math.round((size * 50) / (c.row_height + c.gap)));
          if (guess === kid.nat.rows) return;
          kid.nat.rows = guess;
          this._layout();
        })
        .catch(() => {});
    }
    // a card whose code is still on its way answers once it is there
    if (!kid.waited && el.localName && el.localName.includes("-") && !customElements.get(el.localName)) {
      kid.waited = true;
      customElements.whenDefined(el.localName).then(() => {
        if (kid.el !== el) return;
        this._measure(kid);
        this._layout();
      });
    }
    return before !== JSON.stringify(kid.nat);
  }

  // ------------------------------------------------- which layout counts
  //
  // With `storage: user` the user's own record counts, piece by piece (the
  // wide grid, the list's order, what is hidden), and `default_layout` of the
  // config stands in for each piece the user has not made. With
  // `storage: config` there is only the config's.

  _own() {
    if (this._config.storage === "config") return this._cfgOver !== undefined ? this._cfgOver : this._config.default_layout;
    return this._arr || null;
  }

  _base() {
    return this._config.storage === "config" ? null : this._config.default_layout;
  }

  _wideSrc() {
    if (this._arrEdit) return this._arrEdit;
    const [a, b] = [this._own(), this._base()];
    return a && a.grid ? a : b && b.grid ? b : null;
  }

  _listSrc() {
    if (this._arrListEdit) return this._arrListEdit;
    const [a, b] = [this._own(), this._base()];
    return (a && a.list) || (b && b.list) || [];
  }

  _hiddenKept() {
    const [a, b] = [this._own(), this._base()];
    return (a && a.hidden) || (b && b.hidden) || [];
  }

  _hidden() {
    const hidden = this._hiddenKept();
    // (with what was dropped on the bin while arranging, until Done or Cancel)
    return this._arrGone && this._arrGone.length ? [...new Set([...hidden, ...this._arrGone])] : hidden;
  }

  _isList() {
    if (this._arranging) return this._arrMode === "list";
    const outer = this._outerGrid();
    if (outer) return outer._isList();
    return this.clientWidth > 0 && this.clientWidth < this._config.min_width;
  }

  // A child's own size in cells of a grid `cols` wide. A sections view's
  // section (12 of its columns) is taken as a quarter of the page.
  _cells(kid, cols) {
    // (a group is a section itself)
    const section = this._config.nested ? cols : Math.max(1, Math.round(cols / 4));
    return { w: Math.max(1, Math.min(cols, Math.round((kid.nat.cols / SECTION_COLS) * section))), h: kid.nat.rows };
  }

  _wideGrid() {
    const src = this._wideSrc();
    const hidden = this._hidden();
    const cols = src ? Math.max(1, Math.min(MAX_COLS, src.grid.cols | 0)) : this._config.columns;
    const items = this._kids.filter((k) => !hidden.includes(k.key)).map((k) => ({ id: k.key, ...this._cells(k, cols) }));
    return src ? Layout.free(src, items) : Layout.flow(items, cols);
  }

  // Where everything goes (nothing is drawn here):
  // {list: false, cols, rows, places: [{id, c, r, w, h}]} or {list: true, order: [id]}.
  _plan() {
    const g = this._wideGrid();
    if (this._isList()) return { list: true, order: Layout.listOrder(this._listSrc(), g.tiles) };
    return { list: false, cols: g.cols, rows: g.rows, places: g.tiles };
  }

  _layout() {
    if (!this._grid || !this._kids || !this._config) return;
    const plan = this._plan();
    const grid = this._grid;
    const hidden = this._hidden();
    const folded = this._folded();
    this._met = null;
    grid.classList.toggle("list", plan.list);
    for (const kid of this._kids) {
      const off = hidden.includes(kid.key);
      if (off !== !!kid.off) {
        kid.off = off;
        // off the page: the card is taken out, so it plays and asks nothing
        if (off) kid.el.remove();
        else {
          kid.slot.prepend(kid.el);
          if (this._hass) kid.el.hass = this._hass;
        }
      }
      kid.slot.hidden = off || (plan.list && !!kid.group && folded.includes(kid.group));
      this._foldButton(kid, plan.list, folded.includes(kid.key));
    }
    if (plan.list) {
      grid.style.gridTemplateColumns = `repeat(${SECTION_COLS}, minmax(0, 1fr))`;
      grid.style.gridTemplateRows = "";
      plan.order.forEach((id, at) => {
        const kid = this._kids.find((k) => k.key === id);
        kid.slot.style.order = String(at);
        kid.slot.style.gridColumn = `span ${kid.nat.cols}`;
        kid.slot.style.gridRow = kid.nat.auto ? "" : `span ${kid.nat.rows}`;
      });
      this._rows = plan.order.length;
    } else {
      grid.style.gridTemplateColumns = `repeat(${plan.cols}, minmax(0, 1fr))`;
      grid.style.gridTemplateRows = `repeat(${plan.rows}, minmax(${this._config.row_height}px, auto))`;
      for (const { id, c, r, w, h } of plan.places) {
        const kid = this._kids.find((k) => k.key === id);
        kid.slot.style.order = "";
        kid.slot.style.gridColumn = `${c + 1} / span ${w}`;
        kid.slot.style.gridRow = `${r + 1} / span ${h}`;
        if (kid.dim) kid.dim.textContent = `${w} × ${h}`;
      }
      this._rows = plan.rows;
    }
    if (this._arranging && !plan.list) {
      this._arrCells(plan.cols, plan.rows);
      // under a group only the group's own grid is drawn, not this one's as well
      const boxes = plan.places.filter((t) => {
        const kid = this._kids.find((k) => k.key === t.id);
        return kid && kid.el.localName === TAG;
      });
      (this._arrCellEls || []).forEach((cell, k) => {
        const [c, r] = [k % plan.cols, Math.floor(k / plan.cols)];
        cell.classList.toggle("under", boxes.some((t) => c >= t.c && c < t.c + t.w && r >= t.r && r < t.r + t.h));
      });
    }
    const none = !this._kids.length;
    const allOff = !none && this._kids.every((k) => k.off);
    this._empty.textContent = none ? (this._config.nested ? "An empty group. In Arrange, drop a card here." : "No cards yet. Add some in the card's editor.") : "Every card is hidden. Use the menu to show one.";
    this._empty.hidden = !(none || allOff);
    // groups: this one's title bar, the ones among its cards, the one it is in
    this._foldSync();
    const flipped = this._wasList !== plan.list;
    this._wasList = plan.list;
    for (const kid of this._kids) {
      if (kid.el.localName !== TAG || typeof kid.el._foldSync !== "function") continue;
      if (flipped) kid.el._layout();
      else kid.el._foldSync();
    }
    const outer = this._outerGrid();
    const size = `${plan.list}:${this._rows}`;
    if (outer && size !== this._sizeTold) {
      this._sizeTold = size;
      outer._kidGrew(this);
    }
  }

  // --------------------------------------------------- folding groups
  //
  // In the list a group can be folded shut: its heading stays, its cards
  // are not shown. Which groups are shut is the user's own (with
  // `storage: config`, this browser's: it is not a thing to write into the
  // dashboard for everyone).

  _folded() {
    if (this._config.storage === "config") {
      if (!this._foldLocal) {
        try {
          this._foldLocal = JSON.parse(localStorage.getItem(FOLD_KEY + this._config.name) || "[]");
        } catch (err) {}
        if (!Array.isArray(this._foldLocal)) this._foldLocal = [];
      }
      return this._foldLocal;
    }
    const [a, b] = [this._own(), this._base()];
    return (a && a.folded) || (b && b.folded) || [];
  }

  _setFolded(key, shut) {
    const set = new Set(this._folded());
    if (shut) set.add(key);
    else set.delete(key);
    if (this._config.storage === "config") {
      this._foldLocal = [...set];
      try {
        localStorage.setItem(FOLD_KEY + this._config.name, JSON.stringify(this._foldLocal));
      } catch (err) {}
      return this._layout();
    }
    this._change((a) => {
      a.folded = [...set];
    });
  }

  // The button on a group's heading that folds it (in the list only).
  _foldButton(kid, list, shut) {
    const wanted = list && !kid.off && !!(kid.members && kid.members.length);
    if (!wanted) {
      if (kid.fold) kid.fold.hidden = true;
      return;
    }
    if (!kid.fold) {
      kid.fold = make("button", "fold");
      kid.foldIcon = icon("mdi:chevron-up");
      kid.fold.appendChild(kid.foldIcon);
      kid.fold.addEventListener("click", (ev) => {
        ev.stopPropagation();
        this._setFolded(kid.key, !this._folded().includes(kid.key));
      });
      kid.slot.appendChild(kid.fold);
    }
    kid.fold.hidden = false;
    kid.fold.title = shut ? "Show this group's cards" : "Hide this group's cards";
    kid.fold.setAttribute("aria-label", `${kid.name}: ${kid.fold.title.toLowerCase()}`);
    kid.fold.setAttribute("aria-expanded", shut ? "false" : "true");
    kid.foldIcon.setAttribute("icon", shut ? "mdi:chevron-down" : "mdi:chevron-up");
  }

  // ---------------------------------------------------------- storage
  //
  // The user's record: this browser's copy at once, the one Home Assistant
  // keeps for the user when it answers (that one counts, unless this browser
  // has a change Home Assistant never took).

  _load() {
    const c = this._config;
    if (!c || !this._hass || c.storage !== "user" || this._asked === c.name) return;
    const name = (this._asked = c.name);
    let local = null;
    try {
      local = JSON.parse(localStorage.getItem(LOCAL_KEY + name) || "null");
    } catch (err) {}
    this._arr = local && local.cleared ? null : Layout.valid(local);
    const unsent = !!(local && local.unsent);
    this._layout();
    Promise.resolve()
      .then(() => this._hass.callWS({ type: "frontend/get_user_data", key: USER_KEY }))
      .then(
        (res) => {
          if (this._asked !== name) return;
          const all = res && res.value && typeof res.value === "object" ? res.value : {};
          this._arrAll = all;
          if (unsent) return this._store(this._arr, true); // hand it over now
          const mine = Layout.valid(all.layouts && all.layouts[name]);
          if (JSON.stringify(mine) === JSON.stringify(this._arr)) return;
          this._local(mine, false);
          if (this._arranging) return; // (not under the user's hands)
          this._arr = mine;
          this._layout();
        },
        () => {} // this browser's copy it is
      );
  }

  _local(arr, unsent) {
    try {
      const key = LOCAL_KEY + this._config.name;
      if (arr || unsent) localStorage.setItem(key, JSON.stringify({ ...(arr || { tiles: [] }), unsent: !!unsent, cleared: !arr }));
      else localStorage.removeItem(key);
    } catch (err) {}
  }

  // One save at a time, page-wide: every card keeps its arrangement in the
  // same place, and a page with groups saves several at once.
  _store(arr, quiet) {
    const name = this._config.name;
    this._local(arr, true); // until Home Assistant has it
    const run = () => this._storeNow(arr, quiet, name);
    ArrangeGridCard._saving = (ArrangeGridCard._saving || Promise.resolve()).then(run, run);
    return ArrangeGridCard._saving;
  }

  async _storeNow(arr, quiet, name) {
    try {
      // read again first: other cards (the groups of one page) keep theirs in the same place
      const res = await this._hass.callWS({ type: "frontend/get_user_data", key: USER_KEY });
      this._arrAll = res && res.value && typeof res.value === "object" ? res.value : {};
      const layouts = { ...(this._arrAll.layouts || {}) };
      if (arr) layouts[name] = arr;
      else delete layouts[name];
      const value = { ...this._arrAll, v: 1, layouts };
      await this._hass.callWS({ type: "frontend/set_user_data", key: USER_KEY, value });
      this._arrAll = value;
      if (this._config.name === name) this._local(arr, false);
      if (!quiet) this._note(arr ? "Arrangement saved" : "Back to the page's own arrangement", 3000);
    } catch (err) {
      if (!quiet) this._note("Kept in this browser only: Home Assistant didn't take it. It is sent again next time.", 8000);
    }
  }

  // `storage: config`: the arrangement goes into this card's own config in
  // the dashboard (`default_layout`), for everyone. That takes a dashboard
  // kept by Home Assistant's UI and a user who may edit it; when it cannot
  // be done, the layout is shown to copy into the config by hand.
  async _storeConfig(arr, act) {
    const strip = (c) => {
      const { default_layout, ...rest } = c;
      return JSON.stringify(rest);
    };
    try {
      const first = location.pathname.split("/")[1] || "";
      const url_path = !first || first === "lovelace" ? null : first;
      const conf = await this._hass.callWS({ type: "lovelace/config", url_path, force: false });
      const mine = strip(this._raw);
      let found = null;
      const walk = (node) => {
        if (found || !node || typeof node !== "object") return;
        if (!Array.isArray(node) && node.type === `custom:${TAG}` && Array.isArray(node.cards) && strip(node) === mine) {
          found = node;
          return;
        }
        for (const v of Array.isArray(node) ? node : Object.values(node)) walk(v);
      };
      walk(conf && conf.views);
      if (!found) throw new Error("card not found in the dashboard");
      if (arr) found.default_layout = arr;
      else delete found.default_layout;
      await this._hass.callWS({ type: "lovelace/config/save", url_path, config: conf });
      this._rootGrid()._note(arr ? "Arrangement saved to the dashboard" : "Arrangement removed from the dashboard, for everyone", act ? 20000 : 3000, act);
    } catch (err) {
      this._showCopy(arr);
    }
  }

  // The layout as text, to paste under `default_layout:` (JSON is YAML too).
  _showCopy(arr) {
    clearTimeout(this._noteTimer);
    const text = make("span", "", arr ? "Couldn't save to the dashboard. Paste this under default_layout: in the card's config:" : "Couldn't save to the dashboard. Remove default_layout: from the card's config.");
    const close = make("button", "", "Close");
    close.onclick = () => {
      this._bar.hidden = true;
    };
    const parts = [text, close];
    if (arr) {
      const area = make("textarea");
      area.readOnly = true;
      area.value = JSON.stringify(arr);
      parts.push(area);
    }
    this._bar.replaceChildren(...parts);
    this._bar.hidden = false;
  }

  // Keeps `next` (null: nothing of the user's own) as the record that counts.
  // `act`: something to offer with what is said about it ({label, fn}).
  _commit(next, quiet, act) {
    if (this._config.storage === "config") {
      this._cfgOver = next;
      this._storeConfig(next, act);
    } else {
      this._arr = next;
      this._store(next, quiet);
    }
    this._layout();
  }

  // Changes the record that counts and shows the result.
  _change(change) {
    const a = { tiles: [], ...(this._own() || {}) };
    change(a);
    const base = this._base();
    // (an empty list of hidden cards still says something over a default that hides some)
    if (a.hidden && !a.hidden.length && !(base && base.hidden && base.hidden.length)) delete a.hidden;
    if (a.folded && !a.folded.length && !(base && base.folded && base.folded.length)) delete a.folded;
    this._commit(a.grid || a.list || a.hidden || a.folded ? a : null, true);
  }

  // Hides or shows one card, or several at once (an array of keys).
  _setHidden(key, off) {
    this._change((a) => {
      const set = new Set(this._hidden());
      for (const k of [].concat(key)) {
        if (off) set.add(k);
        else set.delete(k);
      }
      a.hidden = [...set];
    });
  }

  // The keys of a card's whole group (its heading and every card under it),
  // or null for a card that is in none.
  _groupKeys(kid) {
    const head = kid.members ? kid : this._kids.find((k) => k.key === kid.group);
    return head && head.members && head.members.length ? [head.key, ...head.members.map((m) => m.key)] : null;
  }

  _canArrange() {
    if (this._config.storage !== "config") return true;
    const user = this._hass && this._hass.user;
    return !!(user && user.is_admin);
  }

  // Something said in the bar for a while; `act`: with a button ({label, fn}).
  _note(text, ms, act) {
    if (!this._bar || this._arranging) return;
    clearTimeout(this._noteTimer);
    const parts = [make("span", "", text)];
    if (act) {
      const b = make("button", "", act.label);
      b.onclick = () => {
        clearTimeout(this._noteTimer);
        this._bar.hidden = true;
        act.fn();
      };
      parts.push(b);
    }
    this._bar.replaceChildren(...parts);
    this._bar.hidden = false;
    this._noteTimer = setTimeout(() => {
      if (!this._arranging) this._bar.hidden = true;
    }, ms);
  }

  // -------------------------------------------- previous arrangements
  //
  // Before an arrangement is reset, restored, or changed by an Arrange, what
  // it was is kept: the last few for each page (PREV_KEEP), with the user's
  // own data in Home Assistant, so that it can be brought back after a
  // reload and from another device. This browser keeps a copy as well, for
  // when Home Assistant does not take it. One of them:
  //   {at: ms, why: "reset" | "arrange" | "restore",
  //    layouts: {name: record | null}, defaults: {name: record | null}}
  // `layouts`: the user's own, by layout name (the page's and its groups');
  // `defaults`: those kept in the dashboard for everyone (`storage: config`).

  // What `grids` are arranged as now. `live`: while arranging, as Done
  // would keep what is on screen.
  _prevSnap(grids, live) {
    const snap = { layouts: {}, defaults: {} };
    for (const g of grids) {
      const touched = live && g._arranging && ((g._arrGone && g._arrGone.length) || JSON.stringify([g._arrEdit, g._arrListEdit]) !== g._arrStart);
      const rec = touched ? g._arrNext("save", null) : g._own();
      (g._config.storage === "config" ? snap.defaults : snap.layouts)[g._config.name] = rec || null;
    }
    return snap;
  }

  _prevLocal() {
    try {
      const list = JSON.parse(localStorage.getItem(PREV_KEY + this._rootGrid()._config.name) || "[]");
      return Array.isArray(list) ? list.filter(ArrangeGridCard.prevOk) : [];
    } catch (err) {
      return [];
    }
  }

  static prevOk(e) {
    return !!e && typeof e === "object" && typeof e.at === "number" && !!e.layouts && typeof e.layouts === "object";
  }

  // Keeps `snap` as the newest previous arrangement of the page. Null when
  // there is nothing in it to lose.
  _prevKeep(why, snap) {
    const [layouts, defaults] = [snap.layouts || {}, snap.defaults || {}];
    if (![...Object.values(layouts), ...Object.values(defaults)].some(Boolean)) return null;
    const at = (ArrangeGridCard._prevAt = Math.max(Date.now(), (ArrangeGridCard._prevAt || 0) + 1));
    const entry = { at, why, layouts };
    if (Object.keys(defaults).length) entry.defaults = defaults;
    const root = this._rootGrid();
    const page = root._config.name;
    try {
      localStorage.setItem(PREV_KEY + page, JSON.stringify([entry, ...root._prevLocal()].slice(0, PREV_KEEP)));
    } catch (err) {}
    const run = async () => {
      try {
        const res = await root._hass.callWS({ type: "frontend/get_user_data", key: USER_KEY });
        const all = res && res.value && typeof res.value === "object" ? res.value : {};
        const previous = { ...(all.previous && typeof all.previous === "object" ? all.previous : {}) };
        const list = Array.isArray(previous[page]) ? previous[page].filter(ArrangeGridCard.prevOk) : [];
        previous[page] = [entry, ...list.filter((e) => e.at !== at)].slice(0, PREV_KEEP);
        await root._hass.callWS({ type: "frontend/set_user_data", key: USER_KEY, value: { ...all, v: 1, previous } });
      } catch (err) {}
    };
    ArrangeGridCard._saving = (ArrangeGridCard._saving || Promise.resolve()).then(run, run);
    return entry;
  }

  // The page's previous arrangements, the newest first: Home Assistant's,
  // and this browser's where Home Assistant has not got them.
  async _prevList() {
    const root = this._rootGrid();
    let server = [];
    try {
      await (ArrangeGridCard._saving || Promise.resolve());
      const res = await root._hass.callWS({ type: "frontend/get_user_data", key: USER_KEY });
      const list = res && res.value && res.value.previous && res.value.previous[root._config.name];
      if (Array.isArray(list)) server = list.filter(ArrangeGridCard.prevOk);
    } catch (err) {}
    const local = root._prevLocal().filter((e) => !server.some((s) => s.at === e.at));
    return [...server, ...local].sort((a, b) => b.at - a.at).slice(0, PREV_KEEP);
  }

  static prevLabel(e) {
    const why = { reset: "Before the reset", arrange: "Before arranging", restore: "Before restoring" }[e.why] || "Earlier";
    let when = "";
    try {
      when = new Date(e.at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
    } catch (err) {}
    const n = Object.keys(e.layouts || {}).length + Object.keys(e.defaults || {}).length;
    return `${why}${when ? ` · ${when}` : ""}${n > 1 ? ` · ${n} grids` : ""}`;
  }

  // Brings a previous arrangement back, for every grid of the page it was
  // kept for that is still there. What is replaced is kept in its turn.
  _prevRestore(entry) {
    const root = this._rootGrid();
    if (root._tree().some((g) => g._arranging)) return;
    const of = (g) => (g._config.storage === "config" ? entry.defaults : entry.layouts) || {};
    const grids = root._tree().filter((g) => g._config.name in of(g) && g._canArrange());
    if (!grids.length) return root._note("None of the grids that arrangement was for are on the page any more.", 6000);
    const back = root._prevKeep("restore", root._prevSnap(grids));
    const act = back ? { label: "Undo", fn: () => root._prevRestore(back) } : null;
    for (const g of grids) g._commit(Layout.valid(of(g)[g._config.name]), true, act);
    root._note("The previous arrangement is back.", 20000, act);
  }

  // Forgets the arrangement of `grids` (this one's, or its groups' too),
  // keeping what it was.
  _resetNow(grids) {
    const root = this._rootGrid();
    grids = grids.filter((g) => g._own() && g._canArrange());
    if (!grids.length) return;
    const entry = root._prevKeep("reset", root._prevSnap(grids));
    const act = root._resetAct(entry);
    for (const g of grids) g._commit(null, true, act);
    root._note("The arrangement is reset.", 20000, act);
  }

  _resetAct(entry) {
    return entry ? { label: "Undo reset", fn: () => this._prevRestore(entry) } : null;
  }

  // What a reset loses, and for whom, in words.
  _resetWords(grids, part) {
    const groups = grids.length - 1;
    const config = grids.filter((g) => g._config.storage === "config").length;
    const where = `${grids[0]._outerGrid() ? "this group" : "the page"}${groups > 0 ? ` and ${groups === 1 ? "the group" : `the ${groups} groups`} in it` : ""}`;
    const what = part === "grid" ? "where every card is on the wide grid, and its size" : part === "list" ? "the order of the list" : "places, sizes, the list's order, what is hidden and what is folded";
    const whose = config === grids.length
      ? "This is the arrangement kept in the dashboard: it is removed for everyone."
      : config
        ? "Part of this is kept in the dashboard and is removed for everyone; the rest is your own, and other people keep theirs."
        : "Only your own arrangement is forgotten: other people keep theirs, and the cards themselves stay.";
    return `This resets ${where}: ${what} go${part === "list" ? "es" : ""} back to the default. ${whose}`;
  }

  // ------------------------------------------------------------- menu
  //
  // Right-click anywhere on the page, a long press on an empty part of it,
  // or the button under the grid. It stays on screen; a click elsewhere or
  // Esc closes it, the arrow keys walk it.

  _menuClose(refocus) {
    const m = this._menu;
    if (!m) return;
    this._menu = null;
    m.back.remove();
    m.menu.remove();
    window.removeEventListener("keydown", m.key, true);
    if (refocus && m.opener && m.opener.focus) m.opener.focus();
  }

  _menuOpen(x, y, fill, opener) {
    this._menuClose();
    this._menuAt = Date.now();
    const back = make("div", "menu-back");
    const menu = make("div", "menu");
    menu.setAttribute("role", "menu");
    const close = () => this._menuClose();
    back.addEventListener("pointerdown", close);
    back.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      close();
    });
    menu.addEventListener("contextmenu", (ev) => ev.preventDefault());
    const items = () => [...menu.children].filter((el) => el.localName === "button" && !el.disabled);
    const key = (ev) => {
      if (ev.key === "Escape") {
        ev.stopPropagation();
        ev.preventDefault();
        return this._menuClose(true);
      }
      const step = { ArrowDown: 1, ArrowUp: -1 }[ev.key];
      if (!step && ev.key !== "Home" && ev.key !== "End") return;
      const list = items();
      if (!list.length) return;
      ev.preventDefault();
      const at = list.indexOf(this.shadowRoot.activeElement);
      const to = ev.key === "Home" ? 0 : ev.key === "End" ? list.length - 1 : (at + step + list.length) % list.length;
      list[at < 0 && step < 0 ? list.length - 1 : to].focus();
    };
    window.addEventListener("keydown", key, true);
    this.shadowRoot.append(back, menu);
    this._menu = { back, menu, key, opener };
    const fit = () => {
      const mw = menu.offsetWidth || 220;
      const mh = menu.offsetHeight || 200;
      menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - mw - 8))}px`;
      menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - mh - 8))}px`;
    };
    const kit = {
      // an item: `fn` runs and the menu closes (unless `stay`)
      item: (label, fn, { disabled, stay } = {}) => {
        const b = make("button", "", label);
        b.setAttribute("role", "menuitem");
        b.disabled = !!disabled;
        b.onclick = () => {
          if (!stay) close();
          fn();
        };
        return b;
      },
      head: (title, sub) => {
        const el = make("span", "head", title);
        if (sub) el.appendChild(make("small", "", sub));
        return el;
      },
      hr: () => document.createElement("hr"),
      note: (text) => make("span", "note", text),
      // another set of items in the same menu
      show: (again) => {
        menu.replaceChildren(...again(kit));
        fit();
        const first = items()[0];
        if (first) first.focus();
      },
    };
    kit.show(fill);
  }

  // A title to type, then `go(title)`: the menu's way of making a group.
  _groupField(kit, head, go) {
    const field = document.createElement("input");
    field.type = "text";
    field.placeholder = "Title";
    field.setAttribute("aria-label", "The new group's title");
    const done = () => {
      this._menuClose();
      go(field.value);
    };
    field.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter") return;
      ev.preventDefault();
      done();
    });
    setTimeout(() => field.focus(), 0);
    return [kit.head(head), field, kit.item("Add", done, { stay: true })];
  }

  // An entity to find by typing, then `go(entity_id)`: the menu's way of
  // adding a card. The matches are items of the menu, under the field.
  _entityField(kit, head, go) {
    const field = document.createElement("input");
    field.type = "text";
    field.placeholder = "Search entities";
    field.setAttribute("aria-label", "Search entities by name or id");
    const none = make("span", "note", "Type a name or an entity id.");
    let shown = [];
    const find = () => {
      const words = String(field.value || "").toLowerCase().split(/\s+/).filter(Boolean);
      if (!words.length) return [];
      const states = (this._hass && this._hass.states) || {};
      const hits = [];
      for (const id of Object.keys(states)) {
        const name = String((states[id].attributes && states[id].attributes.friendly_name) || "");
        const hay = `${name} ${id}`.toLowerCase();
        if (words.every((w) => hay.includes(w))) hits.push({ id, name, first: name.toLowerCase().startsWith(words[0]) || id.split(".")[1].startsWith(words[0]) });
      }
      hits.sort((a, b) => b.first - a.first || (a.name || a.id).localeCompare(b.name || b.id));
      return hits.slice(0, 8);
    };
    const draw = () => {
      const menu = this._menu && this._menu.menu;
      if (!menu) return;
      for (const b of shown) b.remove();
      const hits = find();
      shown = hits.map((h) =>
        kit.item(h.name ? `${h.name}  ·  ${h.id}` : h.id, () => go(h.id))
      );
      none.textContent = hits.length ? "" : String(field.value || "").trim() ? "No entity matches." : "Type a name or an entity id.";
      none.hidden = !!hits.length;
      menu.append(...shown);
    };
    field.addEventListener("input", draw);
    field.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter" || !shown.length) return;
      ev.preventDefault();
      shown[0].onclick();
    });
    setTimeout(() => field.focus(), 0);
    return [kit.head(head), field, none];
  }

  // The menu for one card (`kid`), or for the page (null), at a point on screen.
  _context(x, y, kid, opener) {
    if (this._arranging || !this._kids) return;
    const off = this._kids.filter((k) => k.off);
    const on = this._kids.filter((k) => !k.off);
    const may = this._canArrange();
    const nest = this._outerGrid() && this._outerGrid()._kidOf(this) ? this._outerGrid() : null;
    const pick = (title, list, fn) => (kit) => [kit.head(title), ...list.map((k) => kit.item(k.name, () => fn(k)))];
    const group = kid && this._groupKeys(kid);
    // (a hidden heading comes back with the cards under it)
    const back = (k) => (k.members && this._groupKeys(k)) || k.key;
    // (`src`: the grid the card is in now)
    const places = (src, k) => (kit) => [kit.head(`Move ${k.name} to`), ...src._moveTargets(k).map((t) => kit.item(t.label, () => src._moveCard(k, t.grid)))];
    const newGroup = (kit) => this._groupField(kit, nest ? `New group in ${this._config.title || "this group"}` : "New group on the page", (title) => this._addGroup(title));
    const moves = this._mayMove() && this._rootGrid()._kids.some((k) => k.el.localName === TAG);
    // Reset asks first, and says what goes; what it was can be brought back
    const tree = this._tree();
    const resetAsk = (kit) => [
      kit.head("Reset layout?"),
      kit.note(`${this._resetWords(tree)} It can be brought back afterwards with "Restore a previous arrangement…" in this menu.`),
      kit.item("Keep it as it is", () => {}),
      kit.item(tree.length > 1 ? `Reset ${nest ? "this group and its groups" : "the whole page"}` : "Reset", () => this._resetNow(tree), { disabled: !tree.some((g) => g._own()) }),
      ...(tree.length > 1 ? [kit.item(`Reset only ${nest ? "this group's own grid" : "the page's own grid"}, not the groups in it`, () => this._resetNow([this]), { disabled: !this._own() })] : []),
    ];
    const restore = (kit) => {
      const menu = this._menu;
      const wait = [kit.head("Restore a previous arrangement"), kit.note("Looking…")];
      this._prevList().then((list) => {
        if (this._menu !== menu) return;
        kit.show((k) => [
          k.head("Restore a previous arrangement"),
          k.note(list.length ? `The last ${PREV_KEEP} are kept, with your own data in Home Assistant. What is on the page now is kept in its turn.` : "Nothing is kept yet: an arrangement is kept when it is reset or changed in Arrange."),
          ...list.map((e) => k.item(ArrangeGridCard.prevLabel(e), () => this._prevRestore(e))),
        ]);
      });
      return wait;
    };
    const common = (kit) => [
      kit.item(nest ? "Arrange inside this group…" : "Arrange…", () => this._arrEnter(), { disabled: !may || !on.length }),
      ...(nest ? [kit.item("Hide this group", () => nest._setHidden(nest._kidOf(this).key, true), { disabled: !nest._canArrange() }), kit.item("Arrange the whole page…", () => this._rootGrid()._arrEnter(), { disabled: !nest._canArrange() }),
        ...(moves && !kid ? [kit.item("Move this group to…", () => kit.show(places(nest, nest._kidOf(this))), { stay: true })] : [])] : []),
      ...(kid || !on.length ? [] : [kit.item("Hide a card…", () => kit.show(pick("Hide a card", on, (k) => this._setHidden(k.key, true))), { stay: true, disabled: !may })]),
      // (a card under a finger has no menu of its own: this is the way to its editor)
      ...(kid || !on.length || !this._mayMove() ? [] : [kit.item("Edit a card…", () => kit.show(pick("Edit a card", on, (k) => this._editCard(k))), { stay: true })]),
      ...(nest && !kid && this._mayMove() ? [kit.item("Edit this group…", () => nest._editCard(nest._kidOf(this)))] : []),
      ...(off.length ? [kit.item("Show a hidden card…", () => kit.show(pick("Show a hidden card", off, (k) => this._setHidden(back(k), false))), { stay: true, disabled: !may })] : []),
      ...(this._mayMove()
        ? [
            kit.item(nest ? "Add card here…" : "Add card…", () => kit.show((k) => this._entityField(k, nest ? `New card in ${this._config.title || "this group"}` : "New card on the page", (entity) => this._addTile(entity))), { stay: true }),
            kit.item(nest ? "Add group inside…" : "Add group…", () => kit.show(newGroup), { stay: true }),
          ]
        : []),
      // (everything of the user's own: places, sizes, the list's order, what is hidden)
      kit.item("Reset layout…", () => kit.show(resetAsk), { stay: true, disabled: !may || !tree.some((g) => g._own()) }),
      kit.item("Restore a previous arrangement…", () => kit.show(restore), { stay: true, disabled: !may }),
      ...(may ? [] : [kit.hr(), kit.item("Only an administrator can arrange this page", () => {}, { disabled: true })]),
    ];
    this._menuOpen(
      x,
      y,
      (kit) => (kid ? [kit.head(kid.name), kit.item("Hide this card", () => this._setHidden(kid.key, true), { disabled: !may }), ...(group ? [kit.item("Hide this group", () => this._setHidden(group, true), { disabled: !may })] : []), ...(this._mayMove() ? [kit.item(kid.el.localName === TAG ? "Edit this group…" : "Edit this card…", () => this._editCard(kid))] : []), ...(moves ? [kit.item("Move to…", () => kit.show(places(this, kid)), { stay: true })] : []), kit.hr(), ...common(kit)] : [kit.head(nest ? this._config.title || "Group" : "Page layout"), ...common(kit)]),
      opener
    );
  }

  _wireMenu(root) {
    const kidAt = (ev) => {
      const path = ev.composedPath ? ev.composedPath() : [];
      return (this._kids || []).find((k) => path.includes(k.slot)) || null;
    };
    // an arranging grid inside one of our cards answers for itself, and a
    // text field keeps the browser's own menu
    const theirs = (ev) => {
      const path = ev.composedPath ? ev.composedPath() : [];
      const mine = path.indexOf(this);
      const inner = path.findIndex((el) => el && el.localName === TAG);
      const t = path[0];
      return (inner >= 0 && inner < mine) || !!(t && (t.localName === "input" || t.localName === "textarea" || t.isContentEditable));
    };
    // On the way down (capture): Home Assistant's own cards stop a
    // right-click from travelling back up, so it would never get here.
    root.addEventListener("contextmenu", (ev) => {
      if (this._arranging && this._config.context_menu && !theirs(ev)) {
        // while arranging: what can be done to the card, or the grid, under the pointer
        const path = ev.composedPath ? ev.composedPath() : [];
        if (this._menu && (path.includes(this._menu.menu) || path.includes(this._menu.back))) return;
        if (!path.includes(this._grid) && !path.includes(this._head)) return;
        ev.preventDefault();
        this._arrMenu(ev.clientX, ev.clientY, kidAt(ev));
        return;
      }
      if (this._arranging || !this._config.context_menu || theirs(ev)) return;
      // (the open menu, and what lies behind it, see to themselves)
      const path = ev.composedPath ? ev.composedPath() : [];
      if (this._menu && (path.includes(this._menu.menu) || path.includes(this._menu.back))) return;
      ev.preventDefault();
      if (Date.now() - (this._menuAt || 0) < 700) return; // (the long press has just opened it)
      this._context(ev.clientX, ev.clientY, kidAt(ev));
    }, true);
    // A finger held still on an empty part of the page. Not on a card: a
    // long press there is the card's own (its hold action).
    let press = null;
    const drop = () => {
      if (press) clearTimeout(press.timer);
      press = null;
    };
    root.addEventListener("pointerdown", (ev) => {
      drop();
      if (ev.pointerType !== "touch" || this._arranging || !this._config.context_menu || this._menu || kidAt(ev) || theirs(ev)) return;
      const path = ev.composedPath ? ev.composedPath() : [];
      if (!path.includes(this._grid)) return;
      const [x, y] = [ev.clientX, ev.clientY];
      press = { id: ev.pointerId, x, y, timer: setTimeout(() => {
        press = null;
        this._context(x, y, null);
      }, 550) };
    }, true);
    root.addEventListener("pointermove", (ev) => {
      if (press && ev.pointerId === press.id && Math.hypot(ev.clientX - press.x, ev.clientY - press.y) > 10) drop();
    }, true);
    root.addEventListener("pointerup", drop, true);
    root.addEventListener("pointercancel", drop, true);
  }

  // -------------------------------------------------------- arranging

  _arrBar(hint, extra) {
    const exit = (label, how, main) => {
      const b = make("button", main ? "main" : "", label);
      b.onclick = () => this._arrExit(how);
      return b;
    };
    this._why = make("div", "why", "");
    this._undo = make("div", "undo");
    this._undo.hidden = true;
    this._arrGone = [];
    this._ask = null;
    if (!this._trash) {
      this._trash = make("div", "trash");
      this._trash.setAttribute("aria-hidden", "true");
      this._trashText = make("span", "", "");
      this._trash.append(icon("mdi:trash-can-outline"), this._trashText);
      this.shadowRoot.appendChild(this._trash);
    }
    this._trashText.textContent = this._arrDeletes() ? "Drop here to delete it" : "Drop here to hide it";
    // (a group arranged with the page it is in: the page's bar speaks for it)
    if (this._arrLead) {
      if (this._arrLead._bar) this._arrLead._bar.appendChild(this._undo);
      return;
    }
    const step = (label, title, fn) => {
      const b = make("button", "", label);
      b.title = title;
      b.disabled = true;
      b.onclick = fn;
      return b;
    };
    this._undoBtn = step("Undo", "Take back the last change (Ctrl+Z)", () => this._arrUndoStep());
    this._redoBtn = step("Redo", "Do again what Undo took back (Ctrl+Shift+Z)", () => this._arrRedoStep());
    // (Reset is apart from Done and Cancel, and asks first)
    const reset = make("button", "quiet", "Reset…");
    reset.title = "Go back to the default arrangement";
    reset.onclick = () => this._arrAskReset();
    this._bar.replaceChildren(make("span", "", hint), ...extra, this._undoBtn, this._redoBtn, exit("Done", "save", true), exit("Cancel", "cancel"), reset, this._undo, this._why);
    this._bar.hidden = false;
    this._btn.classList.add("on");
    // Esc leaves without keeping anything; Ctrl/Cmd+Z takes back a step
    // (Shift with it, or Ctrl+Y: does it again)
    this._arrKey = (ev) => {
      const held = !!ArrangeGridCard._dialog || this._tree().some((g) => g._menu || g._arrBusy);
      const key = String(ev.key || "").toLowerCase();
      if ((ev.ctrlKey || ev.metaKey) && !ev.altKey && (key === "z" || key === "y")) {
        const t = (ev.composedPath ? ev.composedPath() : [])[0];
        if (held || (t && (t.localName === "input" || t.localName === "textarea" || t.isContentEditable))) return;
        ev.preventDefault();
        ev.stopPropagation();
        if (key === "z" && !ev.shiftKey) this._arrUndoStep();
        else this._arrRedoStep();
        return;
      }
      if (ev.key !== "Escape" || held) return;
      ev.stopPropagation();
      if (this._ask) return this._arrAskDrop();
      this._arrExit("cancel");
    };
    window.addEventListener("keydown", this._arrKey, true);
  }

  // One Arrange covers a grid and every group in it: `lead` is the grid it
  // was started on (it has the bar; Done, Reset and Cancel are for all).
  _arrEnter(lead) {
    if (this._arranging || !this._grid || !this._kids.some((k) => !k.off) || !this._canArrange()) return;
    clearTimeout(this._noteTimer);
    this._arrLead = lead && lead !== this ? lead : null;
    if (!this._arrLead) this._arrSession = this._resumeTake() || { moves: [], snap: null };
    if (this._isList()) this._arrEnterList();
    else this._arrEnterGrid();
    this._arrStart = JSON.stringify([this._arrEdit, this._arrListEdit]);
    // (what was in the bin before a redraw is in it again)
    const session = (this._arrLead || this)._arrSession;
    const pend = ((session && session.gone) || {})[this._config.name] || [];
    const again = pend.filter((key) => this._kids.some((k) => k.key === key && !k.off));
    if (again.length) {
      this._arrGone.push(...again);
      if (this._arrEdit) this._arrEdit.tiles = this._arrEdit.tiles.filter((t) => !again.includes(t.id));
      if (this._arrListEdit) this._arrListEdit.splice(0, this._arrListEdit.length, ...this._arrListEdit.filter((key) => !again.includes(key)));
      this._layout();
    }
    for (const kid of this._kids) if (!kid.off && kid.el.localName === TAG && typeof kid.el._arrEnter === "function") kid.el._arrEnter(this._arrLead || this);
    if (!this._arrLead) {
      this._arrFitAll(true);
      this._arrUnstretch();
    }
    // (what everything was before, for Cancel after a card changed groups)
    if (!this._arrLead && !this._arrSession.snap) {
      this._arrSession.snap = {};
      for (const g of this._tree()) if (g._config.storage === "user") this._arrSession.snap[g._config.name] = g._arr || null;
    }
    // (and to keep as the previous arrangement once Done changes it)
    if (!this._arrLead && !this._arrSession.prev) this._arrSession.prev = this._prevSnap(this._tree());
    (this._arrLead || this)._arrJoined(this);
  }

  // ------------------------------------------------- undo and redo
  //
  // One history for the whole Arrange, kept by the grid it was started on:
  // every step (a move, a resize, a column or row, a card in the bin, a new
  // order) can be taken back and done again, whichever grid it was in. A
  // step is what the page and its groups were arranged as before it:
  //   {state: JSON of {name: {edit, list, gone, asked}}, cfg}
  // `cfg`: the step also changed the dashboard (a card changed groups, or a
  // card or group was added): taking it back rewrites the dashboard again,
  // and such a step is not done again by Redo.

  _arrState() {
    const out = {};
    for (const g of this._tree()) {
      if (!g._arranging) continue;
      const e = g._arrEdit;
      out[g._config.name] = {
        edit: e ? { grid: { cols: e.grid.cols, rows: e.grid.rows }, tiles: e.tiles.map(({ id, c, r, w, h }) => ({ id, c, r, w, h })) } : null,
        list: g._arrListEdit ? [...g._arrListEdit] : null,
        gone: [...(g._arrGone || [])],
        asked: g._arrRowsAsked || null,
      };
    }
    return out;
  }

  // A grid has opened for this Arrange (the lead itself, or a group, which
  // after a redraw may come later): what a step taken back across a redraw
  // left for it is put in place, and the history goes on from here.
  _arrJoined(grid) {
    const s = this._arrSession;
    if (!s) return;
    s.undo = Array.isArray(s.undo) ? s.undo : [];
    s.redo = Array.isArray(s.redo) ? s.redo : [];
    const mine = s.pending && s.pending[grid._config.name];
    if (mine) {
      delete s.pending[grid._config.name];
      if (grid._arrTake(mine)) grid._layout();
    }
    s.now = JSON.stringify(this._arrState());
    this._arrHistSync();
  }

  // After something was done: a step, if anything changed.
  _arrStep() {
    const lead = this._arrLead || this;
    const s = lead._arrSession;
    // (not in the middle of a drag: the spare row under the pointer is no step)
    if (!lead._arranging || !s || !Array.isArray(s.undo) || lead._arrSpareGrid) return;
    const now = JSON.stringify(lead._arrState());
    if (now === s.now) return;
    s.undo.push({ state: s.now });
    if (s.undo.length > UNDO_KEEP) s.undo.shift();
    s.redo = [];
    s.pending = null;
    s.now = now;
    lead._arrHistSync();
  }

  // A step that changes the dashboard is about to be taken (the Arrange
  // pauses for the redraw).
  _arrCfgStep(session) {
    session.undo = Array.isArray(session.undo) ? session.undo : [];
    session.undo.push({ state: session.now, cfg: true });
    if (session.undo.length > UNDO_KEEP) session.undo.shift();
    session.redo = [];
    session.pending = null;
    session.saved = true;
  }

  _arrHistSync() {
    const s = this._arrSession;
    if (this._undoBtn) this._undoBtn.disabled = !(s && s.undo && s.undo.length);
    if (this._redoBtn) this._redoBtn.disabled = !(s && s.redo && s.redo.length);
  }

  // One grid's part of a state. Not taken when it is not about the cards
  // that are here now.
  _arrTake(st) {
    if (!this._arranging || !st) return false;
    const keys = this._kids.map((k) => k.key);
    const out = new Set([...this._hiddenKept(), ...(st.gone || [])]);
    if (this._arrEdit) {
      if (!st.edit || !st.edit.tiles.every((t) => keys.includes(t.id)) || keys.some((key) => !out.has(key) && !st.edit.tiles.some((t) => t.id === key))) return false;
      this._arrEdit = { grid: { ...st.edit.grid }, tiles: st.edit.tiles.map((t) => ({ ...t })) };
    }
    if (this._arrListEdit) {
      if (!st.list || !st.list.every((key) => keys.includes(key)) || keys.some((key) => !out.has(key) && !st.list.includes(key))) return false;
      this._arrListEdit.splice(0, this._arrListEdit.length, ...st.list);
    }
    this._arrGone = (st.gone || []).filter((key) => keys.includes(key));
    this._arrRowsAsked = st.asked || null;
    if (this._arrSel && this._arrGone.includes(this._arrSel)) this._arrSelect(null);
    this._arrBackDrop();
    return true;
  }

  _arrApply(state) {
    const st = JSON.parse(state);
    const tree = this._tree();
    for (const g of tree) g._arrTake(st[g._config.name]);
    for (const g of tree.reverse()) if (g._arranging) g._layout();
    this._arrWhy("");
  }

  _arrUndoStep() {
    const lead = this._arrLead || this;
    const s = lead._arrSession;
    if (!lead._arranging || !s || !s.undo || !s.undo.length || lead._tree().some((g) => g._arrBusy)) return;
    const e = s.undo.pop();
    if (e.cfg) return lead._arrUndoCfg(e);
    s.redo.push({ state: JSON.stringify(lead._arrState()) });
    s.now = e.state;
    lead._arrApply(e.state);
    lead._arrHistSync();
  }

  _arrRedoStep() {
    const lead = this._arrLead || this;
    const s = lead._arrSession;
    if (!lead._arranging || !s || !s.redo || !s.redo.length || lead._tree().some((g) => g._arrBusy)) return;
    const e = s.redo.pop();
    s.undo.push({ state: JSON.stringify(lead._arrState()) });
    s.now = e.state;
    lead._arrApply(e.state);
    lead._arrHistSync();
  }

  // Takes back a step that changed the dashboard: the dashboard is changed
  // back (which redraws the page), and when Arrange opens again everything
  // is put where it was before the step.
  async _arrUndoCfg(e) {
    const s = this._arrSession;
    const m = s.moves.pop();
    if (!m) {
      s.now = e.state;
      this._arrApply(e.state);
      return this._arrHistSync();
    }
    s.redo = [];
    s.pending = JSON.parse(e.state);
    s.gone = {};
    s.saved = true;
    this._resumeSave(s);
    this._arrExit("save", true);
    try {
      await this._dashEdit((page, down) => ArrangeGridCard.unmove(down, m));
    } catch (err) {
      this._resumeSave(null);
      this._note("Couldn't take that back in the dashboard. Arrange is closed with everything else kept: move the card back with its \"Move to…\".", 9000);
    }
  }

  // Reset, in the bar: asks first, and says what goes and for whom.
  _arrAskReset() {
    if (this._ask) return this._arrAskDrop();
    const keep = make("button", "", "Keep arranging");
    keep.onclick = () => this._arrAskDrop();
    const go = make("button", "danger", "Reset");
    go.onclick = () => this._arrExit("reset");
    this._ask = make("div", "ask");
    this._ask.setAttribute("role", "alertdialog");
    this._ask.append(
      make("span", "", `${this._resetWords(this._tree(), this._arrMode === "list" ? "list" : "grid")} What you changed in this Arrange goes with it. ${this._arrMode === "list" ? "The wide grid is" : "What is hidden and the list's order are"} left alone. It can be taken back: "Undo reset" right after, or "Restore a previous arrangement…" in the menu later.`),
      keep,
      go
    );
    this._bar.appendChild(this._ask);
    keep.focus();
  }

  _arrAskDrop() {
    if (this._ask) this._ask.remove();
    this._ask = null;
  }

  // This grid and every group in it, however deep.
  _tree() {
    const out = [this];
    for (const kid of this._kids || []) if (kid.el.localName === TAG && kid.el._config && typeof kid.el._tree === "function") out.push(...kid.el._tree());
    return out;
  }

  _arrEnterGrid() {
    // starts from the page as it is shown now, with room under it
    const now = this._plan();
    this._arranging = true;
    this._arrMode = "grid";
    this._arrEdit = { grid: { cols: now.cols, rows: now.rows }, tiles: now.places.map(({ id, c, r, w, h }) => ({ id, c, r, w, h })) };
    const stepper = (label, one, key) => {
      const grp = make("div", "grp");
      const minus = make("button", "", "−");
      const plus = make("button", "", "+");
      const count = make("b", "", "");
      minus.title = `One ${one} fewer`;
      minus.setAttribute("aria-label", minus.title);
      plus.title = `One ${one} more`;
      plus.setAttribute("aria-label", plus.title);
      minus.onclick = () => this._arrGrid(key, -1);
      plus.onclick = () => this._arrGrid(key, 1);
      grp.append(make("span", "", label), minus, count, plus);
      this._arrCount = { ...(this._arrCount || {}), [key]: count };
      return grp;
    };
    const grouped = this._kids.some((k) => !k.off && k.members && k.members.length);
    const boxes = this._mayMove() && this._rootGrid()._kids.some((k) => k.el.localName === TAG);
    this._arrBar(`Drag a card to any cell; drag its corner to resize; drop it on the bin to ${this._arrDeletes() ? "delete" : "hide"} it.${boxes ? " Drop a card on another group to move it there; a group moves by its title bar." : ""}${grouped ? " The button on a heading selects its group, to move it as one." : ""}`, [stepper("Columns", "column", "cols"), stepper("Rows", "row", "rows")]);
    for (const kid of this._kids) {
      if (kid.off) continue;
      const o = make("div", kid.el.localName === TAG ? "arr frame" : "arr");
      o.tabIndex = 0;
      o.setAttribute("role", "group");
      o.setAttribute("aria-label", `${kid.name}: arrow keys move it, Shift and arrow keys resize it, Delete ${this._arrDeletes() ? "deletes" : "hides"} it`);
      const grip = make("div", "grip");
      grip.title = "Drag to move";
      grip.appendChild(icon("mdi:drag"));
      kid.dim = make("div", "dim");
      const size = make("div", "size");
      size.title = "Drag to resize";
      size.appendChild(icon("mdi:resize-bottom-right"));
      o.append(grip, kid.dim, size);
      if (kid.members && kid.members.length) {
        // a group's heading: its cards can be taken along
        const pick = make("button", "pick");
        pick.title = "Select the whole group, to move it as one";
        pick.setAttribute("aria-label", `${kid.name}: select the whole group`);
        pick.setAttribute("aria-pressed", "false");
        pick.appendChild(icon("mdi:select-group"));
        pick.addEventListener("click", (ev) => {
          ev.stopPropagation();
          this._arrSelect(this._arrSel === kid.key ? null : kid.key);
        });
        o.appendChild(pick);
        kid.pick = pick;
      }
      this._arrWire(o, kid);
      kid.slot.appendChild(o);
      kid.arr = o;
    }
    this._layout();
  }

  // On a narrow screen the page is a list: only its order can be changed, by
  // a card's grip or its arrows. That order is the list's own.
  _arrEnterList() {
    const now = this._plan();
    this._arranging = true;
    this._arrMode = "list";
    this._arrListEdit = [...now.order];
    this._arrBar(`Change the order with the arrows, or drag a card by its grip. The bin ${this._arrDeletes() ? "deletes" : "hides"} a card.`, []);
    for (const kid of this._kids) {
      if (kid.off) continue;
      const o = make("div", kid.el.localName === TAG ? "arr list frame" : "arr list");
      const grip = make("div", "grip");
      grip.title = "Drag to move";
      grip.appendChild(icon("mdi:drag"));
      const mv = make("div", "mv");
      const up = make("button", "up");
      up.title = "Move earlier";
      up.setAttribute("aria-label", `${kid.name}: move earlier`);
      up.appendChild(icon("mdi:arrow-up"));
      const down = make("button", "down");
      down.title = "Move later";
      down.setAttribute("aria-label", `${kid.name}: move later`);
      down.appendChild(icon("mdi:arrow-down"));
      const rm = make("button", "rm");
      const many = kid.members && kid.members.length;
      rm.title = `${this._arrDeletes() ? "Delete" : "Hide"} this ${many ? "group" : "card"}`;
      rm.setAttribute("aria-label", `${kid.name}: ${rm.title.toLowerCase()}`);
      rm.appendChild(icon("mdi:trash-can-outline"));
      rm.onclick = () => this._arrRemove(this._arrBlock(kid).map((key) => this._kids.find((k) => k.key === key)));
      mv.append(up, down, rm);
      o.append(grip, mv);
      this._arrWireList(o, kid, up, down);
      kid.slot.appendChild(o);
      kid.arr = o;
    }
    this._layout();
  }

  // how: "save" keeps the changes, "reset" forgets the arrangement, "cancel"
  // drops the changes. The wide grid and the list are kept apart: each is
  // saved, and reset, without touching the other.
  // `kept`: the page is only being redrawn, or a card is changing groups:
  // nothing is taken back, and the Arrange may go on afterwards.
  _arrExit(how, kept) {
    if (!this._arranging) return;
    // Done: every group is made as tall as its cards need
    if (how === "save" && !this._arrLead) this._arrFitAll();
    // what is in the bin: deleted from the dashboard on Done (kept in the
    // bin while the Arrange only pauses for a redraw), else hidden
    const binned = how === "save" && this._arrGone && this._arrGone.length ? [...this._arrGone] : null;
    const deletes = !!binned && this._arrDeletes();
    const top = this._arrLead || this;
    if (!this._arrLead) {
      this._arrDel = [];
      this._arrPause = !!kept;
    }
    if (binned && deletes && !top._arrPause) {
      const at = binned.map((key) => this._keys.indexOf(key)).filter((i) => i >= 0);
      top._arrDel.push({ grid: this, path: this._pathFromRoot(), keys: binned, at, types: at.map((i) => this._config.cards[i].type) });
    }
    const [sub, session] = [!!this._arrLead, this._arrSession];
    // Reset: what is on screen is kept first, to bring back
    const lost = how === "reset" && !sub && !kept ? this._rootGrid()._prevKeep("reset", this._prevSnap(this._tree(), true)) : null;
    if (!sub) this._arrLost = lost;
    // (a group nobody touched keeps no arrangement of its own for it)
    if (sub && how === "save" && !(this._arrGone && this._arrGone.length) && JSON.stringify([this._arrEdit, this._arrListEdit]) === this._arrStart) how = "cancel";
    for (const kid of this._kids) if (kid.el.localName === TAG && kid.el._arranging && kid.el._arrLead) kid.el._arrExit(how, true);
    if (this._undo && sub) this._undo.remove();
    this._arrLead = this._arrSession = null;
    this._arrSpareOn = false;
    this._arrSpareGrid = null;
    this._arrRowsWas = this._arrRowsAsked = null;
    if (!sub && !kept) {
      this._resumeSave(null);
      // (cards that changed groups go back, with everything as it was)
      if (how === "cancel" && session && (session.moves.length || session.saved)) this._arrRevert(session);
    }
    const gone = binned && !deletes ? this._hidden() : null;
    const next = how === "save" || how === "reset" ? this._arrNext(how, gone) : null;
    this._arranging = false;
    this._arrEdit = this._arrListEdit = this._arrMode = this._arrCount = this._arrSel = this._arrGone = this._ask = this._undoBtn = this._redoBtn = null;
    this._trashShow(false);
    this._scrollStop();
    window.removeEventListener("keydown", this._arrKey, true);
    for (const cell of this._arrCellEls || []) cell.remove();
    this._arrCellEls = null;
    for (const kid of this._kids) {
      if (kid.arr) kid.arr.remove();
      kid.arr = kid.dim = kid.pick = null;
      kid.slot.classList.remove("dragging", "drop");
      kid.slot.style.transform = "";
    }
    this._bar.hidden = true;
    this._btn.classList.remove("on");
    if (how === "save" || how === "reset") this._commit(next, sub || how === "reset" || !!(this._arrDel && this._arrDel.length), how === "reset" ? this._rootGrid()._resetAct(top._arrLost) : null);
    else this._layout();
    if (!sub) {
      const del = this._arrDel || [];
      this._arrDel = null;
      if (del.length) this._arrDelete(del);
      // Done: what the page was arranged as when Arrange was opened is kept
      // (if anything was done in it)
      if (how === "save" && !kept && session && session.prev && ((session.undo && session.undo.length) || session.saved)) this._prevKeepIfChanged(session.prev);
      if (how === "reset" && !kept) this._rootGrid()._note("The arrangement is reset.", 20000, this._rootGrid()._resetAct(lost));
      this._arrLost = null;
    }
  }

  // What Done ("save") or Reset keeps of this grid: null, nothing of its own.
  _arrNext(how, gone) {
    const [edit, listEdit, mode] = [this._arrEdit, this._arrListEdit, this._arrMode];
    const had = this._own() || { tiles: [] };
    const next = { tiles: [] };
    if (mode === "list") {
      if (had.grid) {
        next.grid = had.grid;
        next.tiles = had.tiles;
      }
      if (how === "save" && listEdit) next.list = [...listEdit];
    } else {
      if (how === "save" && edit) {
        // without the empty rows under the last card; a hidden card keeps its place
        next.grid = { cols: edit.grid.cols, rows: Layout.bottom(edit.tiles) };
        next.tiles = [...edit.tiles, ...(had.tiles || []).filter((t) => !edit.tiles.some((e) => e.id === t.id))];
      }
      if (had.list) next.list = had.list;
    }
    if (gone) next.hidden = gone;
    else if (had.hidden) next.hidden = had.hidden;
    if (had.folded) next.folded = had.folded;
    return next.grid || next.list || next.hidden || next.folded ? next : null;
  }

  // `prev`: a snapshot of when Arrange was opened. Kept as a previous
  // arrangement if any grid in it is arranged differently now.
  _prevKeepIfChanged(prev) {
    const root = this._rootGrid();
    const tree = root._tree();
    const same = ["layouts", "defaults"].every((part) =>
      Object.keys(prev[part] || {}).every((name) => {
        const g = tree.find((x) => x._config.name === name && (x._config.storage === "config") === (part === "defaults"));
        return !g || JSON.stringify(g._own() || null) === JSON.stringify(prev[part][name] || null);
      })
    );
    if (!same) root._prevKeep("arrange", prev);
  }

  // Selects a group (by its heading's key; null: none). While one is
  // selected, moving any of its cards moves them all.
  _arrSelect(key) {
    this._arrSel = key;
    for (const kid of this._kids) {
      if (kid.arr) kid.arr.classList.toggle("sel", !!key && (kid.key === key || kid.group === key));
      if (kid.pick) kid.pick.setAttribute("aria-pressed", kid.key === key ? "true" : "false");
    }
    this._arrWhy("");
  }

  // The selected group's cards, if `kid` is one of them: [{kid, t (its tile)}].
  _arrGroup(kid) {
    const key = this._arrSel;
    if (!key || (kid.key !== key && kid.group !== key)) return null;
    return this._kids
      .filter((k) => k.key === key || k.group === key)
      .map((k) => ({ kid: k, t: this._arrItem(k.key) }))
      .filter((m) => m.t);
  }

  _shiftGroup(group, dc, dr) {
    if (!dc && !dr) return true;
    const tiles = group.map((m) => m.t);
    const low = Math.max(...tiles.map((x) => x.r + x.h)) + dr;
    if (low > this._arrEdit.grid.rows && low <= MAX_ROWS) this._arrEdit.grid.rows = low;
    if (!Layout.canShift(this._arrG(), tiles, dc, dr)) {
      this._arrWhy("No room for the group there: move the cards in the way first");
      return false;
    }
    for (const t of tiles) {
      t.c += dc;
      t.r += dr;
    }
    this._arrWhy("");
    this._arrRoom();
    return true;
  }

  _arrItem(key) {
    return ((this._arrEdit && this._arrEdit.tiles) || []).find((t) => t.id === key);
  }

  _arrG() {
    const e = this._arrEdit;
    return { cols: e.grid.cols, rows: e.grid.rows, tiles: e.tiles };
  }

  // Why something wasn't done, in the bar ("" clears it).
  _arrWhy(text, tip) {
    if (this._arrLead) return this._arrLead._arrWhy(text, tip);
    if (!this._why) return;
    this._why.textContent = text || "";
    this._why.classList.toggle("tip", !!tip && !!text);
  }

  // The menu while arranging: for a card, a group (`kid`), or this grid
  // itself (null). A group's own grid is sized from here.
  _arrMenu(x, y, kid) {
    const box = kid && kid.el.localName === TAG ? kid.el : null;
    const grid = box || (kid ? null : this);
    const outer = box ? this : this._arrLead && this._outerGrid();
    const boxKid = box ? kid : outer && outer._kidOf(this);
    const fill = (kit) => {
      const out = [kit.head(kid ? kid.name : this._config.title || "This grid")];
      const again = (fn) => () => {
        fn();
        kit.show(fill);
      };
      if (grid && grid._arranging && grid._arrEdit) {
        const g = grid._arrEdit.grid;
        out.push(
          kit.item(`Columns: ${g.cols}  ·  one more`, again(() => grid._arrGrid("cols", 1)), { stay: true }),
          kit.item("Columns: one fewer", again(() => grid._arrGrid("cols", -1)), { stay: true, disabled: g.cols <= 1 }),
          kit.item(`Rows: ${g.rows}  ·  one more`, again(() => grid._arrGrid("rows", 1)), { stay: true }),
          kit.item("Rows: one fewer", again(() => grid._arrGrid("rows", -1)), { stay: true, disabled: g.rows <= 1 })
        );
      }
      if (boxKid && outer && outer._arrEdit) out.push(kit.item("Fit the group's height to its cards", () => outer._arrFit(boxKid, true, true)));
      if (kid && this._mayMove()) out.push(kit.item(box ? "Edit this group…" : "Edit this card…", () => this._editCard(kid)));
      else if (boxKid && outer && this._mayMove()) out.push(kit.item("Edit this group…", () => outer._editCard(boxKid)));
      const into = box || (kid ? null : this);
      if (into && this._mayMove()) {
        const inside = !!into._outerGrid();
        out.push(kit.item(inside ? "Add card here…" : "Add card…", () => kit.show((k) => this._entityField(k, inside ? `New card in ${into._config.title || "this group"}` : "New card on the page", (entity) => this._arrAddTile(into, entity))), { stay: true }));
        out.push(kit.item(inside ? "Add group inside…" : "Add group…", () => kit.show((k) => this._groupField(k, inside ? `New group in ${into._config.title || "this group"}` : "New group on the page", (title) => this._arrAddGroup(into, title))), { stay: true }));
      }
      if (kid) out.push(kit.hr(), kit.item(`${this._arrDeletes() ? "Delete" : "Hide"} this ${box ? "group" : "card"}`, () => this._arrRemove((this._arrGroup(kid) || [{ kid }]).map((m) => m.kid))));
      return out;
    };
    this._menuOpen(x, y, fill);
  }

  // How many rows of the grid it is in a group takes to show its cards.
  // `live`: as it is drawn while arranging, with its spare row to drag into.
  _groupRows(live) {
    const outer = this._outerGrid();
    if (!outer) return null;
    const [c, oc] = [this._config, outer._config];
    const shown = this._kids.some((k) => !k.off);
    let rows = 1;
    if (this._arrEdit) rows = live ? this._arrEdit.grid.rows : Layout.bottom(this._arrEdit.tiles);
    else {
      const plan = this._plan();
      if (plan.list) return null;
      rows = Layout.bottom(plan.places);
    }
    const px = (c.title ? 40 + c.gap : 0) + 14 + (shown ? rows * c.row_height + (rows - 1) * c.gap : 90);
    return Math.max(1, Math.ceil((px + oc.gap) / (oc.row_height + oc.gap)));
  }

  // Makes a group as tall as its cards need: shorter always, taller where
  // there is room. `say`: tell why not.
  _arrFit(kid, say, live) {
    const t = this._arrItem(kid.key);
    const n = typeof kid.el._groupRows === "function" ? kid.el._groupRows(live) : null;
    if (!t || !n || n === t.h) return;
    this._arrGrow(t, n);
    if (say) this._arrStep();
  }

  // A card made as tall as it needs. Taller than there is room for: what
  // is under it moves down, so that no row has to stretch to hold it.
  _arrGrow(t, n) {
    const g = this._arrG();
    if (n > t.h && !Layout.fits({ ...g, rows: Math.min(MAX_ROWS, Math.max(g.rows, t.r + n)) }, t, t.w, n)) {
      const moved = Layout.push(g, t, n);
      if (!moved) return false;
      for (const [o, r] of moved) o.r = r;
    }
    t.h = n;
    this._arrRoom();
    return true;
  }

  // On opening Arrange: every card shorter than what is in it needs is
  // given the rows it needs (measured on screen). Until then its rows were
  // stretched to hold it, and everything else in those rows with them.
  _arrUnstretch() {
    for (const kid of this._kids) if (!kid.off && kid.el.localName === TAG && typeof kid.el._arrUnstretch === "function") kid.el._arrUnstretch();
    if (!this._arrEdit) return;
    for (const kid of this._kids) {
      if (kid.off || kid.el.localName === TAG) continue;
      const t = this._arrItem(kid.key);
      const need = t ? this._needRows(kid) : 0;
      if (t && need > t.h) this._arrGrow(t, need);
    }
  }

  // Every group in this grid, the innermost first.
  _arrFitAll(live) {
    if (!this._arrEdit) return;
    for (const kid of this._kids) {
      if (kid.off || kid.el.localName !== TAG || typeof kid.el._arrFitAll !== "function") continue;
      kid.el._arrFitAll(live);
      this._arrFit(kid, false, live);
    }
  }

  // One column or row more or fewer. The last one goes only when it is
  // empty: nothing is moved behind the user's back.
  _arrGrid(key, d) {
    const e = this._arrEdit;
    if (!e) return;
    const grid = { ...e.grid, [key]: e.grid[key] + d };
    const max = key === "cols" ? MAX_COLS : MAX_ROWS;
    if (grid[key] > max) return this._arrWhy(`No more than ${max} ${key === "cols" ? "columns" : "rows"}`);
    const inLast = e.tiles.some((t) => (key === "cols" ? t.c + t.w > grid.cols : t.r + t.h > grid.rows));
    if (d < 0 && inLast) return this._arrWhy(`The last ${key === "cols" ? "column" : "row"} still has a card in it: move or shrink that first`);
    if (grid[key] < 1) return;
    e.grid = grid;
    if (key === "rows") this._arrRowsAsked = grid.rows;
    this._arrWhy("");
    this._arrBackDrop();
    this._layout();
    this._arrStep();
  }

  // While a card is dragged, the one grid the pointer is over has an empty
  // row under its last card, so that there is somewhere further down to
  // drop it (`grid`; null: none, the drag is over). Only that one, and only
  // then: everything else stays at its real size, so that what is beside
  // what can be seen. A row added by hand stays. The boxes of the groups
  // are left alone meanwhile: nothing is moved for a spare row.
  _arrSpareAt(grid) {
    const lead = this._arrLead || this;
    if (!lead._arranging || (lead._arrSpareGrid || null) === (grid || null)) return;
    lead._arrSpareGrid = grid || null;
    for (const g of lead._tree()) {
      const e = g._arranging ? g._arrEdit : null;
      const want = !!e && g === grid;
      if (!e || !!g._arrSpareOn === want) continue;
      g._arrSpareOn = want;
      if (want) {
        g._arrRowsWas = e.grid.rows;
        e.grid.rows = Math.min(MAX_ROWS, Math.max(e.grid.rows, Layout.bottom(e.tiles) + 1));
      } else {
        e.grid.rows = Math.max(g._arrRowsAsked || 1, Layout.bottom(e.tiles));
        g._arrRowsWas = null;
      }
      g._layout();
    }
    // (now that the drag is over, each group's box follows what is in it)
    if (!grid) for (const g of lead._tree().reverse()) for (const kid of g._kids) if (g._arrEdit && !kid.off && kid.el.localName === TAG) g._arrFit(kid, false, true);
  }

  // After a card moved or grew: an empty row stays under the last card, so
  // there is always somewhere further down to drag to.
  _arrRoom() {
    const e = this._arrEdit;
    this._arrBackDrop();
    // (as many rows as the cards take, or as were asked for by hand: an
    // empty row that a card left behind does not linger)
    e.grid.rows = Math.min(MAX_ROWS, Math.max(this._arrRowsAsked || 1, Layout.bottom(e.tiles) + (this._arrSpareOn ? 1 : 0)));
    this._layout();
  }

  // The grid's cells, drawn while arranging (the empty ones are where a card
  // can go). They also say where each column and row is on screen.
  _arrCells(cols, rows) {
    const n = cols * rows;
    const cells = (this._arrCellEls = this._arrCellEls || []);
    while (cells.length > n) cells.pop().remove();
    while (cells.length < n) {
      const cell = make("div", "cell");
      this._grid.prepend(cell); // under the cards
      cells.push(cell);
    }
    cells.forEach((cell, k) => {
      cell.style.gridColumn = `${(k % cols) + 1}`;
      cell.style.gridRow = `${Math.floor(k / cols) + 1}`;
    });
    this._arrCols = cols;
    if (this._arrCount) {
      this._arrCount.cols.textContent = String(cols);
      this._arrCount.rows.textContent = String(rows);
    }
  }

  // The cell under a point on screen, kept on the grid whatever the point
  // does. Rows are as high as their cards make them, so the cells are
  // measured, not worked out.
  _cellAt(x, y) {
    const { cols, rows } = this._arrEdit.grid;
    const g = this._grid.getBoundingClientRect();
    if (!this._met) {
      const cells = this._arrCellEls || [];
      const xs = [];
      const ys = [];
      for (let c = 0; c < cols; c++) xs.push(cells[c].getBoundingClientRect().left - g.left);
      for (let r = 0; r < rows; r++) ys.push(cells[r * cols].getBoundingClientRect().top - g.top);
      this._met = { xs, ys };
    }
    const at = (list, v) => {
      let k = 0;
      while (k + 1 < list.length && list[k + 1] <= v) k++;
      return k;
    };
    return { c: at(this._met.xs, x - g.left), r: at(this._met.ys, y - g.top) };
  }

  // The bin: shown while a card is dragged. A card dropped on it is
  // deleted from the dashboard when Done is pressed: for an administrator,
  // on a dashboard that can be saved. For anyone else it is hidden (the
  // user's own, brought back by "Show a hidden card…"). Until Done nothing
  // is kept: Cancel and Undo bring it back.
  _arrDeletes() {
    if (!this._mayMove()) return false;
    const ll = this._lovelace();
    return !(ll && ll.mode === "yaml");
  }

  // Done: the binned cards of this grid and its groups leave the dashboard.
  // list: [{grid, path, keys, at: [index], types: [type]}]
  async _arrDelete(list) {
    const n = list.reduce((sum, d) => sum + d.keys.length, 0);
    try {
      await this._dashEdit((page, down) => {
        const picks = [];
        for (const d of list) {
          const node = down(d.path);
          if (!node || !Array.isArray(node.cards)) continue;
          d.at.forEach((i, k) => {
            const c = node.cards[i];
            if (c && c.type === d.types[k]) picks.push([node, c]);
          });
        }
        if (!picks.length) throw new Error("cards not found in the dashboard");
        for (const [node, c] of picks) {
          const i = node.cards.indexOf(c);
          if (i >= 0) node.cards.splice(i, 1);
        }
      });
      this._note(`${n === 1 ? "1 card" : `${n} cards`} deleted from the dashboard`, 4000);
    } catch (err) {
      for (const d of list) d.grid._setHidden(d.keys, true);
      this._note("Couldn't delete from the dashboard (that takes a dashboard edited in Home Assistant's UI): hidden instead.", 9000);
    }
  }

  // What is in the bin, per grid, for an Arrange that goes on after a redraw.
  _goneAll() {
    const out = {};
    for (const g of this._tree()) if (g._arrGone && g._arrGone.length) out[g._config.name] = [...g._arrGone];
    return out;
  }
  _trashShow(on) {
    if (!this._trash) return;
    this._trash.classList.toggle("show", on);
    if (!on) this._trash.classList.remove("over");
  }

  _trashOver(x, y) {
    if (!this._trash) return false;
    const r = this._trash.getBoundingClientRect();
    const over = r.width > 0 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    this._trash.classList.toggle("over", over);
    return over;
  }

  _arrRemove(kids) {
    kids = kids.filter((k) => k && !k.off);
    if (!this._arranging || !kids.length) return;
    const keys = kids.map((k) => k.key);
    const [e, list] = [this._arrEdit, this._arrListEdit];
    this._arrGone.push(...keys);
    if (e) e.tiles = e.tiles.filter((t) => !keys.includes(t.id));
    if (list) list.splice(0, list.length, ...list.filter((key) => !keys.includes(key)));
    if (this._arrSel && keys.includes(this._arrSel)) this._arrSelect(null);
    this._arrWhy("");
    this._layout();
    this._arrStep();
    // (said until something else is changed; the Undo is the bar's own)
    const undo = make("button", "", "Undo");
    undo.onclick = () => this._arrUndoStep();
    this._undo.replaceChildren(make("span", "", `${kids.length === 1 ? kids[0].name : `${kids.length} cards`} ${this._arrDeletes() ? "will be deleted when you press Done." : "will be hidden when you press Done."}`), undo);
    this._undo.hidden = false;
  }

  _arrBackDrop() {
    if (this._undo) {
      this._undo.replaceChildren();
      this._undo.hidden = true;
    }
  }

  _mark(kid, to) {
    for (const cell of this._arrCellEls || []) cell.classList.remove("on", "bad");
    if (!to) return;
    const t = this._arrItem(kid.key);
    const cols = this._arrCols || 1;
    const ok = !!Layout.tryMove(this._arrG(), t, to.c, to.r);
    for (let y = to.r; y < to.r + t.h; y++) {
      for (let x = to.c; x < to.c + t.w; x++) {
        const cell = (this._arrCellEls || [])[y * cols + x];
        if (cell) cell.classList.add(ok ? "on" : "bad");
      }
    }
  }

  _markGroup(group, dc, dr) {
    for (const cell of this._arrCellEls || []) cell.classList.remove("on", "bad");
    const cols = this._arrCols || 1;
    const ok = Layout.canShift(this._arrG(), group.map((m) => m.t), dc, dr);
    for (const { t } of group) {
      for (let y = t.r + dr; y < t.r + dr + t.h; y++) {
        for (let x = t.c + dc; x < t.c + dc + t.w; x++) {
          const cell = x >= 0 && x < cols ? (this._arrCellEls || [])[y * cols + x] : null;
          if (cell) cell.classList.add(ok ? "on" : "bad");
        }
      }
    }
  }

  // While a card is held near the top or bottom of the window, the page
  // scrolls under it. `again` redoes the move at the pointer's last place.
  _scroll(y, again) {
    const edge = 56;
    const speed = y < edge ? y - edge : y > window.innerHeight - edge ? y - (window.innerHeight - edge) : 0;
    this._scrollBy = Math.max(-24, Math.min(24, speed * 0.4));
    if (!this._scrollBy) return this._scrollStop();
    if (this._scrollFrame) return;
    const tick = () => {
      this._scrollFrame = null;
      if (!this._scrollBy) return;
      window.scrollBy(0, this._scrollBy);
      again();
      this._scrollFrame = requestAnimationFrame(tick);
    };
    this._scrollFrame = requestAnimationFrame(tick);
  }

  _scrollStop() {
    this._scrollBy = 0;
    if (this._scrollFrame) cancelAnimationFrame(this._scrollFrame);
    this._scrollFrame = null;
  }

  _moveTo(kid, c, r) {
    const t = this._arrItem(kid.key);
    if (!t || (c === t.c && r === t.r)) return true;
    // (down past the last row: one is made)
    if (r + t.h > this._arrEdit.grid.rows && r + t.h <= MAX_ROWS) this._arrEdit.grid.rows = r + t.h;
    const moves = Layout.tryMove(this._arrG(), t, c, r);
    if (!moves) {
      this._arrWhy("No room there: make it smaller, or move the cards in the way first");
      return false;
    }
    for (const [x, mc, mr] of moves) {
      x.c = mc;
      x.r = mr;
    }
    this._arrWhy("");
    this._arrRoom();
    return true;
  }

  _sizeTo(kid, w, h) {
    const t = this._arrItem(kid.key);
    if (!t || (w === t.w && h === t.h)) return true;
    const g = this._arrG();
    // (down, there is always room to make: the grid grows)
    if (!Layout.fits({ ...g, rows: Math.min(MAX_ROWS, Math.max(g.rows, t.r + h)) }, t, w, h)) {
      this._arrWhy(t.c + w > g.cols ? "That is as wide as the grid goes: add a column first" : "Another card is in the way");
      return false;
    }
    const was = t.h;
    t.w = w;
    t.h = h;
    this._arrWhy("");
    this._arrRoom();
    // Not shorter than what is in it needs: a card too short for its
    // content makes its rows taller, and everything else in them with it.
    const need = this._needRows(kid);
    if (t.h < need) {
      const back = Math.max(t.h, Math.min(need, was));
      if (back !== t.h && Layout.fits({ ...g, rows: Math.max(g.rows, t.r + back) }, t, t.w, back)) {
        t.h = back;
        this._arrRoom();
      }
      if (t.h < need) this._arrWhy(`${kid.name} needs ${need} rows at this width: its rows stretch to fit it`, true);
      else this._arrWhy("That is as short as it goes without stretching its rows", true);
    }
    return true;
  }

  // How many rows a card needs for what is in it, at the width it has now.
  // A group knows; any other card is measured on screen.
  _needRows(kid) {
    if (kid.el.localName === TAG && typeof kid.el._groupRows === "function") return kid.el._groupRows(true) || 1;
    const st = kid.slot.style;
    const keep = [st.height, st.minHeight, st.overflow, st.alignSelf];
    let px = 0;
    try {
      [st.height, st.minHeight, st.overflow, st.alignSelf] = ["0px", "0", "hidden", "start"];
      px = kid.slot.scrollHeight;
    } catch (err) {}
    [st.height, st.minHeight, st.overflow, st.alignSelf] = keep;
    const c = this._config;
    return px > 0 ? Math.max(1, Math.ceil((px - 1 + c.gap) / (c.row_height + c.gap))) : 1;
  }

  // One card's handles. A mouse moves the card from anywhere on it; a finger
  // only by the grip, so that the page still scrolls under it. With the
  // keyboard: the arrow keys move it, Shift and the arrow keys resize it.
  _arrWire(el, kid) {
    let op = null;
    const on = (ev, cls) => !!(ev.target && ev.target.closest && ev.target.closest(cls));
    const move = (x, y) => {
      const t = this._arrItem(kid.key);
      const e = this._arrEdit;
      if (!op || !t || !e) return;
      // the grid under the pointer gets its spare row (the page may shift
      // as it comes and goes: the card stays under the pointer)
      const over = (!op.resize && !this._arrGroup(kid) && this._dropTarget(x, y, kid)) || this;
      if (((this._arrLead || this)._arrSpareGrid || null) !== over) {
        const b0 = kid.slot.getBoundingClientRect();
        this._arrSpareAt(over);
        const b1 = kid.slot.getBoundingClientRect();
        op.x += b1.left - b0.left;
        op.y += b1.top - b0.top;
      }
      const at = this._cellAt(x, y);
      if (op.resize) {
        this._sizeTo(kid, Math.max(1, Math.min(e.grid.cols - t.c, at.c - t.c + 1)), Math.max(1, at.r - t.r + 1));
        return;
      }
      const shift = `translate(${x - op.x}px, ${y - op.y + (window.scrollY - op.scrollY)}px)`;
      const group = this._arrGroup(kid);
      for (const m of group || [{ kid }]) m.kid.slot.style.transform = shift;
      this._trashShow(true);
      if (this._trashOver(x, y)) {
        if (op.dest) {
          op.dest.classList.remove("dropin");
          op.dest = null;
          this._arrWhy("");
        }
        op.trash = true;
        op.to = null;
        this._mark(kid, null);
        return;
      }
      op.trash = false;
      // over another group (or out of this one): it would go there
      const dest = group ? null : this._dropTarget(x, y, kid);
      if (dest !== op.dest) {
        if (op.dest) op.dest.classList.remove("dropin");
        if (dest) dest.classList.add("dropin");
        op.dest = dest;
        this._arrWhy(dest ? `Drop to move it to ${dest._outerGrid() ? dest._config.title || "that group" : "the page"} ` : "", true);
      }
      if (dest) {
        op.to = null;
        this._mark(kid, null);
        return;
      }
      let c = Math.max(0, Math.min(e.grid.cols - t.w, at.c - op.gx));
      let r = Math.max(0, Math.min(e.grid.rows - t.h, at.r - op.gy));
      if (group) {
        // the whole group stays on the grid, not just the card that is held
        const tiles = group.map((m) => m.t);
        c = t.c + Math.max(-Math.min(...tiles.map((g) => g.c)), Math.min(e.grid.cols - Math.max(...tiles.map((g) => g.c + g.w)), c - t.c));
        r = t.r + Math.max(-Math.min(...tiles.map((g) => g.r)), r - t.r);
      }
      if (op.to && op.to.c === c && op.to.r === r) return;
      op.to = { c, r };
      if (group) this._markGroup(group, c - t.c, r - t.r);
      else this._mark(kid, op.to);
    };
    el.addEventListener("pointerdown", (ev) => {
      if (op || (ev.button != null && ev.button > 0) || on(ev, ".pick")) return;
      const resize = on(ev, ".size");
      if (!resize && ev.pointerType !== "mouse" && !on(ev, ".grip")) return; // a finger elsewhere: scrolling
      const t = this._arrItem(kid.key);
      if (!t) return;
      const at = this._cellAt(ev.clientX, ev.clientY);
      op = {
        id: ev.pointerId, resize, x: ev.clientX, y: ev.clientY, scrollY: window.scrollY, to: null,
        // which of the card's own cells is held
        gx: Math.max(0, Math.min(t.w - 1, at.c - t.c)),
        gy: Math.max(0, Math.min(t.h - 1, at.r - t.r)),
      };
      this._arrBusy = true;
      try {
        el.setPointerCapture(ev.pointerId);
      } catch (err) {}
      if (!resize) for (const m of this._arrGroup(kid) || [{ kid }]) m.kid.slot.classList.add("dragging");
      this._arrWhy("");
      ev.preventDefault();
    });
    el.addEventListener("pointermove", (ev) => {
      if (!op || ev.pointerId !== op.id) return;
      const [x, y] = [ev.clientX, ev.clientY];
      move(x, y);
      // (the bin is at the window's edge: the page stays still under it)
      if (op && op.trash) this._scrollStop();
      else this._scroll(y, () => move(x, y));
    });
    const end = (ev, drop) => {
      try {
        settle(ev, drop);
      } finally {
        this._arrSpareAt(null);
        this._arrStep();
      }
    };
    const settle = (ev, drop) => {
      if (!op || ev.pointerId !== op.id) return;
      const done = op;
      op = null;
      this._arrBusy = false;
      this._scrollStop();
      try {
        el.releasePointerCapture(ev.pointerId);
      } catch (err) {}
      const group = done.resize ? null : this._arrGroup(kid);
      for (const m of group || [{ kid }]) {
        m.kid.slot.classList.remove("dragging");
        m.kid.slot.style.transform = "";
      }
      this._mark(kid, null);
      this._trashShow(false);
      if (done.dest) {
        done.dest.classList.remove("dropin");
        this._arrWhy("");
        if (drop && !done.trash) {
          this._arrMoveTo(kid, done.dest, ev.clientX, ev.clientY);
          return;
        }
      }
      if (done.trash) {
        if (drop) this._arrRemove((group || [{ kid }]).map((m) => m.kid));
        return;
      }
      if (done.resize || !drop || !done.to) return;
      const t = this._arrItem(kid.key);
      if (group && t) this._shiftGroup(group, done.to.c - t.c, done.to.r - t.r);
      else this._moveTo(kid, done.to.c, done.to.r);
    };
    el.addEventListener("pointerup", (ev) => end(ev, true));
    el.addEventListener("pointercancel", (ev) => end(ev, false));
    el.addEventListener("keydown", (ev) => {
      const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[ev.key];
      const t = this._arrItem(kid.key);
      if (ev.key === "Delete" && t) {
        ev.preventDefault();
        ev.stopPropagation();
        this._arrRemove((this._arrGroup(kid) || [{ kid }]).map((m) => m.kid));
        return;
      }
      if (!d || !t) return;
      ev.preventDefault();
      ev.stopPropagation();
      const group = this._arrGroup(kid);
      if (group && !ev.shiftKey) this._shiftGroup(group, d[0], d[1]);
      else if (ev.shiftKey) this._sizeTo(kid, t.w + d[0], t.h + d[1]);
      else this._moveTo(kid, t.c + d[0], t.r + d[1]);
      this._arrStep();
    });
    // (a click on the card under it would do what the card does)
    el.addEventListener("click", (ev) => ev.stopPropagation());
  }

  // The card to place `to` of the list being ordered. A group's heading
  // takes the group's cards along, as one block in the order they are in.
  _arrListMove(kid, to) {
    const list = this._arrListEdit;
    const from = list ? list.indexOf(kid.key) : -1;
    const target = list && list[to];
    const block = this._arrBlock(kid);
    if (from < 0 || target == null || block.includes(target)) return;
    const rest = list.filter((key) => !block.includes(key));
    rest.splice(rest.indexOf(target) + (to > from ? 1 : 0), 0, ...block);
    list.splice(0, list.length, ...rest);
    this._arrBackDrop();
    this._layout();
    this._arrStep();
  }

  _arrBlock(kid) {
    const list = this._arrListEdit || [];
    if (!kid.members || !kid.members.length) return [kid.key];
    return list.filter((key) => key === kid.key || kid.members.some((m) => m.key === key));
  }

  // One step earlier or later for the card's arrows. A group's heading steps
  // over a whole group at a time, so that it never lands inside another.
  _arrListStep(kid, d) {
    const list = this._arrListEdit;
    const block = this._arrBlock(kid);
    const at = block.map((key) => list.indexOf(key));
    if (block.length === 1) return this._arrListMove(kid, at[0] + d);
    const byKey = (key) => this._kids.find((k) => k.key === key);
    if (d < 0) {
      const prev = byKey(list[Math.min(...at) - 1]);
      if (!prev) return;
      const head = prev.group ? list.indexOf(prev.group) : -1;
      return this._arrListMove(kid, head >= 0 && head < Math.min(...at) ? head : list.indexOf(prev.key));
    }
    const next = byKey(list[Math.max(...at) + 1]);
    if (!next) return;
    const theirs = this._arrBlock(next).map((key) => list.indexOf(key));
    this._arrListMove(kid, Math.max(...theirs));
  }

  _arrWireList(el, kid, up, down) {
    up.onclick = () => this._arrListStep(kid, -1);
    down.onclick = () => this._arrListStep(kid, 1);
    let op = null;
    const on = (ev, cls) => !!(ev.target && ev.target.closest && ev.target.closest(cls));
    const over = (x, y) =>
      this._kids.find((other) => {
        if (other === kid || other.off) return false;
        const r = other.slot.getBoundingClientRect();
        return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
      }) || null;
    const move = (x, y) => {
      if (!op) return;
      kid.slot.style.transform = `translate(${x - op.x}px, ${y - op.y + (window.scrollY - op.scrollY)}px)`;
      this._trashShow(true);
      op.trash = this._trashOver(x, y);
      // over another group (or out of this one): it would go there
      const dest = op.trash || (kid.members && kid.members.length) ? null : this._dropTarget(x, y, kid);
      if (dest !== op.dest) {
        if (op.dest) op.dest.classList.remove("dropin");
        if (dest) dest.classList.add("dropin");
        op.dest = dest;
        this._arrWhy(dest ? `Drop to move it to ${dest._outerGrid() ? dest._config.title || "that group" : "the page"}` : "", true);
      }
      const target = op.trash || dest ? null : over(x, y);
      if (target === op.target) return;
      if (op.target) op.target.slot.classList.remove("drop");
      if (target) target.slot.classList.add("drop");
      op.target = target;
    };
    el.addEventListener("pointerdown", (ev) => {
      if (op || (ev.button != null && ev.button > 0) || on(ev, ".mv")) return;
      if (ev.pointerType !== "mouse" && !on(ev, ".grip")) return; // a finger elsewhere: scrolling
      op = { id: ev.pointerId, x: ev.clientX, y: ev.clientY, scrollY: window.scrollY, target: null };
      this._arrBusy = true;
      try {
        el.setPointerCapture(ev.pointerId);
      } catch (err) {}
      kid.slot.classList.add("dragging");
      ev.preventDefault();
    });
    el.addEventListener("pointermove", (ev) => {
      if (!op || ev.pointerId !== op.id) return;
      const [x, y] = [ev.clientX, ev.clientY];
      move(x, y);
      // (the bin is at the window's edge: the page stays still under it)
      if (op && op.trash) this._scrollStop();
      else this._scroll(y, () => move(x, y));
    });
    const end = (ev, drop) => {
      if (!op || ev.pointerId !== op.id) return;
      const done = op;
      op = null;
      this._arrBusy = false;
      this._scrollStop();
      try {
        el.releasePointerCapture(ev.pointerId);
      } catch (err) {}
      kid.slot.classList.remove("dragging");
      kid.slot.style.transform = "";
      this._trashShow(false);
      if (done.dest) {
        done.dest.classList.remove("dropin");
        this._arrWhy("");
        if (done.target) done.target.slot.classList.remove("drop");
        if (drop) this._arrMoveTo(kid, done.dest, ev.clientX, ev.clientY);
        return;
      }
      if (done.trash) {
        // (a heading goes with its cards, as when it is moved)
        if (drop) this._arrRemove(this._arrBlock(kid).map((key) => this._kids.find((k) => k.key === key)));
        return;
      }
      if (!done.target) return;
      done.target.slot.classList.remove("drop");
      // takes the place of the one it was dropped on
      if (drop) this._arrListMove(kid, this._arrListEdit.indexOf(done.target.key));
    };
    el.addEventListener("pointerup", (ev) => end(ev, true));
    el.addEventListener("pointercancel", (ev) => end(ev, false));
    el.addEventListener("click", (ev) => ev.stopPropagation());
  }
}

ArrangeGridCard.version = VERSION;
ArrangeGridCard.layout = Layout; // (for the tests)
ArrangeGridCard.cardKeys = cardKeys;

// ------------------------------------------------------------ the editor
//
// The card's options, and its cards: added with Home Assistant's own card
// picker, edited with each card's own editor (as the stack cards do).

const EDITOR_STYLE = `
  :host { display: block; }
  h3 { margin: 20px 0 8px; font-size: 14px; font-weight: 600; color: var(--primary-text-color); }
  p { margin: 4px 0 8px; font-size: 13px; color: var(--secondary-text-color); }
  .row { display: flex; align-items: center; gap: 4px; padding: 4px 4px 4px 12px; margin-bottom: 6px; border-radius: 10px;
    border: 1px solid var(--divider-color, #444); background: var(--card-background-color, transparent); }
  .row .name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--primary-text-color); }
  .row .name small { color: var(--secondary-text-color); margin-right: 8px; }
  button { font: inherit; color: var(--primary-text-color); cursor: pointer; border-radius: 999px; padding: 6px 14px;
    border: 1px solid var(--divider-color, #444); background: transparent; }
  button:hover:not(:disabled), button:focus-visible { border-color: var(--primary-color); color: var(--primary-color); outline: none; }
  button:disabled { opacity: .4; cursor: default; }
  button.icon { width: 36px; height: 36px; padding: 0; display: grid; place-items: center; border-color: transparent; flex: none; }
  button.main { border-color: var(--primary-color); }
  .tools { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 8px 0; }
  .tools .title { flex: 1 1 auto; font-weight: 600; color: var(--primary-text-color); }
  .tools.ask .title { flex-basis: 100%; font-weight: 400; }
  textarea { width: 100%; min-height: 220px; box-sizing: border-box; font: 13px/1.4 var(--ha-font-family-code, monospace);
    color: var(--primary-text-color); background: var(--secondary-background-color, #000); border: 1px solid var(--divider-color, #444); border-radius: 8px; padding: 8px; }
  .err { color: var(--error-color, #f87171); font-size: 13px; }
  [hidden] { display: none !important; }
`;

const FORM = [
  { name: "title", selector: { text: {} } },
  { name: "icon", selector: { icon: {} } },
  { name: "columns", selector: { number: { min: 1, max: MAX_COLS, mode: "box" } } },
  { name: "row_height", selector: { number: { min: 16, max: 400, mode: "box", unit_of_measurement: "px" } } },
  { name: "gap", selector: { number: { min: 0, max: 64, mode: "box", unit_of_measurement: "px" } } },
  { name: "min_width", selector: { number: { min: 0, max: 10000, mode: "box", unit_of_measurement: "px" } } },
  { name: "storage", selector: { select: { mode: "dropdown", options: [{ value: "user", label: "Each user arranges their own" }, { value: "config", label: "One arrangement for everyone, kept in the dashboard" }] } } },
  { name: "layout", selector: { text: {} } },
  { name: "arrange_button", selector: { boolean: {} } },
  { name: "context_menu", selector: { boolean: {} } },
  { name: "groups", selector: { boolean: {} } },
  { name: "hide_add_menu", selector: { boolean: {} } },
];
const FORM_LABELS = {
  title: "Title (shown when this card is a group inside another)",
  icon: "Icon beside the title",
  columns: "Columns of a new arrangement",
  row_height: "Row height",
  gap: "Gap between cards",
  min_width: "Narrower than this, the cards are a list",
  storage: "Who arranges",
  layout: "Name the arrangement is kept under",
  arrange_button: "Show the arrange button under the grid",
  context_menu: "Right-click and long-press menu",
  groups: "A heading and the cards after it are a group",
  hide_add_menu: "Hide Home Assistant's add menu (device, automation, area, person) in the header",
};

class ArrangeGridCardEditor extends HTMLElement {
  setConfig(config) {
    this._config = { ...config, cards: Array.isArray(config.cards) ? config.cards : [] };
    this._draw();
  }

  set hass(hass) {
    this._hass = hass;
    for (const el of [this._form, this._picker, this._sub]) if (el) el.hass = hass;
  }

  set lovelace(lovelace) {
    this._lovelace = lovelace;
    for (const el of [this._picker, this._sub]) if (el) el.lovelace = lovelace;
  }

  _fire(config) {
    this._config = config;
    this.dispatchEvent(new CustomEvent("config-changed", { detail: { config }, bubbles: true, composed: true }));
    this._draw();
  }

  _setCards(cards) {
    this._fire({ ...this._config, cards });
  }

  // Home Assistant loads its card picker and card editor only when one of
  // its own editors needs them. The stack card's editor uses both, so
  // asking for that one brings them in.
  static async haEditors() {
    const ready = () => !!(customElements.get("hui-card-element-editor") && customElements.get("hui-card-picker"));
    if (ready()) return true;
    try {
      const helpers = await window.loadCardHelpers();
      helpers.createCardElement({ type: "vertical-stack", cards: [] });
      const wait = (ms) => new Promise((done) => setTimeout(done, ms));
      await Promise.race([customElements.whenDefined("hui-vertical-stack-card"), wait(3000)]);
      const stack = customElements.get("hui-vertical-stack-card");
      if (stack && stack.getConfigElement) await Promise.race([stack.getConfigElement(), wait(3000)]);
    } catch (err) {}
    return ready();
  }

  _build() {
    const root = this.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = EDITOR_STYLE;

    // the list of cards and the card's own options
    this._main = make("div", "main");
    this._form = document.createElement("ha-form");
    this._form.schema = FORM;
    this._form.computeLabel = (s) => FORM_LABELS[s.name] || s.name;
    this._form.addEventListener("value-changed", (ev) => {
      ev.stopPropagation();
      const next = { ...this._config, ...ev.detail.value };
      for (const key of Object.keys(DEFAULTS)) if (next[key] === DEFAULTS[key] || next[key] == null) delete next[key];
      for (const key of ["layout", "title", "icon"]) if (!next[key]) delete next[key];
      this._fire(next);
    });
    this._list = make("div", "list");
    const add = make("button", "main add", "Add card");
    add.onclick = () => this._openPicker();
    const group = make("button", "group", "Add group");
    group.title = "A box with a title that holds cards of its own";
    group.onclick = () => {
      this._setCards([...this._config.cards, { id: ArrangeGridCardEditor.newId(this._config.cards), type: `custom:${TAG}`, title: "New group", cards: [] }]);
      this._edit(this._config.cards.length - 1);
    };
    const adds = make("div", "tools");
    adds.append(add, group);
    this._saved = make("p", "saved");
    const use = make("button", "use", "Use my arrangement as the default");
    // (both change what everyone starts from: each asks first)
    use.onclick = () => {
      if (!this._config.default_layout) return this._useMine();
      this._askFirst("Replace the default arrangement with your own? Everyone who has not arranged this page themselves sees it once the dashboard is saved. The default there is now is lost.", "Replace it", () => this._useMine());
    };
    this._drop = make("button", "drop", "Remove the default…");
    this._drop.onclick = () =>
      this._askFirst("Remove the default arrangement? Once the dashboard is saved, everyone who has not arranged this page themselves sees the cards one after another again. Each user's own arrangement stays.", "Remove it", () => {
        const { default_layout, ...rest } = this._config;
        this._fire(rest);
      });
    const tools = make("div", "tools");
    tools.append(use, this._drop);
    this._askBox = make("div", "tools ask");
    this._askBox.hidden = true;
    this._msg = make("p", "err");
    this._main.append(
      make("h3", "", "Cards"),
      this._list,
      adds,
      make("h3", "", "Grid"),
      this._form,
      make("h3", "", "Default arrangement"),
      make("p", "", "The arrangement everyone starts from. Arrange the page yourself first (the button under the grid), then keep that here."),
      this._saved,
      tools,
      this._askBox,
      this._msg
    );

    // one card being picked or edited
    this._panel = make("div", "panel");
    this._panel.hidden = true;
    const back = make("button", "back", "Back");
    back.onclick = () => this._close();
    this._title = make("span", "title");
    this._mode = make("button", "mode", "Show code editor");
    this._mode.onclick = () => this._sub && this._sub.toggleMode && this._sub.toggleMode();
    const head = make("div", "tools");
    head.append(back, this._title, this._mode);
    this._body = make("div", "body");
    this._panel.append(head, this._body);

    root.append(style, this._main, this._panel);
  }

  _draw() {
    if (!this.shadowRoot) this._build();
    const c = this._config;
    this._form.hass = this._hass;
    this._form.data = { ...DEFAULTS, layout: "", title: "", icon: "", ...Object.fromEntries(FORM.map((f) => f.name).filter((k) => c[k] != null).map((k) => [k, c[k]])) };
    const keys = cardKeys(c.cards);
    const tool = (name, title, fn, disabled) => {
      const b = make("button", "icon");
      b.title = title;
      b.setAttribute("aria-label", title);
      b.disabled = !!disabled;
      b.appendChild(icon(name));
      b.onclick = fn;
      return b;
    };
    // (a heading with cards under it: the group can go in one press)
    const span = (i) => {
      if (c.groups === false || c.cards[i].type !== "heading") return 0;
      let n = 0;
      while (c.cards[i + 1 + n] && c.cards[i + 1 + n].type !== "heading") n++;
      return n;
    };
    this._list.replaceChildren(
      ...c.cards.map((card, i) => {
        const row = make("div", "row");
        const name = make("div", "name");
        name.append(make("small", "", keys[i]), document.createTextNode(cardName(card)));
        row.append(
          name,
          tool("mdi:arrow-up", "Move up", () => this._move(i, i - 1), i === 0),
          tool("mdi:arrow-down", "Move down", () => this._move(i, i + 1), i === c.cards.length - 1),
          tool("mdi:pencil", "Edit", () => this._edit(i)),
          tool("mdi:delete", "Remove", () => this._remove(i))
        );
        if (span(i)) row.append(tool("mdi:delete-sweep", `Remove the group (this heading and the ${span(i)} under it)`, () => this._remove(i, span(i) + 1)));
        return row;
      })
    );
    if (!c.cards.length) this._list.appendChild(make("p", "", "No cards yet."));
    const d = Layout.valid(c.default_layout);
    this._saved.textContent = d
      ? [d.grid ? `${d.grid.cols} × ${d.grid.rows} cells, ${d.tiles.length} cards placed` : "", d.list ? "an order for the list" : "", d.hidden && d.hidden.length ? `${d.hidden.length} hidden` : ""].filter(Boolean).join("; ")
      : "None: the cards follow one another in the order above.";
    this._drop.disabled = !c.default_layout;
    // the card being edited, when the config came back changed from outside
    if (this._editing != null && this._sub) {
      const card = c.cards[this._editing];
      if (!card) this._close();
      else if (JSON.stringify(childConfig(card)) !== this._subJson) this._subSet(childConfig(card));
    }
  }

  _move(i, to) {
    const cards = [...this._config.cards];
    if (to < 0 || to >= cards.length) return;
    // (a card without an id is known by its place: give it one before it moves)
    cards.forEach((card, k) => {
      if (card.id == null) cards[k] = { id: ArrangeGridCardEditor.newId(cards), ...card };
    });
    cards.splice(to, 0, cards.splice(i, 1)[0]);
    this._setCards(cards);
  }

  _remove(i, count = 1) {
    const cards = this._config.cards.map((card, k) => (card.id == null && k > i ? { id: ArrangeGridCardEditor.newId(this._config.cards), ...card } : card));
    cards.splice(i, count);
    this._setCards(cards);
  }

  static newId(cards) {
    const taken = new Set(cards.map((c) => String(c.id)));
    for (;;) {
      const id = `c${Math.random().toString(36).slice(2, 7)}`;
      if (!taken.has(id)) return id;
    }
  }

  _show(title, el, withMode) {
    this._title.textContent = title;
    this._mode.hidden = !withMode;
    this._mode.textContent = "Show code editor";
    this._body.replaceChildren(el);
    this._main.hidden = true;
    this._panel.hidden = false;
  }

  _close() {
    this._editing = null;
    this._sub = this._picker = null;
    this._body.replaceChildren();
    this._panel.hidden = true;
    this._main.hidden = false;
  }

  async _openPicker() {
    const have = await ArrangeGridCardEditor.haEditors();
    if (!have) {
      // no picker to be had: a card to start from, edited as text
      this._setCards([...this._config.cards, { id: ArrangeGridCardEditor.newId(this._config.cards), type: "markdown", content: "New card" }]);
      return this._edit(this._config.cards.length - 1);
    }
    const picker = (this._picker = document.createElement("hui-card-picker"));
    picker.hass = this._hass;
    picker.lovelace = this._lovelace;
    picker.addEventListener("config-changed", (ev) => {
      ev.stopPropagation();
      const picked = ev.detail && ev.detail.config;
      if (!picked) return;
      this._setCards([...this._config.cards, { id: ArrangeGridCardEditor.newId(this._config.cards), ...picked }]);
      this._edit(this._config.cards.length - 1);
    });
    this._show("Add a card", picker, false);
  }

  async _edit(i) {
    const card = this._config.cards[i];
    if (!card) return;
    const have = await ArrangeGridCardEditor.haEditors();
    this._editing = i;
    this._picker = null;
    const put = (value) => {
      const cards = [...this._config.cards];
      const at = this._editing;
      if (at == null || !cards[at]) return;
      // (the id is ours: the card's editor never sees it, and it stays)
      cards[at] = cards[at].id != null ? { id: cards[at].id, ...value } : value;
      this._subJson = JSON.stringify(value);
      this._setCards(cards);
    };
    if (have) {
      const sub = (this._sub = document.createElement("hui-card-element-editor"));
      sub.hass = this._hass;
      sub.lovelace = this._lovelace;
      sub.addEventListener("config-changed", (ev) => {
        ev.stopPropagation();
        if (ev.detail && ev.detail.config) put(ev.detail.config);
      });
      sub.addEventListener("GUImode-changed", (ev) => {
        ev.stopPropagation();
        this._mode.textContent = ev.detail && ev.detail.guiMode ? "Show code editor" : "Show visual editor";
      });
      this._subSet(childConfig(card));
      this._show(cardName(card), sub, true);
      return;
    }
    // Home Assistant's card editor isn't to be had: the config as text
    const area = make("textarea");
    const err = make("div", "err");
    this._sub = {
      set value(v) {
        area.value = JSON.stringify(v, null, 2);
      },
    };
    area.addEventListener("input", () => {
      try {
        const value = JSON.parse(area.value);
        if (!value || typeof value.type !== "string") throw new Error("a card needs a type");
        err.textContent = "";
        put(value);
      } catch (e) {
        err.textContent = `Not saved: ${e.message}`;
      }
    });
    this._subSet(childConfig(card));
    const wrap = make("div");
    wrap.append(area, err);
    this._show(cardName(card), wrap, false);
  }

  _subSet(value) {
    this._subJson = JSON.stringify(value);
    this._sub.value = value;
  }

  // A question under the buttons, before something is done for everyone.
  _askFirst(text, yes, fn) {
    const close = () => {
      this._askBox.replaceChildren();
      this._askBox.hidden = true;
    };
    const keep = make("button", "", "Keep it as it is");
    keep.onclick = close;
    const go = make("button", "main", yes);
    go.onclick = () => {
      close();
      fn();
    };
    this._askBox.replaceChildren(make("span", "title", text), keep, go);
    this._askBox.hidden = false;
  }

  // The arrangement this user has made of the page becomes the config's.
  async _useMine() {
    this._msg.textContent = "";
    try {
      const res = await this._hass.callWS({ type: "frontend/get_user_data", key: USER_KEY });
      const mine = Layout.valid(res && res.value && res.value.layouts && res.value.layouts[layoutName(this._config)]);
      if (!mine) {
        this._msg.textContent = "You have no arrangement of this page yet: arrange it first, then come back.";
        return;
      }
      this._fire({ ...this._config, default_layout: mine });
    } catch (err) {
      this._msg.textContent = "Home Assistant didn't answer.";
    }
  }
}

if (!customElements.get(TAG)) customElements.define(TAG, ArrangeGridCard);
if (!customElements.get(`${TAG}-editor`)) customElements.define(`${TAG}-editor`, ArrangeGridCardEditor);

window.customCards = window.customCards || [];
if (!window.customCards.some((c) => c.type === TAG)) {
  window.customCards.push({
    type: TAG,
    name: "Arrange Grid",
    description: "Any cards on a grid you arrange by hand: drag to any cell, resize, leave gaps.",
    preview: true,
    documentationURL: "https://github.com/OnticEntia/arrange-grid-card",
  });
}

console.info(`%c ARRANGE-GRID-CARD %c v${VERSION} `, "color: #fff; background: #555; font-weight: 700;", "color: #fff; background: #b00020; font-weight: 700;");
