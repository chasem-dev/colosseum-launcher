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
  const gift = moves.find(move => move.number === 363);
  assert.equal(gift.row.readUInt16BE(0x1a), 258, "Natural Gift plays as the port's own effect");
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

test('Acupressure is aimed, as Colosseum has no move for the user or its partner', () => {
  const game = tables(), data = generations.load(4);
  game.moveRows[70][3] = 5;   // the move it plays as here is the user's own, as Focus Energy is on the disc
  const colosseum = { ...data.colosseum, moves: Object.fromEntries(Object.entries(data.colosseum.moves).map(([name, how]) => [name, how && { ...how, as: 'Strength' }])) };
  const acupressure = generations.newMoves(game, { ...data, colosseum }).find(move => move.name === 'ACUPRESSURE');
  assert.equal(acupressure.row[3], 0, 'a move a target is chosen for: the partner, or (aimed at a foe) the user');
  assert.equal(acupressure.row.readUInt16BE(0x1a), 244);
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
  // Astonish, Extrasensory and Needle Arm share Stomp's effect in Colosseum, which doubles against Minimize: in
  // Platinum they only flinch, as Bite does
  for (const id of [310, 326, 302]) assert.equal(row(id).readUInt16BE(0x1a), 31, `move ${id} only flinches`);
  assert.equal(row(23).readUInt16BE(0x1a), 0, "Stomp keeps its own effect (the made-up table's 0)");
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
  // none of its own is none at all, not its stand-in's (Zigzagoon's Linoone at 20, for Arceus)
  assert.deepEqual(generations.speciesSpec(game, data, 493, []).evolutions, []);
});

test('level-up moves and evolutions are Pokémon Platinum\'s', () => {
  const data = generations.load(4);
  assert.deepEqual(data.species[7].levelUp.filter(([level]) => level >= 34), [[34, 334], [37, 240], [40, 56]], 'Squirtle: Iron Defense, Rain Dance, Hydro Pump');
  assert.ok(data.species[2].levelUp.some(([level, move]) => level === 3 && move === 45), 'Ivysaur learns Growl again at 3');
  assert.deepEqual(data.species[193].evolutions, [{ into: 469, knowsMove: 246 }]);
  assert.deepEqual(data.species[412].evolutions, [{ into: 413, level: 20, gender: 'female' }, { into: 414, level: 20, gender: 'male' }]);
  assert.ok(Object.values(data.species).every(entry => entry.levelUp.length <= 20), 'each fits a row');
});

test('a later generation\'s evolutions as Colosseum can make them', () => {
  const data = generations.load(4), usable = n => n < 355 ? n : n + 3;
  const of = number => data.species[number].evolutions.map(evolution => generations.evolutionOf(data, evolution, usable));
  assert.deepEqual(of(193), [{ into: 'generation:469', knowsMove: 246 }], 'Yanma knowing Ancient Power');
  assert.deepEqual(of(190), [{ into: 'generation:424', knowsMove: 458 + 3 }], 'Aipom knowing Double Hit, a new move');
  assert.deepEqual(of(221), [{ into: 'generation:473', knowsMove: 246 }]);
  assert.deepEqual(of(198), [{ into: 'generation:430', level: 35 }], 'Murkrow: no Dusk Stone in the game');
  assert.deepEqual(of(281).slice(-1), [{ into: 'generation:475', level: 35, gender: 'male' }], 'Kirlia: Dawn Stone, male only');
  assert.deepEqual(of(361).slice(-1), [{ into: 'generation:478', level: 35, gender: 'female' }]);
  assert.deepEqual(of(412), [{ into: 'generation:413', level: 20, gender: 'female' }, { into: 'generation:414', level: 20, gender: 'male' }]);
  assert.deepEqual(of(415), [{ into: 'generation:416', level: 21, gender: 'female' }], 'only a female Combee becomes Vespiquen');
  assert.deepEqual(of(447), [{ into: 'generation:448', friendship: true }], 'Riolu: no time of day in the game');
  assert.deepEqual(of(440), [{ into: 113, level: 25 }], 'Happiny holding an Oval Stone');
  assert.deepEqual(of(458), [{ into: 226, withPokemon: 223 }], 'Mantyke with a Remoraid');
  assert.deepEqual(of(439), [{ into: 122, knowsMove: 102 }], 'Mime Jr. knowing Mimic');
  assert.deepEqual(of(82), [{ into: 'generation:462', level: 40 }], 'Magneton: no magnetic field');
  assert.deepEqual(of(133).slice(0, 2), [null, null], 'no mossy or icy rock for Eevee');
  assert.deepEqual(of(112), [{ into: 'generation:464', level: 45 }], 'Rhydon: traded holding a Protector');
});

