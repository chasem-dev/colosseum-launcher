'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EXPORT_NAME, convertGci, readGci, readGciFiles, importGci, readCardSave, writeGci } = require('../src/gci-save');
const saves = require('../src/saves');

const BLOCK = 0x2000, SLOT_START = 0x6000, SLOT_SIZE = 0x1e000, HASHED = 0x1dfd8, HASH = 0x1dfec;
const sha1 = bytes => crypto.createHash('sha1').update(bytes).digest();

// The game's fn_801CBE44, then the header sum: each 20 bytes are masked, and the next key is the SHA-1 of what was stored.
function scramble(slot) {
  const hash = sha1(slot.subarray(0, HASHED));
  let key = Buffer.from(hash.map(byte => ~byte & 0xff));
  for (let offset = 0x18; offset < HASHED; offset += 20) {
    for (let i = 0; i < 20; i++) slot[offset + i] ^= key[i];
    key = sha1(slot.subarray(offset, offset + 20));
  }
  hash.copy(slot, HASH);
  let sum = 0;
  for (let word = 0; word < 8; word++) sum = (sum + slot.readUInt32BE(word * 4)) >>> 0;
  slot.writeUInt32BE((0x100000000 - sum) >>> 0, 0x0c);
}

function utf16(bytes, offset, value) { Buffer.from(value, 'utf16le').swap16().copy(bytes, offset); }

function writeSlot(bytes, index, count, trainer = 'WES', party = ['ESPEON', 'UMBREON']) {
  const slot = bytes.subarray(0x40 + SLOT_START + index * SLOT_SIZE, 0x40 + SLOT_START + (index + 1) * SLOT_SIZE);
  slot.fill(0);
  slot[0] = 1; slot[1] = 1;
  slot.writeInt32BE(count, 4);
  slot.writeUInt32BE(0x0b030202, 8);
  utf16(slot, 0x78, trainer);
  party.forEach((name, i) => {
    slot.writeUInt16BE(i + 1, 0xa8 + i * 0x138);
    utf16(slot, 0xa8 + i * 0x138 + 0x2e, name);
  });
  scramble(slot);
}

function blankSlot(bytes, index) {
  const slot = bytes.subarray(0x40 + SLOT_START + index * SLOT_SIZE, 0x40 + SLOT_START + (index + 1) * SLOT_SIZE);
  slot.fill(0);
  slot[0] = 1; slot[1] = 1;
  slot.writeUInt32BE((0x100000000 - 0x01010000) >>> 0, 0x0c);
}

function fixture(counts = [122, 123, 124]) {
  const bytes = Buffer.alloc(0x40 + 48 * BLOCK);
  bytes.write('GC6E01');
  bytes[6] = 0xff; bytes[7] = 2;
  bytes.write('pokemon_colosseum', 8);
  bytes.writeUInt32BE(0x0936_49ee, 0x28);
  bytes.writeUInt32BE(0x40, 0x2c);
  bytes.writeUInt16BE(0x5555, 0x30);
  bytes.writeUInt16BE(0xaaaa, 0x32);
  bytes.writeUInt16BE(48, 0x38);
  counts.forEach((count, index) => (count ? writeSlot(bytes, index, count) : blankSlot(bytes, index)));
  return bytes;
}

function damage(bytes, index) { bytes[0x40 + SLOT_START + index * SLOT_SIZE + 0x1000] ^= 0xff; }

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gci-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('keeps the card data as it is and reads the newest save', () => {
  const bytes = fixture();
  const converted = convertGci(bytes);
  assert.equal(converted.name, 'pokemon_colosseum');
  assert.deepEqual(converted.data, bytes.subarray(0x40));
  assert.equal(converted.trainer, 'WES');
  assert.deepEqual(converted.party, ['ESPEON', 'UMBREON']);
  assert.equal(converted.saveCount, 124);
  assert.equal(converted.damaged, 0);
});

test('picks the highest save count, wherever the game last wrote', () => {
  const bytes = fixture([7, 9, 8]);
  writeSlot(bytes, 1, 9, 'RUI', ['PLUSLE']);
  const converted = convertGci(bytes);
  assert.equal(converted.saveCount, 9);
  assert.equal(converted.trainer, 'RUI');
});

