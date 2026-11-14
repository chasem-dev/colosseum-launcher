'use strict';

// Checks the file a player chooses as their Pokémon Battle Revolution disc before the launcher keeps it. Making the
// assets reads the whole disc with nodtool, minutes in; a wrong file only failed then, with the reason in the activity
// log. This reads the disc header out of each image format nodtool takes (ISO, WBFS, RVZ, WIA, GCZ, CISO) and says
// what is wrong in the player's words: another game, a GameCube disc, an archive, an incomplete copy.

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const games = require('./games');

const REGIONS = { RPBE01: 'North American', RPBP01: 'European', RPBJ01: 'Japanese' };
const NAME = 'Pokémon Battle Revolution';
const WII_MAGIC = 0x5d1c9ea3, GAMECUBE_MAGIC = 0xc2339f3d;
const CHOOSE = `Choose a file of your own ${NAME} disc (RVZ, ISO or WBFS).`;
const ARCHIVES = { zip: 'a ZIP archive', '7z': 'a 7-Zip archive', rar: 'a RAR archive' };

function readAt(fd, offset, length) {
  const out = Buffer.alloc(length);
  return out.subarray(0, fs.readSync(fd, out, 0, length, offset));
}

// The first 0x440 bytes of the disc inside an image, and what the image is: { format, header } (header null when it
// can't be read: an image cut short, or a compressed block that won't unpack).
function discHeader(fd, size) {
  const head = readAt(fd, 0, 0x60);
  const magic = head.toString('latin1', 0, 4);
  if (magic === 'PK\x03\x04') return { format: 'zip' };
  if (head.toString('latin1', 0, 6) === '7z\xbc\xaf\x27\x1c') return { format: '7z' };
  if (magic === 'Rar!') return { format: 'rar' };
  // RVZ and WIA: header 1 (0x48 bytes), then header 2, whose disc header copy starts 0x10 in
  if (magic === 'RVZ\x01' || magic === 'WIA\x01') return { format: magic === 'RVZ\x01' ? 'rvz' : 'wia', header: head.length >= 0x60 ? readAt(fd, 0x58, 0x80) : null };
  // WBFS: the first disc's info, which starts with its header, is one HD sector in
  if (magic === 'WBFS') {
    const shift = head[8];
    return { format: 'wbfs', header: shift >= 9 && shift <= 16 && head[0xc] ? readAt(fd, 1 << shift, 0x100) : null };
  }
  if (magic === 'CISO') {
    const blockSize = head.readUInt32LE(4);
    return { format: 'ciso', header: blockSize >= 0x20 && blockSize <= 0x200000 && head[8] === 1 ? readAt(fd, 0x8000, 0x440) : null };
  }
  if (head.length >= 4 && head.readUInt32LE(0) === 0xb10bc001) return { format: 'gcz', header: gczFirstBlock(fd, size) };
  return { format: 'iso', header: readAt(fd, 0, 0x440) };
}

// A GCZ's first block, unpacked (a pointer's top bit marks a block stored as it is)
function gczFirstBlock(fd, size) {
  try {
    const head = readAt(fd, 0, 0x20);
    const compressed = Number(head.readBigUInt64LE(8)), blockSize = head.readUInt32LE(0x18), blocks = head.readUInt32LE(0x1c);
    if (!blocks || blockSize < 0x440 || blockSize > 0x1000000 || 0x20 + blocks * 12 > size) return null;
    const pointers = readAt(fd, 0x20, Math.min(blocks, 2) * 8);
    const mask = (1n << 63n) - 1n, first = pointers.readBigUInt64LE(0);
    const start = Number(first & mask), end = blocks > 1 ? Number(pointers.readBigUInt64LE(8) & mask) : compressed;
    if (end <= start || end - start > blockSize + 0x100) return null;
    const data = readAt(fd, 0x20 + blocks * 12 + start, end - start);
    return first >> 63n ? data : zlib.inflateSync(data);
  } catch { return null; }
}

