'use strict';

// The Fairy type setting (src/generations.js, src/generations/fairy.json): what the game's file gets, and what an
// online room with the type takes.
const test = require('node:test');
const assert = require('node:assert/strict');
const generations = require('../src/generations');
const pokemonPacks = require('../src/pokemon-packs');
const pokedex = require('../src/pokedex');
const formats = require('../src/formats');
const fairyLearnsets = require('../src/fairy-learnsets');

const key = text => String(text).toLowerCase();
const MOVE = { tackle: 33, gust: 16, hyperVoice: 304, sweetKiss: 186, slam: 21, mistBall: 296, swift: 129, charm: 204,
  auroraBeam: 62, growl: 45, moonlight: 236, quickAttack: 98 };
const FAIRY_MOVE = { disarmingVoice: 577, drainingKiss: 580, playRough: 586, fairyWind: 587, moonblast: 588, dazzlingGleam: 608, babyDollEyes: 611 };

// What readGameTables reads, made up: the moves the Fairy moves play as, each row's effect its number, and three
// Pokémon, Clefairy (35, Normal) learning Pound and Growl, Marill (183, Water) and Pikachu (25, Electric).
function tables() {
  const names = { [MOVE.tackle]: 'Tackle', [MOVE.gust]: 'Gust', [MOVE.hyperVoice]: 'Hyper Voice', [MOVE.sweetKiss]: 'Sweet Kiss',
    [MOVE.slam]: 'Slam', [MOVE.mistBall]: 'Mist Ball', [MOVE.swift]: 'Swift', [MOVE.charm]: 'Charm', [MOVE.auroraBeam]: 'Aurora Beam',
    [MOVE.growl]: 'Growl', [MOVE.moonlight]: 'Moonlight', [MOVE.quickAttack]: 'Quick Attack' };
  const moveRows = Array.from({ length: 358 }, (_, id) => {
    const row = Buffer.alloc(0x38);
    row.writeUInt16BE(id, 0x1a);
    row[0x05] = id === MOVE.auroraBeam ? 10 : 0;
    return row;
  });
  const species = [[35, 0, [[1, 1], [5, MOVE.growl]]], [183, 11, [[1, MOVE.tackle]]], [25, 13, [[1, MOVE.quickAttack]]]].map(([national, type, moves]) => {
    const row = Buffer.alloc(0x11c);
    row.writeUInt16BE(national, 0x12);
    row[0x30] = type; row[0x31] = type;
    moves.forEach(([level, move], i) => { row[0xba + i * 4] = level; row.writeUInt16BE(move, 0xba + i * 4 + 2); });
    return { id: national, national, name: `#${national}`, row };
  });
  return { moves: new Map(Object.entries(names).map(([id, name]) => [key(name), Number(id)])), moveRows,
    abilities: new Map(), types: pokedex.TYPES.map(key), species, tmMoves: new Map() };
}

test('Fairy data: generation 6\'s twenty Pokémon and three moves, and its seven new moves', () => {
  const fairy = generations.loadFairy();
  assert.equal(Object.keys(fairy.species).length, 20);
  assert.deepEqual(fairy.species[282], ['Psychic', 'Fairy'], 'Gardevoir');
  assert.deepEqual(fairy.species[303], ['Steel', 'Fairy'], 'Mawile');
  assert.deepEqual(fairy.species[468], ['Fairy', 'Flying'], 'Togekiss');
  assert.deepEqual(Object.keys(fairy.moves).map(Number), [186, 204, 236]);
  assert.equal(Object.keys(fairy.newMoves).length, 7);
  for (const move of Object.values(fairy.newMoves)) {
    assert.equal(move.type, 'Fairy');
    assert.ok(move.name in fairy.colosseum.moves, move.name);
  }
  assert.deepEqual(fairy.levelUp[35], [[1, 574], [46, 585]], 'Clefairy: Disarming Voice and Moonblast');
});

test('without the setting nothing changes', () => {
  const built = generations.build(tables(), {});
  assert.equal(built.types, null);
  assert.equal(built.moves.length, 0);
  assert.equal(built.ownSpecies.length, 0);
});

