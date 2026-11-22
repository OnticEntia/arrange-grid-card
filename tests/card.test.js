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
    const el = document.createElement(config.type === "custom:arrange-grid-card" ? "arrange-grid-card" : "fake-card");
    el.setConfig(config);
    created.push(el);
    return el;
  },
  createBadgeElement(config) {
    const el = document.createElement("fake-card");
    el.setConfig(config);
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
  dom.session.clear();
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
  assert.equal(byClass(card, "cell").length, 12); // the row in use: the grid at its real size
  const a = created[0];
  // a spare row to drop into is there for as long as something is dragged
  fire(kid(card, "b").arr, "pointerdown", { pointerId: 1, button: 0, pointerType: "mouse", clientX: 150, clientY: 25 });
  assert.equal(byClass(card, "cell").length, 12);
  fire(kid(card, "b").arr, "pointermove", { pointerId: 1, clientX: 160, clientY: 30 });
  assert.equal(byClass(card, "cell").length, 12 * 2);
  fire(kid(card, "b").arr, "pointerup", { pointerId: 1, clientX: 160, clientY: 30 });
  assert.equal(byClass(card, "cell").length, 12);
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
  assert.equal(byClass(card, "cell").length, 4 * 3); // and no spare one is left behind
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

test("arranging: the keyboard moves a card below the last row, which makes one", async () => {
  const card = await mount(three());
  click(card._btn);
  click(button(card, "Arrange…"));
  fire(kid(card, "a").arr, "keydown", { key: "ArrowDown" });
  assert.equal(place(card, "a").r, 1);
  assert.equal(byClass(card, "cell").length, 12 * 2);
});

test("arranging: columns and rows are added freely, removed only when empty", async () => {
  const card = await mount({ ...three(), columns: 3 });
  click(card._btn);
  click(button(card, "Arrange…"));
  const [colMinus, rowMinus] = all(card, (el) => el.localName === "button" && el.textContent === "−");
  const [colPlus, rowPlus] = all(card, (el) => el.localName === "button" && el.textContent === "+");
  click(colMinus);
  assert.match(byClass(card, "why")[0].textContent, /last column still has a card/);
  assert.equal(byClass(card, "cell").length, 3);
  click(colPlus);
  assert.equal(byClass(card, "cell").length, 4);
  click(rowPlus); // a row added by hand stays, drag or no drag
  assert.equal(byClass(card, "cell").length, 4 * 2);
  drag(card, "a", at(0, 0), at(3, 0));
  assert.equal(byClass(card, "cell").length, 4 * 2);
  click(rowMinus); // it is empty
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

// ----------------------------------------------------------------- groups

const head = (id) => ({ id, type: "heading", heading: id, grid_options: { columns: 12, rows: 1 } });
const grouped = () => ({ type: "custom:arrange-grid-card", cards: [head("h1"), small("a"), small("b"), head("h2"), small("c")] });

test("groups: a selected group moves as one, and only where all of it has room", async () => {
  const card = await mount(grouped());
  assert.deepEqual(["h1", "a", "b", "h2", "c"].map((k) => place(card, k).c), [0, 3, 4, 5, 8]);
  click(card._btn);
  click(button(card, "Arrange…"));
  assert.match(card._bar.textContent, /selects its group/);
  const pick = byClass(kid(card, "h1").arr, "pick")[0];
  assert.equal(byClass(kid(card, "a").arr, "pick").length, 0); // only a group's heading has one
  click(pick);
  assert.equal(pick.getAttribute("aria-pressed"), "true");
  assert.deepEqual(["h1", "a", "b", "h2", "c"].map((k) => kid(card, k).arr.classList.contains("sel")), [true, true, true, false, false]);

  drag(card, "a", at(3, 0), at(3, 1)); // held by one of its cards, one row down
  assert.deepEqual(["h1", "a", "b"].map((k) => [place(card, k).c, place(card, k).r]), [[0, 1], [3, 1], [4, 1]]);
  assert.deepEqual([place(card, "h2").r, place(card, "c").r], [0, 0]);

  const arr = kid(card, "b").arr;
  fire(arr, "keydown", { key: "ArrowLeft" }); // the heading is at the edge already
  assert.equal(place(card, "h1").c, 0);
  assert.match(byClass(card, "why")[0].textContent, /No room for the group/);
  for (let i = 0; i < 3; i++) fire(arr, "keydown", { key: "ArrowRight" });
  assert.deepEqual(["h1", "a", "b"].map((k) => place(card, k).c), [3, 6, 7]);
  fire(arr, "keydown", { key: "ArrowUp" }); // onto the other group's heading
  assert.equal(place(card, "h1").r, 1);
  assert.match(byClass(card, "why")[0].textContent, /No room for the group/);
  drag(card, "h1", at(3, 1), at(0, 1)); // far left, held by its heading: stops at the edge
  assert.deepEqual(["h1", "a", "b"].map((k) => place(card, k).c), [0, 3, 4]);

  click(pick); // nothing selected: a card moves alone again
  drag(card, "a", at(3, 1), at(10, 1));
  assert.deepEqual([place(card, "a").c, place(card, "h1").c, place(card, "b").c], [10, 0, 4]);
});

test("groups: in the list a group folds shut, per user, and only there", async () => {
  const hass = fakeHass();
  const card = await mount(grouped(), { width: 400, hass });
  const fold = byClass(kid(card, "h1").slot, "fold")[0];
  assert.equal(fold.getAttribute("aria-expanded"), "true");
  assert.equal(byClass(kid(card, "a").slot, "fold").length, 0);
  click(fold);
  await tick();
  assert.deepEqual(["h1", "a", "b", "h2", "c"].map((k) => kid(card, k).slot.hidden), [false, true, true, false, false]);
  assert.equal(fold.getAttribute("aria-expanded"), "false");
  assert.deepEqual(hass.userData.layouts["/dashboard-test/home"].folded, ["h1"]);
  assert.equal(created[1].removals || 0, 0); // still there, just not shown

  const wide = await mount(grouped(), { hass });
  assert.equal(kid(wide, "a").slot.hidden, false); // the wide grid shows everything
  assert.ok(byClass(wide, "fold").every((b) => b.hidden));

  click(fold);
  await tick();
  assert.equal(kid(card, "a").slot.hidden, false);
  assert.equal(hass.userData.layouts["/dashboard-test/home"], undefined);

  const plain = await mount({ ...grouped(), groups: false }, { width: 400 });
  assert.equal(byClass(plain, "fold").length, 0);
});

test("groups: with storage: config what is folded stays in the browser", async () => {
  const hass = fakeHass();
  const card = await mount({ ...grouped(), storage: "config", layout: "g" }, { width: 400, hass });
  click(byClass(kid(card, "h2").slot, "fold")[0]);
  await tick();
  assert.equal(kid(card, "c").slot.hidden, true);
  assert.equal(hass.calls.length, 0);
  const again = await mount({ ...grouped(), storage: "config", layout: "g" }, { width: 400, hass });
  assert.equal(kid(again, "c").slot.hidden, true);
});

test("groups: ordering the list, a heading takes its cards along and steps over whole groups", async () => {
  const hass = fakeHass();
  const card = await mount(grouped(), { width: 400, hass });
  const order = () => ["h1", "a", "b", "h2", "c"].sort((x, y) => kid(card, x).slot.style.order - kid(card, y).slot.style.order);
  click(card._btn);
  click(button(card, "Arrange…"));
  click(byClass(kid(card, "h1").arr, "down")[0]);
  assert.deepEqual(order(), ["h2", "c", "h1", "a", "b"]);
  click(byClass(kid(card, "b").arr, "up")[0]); // a card on its own: one place
  assert.deepEqual(order(), ["h2", "c", "h1", "b", "a"]);
  click(byClass(kid(card, "h1").arr, "up")[0]);
  assert.deepEqual(order(), ["h1", "b", "a", "h2", "c"]);
  click(byClass(kid(card, "h1").arr, "up")[0]); // first already
  assert.deepEqual(order(), ["h1", "b", "a", "h2", "c"]);
  // dropped on a card of another group, the block goes there
  for (const [k, i] of [["h1", 0], ["b", 1], ["a", 2], ["h2", 3], ["c", 4]]) kid(card, k).slot.rect = { left: 0, top: i * 50, width: 300, height: 50 };
  drag(card, "h2", [10, 175], [10, 25], { pointerType: "touch", handle: "grip" });
  assert.deepEqual(order(), ["h2", "c", "h1", "b", "a"]);
  click(button(card, "Done"));
  await tick();
  assert.deepEqual(hass.userData.layouts["/dashboard-test/home"].list, ["h2", "c", "h1", "b", "a"]);
});

test("groups: the menu hides a whole group, and its heading brings it back", async () => {
  const hass = fakeHass();
  const card = await mount(grouped(), { hass });
  fire(kid(card, "a").el, "contextmenu", { clientX: 10, clientY: 10 });
  click(button(card, "Hide this group"));
  await tick();
  assert.deepEqual(["h1", "a", "b", "h2", "c"].map((k) => kid(card, k).slot.hidden), [true, true, true, false, false]);
  assert.deepEqual(hass.userData.layouts["/dashboard-test/home"].hidden, ["h1", "a", "b"]);

  click(card._btn);
  click(button(card, "Show a hidden card…"));
  click(all(card, (el) => el.localName === "button" && /^h1 /.test(el.textContent))[0]);
  await tick();
  assert.ok(["h1", "a", "b"].every((k) => !kid(card, k).slot.hidden));

  const plain = await mount(three(), { hass: fakeHass() });
  fire(kid(plain, "b").el, "contextmenu", { clientX: 10, clientY: 10 });
  assert.equal(all(plain, (el) => el.textContent === "Hide this group").length, 0);
});

test("editor: a group is removed in one press", () => {
  const cards = [{ id: "h1", type: "heading" }, { id: "a", type: "one" }, { id: "b", type: "two" }, { id: "h2", type: "heading" }, { id: "c", type: "three" }, { id: "h3", type: "heading" }];
  const { ed, last } = editor({ type: "custom:arrange-grid-card", cards });
  const sweep = all(ed, (el) => /^Remove the group/.test(el.title || ""));
  assert.equal(sweep.length, 2); // not on a heading with nothing under it
  click(sweep[0]);
  assert.deepEqual(last().cards.map((c) => c.id), ["h2", "c", "h3"]);
  const off = editor({ type: "custom:arrange-grid-card", groups: false, cards });
  assert.equal(all(off.ed, (el) => /^Remove the group/.test(el.title || "")).length, 0);
});

const group = (id, title, cards) => ({ id, type: "custom:arrange-grid-card", title, cards });
const nestedPage = () => ({ type: "custom:arrange-grid-card", cards: [group("lights", "Lights", [small("x"), small("y"), group("room", "Room", [small("z")])]), small("a")] });

test("nested groups: a grid card inside another is a box with a title and an arrangement of its own", async () => {
  const hass = fakeHass();
  const card = await mount(nestedPage(), { hass });
  await tick();
  const lights = kid(card, "lights").el;
  assert.equal(lights.localName, "arrange-grid-card");
  assert.equal(lights._config.name, "/dashboard-test/home/lights");
  assert.equal(lights.getAttribute("nested"), "");
  assert.equal(byClass(lights, "head")[0].hidden, false);
  assert.equal(byClass(lights, "title")[0].textContent, "Lights");
  assert.equal(lights._foot.hidden, true); // no button of its own
  assert.equal(byClass(card, "head")[0].hidden, true); // the page has no title
  // inside, a section's 12 columns are the whole group
  assert.deepEqual([place(lights, "x"), place(lights, "y")].map((p) => [p.c, p.w]), [[0, 4], [4, 4]]);
  assert.equal(place(lights, "room").w, 12);
  const room = kid(lights, "room").el;
  assert.equal(room._config.name, "/dashboard-test/home/lights/room");
  // in the outer grid it is one card, as wide as a section
  assert.equal(place(card, "lights").w, 3);

  // arranged inside: kept under the group's own name, the page's untouched
  fire(kid(lights, "x").el, "contextmenu", { clientX: 10, clientY: 10 });
  assert.ok(!card._menu && lights._menu); // the group answers for itself
  click(button(lights, "Arrange inside this group…"));
  drag(lights, "x", at(0, 0), at(8, 0));
  click(button(lights, "Done"));
  await tick();
  assert.equal(place(lights, "x").c, 8);
  assert.deepEqual(Object.keys(hass.userData.layouts), ["/dashboard-test/home/lights"]);
  // and the page's own save does not lose it
  click(card._btn);
  click(button(card, "Arrange…"));
  drag(card, "a", at(3, 0), at(6, 0));
  click(button(card, "Done"));
  await tick();
  assert.deepEqual(Object.keys(hass.userData.layouts).sort(), ["/dashboard-test/home", "/dashboard-test/home/lights"]);
});

test("nested groups: the page decides grid or list for them, and in the list they fold shut", async () => {
  const hass = fakeHass();
  const card = await mount(nestedPage(), { width: 400, hass });
  await tick();
  const lights = kid(card, "lights").el;
  const room = kid(lights, "room").el;
  assert.ok(lights._grid.classList.contains("list") && room._grid.classList.contains("list"));
  const fold = byClass(lights, "shutter")[0];
  assert.equal(fold.hidden, false);
  click(fold);
  await tick();
  assert.equal(lights._grid.hidden, true);
  assert.equal(fold.getAttribute("aria-expanded"), "false");
  assert.deepEqual(hass.userData.layouts["/dashboard-test/home"].folded, ["lights"]);
  click(byClass(lights, "head")[0]); // the title opens it again
  await tick();
  assert.equal(lights._grid.hidden, false);
  click(byClass(room, "shutter")[0]); // a group in a group, on its own
  await tick();
  assert.deepEqual([room._grid.hidden, lights._grid.hidden], [true, false]);
  assert.deepEqual(hass.userData.layouts["/dashboard-test/home/lights"].folded, ["room"]);

  const wide = await mount(nestedPage(), { hass });
  await tick();
  const w = kid(wide, "lights").el;
  assert.equal(w._grid.classList.contains("list"), false);
  assert.equal(byClass(w, "shutter")[0].hidden, true); // nothing folds on the wide grid
  assert.equal(kid(w, "room").el._grid.hidden, false);
});

test("nested groups: the group's menu reaches the page, and the editor adds one", async () => {
  const hass = fakeHass();
  const card = await mount(nestedPage(), { hass });
  await tick();
  const lights = kid(card, "lights").el;
  fire(lights._grid, "contextmenu", { clientX: 10, clientY: 10 });
  assert.ok(lights._menu && !card._menu);
  click(button(lights, "Hide this group"));
  await tick();
  assert.equal(kid(card, "lights").slot.hidden, true);
  assert.deepEqual(hass.userData.layouts["/dashboard-test/home"].hidden, ["lights"]);

  const { ed, last } = editor({ type: "custom:arrange-grid-card", cards: [{ id: "k", type: "one" }] });
  click(button(ed, "Add group"));
  const added = last().cards[1];
  assert.deepEqual([added.type, added.title, added.cards], ["custom:arrange-grid-card", "New group", []]);
  assert.equal(typeof added.id, "string");
});

// The page as the dashboard has it, so that the card can find itself there.
async function onDashboard(config, opts = {}) {
  const hass = fakeHass({ lovelace: { views: [{ cards: [config] }] }, ...opts });
  const card = await mount(config, { hass });
  await tick();
  return { hass, card, saved: () => hass.lovelace.views[0].cards[0] };
}
const ids = (node) => node.cards.map((c) => c.id);

test("moving between groups: the menu lists the page's groups and rewrites the dashboard", async () => {
  const { hass, card, saved } = await onDashboard(nestedPage());
  const lights = kid(card, "lights").el;
  fire(kid(lights, "x").el, "contextmenu", { clientX: 10, clientY: 10 });
  click(button(lights, "Move to…"));
  assert.deepEqual(all(byClass(lights, "menu")[0], (el) => el.localName === "button").map((el) => el.textContent), ["The page", "Lights › Room"]);
  click(button(lights, "Lights › Room"));
  await tick();
  assert.deepEqual(ids(saved()), ["lights", "a"]);
  assert.deepEqual(ids(saved().cards[0]), ["y", "room"]);
  assert.deepEqual(ids(saved().cards[0].cards[1]), ["z", "x"]);
  assert.match(card._bar.textContent, /moved to Room/);
  assert.equal(saved().cards[0].nested, undefined); // nothing of the card's own making is written

  // out to the page, where the id is taken already: it gets one of its own
  const taken = nestedPage();
  taken.cards[0].cards[0].id = "a";
  const two = await onDashboard(taken);
  const g = kid(two.card, "lights").el;
  fire(kid(g, "a").el, "contextmenu", { clientX: 10, clientY: 10 });
  click(button(g, "Move to…"));
  click(button(g, "The page"));
  await tick();
  assert.deepEqual(ids(two.saved()), ["lights", "a", "a-2"]);

  // a whole group, from its own menu; never into itself
  const three_ = await onDashboard(nestedPage());
  const room = kid(kid(three_.card, "lights").el, "room").el;
  fire(room._grid, "contextmenu", { clientX: 10, clientY: 10 });
  click(button(room, "Move this group to…"));
  assert.deepEqual(all(byClass(room, "menu")[0], (el) => el.localName === "button").map((el) => el.textContent), ["The page"]);
  click(button(room, "The page"));
  await tick();
  assert.deepEqual(ids(three_.saved()), ["lights", "a", "room"]);
});

test("one Arrange for the page and its groups: every card can be taken hold of, one bar, one Done", async () => {
  const hass = fakeHass();
  const card = await mount(nestedPage(), { hass });
  await tick();
  const lights = kid(card, "lights").el;
  const room = kid(lights, "room").el;
  click(card._btn);
  click(button(card, "Arrange…"));
  assert.deepEqual([card._arranging, lights._arranging, room._arranging], [true, true, true]);
  assert.deepEqual([card._bar.hidden, lights._bar.hidden, room._bar.hidden], [false, true, true]);
  assert.ok(kid(card, "lights").arr.classList.contains("frame")); // the group's own overlay leaves its cards free
  assert.equal(kid(card, "a").arr.classList.contains("frame"), false);
  // the page's cells are not drawn under a group, which draws its own
  const under = card._arrCellEls.filter((c) => c.classList.contains("under")).map((c) => parseInt(c.style.gridColumn, 10) - 1);
  assert.deepEqual([...new Set(under)].sort((x, y) => x - y), [0, 1, 2]);
  assert.equal(lights._arrCellEls.some((c) => c.classList.contains("under")), true); // (its own, under the group in it)
  assert.equal(kid(lights, "room").el._arrCellEls.some((c) => c.classList.contains("under")), false);
  drag(lights, "x", at(0, 0), at(8, 0)); // a card inside a group, without opening the group first
  assert.equal(place(lights, "x").c, 8);
  fire(kid(lights, "x").arr, "keydown", { key: "ArrowRight" }); // at the edge already
  assert.equal(place(lights, "x").c, 8);
  click(button(card, "Done"));
  await tick();
  assert.deepEqual([card._arranging, lights._arranging, room._arranging], [false, false, false]);
  // the group that was changed keeps its arrangement; the one nobody touched keeps none
  assert.deepEqual(Object.keys(hass.userData.layouts).sort(), ["/dashboard-test/home", "/dashboard-test/home/lights"]);
  assert.equal(hass.userData.layouts["/dashboard-test/home/lights"].tiles.find((t) => t.id === "x").c, 8);

  click(card._btn);
  click(button(card, "Arrange…"));
  drag(lights, "x", at(8, 0), at(0, 0));
  assert.equal(place(lights, "x").c, 0);
  fire(dom.win, "keydown", { key: "Escape" }); // Cancel is for all of it
  assert.equal(lights._arranging, false);
  assert.equal(place(lights, "x").c, 8);
});

test("one Arrange: right-click on a group's title sizes its grid; Done fits each group to its cards", async () => {
  const hass = fakeHass();
  const page = nestedPage();
  page.default_layout = { grid: { cols: 12, rows: 9 }, tiles: [{ id: "lights", c: 0, r: 0, w: 6, h: 9 }, { id: "a", c: 6, r: 0, w: 1, h: 1 }] };
  const card = await mount(page, { hass });
  await tick();
  const lights = kid(card, "lights").el;
  click(card._btn);
  click(button(card, "Arrange…"));
  const ev = fire(byClass(kid(card, "lights").arr, "grip")[0], "contextmenu", { clientX: 10, clientY: 10 });
  assert.equal(ev.defaultPrevented, true);
  const items = () => all(byClass(card, "menu")[0], (el) => el.localName === "button").map((el) => el.textContent);
  assert.deepEqual(items(), ["Columns: 12  ·  one more", "Columns: one fewer", `Rows: ${lights._arrEdit.grid.rows}  ·  one more`, "Rows: one fewer", "Fit the group's height to its cards", "Add card here…", "Add group inside…", "Delete this group"]);
  click(button(card, "Columns: 12  ·  one more"));
  assert.equal(lights._arrEdit.grid.cols, 13);
  assert.equal(items()[0], "Columns: 13  ·  one more"); // the menu stays, with the new count
  fire(dom.win, "keydown", { key: "Escape" });
  assert.equal(card._arranging, true); // Esc closed the menu, not Arrange

  // inside the group, on an empty part: the same for that grid
  fire(lights._grid, "contextmenu", { clientX: 10, clientY: 10 });
  assert.equal(all(byClass(lights, "menu")[0], (el) => el.localName === "button")[0].textContent, "Columns: 13  ·  one more");
  click(button(lights, "Fit the group's height to its cards"));
  const need = lights._groupRows(true); // as it is drawn while arranging, spare row and all
  assert.ok(need < 9);
  assert.equal(place(card, "lights").h, need);

  // and it cannot be made shorter than that by hand: its rows would stretch, and the neighbours with them
  fire(kid(card, "lights").arr, "keydown", { key: "ArrowUp", shiftKey: true });
  assert.equal(place(card, "lights").h, need);
  assert.match(byClass(card, "why")[0].textContent, /as short as it goes/);
  fire(kid(card, "lights").arr, "keydown", { key: "ArrowDown", shiftKey: true }); // taller is fine
  assert.equal(place(card, "lights").h, need + 1);
  // an ordinary card is measured on screen
  kid(card, "a").slot.scrollHeight = 150; // what is in it needs three rows
  for (let i = 0; i < 4; i++) fire(kid(card, "a").arr, "keydown", { key: "ArrowDown", shiftKey: true });
  assert.equal(place(card, "a").h, 5);
  for (let i = 0; i < 4; i++) fire(kid(card, "a").arr, "keydown", { key: "ArrowUp", shiftKey: true });
  assert.equal(place(card, "a").h, 3);
  click(button(card, "Cancel"));

  // and Done does it for every group by itself
  const other = await mount(page, { hass: fakeHass() });
  await tick();
  click(other._btn);
  click(button(other, "Arrange…"));
  assert.equal(place(other, "lights").h, kid(other, "lights").el._groupRows(true)); // its box follows it at once
  click(button(other, "Done"));
  await tick();
  assert.equal(place(other, "lights").h, kid(other, "lights").el._groupRows());
});

test("one Arrange: a card too short for what is in it gets the rows it needs, and what is under it moves down", async () => {
  const page = { ...three(), default_layout: { grid: { cols: 12, rows: 5 }, tiles: [{ id: "a", c: 0, r: 0, w: 2, h: 1 }, { id: "b", c: 1, r: 1, w: 2, h: 1 }, { id: "c", c: 2, r: 4, w: 1, h: 1 }] } };
  const card = await mount(page, { hass: fakeHass() });
  kid(card, "a").slot.scrollHeight = 200; // four rows' worth: until now its row was stretched to hold it
  click(card._btn);
  click(button(card, "Arrange…"));
  assert.deepEqual([place(card, "a").r, place(card, "a").h], [0, 4]);
  assert.deepEqual([place(card, "b").r, place(card, "c").r], [4, 5]); // b was under it, and lands on c, which moves in turn
  assert.equal(overlaps(card._arrEdit.tiles), false);
  assert.deepEqual(L.push({ tiles: [] }, { c: 0, r: 498, w: 1, h: 1 }, 5), null); // never past the last row
});

test("one Arrange: a group is added from the menu while arranging, and Cancel takes it away again", async () => {
  const { hass, card, saved } = await onDashboard(nestedPage());
  const before = JSON.stringify(saved());
  click(card._btn);
  click(button(card, "Arrange…"));
  fire(card._grid, "contextmenu", { clientX: 10, clientY: 10 });
  click(button(card, "Add group…"));
  const field = all(byClass(card, "menu")[0], (el) => el.localName === "input")[0];
  field.value = "Kitchen";
  fire(field, "keydown", { key: "Enter" });
  await tick();
  assert.deepEqual(ids(saved()), ["lights", "a", "kitchen"]);
  document.body.replaceChildren(); // the page is redrawn: Arrange is open again
  const again = await mount(saved(), { hass });
  await tick();
  assert.equal(again._arranging, true);
  // inside a group, from its title bar
  fire(byClass(kid(again, "lights").arr, "grip")[0], "contextmenu", { clientX: 10, clientY: 10 });
  click(button(again, "Add group inside…"));
  all(byClass(again, "menu")[0], (el) => el.localName === "input")[0].value = "Desk";
  click(button(again, "Add"));
  await tick();
  assert.deepEqual(ids(saved().cards[0]), ["x", "y", "room", "desk"]);
  document.body.replaceChildren();
  const third = await mount(saved(), { hass });
  await tick();
  click(button(third, "Cancel"));
  await tick();
  await tick();
  assert.equal(JSON.stringify(saved()), before);
});

test("one Arrange: while dragging, only the grid under the pointer has a spare row", async () => {
  const card = await mount(nestedPage(), { hass: fakeHass() });
  await tick();
  const lights = kid(card, "lights").el;
  card.rect = { left: 0, top: 0, width: 1200, height: 600 };
  lights.rect = { left: 0, top: 0, width: 300, height: 300 };
  click(card._btn);
  click(button(card, "Arrange…"));
  const rows = () => [card._arrEdit.grid.rows, lights._arrEdit.grid.rows];
  const before = rows();
  const arr = kid(card, "a").arr;
  fire(arr, "pointerdown", { pointerId: 1, button: 0, pointerType: "mouse", clientX: 350, clientY: 25 });
  fire(arr, "pointermove", { pointerId: 1, clientX: 700, clientY: 30 }); // over the page
  assert.ok(card._arrEdit.grid.rows > L.bottom(card._arrEdit.tiles)); // an empty row under the page's last card
  assert.equal(lights._arrEdit.grid.rows, before[1]); // and none in the group
  fire(arr, "pointermove", { pointerId: 1, clientX: 150, clientY: 150 }); // over the group
  assert.deepEqual(rows(), [before[0], before[1] + 1]);
  fire(arr, "pointermove", { pointerId: 1, clientX: 700, clientY: 30 });
  fire(arr, "pointerup", { pointerId: 1, clientX: 700, clientY: 30 });
  assert.deepEqual(rows(), before); // and none once it is let go
});

test("one Arrange: a card dropped on another group lands where it was dropped, Arrange goes on, Cancel takes it back", async () => {
  const { hass, card, saved } = await onDashboard(nestedPage());
  const before = JSON.stringify(saved());
  const lights = kid(card, "lights").el;
  card.rect = { left: 0, top: 0, width: 1200, height: 600 };
  lights.rect = { left: 0, top: 0, width: 1200, height: 300 };
  click(card._btn);
  click(button(card, "Arrange…"));
  drag(card, "a", at(3, 0), at(8, 0)); // onto the group, at its free cell 8, 0
  await tick();
  assert.deepEqual(ids(saved().cards[0]), ["x", "y", "room", "a"]);
  const tile = hass.userData.layouts["/dashboard-test/home/lights"].tiles.find((t) => t.id === "a");
  assert.deepEqual([tile.c, tile.r, tile.w], [8, 0, 4]); // and at a section's size in there, not the page's

  // Home Assistant redraws the page from the new config: Arrange is open again
  document.body.replaceChildren();
  const again = await mount(saved(), { hass });
  await tick();
  const g = kid(again, "lights").el;
  assert.deepEqual([again._arranging, g._arranging], [true, true]);
  assert.deepEqual([place(g, "a").c, place(g, "a").r], [8, 0]);
  click(button(again, "Cancel"));
  await tick();
  await tick();
  assert.equal(JSON.stringify(saved()), before); // back in its group
  assert.equal(hass.userData.layouts["/dashboard-test/home/lights"], undefined); // and the arrangements as they were

  // Done instead: it stays, and a reload does not open Arrange again
  dom.session.clear();
  const two = await onDashboard(nestedPage());
  two.card.rect = { left: 0, top: 0, width: 1200, height: 600 };
  kid(two.card, "lights").el.rect = { left: 0, top: 0, width: 1200, height: 300 };
  click(two.card._btn);
  click(button(two.card, "Arrange…"));
  drag(two.card, "a", at(3, 0), at(8, 0));
  await tick();
  document.body.replaceChildren();
  const next = await mount(two.saved(), { hass: two.hass });
  await tick();
  click(button(next, "Done"));
  await tick();
  document.body.replaceChildren();
  const later = await mount(two.saved(), { hass: two.hass });
  await tick();
  assert.ok(!later._arranging);
  assert.deepEqual(ids(two.saved().cards[0]), ["x", "y", "room", "a"]);
});

test("one Arrange in the list: a row dragged onto another group goes into it, at the row it was dropped on", async () => {
  const { hass, card, saved } = await onDashboard(nestedPage(), {});
  document.body.replaceChildren();
  const narrow = await mount(saved(), { width: 400, hass });
  await tick();
  const lights = kid(narrow, "lights").el;
  narrow.rect = { left: 0, top: 0, width: 400, height: 900 };
  lights.rect = { left: 0, top: 0, width: 400, height: 400 };
  kid(lights, "y").slot.rect = { left: 0, top: 100, width: 400, height: 50 };
  click(narrow._btn);
  click(button(narrow, "Arrange…"));
  assert.ok(lights._arranging && lights._arrMode === "list");
  drag(narrow, "a", [10, 500], [10, 120], { pointerType: "touch", handle: "grip" });
  await tick();
  assert.deepEqual(ids(saved().cards[0]), ["x", "y", "room", "a"]);
  assert.deepEqual(hass.userData.layouts["/dashboard-test/home/lights"].list, ["x", "a", "y", "room"]);
});

test("adding a group from the menu: on the page or inside a group, with an id made from its title", async () => {
  const { card, saved } = await onDashboard(nestedPage());
  click(card._btn);
  click(button(card, "Add group…"));
  const field = all(byClass(card, "menu")[0], (el) => el.localName === "input")[0];
  field.value = "Dining Room";
  fire(field, "keydown", { key: "Enter" });
  await tick();
  assert.deepEqual(saved().cards[2], { id: "dining-room", type: "custom:arrange-grid-card", title: "Dining Room", cards: [] });
  assert.match(card._bar.textContent, /Group "Dining Room" added/);

  const inner = await onDashboard(nestedPage());
  const lights = kid(inner.card, "lights").el;
  fire(lights._grid, "contextmenu", { clientX: 10, clientY: 10 });
  click(button(lights, "Add group inside…"));
  all(byClass(lights, "menu")[0], (el) => el.localName === "input")[0].value = "Room"; // the id is taken in there
  click(button(lights, "Add"));
  await tick();
  assert.deepEqual(ids(inner.saved().cards[0]), ["x", "y", "room", "room-2"]);

  const guest = await onDashboard(nestedPage(), { admin: false });
  click(guest.card._btn);
  assert.equal(button(guest.card, "Add group…"), undefined);
});

test("hide_add_menu: the header's add menu is hidden while the card is on the page, and put back", async () => {
  const el = (tag, attrs = {}, kids = []) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    n.append(...kids);
    return n;
  };
  const item = (value) => Object.assign(el("ha-dropdown-item"), { value });
  const add = el("ha-dropdown", { slot: "actionItems" }, [item("ui.panel.lovelace.menu.add_device"), item("ui.panel.lovelace.menu.create_area")]);
  const other = el("ha-dropdown", { slot: "actionItems" }, [item("ui.panel.lovelace.menu.something_else")]);
  const root = el("hui-root");
  root.attachShadow({ mode: "open" }).append(el("div", {}, [add, other]));
  document.body.append(root);
  const card = new Card();
  card.clientWidth = 1200;
  card.setConfig({ ...three(), hide_add_menu: true });
  card.hass = fakeHass();
  root.shadowRoot.append(card);
  await tick();
  assert.deepEqual([add.style.display, other.style.display], ["none", undefined]);
  card.setConfig(three()); // the option taken away
  assert.notEqual(add.style.display, "none");
  card.setConfig({ ...three(), hide_add_menu: true });
  assert.equal(add.style.display, "none");
  card.remove(); // another view: the header is as it was
  assert.notEqual(add.style.display, "none");
  root.remove();
});

test("adding a card from the menu: an entity is searched for by name or id and gets a tile, on the page or in a group", async () => {
  const states = {
    "light.desk_lamp": { attributes: { friendly_name: "Desk lamp" } },
    "light.floor_lamp": { attributes: { friendly_name: "Floor lamp" } },
    "sensor.outside_temperature": { attributes: { friendly_name: "Outside temperature" } },
    "switch.x": { attributes: {} },
  };
  const { hass, card, saved } = await onDashboard(nestedPage());
  hass.states = states;
  const menuItems = (g) => all(byClass(g, "menu")[0], (el) => el.localName === "button").map((el) => el.textContent);
  const type = (g, text) => {
    const field = all(byClass(g, "menu")[0], (el) => el.localName === "input")[0];
    field.value = text;
    fire(field, "input");
    return field;
  };
  click(card._btn);
  click(button(card, "Add card…"));
  assert.deepEqual(menuItems(card), []);
  type(card, "lamp");
  assert.deepEqual(menuItems(card), ["Desk lamp  ·  light.desk_lamp", "Floor lamp  ·  light.floor_lamp"]);
  type(card, "nothing like it");
  assert.deepEqual(menuItems(card), []);
  assert.match(byClass(card, "note")[0].textContent, /No entity matches/);
  const field = type(card, "sensor temp"); // words in any order, from the id as well
  assert.deepEqual(menuItems(card), ["Outside temperature  ·  sensor.outside_temperature"]);
  fire(field, "keydown", { key: "Enter" }); // the first match
  await tick();
  assert.deepEqual(saved().cards[2], { id: "outside-temperature", type: "tile", entity: "sensor.outside_temperature" });
  assert.match(card._bar.textContent, /sensor.outside_temperature added to the page/);

  // in a group, from its menu; an id that is taken there gets a number
  dom.session.clear();
  const two = await onDashboard(nestedPage());
  two.hass.states = states;
  const lights = kid(two.card, "lights").el;
  fire(lights._grid, "contextmenu", { clientX: 10, clientY: 10 });
  click(button(lights, "Add card here…"));
  type(lights, "switch.x");
  click(button(lights, "switch.x"));
  await tick();
  assert.deepEqual(two.saved().cards[0].cards[3], { id: "x-2", type: "tile", entity: "switch.x" });

  // while arranging: the same, Arrange goes on, and Cancel takes the card away again
  dom.session.clear();
  const three_ = await onDashboard(nestedPage());
  three_.hass.states = states;
  const before = JSON.stringify(three_.saved());
  click(three_.card._btn);
  click(button(three_.card, "Arrange…"));
  fire(three_.card._grid, "contextmenu", { clientX: 10, clientY: 10 });
  click(button(three_.card, "Add card…"));
  type(three_.card, "desk");
  click(button(three_.card, "Desk lamp  ·  light.desk_lamp"));
  await tick();
  assert.deepEqual(ids(three_.saved()), ["lights", "a", "desk-lamp"]);
  document.body.replaceChildren();
  const again = await mount(three_.saved(), { hass: three_.hass });
  await tick();
  assert.equal(again._arranging, true);
  click(button(again, "Cancel"));
  await tick();
  await tick();
  assert.equal(JSON.stringify(three_.saved()), before);
});

test("moving between groups: only an administrator, and only a dashboard that can be saved", async () => {
  const guest = await onDashboard(nestedPage(), { admin: false });
  fire(kid(guest.card, "a").el, "contextmenu", { clientX: 10, clientY: 10 });
  assert.equal(button(guest.card, "Move to…"), undefined);

  const yaml = await mount(nestedPage(), { hass: fakeHass() });
  await tick();
  fire(kid(yaml, "a").el, "contextmenu", { clientX: 10, clientY: 10 });
  click(button(yaml, "Move to…"));
  click(button(yaml, "Lights"));
  await tick();
  assert.match(yaml._bar.textContent, /Couldn't move it to Lights/);

  const plain = await onDashboard(three());
  fire(kid(plain.card, "a").el, "contextmenu", { clientX: 10, clientY: 10 });
  assert.equal(button(plain.card, "Move to…"), undefined); // no groups: nowhere to move to
});

test("moving between groups: a card dragged onto a group, or out of its own, goes there", async () => {
  const { hass, card, saved } = await onDashboard(nestedPage());
  const lights = kid(card, "lights").el;
  card.rect = { left: 0, top: 0, width: 1200, height: 600 };
  lights.rect = { left: 0, top: 0, width: 300, height: 300 };
  click(card._btn);
  click(button(card, "Arrange…"));
  const arr = kid(card, "a").arr;
  fire(arr, "pointerdown", { pointerId: 1, button: 0, pointerType: "mouse", clientX: 350, clientY: 25 });
  fire(arr, "pointermove", { pointerId: 1, clientX: 150, clientY: 150 });
  assert.equal(lights.classList.contains("dropin"), true);
  assert.match(byClass(card, "why")[0].textContent, /Drop to move it to Lights/);
  fire(arr, "pointermove", { pointerId: 1, clientX: 650, clientY: 25 }); // away again: an ordinary move
  assert.equal(lights.classList.contains("dropin"), false);
  fire(arr, "pointermove", { pointerId: 1, clientX: 150, clientY: 150 });
  fire(arr, "pointerup", { pointerId: 1, clientX: 150, clientY: 150 });
  await tick();
  assert.equal(card._arranging, false); // what was arranged so far is kept, then the card moves
  assert.deepEqual(ids(saved()), ["lights"]);
  assert.deepEqual(ids(saved().cards[0]), ["x", "y", "room", "a"]);

  // from inside a group, out onto the page
  dom.session.clear();
  const out = await onDashboard(nestedPage());
  const g = kid(out.card, "lights").el;
  out.card.rect = { left: 0, top: 0, width: 1200, height: 600 };
  g.rect = { left: 0, top: 0, width: 300, height: 300 };
  fire(g._grid, "contextmenu", { clientX: 10, clientY: 10 });
  click(button(g, "Arrange inside this group…"));
  drag(g, "y", at(4, 0), [800, 400]);
  await tick();
  assert.deepEqual(ids(out.saved()), ["lights", "a", "y"]);

  // a group itself is not dropped into another by dragging
  dom.session.clear();
  const grp = await onDashboard({ type: "custom:arrange-grid-card", cards: [group("one", "One", [small("x")]), group("two", "Two", [small("y")])] });
  grp.card.rect = { left: 0, top: 0, width: 1200, height: 600 };
  kid(grp.card, "two").el.rect = { left: 300, top: 0, width: 300, height: 300 };
  click(grp.card._btn);
  click(button(grp.card, "Arrange…"));
  drag(grp.card, "one", at(0, 0), [450, 150]);
  await tick();
  assert.deepEqual(ids(grp.saved()), ["one", "two"]);
});

test("badges: a centred row over the grid, kept while they do not change", async () => {
  const hass = fakeHass();
  const config = { ...three(), badges: ["sensor.one", { entity: "sensor.two", name: "Two" }] };
  const card = await mount(config, { hass });
  const row = byClass(card, "badges")[0];
  assert.equal(row.hidden, false);
  assert.deepEqual(row.children.map((el) => el.config), [{ type: "entity", entity: "sensor.one" }, { type: "entity", entity: "sensor.two", name: "Two" }]);
  assert.ok(row.children.every((el) => el.hass === hass));
  const first = row.children[0];
  card.setConfig({ ...config, columns: 6 });
  await tick();
  assert.equal(row.children[0], first);
  const next = fakeHass();
  card.hass = next;
  assert.equal(first.hass, next);
  assert.equal(byClass(await mount(three()), "badges")[0].hidden, true);
});

const bin = [600, 760]; // a point on the bin, once a test has said where it is
const withBin = (card) => {
  card._trash.rect = { left: 500, top: 730, width: 200, height: 50 };
};

test("the bin: a card dropped on it is off the page once Done is pressed; Undo and Cancel bring it back", async () => {
  const hass = fakeHass();
  const card = await mount(three(), { hass });
  click(card._btn);
  click(button(card, "Arrange…"));
  withBin(card);
  const arr = kid(card, "b").arr;
  fire(arr, "pointerdown", { pointerId: 1, button: 0, pointerType: "mouse", clientX: 150, clientY: 25 });
  assert.equal(card._trash.classList.contains("show"), false); // only while something is dragged
  fire(arr, "pointermove", { pointerId: 1, clientX: 460, clientY: 300 });
  assert.deepEqual([card._trash.classList.contains("show"), card._trash.classList.contains("over")], [true, false]);
  fire(arr, "pointermove", { pointerId: 1, clientX: bin[0], clientY: bin[1] });
  assert.equal(card._trash.classList.contains("over"), true);
  fire(arr, "pointerup", { pointerId: 1, clientX: bin[0], clientY: bin[1] });
  assert.equal(card._trash.classList.contains("show"), false);
  assert.equal(kid(card, "b").slot.hidden, true);
  assert.match(byClass(card, "undo")[0].textContent, /^b · fake will be deleted when you press Done/);
  assert.equal(hass.userData, null); // nothing is kept yet

  click(button(card, "Undo"));
  assert.equal(kid(card, "b").slot.hidden, false);
  assert.equal(place(card, "b").c, 1);
  assert.equal(byClass(card, "undo")[0].hidden, true);

  drag(card, "b", at(1, 0), bin);
  drag(card, "a", at(0, 0), at(6, 2)); // another change: the offer to undo goes
  assert.equal(byClass(card, "undo")[0].hidden, true);
  click(button(card, "Cancel"));
  assert.equal(kid(card, "b").slot.hidden, false);
  assert.equal(hass.userData, null);

  click(card._btn);
  click(button(card, "Arrange…"));
  fire(kid(card, "c").arr, "keydown", { key: "Delete" }); // the keyboard's way
  click(button(card, "Done"));
  await tick();
  assert.equal(kid(card, "c").slot.hidden, true);
  assert.equal(kid(card, "c").el.isConnected, false);
  assert.deepEqual(hass.userData.layouts["/dashboard-test/home"].hidden, ["c"]);
  click(card._btn);
  click(button(card, "Show a hidden card…"));
  click(button(card, "c · fake"));
  await tick();
  assert.equal(kid(card, "c").slot.hidden, false);
});

test("the bin deletes: on Done the card leaves the dashboard, for an administrator; otherwise it is hidden", async () => {
  const { hass, card, saved } = await onDashboard(nestedPage());
  const lights = kid(card, "lights").el;
  click(card._btn);
  click(button(card, "Arrange…"));
  withBin(card);
  withBin(lights);
  assert.equal(card._trashText.textContent, "Drop here to delete it");
  drag(card, "a", at(3, 0), bin);
  drag(lights, "x", at(0, 0), bin); // one inside a group as well
  assert.deepEqual(ids(saved()), ["lights", "a"]); // nothing yet
  click(button(card, "Done"));
  await tick();
  assert.deepEqual(ids(saved()), ["lights"]);
  assert.deepEqual(ids(saved().cards[0]), ["y", "room"]);
  assert.match(card._bar.textContent, /2 cards deleted from the dashboard/);
  const kept = (hass.userData && hass.userData.layouts) || {};
  assert.ok(Object.values(kept).every((l) => !l.hidden)); // gone, not hidden: Reset layout has nothing to bring back

  // Cancel: nothing is deleted
  dom.session.clear();
  const two = await onDashboard(nestedPage());
  click(two.card._btn);
  click(button(two.card, "Arrange…"));
  withBin(two.card);
  drag(two.card, "a", at(3, 0), bin);
  click(button(two.card, "Cancel"));
  await tick();
  assert.deepEqual(ids(two.saved()), ["lights", "a"]);

  // someone who may not edit the dashboard: hidden, their own
  dom.session.clear();
  const guest = await onDashboard(nestedPage(), { admin: false });
  click(guest.card._btn);
  click(button(guest.card, "Arrange…"));
  withBin(guest.card);
  assert.equal(guest.card._trashText.textContent, "Drop here to hide it");
  drag(guest.card, "a", at(3, 0), bin);
  click(button(guest.card, "Done"));
  await tick();
  assert.deepEqual(ids(guest.saved()), ["lights", "a"]);
  assert.deepEqual(guest.hass.userData.layouts["/dashboard-test/home"].hidden, ["a"]);
});

test("the bin: what is in it stays in it while a card changes groups, and goes on Done", async () => {
  const { hass, card, saved } = await onDashboard({ type: "custom:arrange-grid-card", cards: [group("lights", "Lights", [small("x"), small("y")]), small("a"), small("b")] });
  const lights = kid(card, "lights").el;
  card.rect = { left: 0, top: 0, width: 1200, height: 600 };
  lights.rect = { left: 0, top: 0, width: 300, height: 300 };
  click(card._btn);
  click(button(card, "Arrange…"));
  card._trash.rect = { left: 500, top: 730, width: 200, height: 50 };
  drag(card, "b", at(4, 0), bin);
  drag(card, "a", at(3, 0), [150, 150]); // into the group: the page is redrawn
  await tick();
  assert.deepEqual(ids(saved()), ["lights", "b"]); // b is still there: not deleted before Done
  document.body.replaceChildren();
  const again = await mount(saved(), { hass });
  await tick();
  assert.equal(again._arranging, true);
  assert.equal(kid(again, "b").slot.hidden, true); // and still in the bin
  click(button(again, "Done"));
  await tick();
  assert.deepEqual(ids(saved()), ["lights"]);
  assert.deepEqual(ids(saved().cards[0]), ["x", "y", "a"]);
});

test("the bin: a selected group goes as one; a finger drags by the grip", async () => {
  const hass = fakeHass();
  const card = await mount(grouped(), { hass });
  click(card._btn);
  click(button(card, "Arrange…"));
  withBin(card);
  drag(card, "h1", at(0, 0), bin, { pointerType: "touch", handle: "grip" }); // not selected: the heading alone
  assert.deepEqual(["h1", "a", "b"].map((k) => kid(card, k).slot.hidden), [true, false, false]);
  click(button(card, "Undo"));
  click(byClass(kid(card, "h1").arr, "pick")[0]);
  drag(card, "a", at(3, 0), bin, { pointerType: "touch", handle: "grip" });
  assert.deepEqual(["h1", "a", "b", "h2", "c"].map((k) => kid(card, k).slot.hidden), [true, true, true, false, false]);
  assert.match(byClass(card, "undo")[0].textContent, /^3 cards will be deleted when you press Done/);
  drag(card, "c", at(8, 0), at(0, 0)); // the cells they left are free
  assert.equal(place(card, "c").c, 0);
  click(button(card, "Done"));
  await tick();
  const kept = hass.userData.layouts["/dashboard-test/home"];
  assert.deepEqual(kept.hidden, ["h1", "a", "b"]);
  assert.deepEqual(kept.tiles.map((t) => t.id).sort(), ["c", "h2"]);
});

test("the bin: in the list every card has a button for it, and a heading takes its cards", async () => {
  const hass = fakeHass();
  const card = await mount(grouped(), { width: 400, hass });
  click(card._btn);
  click(button(card, "Arrange…"));
  click(byClass(kid(card, "c").arr, "rm")[0]);
  assert.equal(kid(card, "c").slot.hidden, true);
  click(button(card, "Undo"));
  assert.equal(kid(card, "c").slot.hidden, false);
  click(byClass(kid(card, "h1").arr, "rm")[0]);
  assert.deepEqual(["h1", "a", "b", "h2", "c"].map((k) => kid(card, k).slot.hidden), [true, true, true, false, false]);
  withBin(card);
  drag(card, "c", [10, 225], bin, { pointerType: "touch", handle: "grip" });
  assert.equal(kid(card, "c").slot.hidden, true);
  click(button(card, "Done"));
  await tick();
  const kept = hass.userData.layouts["/dashboard-test/home"];
  assert.deepEqual(kept.hidden, ["h1", "a", "b", "c"]);
  assert.deepEqual(kept.list, ["h2"]);
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
