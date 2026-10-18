import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Exercise the registered client components, without exporting private functions
// or bringing a browser / React dependency into this plugin's test package.
function createClock() {
  let now = 0;
  let nextId = 1;
  const tasks = new Map();
  const schedule = (callback, delay, interval = false) => {
    const id = nextId++;
    tasks.set(id, { callback, at: now + Number(delay || 0), interval, delay: Number(delay || 0) });
    return id;
  };
  return {
    setTimeout: (callback, delay) => schedule(callback, delay),
    setInterval: (callback, delay) => schedule(callback, delay, true),
    clearTimeout: (id) => tasks.delete(id),
    clearInterval: (id) => tasks.delete(id),
    advance(milliseconds) {
      const until = now + milliseconds;
      for (let count = 0; count < 1000; count++) {
        const next = [...tasks].filter(([, task]) => task.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) { now = until; return; }
        const [id, task] = next;
        now = task.at;
        if (task.interval) task.at += Math.max(1, task.delay);
        else tasks.delete(id);
        task.callback();
      }
      throw new Error('Fake clock exceeded 1000 callbacks');
    },
  };
}

class EventTarget {
  listeners = new Map();
  addEventListener(type, callback, options) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push({ callback, capture: options === true || options?.capture === true });
    this.listeners.set(type, listeners);
  }
  removeEventListener(type, callback, options) {
    const capture = options === true || options?.capture === true;
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((item) => item.callback !== callback || item.capture !== capture));
  }
  emit(event, capture) {
    for (const listener of [...(this.listeners.get(event.type) ?? [])]) {
      if (listener.capture !== capture) continue;
      listener.callback(event);
      if (event.immediatePropagationStopped) break;
    }
  }
}

function createDOM() {
  const window = new EventTarget();
  const document = new EventTarget();
  const mutationObservers = new Set();
  const resizeObservers = new Set();
  class MutationObserver {
    constructor(callback) { this.callback = callback; this.targets = []; this.records = []; }
    observe(target, options) { this.targets.push({ target, options }); mutationObservers.add(this); }
    disconnect() { this.targets = []; this.records = []; mutationObservers.delete(this); }
  }
  class ResizeObserver {
    constructor(callback) { this.callback = callback; this.targets = new Set(); }
    observe(target) { this.targets.add(target); resizeObservers.add(this); }
    disconnect() { this.targets.clear(); resizeObservers.delete(this); }
  }
  const mutate = (target) => {
    for (const observer of mutationObservers) {
      if (observer.targets.some((item) => item.target === target || item.options.subtree && item.target.contains(target))) {
        observer.records.push({ type: 'childList', target });
      }
    }
  };
  const deliverMutations = () => {
    for (const observer of mutationObservers) {
      const records = observer.records.splice(0);
      if (records.length) observer.callback(records, observer);
    }
  };
  class Element extends EventTarget {
    constructor(tagName) {
      super();
      this.tagName = tagName.toUpperCase();
      this.nodeType = 1;
      this.attributes = new Map();
      this.childNodes = [];
      this.parentElement = null;
      this.ownerDocument = document;
      this.offsetLeft = 0;
      this.offsetTop = 0;
      this.clientWidth = 500;
      this.rectHeight = 24;
      this.style = { minHeight: '', position: '', cssText: '', setProperty(name, value) { this[name] = value; }, removeProperty(name) { delete this[name]; } };
    }
    get id() { return this.getAttribute('id') ?? ''; }
    set id(value) { this.setAttribute('id', value); }
    get children() { return this.childNodes.filter((child) => child.nodeType === 1); }
    get firstChild() { return this.childNodes[0] ?? null; }
    get parentNode() { return this.parentElement; }
    get isConnected() { return this === document.documentElement || Boolean(this.parentElement?.isConnected); }
    get innerText() { return this.textContent; }
    set innerText(value) { this.textContent = value; }
    get textContent() { return this.childNodes.map((child) => child.nodeType === 3 ? child.nodeValue : child.textContent).join(''); }
    set textContent(value) { this.childNodes = value ? [{ nodeType: 3, nodeValue: String(value), parentElement: this }] : []; mutate(this); }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    hasAttribute(name) { return this.attributes.has(name); }
    removeAttribute(name) { this.attributes.delete(name); }
    appendChild(child) { child.remove?.(); child.parentElement = this; this.childNodes.push(child); mutate(this); return child; }
    append(...children) { for (const child of children) this.appendChild(child); }
    remove() {
      if (this.parentElement) {
        this.parentElement.childNodes = this.parentElement.childNodes.filter((child) => child !== this);
        mutate(this.parentElement);
      }
      this.parentElement = null;
    }
    contains(element) { return this === element || this.children.some((child) => child.contains(element)); }
    matches(selector) {
      return selector.split(',').some((part) => {
        const value = part.trim();
        if (value.startsWith('#')) return this.id === value.slice(1);
        if (value.startsWith('.')) return (this.getAttribute('class') ?? '').split(' ').includes(value.slice(1));
        const attribute = value.match(/^\[([^=\]]+)(?:=["']?([^"'\]]+)["']?)?\]$/);
        if (attribute) return attribute[2] === undefined ? this.hasAttribute(attribute[1]) : this.getAttribute(attribute[1]) === attribute[2];
        return this.tagName.toLowerCase() === value.toLowerCase();
      });
    }
    closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) ?? null; }
    querySelector(selector) {
      for (const child of this.children) {
        if (child.matches(selector)) return child;
        const found = child.querySelector(selector);
        if (found) return found;
      }
      return null;
    }
    querySelectorAll(selector) {
      return this.children.flatMap((child) => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
    }
    getBoundingClientRect() { return { x: 0, y: 0, top: 0, left: 0, right: this.clientWidth, bottom: this.rectHeight, width: this.clientWidth, height: this.rectHeight }; }
    focus() { document.activeElement = this; }
  }
  document.createElement = (tag) => new Element(tag);
  document.createTextNode = (text) => ({ nodeType: 3, nodeValue: text });
  document.documentElement = new Element('html');
  document.head = document.documentElement.appendChild(new Element('head'));
  document.body = document.documentElement.appendChild(new Element('body'));
  document.querySelector = (selector) => document.documentElement.querySelector(selector);
  document.querySelectorAll = (selector) => document.documentElement.querySelectorAll(selector);
  document.getElementById = (id) => document.querySelector(`#${id}`);
  const card = document.body.appendChild(new Element('div'));
  card.setAttribute('data-composer-card', 'true');
  const grow = card.appendChild(new Element('div'));
  grow.setAttribute('class', 'grow');
  const editor = grow.appendChild(new Element('div'));
  editor.setAttribute('data-composer-input', 'true');
  editor.setAttribute('contenteditable', 'true');
  editor.isContentEditable = true;
  const placeholder = grow.appendChild(new Element('div'));
  placeholder.setAttribute('data-composer-placeholder', 'true');
  const button = card.appendChild(new Element('button'));
  document.activeElement = editor;
  function dispatch(type, init = {}) {
    const event = {
      type, target: init.target ?? document.activeElement, key: '', keyCode: 0,
      altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, isComposing: false,
      defaultPrevented: false, propagationStopped: false, immediatePropagationStopped: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.propagationStopped = true; },
      stopImmediatePropagation() { this.immediatePropagationStopped = true; this.propagationStopped = true; },
      ...init,
    };
    const ancestors = [];
    for (let node = event.target; node; node = node.parentElement) ancestors.push(node);
    const path = [window, document, ...ancestors.reverse()];
    event.composedPath = () => [...path].reverse();
    for (const node of path) { node.emit(event, true); if (event.propagationStopped) return event; }
    for (const node of path.reverse()) { node.emit(event, false); if (event.propagationStopped) return event; }
    return event;
  }
  const deliverResize = (target) => {
    for (const observer of resizeObservers) if (observer.targets.has(target)) observer.callback([{ target }], observer);
  };
  return { window, document, Element, MutationObserver, ResizeObserver, deliverMutations, deliverResize, card, grow, editor, placeholder, button, dispatch };
}

