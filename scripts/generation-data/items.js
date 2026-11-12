'use strict';

// Makes src/generations/gen4-items.json: the held items the game has only under Pokémon Platinum's battle rules, for
// a Generation 4 party in the team builder (src/battle-data.js). They are the game's own, as its host/gen4_items.h has
// them (made by its tools/gen4/make_items.py from pret/pokeplatinum res/items): Diamond and Pearl's new items, by the
// numbers the game gives them past its own (FIRST_NEW_ITEM on), with their names and the descriptions the game shows;
// and the Enigma Berry, whose row Colosseum leaves blank and those rules fill. As the disc's own list does, it keeps
// only items with a held effect (not the fossils, Mulch, evolution stones or Honey).
//
// usage: node items.js GAME_DIR
//   GAME_DIR: a checkout of the game (https://git.softwareauralabs.com/chase/pokemon-colosseum)
const fs = require('node:fs');
const path = require('node:path');

function readHeader(file) {
  const text = fs.readFileSync(file, 'utf8');
  const first = Number(/FIRST_NEW_ITEM = (0x[0-9A-F]+)/.exec(text)?.[1]), count = Number(/NEW_ITEMS = (\d+)/.exec(text)?.[1]);
  if (!first || !count) throw new Error(`${file} doesn't say where its new items start.`);
  const texts = new Map();
  for (const [, id, value] of text.matchAll(/\{ (0x[0-9A-F]+), "((?:[^"\\]|\\.)*)" \}/g)) texts.set(Number(id), value);
  const items = [];
  for (const [, number, index, hold, name] of text.matchAll(/\{ (0x[0-9A-F]+), (-?\d+), (G4_\w+),[^}]*\},\s*\/\* (.*?) \*\//g)) {
    const id = Number(number), newIndex = Number(index);
    if (newIndex < 0 || hold === 'G4_NONE') continue;
    const doc = texts.get(0x500 + newIndex);
    if (!doc) throw new Error(`${name} has no description in ${file}.`);
    items.push({ id, name, doc: doc.replace(/\{00\}/g, ' ').replace(/’/g, '\'').replace(/\s+/g, ' ').trim(),
      ...(/ Berry$/.test(name) ? { berry: true } : {}) });
    if (id !== (newIndex < count ? first + newIndex : id)) throw new Error(`${name}: ${number} isn't new item ${newIndex}.`);
  }
  return items.sort((a, b) => a.id - b.id);
}

function main() {
  const game = process.argv[2];
  if (!game) throw new Error('usage: node items.js GAME_DIR');
  const items = readHeader(path.join(game, 'host', 'gen4_items.h'));
  const out = path.join(__dirname, '..', '..', 'src', 'generations', 'gen4-items.json');
  const data = { generation: 4, source: 'the game\'s host/gen4_items.h (pret\'s decompilation of Pokémon Platinum, res/items)', items };
  fs.writeFileSync(out, `${JSON.stringify(data, null, 2)}\n`);
  console.log(`${items.length} items: ${path.relative(process.cwd(), out)}`);
}

if (require.main === module) main();
module.exports = { readHeader };
