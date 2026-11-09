'use strict';

const fs = require('node:fs');
const path = require('node:path');

// The port's PC has 10 boxes (host/pcboxes.c). Boxes 1 to 3 are in the save as the original game keeps them; boxes 4 to
// 10 are in pokemon_colosseum.boxes beside it, named from the save by a stamp in the part of the body no section owns:
// "CPBX", version 1 and 7 boxes, a counter, the boxes' 64-bit FNV-1a hash, and an FNV-1a check of the first 28 bytes.
// The file keeps the boxes of the last few saves, each an entry of a 0x20-byte header ("CPBE", version, generation,
// size, the hash, its own check) and the 7 boxes as game memory holds them.
const FILE = 'pokemon_colosseum.boxes';
const STAMP = 8 + 0x1df60;   // the save body starts 8 bytes into a copy of the save
const STAMP_MAGIC = 0x43504258;
const ENTRY_MAGIC = 0x43504245;
const VERSION = 1;
const EXTRA = 7;
const BOX_SIZE = 0x24a4;
const BOX_HEADER = 0x14;
const POKEMON = 0x138;
const PER_BOX = 30;
const EXTRA_SIZE = EXTRA * BOX_SIZE;
const ENTRY_HEAD = 0x20;
const ENTRY_SIZE = ENTRY_HEAD + EXTRA_SIZE;

function fnv32(bytes) {
  let h = 0x811c9dc5;
  for (const byte of bytes) h = Math.imul(h ^ byte, 0x01000193) >>> 0;
  return h;
}

function fnv64(bytes) {
  let h = 0xcbf29ce484222325n;
  for (const byte of bytes) h = BigInt.asUintN(64, (h ^ BigInt(byte)) * 0x100000001b3n);
  return h;
}

// The hash a save names its boxes 4 to 10 by, or null when it has none (the original game's, or one made before them).
function stampedHash(plain) {
  if (plain.length < STAMP + 0x20 || plain.readUInt32BE(STAMP) !== STAMP_MAGIC ||
    plain.readUInt32BE(STAMP + 4) !== (VERSION << 16 | EXTRA) || plain.readUInt32BE(STAMP + 28) !== fnv32(plain.subarray(STAMP, STAMP + 28)))
    return null;
  return plain.readBigUInt64BE(STAMP + 12);
}

function boxesFor(saveDir, hash) {
  let file;
  try { file = fs.readFileSync(path.join(saveDir, FILE)); } catch (_) { return null; }
  for (let at = 0; at + ENTRY_SIZE <= file.length; at += ENTRY_SIZE) {
    const head = file.subarray(at, at + ENTRY_HEAD);
    if (head.readUInt32BE(0) !== ENTRY_MAGIC || head.readUInt32BE(4) !== VERSION || head.readUInt32BE(12) !== EXTRA_SIZE ||
      head.readUInt32BE(28) !== fnv32(head.subarray(0, 28)) || head.readBigUInt64BE(16) !== hash) continue;
    const data = file.subarray(at + ENTRY_HEAD, at + ENTRY_SIZE);
    if (fnv64(data) === hash) return data;
  }
  return null;
}

// How many Pokémon a save (the plain copy the game would load) holds in boxes 4 to 10.
function extraBoxPokemon(saveDir, plain) {
  const hash = stampedHash(plain);
  const data = hash === null ? null : boxesFor(saveDir, hash);
  if (!data) return 0;
  let count = 0;
  for (let box = 0; box < EXTRA; box++)
    for (let slot = 0; slot < PER_BOX; slot++)
      if (data.readUInt16BE(box * BOX_SIZE + BOX_HEADER + slot * POKEMON)) count++;
  return count;
}

module.exports = { FILE, extraBoxPokemon, stampedHash, fnv32, fnv64 };
