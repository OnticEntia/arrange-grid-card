// Stand-ins for the browser and for Home Assistant's frontend: just enough of
// the DOM for the card to build itself, take events and be looked at. There
// is no layout here: a test says where things are on screen with `rects`.

"use strict";

class Ev {
  constructor(type, init = {}) {
    this.type = type;
    this.bubbles = init.bubbles !== false;
    this.detail = init.detail;
    this.defaultPrevented = false;
    this._stopped = false;
    Object.assign(this, init.props || {});
  }
  preventDefault() {
    this.defaultPrevented = true;
  }
  stopPropagation() {
    this._stopped = true;
  }
  composedPath() {
    return this._path || [];
  }
}

class Target {
  constructor() {
    this._listeners = [];
  }
  addEventListener(type, fn, opts) {
    this._listeners.push({ type, fn, capture: opts === true || !!(opts && opts.capture) });
  }
  removeEventListener(type, fn, opts) {
    const capture = opts === true || !!(opts && opts.capture);
    this._listeners = this._listeners.filter((l) => !(l.type === type && l.fn === fn && l.capture === capture));
  }
  _run(ev, capture) {
    for (const l of [...this._listeners]) if (l.type === ev.type && l.capture === capture) l.fn.call(this, ev);
    if (!capture && typeof this[`on${ev.type}`] === "function") this[`on${ev.type}`](ev);
  }
  // Down from the window to the target (capture), then back up (bubble),
  // through shadow roots to their hosts.
  dispatchEvent(ev) {
    const path = [];
    for (let n = this; n; n = n.parentNode || n.host) path.push(n);
    if (path[path.length - 1] !== win) path.push(win);
    ev.target = this;
    ev._path = path;
    for (let i = path.length - 1; i >= 1 && !ev._stopped; i--) path[i]._run(ev, true);
    if (!ev._stopped) {
      path[0]._run(ev, true);
      path[0]._run(ev, false);
    }
    for (let i = 1; i < path.length && !ev._stopped && ev.bubbles; i++) path[i]._run(ev, false);
    return !ev.defaultPrevented;
  }
}

class Node extends Target {
  constructor() {
    super();
    this.childNodes = [];
    this.parentNode = null;
  }
  get children() {
    return this.childNodes.filter((n) => n instanceof Element);
  }
  get isConnected() {
    for (let n = this; n; n = n.parentNode || n.host) if (n === document.body) return true;
    return false;
  }
  getRootNode() {
    let n = this;
    while (n.parentNode) n = n.parentNode;
    return n;
  }
  _adopt(nodes) {
    return nodes.map((n) => {
      const node = typeof n === "string" ? new Text(n) : n;
      if (node.parentNode) node.parentNode.childNodes.splice(node.parentNode.childNodes.indexOf(node), 1);
      node.parentNode = this;
      return node;
    });
  }
  append(...nodes) {
    const was = this.isConnected;
    const added = this._adopt(nodes);
    this.childNodes.push(...added);
    if (this.isConnected) for (const n of added) n._connected && n._connected(was);
  }
  appendChild(node) {
    this.append(node);
    return node;
  }
  prepend(...nodes) {
    const added = this._adopt(nodes);
    this.childNodes.unshift(...added);
    if (this.isConnected) for (const n of added) n._connected && n._connected();
  }
  replaceChildren(...nodes) {
    for (const n of [...this.childNodes]) n.remove();
    this.append(...nodes);
  }
  remove() {
    if (!this.parentNode) return;
    const was = this.isConnected;
    this.parentNode.childNodes.splice(this.parentNode.childNodes.indexOf(this), 1);
    this.parentNode = null;
    this.removals = (this.removals || 0) + 1;
    if (was && this._disconnected) this._disconnected();
  }
  replaceWith(node) {
    const parent = this.parentNode;
    const at = parent.childNodes.indexOf(this);
    this.remove();
    parent._adopt([node]);
    parent.childNodes.splice(at, 0, node);
  }
  get textContent() {
    return this.childNodes.map((n) => n.textContent).join("");
  }
  set textContent(text) {
    for (const n of [...this.childNodes]) n.remove();
    if (text !== "" && text != null) this.append(new Text(String(text)));
  }
}

class Text extends Node {
  constructor(text) {
    super();
    this._text = text;
  }
  get textContent() {
    return this._text;
  }
  set textContent(text) {
    this._text = text;
  }
}

class ClassList {
  constructor(el) {
    this.el = el;
  }
  _all() {
    return this.el.className.split(/\s+/).filter(Boolean);
  }
  contains(c) {
    return this._all().includes(c);
  }
  add(...cs) {
    this.el.className = [...new Set([...this._all(), ...cs])].join(" ");
  }
  remove(...cs) {
    this.el.className = this._all().filter((c) => !cs.includes(c)).join(" ");
  }
  toggle(c, on = !this.contains(c)) {
    if (on) this.add(c);
    else this.remove(c);
    return on;
  }
}

