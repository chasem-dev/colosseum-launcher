'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const parties = require('../src/parties');

test('a first run has no parties and the default rules', () => {
  assert.deepEqual(parties.normalize(undefined),
    { trainer: 'Trainer', parties: [], selected: null, level: 50, size: 6, listed: true });
});

test('trainer names are what the game can show', () => {
  assert.equal(parties.trainerName('  Red  '), 'Red');
  assert.equal(parties.trainerName('Pokémon Master Supreme'), 'Pokemon Ma');
  assert.equal(parties.trainerName('!!!'), 'Trainer');
});

test('a party keeps species the game has, up to six', () => {
  const [party] = parties.normalize({ parties: [{ id: 'one', name: '  Mine ', members: [1, 252, 277, 412, 'x', 6, 9, 25, 150, 151] }] }).parties;
  assert.equal(party.name, 'Mine');
  assert.deepEqual(party.members, [1, 277, 6, 9, 25, 150]);
});

test('party ids stay apart and names are never empty', () => {
  const { parties: list } = parties.normalize({ parties: [{ id: 'same', name: '', members: [] }, { id: 'same', name: 'B', members: [] }] });
  assert.notEqual(list[0].id, list[1].id);
  assert.equal(list[0].name, 'Party 1');
});

test('only a full party can be battled with', () => {
  const full = { id: 'full', name: 'A', members: [1, 2, 3, 4, 5, 6] }, short = { id: 'short', name: 'B', members: [1] };
  assert.equal(parties.selectedParty(parties.normalize({ parties: [full, short], selected: 'full' })).id, 'full');
  assert.equal(parties.selectedParty(parties.normalize({ parties: [full, short], selected: 'short' })), null);
  assert.equal(parties.normalize({ parties: [full], selected: 'gone' }).selected, null);
});

test('rules come from what rooms offer', () => {
  assert.equal(parties.normalize({ level: 100, size: 3 }).level, 100);
  assert.equal(parties.normalize({ level: 100, size: 3 }).size, 3);
  assert.equal(parties.normalize({ level: 75, size: 4 }).level, 50);
  assert.equal(parties.normalize({ level: 75, size: 4 }).size, 6);
  assert.equal(parties.normalize({ listed: false }).listed, false);
});
