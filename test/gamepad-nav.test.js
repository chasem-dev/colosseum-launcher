'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { heldInputs, scrollAxis, createRepeater, nextInDirection } = require('../src/gamepad-nav');

function pad({ buttons = [], axes = [0, 0, 0, 0], connected = true } = {}) {
  return { connected, axes, buttons: Array.from({ length: 17 }, (_, index) => ({ pressed: buttons.includes(index), value: buttons.includes(index) ? 1 : 0 })) };
}
const rect = (left, top, width, height) => ({ left, top, right: left + width, bottom: top + height });

test('standard mapping buttons and the left stick become navigation inputs', () => {
  assert.deepEqual([...heldInputs([pad({ buttons: [0, 13] })])].sort(), ['confirm', 'down']);
  assert.deepEqual([...heldInputs([null, pad({ buttons: [1, 9] })])].sort(), ['back', 'menu']);
  assert.deepEqual([...heldInputs([pad({ axes: [-0.9, 0.2] })])], ['left']);
  // A diagonal stick moves along its stronger axis only.
  assert.deepEqual([...heldInputs([pad({ axes: [0.6, 0.7] })])], ['down']);
  assert.deepEqual([...heldInputs([pad({ axes: [0.3, -0.3] })])], []);
  assert.deepEqual([...heldInputs([pad({ buttons: [0], connected: false })])], []);
});

test('a controller printed like Nintendo\'s confirms with its A, the right-hand button', () => {
  const nintendo = () => true;
  assert.deepEqual([...heldInputs([pad({ buttons: [1] })], 0.5, nintendo)], ['confirm']);
  assert.deepEqual([...heldInputs([pad({ buttons: [0] })], 0.5, nintendo)], ['back']);
  assert.deepEqual([...heldInputs([pad({ buttons: [3, 9] })], 0.5, nintendo)].sort(), ['alternate', 'menu']);
});

test('right stick scrolls with a deadzone', () => {
  assert.equal(scrollAxis([pad({ axes: [0, 0, 0, 0.1] })]), 0);
  assert.equal(scrollAxis([pad({ axes: [0, 0, 0, -0.8] }), pad({ axes: [0, 0, 0, 0.4] })]), -0.8);
});

test('buttons fire once per press and directions repeat while held', () => {
  const update = createRepeater({ delay: 300, interval: 100 });
  assert.deepEqual(update(new Set(['confirm', 'down']), 0), ['confirm', 'down']);
  assert.deepEqual(update(new Set(['confirm', 'down']), 200), []);
  assert.deepEqual(update(new Set(['confirm', 'down']), 300), ['down']);
  assert.deepEqual(update(new Set(['confirm', 'down']), 350), []);
  assert.deepEqual(update(new Set(['confirm', 'down']), 400), ['down']);
  assert.deepEqual(update(new Set(), 410), []);
  assert.deepEqual(update(new Set(['confirm']), 420), ['confirm']);
});

test('inputs held while quiet stay silent until released', () => {
  const update = createRepeater({ delay: 300, interval: 100 });
  assert.deepEqual(update(new Set(['confirm', 'up']), 0, true), []);
  assert.deepEqual(update(new Set(['confirm', 'up']), 1000), []);
  assert.deepEqual(update(new Set(['up']), 1100), []);
  assert.deepEqual(update(new Set(['confirm']), 1200), ['confirm']);
});

test('focus moves to the nearest aligned control in the pressed direction', () => {
  // Play button with the settings cog to its right and window controls above.
  const play = rect(100, 500, 400, 72), cog = rect(510, 500, 72, 72);
  const minimize = rect(800, 10, 37, 32), close = rect(882, 10, 37, 32);
  const all = [play, cog, minimize, close];
  assert.equal(nextInDirection(play, all, 'right'), 1);
  assert.equal(nextInDirection(cog, all, 'left'), 0);
  assert.equal(nextInDirection(play, all, 'down'), -1);
  assert.equal(nextInDirection(play, all, 'up'), 2);
  assert.equal(nextInDirection(close, all, 'down'), 1);
});

test('controls side by side in a row are not above or below each other', () => {
  // A row of three settings, then a full-width row and a two-column grid below it.
  const format = rect(0, 0, 200, 62), frameRate = rect(212, 0, 200, 62), eclipse = rect(424, 0, 260, 62);
  const files = rect(0, 90, 684, 50), arch = rect(0, 170, 330, 53), fullscreen = rect(354, 170, 330, 50);
  const all = [format, frameRate, eclipse, files, arch, fullscreen];
  assert.equal(nextInDirection(format, all, 'up'), -1);
  assert.equal(nextInDirection(format, all, 'right'), 1);
  assert.equal(nextInDirection(eclipse, all, 'down'), 3);
  assert.equal(nextInDirection(fullscreen, all, 'up'), 3);
  assert.equal(nextInDirection(fullscreen, all, 'left'), 4);
  // Prefer the aligned column over a nearer diagonal one.
  assert.equal(nextInDirection(rect(354, 250, 330, 50), [arch, fullscreen], 'up'), 1);
});

