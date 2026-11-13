'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crossplay = require('../src/crossplay');
const formats = require('../src/formats');
const storyParty = require('../src/story-party');

// a wire member (src/story-party.js wireMember), legal in a room for both games unless changed
const wire = (species, { item = 0, ability = 0, moves = [34], ball = 4, ivs = 31, evs = [0, 0, 0, 0, 0, 0], friendship = 255, nickname = '-' } = {}) => {
  const m = [0, 0, 0, 0];
  moves.forEach((move, i) => { m[i] = move; });
  return [species, 1234, 0, ball, ability, item, friendship, m[0], 3, m[1], 3, m[2], 3, m[3], 3, ivs, 31, 31, 31, 31, 31, ...evs, nickname];
};
const one = (species, options) => crossplay.memberProblems(species, wire(species, options));

test('a Pokémon both games make alike goes as it is', () => {
  assert.deepEqual(one(143, { item: 200, ability: 1, moves: [34, 156, 214, 89], evs: [252, 252, 0, 0, 4, 0] }), []);   // Snorlax, Leftovers, Thick Fat
  assert.deepEqual(one(376, { item: 13, moves: [309, 89] }), []);                         // species 376 (Absol) holding a Potion
  assert.deepEqual(one(65, { nickname: '30b230f3' }), []);                                 // a nickname in katakana: both games take it
  assert.deepEqual(crossplay.problems([143, 6, 0], [wire(143), wire(6), null]), []);
  assert.deepEqual(crossplay.problems([143, 6]), []);                                      // species alone
});

test('a Shadow move, of either game, stays out of a room for both games', () => {
  for (const move of [355, 356, 357, 360, 374]) assert.match(one(94, { moves: [247, move] })[0], /a Shadow move \(move #\d+\): rooms for both games have none/);
  assert.match(one(94, { moves: [400] })[0], /move #400, which the other game doesn't have/);   // a later generation's
  assert.match(one(94, { moves: [247, 247] })[0], /twice/);
});

test('a held item the other game doesn\'t have alike', () => {
  for (const item of [592, 0x224, 520, 537, 175, 52, 289]) assert.match(one(94, { item })[0], new RegExp(`item #${item}, which the other game doesn't have as a held item`));
  const names = { species: () => 'Gengar', item: id => (id === 592 ? 'Battle CD 50' : null) };
  assert.equal(crossplay.memberProblems(94, wire(94, { item: 592 }), names)[0], 'Gengar holds Battle CD 50, which the other game doesn\'t have as a held item.');
});

test('a species row only one game has, or neither', () => {
  for (const species of [0, 252, 260, 276, 412, 413, 414, 420, 519]) assert.match(crossplay.memberProblems(species, wire(species))[0], /isn't a Pokémon both games have/);
  assert.match(crossplay.problems([413], null)[0], /Pokémon #413 isn't a Pokémon both games have/);
  assert.deepEqual(crossplay.problems([251, 277, 411]), []);
});

test('a Shadow Pokémon stays home', () => {
  assert.match(crossplay.memberProblems(143, wire(143), {}, true)[0], /is a Shadow Pokémon: it stays home until it's purified/);
});

test('numbers out of range: ball, second ability, EVs, IVs, friendship, nickname', () => {
  assert.match(one(94, { ball: 0 })[0], /a ball the other game doesn't have/);
  assert.match(one(94, { ball: 13 })[0], /a ball the other game doesn't have/);
  assert.match(one(94, { ability: 1 })[0], /a second ability its species doesn't have/);     // Gengar: Levitate only
  assert.deepEqual(one(143, { ability: 1 }), []);                                          // Snorlax: Immunity or Thick Fat
  assert.match(one(94, { evs: [255, 255, 255, 0, 0, 0] })[0], /more EVs/);
  assert.match(one(94, { evs: [256, 0, 0, 0, 0, 0] })[0], /more EVs/);
  assert.match(one(94, { ivs: 40 })[0], /an IV above 31/);
  assert.match(one(94, { friendship: 300 })[0], /friendship is more than 255/);
  assert.match(one(94, { nickname: '534e20ac' })[0], /nickname has a letter the games can't show/);   // a euro sign
});

test('the shared held items are the third generation\'s holdable ones (src/formats.js), with the Enigma Berry left out', () => {
  const rules = { format: 'hoenn' };
  for (let item = 1; item < 0x300; item++) {
    const formatsHolds = !formats.problems(rules, [143], [wire(143, { item })]).some(problem => /can't hold|isn't in|generation/.test(problem));
    if (item === 175 || (item >= 0x224 && item <= 0x289)) continue;   // a later generation's, which formats.js refuses under Colosseum's rules otherwise
    assert.equal(crossplay.isItem(item), formatsHolds, `item ${item}`);
  }
  assert.equal(crossplay.isItem(175), false);
});

test('a Story party in a room for both games: those outside the set stay home, with why', () => {
  const member = (species, extra = {}) => ({ species, rnd: 1, trainer: 2, ball: 4, ability: 0, item: 0, friendship: 70,
    moves: [[34, 0], [0, 0], [0, 0], [0, 0]], ivs: [31, 31, 31, 31, 31, 31], evs: [0, 0, 0, 0, 0, 0], nicknameUnits: [], ...extra });
  const party = [member(143), member(94, { item: 592 }), member(65, { moves: [[356, 0], [94, 0], [0, 0], [0, 0]] }), member(196), member(197, { shadow: true })];
  const { kept, leftOut } = crossplay.storyMembers(party, storyParty.wireMember, { species: id => ({ 94: 'Gengar', 65: 'Alakazam', 197: 'Umbreon' })[id] });
  assert.deepEqual(kept.map(each => each.species), [143, 196]);
  assert.deepEqual(leftOut.map(each => each.why[0]), ['Gengar holds item #592, which the other game doesn\'t have as a held item.',
    'Alakazam knows a Shadow move (move #356): rooms for both games have none.', 'Umbreon is a Shadow Pokémon: it stays home until it\'s purified.']);
});

test('under Platinum\'s rules a room for both games takes the fourth generation\'s', () => {
  const later = { later: true, secondAbility: species => species === 212 || species === 474 };
  const plat = (species, options) => crossplay.memberProblems(species, wire(species, options), {}, false, later);
  // Garchomp with Life Orb (0x251) and later moves (Stone Edge 447, Fire Fang 427); Lucario's second ability
  assert.deepEqual(plat(471, { item: 593, moves: [447, 89, 200, 427] }), []);
  assert.deepEqual(plat(474, { item: 555, ability: 1, moves: [399, 373] }), []);
  assert.deepEqual(plat(212, { ability: 1, moves: [421, 372] }), []);      // Scizor's Technician is the fourth generation's
  assert.deepEqual(plat(143, { item: 175 }), []);                         // the Enigma Berry has an effect under them
  assert.deepEqual(plat(360, { moves: [360, 361] }), []);                 // Colosseum's 358 on: later moves, not Shadow ones
  assert.match(plat(94, { moves: [355] })[0], /a Shadow move/);           // Colosseum's own Shadow moves stay out
  assert.match(plat(143, { ability: 1, moves: [34] })[0], /second ability/);
  assert.match(plat(94, { item: 0x28a })[0], /doesn't have as a held item/);
  // and without them, as before
  assert.match(one(471)[0], /isn't a Pokémon both games have/);
  assert.match(one(212, { ability: 1 })[0], /second ability/);
  assert.deepEqual(crossplay.problems([471, 474], [wire(471, { moves: [447] }), wire(474, { moves: [399] })], {}, later), []);
});
