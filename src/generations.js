'use strict';

// Later generations, which the player opts into under Settings → Gameplay: their battle rules, and their Pokémon and
// moves. Each is a file of src/generations (gen<N>.json, made from Pokémon Showdown's data by
// scripts/generation-data/make.js) and how Colosseum plays what it lacks (gen<N>-colosseum.json, written by hand).
// Rules and Pokémon are separate choices: Colosseum's own rules with generation 4's Pokémon, or generation 4's rules
// with or without them. A generation added later is another pair of files.
//
// This turns them into what the game's expansion file holds (src/pokemon-packs.js writes it, host/pokemonpacks.c and
// host/mechanics.c read it):
//   - rules: each move's category, the feature bits, and the old moves whose numbers that generation changed;
//   - moves: each new move as a row of Colosseum's move table, copied from the move it plays as (`as`: its effect,
//     animation and messages) with the new move's own numbers. A new move is numbered 3 past its own number, after
//     Colosseum's 355-357 (its own unnamed move, Shadow Rush and "????"), so a saved Pokémon's moves keep their meaning;
//   - Pokémon: each new species as a pack Pokémon's row, numbered 26 past its National Pokédex number (387 is 413,
//     right after Colosseum's 413), with a Pokémon Colosseum has of the same type and stage standing in for its looks
//     and cry until one of its own is converted (src/pbr-models.js).
const fs = require('node:fs');
const path = require('node:path');

const DIRECTORY = path.join(__dirname, 'generations');
const COLOSSEUM_RULES = 3;
const MOVE_OFFSET = 3, FIRST_NEW_MOVE = 355, SPECIES_OFFSET = 26;
const FEATURES = { physicalSpecialSplit: 1, sandstormRockSpecialDefense: 2 };
const CATEGORY = { Physical: 1, Special: 2, Status: 0 };
const MOVE_ROW = 0x38;
const MV = { priority: 0, pp: 1, type: 2, target: 3, accuracy: 4, chance: 5, contact: 6, protect: 7, magicCoat: 8, snatch: 9, mirror: 0x0a, power: 0x16, effect: 0x1a };
// Who stands in for a new Pokémon's looks and cry: a Pokémon Colosseum has, by first type and stage.
const STAND_INS = {
  Grass: ['Treecko', 'Grovyle', 'Sceptile'], Fire: ['Torchic', 'Combusken', 'Blaziken'], Water: ['Mudkip', 'Marshtomp', 'Swampert'],
  Normal: ['Zigzagoon', 'Linoone', 'Slaking'], Electric: ['Electrike', 'Manectric', 'Manectric'], Bug: ['Wurmple', 'Dustox', 'Beautifly'],
  Flying: ['Taillow', 'Swellow', 'Swellow'], Psychic: ['Ralts', 'Kirlia', 'Gardevoir'], Rock: ['Aron', 'Lairon', 'Aggron'],
  Ground: ['Trapinch', 'Vibrava', 'Flygon'], Ghost: ['Shuppet', 'Banette', 'Dusclops'], Ice: ['Snorunt', 'Glalie', 'Glalie'],
  Dragon: ['Bagon', 'Shelgon', 'Salamence'], Dark: ['Poochyena', 'Mightyena', 'Absol'], Steel: ['Beldum', 'Metang', 'Metagross'],
  Poison: ['Gulpin', 'Swalot', 'Swalot'], Fighting: ['Makuhita', 'Hariyama', 'Hariyama']
};

const key = text => String(text).toLowerCase().replace(/[\s_]+/g, ' ').replace(/é/g, 'e').trim();
const cache = new Map();

// The generations there are data for: { generation, name, newSpecies, newMoves }.
function available() {
  return fs.readdirSync(DIRECTORY).map(name => /^gen(\d+)\.json$/.exec(name)).filter(Boolean)
    .map(match => Number(match[1])).sort((a, b) => a - b).map(n => {
      const data = load(n);
      return { generation: n, name: data.name, newSpecies: data.newSpecies, newMoves: data.newMoves, mechanics: Object.keys(data.mechanics) };
    });
}

function load(generation) {
  if (!cache.has(generation)) {
    const data = JSON.parse(fs.readFileSync(path.join(DIRECTORY, `gen${generation}.json`), 'utf8'));
    data.colosseum = JSON.parse(fs.readFileSync(path.join(DIRECTORY, `gen${generation}-colosseum.json`), 'utf8'));
    cache.set(generation, data);
  }
  return cache.get(generation);
}

// The settings as kept: rules of a generation there is data for (else Colosseum's), and the generations whose Pokémon
// are imported.
function normalize(input = {}) {
  const known = new Set(available().map(each => each.generation));
  const rules = known.has(Number(input.battleRules)) ? Number(input.battleRules) : COLOSSEUM_RULES;
  const pokemon = [...new Set((Array.isArray(input.generationPokemon) ? input.generationPokemon : []).map(Number).filter(n => known.has(n)))].sort();
  return { battleRules: rules, generationPokemon: pokemon };
}

