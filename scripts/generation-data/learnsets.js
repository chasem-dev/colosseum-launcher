'use strict';

// Makes src/generations/gen3-learnsets.json and gen4-learnsets.json: what each Pokémon can learn in the third
// generation and in the fourth, as Pokémon Showdown has it (@pkmn/dex, MIT), for the team builder (src/battle-data.js).
// The third is Ruby, Sapphire, Emerald, FireRed, LeafGreen, Colosseum and XD together, the fourth Diamond, Pearl,
// Platinum, HeartGold and SoulSilver: their level-up moves, TMs and HMs, move tutors (XD's too), egg moves and event
// moves. Each species' own only, and that generation's alone; the builder adds what an earlier form learned, and for
// the fourth what a Pokémon brought over from the third (by Pal Park) knew. Moves from generations 1 and 2 are left
// out, as no Pokémon could be moved from those games to the third.
//
// usage: node learnsets.js (both)
const fs = require('node:fs');
const path = require('node:path');
const { Dex } = require('@pkmn/dex');

// Each generation's last Pokémon and move by number.
const LAST = { 3: { species: 386, move: 354 }, 4: { species: 493, move: 467 } };
const KINDS = { L: 'levelUp', M: 'tm', T: 'tutor', E: 'egg', S: 'event' };

async function learnsetOf(dex, species, generation) {
  const levels = new Map(), lists = { tm: new Set(), tutor: new Set(), egg: new Set(), event: new Set() };
  const data = await dex.learnsets.get(species.id);
  for (const [id, sources] of Object.entries(data?.learnset || {})) {
    const move = dex.moves.get(id);
    if (!move.exists || move.num < 1 || move.num > LAST[generation].move) continue;
    for (const source of sources) {
      const kind = KINDS[source[1]];
      if (source[0] !== String(generation) || !kind) continue;
      // a move learned at more than one level, as the games differ: the earliest
      if (kind === 'levelUp') levels.set(move.num, Math.min(levels.get(move.num) ?? 100, Number(source.slice(2)) || 1));
      else lists[kind].add(move.num);
    }
  }
  const sorted = set => [...set].sort((a, b) => a - b);
  const record = { levelUp: [...levels].map(([move, level]) => [level, move]).sort((a, b) => a[0] - b[0] || a[1] - b[1]) };
  for (const [kind, set] of Object.entries(lists)) if (set.size) record[kind] = sorted(set);
  return record;
}

async function make(generation) {
  const dex = Dex.forGen(generation), species = {}, last = LAST[generation];
  for (const entry of dex.species.all()) {
    if (entry.isNonstandard || entry.num < 1 || entry.num > last.species || entry.forme) continue;
    species[entry.num] = await learnsetOf(dex, entry, generation);
  }
  for (let n = 1; n <= last.species; n++) if (!species[n]) throw new Error(`Showdown has no Pokémon #${n}`);
  // Smeargle learns any move by Sketch, but those Sketch can't copy
  const sketch = dex.moves.all().filter(move => !move.isNonstandard && move.num >= 1 && move.num <= last.move && !move.flags.nosketch && !/^Hidden Power ./.test(move.name));
  species[dex.species.get('Smeargle').num].sketch = sketch.map(move => move.num).sort((a, b) => a - b);

  const out = path.join(__dirname, '..', '..', 'src', 'generations', `gen${generation}-learnsets.json`);
  const data = { source: `Pokémon Showdown's data, generation ${generation} (@pkmn/dex ${require('@pkmn/dex/package.json').version}, MIT)`, species };
  fs.writeFileSync(out, `${JSON.stringify(data)}\n`);
  console.log(`${out}: ${Object.keys(species).length} species, ${(fs.statSync(out).size / 1024).toFixed(0)} KB`);
}

async function main() {
  for (const generation of Object.keys(LAST).map(Number)) await make(generation);
}

main().catch(error => { console.error(error); process.exit(1); });
