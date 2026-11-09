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
  assert.equal(moves.some(move => move.number === 363), false, 'Natural Gift is left out');
});

test("moves have Pokémon Platinum's numbers and flags, and its engine's move lists", () => {
  const data = generations.load(4);
  const fang = data.moves[422];
  assert.equal(fang.effectChance, 10, "Thunder Fang's 10%, though Showdown gives it two added effects");
  assert.deepEqual([data.moves[237].name, data.moves[237].type, data.moves[237].power], ['Hidden Power', 'Normal', 1], 'Hidden Power itself, not a typed copy');
  assert.equal(data.moves[57].range, 'RANGE_ALL_ADJACENT', 'Surf hits a partner too');
  assert.equal(data.moves[203].priority, 3, 'Endure, +3 as Platinum has it');
  const named = list => Object.values(data.moves).filter(move => move[list]).map(move => move.name);
  const without = list => Object.values(data.moves).filter(move => !move[list]).map(move => move.name).sort();
  assert.deepEqual(named('sound').sort(), ['Bug Buzz', 'Chatter', 'Grass Whistle', 'Growl', 'Hyper Voice', 'Metal Sound', 'Roar', 'Screech', 'Sing', 'Snore', 'Supersonic', 'Uproar']);
  assert.deepEqual(named('hm').sort(), ['Cut', 'Defog', 'Fly', 'Rock Climb', 'Rock Smash', 'Strength', 'Surf', 'Waterfall']);
  assert.deepEqual(without('mimic'), ['Chatter', 'Metronome', 'Mimic', 'Sketch', 'Struggle']);
  assert.ok(without('metronome').includes('Feint') && !without('metronome').includes('Metal Burst'));
  assert.ok(!data.moves[264].sleepTalk && !data.moves[19].sleepTalk && !data.moves[467].sleepTalk, 'Focus Punch, Fly and Shadow Force');
  assert.ok(!data.moves[119].assist && data.moves[119].sleepTalk === false, 'Mirror Move calls moves itself');
});

test('a new move gets all its own flags, and keeps a chance its stand-in plays as certain', () => {
  const game = tables(), data = generations.load(4);
  const strength = game.moveRows[70];
  strength[0x12] = 1; strength[0x13] = 1; strength[0x11] = 1;   // an HM, a risky move, Pressure
  game.moves.set('fire spin', 83);
  game.moveRows[83][5] = 100;   // Fire Spin's trap, always
  game.moves.set('thunderpunch', 9);
  game.moveRows[9][5] = 10;
  const colosseum = { ...data.colosseum, moves: Object.fromEntries(Object.entries(data.colosseum.moves).map(([name, how]) =>
    [name, how && { ...how, as: ['Fire Spin', 'ThunderPunch', 'Swift'].includes(how.as) ? how.as : 'Strength' }])) };
  const moves = generations.newMoves(game, { ...data, colosseum });
  const by = name => moves.find(move => move.name === name).row;
  assert.equal(by('AQUA TAIL')[0x12], 0, 'not an HM, though Strength is');
  assert.equal(by('ROCK CLIMB')[0x12], 1, 'an HM in Platinum');
  assert.equal(by('BUG BUZZ')[0x10], 1, 'a sound move');
  assert.equal(by('THUNDER FANG')[5], 10);
  assert.equal(by('THUNDER FANG')[0x0b], 1, "King's Rock");
  assert.equal(by('MAGMA STORM')[5], 100, "Fire Spin's certain trap, where Platinum's data has 0");
  assert.equal(by('CHATTER')[5], 0, 'its own effect in Platinum, not the stand-in\'s');
  assert.deepEqual([by('AQUA TAIL')[0x11], by('AQUA TAIL')[0x13]], [1, 1], 'Pressure and the AI\'s risk stay the stand-in\'s');
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

test("Colosseum's own moves become Platinum's in every number and flag, but effects stay theirs", () => {
  const game = tables(), data = generations.load(4);
  game.moveRows[20][5] = 100;   // Bind traps, always
  game.moveRows[255].writeUInt16BE(100, 0x16);   // Spit Up, 100 a Stockpile
  game.moveRows[148][0x12] = 1;   // Flash, an HM in Ruby and Sapphire
  game.moveRows[127].writeUInt16BE(80, 0x16);
  const changed = new Map(generations.rules(game, data, []).changed.map(change => [change.id, change.row]));
  const row = id => changed.get(id) || game.moveRows[id];
  assert.equal(row(20)[5], 100, "Platinum's 0 is a certain effect, so Bind keeps its 100");
  assert.equal(row(255).readUInt16BE(0x16), 100, 'Spit Up keeps the power its script multiplies');
  assert.equal(row(148)[0x12], 0, 'Flash can be forgotten');
  assert.equal(row(127)[5], 20, "Waterfall's 20% flinch");
  assert.equal(row(127)[0x18], 127, 'the row is otherwise its own');
  assert.equal(row(252)[6], 1, 'Fake Out makes contact');
  assert.equal(row(237)[2], 0, 'Hidden Power stays Normal in the table');
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
