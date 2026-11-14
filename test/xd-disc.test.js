'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const xdDisc = require('../src/xd-disc');
const hsd = require('../src/hsd-model');

// An "I_SF" stream header: rate, samples, channels, block size, and each channel's coefficients (all zero here, so a
// frame's samples are its nibbles scaled)
function streamHead({ rate = 32000, samples, channels = 2, block, loop = null }) {
  const head = Buffer.alloc(0xc0);
  head.write('I_SF', 0, 'latin1');
  head.writeUInt32BE(rate, 8);
  head.writeUInt32BE(samples, 0x0c);
  head.writeUInt32BE(channels, 0x14);
  head.writeUInt32BE(block, 0x18);
  if (loop) { head.writeUInt32BE(1, 0x1c); head.writeUInt32BE(loop[0], 0x20); head.writeUInt32BE(loop[1], 0x28); }
  return head;
}
// A frame whose 14 samples are all `value` (scale 1, predictor 0: no history counts)
const frame = value => Buffer.from([0x00, ...Array(7).fill(((value & 15) << 4) | (value & 15))]);

test('a stream\'s channels are its blocks in turn, each decoded as DSP-ADPCM', () => {
  // two frames to a block: left, right, left, right
  const block = 16, data = Buffer.concat([frame(1), frame(1), frame(2), frame(2), frame(3), frame(3), frame(-4), frame(-4)]);
  const { rate, channels, loop } = xdDisc.decodeStream(streamHead({ samples: 56, block }), data);
  assert.equal(rate, 32000);
  assert.equal(loop, null);
  assert.deepEqual([...channels[0]], [...Array(28).fill(1), ...Array(28).fill(3)]);
  assert.deepEqual([...channels[1]], [...Array(28).fill(2), ...Array(28).fill(-4)]);
  assert.throws(() => xdDisc.decodeStream(Buffer.alloc(0xc0), data), /isn't on the disc/);
});

test('a stream\'s loop is in nibble addresses: 16 to a frame, the first two its header', () => {
  const { loop } = xdDisc.decodeStream(streamHead({ samples: 56, block: 64, loop: [0x12, 0x3f] }), Buffer.alloc(64 * 2));
  assert.deepEqual(loop, { start: 14, end: 56 });
  assert.equal(xdDisc.sampleAt(2), 0);
  assert.equal(xdDisc.sampleAt(0x1f), 27);
});

test('an XD model is made Colosseum\'s: header, model, particles, motion slots and shiny filter where hsd-model.js reads them', () => {
  const count = 2, dat = Buffer.from('MODELDATA!'), gpt = Buffer.from('PARTICLES');
  const head = (0x84 + count * 0xd0 + 31) & ~31;
  const x = Buffer.alloc(head + ((gpt.length + 31) & ~31) + dat.length);
  x.writeUInt32BE(dat.length, 0);
  x.writeUInt32BE(gpt.length, 8);
  x.writeUInt32BE(count, 0x10);
  x.writeUInt32BE(0xfffffffe, 0x14);
  // sleep 8, wake 9, blink 7, and no fourth
  [[1, 8], [1, 9], [1, 7], [0, 0]].forEach(([on, animation], k) => { x[0x1c + k * 19] = on; x[0x1c + k * 19 + 18] = animation; });
  [0, 0, 2, 3].forEach((channel, i) => x.writeUInt32BE(channel, 0x70 + i * 4));
  x.set([0x82, 0x81, 0x80, 0x7f], 0x80);
  for (let i = 0; i < count; i++) {
    const at = 0x84 + i * 0xd0;
    x.writeUInt32BE(2, at + 4);   // two motions
    x.writeFloatBE(0.5, at + 0x10);
    x.writeUInt32BE(1, at + 0x8c);   // the first in use
    x.writeUInt32BE(i, at + 0x90);
    x.writeUInt32BE(0, at + 0x94);
  }
  gpt.copy(x, head);
  dat.copy(x, head + 32);
  const c = xdDisc.colosseumPkx(x);
  assert.deepEqual([c.readUInt32BE(0), c.readUInt32BE(4), c.readUInt32BE(8), c.readUInt32BE(0xc), c.readUInt32BE(0x10)], [dat.length, gpt.length, count, 0xfffffffe, 5]);
  assert.deepEqual([c.readInt32BE(0x18), c.readInt32BE(0x1c), c.readInt32BE(0x20)], [8, 9, 7]);
  assert.equal(c.toString('latin1', 0x40, 0x40 + dat.length), 'MODELDATA!');
  assert.equal(c.toString('latin1', 0x60, 0x60 + gpt.length), 'PARTICLES');
  const slots = 0x80;
  assert.equal(c.readUInt32BE(slots + 0x10), 30, 'half a second is 30 frames');
  assert.deepEqual([c.readUInt32BE(slots + 0x8c), c.readUInt32BE(slots + 0x94)], [0, 1], 'Colosseum marks a motion in use with 0');
  const shiny = slots + ((count * 0xd0 + 31) & ~31);
  assert.deepEqual([0, 1, 2, 3].map(i => c.readUInt32BE(shiny + i * 4)), [0, 0, 2, 3]);
  const word = c.readUInt32BE(shiny + 0x10);
  assert.deepEqual([word & 0xff, (word >> 8) & 0xff, (word >> 16) & 0xff], [0x80, 0x81, 0x82], 'red, green and blue as readHeader takes them');
});

test('song names: the ones known by name, the rest made readable', () => {
  assert.equal(xdDisc.songTitle('stm_bgm_title.fsys'), 'Title Screen');
  assert.equal(xdDisc.songTitle('stm_me_me_win.fsys'), 'Win Battle');
  assert.equal(xdDisc.songTitle('stm_bgm_b_colosseum1.fsys'), 'Colosseum - 1st Round');
  assert.equal(xdDisc.songTitle('stm_bgm_b_paira.fsys'), 'Colosseum - 1st Round (Pyrite)');
  assert.equal(xdDisc.songTitle('stm_bgm_chr_mecha.fsys'), 'Chr mecha');
  assert.equal(xdDisc.songTitle('stm_me_fanfare00.fsys'), 'VS Battle Fanfare 1');
});

// --- The real disc: XD_TEST_DISC=/path/to/GXXE01.iso npm test ---------------------------------------------------

const rom = process.env.XD_TEST_DISC;
const withDisc = { skip: rom && fs.existsSync(rom) ? false : 'set XD_TEST_DISC to your XD disc to run this' };

test('XD\'s Pokédex: every Pokémon, each with a model and a sprite, and how XD gives it', withDisc, () => {
  const pokedex = require('../src/pokedex');
  const list = pokedex.readPokedex(rom), count = kind => list.filter(entry => entry.status.kind === kind).length;
  assert.deepEqual(list.map(entry => entry.national), Array.from({ length: 386 }, (_, i) => i + 1));
  assert.deepEqual(list.filter(entry => !entry.forms.length), []);
  assert.deepEqual(list.filter(entry => !entry.sprite), []);
  assert.equal(count('shadow'), 83);
  assert.equal(count('gift'), 8);
  assert.equal(count('wild'), 9);
  const find = national => list.find(entry => entry.national === national);
  assert.equal(find(133).status.note, 'Your partner from the very start of the game.');
  assert.deepEqual(find(133).evolutions, [135, 134, 136, 196, 197]);
  assert.equal(find(249).status.kind, 'shadow');
  assert.match(find(27).status.note, /Rock Poké Spot/);
  assert.equal(find(1).height, '2\'04"');
  assert.equal(find(1).weight, '15.2 lbs');
  assert.deepEqual(find(386).forms.map(form => form.label), ['Normal', 'Shiny', 'Attack', 'Defense', 'Speed']);
  const eevee = pokedex.create().model(rom, 133, 'eievui');
  assert.ok(eevee.shapes.length > 0 && eevee.animations.length > 0);
  assert.deepEqual([eevee.sleep, eevee.wake, eevee.blink], [8, 9, 7]);
  assert.ok(eevee.motions.some(motion => motion.kind === 'idle'));
});

test('XD\'s cries stream from its disc, at 32 kHz', withDisc, () => {
  const cries = require('../src/pokemon-cries').create();
  const sound = cries.soundOf(rom, 133);
  assert.equal(sound, 595);
  assert.equal(cries.has(rom, sound), true);
  const wav = cries.wav(rom, sound), seconds = (wav.length - 44) / 2 / wav.readUInt32LE(24);
  assert.equal(wav.readUInt32LE(24), 32000);
  assert.ok(seconds > 0.5 && seconds < 3, `${seconds} s`);
  let loud = 0;
  for (let at = 44; at < wav.length; at += 2) loud = Math.max(loud, Math.abs(wav.readInt16LE(at)));
  assert.ok(loud > 4000, 'it makes a sound');
});

test('XD\'s Jukebox: its own sound test\'s songs, streamed', withDisc, () => {
  const { Disc } = require('../src/disc');
  const songs = require('../src/jukebox-songs'), render = require('../src/jukebox-render');
  const disc = new Disc(rom);
  try {
    const tracks = songs.read(disc);
    assert.ok(tracks.length > 80, `${tracks.length} songs`);
    assert.equal(new Set(tracks.map(track => track.id)).size, tracks.length);
    assert.ok(tracks.some(track => track.name === 'Title screen'));
    const song = render.create(disc).render(1468);   // the Orre Colosseum, which loops
    assert.ok(song.rate > 31000 && song.rate <= 32000);
    assert.ok(song.loop && song.loop.start > 0 && song.loop.end > song.loop.start && song.loop.end <= song.left.length / song.rate);
    let smooth = 0, energy = 0;
    for (let i = 1; i < song.left.length; i++) { smooth += song.left[i] * song.left[i - 1]; energy += song.left[i] * song.left[i]; }
    assert.ok(smooth / energy > 0.9, 'music, not noise');
  } finally { disc.close(); }
});
