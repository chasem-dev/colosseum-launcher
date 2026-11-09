'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const saves = require('./saves');
const pcBoxes = require('./pc-boxes');

const HEADER = 0x40;
const BLOCK = 0x2000;
const BLOCKS = 48;
const SIZE = BLOCKS * BLOCK;
const CARD_BLOCKS = 59; // host/card.c
const NAME = 'pokemon_colosseum';
const GAME = 'GC6E01';
const TITLE = 'Pokémon Colosseum';
const EXPORT_NAME = `01-${GAME.slice(0, 4)}-${NAME}.gci`; // the name Dolphin gives it
const RESTORE = 'Restore a backup from the Saves tab, then try again.';
const PERMISSIONS = 0x1c; // public, as every card file starts, then no copy and no move, which the game adds
const FIRST_BLOCK = 5; // the first block after a card's system blocks: where the file would be on an empty card

// The save file (memcard.c in the decomp): banner and icon, then three slots the game writes in turn. Each slot opens
// with a plain header, and the rest is scrambled against the SHA-1 of the whole that it keeps at HASH.
const SLOT_START = 0x6000;
const SLOT_SIZE = 0x1e000;
const SLOTS = 3;
const SCRAMBLED_START = 0x18;
const HASHED = 0x1dfd8;
const HASH = 0x1dfec;

// Where an unscrambled slot keeps the trainer and the party.
const TRAINER = 0x78;
const PARTY = 0xa8;
const PARTY_SIZE = 6;
const POKEMON = 0x138;
const NICKNAME = 0x2e;
const NAME_LENGTH = 10;

// A card file that is not a Colosseum save with progress; reason is the short form.
function otherFile(message, reason, code = 'OTHER_FILE') {
  return Object.assign(new Error(message), { code, reason });
}

function sha1(bytes) { return crypto.createHash('sha1').update(bytes).digest(); }

// The game's savedataDecryptCheck: each 20 bytes are masked with the SHA-1 of the 20 before them as they were stored,
// the first with the inverted hash. The header's checksum word is zero when the hash is taken.
function unscramble(slot) {
  const plain = Buffer.from(slot);
  plain.writeUInt32BE(0, 0x0c);
  const hash = slot.subarray(HASH, HASH + 20);
  let key = Buffer.from(hash.map(byte => byte ^ 0xff));
  for (let offset = SCRAMBLED_START; offset < HASHED; offset += 20) {
    const next = sha1(slot.subarray(offset, offset + 20));
    for (let i = 0; i < 20; i++) plain[offset + i] ^= key[i];
    key = next;
  }
  return sha1(plain.subarray(0, HASHED)).equals(hash) ? plain : null;
}

// The game refuses the whole file if any slot's header is bad, even a slot it wouldn't load.
function headerValid(slot) {
  let sum = 0;
  for (let word = 0; word < 8; word++) sum = (sum + slot.readUInt32BE(word * 4)) >>> 0;
  return sum === 0 && slot[0] === 1 && slot[1] === 1;
}

function text(bytes, offset) {
  const end = offset + NAME_LENGTH * 2;
  let stop = offset;
  while (stop < end && bytes.readUInt16BE(stop)) stop += 2;
  return Buffer.from(bytes.subarray(offset, stop)).swap16().toString('utf16le');
}

function summary(plain, count) {
  const party = [];
  for (let i = 0; i < PARTY_SIZE; i++) {
    const pokemon = PARTY + i * POKEMON;
    if (plain.readUInt16BE(pokemon)) party.push(text(plain, pokemon + NICKNAME));
  }
  return { trainer: text(plain, TRAINER), party, saveCount: count };
}

// The slot the game will load: the newest whose hash holds, as it falls back from a damaged one. fix is what to do
// about a damaged save, which depends on where it came from.
function newestPlain(data, fix = 'Export the save again from Dolphin.') {
  const slots = [];
  for (let i = 0; i < SLOTS; i++) {
    const start = SLOT_START + i * SLOT_SIZE;
    const slot = data.subarray(start, start + SLOT_SIZE);
    if (!headerValid(slot))
      throw new Error(`This save is damaged: the game would not open it. ${fix}`);
    slots.push({ slot, count: slot.readInt32BE(4) });
  }
  const written = slots.filter(item => item.count > 0).sort((a, b) => b.count - a.count);
  if (!written.length)
    throw otherFile(`This ${TITLE} save has no saved progress.`, `${TITLE} save with no saved progress`, 'NO_PROGRESS');
  for (const [damaged, { slot, count }] of written.entries()) {
    const plain = unscramble(slot);
    if (plain) return { plain, count, damaged };
  }
  throw new Error(`This save is damaged: none of its three copies can be read. ${fix}`);
}