test('builds the same .stat the port writes for its own save', () => {
  // A pokemon_colosseum.stat the game wrote, with the export's last-modified time.
  const expected = Buffer.alloc(0x6c);
  expected.write('pokemon_colosseum');
  Buffer.from('00060000', 'hex').copy(expected, 0x20);
  Buffer.from('093649ee', 'hex').copy(expected, 0x24);
  Buffer.from('474336453031020000000040', 'hex').copy(expected, 0x28);
  Buffer.from('5555aaaa', 'hex').copy(expected, 0x34);
  assert.deepEqual(convertGci(fixture()).stat, expected);
});

test('handles a party of six and a full-length name', () => {
  const bytes = fixture([0, 0, 1]);
  writeSlot(bytes, 2, 1, 'ABCDEFGHIJ', ['A', 'B', 'C', 'D', 'E', 'FFFFFFFFFF']);
  const converted = convertGci(bytes);
  assert.equal(converted.trainer, 'ABCDEFGHIJ');
  assert.deepEqual(converted.party, ['A', 'B', 'C', 'D', 'E', 'FFFFFFFFFF']);
});

test('reads a save written only once', () => {
  const converted = convertGci(fixture([1, 0, 0]));
  assert.equal(converted.saveCount, 1);
  assert.equal(converted.damaged, 0);
});

test('falls back as the game does when the newest copy is damaged', () => {
  const bytes = fixture();
  writeSlot(bytes, 1, 123, 'OLDER');
  damage(bytes, 2);
  const converted = convertGci(bytes);
  assert.equal(converted.trainer, 'OLDER');
  assert.equal(converted.saveCount, 123);
  assert.equal(converted.damaged, 1);
});

test('refuses a save with no readable copy', () => {
  const bytes = fixture();
  for (const slot of [0, 1, 2]) damage(bytes, slot);
  assert.throws(() => convertGci(bytes), /none of its three copies/);
});

test('refuses a bad slot header, which the game rejects outright', () => {
  for (const change of [
    bytes => { bytes[0x40 + SLOT_START] = 0; },
    bytes => { bytes[0x40 + SLOT_START + 2 * SLOT_SIZE + 0x0c] ^= 1; }]) {
    const bytes = fixture();
    change(bytes);
    assert.throws(() => convertGci(bytes), /would not open it/);
  }
});

test('a card file never saved to has no progress', () => {
  assert.throws(() => convertGci(fixture([0, 0, 0])), error => error.code === 'NO_PROGRESS');
});

test('says what another file is', () => {
  const japanese = fixture(); japanese.write('GC6J01');
  assert.throws(() => convertGci(japanese), error => error.code === 'OTHER_FILE' && /another region/.test(error.message));
  const other = Buffer.alloc(0x40 + 7 * BLOCK);
  other.write('GMSE01'); other.write('super_mario_sunshine', 8); other.writeUInt16BE(7, 0x38);
  assert.throws(() => convertGci(other), error => error.code === 'OTHER_FILE' && /not a Pokémon Colosseum save/.test(error.message));
  const renamed = fixture(); renamed.fill(0, 8, 40); renamed.write('something_else', 8);
  assert.throws(() => convertGci(renamed), error => error.code === 'OTHER_FILE');
});

test('refuses a truncated export or a wrong block count', () => {
  assert.throws(() => convertGci(Buffer.alloc(10)), /\.gci export/);
  assert.throws(() => convertGci(fixture().subarray(0, 0x40 + 47 * BLOCK + 1)), /\.gci export/);
  const blocks = fixture(); blocks.writeUInt16BE(47, 0x38);
  assert.throws(() => convertGci(blocks), /block count/);
});

test('reads only .gci files', t => {
  const dir = tempDir(t);
  const file = path.join(dir, 'save.gci');
  fs.writeFileSync(file, fixture());
  assert.equal(readGci(file).trainer, 'WES');
  fs.renameSync(file, path.join(dir, 'save.bin'));
  assert.throws(() => readGci(path.join(dir, 'save.bin')), /Choose a Dolphin \.gci/);
});

