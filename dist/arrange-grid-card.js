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

const VERSION = "0.1.0";
const TAG = "arrange-grid-card";
const USER_KEY = "arrange_grid_card"; // frontend user data
const LOCAL_KEY = "arrange-grid-card:layout:"; // + layout name, in localStorage
const MAX_COLS = 48;
const MAX_ROWS = 400;
const SECTION_COLS = 12; // what `grid_options.columns` counts in
const DEFAULTS = { columns: 12, row_height: 56, gap: 8, min_width: 600, storage: "user", arrange_button: true, context_menu: true };

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
    return out.grid || out.list || out.hidden ? out : null;
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
    .arr .grip, .arr .size { width: 30px; height: 30px; }
    .arr .mv { right: 3px; gap: 3px; }
    .arr .mv button { width: 28px; height: 28px; --mdc-icon-size: 18px; }
  }
  @container (max-width: 80px) { .arr .dim { display: none; } }
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
  .menu hr { border: 0; border-top: 1px solid var(--divider-color, #2a2a2a); margin: 4px 0; }

  @media (prefers-reduced-motion: reduce) {
    .menu-btn, .arr, .cell { transition: none; }
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
      default_layout: Layout.valid(config.default_layout),
    };
    this._keys = cardKeys(config.cards);
    this._cfgOver = undefined; // (the dashboard has what was saved to it)
    if (was && (was.name !== this._config.name || was.storage !== storage)) {
      this._asked = null;
      this._arr = null;
      this._arrAll = null;
    }
    if (this._arranging) this._arrExit("cancel");
    this._render();
    this._sync();
    this._load();
  }

  set hass(hass) {
    this._hass = hass;
    for (const kid of this._kids || []) if (!kid.off) kid.el.hass = hass;
    this._load();
  }

  get hass() {
    return this._hass;
  }

  getCardSize() {
    const c = this._config || DEFAULTS;
    const rows = this._rows || ((c.cards && c.cards.length) || 1);
    return Math.max(1, Math.ceil((rows * (c.row_height + c.gap)) / 50));
  }

  getGridOptions() {
    return { columns: "full", min_columns: 6 };
  }

  connectedCallback() {
    if (typeof ResizeObserver !== "undefined" && !this._ro) {
      this._ro = new ResizeObserver(() => this._layout());
      this._ro.observe(this);
    }
    this._layout();
  }

  disconnectedCallback() {
    if (this._ro) this._ro.disconnect();
    this._ro = null;
    this._menuClose();
    if (this._arranging) this._arrExit("cancel");
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
      root.append(style, this._bar, this._grid, this._empty, this._foot);
      this._wireMenu(root);
      this._kids = [];
    }
    const c = this._config;
    this.style.setProperty("--agc-gap", `${c.gap}px`);
    this.style.setProperty("--agc-row", `${c.row_height}px`);
    this._foot.hidden = !c.arrange_button;
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
    const pool = [...this._kids];
    const take = (test) => {
      const at = pool.findIndex(test);
      return at < 0 ? null : pool.splice(at, 1)[0];
    };
    const wanted = this._config.cards.map((card, i) => ({ key: this._keys[i], cfg: childConfig(card), json: JSON.stringify(childConfig(card)), name: cardName(card) }));
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
    this._layout();
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

  _hidden() {
    const [a, b] = [this._own(), this._base()];
    return (a && a.hidden) || (b && b.hidden) || [];
  }

  _isList() {
    if (this._arranging) return this._arrMode === "list";
    return this.clientWidth > 0 && this.clientWidth < this._config.min_width;
  }

  // A child's own size in cells of a grid `cols` wide. A sections view's
  // section (12 of its columns) is taken as a quarter of the page.
  _cells(kid, cols) {
    const section = Math.max(1, Math.round(cols / 4));
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
      kid.slot.hidden = off;
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
    if (this._arranging && !plan.list) this._arrCells(plan.cols, plan.rows);
    const none = !this._kids.length;
    const allOff = !none && this._kids.every((k) => k.off);
    this._empty.textContent = none ? "No cards yet. Add some in the card's editor." : "Every card is hidden. Use the menu to show one.";
    this._empty.hidden = !(none || allOff);
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

  async _store(arr, quiet) {
    const name = this._config.name;
    this._local(arr, true); // until Home Assistant has it
    try {
      if (!this._arrAll) {
        const res = await this._hass.callWS({ type: "frontend/get_user_data", key: USER_KEY });
        this._arrAll = res && res.value && typeof res.value === "object" ? res.value : {};
      }
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
  async _storeConfig(arr) {
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
      this._note(arr ? "Arrangement saved to the dashboard" : "Arrangement removed from the dashboard", 3000);
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
  _commit(next, quiet) {
    if (this._config.storage === "config") {
      this._cfgOver = next;
      this._storeConfig(next);
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
    this._commit(a.grid || a.list || a.hidden ? a : null, true);
  }

  _setHidden(key, off) {
    this._change((a) => {
      const set = new Set(this._hidden());
      if (off) set.add(key);
      else set.delete(key);
      a.hidden = [...set];
    });
  }

  _canArrange() {
    if (this._config.storage !== "config") return true;
    const user = this._hass && this._hass.user;
    return !!(user && user.is_admin);
  }

  _note(text, ms) {
    if (!this._bar || this._arranging) return;
    clearTimeout(this._noteTimer);
    this._bar.replaceChildren(make("span", "", text));
    this._bar.hidden = false;
    this._noteTimer = setTimeout(() => {
      if (!this._arranging) this._bar.hidden = true;
    }, ms);
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

  // The menu for one card (`kid`), or for the page (null), at a point on screen.
  _context(x, y, kid, opener) {
    if (this._arranging || !this._kids) return;
    const off = this._kids.filter((k) => k.off);
    const on = this._kids.filter((k) => !k.off);
    const may = this._canArrange();
    const pick = (title, list, fn) => (kit) => [kit.head(title), ...list.map((k) => kit.item(k.name, () => fn(k)))];
    const common = (kit) => [
      kit.item("Arrange…", () => this._arrEnter(), { disabled: !may || !on.length }),
      ...(kid || !on.length ? [] : [kit.item("Hide a card…", () => kit.show(pick("Hide a card", on, (k) => this._setHidden(k.key, true))), { stay: true, disabled: !may })]),
      ...(off.length ? [kit.item("Show a hidden card…", () => kit.show(pick("Show a hidden card", off, (k) => this._setHidden(k.key, false))), { stay: true, disabled: !may })] : []),
      // (everything of the user's own: places, sizes, the list's order, what is hidden)
      kit.item("Reset layout", () => this._commit(null), { disabled: !may || !this._own() }),
      ...(may ? [] : [kit.hr(), kit.item("Only an administrator can arrange this page", () => {}, { disabled: true })]),
    ];
    this._menuOpen(
      x,
      y,
      (kit) => (kid ? [kit.head(kid.name), kit.item("Hide this card", () => this._setHidden(kid.key, true), { disabled: !may }), kit.hr(), ...common(kit)] : [kit.head("Page layout"), ...common(kit)]),
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
    this._bar.replaceChildren(make("span", "", hint), ...extra, exit("Done", "save", true), exit("Reset", "reset"), exit("Cancel", "cancel"), this._why);
    this._bar.hidden = false;
    this._btn.classList.add("on");
    // Esc leaves without keeping anything
    this._arrKey = (ev) => {
      if (ev.key !== "Escape" || this._menu || this._arrBusy) return;
      ev.stopPropagation();
      this._arrExit("cancel");
    };
    window.addEventListener("keydown", this._arrKey, true);
  }

  _arrEnter() {
    if (this._arranging || !this._grid || !this._kids.some((k) => !k.off) || !this._canArrange()) return;
    clearTimeout(this._noteTimer);
    if (this._isList()) return this._arrEnterList();
    // starts from the page as it is shown now, with room under it
    const now = this._plan();
    this._arranging = true;
    this._arrMode = "grid";
    this._arrEdit = { grid: { cols: now.cols, rows: Math.min(MAX_ROWS, now.rows + 1) }, tiles: now.places.map(({ id, c, r, w, h }) => ({ id, c, r, w, h })) };
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
    this._arrBar("Drag a card to any cell; drag its corner to resize.", [stepper("Columns", "column", "cols"), stepper("Rows", "row", "rows")]);
    for (const kid of this._kids) {
      if (kid.off) continue;
      const o = make("div", "arr");
      o.tabIndex = 0;
      o.setAttribute("role", "group");
      o.setAttribute("aria-label", `${kid.name}: arrow keys move it, Shift and arrow keys resize it`);
      const grip = make("div", "grip");
      grip.title = "Drag to move";
      grip.appendChild(icon("mdi:drag"));
      kid.dim = make("div", "dim");
      const size = make("div", "size");
      size.title = "Drag to resize";
      size.appendChild(icon("mdi:resize-bottom-right"));
      o.append(grip, kid.dim, size);
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
    this._arrBar("Change the order with the arrows, or drag a card by its grip.", []);
    for (const kid of this._kids) {
      if (kid.off) continue;
      const o = make("div", "arr list");
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
      mv.append(up, down);
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
  _arrExit(how) {
    if (!this._arranging) return;
    const [edit, listEdit, mode] = [this._arrEdit, this._arrListEdit, this._arrMode];
    this._arranging = false;
    this._arrEdit = this._arrListEdit = this._arrMode = this._arrCount = null;
    this._scrollStop();
    window.removeEventListener("keydown", this._arrKey, true);
    for (const cell of this._arrCellEls || []) cell.remove();
    this._arrCellEls = null;
    for (const kid of this._kids) {
      if (kid.arr) kid.arr.remove();
      kid.arr = kid.dim = null;
      kid.slot.classList.remove("dragging", "drop");
      kid.slot.style.transform = "";
    }
    this._bar.hidden = true;
    this._btn.classList.remove("on");
    if (how === "save" || how === "reset") {
      const had = this._own() || { tiles: [] };
      const next = { tiles: [] };
      if (mode === "list") {
        if (had.grid) {
          next.grid = had.grid;
          next.tiles = had.tiles;
        }
        if (how === "save" && listEdit) next.list = listEdit;
      } else {
        if (how === "save" && edit) {
          // without the empty rows under the last card; a hidden card keeps its place
          next.grid = { cols: edit.grid.cols, rows: Layout.bottom(edit.tiles) };
          next.tiles = [...edit.tiles, ...(had.tiles || []).filter((t) => !edit.tiles.some((e) => e.id === t.id))];
        }
        if (had.list) next.list = had.list;
      }
      if (had.hidden) next.hidden = had.hidden;
      this._commit(next.grid || next.list || next.hidden ? next : null);
    } else this._layout();
  }

  _arrItem(key) {
    return ((this._arrEdit && this._arrEdit.tiles) || []).find((t) => t.id === key);
  }

  _arrG() {
    const e = this._arrEdit;
    return { cols: e.grid.cols, rows: e.grid.rows, tiles: e.tiles };
  }

  // Why something wasn't done, in the bar ("" clears it).
  _arrWhy(text) {
    if (this._why) this._why.textContent = text || "";
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
    this._arrWhy("");
    this._layout();
  }

  // After a card moved or grew: an empty row stays under the last card, so
  // there is always somewhere further down to drag to.
  _arrRoom() {
    const e = this._arrEdit;
    e.grid.rows = Math.min(MAX_ROWS, Math.max(e.grid.rows, Layout.bottom(e.tiles) + 1));
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
    t.w = w;
    t.h = h;
    this._arrWhy("");
    this._arrRoom();
    return true;
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
      const at = this._cellAt(x, y);
      if (op.resize) {
        this._sizeTo(kid, Math.max(1, Math.min(e.grid.cols - t.c, at.c - t.c + 1)), Math.max(1, at.r - t.r + 1));
        return;
      }
      kid.slot.style.transform = `translate(${x - op.x}px, ${y - op.y + (window.scrollY - op.scrollY)}px)`;
      const c = Math.max(0, Math.min(e.grid.cols - t.w, at.c - op.gx));
      const r = Math.max(0, Math.min(e.grid.rows - t.h, at.r - op.gy));
      if (op.to && op.to.c === c && op.to.r === r) return;
      op.to = { c, r };
      this._mark(kid, op.to);
    };
    el.addEventListener("pointerdown", (ev) => {
      if (op || (ev.button != null && ev.button > 0)) return;
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
      if (!resize) kid.slot.classList.add("dragging");
      this._arrWhy("");
      ev.preventDefault();
    });
    el.addEventListener("pointermove", (ev) => {
      if (!op || ev.pointerId !== op.id) return;
      const [x, y] = [ev.clientX, ev.clientY];
      move(x, y);
      this._scroll(y, () => move(x, y));
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
      this._mark(kid, null);
      if (done.resize || !drop || !done.to) return;
      this._moveTo(kid, done.to.c, done.to.r);
    };
    el.addEventListener("pointerup", (ev) => end(ev, true));
    el.addEventListener("pointercancel", (ev) => end(ev, false));
    el.addEventListener("keydown", (ev) => {
      const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[ev.key];
      const t = this._arrItem(kid.key);
      if (!d || !t) return;
      ev.preventDefault();
      ev.stopPropagation();
      if (ev.shiftKey) this._sizeTo(kid, t.w + d[0], t.h + d[1]);
      else this._moveTo(kid, t.c + d[0], t.r + d[1]);
    });
    // (a click on the card under it would do what the card does)
    el.addEventListener("click", (ev) => ev.stopPropagation());
  }

  // The card to place `to` of the list being ordered.
  _arrListMove(kid, to) {
    const list = this._arrListEdit;
    const from = list ? list.indexOf(kid.key) : -1;
    if (from < 0 || to < 0 || to >= list.length || to === from) return;
    list.splice(to, 0, list.splice(from, 1)[0]);
    this._layout();
  }

  _arrWireList(el, kid, up, down) {
    const where = () => this._arrListEdit.indexOf(kid.key);
    up.onclick = () => this._arrListMove(kid, where() - 1);
    down.onclick = () => this._arrListMove(kid, where() + 1);
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
      const target = over(x, y);
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
      this._scroll(y, () => move(x, y));
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
  textarea { width: 100%; min-height: 220px; box-sizing: border-box; font: 13px/1.4 var(--ha-font-family-code, monospace);
    color: var(--primary-text-color); background: var(--secondary-background-color, #000); border: 1px solid var(--divider-color, #444); border-radius: 8px; padding: 8px; }
  .err { color: var(--error-color, #f87171); font-size: 13px; }
  [hidden] { display: none !important; }
`;

const FORM = [
  { name: "columns", selector: { number: { min: 1, max: MAX_COLS, mode: "box" } } },
  { name: "row_height", selector: { number: { min: 16, max: 400, mode: "box", unit_of_measurement: "px" } } },
  { name: "gap", selector: { number: { min: 0, max: 64, mode: "box", unit_of_measurement: "px" } } },
  { name: "min_width", selector: { number: { min: 0, max: 10000, mode: "box", unit_of_measurement: "px" } } },
  { name: "storage", selector: { select: { mode: "dropdown", options: [{ value: "user", label: "Each user arranges their own" }, { value: "config", label: "One arrangement for everyone, kept in the dashboard" }] } } },
  { name: "layout", selector: { text: {} } },
  { name: "arrange_button", selector: { boolean: {} } },
  { name: "context_menu", selector: { boolean: {} } },
];
const FORM_LABELS = {
  columns: "Columns of a new arrangement",
  row_height: "Row height",
  gap: "Gap between cards",
  min_width: "Narrower than this, the cards are a list",
  storage: "Who arranges",
  layout: "Name the arrangement is kept under",
  arrange_button: "Show the arrange button under the grid",
  context_menu: "Right-click and long-press menu",
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
      if (!next.layout) delete next.layout;
      this._fire(next);
    });
    this._list = make("div", "list");
    const add = make("button", "main add", "Add card");
    add.onclick = () => this._openPicker();
    this._saved = make("p", "saved");
    const use = make("button", "use", "Use my arrangement as the default");
    use.onclick = () => this._useMine();
    this._drop = make("button", "drop", "Remove the default");
    this._drop.onclick = () => {
      const { default_layout, ...rest } = this._config;
      this._fire(rest);
    };
    const tools = make("div", "tools");
    tools.append(use, this._drop);
    this._msg = make("p", "err");
    this._main.append(
      make("h3", "", "Cards"),
      this._list,
      add,
      make("h3", "", "Grid"),
      this._form,
      make("h3", "", "Default arrangement"),
      make("p", "", "The arrangement everyone starts from. Arrange the page yourself first (the button under the grid), then keep that here."),
      this._saved,
      tools,
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
    this._form.data = { ...DEFAULTS, layout: "", ...Object.fromEntries(FORM.map((f) => f.name).filter((k) => c[k] != null).map((k) => [k, c[k]])) };
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

  _remove(i) {
    const cards = this._config.cards.map((card, k) => (card.id == null && k > i ? { id: ArrangeGridCardEditor.newId(this._config.cards), ...card } : card));
    cards.splice(i, 1);
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