// How long a plain Wii ISO must be to hold its game partition: the partition table at 0x40000 points at each one, and
// each partition's header at its data's offset and size (all in 4-byte units). Null when the table can't be read.
function wiiIsoNeeded(fd) {
  const table = readAt(fd, 0x40000, 0x20);
  if (table.length < 0x20) return null;
  let needed = 0;
  for (let group = 0; group < 4; group++) {
    const count = table.readUInt32BE(group * 8), at = table.readUInt32BE(group * 8 + 4) * 4;
    if (!count) continue;
    if (count > 16) return null;
    const entries = readAt(fd, at, count * 8);
    if (entries.length < count * 8) return null;
    for (let i = 0; i < count; i++) {
      const offset = entries.readUInt32BE(i * 8) * 4, partition = readAt(fd, offset + 0x2b8, 8);
      if (partition.length < 8) return Infinity;
      needed = Math.max(needed, offset + partition.readUInt32BE(0) * 4 + partition.readUInt32BE(4) * 4);
    }
  }
  return needed || null;
}

function megabytes(bytes) { return `${Math.round(bytes / 1048576).toLocaleString('en-US')} MB`; }

// What the disc is, as the banner says it: { file, gameId, region, format } for a Battle Revolution disc; otherwise
// an Error whose message says what was chosen and what to do.
function validate(file) {
  if (!file || typeof file !== 'string') throw new Error(`No file was chosen. ${CHOOSE}`);
  const absolute = path.resolve(file);
  let fd;
  try { fd = fs.openSync(absolute, 'r'); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error(`That file can't be found. ${CHOOSE}`);
    if (error.code === 'EISDIR') throw new Error(`That's a folder. ${CHOOSE}`);
    throw new Error(`The launcher can't open that file (${error.code || error.message}). ${CHOOSE}`);
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error(`That's a folder. ${CHOOSE}`);
    const { format, header } = discHeader(fd, stat.size);
    if (ARCHIVES[format]) throw new Error(`That's ${ARCHIVES[format]}, not a disc file. Extract the disc file from it first, then choose that.`);
    const again = 'It may not have finished copying: copy it from your disc again and choose the new file.';
    if (!header || header.length < 0x20) {
      if (format === 'iso' && stat.size < 0x440) throw new Error(`That file is too small to be a disc (${stat.size.toLocaleString('en-US')} bytes). ${CHOOSE}`);
      throw new Error(`That ${format.toUpperCase()} file is incomplete or damaged. ${again}`);
    }
    const wii = header.readUInt32BE(0x18) === WII_MAGIC, gamecube = header.readUInt32BE(0x1c) === GAMECUBE_MAGIC;
    if (!wii && !gamecube) throw new Error(`That file isn't a Wii disc image. ${CHOOSE}`);
    const gameId = header.toString('latin1', 0, 6).replace(/[^\x20-\x7e]/g, '?');
    const nul = header.indexOf(0, 0x20);
    const title = header.toString('latin1', 0x20, Math.min(nul < 0 ? 0x80 : nul, 0x80)).trim();
    if (gamecube) {
      const known = games.identifyDisc(gameId);
      const what = known ? `${known.region ? `the ${known.region} release of ` : ''}${known.game.name}` : title ? `"${title}"` : 'a GameCube game';
      throw new Error(`That's ${what} (${gameId}), a GameCube disc. ${NAME} is a Wii disc. ${CHOOSE}`);
    }
    if (!REGIONS[gameId]) throw new Error(`That's ${title ? `"${title}"` : 'another Wii game'} (${gameId}), not ${NAME}. ${CHOOSE}`);
    // Shorter than its game partition: most likely a copy that stopped, but a trimmed image (or NKit's, marked at
    // 0x200) is short too and nodtool may read it, so it's kept with a warning rather than turned down
    let warning = '';
    if (format === 'iso') {
      const needed = wiiIsoNeeded(fd);
      if (needed && stat.size < needed)
        warning = header.toString('latin1', 0x200, 0x204) === 'NKIT'
          ? 'It\'s an NKit image, which may not read. If making the assets fails, convert it back to ISO or RVZ in Dolphin.'
          : `It may be incomplete: it's ${megabytes(stat.size)}, but the disc needs at least ${megabytes(needed)}. If making the assets fails, copy it from your disc again.`;
    }
    return { file: absolute, gameId, region: REGIONS[gameId], format, ...warning && { warning } };
  } finally { fs.closeSync(fd); }
}

// The banner's words for a disc that passed
function describe(disc) { return `The ${disc.region} release of ${NAME} (${disc.gameId}, ${disc.format.toUpperCase()}).${disc.warning ? ` ${disc.warning}` : ''}`; }

module.exports = { REGIONS, validate, describe };
