'use strict';

// Makes src/generations/gen<N>.json: a later generation's Pokémon, moves, abilities and battle rules, for the
// launcher's Generations settings (src/generations.js). Names, descriptions, Pokémon and TM, tutor and egg moves are
// Pokémon Showdown's (@pkmn/dex, MIT), as that generation had it. What Showdown's data doesn't have (catch rate, base
// experience, EV yield, growth rate, friendship) comes from a game of that generation, and is checked against it:
// Pokémon Battle Revolution, for generation 4, read by pbr2pkx's pbrdata.py --dump. Each move's numbers and flags are
// the game's own, from pret's decompilation of Pokémon Platinum (res/moves/<move>/data.json, and the move lists its
// battle engine keeps in src/battle), and so are each Pokémon's level-up moves and evolutions (res/pokemon/<species>). Every difference between Showdown and the games is written to gen<N>-check.md
// beside this script.
//
// usage: node make.js 4 PBR_DUMP.json [POKEPLATINUM_DIR]
//   POKEPLATINUM_DIR: a checkout of https://github.com/pret/pokeplatinum (default: $POKEPLATINUM, else
//   ../../../ref/pokeplatinum from here)
//
// How the game plays what Colosseum lacks (a stand-in move for each new move, abilities for new abilities) is written
// by hand, in src/generations/gen<N>-colosseum.json: this checks that it covers what the data names.
const fs = require('node:fs');
const path = require('node:path');
const { Dex } = require('@pkmn/dex');

const GENERATIONS = {
  4: { name: 'Diamond, Pearl and Platinum', species: [387, 493], moves: [355, 467], abilities: [77, 123],
    mechanics: { physicalSpecialSplit: true, sandstormRockSpecialDefense: true } }
};
const STATS = { hp: 'hp', atk: 'attack', def: 'defense', spa: 'spAttack', spd: 'spDefense', spe: 'speed' };

function genderOf(species) {
  if (species.gender === 'N') return 'genderless';
  if (species.gender === 'M') return 0;
  if (species.gender === 'F') return 100;
  return Math.round((species.genderRatio?.F ?? 0.5) * 1000) / 10;
}

async function learnsetOf(dex, species) {
  const gen = String(dex.gen), levelUp = new Map(), tm = new Set(), tutor = new Set(), egg = new Set();
  const data = await dex.learnsets.get(species.id);
  for (const [id, sources] of Object.entries(data?.learnset || {})) {
    const move = dex.moves.get(id);
    if (!move.exists || move.num > GENERATIONS[dex.gen].moves[1]) continue;
    for (const source of sources) {
      if (!source.startsWith(gen)) continue;
      const kind = source[gen.length], rest = source.slice(gen.length + 1);
      if (kind === 'L') {
        const level = Number(rest);
        if (!levelUp.has(move.num)) levelUp.set(move.num, new Set());
        levelUp.get(move.num).add(level);
      } else if (kind === 'M') tm.add(move.num);
      else if (kind === 'T') tutor.add(move.num);
      else if (kind === 'E') egg.add(move.num);
    }
  }
  const levels = [];
  for (const [move, at] of levelUp) for (const level of at) levels.push([level, move]);
  levels.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const sorted = set => [...set].sort((a, b) => a - b);
  return { levelUp: levels, tm: sorted(tm), tutor: sorted(tutor), egg: sorted(egg) };
}

// --- Pokémon Platinum's moves -----------------------------------------------------------------

const PLATINUM_CLASS = { CLASS_PHYSICAL: 'Physical', CLASS_SPECIAL: 'Special', CLASS_STATUS: 'Status' };
const PLATINUM_FLAGS = { contact: 'MOVE_FLAG_MAKES_CONTACT', protect: 'MOVE_FLAG_CAN_PROTECT', reflectable: 'MOVE_FLAG_CAN_MAGIC_COAT',
  snatch: 'MOVE_FLAG_CAN_SNATCH', mirror: 'MOVE_FLAG_CAN_MIRROR_MOVE', kingsRock: 'MOVE_FLAG_TRIGGERS_KINGS_ROCK' };