test('a folder stands for its .gci files, skipping other games and empty saves', t => {
  const dir = tempDir(t);
  const other = Buffer.alloc(0x40 + 7 * BLOCK);
  other.write('GMSE01'); other.write('super_mario_sunshine', 8); other.writeUInt16BE(7, 0x38);
  fs.writeFileSync(path.join(dir, '01-GC6E-pokemon_colosseum.gci'), fixture());
  fs.writeFileSync(path.join(dir, '01-GC6E-empty.GCI'), fixture([0, 0, 0]));
  fs.writeFileSync(path.join(dir, '01-GMSE-super_mario_sunshine.gci'), other);
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a save');
  const result = readGciFiles([dir]);
  assert.equal(path.basename(result.file), '01-GC6E-pokemon_colosseum.gci');
  assert.equal(result.converted.trainer, 'WES');
  assert.deepEqual(result.skipped.map(save => save.file).sort(), ['01-GC6E-empty.GCI', '01-GMSE-super_mario_sunshine.gci']);
});

test('a single file that cannot be imported says why; a broken one among several stops the import', t => {
  const dir = tempDir(t);
  const empty = path.join(dir, 'empty.gci'), good = path.join(dir, 'good.gci'), broken = path.join(dir, 'broken.gci');
  fs.writeFileSync(empty, fixture([0, 0, 0]));
  fs.writeFileSync(good, fixture());
  fs.writeFileSync(broken, Buffer.alloc(100));
  assert.throws(() => readGciFiles([empty]), /no saved progress/);
  assert.throws(() => readGciFiles([good, broken]), /broken\.gci: /);
  fs.rmSync(broken);
  assert.equal(readGciFiles([good, empty]).skipped.length, 1);
});

test('refuses several saves, and a folder with none', t => {
  const dir = tempDir(t);
  assert.throws(() => readGciFiles([dir]), /no Dolphin \.gci/);
  fs.writeFileSync(path.join(dir, 'a.gci'), fixture());
  fs.writeFileSync(path.join(dir, 'b.gci'), fixture());
  assert.throws(() => readGciFiles([dir]), /Choose one Dolphin save/);
  fs.rmSync(path.join(dir, 'b.gci'));
  fs.writeFileSync(path.join(dir, 'a.gci'), fixture([0, 0, 0]));
  fs.writeFileSync(path.join(dir, 'c.gci'), fixture([0, 0, 0]));
  assert.throws(() => readGciFiles([dir]), /None of these files/);
});

test('imports onto a card that does not exist yet', t => {
  const dir = tempDir(t);
  const card = path.join(dir, 'colo-port', 'card-a'), backups = path.join(dir, 'backups');
  const converted = convertGci(fixture());
  const result = importGci(converted, card, backups);
  assert.equal(result.previous, null);
  assert.deepEqual(fs.readFileSync(path.join(card, 'pokemon_colosseum.dat')), converted.data);
  assert.deepEqual(fs.readFileSync(path.join(card, 'pokemon_colosseum.stat')), converted.stat);
  assert.deepEqual(fs.readdirSync(card).sort(), ['pokemon_colosseum.dat', 'pokemon_colosseum.stat']);
});

test('backs up the current save, then replaces it, and restoring brings it back', t => {
  const dir = tempDir(t);
  const card = path.join(dir, 'card-a'), backups = path.join(dir, 'backups');
  fs.mkdirSync(card);
  fs.writeFileSync(path.join(card, 'pokemon_colosseum.dat'), 'current save');
  fs.writeFileSync(path.join(card, 'pokemon_colosseum.stat'), 'current stat');
  const converted = convertGci(fixture());
  const result = importGci(converted, card, backups);
  assert.deepEqual(fs.readFileSync(path.join(card, 'pokemon_colosseum.dat')), converted.data);
  const [backup] = saves.listBackups(backups);
  assert.equal(backup.reason, 'before-dolphin-import');
  assert.equal(path.join(backups, backup.id), result.previous);
  saves.restoreBackup(backup.id, card, backups);
  assert.equal(fs.readFileSync(path.join(card, 'pokemon_colosseum.dat'), 'utf8'), 'current save');
});

test('needs room on the card beside other files, and changes nothing without it', t => {
  const dir = tempDir(t);
  const card = path.join(dir, 'card-a'), backups = path.join(dir, 'backups');
  fs.mkdirSync(card);
  fs.writeFileSync(path.join(card, 'other.dat'), Buffer.alloc(11 * BLOCK));
  const converted = convertGci(fixture());
  importGci(converted, card, backups); // 48 + 11 fills the 59 blocks exactly
  fs.writeFileSync(path.join(card, 'other.dat'), Buffer.alloc(11 * BLOCK + 1));
  fs.writeFileSync(path.join(card, 'pokemon_colosseum.dat'), 'kept');
  assert.throws(() => importGci(converted, card, backups), /48 free blocks/);
  assert.equal(fs.readFileSync(path.join(card, 'pokemon_colosseum.dat'), 'utf8'), 'kept');
});

