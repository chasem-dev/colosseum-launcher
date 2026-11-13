'use strict';

const test = require('node:test');
const assert = require('node:assert');
const windowMode = require('../src/window-mode');

test('window mode: only known modes are kept', () => {
  assert.strictEqual(windowMode.normalize('fullscreen'), 'fullscreen');
  assert.strictEqual(windowMode.normalize('maximized'), 'maximized');
  for (const value of [undefined, null, '', 'huge', true, 3]) assert.strictEqual(windowMode.normalize(value), 'normal');
});

test('window mode: full screen wins over maximized', () => {
  const window = (fullscreen, maximized) => ({ isFullScreen: () => fullscreen, isMaximized: () => maximized });
  assert.strictEqual(windowMode.modeOf(window(true, true)), 'fullscreen');
  assert.strictEqual(windowMode.modeOf(window(false, true)), 'maximized');
  assert.strictEqual(windowMode.modeOf(window(false, false)), 'normal');
  assert.strictEqual(windowMode.modeOf(null), 'normal');
});