test('the game\'s own Pokémon learn and evolve as generation 4 has them when its Pokémon are added', () => {
  const game = tables(), data = generations.load(4);
  game.species = [{ id: 193, national: 193, name: 'Yanma', row: Buffer.alloc(0x11c) }, { id: 412, national: 412, name: 'Egg', row: Buffer.alloc(0x11c) }];
  // each move a new one plays as, made up as one of the game's
  Object.values(data.colosseum.moves).filter(Boolean).forEach((how, i) => { if (!game.moves.has(key(how.as))) game.moves.set(key(how.as), 1 + i % 300); });
  const moves = generations.newMoves(game, data);
  const [yanma] = generations.ownSpecies(game, data, moves);
  assert.equal(yanma.id, 193);
  assert.ok(yanma.levelUp.some(([level, move]) => level === 33 && move === 246), 'Ancient Power at 33');
  assert.deepEqual(yanma.evolutions, [{ into: 'generation:469', knowsMove: 246 }]);
  assert.equal(generations.ownSpecies(game, data, moves).length, 1, 'only the game\'s first 386');
  assert.deepEqual(generations.build(game, { generationPokemon: [4] }).ownSpecies.map(each => each.id), [193]);
  assert.deepEqual(generations.build(game, { battleRules: 4 }).ownSpecies, [], 'not with the rules alone');
});

test('Battle Revolution models are made by the game\'s own pbr2pkx, with the build tools\' Python', () => {
  const port = require('../src/port');
  const cmd = port.pbrModelsCommand('/game', '/discs/pbr.rvz', '/data/battle-revolution', [387, 388], 'linux', {});
  assert.equal(cmd.command, 'python3');
  const tools = require('path').join('/game', 'tools', 'pbr2pkx');   // with the system's own separators
  assert.deepEqual(cmd.args, [require('path').join(tools, 'make_models.py'), '/discs/pbr.rvz', '/data/battle-revolution', '387', '388']);
  assert.equal(cmd.cwd, tools);
});

test('Battle Revolution models a newer converter changed count as outdated until they are made again', () => {
  const fs = require('fs'), os = require('os'), path = require('path'), port = require('../src/port');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pbr-outdated-')), models = path.join(root, 'models');
  try {
    // A game whose converter has no remade.json: nothing is outdated
    assert.deepEqual([...port.pbrOutdated(root, models, [410, 412])], []);
    fs.mkdirSync(path.join(root, 'tools', 'pbr2pkx'), { recursive: true });
    fs.writeFileSync(path.join(root, 'tools', 'pbr2pkx', 'remade.json'), JSON.stringify({ version: 3, remade: { 2: [410, 412], 3: [387] } }));
    for (const [number, stamp] of [[387, '2\n'], [410, null], [412, '2\n'], [413, null]]) {
      fs.mkdirSync(path.join(models, String(number)), { recursive: true });
      if (stamp) fs.writeFileSync(path.join(models, String(number), 'models-version.txt'), stamp);
    }
    // 410: made by the first converter (no stamp), which version 2 changed; 387: made by 2, which 3 changed
    assert.deepEqual([...port.pbrOutdated(root, models, [387, 410, 412, 413])].sort(), [387, 410]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the game says whether it makes Battle Revolution cries, and whether it plays a Pokémon\'s own', () => {
  const fs = require('fs'), os = require('os'), path = require('path'), port = require('../src/port');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pbr-cries-'));
  try {
    assert.deepEqual([port.pbrMakesCries(root), port.playsPackCries(root)], [false, false], 'an older game: models only, and the base\'s cry');
    fs.mkdirSync(path.join(root, 'tools', 'pbr2pkx'), { recursive: true });
    fs.writeFileSync(path.join(root, 'tools', 'pbr2pkx', 'cries.py'), '');
    fs.mkdirSync(path.join(root, 'host'));
    fs.writeFileSync(path.join(root, 'host', 'packcries.c'), '');
    assert.deepEqual([port.pbrMakesCries(root), port.playsPackCries(root)], [true, true]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("an ability Ruby writes as one word stays a Pokémon's under Generation 4's rules", () => {
  const data = generations.load(4);
  const row = Buffer.alloc(0x40); row[0x32] = 31; row[0x33] = 69;   // Rhydon: Lightning Rod, Rock Head
  const tables = { species: [{ id: 112, national: 112, row }], abilities: new Map([['lightningrod', 31], ['rock head', 69]]), moveRows: [] };
  const out = generations.rules(tables, data, []);
  assert.equal(out.species.some(each => each.id === 112), false, 'Rhydon keeps both, so it needs no change');
});

test("the team builder's categories under generation 4's rules are each move's own", () => {
  const categories = generations.moveCategories(4);
  assert.equal(categories[7], 'Physical', 'Fire Punch, a Fire move');
  assert.equal(categories[247], 'Special', 'Shadow Ball, a Ghost move');
  assert.equal(categories[237], 'Special', 'Hidden Power, whatever its type');
  assert.equal(categories[68], 'Physical', 'Counter');
  assert.equal(categories[14], 'Status', 'Swords Dance');
  assert.equal(Object.keys(categories).length, generations.FIRST_NEW_MOVE - 1, 'moves 1 to 354, the numbers Colosseum shares with later games');
});
