'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const formats = require('../src/formats');

// a wire member (src/story-party.js wireMember) with an item, an ability slot and moves
const wire = (species, { item = 0, ability = 0, moves = [] } = {}) => {
  const m = [0, 0, 0, 0];
  moves.forEach((move, i) => { m[i] = move; });
  return [species, 0, 0, 4, ability, item, 255, m[0], 3, m[1], 3, m[2], 3, m[3], 3, 31, 31, 31, 31, 31, 31, 0, 0, 0, 0, 0, 0, '-'];
};

test('a room without a format is Casual, with its level and size as before', () => {
  const rules = formats.normalize({ level: 100, size: 3, stage: 2 });
  assert.equal(rules.format, 'casual');
  assert.equal(rules.level, 100);
  assert.equal(rules.size, 3);
  assert.equal(rules.stage, 2);
  assert.equal(rules.battle, 'single');
  assert.equal(formats.rulesLine(rules), null);
  assert.deepEqual(formats.problems(rules, [6, 9, 3, 150, 150, 251]), []);
  assert.equal(formats.describe(rules).summary, 'Level 100, 3 Pokémon each');
});

test('Casual takes only its level and size', () => {
  const rules = formats.normalize({ format: 'casual', level: 50, size: 6, sleep: 'stadium', battle: 'double', pool: 'ou' });
  assert.equal(rules.sleep, 'off');
  assert.equal(rules.battle, 'single');
  assert.equal(rules.pool, 'any');
});

test('the three formats as players set them up', () => {
  const orre = formats.normalize({ format: 'orre' });
  assert.equal(orre.battle, 'double');
  assert.equal(orre.size, 4);
  assert.equal(orre.level, 100);
  assert.equal(orre.preview, true);
  assert.equal(formats.rulesLine(orre), 'rules double=1 sleep=1 freeze=1 selfko=1 lastmon=1 hp=0');
  const hoenn = formats.normalize({ format: 'hoenn' });
  assert.equal(hoenn.battle, 'single');
  assert.equal(hoenn.size, 3);
  assert.equal(formats.rulesLine(hoenn), 'rules double=0 sleep=1 freeze=1 selfko=1 lastmon=1 hp=0');
  const ou = formats.normalize({ format: 'gen3ou' });
  assert.equal(ou.size, 6);
  assert.equal(ou.preview, false);
  assert.equal(formats.rulesLine(ou), 'rules double=0 sleep=2 freeze=1 selfko=0 lastmon=0 hp=1');
  assert.equal(formats.describe(ou).name, 'Gen 3 OU');
});

test('a named variant shows its name, anything else as custom with what changed', () => {
  assert.equal(formats.describe({ format: 'orre', pool: 'any', soulDew: true }).name, 'Orre Unlimited');
  assert.equal(formats.describe({ format: 'hoenn', level: 50, pool: 'legends' }).name, 'Hoenn Limited');
  const custom = formats.describe({ format: 'orre', level: 50 });
  assert.equal(custom.name, 'Orre Colosseum*');
  assert.equal(custom.custom, true);
  assert.deepEqual(custom.changes, ['Level 50']);
  assert.equal(custom.summary, 'Orre Colosseum* (custom): Level 50');
  assert.equal(formats.describe({ format: 'orre' }).custom, false);
});

test('a size the battle can\'t have falls back to the format\'s', () => {
  assert.equal(formats.normalize({ format: 'orre', battle: 'single' }).size, 3);
  assert.equal(formats.normalize({ format: 'hoenn', size: 4 }).size, 3);
  assert.equal(formats.normalize({ format: 'hoenn', battle: 'double', size: 6 }).size, 6);
});

test('Orre Colosseum: box legendaries and mythical Pokémon out, Articuno and Latios in', () => {
  const rules = { format: 'orre' };
  assert.deepEqual(formats.problems(rules, [144, 408, 6, 9, 3, 25]), []);
  assert.equal(formats.problems(rules, [405, 408, 6, 9, 3, 25]).length, 1);
  assert.equal(formats.problems(rules, [251, 408, 6, 9, 3, 25]).length, 1);
  assert.deepEqual(formats.problems({ format: 'orre', pool: 'any' }, [405, 251, 6, 9, 3, 25]), []);
  assert.equal(formats.problems({ format: 'orre', pool: 'legends' }, [144, 408, 6, 9, 3, 25]).length, 2);
});