function createReact() {
  let current;
  const sameDeps = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const hook = (initial) => {
    const index = current.index++;
    if (!(index in current.hooks)) current.hooks[index] = initial();
    return current.hooks[index];
  };
  const React = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useRef: (value) => hook(() => ({ current: value })),
    useMemo(factory, deps) {
      const state = hook(() => ({ initialized: false }));
      if (!state.initialized || !sameDeps(state.deps, deps)) {
        state.initialized = true; state.deps = deps; state.value = factory();
      }
      return state.value;
    },
    useCallback(callback, deps) { return React.useMemo(() => callback, deps); },
    useEffect(effect, deps) {
      const state = hook(() => ({ initialized: false }));
      if (!state.initialized || !sameDeps(state.deps, deps)) {
        state.initialized = true; state.deps = deps;
        current.effects.push(() => { state.cleanup?.(); state.cleanup = effect(); });
      }
    },
    useState(initial) {
      const runner = current;
      const state = hook(() => ({ value: typeof initial === 'function' ? initial() : initial }));
      state.set ??= (next) => {
        const value = typeof next === 'function' ? next(state.value) : next;
        if (!Object.is(value, state.value)) { state.value = value; runner.dirty = true; }
      };
      return [state.value, state.set];
    },
    useSyncExternalStore(subscribe, getSnapshot) {
      const runner = current;
      const state = hook(() => ({}));
      if (state.subscribe !== subscribe) {
        state.cleanup?.(); state.subscribe = subscribe;
        state.cleanup = subscribe(() => { runner.dirty = true; });
      }
      return getSnapshot();
    },
  };
  React.useLayoutEffect = React.useEffect;
  function mount(component, props) {
    const runner = {
      hooks: [], effects: [], dirty: true, mounted: true, props,
      render() {
        for (let count = 0; this.dirty && this.mounted; count++) {
          if (count > 50) throw new Error('React harness exceeded 50 renders');
          this.dirty = false; this.index = 0; current = this;
          this.output = component(this.props); current = undefined;
          const effects = this.effects.splice(0);
          for (const effect of effects) effect();
        }
      },
      update(next) { this.props = { ...this.props, ...next }; this.dirty = true; this.render(); },
      unmount() { this.mounted = false; for (const state of this.hooks) state.cleanup?.(); },
    };
    runner.render();
    return runner;
  }
  return { React, mount };
}