function newestSave(data, fix) {
  const { plain, count, damaged } = newestPlain(data, fix);
  return { ...summary(plain, count), damaged };
}

// GCI is a big-endian GameCube directory entry followed by the unchanged card file data. The port keeps that data as
// it is, and its .stat is the game's CARDStat, big-endian too (host/card.c). Saves move between cards: the card ID in
// a save is only compared with the one loaded from that same save, and the game writes its own at the next save.
function convertGci(bytes) {
  const sizeError = () => new Error(`Choose a ${TITLE} .gci export (64-byte header and ${BLOCKS} save blocks).`);
  if (!Buffer.isBuffer(bytes) || bytes.length < HEADER) throw sizeError();
  const game = bytes.toString('latin1', 0, 6);
  const filename = bytes.subarray(8, 40);
  const end = filename.indexOf(0);
  const name = filename.subarray(0, end < 0 ? 32 : end).toString('latin1');
  const blocks = bytes.readUInt16BE(0x38);
  // A whole export of something else (its size matches its block count): say what it is, not only that it is the wrong size.
  if (bytes.length === HEADER + SIZE || bytes.length === HEADER + blocks * BLOCK) {
    if (/^GC6.01$/.test(game) && game !== GAME)
      throw otherFile(`This save is from another region's ${TITLE}. The game here is the North American version (GC6E01), so export a save from that version.`, `another region's ${TITLE} save`);
    if (game !== GAME || name !== NAME)
      throw otherFile(`This is not a ${TITLE} save. Choose the 01-GC6E-pokemon_colosseum.gci save exported from Dolphin.`, `not a ${TITLE} save`);
  }
  if (bytes.length !== HEADER + SIZE) throw sizeError();
  if (blocks !== BLOCKS)
    throw new Error('The GCI block count does not match its save data. Export the save again from Dolphin.');

  const data = Buffer.from(bytes.subarray(HEADER));
  const save = newestSave(data);
  const stat = Buffer.alloc(0x6c);
  stat.write(NAME, 0, 'latin1');
  stat.writeUInt32BE(data.length, 0x20);
  stat.writeUInt32BE(bytes.readUInt32BE(0x28), 0x24); // last modified
  bytes.copy(stat, 0x28, 0, 6);
  stat[0x2e] = bytes[7]; // banner format
  bytes.copy(stat, 0x30, 0x2c, 0x34); // icon address, format and speed
  stat.writeUInt32BE(bytes.readUInt32BE(0x3c), 0x38); // comment address
  return { name: NAME, title: TITLE, data, stat, ...save };
}

function readGci(file) {
  if (typeof file !== 'string' || path.extname(file).toLowerCase() !== '.gci')
    throw new Error('Choose a Dolphin .gci save file.');
  const fd = fs.openSync(file, 'r');
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error('Choose a Dolphin .gci save file.');
    const bytes = Buffer.alloc(HEADER + SIZE + 1);
    let length = 0, received;
    while (length < bytes.length && (received = fs.readSync(fd, bytes, length, bytes.length - length, null)))
      length += received;
    return convertGci(bytes.subarray(0, length));
  } finally { fs.closeSync(fd); }
}

// Reads the one save among files, a dropped folder standing for the .gci files in it. Among several, other games'
// saves and empty ones are skipped (a Dolphin card folder holds every game's); a broken file, or a single file that
// cannot be imported, stops the import.
function readGciFiles(files) {
  files = files.flatMap(file => typeof file === 'string' && fs.statSync(file, { throwIfNoEntry: false })?.isDirectory()
    ? fs.readdirSync(file).filter(name => /\.gci$/i.test(name)).sort().map(name => path.join(file, name)) : [file]);
  if (!files.length) throw new Error('That folder has no Dolphin .gci save files.');
  const found = [], skipped = [];
  for (const file of files) {
    try { found.push({ file, converted: readGci(file) }); }
    catch (error) {
      if (files.length === 1) throw error;
      if (!['NO_PROGRESS', 'OTHER_FILE'].includes(error.code))
        throw new Error(`${path.basename(String(file))}: ${error.message}`, { cause: error });
      skipped.push({ file: path.basename(file), reason: error.reason });
    }
  }
  if (!found.length) throw new Error(`None of these files has ${TITLE} progress to import.`);
  if (found.length > 1) throw new Error(`Choose one Dolphin save: these include ${found.length} ${TITLE} saves.`);
  return { ...found[0], skipped };
}