class Element extends Node {
  constructor() {
    super();
    this.localName = this.constructor._tag || "";
    this.className = "";
    this.classList = new ClassList(this);
    this.style = { setProperty(k, v) { this[k] = v; } };
    this._attrs = {};
    this.hidden = false;
    this.clientWidth = 0;
  }
  setAttribute(k, v) {
    this._attrs[k] = String(v);
  }
  removeAttribute(k) {
    delete this._attrs[k];
  }
  getAttribute(k) {
    return k in this._attrs ? this._attrs[k] : null;
  }
  attachShadow() {
    this.shadowRoot = new ShadowRoot(this);
    return this.shadowRoot;
  }
  closest(sel) {
    if (sel[0] !== ".") throw new Error(`stand-in closest() takes a class: ${sel}`);
    for (let n = this; n instanceof Element; n = n.parentNode) if (n.classList.contains(sel.slice(1))) return n;
    return null;
  }
  getBoundingClientRect() {
    const r = this.rect || (dom.rects && dom.rects(this)) || { left: 0, top: 0, width: 0, height: 0 };
    return { ...r, right: r.left + r.width, bottom: r.top + r.height };
  }
  setPointerCapture() {}
  releasePointerCapture() {}
  focus() {
    let n = this;
    while (n && !(n instanceof ShadowRoot)) n = n.parentNode;
    if (n) n.activeElement = this;
    dom.focused = this;
  }
  _connected() {
    if (typeof this.connectedCallback === "function") this.connectedCallback();
    for (const n of [...this.childNodes, ...(this.shadowRoot ? this.shadowRoot.childNodes : [])]) n._connected && n._connected();
  }
  _disconnected() {
    if (typeof this.disconnectedCallback === "function") this.disconnectedCallback();
    for (const n of [...this.childNodes, ...(this.shadowRoot ? this.shadowRoot.childNodes : [])]) n._disconnected && n._disconnected();
  }
}

class ShadowRoot extends Node {
  constructor(host) {
    super();
    this.host = host;
    this.activeElement = null;
  }
}

const registry = new Map();
const waiting = new Map();
const customElements = {
  define(tag, cls) {
    cls._tag = tag;
    registry.set(tag, cls);
    for (const done of waiting.get(tag) || []) done(cls);
    waiting.delete(tag);
  },
  get: (tag) => registry.get(tag),
  whenDefined(tag) {
    if (registry.has(tag)) return Promise.resolve(registry.get(tag));
    return new Promise((done) => waiting.set(tag, [...(waiting.get(tag) || []), done]));
  },
};

const document = {
  createElement(tag) {
    const cls = registry.get(tag);
    if (cls) return new cls();
    const el = new Element();
    el.localName = tag;
    return el;
  },
  createTextNode: (text) => new Text(text),
  body: null,
};
document.body = document.createElement("body");

const win = new Target();

const store = new Map();
const localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => void store.set(k, String(v)),
  removeItem: (k) => void store.delete(k),
  clear: () => store.clear(),
};

const session = new Map();
const sessionStorage = {
  getItem: (k) => (session.has(k) ? session.get(k) : null),
  setItem: (k, v) => void session.set(k, String(v)),
  removeItem: (k) => void session.delete(k),
  clear: () => session.clear(),
};

const dom = { Ev, Element, win, store, session, rects: null, focused: null, registry };

// Puts the stand-ins where a script loaded in a browser finds them.
function install() {
  Object.assign(globalThis, {
    window: globalThis,
    document,
    customElements,
    HTMLElement: Element,
    localStorage,
    sessionStorage,
    location: { pathname: "/dashboard-test/home" },
    CustomEvent: Ev,
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
    addEventListener: (...a) => win.addEventListener(...a),
    removeEventListener: (...a) => win.removeEventListener(...a),
    scrollBy: () => {},
    innerWidth: 1280,
    innerHeight: 800,
    scrollY: 0,
  });
  return dom;
}

// Every element under `node` (shadow roots included) that `test` accepts.
function all(node, test, out = []) {
  for (const n of [...(node.childNodes || []), ...(node.shadowRoot ? [node.shadowRoot] : [])]) {
    if (n instanceof Element && test(n)) out.push(n);
    all(n, test, out);
  }
  return out;
}

const byClass = (node, cls) => all(node, (el) => el.classList.contains(cls));

function fire(el, type, props = {}, init = {}) {
  const ev = new Ev(type, { ...init, props });
  el.dispatchEvent(ev);
  return ev;
}

module.exports = { install, all, byClass, fire, Ev, Element, document, customElements };