// Showdown's targets as Platinum's ranges, only to compare the two
const SHOWDOWN_RANGE = { normal: 'RANGE_SINGLE_TARGET', any: 'RANGE_SINGLE_TARGET', adjacentFoe: 'RANGE_SINGLE_TARGET',
  randomNormal: 'RANGE_RANDOM_OPPONENT', allAdjacentFoes: 'RANGE_ADJACENT_OPPONENTS', allAdjacent: 'RANGE_ALL_ADJACENT',
  self: 'RANGE_USER', allySide: 'RANGE_USER_SIDE', allyTeam: 'RANGE_USER_SIDE', all: 'RANGE_FIELD', foeSide: 'RANGE_OPPONENT_SIDE',
  adjacentAlly: 'RANGE_ALLY', adjacentAllyOrSelf: 'RANGE_USER_OR_ALLY', scripted: 'RANGE_SINGLE_TARGET_SPECIAL' };
const typeName = type => type === 'TYPE_MYSTERY' ? '???' : type[5] + type.slice(6).toLowerCase();

// The braces after the first match of `start` (a regular expression's source), from a C file.
function cBody(text, start, file) {
  const at = new RegExp(start).exec(text);
  if (!at) throw new Error(`pokeplatinum: no ${start} in ${file}`);
  const open = text.indexOf('{', at.index + at[0].length - 1);
  for (let i = open, depth = 0; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return text.slice(open, i + 1);
  }
  throw new Error(`pokeplatinum: ${start} in ${file} doesn't close`);
}

// Every move Platinum has, by number: its data.json, and what the battle engine's own move lists say of it.
function platinumMoves(root) {
  const read = file => fs.readFileSync(path.join(root, file), 'utf8');
  const constants = read('generated/moves.txt').split('\n').map(line => line.trim()).filter(Boolean);
  const numbers = new Map(constants.map((name, number) => [name, number]));
  const movesIn = text => [...text.matchAll(/\bMOVE_[A-Z0-9_]+\b/g)].map(m => m[0]).filter(name => numbers.has(name) && name !== 'MOVE_NONE');
  const lib = read('src/battle/battle_lib.c'), script = read('src/battle/battle_script.c');
  // Move_CanBeMimicked / Move_CanBeMetronomed: one list, Mimic's part first
  const forbidden = cBody(lib, String.raw`sCannotMetronomeMoves\[\]\s*=`, 'battle_lib.c');
  const [notMimic, rest] = forbidden.split('FORBIDDEN_BY_MIMIC_DELIM');
  if (rest === undefined) throw new Error('pokeplatinum: sCannotMetronomeMoves has no FORBIDDEN_BY_MIMIC_DELIM');
  const cannotMimic = new Set(movesIn(notMimic)), cannotMetronome = new Set(movesIn(forbidden));
  // Move_IsInvoker: what Sleep Talk, Assist and Copycat never call
  const invokers = new Set(movesIn(cBody(lib, String.raw`BOOL Move_IsInvoker\(u16 move\)\s*\{`, 'battle_lib.c')));
  // Move_IsMultiTurn, by effect
  const multiTurn = new Set([...cBody(lib, String.raw`BOOL Move_IsMultiTurn\([^)]*\)\s*\{`, 'battle_lib.c').matchAll(/\bBATTLE_EFFECT_[A-Z0-9_]+\b/g)].map(m => m[0]));
  // BtlCmd_TrySleepTalk: invokers, its own few moves, and multi-turn moves
  const sleepTalk = cBody(script, String.raw`static BOOL BtlCmd_TrySleepTalk\([^)]*\)\s*\{`, 'battle_script.c');
  if (!/Move_IsInvoker/.test(sleepTalk) || !/Move_IsMultiTurn/.test(sleepTalk)) throw new Error('pokeplatinum: BtlCmd_TrySleepTalk has changed');
  const notSleepTalk = new Set(movesIn(sleepTalk));
  // BtlCmd_TryAssist: neither an invoker nor one Metronome can't call
  const assist = cBody(script, String.raw`static BOOL BtlCmd_TryAssist\([^)]*\)\s*\{`, 'battle_script.c');
  if (!/Move_IsInvoker\(move\) == FALSE && Move_CanBeMetronomed/.test(assist)) throw new Error('pokeplatinum: BtlCmd_TryAssist has changed');
  // Soundproof's list (BattleSystem_TriggerImmunityAbility)
  const sound = new Set(movesIn(cBody(lib, String.raw`sSoundMoves\[\]\s*=`, 'battle_lib.c')));
  // The HMs' moves (Item_IsHMMove)
  const hms = new Set();
  for (let n = 1; n <= 8; n++) hms.add(JSON.parse(read(`res/items/data/hm0${n}.json`)).teachesMove);
  const moves = {};
  for (let number = 1; number < constants.length; number++) {
    const name = constants[number];
    if (!name.startsWith('MOVE_') || name === 'MOVE_NONE') continue;
    const file = path.join('res/moves', name.slice(5).toLowerCase(), 'data.json');
    if (!fs.existsSync(path.join(root, file))) continue;
    const data = JSON.parse(read(file)), flags = new Set(data.flags);
    moves[number] = {
      name: data.name, type: typeName(data.type), category: PLATINUM_CLASS[data.class], power: data.power,
      accuracy: data.accuracy, pp: data.pp, priority: data.priority, range: data.range, effect: data.effect.type,
      effectChance: data.effect.chance,
      ...Object.fromEntries(Object.entries(PLATINUM_FLAGS).map(([key, flag]) => [key, flags.has(flag)])),
      metronome: !cannotMetronome.has(name), mimic: !cannotMimic.has(name),
      assist: !invokers.has(name) && !cannotMetronome.has(name),
      sleepTalk: !invokers.has(name) && !notSleepTalk.has(name) && !multiTurn.has(data.effect.type),
      sound: sound.has(name), hm: hms.has(name)
    };
  }
  return moves;
}