test('moving down from a full-width control picks the first control in the next row', () => {
  const channel = rect(0, 0, 340, 40), update = rect(0, 60, 100, 34), removable = rect(110, 60, 140, 34);
  assert.equal(nextInDirection(channel, [update, removable], 'down'), 0);
});

test('nothing far off to the side counts as being in that direction', () => {
  // A switch at the right edge of a dialog, with the close button far above it.
  const fullscreen = rect(554, 510, 342, 60), close = rect(897, 81, 34, 34), mode = rect(554, 580, 342, 50);
  assert.equal(nextInDirection(fullscreen, [close, mode], 'right'), -1);
  assert.equal(nextInDirection(fullscreen, [close, mode], 'down'), 1);
  // A slightly lower neighbour still counts.
  assert.equal(nextInDirection(rect(0, 0, 100, 30), [rect(130, 40, 100, 30)], 'right'), 0);
});

test('only fields that take typing count as typed', () => {
  const { typed } = require('../src/gamepad-nav');
  assert.equal(typed({ tagName: 'INPUT', type: 'search' }), true);
  assert.equal(typed({ tagName: 'INPUT', type: 'text' }), true);
  assert.equal(typed({ tagName: 'TEXTAREA' }), true);
  for (const type of ['checkbox', 'range', 'radio', 'button']) assert.equal(typed({ tagName: 'INPUT', type }), false);
  assert.equal(typed({ tagName: 'SELECT' }), false);
  assert.equal(typed(null), false);
});

// A small stand-in page: elements that focus and blur, a document that hears focusin, and one controller.
function fakePage() {
  const listeners = {};
  const document = {
    activeElement: null,
    body: { querySelectorAll: () => document.elements, classList: { set: new Set(), toggle(name, on) { if (on) this.set.add(name); else this.set.delete(name); }, contains(name) { return this.set.has(name); } } },
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    querySelectorAll: () => [],
    hasFocus: () => true,
    elements: []
  };
  function element(tagName, type, box) {
    const own = {};
    const el = {
      tagName, type, readOnly: false, disabled: false, dataset: {},
      addEventListener(event, fn, options) { (own[event] ||= []).push({ fn, once: options?.once }); },
      dispatch(event) { const list = own[event] || []; own[event] = list.filter(entry => !entry.once); for (const entry of list) entry.fn(); },
      focus() {
        if (document.activeElement === el) return;
        document.activeElement?.blur();
        document.activeElement = el;
        for (const fn of listeners.focusin || []) fn({ target: el });
      },
      blur() { if (document.activeElement !== el) return; document.activeElement = null; el.dispatch('blur'); },
      click() { el.clicked = (el.clicked || 0) + 1; },
      closest: () => null, checkVisibility: () => true, scrollIntoView() {}, getBoundingClientRect: () => box
    };
    document.elements.push(el);
    return el;
  }
  let buttons = [];
  let frame = null;
  const window = {
    navigator: { getGamepads: () => [pad({ buttons })] },
    requestAnimationFrame(fn) { frame = fn; return 1; },
    addEventListener() {},
    getComputedStyle: () => ({ overflowY: 'visible' }),
    Event: class { constructor(type) { this.type = type; } }
  };
  let now = 0;
  // Each press is held for one frame and released for the next.
  function press(index) {
    for (const held of [[index], []]) { buttons = held; now += 500; const run = frame; frame = null; run(now); }
  }
  const fire = (type, event) => { for (const fn of listeners[type] || []) fn(event); };
  return { document, window, element, press, fire };
}

test('a text field the controller reaches is read-only until A picks it', () => {
  const { start } = require('../src/gamepad-nav');
  const page = fakePage();
  const button = page.element('BUTTON', 'submit', rect(0, 0, 100, 40));
  const search = page.element('INPUT', 'search', rect(0, 100, 100, 40));
  start({ document: page.document, window: page.window, defaultFocus: () => [button] });
  page.press(13); // down: the first press focuses the default control
  assert.equal(page.document.activeElement, button);
  page.press(13); // down to the search field
  assert.equal(page.document.activeElement, search);
  assert.equal(search.readOnly, true);
  page.press(0); // A: now it takes typing
  assert.equal(page.document.activeElement, search);
  assert.equal(search.readOnly, false);
  page.press(12); // up and away, then back: read-only again
  assert.equal(page.document.activeElement, button);
  assert.equal(search.readOnly, false);
  page.press(13);
  assert.equal(search.readOnly, true);
  // A page focusing its own field after a controller press holds it too; a touch frees it.
  page.press(12);
  search.focus();
  assert.equal(search.readOnly, true);
  page.fire('pointerdown', { target: search });
  assert.equal(search.readOnly, false);
  assert.equal(page.document.body.classList.contains('gamepad-active'), false);
});