function importGci(converted, saveDir, backups = saves.backupRoot()) {
  // Complete all validation and a verified backup before changing the card.
  const previous = saves.backupSaves(saveDir, backups, 'before-dolphin-import');
  const data = `${converted.name}.dat`;
  const blocks = saves.cardFiles(saveDir).filter(name => name.endsWith('.dat') && name !== data)
    .reduce((total, name) => total + Math.ceil(fs.statSync(path.join(saveDir, name)).size / BLOCK), BLOCKS);
  if (blocks > CARD_BLOCKS) throw new Error(`The memory card needs ${BLOCKS} free blocks for this save.`);
  // The game finds a save by its .dat, so that goes last. Temporary names aren't card files, so one left behind by a
  // crash is never backed up or read as a save.
  const files = new Map([[`${converted.name}.stat`, converted.stat], [data, converted.data]]);
  const temporary = name => path.join(saveDir, `.${name}.import-${process.pid}`);
  fs.mkdirSync(saveDir, { recursive: true });
  const originals = new Map();
  const replaced = [];
  try {
    for (const [name, bytes] of files) {
      const target = path.join(saveDir, name);
      originals.set(name, fs.existsSync(target) ? fs.readFileSync(target) : null);
      fs.writeFileSync(temporary(name), bytes, { mode: 0o600 });
    }
    for (const name of files.keys()) {
      fs.renameSync(temporary(name), path.join(saveDir, name));
      replaced.push(name);
    }
  } catch (error) {
    try {
      for (const name of replaced.reverse()) {
        const original = originals.get(name), target = path.join(saveDir, name);
        if (original === null) fs.rmSync(target);
        else fs.writeFileSync(target, original);
      }
    } catch (rollback) {
      throw new Error(`Import failed and could not restore every file: ${rollback.message}. Your backup is at ${previous.directory || backups}.`, { cause: error });
    }
    throw error;
  } finally {
    for (const name of files.keys()) fs.rmSync(temporary(name), { force: true });
  }
  return { name: converted.name, directory: saveDir, previous: previous.directory || null };
}

// The directory entry the console would hold for this save. The game sets the banner, icons and comment the same way
// for every save (memcard.c, states 15 and 23). The .stat isn't used: the port ignores the permissions the game asks
// for, and leaves the time at zero or at an import's, however long the save has been played since.
function gciHeader(modified) {
  const header = Buffer.alloc(HEADER);
  header.write(GAME, 0, 'latin1');
  header[6] = 0xff; // unused
  header[7] = 2; // banner format
  header.write(NAME, 8, 'latin1');
  // The console's clock has no time zone: seconds since 2000 began, as a wall clock read them.
  const local = modified.getTime() - modified.getTimezoneOffset() * 60000;
  header.writeUInt32BE(Math.max(0, Math.floor((local - Date.UTC(2000, 0, 1)) / 1000)), 0x28);
  header.writeUInt32BE(0x40, 0x2c); // icon address
  header.writeUInt16BE(0x5555, 0x30); // icon format
  header.writeUInt16BE(0xaaaa, 0x32); // icon speed
  header[0x34] = PERMISSIONS;
  header.writeUInt16BE(FIRST_BLOCK, 0x36);
  header.writeUInt16BE(BLOCKS, 0x38);
  header.writeUInt16BE(0xffff, 0x3a); // unused
  return header; // the comment address stays 0
}

// Reads the port's save as a .gci, the reverse of convertGci: the card data goes in unchanged, as game memory stays
// big-endian on every system the port runs on.
function readCardSave(saveDir) {
  const file = path.join(saveDir, `${NAME}.dat`);
  const found = fs.statSync(file, { throwIfNoEntry: false });
  if (!found) throw new Error(`There is no ${TITLE} save to export yet.`);
  const data = fs.readFileSync(file);
  if (data.length !== SIZE) throw new Error(`This save is damaged: it isn't the size the game writes. ${RESTORE}`);
  const { plain, count, damaged } = newestPlain(data, RESTORE);
  // Boxes 4 to 10 aren't in the card file (pc-boxes.js): the original game has 3 boxes.
  return { gci: Buffer.concat([gciHeader(found.mtime), data]), title: TITLE, ...summary(plain, count), damaged,
    extraBoxPokemon: pcBoxes.extraBoxPokemon(saveDir, plain) };
}

// A dialog only asks before replacing the name it was given, so never replace a file under a name it wasn't given.
function writeGci(gci, chosen) {
  const named = /\.gci$/i.test(chosen);
  const file = named ? chosen : `${chosen}.gci`;
  if (!named && fs.existsSync(file)) throw new Error(`${path.basename(file)} already exists. Choose another name.`);
  // Written beside it and renamed, so a full disk can't cost the player a .gci they are replacing.
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.export-${process.pid}`);
  try {
    fs.writeFileSync(temporary, gci);
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
  return file;
}

module.exports = { EXPORT_NAME, convertGci, readGci, readGciFiles, importGci, newestPlain, readCardSave, writeGci };
