'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cover = require('../src/jukebox-cover');

test('a song keeps the same colours, and different songs differ', () => {
  const a = { name: 'Phenac City' }, b = { name: 'Agate Village' };
  assert.deepEqual(cover.palette(a), cover.palette({ ...a }));
  assert.notDeepEqual(cover.palette(a), cover.palette(b));
});

test('a song\'s kind comes from its name and whether it is short', () => {
  assert.equal(cover.kind({ name: 'Silence' }), 'silence');
  assert.equal(cover.kind({ name: 'Virtual (Unused)' }), 'unused');
  assert.equal(cover.kind({ name: 'Normal Battle' }), 'battle');
  assert.equal(cover.kind({ name: 'Level Up', short: true }), 'jingle');
  assert.equal(cover.kind({ name: 'Phenac City' }), 'tune');
  assert.equal(cover.kind({}), 'tune');
  for (const name of ['Mt. Battle', 'Mt. Battle Rest Room', 'Mt. Battle rest area', 'Battle Mode Menu', 'Battle Bingo']) assert.equal(cover.kind({ name }), 'tune', name);
  for (const name of ['Battle Bingo battle', 'Colosseum Round 3 Battle', 'Battle vs. Miror B.']) assert.equal(cover.kind({ name }), 'battle', name);
  assert.equal(cover.kind({ name: 'General effect 1', kind: 'sfx' }), 'effect');
});

test('every disc is an svg with ids of its own, a spinning part, and none of the song\'s text', () => {
  const one = cover.disc({ name: 'Phenac City <b>' }), two = cover.disc({ name: 'Phenac City <b>' });
  assert.match(one, /^<svg /);
  assert.match(one, /class="disc-spin"/);
  assert.ok(!one.includes('Phenac') && !one.includes('<b>'));
  const ids = text => [...text.matchAll(/ id="([^"]+)"/g)].map(m => m[1]);
  assert.equal(new Set([...ids(one), ...ids(two)]).size, ids(one).length * 2);
  for (const id of ids(one)) assert.ok(one.includes(`#${id}`), id);
});

test('the page has the places the covers go, and loads the script first', () => {
  const html = fs.readFileSync(path.join(__dirname, '../src/index.html'), 'utf8');
  assert.match(html, /id="jukebox-disc"/);
  assert.ok(html.indexOf('jukebox-cover.js') > 0 && html.indexOf('jukebox-cover.js') < html.indexOf('jukebox-page.js'));
});
