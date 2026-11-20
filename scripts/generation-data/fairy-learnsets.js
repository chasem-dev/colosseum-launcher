'use strict';

// Makes src/fairy-learnsets.js: the Fairy type setting's new moves (src/generations/fairy.json) each Pokémon could know
// in generation 6, by level, TM, move tutor, egg or event, with what each earlier form could (Azumarill what Marill and
// Azurill could), by the game's species and move numbers. The online formats check a party in a room with the Fairy type
// against it (src/formats.js, "Only legal Pokémon"), as they check the rest against src/gen3-learnsets.js and
// src/gen4-learnsets.js. Make fairy.js's first.
//
// usage: node fairy-learnsets.js PATH-TO-DISC.iso
const fs = require('node:fs');
const path = require('node:path');
const generations = require('../../src/generations');
const pokemonPacks = require('../../src/pokemon-packs');

function main() {
  const [rom] = process.argv.slice(2);
  if (!rom) throw new Error('usage: node fairy-learnsets.js PATH-TO-DISC.iso');
  const fairy = generations.loadFairy(), gen4 = generations.load(4), tables = pokemonPacks.readGameTables(rom);
  // the game's number for each National Pokédex number: its own Pokémon's, then the fourth generation's (26 past theirs)
  const idOf = new Map();
  for (const each of tables.species) if (each.national >= 1 && each.national <= 386 && !idOf.has(each.national)) idOf.set(each.national, each.id);
  for (let n = 387; n <= 493; n++) idOf.set(n, generations.speciesId(n));
  const parent = new Map();
  for (const [national, entry] of Object.entries(gen4.species))
    for (const evolution of entry.evolutions || []) if (!parent.has(evolution.into)) parent.set(evolution.into, Number(national));
  const own = national => new Set([...(fairy.levelUp[national] || []).map(([, move]) => move),
    ...Object.values(fairy.learnsets[national] || {}).flat()]);
  const lines = [];
  for (let national = 1; national <= 493; national++) {
    const moves = new Set();
    for (let form = national, depth = 0; form && depth < 3; form = parent.get(form), depth++) for (const move of own(form)) moves.add(move);
    if (!moves.size) continue;
    const ids = [...moves].map(generations.colosseumMove).sort((a, b) => a - b);
    lines.push([idOf.get(national), ids]);
  }
  lines.sort((a, b) => a[0] - b[0]);
  const body = lines.map(([id, ids]) => `    ${id}: '${ids.map(move => move.toString(36).padStart(2, '0')).join('')}',`).join('\n');
  const out = path.join(__dirname, '..', '..', 'src', 'fairy-learnsets.js');
  fs.writeFileSync(out, `'use strict';

// Made by scripts/generation-data/fairy-learnsets.js from generations/fairy.json (Pokémon Showdown's data, @pkmn/dex,
// MIT): change that, and make this again. The Fairy type setting's new moves each Pokémon could know in generation 6,
// with what its earlier forms could, by the game's species numbers: each move two base-36 digits.
(function (root) {
  const LEARNSETS = {
${body}
  };
  const sets = new Map();
  function movesOf(species) {
    if (!sets.has(species)) {
      const packed = LEARNSETS[species] || '', moves = new Set();
      for (let i = 0; i < packed.length; i += 2) moves.add(parseInt(packed.slice(i, i + 2), 36));
      sets.set(species, moves);
    }
    return sets.get(species);
  }
  // Whether the species could know the Fairy-type move in generation 6.
  function learns(species, move) {
    return Number.isInteger(move) && movesOf(species).has(move);
  }
  const api = { learns, has: species => Object.prototype.hasOwnProperty.call(LEARNSETS, species) };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.coloFairyLearnsets = api;
})(typeof self !== 'undefined' ? self : this);
`);
  console.log(`${out}: ${lines.length} Pokémon`);
}

main();