const colosseumMove = number => number >= FIRST_NEW_MOVE ? number + MOVE_OFFSET : number;
const speciesId = national => national + SPECIES_OFFSET;
const isGenerationSpecies = id => id >= 387 + SPECIES_OFFSET && id < 1100;

// What Colosseum's own moves tell about its move table: which byte each kind of target is, and "never misses".
function learnMoveTable(tables, data) {
  const votes = {}, misses = {};
  for (let id = 1; id < FIRST_NEW_MOVE; id++) {
    const move = data.moves[id], row = tables.moveRows[id];
    if (!move || !row) continue;
    (votes[move.target] ||= {})[row[MV.target]] = (votes[move.target][row[MV.target]] || 0) + 1;
    if (move.accuracy === null) misses[row[MV.accuracy]] = (misses[row[MV.accuracy]] || 0) + 1;
  }
  const top = counts => Number(Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0]);
  const targets = Object.fromEntries(Object.entries(votes).map(([target, counts]) => [target, top(counts)]));
  return { targets, neverMiss: top(misses) };
}

// A move's numbers written into a row (a copy of another's, or its own).
function writeMove(row, move, learned, tables, power = move.power) {
  const type = tables.types.indexOf(key(move.type));
  row[MV.priority] = move.priority & 0xff;
  row[MV.pp] = move.pp;
  if (type >= 0) row[MV.type] = type;
  if (move.target in learned.targets) row[MV.target] = learned.targets[move.target];
  row[MV.accuracy] = move.accuracy === null ? learned.neverMiss : move.accuracy;
  row[MV.chance] = move.effectChance;
  row[MV.contact] = move.contact ? 1 : 0;
  row[MV.protect] = move.protect ? 1 : 0;
  row[MV.magicCoat] = move.reflectable ? 1 : 0;
  row[MV.snatch] = move.snatch ? 1 : 0;
  row[MV.mirror] = move.mirror ? 1 : 0;
  row.writeUInt16BE(power, MV.power);
  return row;
}

// The new moves a generation brings that Colosseum can play, by Colosseum's number: { id, name, description, row,
// number (its own), exact, note }. Problems in the hand-written file are thrown.
function newMoves(tables, data) {
  const learned = learnMoveTable(tables, data), out = [];
  for (let number = data.newMoves[0]; number <= data.newMoves[1]; number++) {
    const move = data.moves[number];
    if (!move) continue;
    if (!(move.name in data.colosseum.moves)) throw new Error(`generation ${data.generation}: ${move.name} isn't in gen${data.generation}-colosseum.json`);
    const how = data.colosseum.moves[move.name];
    if (!how) continue;
    const template = tables.moves.get(key(how.as));
    if (!template || template >= FIRST_NEW_MOVE) throw new Error(`generation ${data.generation}: ${move.name} plays as "${how.as}", which Colosseum hasn't`);
    // A damaging move whose power is worked out as it's used has 1 in its row, as Pokémon Platinum has it.
    const power = how.power ?? (move.power || (move.category === 'Status' ? 0 : 1));
    const row = writeMove(Buffer.from(tables.moveRows[template]), move, learned, tables, power);
    // The effect the game plays: the template's, or one of the port's own (host/gen4.c's EFFECT_*), or another of the game's.
    if (how.effect !== undefined) row.writeUInt16BE(how.effect, MV.effect);
    out.push({ id: colosseumMove(number), number, name: move.name.toUpperCase().slice(0, 12), description: move.description,
      row, exact: Boolean(how.exact), note: how.note || '', as: how.as });
  }
  return out;
}

// A generation's rules: its feature bits, each move's category, and Colosseum's own moves as that generation numbered
// them (power, accuracy, PP, type, priority, targets).
function rules(tables, data, moves) {
  let features = 0;
  for (const [name, on] of Object.entries(data.mechanics)) if (on && FEATURES[name]) features |= FEATURES[name];
  const highest = Math.max(FIRST_NEW_MOVE, ...moves.map(move => move.id + 1));
  const categories = Buffer.alloc(highest);
  for (let id = 1; id < FIRST_NEW_MOVE; id++) if (data.moves[id]) categories[id] = CATEGORY[data.moves[id].category];
  for (const move of moves) categories[move.id] = CATEGORY[data.moves[move.number].category];
  const learned = learnMoveTable(tables, data), changed = [];
  for (let id = 1; id < FIRST_NEW_MOVE; id++) {
    const move = data.moves[id], row = tables.moveRows[id];
    if (!move || !row) continue;
    const wanted = Buffer.from(row);
    wanted[MV.priority] = move.priority & 0xff;
    wanted[MV.pp] = move.pp;
    const type = tables.types.indexOf(key(move.type));
    if (type >= 0) wanted[MV.type] = type;
    if (move.target in learned.targets) wanted[MV.target] = learned.targets[move.target];
    wanted[MV.accuracy] = move.accuracy === null ? row[MV.accuracy] : move.accuracy;
    if (move.power) wanted.writeUInt16BE(move.power, MV.power);
    if (!wanted.equals(row)) changed.push({ id, row: wanted });
  }
  return { generation: data.generation, features, categories, changed };
}