// --- Pokémon Platinum's Pokémon ----------------------------------------------------------------

// How a Pokémon evolves, as Platinum's EVO_* has it (res/pokemon/<species>/data.json): what pokemon.json's evolutions
// say, with what Colosseum lacks kept for gen<N>-colosseum.json to turn into something it has (`heldItem`, `place`).
const PLATINUM_EVOLUTIONS = {
  EVO_LEVEL: level => ({ level }), EVO_LEVEL_MALE: level => ({ level, gender: 'male' }), EVO_LEVEL_FEMALE: level => ({ level, gender: 'female' }),
  EVO_LEVEL_HAPPINESS: () => ({ friendship: true }), EVO_LEVEL_HAPPINESS_DAY: () => ({ friendship: 'day' }),
  EVO_LEVEL_HAPPINESS_NIGHT: () => ({ friendship: 'night' }),
  EVO_TRADE: () => ({ trade: true }), EVO_TRADE_WITH_HELD_ITEM: item => ({ trade: item }),
  EVO_USE_ITEM: item => ({ item }), EVO_USE_ITEM_MALE: item => ({ item, gender: 'male' }), EVO_USE_ITEM_FEMALE: item => ({ item, gender: 'female' }),
  EVO_LEVEL_WITH_HELD_ITEM_DAY: item => ({ heldItem: item, time: 'day' }), EVO_LEVEL_WITH_HELD_ITEM_NIGHT: item => ({ heldItem: item, time: 'night' }),
  EVO_LEVEL_KNOW_MOVE: move => ({ knowsMove: move }), EVO_LEVEL_SPECIES_IN_PARTY: species => ({ withPokemon: species }),
  EVO_LEVEL_MAGNETIC_FIELD: () => ({ place: 'magnetic field' }), EVO_LEVEL_MOSS_ROCK: () => ({ place: 'moss rock' }),
  EVO_LEVEL_ICE_ROCK: () => ({ place: 'ice rock' }),
  // the third generation's, which Colosseum's own Pokémon keep as the game has them
  EVO_LEVEL_ATK_GT_DEF: level => ({ level, other: 'Attack above Defense' }), EVO_LEVEL_ATK_EQ_DEF: level => ({ level, other: 'Attack equal to Defense' }),
  EVO_LEVEL_ATK_LT_DEF: level => ({ level, other: 'Attack below Defense' }), EVO_LEVEL_PID_LOW: level => ({ level, other: 'personality' }),
  EVO_LEVEL_PID_HIGH: level => ({ level, other: 'personality' }), EVO_LEVEL_NINJASK: level => ({ level, other: 'Ninjask' }),
  EVO_LEVEL_SHEDINJA: level => ({ level, other: 'Shedinja' }), EVO_LEVEL_BEAUTY: beauty => ({ other: `beauty ${beauty}` })
};
// ITEM_DUSK_STONE as its name, Dusk Stone
const itemName = constant => constant.slice(5).toLowerCase().split('_').map(word => word[0].toUpperCase() + word.slice(1)).join(' ')
  .replace(/^Up Grade$/, 'Up-Grade').replace(/^Kings Rock$/, 'King\'s Rock');