test('a failed import puts the card back and leaves nothing behind', t => {
  const dir = tempDir(t);
  const card = path.join(dir, 'card-a'), backups = path.join(dir, 'backups');
  fs.mkdirSync(card);
  fs.writeFileSync(path.join(card, 'pokemon_colosseum.dat'), 'current save');
  fs.writeFileSync(path.join(card, 'pokemon_colosseum.stat'), 'current stat');
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to.endsWith('.dat')) throw new Error('disk full');
    return rename(from, to);
  });
  assert.throws(() => importGci(convertGci(fixture()), card, backups), /disk full/);
  assert.equal(fs.readFileSync(path.join(card, 'pokemon_colosseum.dat'), 'utf8'), 'current save');
  assert.equal(fs.readFileSync(path.join(card, 'pokemon_colosseum.stat'), 'utf8'), 'current stat');
  assert.deepEqual(fs.readdirSync(card).sort(), ['pokemon_colosseum.dat', 'pokemon_colosseum.stat']);
});

// A card holding a save the way the port leaves it: the .dat, and nothing else this needs.
function card(t, bytes = fixture()) {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, 'pokemon_colosseum.dat'), bytes.subarray(0x40));
  return dir;
}

test('exports the card data unchanged behind the header the console keeps', t => {
  const dir = card(t);
  const { gci, trainer, damaged } = readCardSave(dir);
  assert.equal(gci.length, 0x40 + 48 * BLOCK);
  assert.deepEqual(gci.subarray(0x40), fixture().subarray(0x40));
  // The header Dolphin wrote when the original game created its save, with this export's time.
  const retail = Buffer.from([
    '474336453031ff02706f6b656d6f6e5f',
    '636f6c6f737365756d00000000000000',
    '00000000000000000000003700000040',
    '5555aaaa1c0000050030ffff00000000'].join(''), 'hex');
  assert.equal(retail.length, 0x40);
  gci.copy(retail, 0x28, 0x28, 0x2c);
  assert.deepEqual(gci.subarray(0, 0x40), retail);
  assert.equal(trainer, 'WES');
  assert.equal(damaged, 0);
});

test('an exported save imports back to the same save', t => {
  const dir = card(t);
  const { gci } = readCardSave(dir);
  const converted = convertGci(gci);
  assert.deepEqual(converted.data, fs.readFileSync(path.join(dir, 'pokemon_colosseum.dat')));
  assert.equal(converted.trainer, 'WES');
  const expected = convertGci(fixture()).stat;
  expected.writeUInt32BE(gci.readUInt32BE(0x28), 0x24);
  assert.deepEqual(converted.stat, expected);
});

test('dates an export by when the game last wrote the save', t => {
  const dir = card(t);
  const when = new Date(2026, 10, 7, 12, 30, 15);
  fs.utimesSync(path.join(dir, 'pokemon_colosseum.dat'), when, when);
  const seconds = readCardSave(dir).gci.readUInt32BE(0x28);
  assert.equal(new Date(Date.UTC(2000, 0, 1) + seconds * 1000).toISOString(), '2026-11-07T12:30:15.000Z');
});

test('says when there is nothing to export', t => {
  assert.throws(() => readCardSave(tempDir(t)), /no Pokémon Colosseum save to export/);
  assert.throws(() => readCardSave(card(t, fixture([0, 0, 0]))), error => error.code === 'NO_PROGRESS');
});

test('a damaged save points at the backups, not at Dolphin', t => {
  const short = tempDir(t);
  fs.writeFileSync(path.join(short, 'pokemon_colosseum.dat'), Buffer.alloc(BLOCK));
  assert.throws(() => readCardSave(short), /Restore a backup/);
  const bytes = fixture();
  damage(bytes, 0); damage(bytes, 1); damage(bytes, 2);
  assert.throws(() => readCardSave(card(t, bytes)), /none of its three copies.*Restore a backup/);
});

test('exports a save whose newest copy is damaged, and says so', t => {
  const bytes = fixture();
  damage(bytes, 2);
  const { gci, damaged } = readCardSave(card(t, bytes));
  assert.equal(damaged, 1);
  assert.deepEqual(gci.subarray(0x40), bytes.subarray(0x40));
});