function stageOf(data, number) {
  const parents = new Map();
  for (const [n, entry] of Object.entries(data.species)) for (const evolution of entry.evolutions) parents.set(evolution.into, Number(n));
  let stage = 1;
  while (parents.has(number) && stage < 3) { number = parents.get(number); stage++; }
  return stage;
}

// A new species as a pokemon.json (src/pokemon-packs.js buildRow takes it): its own numbers, moves by Colosseum's number,
// abilities Colosseum has, and evolutions it can make.
function speciesSpec(tables, data, number, moves) {
  const entry = data.species[number], playable = new Set(moves.map(move => move.number));
  const usable = n => n < FIRST_NEW_MOVE ? n : playable.has(n) ? colosseumMove(n) : null;
  const abilities = [];
  for (const name of entry.abilities) if (tables.abilities.has(key(name))) abilities.push(name);
  if (!abilities.length) abilities.push(...entry.abilities.map(name => data.colosseum.abilities[name]).filter(Boolean));
  const levelUp = entry.levelUp.map(([level, move]) => [Math.max(1, level), usable(move)]).filter(([, move]) => move);
  // At most twenty, as a row holds: the first ones it learns, as a Pokémon met at a level knows its latest four
  const moveList = levelUp.slice(0, 20);
  const evolutions = [];
  for (const evolution of entry.evolutions) {
    const into = evolution.into > 386 ? `generation:${evolution.into}` : evolution.into;
    if (evolution.level) evolutions.push({ into, level: evolution.level });
    else if (evolution.friendship) evolutions.push({ into, friendship: evolution.friendship });
    else if (evolution.trade === true) evolutions.push({ into, trade: true });
    else {
      const item = evolution.item || evolution.trade;
      const level = data.colosseum.evolutionItems[item];
      if (item && level === undefined) evolutions.push({ into, [evolution.item ? 'item' : 'trade']: item });
      else evolutions.push({ into, level: level || 36 });
    }
  }
  const types = [...new Set(entry.types)];
  return {
    base: (STAND_INS[types[0]] || STAND_INS.Normal)[stageOf(data, number) - 1],
    name: entry.name.toUpperCase().slice(0, 10), national: number,
    description: `Generation ${data.generation}, National Pokédex #${number}.`,
    types, stats: entry.stats, ...(entry.evYield ? { evYield: entry.evYield } : {}),
    ...(entry.catchRate ? { catchRate: entry.catchRate } : {}), ...(entry.baseExp ? { baseExp: entry.baseExp } : {}),
    ...(entry.baseFriendship !== undefined ? { baseFriendship: entry.baseFriendship } : {}),
    ...(entry.growthRate ? { growthRate: entry.growthRate } : {}),
    gender: entry.gender, ...(entry.height ? { height: entry.height } : {}), ...(entry.weight ? { weight: entry.weight } : {}),
    ...(abilities.length ? { abilities: abilities.slice(0, 2) } : {}),
    moves: moveList.length ? moveList : [[1, 33]],
    tmMoves: entry.tm.map(usable).filter(Boolean),
    ...(evolutions.length ? { evolutions } : {})
  };
}

// Everything the settings ask for, for the expansion file: { rules (or null), moves, species: [{ id, number, spec }],
// notes }. tables: src/pokemon-packs.js readGameTables.
function build(tables, settings) {
  const chosen = normalize(settings), out = { rules: null, moves: [], species: [], notes: [] };
  const generations = new Set([...chosen.generationPokemon, ...(chosen.battleRules > COLOSSEUM_RULES ? [chosen.battleRules] : [])]);
  const movesOf = new Map();
  for (const generation of [...generations].sort()) {
    const data = load(generation), moves = newMoves(tables, data);
    movesOf.set(generation, moves);
    if (chosen.generationPokemon.includes(generation)) {
      out.moves.push(...moves);
      for (let number = data.newSpecies[0]; number <= data.newSpecies[1]; number++)
        if (data.species[number]) out.species.push({ id: speciesId(number), number, generation, spec: speciesSpec(tables, data, number, moves) });
    }
  }
  if (chosen.battleRules > COLOSSEUM_RULES) out.rules = rules(tables, load(chosen.battleRules), out.moves);
  return out;
}

module.exports = { COLOSSEUM_RULES, FIRST_NEW_MOVE, MOVE_OFFSET, SPECIES_OFFSET, FEATURES, available, load, normalize, build,
  newMoves, rules, speciesSpec, learnMoveTable, colosseumMove, speciesId, isGenerationSpecies, stageOf };
