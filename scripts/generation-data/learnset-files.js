'use strict';

// Makes src/gen3-learnsets.js and src/gen4-learnsets.js: the moves each Pokémon could know in the third generation, and
// in the fourth, which the competitive online formats check a party against (src/formats.js, "Only legal Pokémon"). It
// is what the team builder offers (src/battle-data.js):
//   - the third: the disc's own moves, then generations/gen3-learnsets.json (Pokémon Showdown's, made by learnsets.js
//     here: level-up, TM and HM, move tutor, egg and event moves of Ruby, Sapphire, Emerald, FireRed, LeafGreen,
//     Colosseum and XD, and what Smeargle can Sketch), with what each earlier form learned;
//   - the fourth (a party of that generation, which plays under Pokémon Platinum's rules): generations/gen4-learnsets.json
//     (Diamond, Pearl, Platinum, HeartGold and SoulSilver), the third's for a Pokémon brought over from those games, and
//     what each earlier form learned in either.
// So a move the builder marks as learnable is one a room takes, and the other way round. Make learnsets.js's first.
//
// Levels aren't kept: a room sets every Pokémon to its level, as Showdown's level 50 formats do, so a move learned at
// a higher level is still the Pokémon's own. Species and moves are the game's numbers (the Hoenn Pokémon at 277 to 411,
// the fourth generation's 26 past their National Pokédex numbers and its moves 3 past theirs: src/generations.js),
// which the disc gives; the battle code, the main process, the Online page and the room server all read these files,
// so each needs nothing but itself.
//
// usage: node learnset-files.js PATH-TO-DISC.iso
const fs = require('node:fs');
const path = require('node:path');
const { readBattleData } = require('../../src/battle-data');

// Each generation's last move by the game's number: Psycho Boost (the game's Shadow moves come after), and Shadow Force.
const FILES = {
  3: { lastMove: 354, least: 386, global: 'coloGen3Learnsets', words: 'third' },
  4: { lastMove: 470, least: 493, global: 'coloGen4Learnsets', words: 'fourth' }
};

function file(generation, species) {
  const { lastMove, least, global, words } = FILES[generation];
  const lines = [];
  for (const [id, entry] of Object.entries(species).map(([id, entry]) => [Number(id), entry]).sort((a, b) => a[0] - b[0])) {
    if (!entry.learnset.length) continue;
    const learned = [...new Set(entry.learnset.map(([move]) => move).filter(move => move >= 1 && move <= lastMove))].sort((a, b) => a - b);
    lines.push(`    ${id}: '${learned.map(move => move.toString(36).padStart(2, '0')).join('')}',`);
  }
  if (lines.length < least) throw new Error(`The disc gave ${lines.length} Pokémon with moves in generation ${generation}: it should be at least ${least}.`);
  const from = generation === 3 ? 'the disc\'s\n// moves and generations/gen3-learnsets.json' : 'generations/gen4.json,\n// gen4-learnsets.json and gen3-learnsets.json';
  return `'use strict';

// Made by scripts/generation-data/learnset-files.js from what the team builder offers (src/battle-data.js: ${from}, Pokémon Showdown's data, @pkmn/dex, MIT): change those, and make this
// again. The moves each Pokémon could know in the ${words} generation, by the game's species numbers: each move two
// base-36 digits.
(function (root) {
  const LEARNSETS = {
${lines.join('\n')}
  };
  const LAST_MOVE = ${lastMove};
  const sets = new Map();
  function movesOf(species) {
    if (!sets.has(species)) {
      const packed = LEARNSETS[species] || '', moves = new Set();
      for (let i = 0; i < packed.length; i += 2) moves.add(parseInt(packed.slice(i, i + 2), 36));
      sets.set(species, moves);
    }
    return sets.get(species);
  }
  // Whether the species could know the move in the ${words} generation.
  function learns(species, move) {
    return Number.isInteger(move) && move >= 1 && move <= LAST_MOVE && movesOf(species).has(move);
  }
  const api = { learns, has: species => Object.prototype.hasOwnProperty.call(LEARNSETS, species) };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.${global} = api;
})(typeof self !== 'undefined' ? self : this);
`;
}

function main() {
  const [rom] = process.argv.slice(2);
  if (!rom) throw new Error('usage: node learnset-files.js PATH-TO-DISC.iso');
  const data = readBattleData(rom);
  for (const [generation, species] of [[3, data.species], [4, data.generations[4].species]]) {
    const out = path.join(__dirname, '..', '..', 'src', `gen${generation}-learnsets.js`);
    fs.writeFileSync(out, file(generation, species));
    console.log(`${out}: ${(fs.statSync(out).size / 1024).toFixed(0)} KB`);
  }
}

main();