test('species, item and Soul Dew clauses', () => {
  const names = { species: id => ({ 6: 'Charizard', 408: 'Latios' })[id], item: id => ({ 200: 'Leftovers', 191: 'Soul Dew' })[id] };
  const party = [6, 6, 9, 3, 25, 408];
  assert.match(formats.problems({ format: 'hoenn' }, party, null, names)[0], /Two Charizard/);
  const members = [wire(6, { item: 200 }), wire(9, { item: 200 }), wire(3), wire(25), wire(130), wire(408, { item: 191 })];
  const found = formats.problems({ format: 'hoenn' }, [6, 9, 3, 25, 130, 408], members, names);
  assert.ok(found.some(text => /Two Pokémon hold Leftovers/.test(text)));
  assert.ok(found.some(text => /Latios holds Soul Dew/.test(text)));
  assert.deepEqual(formats.problems({ format: 'hoenn', pool: 'any', soulDew: true, itemClause: false }, [6, 9, 3, 25, 130, 408], members, names), []);
});

test('Gen 3 OU: Ubers, OHKO and evasion, and Smogon\'s bans', () => {
  const rules = { format: 'gen3ou' };
  assert.equal(formats.problems(rules, [407, 6, 9, 3, 25, 130]).length, 1);   // Latias
  assert.equal(formats.problems(rules, [202, 6, 9, 3, 25, 130]).length, 1);   // Wobbuffet
  assert.deepEqual(formats.problems(rules, [251, 409, 9, 3, 25, 130]), []);   // Celebi and Jirachi are OU
  const party = [131, 113, 143, 101, 235, 197];
  const check = (members, ids = party) => formats.problems(rules, ids, members);
  const plain = [wire(131), wire(113), wire(143), wire(101, { ability: 1 }), wire(235), wire(197)];
  const swap = (slot, member) => plain.map((each, i) => i === slot ? member : each);
  assert.deepEqual(check(plain), []);
  assert.equal(check(swap(0, wire(131, { moves: [329] }))).length, 1);              // Sheer Cold
  assert.equal(check(swap(1, wire(113, { moves: [104] }))).length, 1);              // Double Team
  assert.equal(check(swap(1, wire(113, { item: 179 }))).length, 1);                 // BrightPowder
  assert.equal(check(swap(2, wire(27)), [131, 113, 27, 101, 235, 197]).length, 1);  // Sandslash: Sand Veil
  assert.equal(check(swap(3, wire(101, { ability: 0 }))).length, 1);                // Electrode: Soundproof
  assert.equal(check(swap(4, wire(235, { moves: [275] }))).length, 1);              // Smeargle + Ingrain
  assert.equal(check(swap(5, wire(197, { moves: [226, 212] }))).length, 1);         // Baton Pass + Mean Look
  assert.equal(check(swap(5, wire(197, { moves: [226, 97] }))).length, 1);          // Baton Pass + Agility
  assert.equal(check(swap(5, wire(197, { moves: [226, 14, 347] }))).length, 1);     // two boosts
  assert.equal(check(swap(0, wire(131, { moves: [226, 14] })).map((each, i) => i === 5 ? wire(197, { moves: [226, 347] }) : each)).length, 1);   // two passers
  assert.equal(check(swap(1, wire(113, { item: 183 }))).length, 1);                 // Quick Claw
  assert.equal(check(swap(5, wire(197, { moves: [212, 28] }))).length, 1);          // Mean Look + Sand-Attack
});

test('a short party, and picks', () => {
  assert.equal(formats.problems({ format: 'casual', size: 6 }, [6, 9, 3]).length, 1);
  assert.deepEqual(formats.problems({ format: 'hoenn' }, [6, 9, 3]), []);
  assert.deepEqual(formats.validPick([2, 0, 5], [6, 9, 3, 25, 130, 150], 3), [2, 0, 5]);
  assert.equal(formats.validPick([2, 2, 5], [6, 9, 3, 25, 130, 150], 3), null);
  assert.equal(formats.validPick([2, 0], [6, 9, 3, 25, 130, 150], 3), null);
  assert.equal(formats.validPick([0, 1, 4], [6, 9, 3, 0, 0, 0], 3), null);
  assert.equal(formats.toWin(1), 1);
  assert.equal(formats.toWin(3), 2);
  assert.equal(formats.toWin(5), 3);
  assert.equal(formats.bestOf(7), 1);
});
