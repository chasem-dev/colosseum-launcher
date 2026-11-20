'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const mechanics = require('../src/mechanics');

test('each generation\'s rules are a preset of the mechanics up to it; Colosseum\'s have none', () => {
  assert.deepEqual(mechanics.preset(3), []);
  assert.deepEqual(mechanics.preset(4), ['physicalSpecialSplit', 'sandstormRockSpecialDefense']);
  const six = mechanics.preset(6);
  assert.equal(six.length, mechanics.MECHANICS.length);
  assert.ok(six.includes('gen6Types') && six.includes('damage') && six.includes('hiddenAbilities'));
});

test('a player\'s changes go on top of the preset, and come back as the same changes', () => {
  const chosen = mechanics.choose(6, { criticalHits: false, bogus: true, sleep: 'no' });
  assert.ok(!chosen.includes('criticalHits') && chosen.includes('sleep'));
  assert.deepEqual(mechanics.changesFrom(6, chosen), { criticalHits: false });
  // the engine's need rules of generation 4 or later; the launcher's don't
  assert.deepEqual(mechanics.choose(3, { criticalHits: true, gen6Types: true, physicalSpecialSplit: true }), ['physicalSpecialSplit', 'gen6Types']);
  assert.deepEqual(mechanics.choose(4, { damage: true }), ['physicalSpecialSplit', 'sandstormRockSpecialDefense', 'damage']);
});

test('the game\'s features are a bit for each of its mechanics, as host/mechanics.h numbers them', () => {
  assert.equal(mechanics.features(mechanics.preset(6)), 0xFFFF);
  assert.equal(mechanics.features(['physicalSpecialSplit', 'gen6Types', 'gen6Stats']), 1);
  const bits = mechanics.MECHANICS.filter(each => each.bit !== undefined).map(each => each.bit);
  assert.equal(new Set(bits).size, bits.length);
});

test('the game\'s bits run 0 to 15 with none missing (host/mechanics.h numbers them the same)', () => {
  const bits = mechanics.MECHANICS.filter(each => each.bit !== undefined).sort((a, b) => a.bit - b.bit).map(each => each.bit);
  assert.deepEqual(bits, [...Array(16).keys()]);
});
