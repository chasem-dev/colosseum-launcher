'use strict';

// Later generations, which the player opts into under Settings → Gameplay: their battle rules, and their Pokémon and
// moves. Each is a file of src/generations (gen<N>.json, made from Pokémon Showdown's data and, for moves, Pokémon
// Platinum's by scripts/generation-data/make.js) and how Colosseum plays what it lacks (gen<N>-colosseum.json, written
// by hand).
// Rules and Pokémon are separate choices: Colosseum's own rules with generation 4's Pokémon, or generation 4's rules
// with or without them. A generation added later is another pair of files.
//
// This turns them into what the game's expansion file holds (src/pokemon-packs.js writes it, host/pokemonpacks.c and
// host/mechanics.c read it):
//   - rules: each move's category, the feature bits, and the old moves whose numbers or flags that generation changed;
//   - moves: each new move as a row of Colosseum's move table, copied from the move it plays as (`as`: its effect,
//     animation and messages) with the new move's own numbers and flags. A new move is numbered 3 past its own number,
//     after Colosseum's 355-357 (its own unnamed move, Shadow Rush and "????"), so a saved Pokémon's moves keep their
//     meaning;
//   - Pokémon: each new species as a pack Pokémon's row, numbered 26 past its National Pokédex number (387 is 413,
//     right after Colosseum's 413), with a Pokémon Colosseum has of the same type and stage standing in for its looks
//     and cry until one of its own is converted (src/pbr-models.js).
const fs = require('node:fs');
const path = require('node:path');

const DIRECTORY = path.join(__dirname, 'generations');
const COLOSSEUM_RULES = 3;
const MOVE_OFFSET = 3, FIRST_NEW_MOVE = 355, SPECIES_OFFSET = 26;
const SAME_ABILITIES = 75;   // Stench to Shell Armor: the same numbers in Ruby and later (Ruby's 76 is Cacophony)
const FEATURES = { physicalSpecialSplit: 1, sandstormRockSpecialDefense: 2 };
const CATEGORY = { Physical: 1, Special: 2, Status: 0 };
const MOVE_ROW = 0x38;
// A move's row (decomp include/game/bios_records.h WazaDataBiosFields). 0x06-0x12 are flags, 1 or 0: contact, Protect,
// Magic Coat, Snatch, Mirror Move and King's Rock act on it; Metronome, Mimic, Assist and Sleep Talk can call it; it's
// a sound move (Soundproof); Pressure (unread by the game, and left as Colosseum has it); an HM (can't be forgotten).
// 0x13 marks a move with a drawback for the trainer AI, which no later game has, so it's left as Colosseum has it.
const MV = { priority: 0, pp: 1, type: 2, target: 3, accuracy: 4, chance: 5, power: 0x16, effect: 0x1a };
const FLAGS = { contact: 6, protect: 7, reflectable: 8, snatch: 9, mirror: 0x0a, kingsRock: 0x0b, metronome: 0x0c,
  mimic: 0x0d, assist: 0x0e, sleepTalk: 0x0f, sound: 0x10, hm: 0x12 };
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

// Physical, Special or Status for each of Colosseum's own moves by its id, as a generation's rules make it (the split
// gives each its own; without it the game goes by the move's type, so this is empty). What the team builder shows.
function moveCategories(generation) {
  const data = load(generation), out = {};
  if (!data.mechanics.physicalSpecialSplit) return out;
  for (let id = 1; id < FIRST_NEW_MOVE; id++) if (data.moves[id]) out[id] = data.moves[id].category;
  return out;
}

const colosseumMove = number => number >= FIRST_NEW_MOVE ? number + MOVE_OFFSET : number;
const speciesId = national => national + SPECIES_OFFSET;
const isGenerationSpecies = id => id >= 387 + SPECIES_OFFSET && id < 1100;

// What Colosseum's own moves tell about its move table: which byte each of the generation's ranges is, and "never
// misses".
function learnMoveTable(tables, data) {
  const votes = {}, misses = {};
  for (let id = 1; id < FIRST_NEW_MOVE; id++) {
    const move = data.moves[id], row = tables.moveRows[id];
    if (!move || !row) continue;
    (votes[move.range] ||= {})[row[MV.target]] = (votes[move.range][row[MV.target]] || 0) + 1;
    if (move.accuracy === 0) misses[row[MV.accuracy]] = (misses[row[MV.accuracy]] || 0) + 1;
  }
  const top = counts => Number(Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0]);
  const targets = Object.fromEntries(Object.entries(votes).map(([range, counts]) => [range, top(counts)]));
  return { targets, neverMiss: Object.keys(misses).length ? top(misses) : 0 };
}

