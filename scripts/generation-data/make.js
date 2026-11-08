'use strict';

// Makes src/generations/gen<N>.json: a later generation's Pokémon, moves, abilities and battle rules, for the
// launcher's Generations settings (src/generations.js). The data is Pokémon Showdown's (@pkmn/dex, MIT), as that
// generation had it. What Showdown's data doesn't have (catch rate, base experience, EV yield, growth rate, friendship)
// comes from a game of that generation, and is checked against it: Pokémon Battle Revolution, for generation 4, read
// by pbr2pkx's pbrdata.py --dump. Every difference between the two is written to gen<N>-check.md beside this script.
//
// usage: node make.js 4 PBR_DUMP.json
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

// What a species evolves into, as pokemon.json's evolutions say it.
function evolutionsOf(dex, species) {
  return (species.evos || []).map(name => dex.species.get(name)).filter(evo => evo.exists && evo.num <= GENERATIONS[dex.gen].species[1]).map(evo => {
    const into = evo.num;
    if (evo.evoType === 'useItem') return { into, item: evo.evoItem };
    if (evo.evoType === 'trade') return evo.evoItem ? { into, trade: evo.evoItem } : { into, trade: true };
    if (evo.evoType === 'levelFriendship') return { into, friendship: /day/.test(evo.evoCondition || '') ? 'day' : /night/.test(evo.evoCondition || '') ? 'night' : true };
    if (evo.evoLevel) return { into, level: evo.evoLevel, ...(evo.evoCondition ? { condition: evo.evoCondition } : {}) };
    return { into, other: [evo.evoType, evo.evoItem, evo.evoMove, evo.evoCondition].filter(Boolean).join(', ') || 'unknown' };
  });
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

function moveOf(move) {
  const flags = move.flags || {};
  return {
    name: move.name, type: move.type, category: move.category, power: move.basePower,
    accuracy: move.accuracy === true ? null : move.accuracy, pp: move.pp, priority: move.priority, target: move.target,
    contact: Boolean(flags.contact), protect: Boolean(flags.protect), reflectable: Boolean(flags.reflectable),
    snatch: Boolean(flags.snatch), mirror: Boolean(flags.mirror), effectChance: move.secondary?.chance ?? 0,
    description: move.shortDesc
  };
}

// --- Checking against the game's own data ----------------------------------------------------

function compare(report, label, ours, theirs) {
  const a = JSON.stringify(ours), b = JSON.stringify(theirs);
  if (a !== b) report.push(`- ${label}: Showdown ${a}, the game ${b}`);
}

async function main() {
  const [number, dumpFile] = process.argv.slice(2);
  const gen = Number(number), about = GENERATIONS[gen];
  if (!about) throw new Error(`No generation ${number}: this knows ${Object.keys(GENERATIONS).join(', ')}`);
  const dex = Dex.forGen(gen);
  const game = dumpFile ? JSON.parse(fs.readFileSync(dumpFile, 'utf8')) : null;
  const report = [];

  const moves = {};
  for (const move of dex.moves.all()) {
    if (move.isNonstandard || move.num < 1 || move.num > about.moves[1] || move.isZ || move.isMax) continue;
    moves[move.num] = moveOf(move);
  }
  const abilities = {};
  for (const ability of dex.abilities.all()) {
    if (ability.isNonstandard || ability.num < 1 || ability.num > about.abilities[1]) continue;
    abilities[ability.num] = { name: ability.name, description: ability.shortDesc };
  }

  const species = {};
  for (const entry of dex.species.all()) {
    if (entry.isNonstandard || entry.num < 1 || entry.num > about.species[1] || entry.forme) continue;
    const learnset = await learnsetOf(dex, entry);
    const record = {
      name: entry.name, types: entry.types,
      stats: Object.fromEntries(Object.entries(STATS).map(([from, to]) => [to, entry.baseStats[from]])),
      abilities: Object.values(entry.abilities).filter(Boolean), gender: genderOf(entry),
      height: entry.heightm, weight: entry.weightkg, eggGroups: entry.eggGroups,
      evolutions: evolutionsOf(dex, entry), ...learnset
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
      if (missing.length || extra.length) report.push(`- ${name} level-up moves: only the game ${JSON.stringify(missing)}, only Showdown ${JSON.stringify(extra)}`);
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
      ...(game ? [`catch rate, base experience, EV yield, growth rate and friendship: ${game.source}`] : [])],
    species, moves, abilities
  };
  fs.writeFileSync(out, `${JSON.stringify(data)}\n`);
  const checkFile = path.join(__dirname, `gen${gen}-check.md`);
  fs.writeFileSync(checkFile, `# Generation ${gen}: Showdown's data against ${game ? game.source : 'nothing'}\n\n` +
    `${report.length ? report.join('\n') : 'No differences.'}\n`);
  console.log(`${out}: ${Object.keys(species).length} species, ${Object.keys(moves).length} moves, ${Object.keys(abilities).length} abilities, ${(fs.statSync(out).size / 1024).toFixed(0)} KB`);
  console.log(`${checkFile}: ${report.length} differences`);
}

main().catch(error => { console.error(error); process.exit(1); });
