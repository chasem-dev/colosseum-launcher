'use strict';

// Makes src/gen3-learnsets.js: the moves each Pokémon could know in the third generation, which the competitive
// online formats check a party against (src/formats.js, "Only legal Pokémon"). It is what the team builder offers
// (src/battle-data.js): the disc's own moves, then generations/gen3-learnsets.json (Pokémon Showdown's, made by
// learnsets.js here: level-up, TM and HM, move tutor, egg and event moves of Ruby, Sapphire, Emerald, FireRed,
// LeafGreen, Colosseum and XD, and what Smeargle can Sketch), with what each earlier form learned. So a move the
// builder marks as learnable is one a room takes, and the other way round. Make learnsets.js's first.
//
// Levels aren't kept: a room sets every Pokémon to its level, as Showdown's level 50 formats do, so a move learned at
// a higher level is still the Pokémon's own. Species are the game's numbers (the Hoenn Pokémon at 277 to 411), which
// the disc gives; the battle code, the main process, the Online page and the room server all read this file, so it
// needs nothing but itself.
//
// usage: node gen3-learnsets.js PATH-TO-DISC.iso
const fs = require('node:fs');
const path = require('node:path');
const { readBattleData } = require('../../src/battle-data');

const LAST_MOVE = 354;   // Psycho Boost; the game's Shadow moves come after
const OUT = path.join(__dirname, '..', '..', 'src', 'gen3-learnsets.js');

function main() {
  const [rom] = process.argv.slice(2);
  if (!rom) throw new Error('usage: node gen3-learnsets.js PATH-TO-DISC.iso');
  const { species, moves } = readBattleData(rom);
  const names = new Map(moves.map(move => [move.id, move.name]));
  const lines = [];
  for (const [id, entry] of Object.entries(species).map(([id, entry]) => [Number(id), entry]).sort((a, b) => a[0] - b[0])) {
    if (!entry.learnset.length) continue;
    const learned = [...new Set(entry.learnset.map(([move]) => move).filter(move => move >= 1 && move <= LAST_MOVE))].sort((a, b) => a - b);
    lines.push(`    ${id}: '${learned.map(move => move.toString(36).padStart(2, '0')).join('')}',`);
  }
  if (lines.length < 386 || !names.size) throw new Error(`The disc gave ${lines.length} Pokémon with moves: it should be at least 386.`);
  const source = `'use strict';

// Made by scripts/generation-data/gen3-learnsets.js from what the team builder offers (src/battle-data.js: the disc's
// moves and generations/gen3-learnsets.json, Pokémon Showdown's data, @pkmn/dex, MIT): change those, and make this
// again. The moves each Pokémon could know in the third generation, by the game's species numbers: each move two
// base-36 digits.
(function (root) {
  const LEARNSETS = {
${lines.join('\n')}
  };
  const LAST_MOVE = ${LAST_MOVE};
  const sets = new Map();
  function movesOf(species) {
    if (!sets.has(species)) {
      const packed = LEARNSETS[species] || '', moves = new Set();
      for (let i = 0; i < packed.length; i += 2) moves.add(parseInt(packed.slice(i, i + 2), 36));
      sets.set(species, moves);
    }
    return sets.get(species);
  }
  // Whether the species could know the move in the third generation.
  function learns(species, move) {
    return Number.isInteger(move) && move >= 1 && move <= LAST_MOVE && movesOf(species).has(move);
  }
  const api = { learns, has: species => Object.prototype.hasOwnProperty.call(LEARNSETS, species) };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.coloGen3Learnsets = api;
})(typeof self !== 'undefined' ? self : this);
`;
  fs.writeFileSync(OUT, source);
  console.log(`${path.relative(process.cwd(), OUT)}: ${lines.length} Pokémon`);
}

try { main(); } catch (error) { console.error(error.message); process.exit(1); }