// Each Pokémon's level-up moves and evolutions as Platinum has them, by National Pokédex number. Showdown's level-up
// moves are all of the generation's games at once (Squirtle's Rain Dance at 34 in HeartGold and SoulSilver, 37 in
// Platinum), and leave out the moves an evolution learns again at a low level (Ivysaur's Growl at 3).
function platinumSpecies(root, last) {
  const lines = file => fs.readFileSync(path.join(root, file), 'utf8').split('\n').map(line => line.trim()).filter(Boolean);
  const species = lines('generated/species.txt'), moves = lines('generated/moves.txt');
  const speciesNumber = new Map(species.map((name, n) => [name, n])), moveNumber = new Map(moves.map((name, n) => [name, n]));
  const value = token => {
    if (typeof token === 'number') return token;
    if (token.startsWith('MOVE_')) return moveNumber.get(token);
    if (token.startsWith('SPECIES_')) return speciesNumber.get(token);
    if (token.startsWith('ITEM_')) return itemName(token);
    throw new Error(`pokeplatinum: an evolution's ${token}`);
  };
  const out = {};
  for (let n = 1; n <= last; n++) {
    const file = path.join(root, 'res', 'pokemon', species[n].slice('SPECIES_'.length).toLowerCase(), 'data.json');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const levelUp = data.learnset.by_level.map(([level, move]) => {
      if (!moveNumber.has(move)) throw new Error(`pokeplatinum: ${species[n]} learns ${move}`);
      return [level, moveNumber.get(move)];
    });
    const evolutions = (data.evolutions || []).map(([method, ...rest]) => {
      if (!PLATINUM_EVOLUTIONS[method]) throw new Error(`pokeplatinum: ${species[n]} evolves by ${method}`);
      const into = value(rest.pop());
      return { into, ...PLATINUM_EVOLUTIONS[method](...rest.map(value)) };
    }).filter(evolution => evolution.into <= last);
    out[n] = { levelUp, evolutions };
  }
  return out;
}

function platinumCommit(root) {
  try {
    const head = fs.readFileSync(path.join(root, '.git', 'HEAD'), 'utf8').trim();
    const ref = /^ref: (.*)$/.exec(head);
    const commit = ref ? fs.readFileSync(path.join(root, '.git', ref[1]), 'utf8').trim() : head;
    return ` ${commit.slice(0, 12)}`;
  } catch { return ''; }
}

// A move: Showdown's name and description, Platinum's numbers and flags. Accuracy 0 is "never misses", and a damaging
// move whose power is worked out as it's used has power 1, as Platinum has them. Differences go in the report.
function moveOf(move, platinum, report) {
  const ours = platinum[move.num];
  if (!ours) throw new Error(`#${move.num} ${move.name} isn't in Pokémon Platinum's data`);
  const flags = move.flags || {}, label = `#${move.num} ${move.name}`;
  const showdown = {
    name: move.name, type: move.type, category: move.category, power: move.basePower,
    accuracy: move.accuracy === true ? 0 : move.accuracy, pp: move.pp, priority: move.priority,
    range: SHOWDOWN_RANGE[move.target] || move.target,
    // A move with several added effects (the Fangs) has them in `secondaries`, each with its chance
    effectChance: move.secondary?.chance ?? move.secondaries?.[0]?.chance ?? 0,
    contact: Boolean(flags.contact), protect: Boolean(flags.protect), reflectable: Boolean(flags.reflectable),
    snatch: Boolean(flags.snatch), mirror: Boolean(flags.mirror), sound: Boolean(flags.sound)
  };
  const normalize = name => name.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (normalize(showdown.name) !== normalize(ours.name)) report.push(`- ${label}: Platinum calls it ${JSON.stringify(ours.name)}`);
  for (const [field, theirs] of Object.entries(showdown)) {
    if (field === 'name') continue;
    let platinumValue = ours[field];
    // Platinum gives a damaging move of worked-out power 1, Showdown 0
    if (field === 'power' && theirs === 0 && platinumValue === 1) continue;
    // Showdown's chance is of the effect it names; Platinum's of the move's one effect. 100 in Showdown is an effect
    // Platinum's move always has, with chance 0
    if (field === 'effectChance' && theirs === 100 && platinumValue === 0) continue;
    if (JSON.stringify(theirs) !== JSON.stringify(platinumValue)) report.push(`- ${label} ${field}: Showdown ${JSON.stringify(theirs)}, Platinum ${JSON.stringify(platinumValue)}`);
  }
  const { name: _, ...numbers } = ours;
  return { name: move.name, ...numbers, description: move.shortDesc };
}