// A move's numbers and flags written into a row (a copy of another's, or its own). A range Colosseum has no move of
// keeps the row's.
function writeMove(row, move, learned, tables, { power = move.power, chance = move.effectChance } = {}) {
  const type = tables.types.indexOf(key(move.type));
  row[MV.priority] = move.priority & 0xff;
  row[MV.pp] = move.pp;
  if (type >= 0) row[MV.type] = type;
  if (move.range in learned.targets) row[MV.target] = learned.targets[move.range];
  row[MV.accuracy] = move.accuracy === 0 ? learned.neverMiss : move.accuracy;
  row[MV.chance] = chance;
  for (const [flag, at] of Object.entries(FLAGS)) row[at] = move[flag] ? 1 : 0;
  row.writeUInt16BE(power, MV.power);
  return row;
}

// The added-effect chance a row gets. Platinum's 0 and 100 aren't a roll: its effect never or always happens, and its
// own script makes it so (Bind, Thief, Pay Day have 0; Fake Out, Skull Bash, Overheat 100). Colosseum's scripts read
// the chance as a roll, so where the row plays the move's own effect, it keeps the chance it has (100 for Bind). Any
// other chance is Platinum's.
const chanceFor = (move, row, sameEffect) =>
  sameEffect && (move.effectChance === 0 || move.effectChance === 100) ? row[MV.chance] : move.effectChance;

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
    // A damaging move whose power is worked out as it's used has 1, as Pokémon Platinum has it.
    const power = how.power ?? move.power, from = tables.moveRows[template];
    // The template's chance, where it plays the same effect as Platinum has the move play (Magma Storm as Fire Spin)
    const sameEffect = how.effect === undefined && data.moves[template]?.effect === move.effect;
    const row = writeMove(Buffer.from(from), move, learned, tables, { power, chance: chanceFor(move, from, sameEffect) });
    // The effect the game plays: the template's, or one of the port's own (host/gen4.c's EFFECT_*), or another of the game's.
    if (how.effect !== undefined) row.writeUInt16BE(how.effect, MV.effect);
    // Who it's aimed at, where no move of Colosseum's has its range (Acupressure: the user or its partner).
    if (how.target !== undefined) row[MV.target] = how.target;
    out.push({ id: colosseumMove(number), number, name: move.name.toUpperCase().slice(0, 12), description: move.description,
      row, exact: Boolean(how.exact), note: how.note || '', as: how.as });
  }
  return out;
}

