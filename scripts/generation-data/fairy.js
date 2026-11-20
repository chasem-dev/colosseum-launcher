'use strict';

// Makes src/generations/fairy.json: what the Fairy type setting brings (src/generations.js), from Pokémon Showdown's
// data for generation 6 (@pkmn/dex, MIT), where the type came in:
//   - species: the Pokémon of the first four generations whose types generation 6 changed (Clefairy, Gardevoir...),
//     with their new types;
//   - moves: the moves of the first four generations whose type it changed (Charm, Sweet Kiss, Moonlight);
//   - newMoves: generation 6's Fairy-type attacks and Baby-Doll Eyes, in gen4.json's form (its range and effect names
//     are Pokémon Platinum's, for the effect each plays, and the flags are generation 6's);
//   - levelUp: the levels the first four generations' Pokémon learn those new moves at in generation 6 (X, Y, Omega
//     Ruby and Alpha Sapphire: the earliest where they differ);
//   - learnsets: what else teaches them a new move in generation 6 (a TM, an egg move, an event), for the team builder.
// How the game plays each new move (a move it has, as gen4-colosseum.json does it) is written by hand, in
// src/generations/fairy-colosseum.json.
//
// usage: node fairy.js
const fs = require('node:fs');
const path = require('node:path');
const { Dex } = require('@pkmn/dex');

const LAST_SPECIES = 493, LAST_MOVE = 467;
// The new moves: generation 6's Fairy-type attacks, and Baby-Doll Eyes, a Fairy-type move many Pokémon learn early.
const NEW_MOVES = ['Fairy Wind', 'Disarming Voice', 'Draining Kiss', 'Play Rough', 'Moonblast', 'Dazzling Gleam', 'Baby-Doll Eyes'];
// Showdown's targets, as Pokémon Platinum names a move's range (gen4.json)
const RANGES = { normal: 'RANGE_SINGLE_TARGET', allAdjacentFoes: 'RANGE_ADJACENT_OPPONENTS' };
// The effect each plays, by the name Pokémon Platinum gives the effect of a move that does the same (gen4.json): a
// plain hit, never missing, lowering Sp. Atk or Attack by a chance, lowering Attack. Draining Kiss gives back three
// quarters of the damage, which no move before generation 6 does.
const EFFECTS = {
  'Fairy Wind': 'BATTLE_EFFECT_HIT', 'Disarming Voice': 'BATTLE_EFFECT_BYPASS_ACCURACY',
  'Draining Kiss': 'RECOVER_THREE_QUARTERS_DAMAGE_DEALT', 'Play Rough': 'BATTLE_EFFECT_LOWER_ATTACK_HIT',
  'Moonblast': 'BATTLE_EFFECT_LOWER_SP_ATK_HIT', 'Dazzling Gleam': 'BATTLE_EFFECT_HIT', 'Baby-Doll Eyes': 'BATTLE_EFFECT_ATK_DOWN'
};
const KINDS = { M: 'tm', T: 'tutor', E: 'egg', S: 'event' };

function moveEntry(move) {
  if (!RANGES[move.target]) throw new Error(`${move.name}: no range for Showdown's target ${move.target}`);
  const damaging = move.category !== 'Status';
  return {
    name: move.name, type: move.type, category: move.category, power: move.basePower,
    accuracy: move.accuracy === true ? 0 : move.accuracy, pp: move.pp, priority: move.priority,
    range: RANGES[move.target], effect: EFFECTS[move.name], effectChance: move.secondary?.chance ?? 0,
    ...(move.drain ? { drain: move.drain } : {}),
    contact: Boolean(move.flags.contact), protect: Boolean(move.flags.protect), reflectable: Boolean(move.flags.reflectable),
    snatch: Boolean(move.flags.snatch), mirror: Boolean(move.flags.mirror),
    // From generation 5, King's Rock acts on every damaging move without a flinch chance of its own
    kingsRock: damaging, metronome: true, mimic: true, assist: true, sleepTalk: true,
    sound: Boolean(move.flags.sound), hm: false,
    description: move.shortDesc
  };
}

async function main() {
  const dex = Dex.forGen(6), before = Dex.forGen(5);
  const species = {}, moves = {}, newMoves = {}, levelUp = {}, learnsets = {};
  for (const entry of dex.species.all()) {
    if (entry.isNonstandard || entry.forme || entry.num < 1 || entry.num > LAST_SPECIES) continue;
    const old = before.species.get(entry.id);
    if (old.types.join('/') !== entry.types.join('/')) species[entry.num] = entry.types;
  }
  for (const move of dex.moves.all()) {
    if (move.isNonstandard || move.num < 1 || move.num > LAST_MOVE || /^Hidden Power ./.test(move.name)) continue;
    const old = before.moves.get(move.id);
    if (old.type !== move.type) moves[move.num] = move.type;
  }
  const wanted = new Map();
  for (const name of NEW_MOVES) {
    const move = dex.moves.get(name);
    if (!move.exists) throw new Error(`Showdown has no move ${name}`);
    newMoves[move.num] = moveEntry(move);
    wanted.set(move.id, move.num);
  }
  for (const entry of dex.species.all()) {
    if (entry.isNonstandard || entry.forme || entry.num < 1 || entry.num > LAST_SPECIES) continue;
    const data = await dex.learnsets.get(entry.id), levels = new Map(), other = {};
    for (const [id, sources] of Object.entries(data?.learnset || {})) {
      const number = wanted.get(id);
      if (!number) continue;
      for (const source of sources) {
        if (source[0] !== '6') continue;
        if (source[1] === 'L') levels.set(number, Math.min(levels.get(number) ?? 100, Number(source.slice(2)) || 1));
        else if (KINDS[source[1]]) (other[KINDS[source[1]]] ||= new Set()).add(number);
      }
    }
    if (levels.size) levelUp[entry.num] = [...levels].map(([move, level]) => [level, move]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    if (Object.keys(other).length)
      learnsets[entry.num] = Object.fromEntries(Object.entries(other).map(([kind, set]) => [kind, [...set].sort((a, b) => a - b)]));
  }
  const data = {
    about: 'What the Fairy type setting brings: the Pokémon and moves of the first four generations whose types generation 6 ' +
      'changed, its Fairy-type attacks (newMoves, as gen4.json has moves: Pokémon Platinum\'s range and effect names, for ' +
      'the effect each plays) and the levels each Pokémon learns them at (levelUp), and what else teaches them in ' +
      'generation 6 (learnsets). Made by scripts/generation-data/fairy.js; fairy-colosseum.json says how the game plays ' +
      'each new move.',
    source: `Pokémon Showdown's data, generation 6 (@pkmn/dex ${require('@pkmn/dex/package.json').version}, MIT)`,
    type: 'Fairy', species, moves, newMoves, levelUp, learnsets
  };
  const out = path.join(__dirname, '..', '..', 'src', 'generations', 'fairy.json');
  fs.writeFileSync(out, `${JSON.stringify(data, null, 1)}\n`);
  console.log(`${out}: ${Object.keys(species).length} Pokémon and ${Object.keys(moves).length} moves retyped, ` +
    `${Object.keys(newMoves).length} new moves, ${Object.keys(levelUp).length} Pokémon learn them by level`);
}

main().catch(error => { console.error(error); process.exit(1); });
