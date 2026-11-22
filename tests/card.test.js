// The card and its editor against stand-ins for the browser and for Home
// Assistant (tests/dom.js). Run with: node --test tests/

"use strict";

const { test, mock, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { install, all, byClass, fire, document, customElements, Element } = require("./dom.js");

const dom = install();
mock.timers.enable({ apis: ["setTimeout"] });

// A child card, as Home Assistant's helpers would hand one over.
class FakeCard extends Element {
  setConfig(config) {
    if (config.refuse && this.config) throw new Error("will not take a new config");
    this.config = config;
    this.configs = (this.configs || 0) + 1;
  }
  set hass(hass) {
    this._hass = hass;
    this.hassSets = (this.hassSets || 0) + 1;
  }
  get hass() {
    return this._hass;
  }
  getCardSize() {
    return this.config.size || 1;
  }
  getGridOptions() {
    return this.config.said || {};
  }
}
customElements.define("fake-card", FakeCard);

let created = [];
globalThis.loadCardHelpers = async () => ({
  createCardElement(config) {
    const el = document.createElement("fake-card");
    el.setConfig(config);
    created.push(el);
    return el;
  },
});

require("../dist/arrange-grid-card.js");
const Card = customElements.get("arrange-grid-card");
const Editor = customElements.get("arrange-grid-card-editor");
const L = Card.layout;

const tick = async () => {
  for (let i = 0; i < 4; i++) await new Promise((done) => setImmediate(done));
};

// Home Assistant, as far as the card talks to it.
function fakeHass({ admin = true, userData = null, lovelace = null, failSet = false } = {}) {
  const hass = {
    user: { is_admin: admin },
    calls: [],
    userData,
    lovelace,
    failSet,
    async callWS(msg) {
      hass.calls.push(msg);
      if (msg.type === "frontend/get_user_data") return { value: hass.userData };
      if (msg.type === "frontend/set_user_data") {
        if (hass.failSet) throw new Error("no");
        hass.userData = msg.value;
        return null;
      }
      if (msg.type === "lovelace/config") {
        if (!hass.lovelace) throw new Error("yaml mode");
        return JSON.parse(JSON.stringify(hass.lovelace));
      }
      if (msg.type === "lovelace/config/save") {
        hass.lovelace = msg.config;
        return null;
      }
      throw new Error(`unexpected ${msg.type}`);
    },
  };
  return hass;
}

// One cell wide, one high, on the default 12 columns.
const small = (id, extra = {}) => ({ id, type: "fake", grid_options: { columns: 4, rows: 1 }, ...extra });
const three = () => ({ type: "custom:arrange-grid-card", cards: [small("a"), small("b"), small("c")] });

async function mount(config, { width = 1200, hass = fakeHass() } = {}) {
  const card = document.createElement("arrange-grid-card");
  card.clientWidth = width;
  card.setConfig(config);
  card.hass = hass;
  document.body.append(card);
  await tick();
  return card;
}

const kid = (card, key) => card._kids.find((k) => k.key === key);

// Where a card is on the grid, read back from what was drawn.
function place(card, key) {
  const s = kid(card, key).slot.style;
  const [c, w] = s.gridColumn.split(" / span ").map(Number);
  const [r, h] = s.gridRow.split(" / span ").map(Number);
  return { c: c - 1, r: r - 1, w, h };
}

const button = (node, text) => all(node, (el) => el.localName === "button" && el.textContent === text)[0];
const click = (el) => fire(el, "click");
const at = (c, r) => [c * 100 + 50, r * 50 + 25]; // the middle of a cell on screen

function drag(card, key, from, to, { pointerType = "mouse", handle } = {}) {
  const arr = kid(card, key).arr;
  const start = handle ? byClass(arr, handle)[0] : arr;
  fire(start, "pointerdown", { pointerId: 1, button: 0, pointerType, clientX: from[0], clientY: from[1] });
  fire(arr, "pointermove", { pointerId: 1, clientX: to[0], clientY: to[1] });
  fire(arr, "pointerup", { pointerId: 1, clientX: to[0], clientY: to[1] });
}

const overlaps = (tiles) => tiles.some((a, i) => tiles.some((b, j) => j > i && a.c < b.c + b.w && b.c < a.c + a.w && a.r < b.r + b.h && b.r < a.r + a.h));

beforeEach(() => {
  created = [];
  dom.store.clear();
  document.body.replaceChildren();
  // every cell 100 x 50 on screen, the grid at the top left
  dom.rects = (el) => (el.classList.contains("cell") ? { left: (parseInt(el.style.gridColumn, 10) - 1) * 100, top: (parseInt(el.style.gridRow, 10) - 1) * 50, width: 92, height: 42 } : null);
});

// ------------------------------------------------------------ grid maths

test("flow keeps the config's order and never overlaps", () => {
  const g = L.flow([{ id: "a", w: 2, h: 1 }, { id: "b", w: 3, h: 2 }, { id: "c", w: 1, h: 1 }, { id: "d", w: 9, h: 1 }], 4);
  assert.deepEqual(g.tiles.map((t) => [t.id, t.c, t.r, t.w]), [["a", 0, 0, 2], ["b", 0, 1, 3], ["c", 3, 1, 1], ["d", 0, 3, 4]]);
  assert.equal(g.rows, 4);
  assert.equal(overlaps(g.tiles), false);
});

test("a saved arrangement keeps its places, its gaps, and loses nothing", () => {
  const src = { grid: { cols: 4, rows: 2 }, tiles: [{ id: "a", c: 3, r: 1, w: 1, h: 1 }, { id: "gone", c: 0, r: 0, w: 2, h: 1 }, { id: "b", c: 0, r: 1, w: 2, h: 1 }] };
  const g = L.free(src, [{ id: "a", w: 1, h: 1 }, { id: "b", w: 1, h: 1 }, { id: "new", w: 2, h: 1 }]);
  const of = (id) => g.tiles.find((t) => t.id === id);
  assert.deepEqual([of("a").c, of("a").r], [3, 1]);
  assert.deepEqual([of("b").c, of("b").r, of("b").w], [0, 1, 2]);
  assert.deepEqual([of("new").c, of("new").r], [0, 0]); // the first free place, at its own size
  assert.equal(g.tiles.length, 3);
});

test("a saved place that cannot be is made good, on new rows if need be", () => {
  const src = { grid: { cols: 2, rows: 1 }, tiles: [{ id: "a", c: 0, r: 0, w: 2, h: 1 }, { id: "b", c: 1, r: 0, w: 1, h: 1 }, { id: "c", c: 5, r: 9, w: 7, h: 1 }, { id: "d", c: "x", r: -3, w: 0, h: null }] };
  const g = L.free(src, ["a", "b", "c", "d"].map((id) => ({ id, w: 1, h: 1 })));
  assert.equal(g.tiles.length, 4);
  assert.equal(overlaps(g.tiles), false);
  assert.ok(g.tiles.every((t) => t.c >= 0 && t.r >= 0 && t.c + t.w <= g.cols && t.r + t.h <= g.rows));
});

test("whatever was saved, nothing overlaps and nothing is off the grid", () => {
  let seed = 7;
  const rnd = (n) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
  for (let run = 0; run < 300; run++) {
    const ids = Array.from({ length: 1 + rnd(9) }, (_, i) => `k${i}`);
    const src = { grid: { cols: 1 + rnd(6), rows: 1 + rnd(4) }, tiles: ids.filter(() => rnd(4)).map((id) => ({ id, c: rnd(7), r: rnd(5), w: 1 + rnd(4), h: 1 + rnd(3) })) };
    const g = L.free(src, ids.map((id) => ({ id, w: 1 + rnd(8), h: 1 + rnd(3) })));
    assert.equal(g.tiles.length, ids.length);
    assert.equal(overlaps(g.tiles), false);
    assert.ok(g.tiles.every((t) => t.c + t.w <= g.cols && t.r + t.h <= g.rows));
  }
});

test("a move goes to a free place, swaps with one card, or is refused", () => {
  const a = { id: "a", c: 0, r: 0, w: 1, h: 1 };
  const b = { id: "b", c: 1, r: 0, w: 1, h: 1 };
  const big = { id: "big", c: 0, r: 1, w: 2, h: 1 };
  const g = { cols: 3, rows: 2, tiles: [a, b, big] };
  assert.deepEqual(L.tryMove(g, a, 2, 0), [[a, 2, 0]]);
  assert.deepEqual(L.tryMove(g, a, 1, 0), [[a, 1, 0], [b, 0, 0]]);
  assert.equal(L.tryMove(g, big, 0, 0), null); // on top of two cards
  assert.equal(L.tryMove(g, a, 3, 0), null); // off the grid
  assert.equal(L.tryMove(g, big, 2, 1), null); // half off the grid
});

test("what is kept of a saved thing", () => {
  assert.equal(L.valid(null), null);
  assert.equal(L.valid({ tiles: [{ id: "a" }] }), null); // places without a grid say nothing
  assert.deepEqual(L.valid({ grid: { cols: 2, rows: 1 }, tiles: [{ id: "a", c: 0, r: 0, w: 1, h: 1, junk: 1 }, { id: 5 }], list: ["b", 3], unsent: true }), {
    grid: { cols: 2, rows: 1 },
    tiles: [{ id: "a", c: 0, r: 0, w: 1, h: 1 }],
    list: ["b"],
  });
  assert.deepEqual(L.listOrder(["c", "zz"], [{ id: "a", c: 1, r: 0 }, { id: "b", c: 0, r: 0 }, { id: "c", c: 0, r: 1 }]), ["c", "b", "a"]);
});

test("a child is known by its id, else by its place", () => {
  assert.deepEqual(Card.cardKeys([{ id: "x" }, {}, { id: "x" }, { id: 7 }]), ["x", "#1", "#2", "7"]);
});

// --------------------------------------------------------------- the card

test("a config that cannot work is refused", () => {
  const card = document.createElement("arrange-grid-card");
  assert.throws(() => card.setConfig({}), /cards/);
  assert.throws(() => card.setConfig({ cards: [{ entity: "x" }] }), /cards\[0\] needs a type/);
  assert.throws(() => card.setConfig({ cards: [], columns: 0 }), /columns/);
  assert.throws(() => card.setConfig({ cards: [], columns: 2.5 }), /whole number/);
  assert.throws(() => card.setConfig({ cards: [], storage: "browser" }), /storage/);
});

test("children are made by Home Assistant's helpers, without our id, and get hass", async () => {
  const hass = fakeHass();
  const card = await mount(three(), { hass });
  assert.equal(created.length, 3);
  assert.deepEqual(created[0].config, { type: "fake", grid_options: { columns: 4, rows: 1 } });
  assert.ok(created.every((el) => el.hass === hass && el.layout === "grid"));
  const later = fakeHass();
  card.hass = later;
  assert.ok(created.every((el) => el.hass === later));
});

test("with nothing arranged the cards follow one another at their own sizes", async () => {
  const card = await mount({
    type: "custom:arrange-grid-card",
    cards: [
      { type: "fake", grid_options: { columns: 12, rows: 2 } }, // a section's width: a quarter of the page
      { type: "fake", said: { columns: 6, rows: 1 } }, // what the card itself says
      { type: "fake", size: 4 }, // nothing said: full width, rows from its card size
    ],
  });
  assert.deepEqual(place(card, "#0"), { c: 0, r: 0, w: 3, h: 2 });
  assert.deepEqual(place(card, "#1"), { c: 3, r: 0, w: 2, h: 1 });
  assert.deepEqual(place(card, "#2"), { c: 5, r: 0, w: 3, h: 3 });
  assert.equal(card._grid.style.gridTemplateColumns, "repeat(12, minmax(0, 1fr))");
  assert.equal(card._grid.style.gridTemplateRows, "repeat(3, minmax(56px, auto))");
});

test("a changed config keeps the elements of the cards that did not change", async () => {
  const card = await mount(three());
  const [a, b, c] = created;
  card.setConfig({ type: "custom:arrange-grid-card", cards: [small("c"), small("a"), small("b", { name: "new" }), small("d")] });
  await tick();
  assert.equal(kid(card, "a").el, a);
  assert.equal(kid(card, "c").el, c);
  assert.equal(kid(card, "b").el, b); // same card, new config: told, not replaced
  assert.equal(b.config.name, "new");
  assert.equal(created.length, 4);
  assert.ok([a, b, c].every((el) => !el.removals && el.isConnected));
  card.setConfig({ type: "custom:arrange-grid-card", cards: [small("a")] });
  await tick();
  assert.equal(card._kids.length, 1);
  assert.equal(c.isConnected, false);
});

test("a child that will not take a new config is made anew; ll-rebuild too", async () => {
  const card = await mount({ type: "custom:arrange-grid-card", cards: [small("a", { refuse: true })] });
  const first = created[0];
  card.setConfig({ type: "custom:arrange-grid-card", cards: [small("a", { refuse: true, name: "x" })] });
  await tick();
  assert.notEqual(kid(card, "a").el, first);
  assert.equal(kid(card, "a").el.config.name, "x");
  const second = kid(card, "a").el;
  const ev = fire(second, "ll-rebuild");
  assert.notEqual(kid(card, "a").el, second);
  assert.equal(kid(card, "a").el.parentNode, kid(card, "a").slot);
  assert.equal(ev._stopped, true);
});

test("the config's default layout is used, and the user's own goes over it", async () => {
  const config = { ...three(), default_layout: { grid: { cols: 4, rows: 2 }, tiles: [{ id: "a", c: 3, r: 1, w: 1, h: 1 }] } };
  const card = await mount(config);
  assert.deepEqual(place(card, "a"), { c: 3, r: 1, w: 1, h: 1 });
  assert.deepEqual(place(card, "b"), { c: 0, r: 0, w: 1, h: 1 }); // not in it: the first free place

  const mine = { grid: { cols: 6, rows: 1 }, tiles: [{ id: "a", c: 5, r: 0, w: 1, h: 1 }] };
  const hass = fakeHass({ userData: { v: 1, layouts: { "/dashboard-test/home": mine } } });
  const theirs = await mount(config, { hass });
  assert.deepEqual(place(theirs, "a"), { c: 5, r: 0, w: 1, h: 1 });
  assert.equal(theirs._grid.style.gridTemplateColumns, "repeat(6, minmax(0, 1fr))");
});

test("arranging: a card dragged to a free cell stays there, gaps and all, per user", async () => {
  const hass = fakeHass();
  const card = await mount(three(), { hass });
  click(card._btn);
  click(button(card, "Arrange…"));
  assert.equal(byClass(card, "cell").length, 12 * 2); // the row in use and a spare one
  const a = created[0];
  drag(card, "a", at(0, 0), at(7, 1));
  assert.deepEqual(place(card, "a"), { c: 7, r: 1, w: 1, h: 1 });
  assert.deepEqual(place(card, "b"), { c: 1, r: 0, w: 1, h: 1 });
  click(button(card, "Done"));
  await tick();
  const saved = hass.userData.layouts["/dashboard-test/home"];
  assert.deepEqual(saved.grid, { cols: 12, rows: 2 }); // without the spare row under the last card
  assert.deepEqual(saved.tiles.find((t) => t.id === "a"), { id: "a", c: 7, r: 1, w: 1, h: 1 });
  assert.equal(byClass(card, "arr").length + byClass(card, "cell").length, 0);
  assert.equal(a.removals || 0, 0); // never taken off the page
  assert.equal(a.configs, 1);
  // and it is there again for a card made later
  const again = await mount(three(), { hass });
  assert.deepEqual(place(again, "a"), { c: 7, r: 1, w: 1, h: 1 });
});

test("arranging: onto another card they change places; where there is no room, nothing moves", async () => {
  const card = await mount({ type: "custom:arrange-grid-card", columns: 4, cards: [small("a"), small("b"), small("wide", { grid_options: { columns: 12, rows: 1 } })] });
  // (4 columns: a section is one cell wide, so "wide" is 1 cell too; make it 2)
  click(card._btn);
  click(button(card, "Arrange…"));
  drag(card, "a", at(0, 0), at(1, 0));
  assert.deepEqual([place(card, "a").c, place(card, "b").c], [1, 0]);
  drag(card, "wide", at(2, 0), at(3, 0), { handle: "size" }); // two cells wide now
  assert.equal(place(card, "wide").w, 2);
  drag(card, "wide", at(2, 0), at(0, 0)); // would cover a and b
  assert.deepEqual(place(card, "wide"), { c: 2, r: 0, w: 2, h: 1 });
  assert.match(byClass(card, "why")[0].textContent, /No room there/);
  click(button(card, "Cancel"));
  assert.deepEqual([place(card, "a").c, place(card, "b").c, place(card, "wide").w], [0, 1, 1]);
});

test("arranging: resizing stops at a neighbour and at the grid's edge, and may grow downwards", async () => {
  const card = await mount({ ...three(), columns: 4 });
  click(card._btn);
  click(button(card, "Arrange…"));
  drag(card, "a", at(0, 0), at(1, 0), { handle: "size" }); // into b
  assert.equal(place(card, "a").w, 1);
  assert.match(byClass(card, "why")[0].textContent, /in the way/);
  drag(card, "c", at(2, 0), at(3, 2), { handle: "size" }); // to the last column, three rows down
  assert.deepEqual(place(card, "c"), { c: 2, r: 0, w: 2, h: 2 }); // (only two rows existed under the pointer)
  drag(card, "c", at(2, 0), at(3, 2), { handle: "size" });
  assert.deepEqual(place(card, "c"), { c: 2, r: 0, w: 2, h: 3 }); // a row was added under it each time
  assert.equal(byClass(card, "cell").length, 4 * 4);
});

test("arranging: a finger moves a card only by its grip; the keyboard works too", async () => {
  const card = await mount(three());
  click(card._btn);
  click(button(card, "Arrange…"));
  drag(card, "a", at(0, 0), at(5, 0), { pointerType: "touch" });
  assert.equal(place(card, "a").c, 0);
  drag(card, "a", at(0, 0), at(5, 0), { pointerType: "touch", handle: "grip" });
  assert.equal(place(card, "a").c, 5);
  const arr = kid(card, "a").arr;
  fire(arr, "keydown", { key: "ArrowRight" });
  fire(arr, "keydown", { key: "ArrowDown" });
  fire(arr, "keydown", { key: "ArrowRight", shiftKey: true });
  assert.deepEqual(place(card, "a"), { c: 6, r: 1, w: 2, h: 1 });
  fire(dom.win, "keydown", { key: "Escape" }); // leaves, keeping nothing
  assert.equal(card._arranging, false);
  assert.deepEqual(place(card, "a"), { c: 0, r: 0, w: 1, h: 1 });
});

test("arranging: columns and rows are added freely, removed only when empty", async () => {
  const card = await mount({ ...three(), columns: 3 });
  click(card._btn);
  click(button(card, "Arrange…"));
  const [colMinus, rowMinus] = all(card, (el) => el.localName === "button" && el.textContent === "−");
  const [colPlus] = all(card, (el) => el.localName === "button" && el.textContent === "+");
  click(colMinus);
  assert.match(byClass(card, "why")[0].textContent, /last column still has a card/);
  assert.equal(byClass(card, "cell").length, 3 * 2);
  click(colPlus);
  assert.equal(byClass(card, "cell").length, 4 * 2);
  click(rowMinus); // the spare row is empty
  assert.equal(byClass(card, "cell").length, 4);
  click(rowMinus);
  assert.match(byClass(card, "why")[0].textContent, /last row still has a card/);
  click(button(card, "Done"));
  await tick();
  assert.equal(card._grid.style.gridTemplateColumns, "repeat(4, minmax(0, 1fr))");
});

test("Reset goes back to the config's layout and forgets the user's", async () => {
  const mine = { grid: { cols: 6, rows: 1 }, tiles: [{ id: "a", c: 5, r: 0, w: 1, h: 1 }], list: ["c"] };
  const hass = fakeHass({ userData: { other: 1, layouts: { "/dashboard-test/home": mine, elsewhere: { list: ["x"] } } } });
  const card = await mount(three(), { hass });
  click(card._btn);
  click(button(card, "Arrange…"));
  click(button(card, "Reset"));
  await tick();
  assert.deepEqual(place(card, "a"), { c: 0, r: 0, w: 1, h: 1 });
  // the list's order is its own, and so are other pages' layouts
  assert.deepEqual(hass.userData.layouts["/dashboard-test/home"], { tiles: [], list: ["c"] });
  assert.deepEqual(hass.userData.layouts.elsewhere, { list: ["x"] });
  assert.equal(hass.userData.other, 1);
});

test("narrow: a list in an order of its own, reordered and saved apart from the grid", async () => {
  const grid = { grid: { cols: 4, rows: 1 }, tiles: [{ id: "c", c: 0, r: 0, w: 1, h: 1 }, { id: "a", c: 1, r: 0, w: 1, h: 1 }, { id: "b", c: 2, r: 0, w: 1, h: 1 }] };
  const hass = fakeHass({ userData: { layouts: { "/dashboard-test/home": grid } } });
  const card = await mount(three(), { width: 400, hass });
  const order = () => ["a", "b", "c"].sort((x, y) => kid(card, x).slot.style.order - kid(card, y).slot.style.order);
  assert.deepEqual(order(), ["c", "a", "b"]); // as the wide grid reads
  assert.equal(kid(card, "a").slot.style.gridColumn, "span 4"); // its width as in a section
  assert.equal(card._grid.style.gridTemplateColumns, "repeat(12, minmax(0, 1fr))");

  click(card._btn);
  click(button(card, "Arrange…"));
  assert.equal(byClass(card, "size").length, 0); // no resizing, no cells
  assert.equal(byClass(card, "cell").length, 0);
  click(byClass(kid(card, "b").arr, "up")[0]);
  assert.deepEqual(order(), ["c", "b", "a"]);
  // dropped on another card it takes that one's place
  kid(card, "c").slot.rect = { left: 0, top: 0, width: 100, height: 50 };
  kid(card, "b").slot.rect = { left: 100, top: 0, width: 100, height: 50 };
  kid(card, "a").slot.rect = { left: 200, top: 0, width: 100, height: 50 };
  drag(card, "a", [250, 25], [50, 25], { pointerType: "touch", handle: "grip" });
  assert.deepEqual(order(), ["a", "c", "b"]);
  click(button(card, "Done"));
  await tick();
  const saved = hass.userData.layouts["/dashboard-test/home"];
  assert.deepEqual(saved.list, ["a", "c", "b"]);
  assert.deepEqual(saved.grid, grid.grid);
  assert.deepEqual(saved.tiles, grid.tiles);
});

test("when Home Assistant does not take it, the browser keeps it and sends it next time", async () => {
  const hass = fakeHass({ failSet: true });
  const card = await mount(three(), { hass });
  click(card._btn);
  click(button(card, "Arrange…"));
  drag(card, "a", at(0, 0), at(9, 0));
  click(button(card, "Done"));
  await tick();
  assert.match(card._bar.textContent, /this browser only/);
  assert.equal(JSON.parse(dom.store.get("arrange-grid-card:layout:/dashboard-test/home")).unsent, true);

  const back = fakeHass();
  const again = await mount(three(), { hass: back });
  assert.equal(place(again, "a").c, 9);
  assert.equal(back.userData.layouts["/dashboard-test/home"].tiles.find((t) => t.id === "a").c, 9);
  assert.equal(JSON.parse(dom.store.get("arrange-grid-card:layout:/dashboard-test/home")).unsent, false);
});

test("storage: config keeps the arrangement in the dashboard, for an administrator", async () => {
  const config = { ...three(), storage: "config", layout: "main" };
  const lovelace = { views: [{ type: "panel", cards: [{ type: "markdown" }] }, { sections: [{ cards: [JSON.parse(JSON.stringify(config))] }] }] };
  const hass = fakeHass({ lovelace, userData: { layouts: { main: { grid: { cols: 2, rows: 1 }, tiles: [] } } } });
  const card = await mount(config, { hass });
  assert.equal(place(card, "b").c, 1); // the user's own is not looked at
  click(card._btn);
  click(button(card, "Arrange…"));
  drag(card, "a", at(0, 0), at(4, 0));
  click(button(card, "Done"));
  await tick();
  assert.ok(!hass.calls.some((m) => m.type.startsWith("frontend/")));
  const saved = hass.lovelace.views[1].sections[0].cards[0];
  assert.deepEqual(saved.default_layout.tiles.find((t) => t.id === "a"), { id: "a", c: 4, r: 0, w: 1, h: 1 });
  assert.equal(saved.cards.length, 3);
  assert.equal(place(card, "a").c, 4);

  const other = await mount(config, { hass: fakeHass({ admin: false, lovelace }) });
  click(other._btn);
  assert.equal(button(other, "Arrange…").disabled, true);
  other._arrEnter();
  assert.ok(!other._arranging);
});

test("storage: config on a dashboard that cannot be saved shows the layout to copy", async () => {
  const card = await mount({ ...three(), storage: "config" }, { hass: fakeHass() }); // (no dashboard to be had)
  click(card._btn);
  click(button(card, "Arrange…"));
  drag(card, "a", at(0, 0), at(4, 0));
  click(button(card, "Done"));
  await tick();
  const area = all(card, (el) => el.localName === "textarea")[0];
  assert.equal(JSON.parse(area.value).tiles.find((t) => t.id === "a").c, 4);
  assert.equal(place(card, "a").c, 4); // and it is shown as arranged meanwhile
});

test("the menu: right-click on a card, even one that swallows the event; Esc and the arrows", async () => {
  const hass = fakeHass();
  const card = await mount(three(), { hass });
  const b = kid(card, "b").el;
  b.addEventListener("contextmenu", (ev) => ev.stopPropagation()); // as Home Assistant's cards do
  const ev = fire(b, "contextmenu", { clientX: 2000, clientY: 30 });
  assert.equal(ev.defaultPrevented, true);
  const menu = byClass(card, "menu")[0];
  assert.match(byClass(menu, "head")[0].textContent, /^b · fake/);
  assert.equal(menu.style.left, `${1280 - 220 - 8}px`); // kept on screen
  assert.equal(dom.focused.textContent, "Hide this card");
  fire(dom.win, "keydown", { key: "ArrowDown" });
  assert.equal(dom.focused.textContent, "Arrange…");
  fire(dom.win, "keydown", { key: "ArrowUp" });
  click(dom.focused);
  await tick();
  assert.equal(byClass(card, "menu").length, 0);
  assert.equal(kid(card, "b").slot.hidden, true);
  assert.equal(b.isConnected, false); // off the page, so it plays nothing
  assert.deepEqual(hass.userData.layouts["/dashboard-test/home"].hidden, ["b"]);
  assert.equal(created[0].removals || 0, 0);
  assert.equal(place(card, "c").c, 1); // the others close up while nothing is arranged

  click(card._btn);
  click(button(card, "Show a hidden card…"));
  click(button(card, "b · fake"));
  await tick();
  assert.equal(b.parentNode, kid(card, "b").slot);
  assert.equal(hass.userData.layouts["/dashboard-test/home"], undefined); // nothing left of the user's own

  click(card._btn);
  assert.equal(byClass(card, "menu").length, 1);
  fire(dom.win, "keydown", { key: "Escape" });
  assert.equal(byClass(card, "menu").length, 0);
  assert.equal(dom.focused, card._btn); // back where it was opened from
});

test("the menu leaves alone: text fields, cards under a finger, a grid inside a card, context_menu: false", async () => {
  const card = await mount(three());
  const input = document.createElement("input");
  kid(card, "a").el.append(input);
  assert.equal(fire(input, "contextmenu").defaultPrevented, false);

  fire(kid(card, "a").el, "pointerdown", { pointerId: 1, pointerType: "touch", clientX: 5, clientY: 5 });
  mock.timers.tick(600);
  assert.equal(byClass(card, "menu").length, 0); // a long press on a card is the card's own
  fire(card._grid, "pointerdown", { pointerId: 1, pointerType: "touch", clientX: 5, clientY: 5 });
  mock.timers.tick(600);
  assert.equal(byClass(card, "menu").length, 1); // on an empty part of the page it opens
  fire(dom.win, "keydown", { key: "Escape" });
  fire(card._grid, "pointerdown", { pointerId: 1, pointerType: "touch", clientX: 5, clientY: 5 });
  fire(card._grid, "pointermove", { pointerId: 1, clientX: 5, clientY: 60 }); // scrolling
  mock.timers.tick(600);
  assert.equal(byClass(card, "menu").length, 0);

  const inner = document.createElement("arrange-grid-card");
  inner.setConfig({ cards: [small("x")] });
  kid(card, "c").el.append(inner);
  await tick();
  fire(inner._kids[0].el, "contextmenu", { clientX: 1, clientY: 1 });
  assert.equal(byClass(inner, "menu").length, 1);
  assert.equal(all(card, (el) => el.classList.contains("menu")).length, 1); // the inner one's only

  const quiet = await mount({ ...three(), context_menu: false, arrange_button: false });
  assert.equal(fire(kid(quiet, "a").el, "contextmenu").defaultPrevented, false);
  assert.equal(quiet._foot.hidden, true);
});

test("what Home Assistant's dashboard asks of a card", async () => {
  const stub = Card.getStubConfig();
  assert.equal(stub.type, "custom:arrange-grid-card");
  assert.deepEqual(stub.cards, []);
  assert.match(stub.layout, /^grid-/);
  assert.notEqual(stub.layout, Card.getStubConfig().layout);
  assert.equal(Card.getConfigElement().localName, "arrange-grid-card-editor");
  assert.equal(globalThis.customCards.filter((c) => c.type === "arrange-grid-card").length, 1);
  const listed = globalThis.customCards.find((c) => c.type === "arrange-grid-card");
  assert.ok(listed.name && listed.description && listed.preview === true);
  assert.match(Card.version, /^\d+\.\d+\.\d+$/);
  const card = await mount({ ...three(), row_height: 42, gap: 8 });
  assert.equal(card.getCardSize(), 1);
  assert.deepEqual(card.getGridOptions(), { columns: "full", min_columns: 6 });
  const empty = await mount(stub);
  assert.match(byClass(empty, "empty")[0].textContent, /No cards yet/);
  assert.equal(byClass(empty, "empty")[0].hidden, false);
});

// ------------------------------------------------------------- the editor

// Home Assistant's own picker and card editor, as far as ours uses them.
class FakeSub extends Element {
  set value(v) {
    this.values = [...(this.values || []), v];
  }
  toggleMode() {
    this.toggled = true;
  }
}

function editor(config, hass = fakeHass()) {
  const ed = document.createElement("arrange-grid-card-editor");
  const out = [];
  ed.addEventListener("config-changed", (ev) => out.push(ev.detail.config));
  ed.hass = hass;
  ed.lovelace = { config: {} };
  ed.setConfig(config);
  document.body.append(ed);
  return { ed, out, last: () => out[out.length - 1] };
}

test("editor: cards are added with the picker and edited with their own editor, the id staying ours", async () => {
  customElements.define("hui-card-picker", class extends Element {});
  customElements.define("hui-card-element-editor", FakeSub);
  const { ed, out, last } = editor({ type: "custom:arrange-grid-card", cards: [{ id: "a", type: "tile", entity: "light.x" }] });
  click(button(ed, "Add card"));
  await tick();
  const picker = all(ed, (el) => el.localName === "hui-card-picker")[0];
  assert.ok(picker.hass && picker.lovelace);
  const bubbled = [];
  document.body.addEventListener("config-changed", (ev) => bubbled.push(ev.detail.config));
  fire(picker, "config-changed", {}, { detail: { config: { type: "button", entity: "light.y" } } });
  await tick();
  assert.equal(last().cards.length, 2);
  assert.match(last().cards[1].id, /^c[a-z0-9]+$/);
  assert.equal(bubbled.every((c) => c.type === "custom:arrange-grid-card"), true); // the picker's own event stops here

  // straight on to the new card's editor, which never sees the id
  const sub = all(ed, (el) => el.localName === "hui-card-element-editor")[0];
  assert.deepEqual(sub.values, [{ type: "button", entity: "light.y" }]);
  fire(sub, "config-changed", {}, { detail: { config: { type: "button", entity: "light.z" } } });
  assert.deepEqual(last().cards[1], { id: last().cards[1].id, type: "button", entity: "light.z" });
  ed.setConfig(last()); // Home Assistant hands the config back: the editor is not reset
  assert.equal(sub.values.length, 1);
  click(button(ed, "Show code editor"));
  assert.equal(sub.toggled, true);
  click(button(ed, "Back"));

  const before = out.length;
  click(all(ed, (el) => el.title === "Remove")[0]);
  assert.equal(out.length, before + 1);
  assert.deepEqual(last().cards.map((c) => c.type), ["button"]);
});

test("editor: moving cards gives those without an id one first, so places stay with their cards", () => {
  const { ed, last } = editor({ type: "custom:arrange-grid-card", cards: [{ type: "one" }, { type: "two" }, { id: "k", type: "three" }] });
  click(all(ed, (el) => el.title === "Move down")[0]);
  assert.deepEqual(last().cards.map((c) => c.type), ["two", "one", "three"]);
  assert.ok(last().cards.every((c) => typeof c.id === "string"));
  assert.equal(new Set(last().cards.map((c) => c.id)).size, 3);
  assert.equal(all(ed, (el) => el.title === "Move up")[0].disabled, true);
});

test("editor: the grid's options, without writing the defaults out", () => {
  const { ed, last } = editor({ type: "custom:arrange-grid-card", cards: [] });
  const form = all(ed, (el) => el.localName === "ha-form")[0];
  assert.equal(form.data.columns, 12);
  assert.equal(form.computeLabel({ name: "columns" }), "Columns of a new arrangement");
  fire(form, "value-changed", {}, { detail: { value: { ...form.data, columns: 24, storage: "config", layout: "" } } });
  assert.deepEqual(last(), { type: "custom:arrange-grid-card", cards: [], columns: 24, storage: "config" });
});

test("editor: the user's own arrangement becomes the config's default, and can be removed", async () => {
  const mine = { grid: { cols: 3, rows: 1 }, tiles: [{ id: "a", c: 2, r: 0, w: 1, h: 1 }] };
  const hass = fakeHass({ userData: { layouts: { main: mine } } });
  const { ed, last } = editor({ type: "custom:arrange-grid-card", layout: "main", cards: [small("a")] }, hass);
  click(button(ed, "Use my arrangement as the default"));
  await tick();
  assert.deepEqual(last().default_layout, mine);
  assert.match(byClass(ed, "saved")[0].textContent, /3 × 1 cells, 1 cards placed/);
  click(button(ed, "Remove the default"));
  assert.equal("default_layout" in last(), false);

  const none = editor({ type: "custom:arrange-grid-card", layout: "other", cards: [] }, hass);
  click(button(none.ed, "Use my arrangement as the default"));
  await tick();
  assert.equal(none.out.length, 0);
  assert.match(byClass(none.ed, "err")[0].textContent, /no arrangement of this page yet/);
});

test("editor: without Home Assistant's editors a card is edited as text", async () => {
  dom.registry.delete("hui-card-picker");
  dom.registry.delete("hui-card-element-editor");
  const { ed, last } = editor({ type: "custom:arrange-grid-card", cards: [{ id: "a", type: "tile", entity: "light.x" }] });
  click(all(ed, (el) => el.title === "Edit")[0]);
  await tick();
  mock.timers.tick(3100); // (it waited for Home Assistant's editors first)
  await tick();
  const area = all(ed, (el) => el.localName === "textarea")[0];
  assert.deepEqual(JSON.parse(area.value), { type: "tile", entity: "light.x" });
  area.value = '{"type": "tile", "entity": "light.q"}';
  fire(area, "input");
  assert.deepEqual(last().cards[0], { id: "a", type: "tile", entity: "light.q" });
  area.value = "{nope";
  fire(area, "input");
  assert.match(byClass(ed, "err").map((e) => e.textContent).join(""), /Not saved/);
  assert.equal(last().cards[0].entity, "light.q");
});