// A generation's rules: its feature bits, each move's category, and Colosseum's own moves as that generation has them
// (power, accuracy, PP, type, priority, range, added-effect chance and flags), as whole rows; their effects, messages
// and animations stay Colosseum's, but for the few whose effect the generation changed (oldMoves).
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
    // A move whose power is worked out as it's used has 1 in Platinum's data. Colosseum's Spit Up has 100 there, the
    // power Ruby and Sapphire multiply by the Stockpile count, as Platinum's script does: it keeps it.
    const power = move.power === 1 ? row.readUInt16BE(MV.power) : move.power;
    // An old move whose effect the generation changed plays another (gen4-colosseum.json's oldMoves): Waterfall flinches.
    const effect = data.colosseum.oldMoves?.[move.name]?.effect;
    const wanted = writeMove(Buffer.from(row), move, learned, tables, { power, chance: chanceFor(move, row, effect === undefined) });
    if (effect !== undefined) wanted.writeUInt16BE(effect, MV.effect);
    if (!wanted.equals(row)) changed.push({ id, row: wanted });
  }
  // The game's own Pokémon with the abilities the generation gives them (Diamond and Pearl gave many a second one:
  // Scizor's Technician, Breloom's Poison Heal), the generation's own by their number in the game (colosseumAbility).
  const numberOf = name => Number(Object.keys(data.abilities).find(n => data.abilities[n].name === name));
  // Ruby's names run some together (LIGHTNINGROD, COMPOUNDEYES): 1 to 75 are the same abilities by number in both
  const abilityId = name => tables.abilities.get(key(name)) ?? (numberOf(name) >= data.newAbilities[0] ? colosseumAbility(numberOf(name))
    : numberOf(name) >= 1 && numberOf(name) <= SAME_ABILITIES ? numberOf(name) : undefined);
  const species = [];
  for (const each of tables.species || []) {
    const entry = each.national >= 1 && each.national <= 386 ? data.species[each.national] : null;
    if (!entry || !each.row) continue;
    const ids = entry.abilities.map(abilityId).filter(Boolean).slice(0, 2);
    if (!ids.length) continue;
    const wanted = [ids[0], ids[1] || 0];
    if (wanted[0] !== each.row[0x32] || wanted[1] !== each.row[0x33]) species.push({ id: each.id, abilities: wanted });
  }
  return { generation: data.generation, features, categories, changed, species };
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
function speciesSpec(tables, data, number, moves, ownAbilities) {
  const entry = data.species[number], playable = new Set(moves.map(move => move.number));
  const usable = n => n < FIRST_NEW_MOVE ? n : playable.has(n) ? colosseumMove(n) : null;
  const abilities = [];
  // Under the generation's own rules its abilities are the game's too (host/gen4.c plays them: build's `abilities`);
  // under Colosseum's, each becomes one the game has.
  const numberOf = name => Number(Object.keys(data.abilities).find(n => data.abilities[n].name === name));
  for (const name of entry.abilities) {
    if (tables.abilities.has(key(name)) || (numberOf(name) >= 1 && numberOf(name) <= SAME_ABILITIES)) abilities.push(name);
    else if (ownAbilities && numberOf(name) >= data.newAbilities[0]) abilities.push(name);
  }
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
    // always, even none: without, the row keeps its stand-in's (Arceus evolved into Linoone)
    evolutions
  };
}

// Everything the settings ask for, for the expansion file: { rules (or null), moves, species: [{ id, number, spec }],
// notes }. tables: src/pokemon-packs.js readGameTables.
// A later generation's ability by the game's number: its own, but Tangled Feet's 77 is Air Lock's in Colosseum (which keeps
// Ruby and Sapphire's numbers, Cacophony 76 and Air Lock 77), so it's 124 (host/gen4.c).
const colosseumAbility = number => number === 77 ? 124 : number;

function build(tables, settings) {
  const chosen = normalize(settings), out = { rules: null, moves: [], abilities: [], species: [], notes: [] };
  const generations = new Set([...chosen.generationPokemon, ...(chosen.battleRules > COLOSSEUM_RULES ? [chosen.battleRules] : [])]);
  const movesOf = new Map();
  for (const generation of [...generations].sort()) {
    const data = load(generation), moves = newMoves(tables, data);
    movesOf.set(generation, moves);
    // The moves come with the generation's rules too, Pokémon or not: its Metronome calls any of them.
    if (chosen.generationPokemon.includes(generation) || chosen.battleRules >= generation) out.moves.push(...moves);
    // its abilities, [name, number], which the game has under its rules
    if (chosen.battleRules >= generation)
      for (let n = data.newAbilities[0]; n <= data.newAbilities[1]; n++) if (data.abilities[n]) out.abilities.push([data.abilities[n].name, colosseumAbility(n)]);
    if (chosen.generationPokemon.includes(generation)) {
      for (let number = data.newSpecies[0]; number <= data.newSpecies[1]; number++)
        if (data.species[number]) out.species.push({ id: speciesId(number), number, generation, spec: speciesSpec(tables, data, number, moves, chosen.battleRules >= generation) });
    }
  }
  if (chosen.battleRules > COLOSSEUM_RULES) out.rules = rules(tables, load(chosen.battleRules), out.moves);
  return out;
}

module.exports = { SAME_ABILITIES, colosseumAbility, COLOSSEUM_RULES, FIRST_NEW_MOVE, MOVE_OFFSET, SPECIES_OFFSET, FEATURES, MV, FLAGS, available, load, normalize, build, moveCategories,
  newMoves, rules, speciesSpec, learnMoveTable, colosseumMove, speciesId, isGenerationSpecies, stageOf };
