'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const prompts = require('../src/prompts');
const port = require('../src/port');

test('button prompts draw each GameCube button as the style shows it, and as the player bound it', () => {
  const faces = style => prompts.icons(style, {}, {}).slice(0, 4).map(icon => icon.text || icon.symbol);
  assert.deepEqual(faces('gamecube'), ['A', 'B', 'X', 'Y']);
  assert.deepEqual(faces('xbox'), ['A', 'B', 'X', 'Y']);
  assert.deepEqual(faces('playstation'), ['cross', 'circle', 'square', 'triangle']);
  assert.deepEqual(faces('keyboard'), ['Space', 'Shift', 'V', 'F']);
  // A bound to the Y button shows Y; GameCube shows the GameCube's own A whatever the binding.
  assert.equal(prompts.icon('xbox', 'A', {}, { A: ['PAD_Y'] }).text, 'Y');
  assert.equal(prompts.icon('gamecube', 'A', {}, { A: ['PAD_Y'] }).text, 'A');
  assert.equal(prompts.icon('keyboard', 'A', { A: ['J'] }, {}).text, 'J');
  assert.ok(prompts.DRAWN.includes('gamecube') && !prompts.DRAWN.includes('auto'));
});

test('button prompts are Automatic and match the controller unless chosen, and always reach the game', () => {
  const env = settings => port.buildEnvironment(port.normalizeSettings(settings), 'disc', '/port');
  assert.equal(port.normalizeSettings({}).buttonPrompts, 'auto');
  assert.equal(port.normalizeSettings({}).promptPad, 'match');
  assert.equal(port.normalizeSettings({ buttonPrompts: 'sega' }).buttonPrompts, 'auto');
  assert.equal(env({}).SMS_BUTTON_PROMPTS, 'auto');
  assert.equal(env({}).SMS_BUTTON_PROMPT_PAD, 'match');
  assert.equal(env({ buttonPrompts: 'playstation', promptPad: 'nintendo' }).SMS_BUTTON_PROMPTS, 'playstation');
  assert.equal(env({ buttonPrompts: 'playstation', promptPad: 'nintendo' }).SMS_BUTTON_PROMPT_PAD, 'nintendo');
});