function findElement(tree, predicate) {
  if (!tree || typeof tree !== 'object') return null;
  if (predicate(tree)) return tree;
  for (const child of tree.props?.children.flat(Infinity) ?? []) {
    const found = findElement(child, predicate);
    if (found) return found;
  }
  return null;
}

export async function createClientHarness(options = {}) {
  const clock = createClock();
  const dom = createDOM();
  const { React, mount } = createReact();
  const requests = [];
  const inserted = [];
  const sent = [];
  const storage = new Map(Object.entries(options.storage ?? {}));
  const slots = new Map();
  let plugin;
  const computedStyle = (element) => ({
    minHeight: element.style.minHeight || '24px', paddingTop: '4px', paddingBottom: '4px',
    paddingLeft: '8px', paddingRight: '8px', fontFamily: 'sans-serif', fontSize: '14px',
    fontWeight: '400', lineHeight: '20px', letterSpacing: 'normal', position: element.style.position || 'static',
    borderTopWidth: '0px', borderBottomWidth: '0px', borderLeftWidth: '0px', boxSizing: 'border-box',
    fontStyle: 'normal', textAlign: 'start', direction: 'ltr',
  });
  Object.assign(dom.window, clock, {
    document: dom.document,
    getComputedStyle: computedStyle,
    __DSH_COMPOSER_PREDICTIONS_TOKEN__: 'test-token',
    __ModuleLoader__: { load: ({ factory }) => { plugin = factory((name) => { if (name === 'react') return React; throw new Error(`Unexpected module: ${name}`); }); } },
    localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    requestAnimationFrame: (callback) => clock.setTimeout(callback, 16),
    cancelAnimationFrame: clock.clearTimeout,
  });
  const fetch = (url, init) => new Promise((resolve, reject) => {
    requests.push({ url, ...init, request: JSON.parse(init.body), reject,
      resolve: (body, status = 200) => resolve({ ok: status >= 200 && status < 300, status, json: async () => body }),
    });
  });
  const context = vm.createContext({
    ...clock, window: dom.window, document: dom.document, fetch, AbortController,
    getComputedStyle: computedStyle, HTMLElement: dom.Element, Element: dom.Element,
    MutationObserver: dom.MutationObserver, ResizeObserver: dom.ResizeObserver,
    requestAnimationFrame: dom.window.requestAnimationFrame, cancelAnimationFrame: dom.window.cancelAnimationFrame,
    console: { info() {}, warn() {}, error() {} },
  });
  vm.runInContext(options.source ?? readFileSync(new URL('../../client.js', import.meta.url), 'utf8'), context, { filename: 'client.js' });
  const cleanup = await plugin.apply({
    effect: (fn) => fn(), locale: { register: () => () => {} },
    slots: { inject: (_name, register) => register(), register: (slot, component) => { slots.set(slot.name, { slot, component }); return () => {}; } },
  });
  const t = (key) => key;
  const inputActions = {
    captureInsertion: () => ({ kind: 'test-insertion' }),
    insertText(text, position) { inserted.push({ text, position }); return true; },
    submit: (...args) => sent.push(args), send: (...args) => sent.push(args),
  };
  const dockSlot = slots.get('conversation.input.dock');
  const settingsSlot = slots.get('settings.general.item');
  const dock = mount(dockSlot.component, {
    ...dockSlot.slot.inject(), sessionId: 'session-a', session: { running: false }, input: { draft: '' }, inputActions, t, ...options.props,
  });
  const settings = mount(settingsSlot.component, { ...settingsSlot.slot.inject(), t });
  const flush = async () => {
    for (let i = 0; i < 12; i++) { await Promise.resolve(); dock.render(); settings.render(); dom.deliverMutations(); }
  };
  return {
    ...dom, requests, inserted, sent, storage,
    ghost: () => dom.document.querySelector('[data-composer-predictions="inline"]'),
    ghostText: () => dom.document.querySelector('[data-composer-predictions="inline-text"]')?.textContent ?? '',
    async update(props) { dock.update(props); await flush(); },
    async advance(ms = 1000) { clock.advance(ms); await flush(); },
    async finishTurn() { dock.update({ session: { running: true } }); await flush(); dock.update({ session: { running: false } }); await flush(); },
    async resolve(index, body) { requests[index].resolve(body); await flush(); },
    async toggle() { settings.render(); findElement(settings.output, (node) => node.props?.role === 'switch').props.onClick(); await flush(); },
    async event(type, init) { const event = dom.dispatch(type, init); await flush(); return event; },
    async unmount() { dock.unmount(); await flush(); },
    flush,
    dispose() { dock.unmount(); settings.unmount(); cleanup?.(); },
  };
}
