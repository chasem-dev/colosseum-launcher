'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const pbrDisc = require('../src/pbr-disc');
const { gcm, ciso } = require('./disc-fixture');

// A Wii disc's header, partition table and one game partition whose data ends at 0x60000
function wiiHeader(id = 'RPBE01', title = 'Pokemon Battle Revolution') {
  const bytes = Buffer.alloc(0x440);
  bytes.write(id, 0, 'ascii');
  bytes.writeUInt32BE(0x5d1c9ea3, 0x18);
  bytes.write(title, 0x20, 'latin1');
  return bytes;
}
function wiiIso(id, title) {
  const bytes = Buffer.alloc(0x60000);
  wiiHeader(id, title).copy(bytes);
  bytes.writeUInt32BE(1, 0x40000); bytes.writeUInt32BE(0x40020 / 4, 0x40004);
  bytes.writeUInt32BE(0x50000 / 4, 0x40020);
  bytes.writeUInt32BE(0x8000 / 4, 0x50000 + 0x2b8); bytes.writeUInt32BE(0x8000 / 4, 0x50000 + 0x2bc);
  return bytes;
}
function wbfs(header) {
  const bytes = Buffer.alloc(0x400);
  bytes.write('WBFS'); bytes[8] = 9; bytes[9] = 21; bytes[0xc] = 1;
  header.copy(bytes, 0x200, 0, 0x100);
  return bytes;
}
function rvz(header) {
  const bytes = Buffer.alloc(0x100);
  bytes.write('RVZ\x01', 0, 'latin1'); bytes.writeUInt32BE(2, 0x48);
  header.copy(bytes, 0x58, 0, 0x80);
  return bytes;
}
function gcz(header) {
  const block = zlib.deflateSync(Buffer.concat([header, Buffer.alloc(0x4000 - header.length)]));
  const head = Buffer.alloc(0x20 + 12);
  head.writeUInt32LE(0xb10bc001, 0); head.writeUInt32LE(1, 4);
  head.writeBigUInt64LE(BigInt(block.length), 8); head.writeBigUInt64LE(0x4000n, 0x10);
  head.writeUInt32LE(0x4000, 0x18); head.writeUInt32LE(1, 0x1c);
  return Buffer.concat([head, block]);
}

function withFiles(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pbr-disc-'));
  const write = (name, bytes) => { const file = path.join(root, name); fs.writeFileSync(file, bytes); return file; };
  try { fn(write, root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('a Battle Revolution disc passes in each format, with its region', () => withFiles(write => {
  assert.deepEqual(pbrDisc.validate(write('pbr.iso', wiiIso())), { file: path.resolve(write('pbr.iso', wiiIso())), gameId: 'RPBE01', region: 'North American', format: 'iso' });
  assert.equal(pbrDisc.validate(write('pbr.wbfs', wbfs(wiiHeader('RPBP01')))).region, 'European');
  assert.equal(pbrDisc.validate(write('pbr.rvz', rvz(wiiHeader('RPBJ01')))).region, 'Japanese');
  assert.equal(pbrDisc.validate(write('pbr.gcz', gcz(wiiHeader()))).format, 'gcz');
  assert.equal(pbrDisc.validate(write('pbr.ciso', ciso(wiiIso()))).format, 'ciso');
  assert.match(pbrDisc.describe(pbrDisc.validate(write('pbr.rvz', rvz(wiiHeader())))), /North American release of Pokémon Battle Revolution \(RPBE01, RVZ\)/);
}));

test('a wrong file is turned away with the reason', () => withFiles((write, root) => {
  assert.throws(() => pbrDisc.validate(write('colo.iso', gcm())), /That's Pokémon Colosseum \(GC6E01\), a GameCube disc\. Pokémon Battle Revolution is a Wii disc/);
  assert.throws(() => pbrDisc.validate(write('sms.iso', gcm('GMSE01', 0, 'Super Mario Sunshine'))), /"Super Mario Sunshine" \(GMSE01\), a GameCube disc/);
  assert.throws(() => pbrDisc.validate(write('wii.rvz', rvz(wiiHeader('RSPE01', 'Wii Sports')))), /That's "Wii Sports" \(RSPE01\), not Pokémon Battle Revolution/);
  assert.throws(() => pbrDisc.validate(write('pbr.zip', Buffer.from('PK\x03\x04rest', 'latin1'))), /ZIP archive.*Extract the disc file/);
  assert.throws(() => pbrDisc.validate(write('notes.txt', Buffer.alloc(0x1000, 0x41))), /isn't a Wii disc image/);
  assert.throws(() => pbrDisc.validate(write('tiny.iso', Buffer.from('hi'))), /too small to be a disc/);
  assert.throws(() => pbrDisc.validate(write('cut.rvz', Buffer.from('RVZ\x01', 'latin1'))), /RVZ file is incomplete or damaged/);
  assert.throws(() => pbrDisc.validate(path.join(root, 'gone.iso')), /can't be found/);
  assert.throws(() => pbrDisc.validate(root), /That's a folder/);
  assert.throws(() => pbrDisc.validate(''), /No file was chosen/);
}));

// Kept, as a trimmed or NKit image is short too and may read, but with a warning
test('a plain ISO cut short of its game partition is kept with a warning', () => withFiles(write => {
  assert.equal(pbrDisc.validate(write('whole.iso', wiiIso())).warning, undefined);
  const cut = pbrDisc.validate(write('cut.iso', wiiIso().subarray(0, 0x58000)));
  assert.match(cut.warning, /may be incomplete: it's 0 MB, but the disc needs at least 0 MB/);
  assert.match(pbrDisc.describe(cut), /\(RPBE01, ISO\)\. It may be incomplete/);
  const nkit = wiiIso().subarray(0, 0x58000);
  nkit.write('NKIT', 0x200, 'latin1');
  assert.match(pbrDisc.validate(write('pbr.nkit.iso', nkit)).warning, /NKit image/);
}));
