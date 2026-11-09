'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FILE, extraBoxPokemon, stampedHash, fnv32, fnv64 } = require('../src/pc-boxes');
const saves = require('../src/saves');

const STAMP = 8 + 0x1df60, BOX_SIZE = 0x24a4, EXTRA_SIZE = 7 * BOX_SIZE, ENTRY_SIZE = 0x20 + EXTRA_SIZE;

// Boxes 4 to 10 with a Pokémon of species `species` in each place listed, as [box, slot].
function boxes(places, species = 197) {
  const data = Buffer.alloc(EXTRA_SIZE);
  for (const [box, slot] of places) data.writeUInt16BE(species, box * BOX_SIZE + 0x14 + slot * 0x138);
  return data;
}

// The save's stamp, as host/pcboxes.c's make_stamp writes it.
function stamped(hash) {
  const plain = Buffer.alloc(0x1e000);
  plain.writeUInt32BE(0x43504258, STAMP);
  plain.writeUInt32BE(1 << 16 | 7, STAMP + 4);
  plain.writeUInt32BE(5, STAMP + 8);
  plain.writeBigUInt64BE(hash, STAMP + 12);
  plain.writeUInt32BE(fnv32(plain.subarray(STAMP, STAMP + 28)), STAMP + 28);
  return plain;
}

// An entry of the .boxes file, as host/pcboxes.c's write_entry writes it.
function entry(data, generation = 1) {
  const head = Buffer.alloc(0x20);
  head.writeUInt32BE(0x43504245, 0);
  head.writeUInt32BE(1, 4);
  head.writeUInt32BE(generation, 8);
  head.writeUInt32BE(EXTRA_SIZE, 12);
  head.writeBigUInt64BE(fnv64(data), 16);
  head.writeUInt32BE(fnv32(head.subarray(0, 28)), 28);
  return Buffer.concat([head, data]);
}

function card(...entries) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-boxes-'));
  fs.writeFileSync(path.join(dir, FILE), Buffer.concat(entries));
  return dir;
}

test('FNV-1a matches its published values', () => {
  assert.equal(fnv32(Buffer.from('a')), 0xe40c292c);
  assert.equal(fnv64(Buffer.from('a')), 0xaf63dc4c8601ec8cn);
});

test('counts the Pokémon in boxes 4 to 10 of the save the game would load', () => {
  const older = boxes([[0, 0]]), mine = boxes([[0, 0], [3, 29], [6, 7]]);
  const dir = card(entry(older, 1), entry(mine, 2));
  try {
    assert.equal(extraBoxPokemon(dir, stamped(fnv64(mine))), 3);
    assert.equal(extraBoxPokemon(dir, stamped(fnv64(older))), 1);
  } finally { fs.rmSync(dir, { recursive: true }); }
});

test('a save with no stamp, or whose boxes are gone or damaged, has none', () => {
  const mine = boxes([[1, 1]]);
  const damaged = entry(mine);
  damaged[0x20 + 5] ^= 1;
  const dir = card(damaged);
  try {
    assert.equal(stampedHash(Buffer.alloc(0x1e000)), null);
    assert.equal(extraBoxPokemon(dir, Buffer.alloc(0x1e000)), 0);
    assert.equal(extraBoxPokemon(dir, stamped(fnv64(mine))), 0);
    const bad = stamped(fnv64(mine));
    bad[STAMP + 12] ^= 1;
    assert.equal(stampedHash(bad), null);
    assert.equal(extraBoxPokemon(path.join(dir, 'missing'), stamped(fnv64(mine))), 0);
  } finally { fs.rmSync(dir, { recursive: true }); }
});

test('backups keep the boxes file with the save', () => {
  const dir = card(entry(boxes([])));
  const backups = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-boxes-backups-'));
  try {
    fs.writeFileSync(path.join(dir, 'pokemon_colosseum.dat'), 'save');
    const backup = saves.backupSaves(dir, backups);
    assert.deepEqual(fs.readdirSync(path.join(backup.directory, 'files')).sort(), ['pokemon_colosseum.boxes', 'pokemon_colosseum.dat']);
    assert.equal(fs.statSync(path.join(backup.directory, 'files', FILE)).size, ENTRY_SIZE);
  } finally {
    fs.rmSync(dir, { recursive: true });
    fs.rmSync(backups, { recursive: true });
  }
});
