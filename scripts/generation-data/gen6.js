'use strict';

// Makes src/generations/gen6.json and gen6-learnsets.json: generation 6's battle rules for the Pokémon and moves the
// game has (the first four generations' Pokémon, their moves, and the Fairy type's: src/generations/fairy.json), from
// Pokémon Showdown's generation 6 data (@pkmn/dex, MIT), on generation 4's file (gen4.json), whose numbers Showdown
// doesn't have (catch rate, base experience, EV yield, growth, friendship, heights, evolutions) and whose effect names
// (Pokémon Platinum's) say what each move does in the game:
//   - each Pokémon's generation 6 types, base stats, abilities and hidden ability (one the game plays: a Gen 3 or 4
//     ability; a hidden ability generation 5 or 6 brought is left out), and its level-up, TM, tutor and egg moves in
//     generation 6 (X, Y, Omega Ruby, Alpha Sapphire: a level-up move at its earliest level), those the game has;
//   - each move's generation 6 power, accuracy, PP, type, priority, category, added-effect chance and flags (its effect
//     stays as gen4.json names it: the game's port plays generation 6's changes to it as mechanics, src/mechanics.js);
//   - the Fairy type's moves (fairy.json's newMoves);
//   - the mechanics generation 6's rules have on (src/mechanics.js).
// Make fairy.js's first.
//
// usage: node gen6.js
const fs = require('node:fs');
const path = require('node:path');
const { Dex } = require('@pkmn/dex');

const OUT = path.join(__dirname, '..', '..', 'src', 'generations');
const LAST_SPECIES = 493, LAST_MOVE = 467, LAST_ABILITY = 123;
const KINDS = { M: 'tm', T: 'tutor', E: 'egg', S: 'event' };
// The flags gen4.json gives a move, from Showdown's (the rest: Platinum's, which generation 6 kept)
const FLAG_MAP = { contact: 'contact', protect: 'protect', reflectable: 'reflectable', snatch: 'snatch', mirror: 'mirror', sound: 'sound' };

async function main() {
  const dex = Dex.forGen(6);
  const gen4 = JSON.parse(fs.readFileSync(path.join(OUT, 'gen4.json'), 'utf8'));
  const fairy = JSON.parse(fs.readFileSync(path.join(OUT, 'fairy.json'), 'utf8'));
  const fairyMoves = new Set(Object.keys(fairy.newMoves).map(Number));
  const playable = num => (num >= 1 && num <= LAST_MOVE) || fairyMoves.has(num);
  const abilityNumber = name => { const a = dex.abilities.get(name); return a.exists ? a.num : 0; };

  // moves: generation 4's entries with generation 6's numbers and flags
  const moves = {};
  for (const [n, entry] of Object.entries(gen4.moves)) {
    const move = dex.moves.get(entry.name);
    if (!move.exists) throw new Error(`Showdown has no move ${entry.name}`);
    const flags = {};
    for (const [ours, theirs] of Object.entries(FLAG_MAP)) flags[ours] = Boolean(move.flags[theirs]);
    const damaging = move.category !== 'Status';
    const flinches = (move.secondaries || []).some(s => s.volatileStatus === 'flinch');
    moves[n] = { ...entry, type: move.type, category: move.category, power: move.basePower === 0 && entry.power === 1 ? 1 : move.basePower,
      accuracy: move.accuracy === true ? 0 : move.accuracy, pp: move.pp, priority: move.priority,
      effectChance: move.secondary?.chance ?? entry.effectChance, ...flags,
      // From generation 5, King's Rock acts on every damaging move without a flinch chance of its own
      kingsRock: damaging && !flinches,
      description: move.shortDesc };
  }
  for (const [n, entry] of Object.entries(fairy.newMoves)) moves[n] = entry;

  // abilities: generation 4's (the game plays those), with generation 6's descriptions
  const abilities = {};
  for (const [n, entry] of Object.entries(gen4.abilities)) {
    const ability = dex.abilities.get(entry.name);
    abilities[n] = { name: entry.name, description: ability.exists ? ability.shortDesc : entry.description };
  }

  const species = {}, learnsets = {};
  let hidden = 0, hiddenLeftOut = 0;
  for (const [n, entry] of Object.entries(gen4.species)) {
    const s = dex.species.get(entry.name);
    if (!s.exists) throw new Error(`Showdown has no Pokémon ${entry.name}`);
    const data = await dex.learnsets.get(s.id), levels = new Map(), other = {};
    for (const [id, sources] of Object.entries(data?.learnset || {})) {
      const move = dex.moves.get(id);
      if (!move.exists || !playable(move.num)) continue;
      for (const source of sources) {
        if (source[0] !== '6') continue;
        if (source[1] === 'L') levels.set(move.num, Math.min(levels.get(move.num) ?? 100, Number(source.slice(2)) || 1));
        else if (KINDS[source[1]]) (other[KINDS[source[1]]] ||= new Set()).add(move.num);
      }
    }
    const levelUp = [...levels].map(([move, level]) => [level, move]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const sorted = set => [...(set || [])].sort((a, b) => a - b);
    const hiddenName = s.abilities.H && abilityNumber(s.abilities.H) <= LAST_ABILITY ? s.abilities.H : null;
    if (s.abilities.H) { if (hiddenName) hidden++; else hiddenLeftOut++; }
    const stats = { hp: s.baseStats.hp, attack: s.baseStats.atk, defense: s.baseStats.def, spAttack: s.baseStats.spa,
      spDefense: s.baseStats.spd, speed: s.baseStats.spe };
    species[n] = { ...entry, types: s.types, stats, abilities: [s.abilities[0], s.abilities[1]].filter(Boolean),
      ...(hiddenName ? { hidden: hiddenName } : {}), levelUp, tm: sorted(other.tm), tutor: sorted(other.tutor), egg: sorted(other.egg) };
    learnsets[n] = { levelUp, ...Object.fromEntries(Object.entries(other).map(([kind, set]) => [kind, sorted(set)])) };
  }

  const data = {
    generation: 6, name: 'X and Y', newSpecies: [494, 493], newMoves: [355, 611], newAbilities: gen4.newAbilities,
    mechanics: require('../../src/mechanics').preset(6),
    sources: [`Pokémon Showdown's data, generation 6 (@pkmn/dex ${require('@pkmn/dex/package.json').version}, MIT)`,
      'catch rate, base experience, EV yield, growth rate, friendship, heights, weights and evolutions: gen4.json (Pokemon Battle Revolution, Pokémon Platinum)'],
    species, moves, abilities
  };
  fs.writeFileSync(path.join(OUT, 'gen6.json'), `${JSON.stringify(data)}\n`);
  fs.writeFileSync(path.join(OUT, 'gen6-learnsets.json'),
    `${JSON.stringify({ source: `Pokémon Showdown's data, generation 6 (@pkmn/dex ${require('@pkmn/dex/package.json').version}, MIT)`, species: learnsets })}\n`);
  console.log(`gen6.json: ${Object.keys(species).length} Pokémon (${hidden} with a hidden ability the game plays, ${hiddenLeftOut} left out), ${Object.keys(moves).length} moves`);
}

main().catch(error => { console.error(error); process.exit(1); });