test('with it: the Fairy moves, the types the game writes, and level-up moves at generation 6\'s levels', () => {
  const built = generations.build(tables(), { fairyType: true });
  const byId = new Map(built.moves.map(move => [move.id, move]));
  assert.deepEqual([...byId.keys()].sort((a, b) => a - b), Object.values(FAIRY_MOVE).sort((a, b) => a - b));
  for (const move of built.moves) assert.equal(move.row[generations.MV.type], generations.FAIRY_TYPE, move.name);
  // effects: their own (Mist Ball's for Moonblast), another move's (effectAs), or the port's
  assert.equal(byId.get(FAIRY_MOVE.moonblast).row.readUInt16BE(generations.MV.effect), MOVE.mistBall);
  assert.equal(byId.get(FAIRY_MOVE.playRough).row.readUInt16BE(generations.MV.effect), MOVE.auroraBeam);
  assert.equal(byId.get(FAIRY_MOVE.babyDollEyes).row.readUInt16BE(generations.MV.effect), MOVE.growl);
  assert.equal(byId.get(FAIRY_MOVE.disarmingVoice).row.readUInt16BE(generations.MV.effect), MOVE.swift);
  assert.equal(byId.get(FAIRY_MOVE.drainingKiss).row.readUInt16BE(generations.MV.effect), 261);
  // numbers: power, accuracy, priority, chance
  const moonblast = byId.get(FAIRY_MOVE.moonblast).row;
  assert.deepEqual([moonblast.readUInt16BE(generations.MV.power), moonblast[generations.MV.accuracy], moonblast[generations.MV.chance]], [95, 100, 30]);
  assert.equal(byId.get(FAIRY_MOVE.babyDollEyes).row[generations.MV.priority], 1);
  assert.equal(byId.get(FAIRY_MOVE.playRough).row[generations.MV.chance], 10);
  // the game's names: twelve letters at most
  assert.equal(byId.get(FAIRY_MOVE.disarmingVoice).name, 'DISARM VOICE');
  for (const move of built.moves) assert.ok(move.name.length <= 12, move.name);
  // Clefairy and Marill are Fairy types now; Pikachu isn't; Charm, Sweet Kiss and Moonlight are Fairy-type moves
  assert.deepEqual(built.types.species, [{ id: 35, types: [18, 18] }, { id: 183, types: [11, 18] }]);
  assert.deepEqual(built.types.moves.map(each => each.id), [186, 204, 236]);
  assert.equal(built.types.count, 19);
  // Clefairy learns Disarming Voice at 1 and Moonblast at 46, after the disc's moves; Marill Play Rough at 23
  const clefairy = built.ownSpecies.find(each => each.national === 35);
  assert.deepEqual(clefairy.levelUp, [[1, 1], [1, FAIRY_MOVE.disarmingVoice], [5, MOVE.growl], [46, FAIRY_MOVE.moonblast]]);
  assert.deepEqual(clefairy.evolutions, []);
  assert.deepEqual(built.ownSpecies.find(each => each.national === 183).levelUp, [[1, MOVE.tackle], [23, FAIRY_MOVE.playRough]]);
  assert.equal(built.ownSpecies.find(each => each.national === 25), undefined, 'Pikachu learns no Fairy move by level');
});

test('a full list keeps its Fairy moves: the last other moves go', () => {
  const full = Array.from({ length: 20 }, (_, i) => [i + 1, 200 + i]);
  const merged = generations.withFairyMoves(full, 35);
  assert.equal(merged.length, 20);
  assert.ok(merged.some(([, move]) => move === FAIRY_MOVE.moonblast));
  assert.ok(merged.some(([, move]) => move === FAIRY_MOVE.disarmingVoice));
  assert.ok(!merged.some(([, move]) => move === 219) && !merged.some(([, move]) => move === 218), 'the last two of the list');
});

test('the game\'s file gets a TYPE chunk: the species, then the moves', () => {
  const built = generations.build(tables(), { fairyType: true });
  const file = pokemonPacks.compile({ moves: built.moves, types: built.types });
  const chunks = {};
  for (let at = 16, c = 0; c < file.readUInt32BE(8); c++) {
    const size = file.readUInt32BE(at + 4);
    chunks[file.toString('latin1', at, at + 4)] = file.subarray(at + 8, at + 8 + size);
    at += 8 + size + ((4 - size % 4) % 4);
  }
  assert.deepEqual(Object.keys(chunks), ['MOVE', 'TYPE']);
  const type = chunks.TYPE;
  assert.deepEqual([type[0], type[1], type.readUInt16BE(4), type.readUInt16BE(6)], [1, 19, 2, 3]);
  assert.deepEqual([type.readUInt16BE(8), type[10], type[11]], [35, 18, 18]);
  assert.deepEqual([type.readUInt16BE(12), type[14], type[15]], [183, 11, 18]);
  assert.deepEqual([type.readUInt16BE(16), type[18]], [186, 18]);
});

test('a room with the Fairy type takes Fairy moves its Pokémon could know in generation 6, and only such a room', () => {
  const member = (species, moves) => [species, 0, 0, 4, 0, 0, 70, ...moves.flatMap(move => [move, 0]), ...Array(4 - moves.length).fill(0).flatMap(() => [0, 0]),
    31, 31, 31, 31, 31, 31, 0, 0, 0, 0, 0, 0, '-'];
  // Gardevoir (394) Moonblast, Clefable (36) Moonblast as Clefairy learns it, Azumarill (184) Play Rough
  const party = [394, 36, 184, 1], members = [member(394, [FAIRY_MOVE.moonblast]), member(36, [FAIRY_MOVE.moonblast]),
    member(184, [FAIRY_MOVE.playRough]), member(1, [MOVE.tackle])];
  assert.deepEqual(formats.problems({ format: 'orre', fairy: true }, party, members), []);
  const without = formats.problems({ format: 'orre' }, party, members);
  assert.equal(without.length, 3);
  assert.match(without[0], /a Fairy-type move, which plays only in a room with the Fairy type/);
  // Bulbasaur can't learn Moonblast
  assert.deepEqual(formats.problems({ format: 'orre', fairy: true }, party, [...members.slice(0, 3), member(1, [FAIRY_MOVE.moonblast])]),
    ['Pokémon #1 can\'t learn move #588 in generation 6.']);
  assert.equal(fairyLearnsets.learns(394, FAIRY_MOVE.moonblast), true);
  assert.equal(fairyLearnsets.learns(1, FAIRY_MOVE.moonblast), false);
  // the room's rules say so
  assert.equal(formats.normalize({ fairy: true }).fairy, true);
  assert.equal(formats.normalize({ fairy: 1 }).fairy, false);
  assert.match(formats.describe({ format: 'casual', fairy: true }).summary, /the Fairy type$/);
  assert.ok(formats.rulesText({ format: 'hoenn', fairy: true }).includes('the Fairy type'));
});
