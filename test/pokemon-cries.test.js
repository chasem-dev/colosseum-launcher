'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const cries = require('../src/pokemon-cries');
const { Disc } = require('../src/disc');

// --- DSP-ADPCM ---------------------------------------------------------------------------

// One 8-byte frame: its predictor/scale byte, then 14 nibbles, high nibble first.
const frame = (header, nibbles) => Buffer.from([header, ...Array.from({ length: 7 }, (_, i) => ((nibbles[i * 2] & 15) << 4) | (nibbles[i * 2 + 1] & 15))]);
// Predictor 0 adds the last sample (1.0 in 11 bits); predictor 1 adds nothing; predictor 2 is 2*last - the one before.
const COEFFICIENTS = [2048, 0, 0, 0, 4096, -2048, ...Array(10).fill(0)];

test('a frame decodes as the DSP does: nibble times scale, plus the predictor of the last two', () => {
  const ones = cries.decodeAdpcm(frame(0x00, Array(14).fill(1)), 14, COEFFICIENTS);
  assert.deepEqual([...ones], Array.from({ length: 14 }, (_, i) => i + 1));
  const alone = cries.decodeAdpcm(frame(0x13, [1, -1, 7, -8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), 4, COEFFICIENTS);
  assert.deepEqual([...alone], [8, -8, 56, -64]);
  // a ramp, then 2*last - before carries it on into the next frame with nothing added
  const ramp = cries.decodeAdpcm(Buffer.concat([frame(0x00, Array(14).fill(1)), frame(0x20, Array(14).fill(0))]), 20, COEFFICIENTS);
  assert.deepEqual([...ramp], Array.from({ length: 20 }, (_, i) => i + 1));
});

test('a frame is clamped to 16 bits, and decoding stops at the sample count', () => {
  const loud = cries.decodeAdpcm(frame(0x0c, Array(14).fill(7)), 14, COEFFICIENTS);
  assert.equal(loud[0], 28672);
  assert.ok([...loud.subarray(1)].every(value => value === 32767));
  const quiet = cries.decodeAdpcm(frame(0x0c, Array(14).fill(-8)), 3, COEFFICIENTS);
  assert.deepEqual([...quiet], [-32768, -32768, -32768]);
  assert.equal(cries.decodeAdpcm(Buffer.concat([frame(0, []), frame(0, [])]), 20, COEFFICIENTS).length, 20);
});

test('a cry is a 16-bit mono WAV at its rate', () => {
  const file = cries.wav(Int16Array.of(1, -2, 32767), 11025);
  assert.equal(file.toString('latin1', 0, 4), 'RIFF');
  assert.equal(file.toString('latin1', 8, 16), 'WAVEfmt ');
  assert.equal(file.readUInt16LE(22), 1);
  assert.equal(file.readUInt32LE(24), 11025);
  assert.equal(file.readUInt16LE(34), 16);
  assert.equal(file.readUInt32LE(40), 6);
  assert.deepEqual([file.readInt16LE(44), file.readInt16LE(46), file.readInt16LE(48)], [1, -2, 32767]);
});

// --- MusyX: sound id to FX, macro and sample ---------------------------------------------

// A project with one sound effect group: FX 7 plays macro 300 at `key`.
function project(group, key) {
  const out = Buffer.alloc(0x40, 0xff);
  out.writeUInt32BE(0x40, 0);
  out.writeUInt16BE(group, 4);
  out.writeUInt16BE(1, 6);
  out.writeUInt32BE(0x1c + 8, 0x1c);   // its FX table, right after the header
  out.writeUInt16BE(1, 0x24);
  out.writeUInt16BE(0, 0x26);
  out.set([0, 7, 0x01, 0x2c, 4, 129, 127, 64, key, 0], 0x28);
  return out;
}
// A pool with macro 300: the steps the disc's cries have (age speed, volume, start sample 12, wait, end).
function pool() {
  const steps = [[0x38, 0x107ac0], [0x00640740, 0], [0x00000c10, 0], [0x01000007, 0xffff0000], [0, 0]];
  const out = Buffer.alloc(16 + 8 + steps.length * 8 + 4);
  out.writeUInt32BE(16, 0);
  out.writeUInt32BE(8 + steps.length * 8, 16);
  out.writeUInt16BE(300, 20);
  steps.forEach(([a, b], i) => { out.writeUInt32BE(a, 24 + i * 8); out.writeUInt32BE(b, 28 + i * 8); });
  out.writeUInt32BE(0xffffffff, out.length - 4);
  return out;
}
// A sample directory with sample 12: 28 samples at `offset`, root key 60, 11025 Hz, and its coefficients.
function sdir(offset) {
  const out = Buffer.alloc(0x20 + 2 + 0x28, 0);
  out.writeUInt16BE(12, 0);
  out.writeUInt32BE(offset, 4);
  out.writeUInt32BE((60 << 24) | 11025, 12);
  out.writeUInt32BE(28, 16);
  out.writeUInt32BE(0x22, 28);
  out.writeUInt16BE(0xffff, 0x20);
  COEFFICIENTS.forEach((value, i) => out.writeInt16BE(value, 0x22 + 8 + i * 2));
  return out;
}
// Sound 2 is FX 7 of group 4; sound 1 isn't a sound effect.
function sounds() {
  const out = Buffer.alloc(3 * 12);
  out.set([0x00, 4, 1, 10], 12);
  out.writeUInt16BE(7, 16);
  out.set([0x80, 4, 1, 10], 24);
  out.writeUInt16BE(7, 28);
  return out;
}
const tables = key => ({ sounds: sounds(), groups: new Map([[4, { fx: cries.fxTable(project(4, key), 4), macros: cries.macros(pool()), samples: cries.sampleDirectory(sdir(0x40)), file: 'sound/x.samp' }]]) });

test('a sound id leads to its FX, its macro\'s sample and that sample\'s rate', () => {
  const found = cries.locate(tables(60), 2);
  assert.equal(found.rate, 11025);
  assert.equal(found.sample.count, 28);
  assert.equal(found.sample.offset, 0x40);
  assert.deepEqual(found.sample.coefficients, COEFFICIENTS);
  assert.equal(cries.macroSample(cries.macros(pool()).get(300)), 12);
});

test('a key above the sample\'s root plays it faster, as sndGetPitch has it', () => {
  assert.equal(cries.locate(tables(72), 2).rate, 22050);
  assert.equal(cries.locate(tables(48), 2).rate, 5513);
});

test('a sound that isn\'t a cry has none', () => {
  assert.equal(cries.locate(tables(60), 1), null);
  assert.equal(cries.locate(tables(60), 0), null);
  assert.equal(cries.locate(tables(60), 5000), null);
  assert.equal(cries.locate(tables(60), null), null);
  const other = tables(60);
  other.sounds[25] = 9;   // a group that holds no cries
  assert.equal(cries.locate(other, 2), null);
});

test('a cry decodes from its file on the disc', () => {
  const file = Buffer.concat([Buffer.alloc(0x40), frame(0x00, Array(14).fill(1)), frame(0x00, Array(14).fill(-1))]);
  const disc = { files: new Map([['sound/x.samp', { offset: 0x100, size: file.length }]]), read: (at, n) => file.subarray(at - 0x100, at - 0x100 + n) };
  const cry = cries.decodeCry(disc, tables(60), 2);
  assert.equal(cry.rate, 11025);
  assert.equal(cry.samples.length, 28);
  assert.equal(cry.samples[13], 14);
  assert.equal(cry.samples[27], 0);
  assert.equal(cry.wav.readUInt32LE(40), 56);
  disc.files.set('sound/x.samp', { offset: 0x100, size: 0x48 });   // a file too short for it
  assert.equal(cries.decodeCry(disc, tables(60), 2), null);
});

// --- The real disc: COLO_TEST_DISC=/path/to/GC6E01.iso npm test --------------------------

const rom = process.env.COLO_TEST_DISC;
const withDisc = { skip: rom && fs.existsSync(rom) ? false : 'set COLO_TEST_DISC to your disc to run this' };

test('every Pokémon on the disc has its cry, at 11025 Hz', withDisc, () => {
  const disc = new Disc(rom);
  try {
    const found = cries.readTables(disc), peak = samples => samples.reduce((top, value) => Math.max(top, Math.abs(value)), 0);
    assert.equal(found.voices.size, 386);
    for (const [national, sound] of found.voices) {
      const cry = cries.decodeCry(disc, found, sound);
      assert.ok(cry, `#${national}`);
      assert.equal(cry.rate, 11025, `#${national}`);
      assert.ok(cry.samples.length > 4000 && cry.samples.length < 11025 * 3, `#${national}`);
    }
    // Charmander, Pikachu, Mewtwo and Espeon: sounds 573, 594, 719 and 765, as the game's own playback has them
    const known = { 4: [573, 9024, 31613], 25: [594, 11328, 31402], 150: [719, 20512, 31566], 196: [765, 14080, 31505] };
    for (const [national, [sound, length, top]] of Object.entries(known)) {
      assert.equal(found.voices.get(Number(national)), sound);
      const cry = cries.decodeCry(disc, found, sound);
      assert.equal(cry.samples.length, length, `#${national}`);
      assert.equal(peak(cry.samples), top, `#${national}`);
    }
    assert.equal(cries.decodeCry(disc, found, 0), null);
  } finally { disc.close(); }
});

test('the Pokédex keeps the last cry and knows a sound that isn\'t one', withDisc, () => {
  const dex = cries.create(), sound = dex.soundOf(rom, 25);
  const first = dex.wav(rom, sound);
  assert.equal(dex.wav(rom, sound), first);
  assert.equal(dex.has(rom, sound), true);
  assert.equal(dex.has(rom, 0), false);
  assert.equal(dex.wav(rom, 0), null);
});