test('writes under the name Dolphin uses, replacing the chosen file', t => {
  const dir = tempDir(t);
  const file = path.join(dir, EXPORT_NAME);
  assert.equal(EXPORT_NAME, '01-GC6E-pokemon_colosseum.gci');
  fs.writeFileSync(file, 'older export');
  assert.equal(writeGci(Buffer.from('new'), file), file);
  assert.equal(fs.readFileSync(file, 'utf8'), 'new');
  assert.deepEqual(fs.readdirSync(dir), [EXPORT_NAME]);
});

test('adds the extension, but never to replace a file the dialog did not ask about', t => {
  const dir = tempDir(t);
  const file = writeGci(Buffer.from('new'), path.join(dir, 'wes'));
  assert.equal(file, path.join(dir, 'wes.gci'));
  assert.throws(() => writeGci(Buffer.from('other'), path.join(dir, 'wes')), /wes\.gci already exists/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'new');
});

test('a failed export keeps the file it would have replaced and leaves nothing behind', t => {
  const dir = tempDir(t);
  const file = path.join(dir, EXPORT_NAME);
  fs.writeFileSync(file, 'older export');
  t.mock.method(fs, 'renameSync', () => { throw new Error('disk full'); });
  assert.throws(() => writeGci(Buffer.from('new'), file), /disk full/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'older export');
  assert.deepEqual(fs.readdirSync(dir), [EXPORT_NAME]);
});

test('an XD save goes to a .gci and back as it is, with its directory entry from the card .stat', t => {
  const gci = require('../src/gci-save');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xd-gci-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const card = path.join(dir, 'card');
  fs.mkdirSync(card);
  const data = crypto.randomBytes(43 * BLOCK);
  const stat = Buffer.alloc(0x6c);
  stat.write('PokemonXD', 0, 'latin1');
  stat.writeUInt32BE(data.length, 0x20);
  stat.write('GXXE01', 0x28, 'latin1');
  stat[0x2e] = 2;
  stat.writeUInt32BE(0x40, 0x30);
  stat.writeUInt16BE(0x5555, 0x34);
  stat.writeUInt16BE(0x5555, 0x36);
  fs.writeFileSync(path.join(card, 'PokemonXD.dat'), data);
  fs.writeFileSync(path.join(card, 'PokemonXD.stat'), stat);

  const save = gci.readCardSaveFor(card, 'xd');
  assert.equal(save.gci.length, 0x40 + data.length);
  assert.equal(save.gci.toString('latin1', 0, 6), 'GXXE01');
  assert.equal(save.gci.toString('latin1', 8, 17), 'PokemonXD');
  assert.equal(save.gci.readUInt16BE(0x38), 43);
  assert.equal(save.gci.readUInt32BE(0x2c), 0x40, 'icon address from the .stat');
  assert.equal(gci.exportName('xd'), '01-GXXE-PokemonXD.gci');

  const file = gci.writeGci(save.gci, path.join(dir, gci.exportName('xd')));
  const { converted } = gci.readGciFilesFor([file], 'xd');
  assert.ok(converted.data.equals(data));
  assert.ok(converted.stat.subarray(0, 0x24).equals(stat.subarray(0, 0x24)));
  assert.ok(converted.stat.subarray(0x28, 0x3c).equals(stat.subarray(0x28, 0x3c)));
  assert.throws(() => gci.readGciFilesFor([file], 'colosseum'), /not a Pokémon Colosseum save/);

  const target = path.join(dir, 'imported');
  const result = gci.importGci(converted, target, path.join(dir, 'backups'));
  assert.equal(result.name, 'PokemonXD');
  assert.ok(fs.readFileSync(path.join(target, 'PokemonXD.dat')).equals(data));
});

test('a Colosseum .gci given for XD says it is not an XD save', t => {
  const gci = require('../src/gci-save');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xd-gci-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bytes = Buffer.alloc(0x40 + 48 * BLOCK);
  bytes.write('GC6E01', 0, 'latin1');
  bytes.write('pokemon_colosseum', 8, 'latin1');
  bytes.writeUInt16BE(48, 0x38);
  const file = path.join(dir, '01-GC6E-pokemon_colosseum.gci');
  fs.writeFileSync(file, bytes);
  assert.throws(() => gci.readGciFilesFor([file], 'xd'), /not a Pokémon XD: Gale of Darkness save/);
});
