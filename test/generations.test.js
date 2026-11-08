'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const generations = require('../src/generations');
const pokedex = require('../src/pokedex');

const key = text => String(text).toLowerCase();

// What readGameTables reads from a disc, made up: moves as Colosseum numbers them, each row marked with its number.
function tables() {
  const names = { 33: 'Tackle', 98: 'Quick Attack', 105: 'Recover', 129: 'Swift', 57: 'Surf', 89: 'Earthquake', 14: 'Swords Dance', 315: 'Overheat',
    163: 'Slash', 70: 'Strength', 55: 'Water Gun', 88: 'Rock Throw' };
  const moveRows = Array.from({ length: 358 }, (_, id) => { const row = Buffer.alloc(0x38); row[0x18] = id & 0xff; return row; });
  return { moves: new Map(Object.entries(names).map(([id, name]) => [key(name), Number(id)])), moveRows,
    abilities: new Map([['overgrow', 65]]), types: pokedex.TYPES.map(key), species: [], tmMoves: new Map() };
}

test('generation 4 is there, with its Pokémon, moves and rules', () => {
  const [gen4] = generations.available();
  assert.equal(gen4.generation, 4);
  assert.deepEqual([gen4.newSpecies, gen4.newMoves], [[387, 493], [355, 467]]);
  const data = generations.load(4);
  assert.equal(Object.keys(data.species).length, 493);
  assert.equal(data.species[387].name, 'Turtwig');
  assert.equal(data.moves[7].category, 'Physical', 'Fire Punch is physical in generation 4');
  // Every new move is settled in the hand-written file, played as some move or left out
  for (let n = 355; n <= 467; n++) assert.ok(data.moves[n].name in data.colosseum.moves, data.moves[n].name);
});

test('settings keep only generations there is data for', () => {
  assert.deepEqual(generations.normalize({}), { battleRules: 3, generationPokemon: [] });
  assert.deepEqual(generations.normalize({ battleRules: '4', generationPokemon: [4, 4, 9] }), { battleRules: 4, generationPokemon: [4] });
  assert.deepEqual(generations.normalize({ battleRules: 9 }), { battleRules: 3, generationPokemon: [] });
});

test('new moves keep their numbers, three past their own, and play as the move named', () => {
  assert.equal(generations.colosseumMove(437), 440);
  assert.equal(generations.colosseumMove(33), 33);
  assert.equal(generations.speciesId(387), 413);
  const game = tables(), data = generations.load(4);
  // A made-up table knows only a few moves: give each new move one of those to play as
  const known = ['Recover', 'Quick Attack', 'Overheat', 'Slash', 'Strength', 'Water Gun', 'Rock Throw', 'Swift'];
  const colosseum = { ...data.colosseum, moves: Object.fromEntries(Object.entries(data.colosseum.moves).map(([name, how]) => [name, how && { ...how, as: known.includes(how.as) ? how.as : 'Strength' }])) };
  const moves = generations.newMoves(game, { ...data, colosseum });
  const leafStorm = moves.find(move => move.number === 437);
  assert.equal(leafStorm.id, 440);
  assert.equal(leafStorm.row[0x18], 315 & 0xff, "Overheat's effect");
  assert.equal(leafStorm.row.readUInt16BE(0x16), 140);
  assert.equal(leafStorm.row[2], 12, 'Grass');
  assert.equal(moves.some(move => move.number === 356), false, 'Gravity is left out');
});

test("a generation's rules: categories by move, and the old moves it changed", () => {
  const game = tables(), data = generations.load(4);
  const rules = generations.rules(game, data, [{ id: 440, number: 437 }]);
  assert.equal(rules.features, generations.FEATURES.physicalSpecialSplit | generations.FEATURES.sandstormRockSpecialDefense);
  assert.equal(rules.categories[7], 1, 'Fire Punch, physical');
  assert.equal(rules.categories[53], 2, 'Flamethrower, special');
  assert.equal(rules.categories[14], 0, 'Swords Dance, status');
  assert.equal(rules.categories[440], 2, 'Leaf Storm');
  assert.ok(rules.changed.some(change => change.id === 19 && change.row.readUInt16BE(0x16) === 90), "Fly has generation 4's 90 power");
});

test('a new Pokémon: its own numbers, a stand-in of its type and stage, moves it can use', () => {
  const game = tables(), data = generations.load(4);
  const spec = generations.speciesSpec(game, data, 389, [{ number: 437, id: 440 }]);
  assert.equal(spec.base, 'Sceptile', 'Torterra is a third-stage Grass type');
  assert.equal(spec.national, 389);
  assert.ok(spec.moves.every(([, move]) => move < 355 || move === 440));
  assert.ok(spec.moves.some(([, move]) => move === 440), 'Leaf Storm, as Colosseum numbers it');
  assert.deepEqual(spec.abilities, ['Overgrow']);
  const turtwig = generations.speciesSpec(game, data, 387, []);
  assert.deepEqual(turtwig.evolutions, [{ into: 'generation:388', level: 18 }]);
});

test('Battle Revolution models are made by the game\'s own pbr2pkx, with the build tools\' Python', () => {
  const port = require('../src/port');
  const cmd = port.pbrModelsCommand('/game', '/discs/pbr.rvz', '/data/battle-revolution', [387, 388], 'linux', {});
  assert.equal(cmd.command, 'python3');
  assert.deepEqual(cmd.args, ['/game/tools/pbr2pkx/make_models.py', '/discs/pbr.rvz', '/data/battle-revolution', '387', '388']);
  assert.equal(cmd.cwd, '/game/tools/pbr2pkx');
});
