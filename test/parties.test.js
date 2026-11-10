'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const parties = require('../src/parties');

test('a first run has no parties and the default rules', () => {
  assert.deepEqual(parties.normalize(undefined),
    { trainer: 'Trainer', parties: [], selected: null, level: 50, size: 6, turnTime: 0, battleTime: 0, listed: true, battleRules: 3, format: 'casual',
      custom: {}, bestOf: 1 });
});

test('Casual keeps timers of its own, and each format its changes to its timers', () => {
  const online = parties.normalize({ turnTime: 45, battleTime: 15, custom: { orre: { turnTime: 90 }, hoenn: { battleTime: 20 } } });
  assert.deepEqual([online.turnTime, online.battleTime], [45, 15]);
  assert.deepEqual(online.custom, { orre: { turnTime: 90 } });
  const casual = parties.roomRules(online);
  assert.deepEqual([casual.turnTime, casual.battleTime], [45, 15]);
  const orre = parties.roomRules({ ...online, format: 'orre' });
  assert.deepEqual([orre.turnTime, orre.battleTime], [90, 20]);
  assert.deepEqual([parties.normalize({ turnTime: 500, battleTime: 'x' }).turnTime, parties.normalize({ battleTime: 'x' }).battleTime], [0, 0]);
});

test('a room\'s format keeps only real changes to each format, and Casual its level and size', () => {
  const online = parties.normalize({ format: 'orre', bestOf: 3, custom: { orre: { level: 50, battle: 'double', pool: 'nope' }, hoenn: { level: 100 }, casual: { level: 100 } } });
  assert.equal(online.format, 'orre');
  assert.equal(online.bestOf, 3);
  assert.deepEqual(online.custom, { orre: { level: 50 } });
  assert.equal(parties.roomRules(online).level, 50);
  assert.equal(parties.roomRules(online).battle, 'double');
  assert.equal(parties.roomRules({ ...online, format: 'casual', level: 100, size: 3 }).size, 3);
  assert.equal(parties.normalize({ format: 'vgc', bestOf: 4 }).format, 'casual');
  assert.equal(parties.normalize({ format: 'vgc', bestOf: 4 }).bestOf, 1);
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

test('only a full party can be battled with, and a full party is always chosen', () => {
  const full = { id: 'full', name: 'A', members: [1, 2, 3, 4, 5, 6] }, other = { ...full, id: 'other' }, short = { id: 'short', name: 'B', members: [1] };
  assert.equal(parties.selectedParty(parties.normalize({ parties: [full, other], selected: 'other' })).id, 'other');
  assert.equal(parties.normalize({ parties: [short, full], selected: 'short' }).selected, 'full');
  assert.equal(parties.normalize({ parties: [short, full] }).selected, 'full');
  assert.equal(parties.normalize({ parties: [full], selected: 'gone' }).selected, 'full');
  const none = parties.normalize({ parties: [short], selected: 'short' });
  assert.equal(none.selected, null);
  assert.equal(parties.selectedParty(none), null);
});

test('the Story party stays chosen, whatever the save holds, and isn\'t one of the built parties', () => {
  const full = { id: 'full', name: 'A', members: [1, 2, 3, 4, 5, 6] };
  const story = parties.normalize({ parties: [full], selected: parties.STORY });
  assert.equal(story.selected, parties.STORY);
  assert.equal(parties.selectedParty(story), null);
  assert.equal(parties.normalize({ parties: [], selected: parties.STORY }).selected, parties.STORY);
});

test('rules come from what rooms offer', () => {
  assert.equal(parties.normalize({ level: 100, size: 3 }).level, 100);
  assert.equal(parties.normalize({ level: 100, size: 3 }).size, 3);
  assert.equal(parties.normalize({ level: 75, size: 4 }).level, 50);
  assert.equal(parties.normalize({ level: 75, size: 4 }).size, 6);
  assert.equal(parties.normalize({ listed: false }).listed, false);
});

test('each member has a set, kept with it when others are dropped', () => {
  const set = { species: 6, nature: 3, moves: [53], evs: [0, 252, 0, 0, 0, 252] };
  const [party] = parties.normalize({ parties: [{ id: 'sets', name: 'S', members: [1, 999, 6, 9], sets: [{ species: 1, shiny: true }, { species: 999 }, set, { species: 25 }] }] }).parties;
  assert.deepEqual(party.members, [1, 6, 9]);
  assert.equal(party.sets.length, 3);
  assert.equal(party.sets[0].shiny, true);
  assert.deepEqual(party.sets[1].moves, [53]);
  assert.equal(party.sets[1].nature, 3);
  // a set that was another species' starts again from this one
  assert.deepEqual(party.sets[2].moves, []);
  assert.equal(party.sets[2].species, 9);
});

test('a party saved before sets gets one for each member', () => {
  const [party] = parties.normalize({ parties: [{ id: 'old', name: 'Old', members: [1, 2, 3, 4, 5, 6] }] }).parties;
  assert.deepEqual(party.sets.map(set => set.species), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(party.sets[0].ivs, [31, 31, 31, 31, 31, 31]);
});

test('a room the player makes plays by the battle rules they chose, in any format', () => {
  assert.equal(parties.roomRules(parties.normalize({ battleRules: 4 })).battleRules, 4);
  assert.equal(parties.roomRules(parties.normalize({ format: 'gen3ou', battleRules: 4 })).battleRules, 4);
  assert.equal(parties.roomRules(parties.normalize({ format: 'orre' })).battleRules, 3);
});