// --- Checking against the game's own data ----------------------------------------------------

function compare(report, label, ours, theirs) {
  const a = JSON.stringify(ours), b = JSON.stringify(theirs);
  if (a !== b) report.push(`- ${label}: Showdown ${a}, the game ${b}`);
}

async function main() {
  const [number, dumpFile, platinumDir] = process.argv.slice(2);
  const gen = Number(number), about = GENERATIONS[gen];
  if (!about) throw new Error(`No generation ${number}: this knows ${Object.keys(GENERATIONS).join(', ')}`);
  const dex = Dex.forGen(gen);
  const game = dumpFile ? JSON.parse(fs.readFileSync(dumpFile, 'utf8')) : null;
  const report = [], moveReport = [], learnsetReport = [];
  const platinumRoot = platinumDir || process.env.POKEPLATINUM || path.join(__dirname, '..', '..', '..', 'ref', 'pokeplatinum');
  if (!fs.existsSync(path.join(platinumRoot, 'res', 'moves'))) throw new Error(`No pokeplatinum checkout at ${platinumRoot}`);
  const platinum = platinumMoves(platinumRoot), platinumPokemon = platinumSpecies(platinumRoot, about.species[1]);

  const moves = {};
  for (const move of dex.moves.all()) {
    // Hidden Power's typed copies (Hidden Power Bug ...) share its number: the move is Hidden Power itself
    if (move.isNonstandard || move.num < 1 || move.num > about.moves[1] || move.isZ || move.isMax || /^Hidden Power ./.test(move.name)) continue;
    moves[move.num] = moveOf(move, platinum, moveReport);
  }
  for (let n = 1; n <= about.moves[1]; n++) if (!moves[n]) throw new Error(`Showdown has no move #${n}`);
  moveReport.sort((a, b) => Number(/#(\d+)/.exec(a)[1]) - Number(/#(\d+)/.exec(b)[1]));
  const abilities = {};
  for (const ability of dex.abilities.all()) {
    if (ability.isNonstandard || ability.num < 1 || ability.num > about.abilities[1]) continue;
    abilities[ability.num] = { name: ability.name, description: ability.shortDesc };
  }

  const species = {};
  for (const entry of dex.species.all()) {
    if (entry.isNonstandard || entry.num < 1 || entry.num > about.species[1] || entry.forme) continue;
    const learnset = await learnsetOf(dex, entry), own = platinumPokemon[entry.num];
    // Level-up moves and evolutions are Platinum's own; what Showdown says differently goes in the report.
    const showdownLevels = learnset.levelUp.map(([l, m]) => `${l}:${moves[m]?.name}`), platinumLevels = own.levelUp.map(([l, m]) => `${l}:${moves[m]?.name}`);
    const onlyPlatinum = platinumLevels.filter(x => !showdownLevels.includes(x)), onlyShowdown = showdownLevels.filter(x => !platinumLevels.includes(x));
    if (onlyPlatinum.length || onlyShowdown.length)
      learnsetReport.push(`- #${entry.num} ${entry.name}: only Platinum ${JSON.stringify(onlyPlatinum)}, only Showdown ${JSON.stringify(onlyShowdown)}`);
    const record = {
      name: entry.name, types: entry.types,
      stats: Object.fromEntries(Object.entries(STATS).map(([from, to]) => [to, entry.baseStats[from]])),
      abilities: Object.values(entry.abilities).filter(Boolean), gender: genderOf(entry),
      height: entry.heightm, weight: entry.weightkg, eggGroups: entry.eggGroups,
      evolutions: own.evolutions, ...learnset, levelUp: own.levelUp
    };
    const theirs = game?.species?.[entry.num];
    if (theirs) {
      // What only the game has
      Object.assign(record, { catchRate: theirs.catchRate, baseExp: theirs.baseExp, evYield: theirs.evYield,
        baseFriendship: theirs.baseFriendship, growthRate: theirs.growthRate });
      if (record.height === undefined) record.height = theirs.height;   // Showdown's data has no heights
      // What both have
      const name = `#${entry.num} ${entry.name}`;
      compare(report, `${name} stats`, record.stats, Object.fromEntries(Object.keys(record.stats).map(k => [k, theirs.stats[k]])));
      compare(report, `${name} types`, [...new Set(record.types)], [...new Set(theirs.types.filter(t => t !== '???'))].map(t => t[0] + t.slice(1).toLowerCase()));
      compare(report, `${name} abilities`, record.abilities, [...new Set(theirs.abilities.map(a => abilities[a]?.name ?? a))]);
      compare(report, `${name} height`, record.height, theirs.height);
      compare(report, `${name} weight`, record.weight, theirs.weight);
      const ourLevels = record.levelUp.map(([l, m]) => `${l}:${moves[m]?.name}`).sort(), theirLevels = theirs.levelUp.map(([l, m]) => `${l}:${moves[m]?.name}`).sort();
      const missing = theirLevels.filter(x => !ourLevels.includes(x)), extra = ourLevels.filter(x => !theirLevels.includes(x));
      if (missing.length || extra.length) report.push(`- ${name} level-up moves: only the game ${JSON.stringify(missing)}, only Platinum ${JSON.stringify(extra)}`);
      const ourTms = record.tm, theirTms = theirs.tms;
      const tmMissing = theirTms.filter(m => !ourTms.includes(m)).map(m => moves[m]?.name), tmExtra = ourTms.filter(m => !theirTms.includes(m)).map(m => moves[m]?.name);
      if (tmMissing.length || tmExtra.length) report.push(`- ${name} TMs and HMs: only the game ${JSON.stringify(tmMissing)}, only Showdown ${JSON.stringify(tmExtra)}`);
    } else if (game) report.push(`- #${entry.num} ${entry.name}: not in the game's data`);
    species[entry.num] = record;
  }

  const out = path.join(__dirname, '..', '..', 'src', 'generations', `gen${gen}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const data = {
    generation: gen, name: about.name, newSpecies: about.species, newMoves: about.moves, newAbilities: about.abilities,
    mechanics: about.mechanics,
    sources: [`Pokémon Showdown's data, generation ${gen} (@pkmn/dex ${require('@pkmn/dex/package.json').version}, MIT)`,
      ...(game ? [`catch rate, base experience, EV yield, growth rate and friendship: ${game.source}`] : []),
      `moves' numbers and flags, level-up moves and evolutions: Pokémon Platinum, by pret's decompilation (pokeplatinum${platinumCommit(platinumRoot)})`],
    species, moves, abilities
  };
  fs.writeFileSync(out, `${JSON.stringify(data)}\n`);
  const checkFile = path.join(__dirname, `gen${gen}-check.md`);
  fs.writeFileSync(checkFile, `# Generation ${gen}: Showdown's data against ${game ? game.source : 'nothing'}\n\n` +
    `${report.length ? report.join('\n') : 'No differences.'}\n\n` +
    `## Moves: Showdown's data against Pokémon Platinum's\n\n` +
    'gen4.json has Platinum\'s numbers and flags, and Showdown\'s names and descriptions. Accuracy 0 is "never misses". ' +
    'Ranges are Platinum\'s, Showdown\'s targets put as the range they mean.\n\n' +
    `${moveReport.length ? moveReport.join('\n') : 'No differences.'}\n\n` +
    `## Level-up moves: Showdown's data against Pokémon Platinum's\n\n` +
    'gen4.json has Platinum\'s. Showdown\'s are all of the generation\'s games at once, HeartGold and SoulSilver too.\n\n' +
    `${learnsetReport.length ? learnsetReport.join('\n') : 'No differences.'}\n`);
  console.log(`${out}: ${Object.keys(species).length} species, ${Object.keys(moves).length} moves, ${Object.keys(abilities).length} abilities, ${(fs.statSync(out).size / 1024).toFixed(0)} KB`);
  console.log(`${checkFile}: ${report.length} differences, ${moveReport.length} in moves, ${learnsetReport.length} in level-up moves`);
}

main().catch(error => { console.error(error); process.exit(1); });
