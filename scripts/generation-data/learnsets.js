'use strict';

// Makes src/generations/gen3-learnsets.json: what each Pokémon of the first three generations can learn in the third,
// as Pokémon Showdown has it (@pkmn/dex, MIT), for the team builder (src/battle-data.js). That is Ruby, Sapphire,
// Emerald, FireRed, LeafGreen, Colosseum and XD together: their level-up moves, TMs and HMs, move tutors (XD's too),
// egg moves and event moves. Each species' own only; the builder adds what an earlier form learned. Moves from
// generations 1 and 2 are left out, as no Pokémon could be moved from those games to these.
//
// usage: node learnsets.js
const fs = require('node:fs');
const path = require('node:path');
const { Dex } = require('@pkmn/dex');

const LAST_SPECIES = 386, LAST_MOVE = 354;
const KINDS = { L: 'levelUp', M: 'tm', T: 'tutor', E: 'egg', S: 'event' };

async function learnsetOf(dex, species) {
  const levels = new Map(), lists = { tm: new Set(), tutor: new Set(), egg: new Set(), event: new Set() };
  const data = await dex.learnsets.get(species.id);
  for (const [id, sources] of Object.entries(data?.learnset || {})) {
    const move = dex.moves.get(id);
    if (!move.exists || move.num < 1 || move.num > LAST_MOVE) continue;
    for (const source of sources) {
      const kind = KINDS[source[1]];
      if (source[0] !== '3' || !kind) continue;
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

async function main() {
  const dex = Dex.forGen(3), species = {};
  for (const entry of dex.species.all()) {
    if (entry.isNonstandard || entry.num < 1 || entry.num > LAST_SPECIES || entry.forme) continue;
    species[entry.num] = await learnsetOf(dex, entry);
  }
  for (let n = 1; n <= LAST_SPECIES; n++) if (!species[n]) throw new Error(`Showdown has no Pokémon #${n}`);
  // Smeargle learns any move by Sketch, but those Sketch can't copy
  const sketch = dex.moves.all().filter(move => !move.isNonstandard && move.num >= 1 && move.num <= LAST_MOVE && !move.flags.nosketch && !/^Hidden Power ./.test(move.name));
  species[dex.species.get('Smeargle').num].sketch = sketch.map(move => move.num).sort((a, b) => a - b);

  const out = path.join(__dirname, '..', '..', 'src', 'generations', 'gen3-learnsets.json');
  const data = { source: `Pokémon Showdown's data, generation 3 (@pkmn/dex ${require('@pkmn/dex/package.json').version}, MIT)`, species };
  fs.writeFileSync(out, `${JSON.stringify(data)}\n`);
  console.log(`${out}: ${Object.keys(species).length} species, ${(fs.statSync(out).size / 1024).toFixed(0)} KB`);
}

main().catch(error => { console.error(error); process.exit(1); });
