'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const mx = require('../src/musyx-music');

// A macro step: two words, the command in the first word's low 7 bits.
const step = (word0, word1 = 0) => { const b = Buffer.alloc(8); b.writeUInt32BE(word0 >>> 0, 0); b.writeUInt32BE(word1 >>> 0, 4); return b; };
const startSample = id => step(0x10 | (id << 8));
const waitForKeyOff = () => step(0x07 | 0x100, 0xffff0000);
const waitMs = ms => step(0x07, ms * 0x10000);
const keyOff = () => step(0x12), end = () => step(0x00);

test('the volume curve is the game\'s: silent at 0, full at 1, and a point of the table between', () => {
  assert.equal(mx.volumeGain(0), 0);
  assert.equal(mx.volumeGain(1), 1);
  assert.ok(Math.abs(mx.volumeGain(64 / 127) - 0.21417899) < 1e-6);
  assert.equal(mx.volumeGain(7), 1);
  assert.equal(mx.volumeGain(-1), 0);
});

test('pan puts the sound left, centre (about -3 dB each side) or right', () => {
  assert.deepEqual(mx.panGains(0), { left: 1, right: 0 });
  assert.deepEqual(mx.panGains(127), { left: 0, right: 1 });
  const centre = mx.panGains(64);
  assert.ok(Math.abs(centre.left - 0.7079) < 0.01 && Math.abs(centre.right - 0.7079) < 0.01);
});

test('a pitch or modulation stream is time and value steps, to a 0x80 0x00 end', () => {
  // +16 after 5 ticks; then (a two-byte time of 10) a one-byte step 0x7e, which is -2; then the end
  const song = { d: Buffer.from([0xff, 0x05, 0x10, 0x80, 0x0a, 0x7e, 0x80, 0x00]) };   // (a stream at offset 0 is none)
  assert.deepEqual(mx.readStream(song, 1, 0x2000), [{ time: 5, value: 0x2010 }, { time: 15, value: 0x200e }]);
  assert.deepEqual(mx.readStream(song, 0, 0x2000), []);   // no stream at all
});

test('a tick is a 384th of a beat, over the tempo track', () => {
  const clock = mx.tickClock({ initialBpm: 120, tempo: [{ tick: 0, bpm: 120 }, { tick: 384, bpm: 60 }] });
  assert.equal(clock(0), 0);
  assert.equal(clock(384), 0.5);          // a beat at 120 bpm
  assert.equal(clock(768), 1.5);          // then a beat at 60
});

test('a linear envelope\'s sustain is its 12-bit field times 8', () => {
  const curve = Buffer.alloc(8);
  curve.writeUInt16LE(100, 0); curve.writeUInt16LE(1000, 2); curve.writeUInt16LE(0x100, 4); curve.writeUInt16LE(500, 6);
  const env = mx.envelopeOf(curve, false, 100, 60);
  assert.equal(env.atk, 0.1); assert.equal(env.dec, 1); assert.equal(env.rel, 0.5);
  assert.ok(Math.abs(env.sus - 0x800 / 0x7fff) < 1e-9);
  const full = Buffer.from(curve); full.writeUInt16LE(0x1000, 4);
  assert.equal(mx.envelopeOf(full, false, 100, 60).sus, 1);   // 0x1000 * 8 reaches 0x7fff
  assert.equal(mx.envelopeOf(null, false, 100, 60), null);
});

test('an envelope rises, decays to its sustain, holds, and releases to nothing', () => {
  const env = { linear: true, atk: 0.1, dec: 1, sus: 0.5, rel: 0.5 };
  assert.equal(mx.gainAt(env, 0, 10), 0);
  assert.ok(Math.abs(mx.gainAt(env, 0.05, 10) - 0.5) < 1e-9);
  assert.ok(Math.abs(mx.gainAt(env, 0.6, 10) - 0.75) < 1e-9);
  assert.equal(mx.gainAt(env, 5, 10), 0.5);
  assert.ok(Math.abs(mx.gainAt(env, 10.25, 10) - 0.25) < 1e-9);
  assert.equal(mx.gainAt(env, 10.6, 10), null);
  assert.equal(mx.gainAt(null, 0.5, 1), 1);   // no envelope: on until the note ends, then a short fade
  assert.equal(mx.gainAt(null, 2, 1), null);
});

test('a macro starts its sample, waits for the key off, releases, and ends', () => {
  const bank = { macros: new Map([[1, Buffer.concat([startSample(7), waitForKeyOff(), keyOff(), waitMs(500), end()])]]), curves: new Map() };
  const voice = mx.runMacro(bank, 1, 60, 100, 2);
  assert.equal(voice.sample, 7);
  assert.equal(voice.startAt, 0);
  assert.equal(voice.releaseAt, 2);   // the key off came when the note ended
  assert.equal(mx.runMacro(bank, 9, 60, 100, 2), null);
});

test('a keymap or a layer picks its macros by the key', () => {
  const macro = id => Buffer.concat([startSample(id), end()]);
  const keymap = Buffer.alloc(128 * 8, 0xff); keymap.writeUInt16BE(2, 60 * 8); keymap.writeInt8(2, 60 * 8 + 2);   // key 60 plays macro 2, two semitones up
  const layer = Buffer.alloc(4 + 2 * 12, 0xff); layer.writeUInt32BE(2, 0);
  layer.writeUInt16BE(1, 4); layer[6] = 0; layer[7] = 59; layer.writeInt8(0, 8); layer[9] = 127;       // macro 1 below 60
  layer.writeUInt16BE(2, 16); layer[18] = 60; layer[19] = 127; layer.writeInt8(0, 20); layer[21] = 127; // macro 2 from 60 up
  const bank = { macros: new Map([[1, macro(11)], [2, macro(22)]]), curves: new Map(), keymaps: new Map([[0x4001, keymap]]), layers: new Map([[0x8001, layer]]) };
  assert.deepEqual(mx.voicesFor(bank, 0x8001, 70, 100, 1, 0.01).map(v => v.sample), [22]);
  assert.deepEqual(mx.voicesFor(bank, 0x8001, 40, 100, 1, 0.01).map(v => v.sample), [11]);
  assert.deepEqual(mx.voicesFor(bank, 0x4001, 60, 100, 1, 0.01).map(v => [v.sample, v.note]), [[22, 62]]);
  assert.deepEqual(mx.voicesFor(bank, 0x4001, 61, 100, 1, 0.01), []);   // nothing on that key
  assert.deepEqual(mx.voicesFor(bank, 0xffff, 60, 100, 1, 0.01), []);
});

// A tiny song and bank: one track, one note (middle C, a beat) of a looping sine, and optionally the loop entry the game's songs end with.
function tiny({ loop = false, pedal = false } = {}) {
  const d = Buffer.alloc(64);
  d.writeUInt32BE(16, 0);                                         // the pattern table: pattern 0 is at 16
  d.writeUInt16BE(0, 28); d[30] = 60; d[31] = 100; d.writeUInt16BE(384, 32);   // a note: at once, key 60, velocity 100, a beat long
  d.writeUInt16BE(0, 34); d[36] = 0xff; d[37] = 0xff;             // the end
  if (pedal) {   // the pedal goes down before the note and up at tick 768 (a second): events 4 bytes, at 28, then the note at 32, the pedal up at 38, the end at 42
    d.writeUInt16BE(0, 28); d[30] = 0xff; d[31] = 0x40;
    d.writeUInt16BE(0, 32); d[34] = 60; d[35] = 100; d.writeUInt16BE(384, 36);
    d.writeUInt16BE(768, 38); d[40] = 0x80; d[41] = 0x40;
    d.writeUInt16BE(0, 42); d[44] = 0xff; d[45] = 0xff;
  }
  const entries = [{ time: 0, program: 0xff, velocity: 0xff, pattern: 0, transpose: 0, velocityAdd: 0 }];
  if (loop) entries.push({ loop: true, time: 384, target: 0 });
  const song = { d, pTab: 0, initialBpm: 120, tempo: [], tracks: [{ midi: 0, entries }], loopPoint: 0 };
  const sine = Int16Array.from({ length: 320 }, (_, i) => Math.round(Math.sin(i / 320 * 2 * Math.PI * 4) * 20000));
  const bank = { macros: new Map([[1, Buffer.concat([startSample(7), waitForKeyOff(), keyOff(), waitMs(100), end()])]]), curves: new Map(), keymaps: new Map(), layers: new Map(),
    normal: { pages: [{ macro: 1 }], translate: Object.assign(new Array(128).fill(0xff), { 0: 0 }) }, drums: { pages: [], translate: new Array(128).fill(0xff) },
    samples: new Map(), pcm: new Map([[7, { pcm: sine, rate: 32000, rootKey: 60, loopStart: 0, loopEnd: 320 }]]) };
  return { song, bank };
}
const energy = (x, from, to) => { let s = 0; for (let i = from; i < to; i++) s += x[i] * x[i]; return s; };

test('a song renders its notes, in time, and falls silent after them', () => {
  const { song, bank } = tiny();
  const r = mx.render(bank, song, null, { seconds: 2, noReverb: true });
  assert.equal(r.notes, 1);
  assert.equal(r.voices, 1);
  assert.deepEqual(r.missing, []);
  assert.equal(r.loop, null);
  assert.ok(energy(r.left, 0, 16000) + energy(r.right, 0, 16000) > 10);     // the beat at 120 bpm is 0.5 s: 16000 samples
  assert.equal(energy(r.left, 40000, 64000) + energy(r.right, 40000, 64000), 0);
});

test('a song with a loop entry plays its looped part again, and says where the loop is', () => {
  const { song, bank } = tiny({ loop: true });
  const once = mx.render(bank, song, null, { seconds: 3, noReverb: true });
  assert.equal(once.notes, 1);
  assert.equal(once.loop, null);                     // no looping asked
  const twice = mx.render(bank, song, null, { seconds: 3, noReverb: true, loops: 2 });
  assert.equal(twice.notes, 3);
  assert.deepEqual(twice.loop, { start: 0.5, length: 0.5 });
  assert.ok(energy(twice.left, 24000, 40000) > 10);  // the note of the second pass, at 1 s
});

test('the reverb is silent until a sound reaches it, then rings and dies away', () => {
  const impulse = new Float32Array(32000 * 4); impulse[0] = 20000;
  const wet = mx.reverbSide(impulse, 1.0, 0.02, 0);
  assert.equal(energy(wet, 0, 639), 0);                                   // the pre-delay: 0.02 s
  const early = energy(wet, 1000, 16000), late = energy(wet, 96000, 112000);
  assert.ok(early > 0 && late > 0 && late < early / 10, `${early} ${late}`);
  assert.ok(mx.reverbSide(new Float32Array(1000), 1.0, 0.02, 1).every(v => v === 0));
  assert.equal(mx.REVERB_PRESETS.length, 12);
});

test('a WAV carries the samples as 16-bit stereo, limited softly', () => {
  const out = mx.wavStereo(Float32Array.of(0, 0.5, 10), Float32Array.of(0, -0.5, -10), 32000);
  assert.equal(out.toString('latin1', 0, 4), 'RIFF');
  assert.equal(out.readUInt16LE(22), 2);
  assert.equal(out.readUInt32LE(24), 32000);
  assert.equal(out.readInt16LE(44 + 4), Math.round(Math.tanh(0.5) * 32767));
  assert.ok(out.readInt16LE(44 + 8) > 32700 && out.readInt16LE(44 + 8) <= 32767);
  assert.equal(out.readInt16LE(46 + 8), -out.readInt16LE(44 + 8));
});

test('an envelope can come from the channel\'s controllers: attack 20, decay 22, sustain 23, release 24', () => {
  const ctrls = { 20: 10, 22: 20, 23: 64, 24: 30 };
  const bank = { macros: new Map([[1, Buffer.concat([step(0x16 | (20 << 8) | (22 << 16) | (23 << 24), 24), startSample(7), end()])]]), curves: new Map() };
  const voice = mx.runMacro(bank, 1, 60, 100, 1, { tickSeconds: 0.01, ctrl: n => ctrls[n] });
  assert.equal(voice.env.linear, false);
  assert.equal(voice.env.atk, mx.MIDI_TIME[10] / 1000);
  assert.equal(voice.env.dec, mx.MIDI_TIME[20] / 1000);
  assert.equal(voice.env.rel, mx.MIDI_TIME[30] / 1000);
  assert.equal(voice.env.sus, (64 / 128) ** 2);
});

test('a voice\'s volume starts at its velocity, and ScaleVolume, Envelope and FadeIn move it', () => {
  const velocity = 100, full = velocity / 127;
  const run = steps => mx.runMacro({ macros: new Map([[1, Buffer.concat([...steps, startSample(7), end()])]]), curves: new Map() }, 1, 60, velocity, 1, 0.01);
  assert.equal(run([]).volumeAt(0.5), full);
  assert.ok(Math.abs(run([step(0x0d | (64 << 8), 0x100)]).volumeAt(0) - full * 64 / 127) < 1e-9);   // ScaleVolume by 64/127 of the original (mode 1)
  const ramp = run([step(0x0f | (96 << 8), (120 << 16) | 0x100)]);                                    // Envelope: to 96/128, over 120 ms
  assert.equal(ramp.volumeAt(0), full);
  assert.ok(Math.abs(ramp.volumeAt(0.12) - full * 96 / 128) < 1e-9);
  assert.ok(Math.abs(ramp.volumeAt(0.06) - (full + full * 96 / 128) / 2) < 1e-9);
  const fade = run([step(0x14 | (127 << 8), (1 << 16) | 0x100)]);                                      // FadeIn: from silence, in a millisecond
  assert.equal(fade.volumeAt(0), 0);
  assert.ok(Math.abs(fade.volumeAt(0.01) - full * 127 / 128) < 1e-9);
});

test('a layer\'s volume scales the voice it starts', () => {
  const macro = Buffer.concat([startSample(11), end()]);
  const layer = Buffer.alloc(4 + 12, 0xff); layer.writeUInt32BE(1, 0);
  layer.writeUInt16BE(1, 4); layer[6] = 0; layer[7] = 127; layer.writeInt8(0, 8); layer[9] = 64;
  const bank = { macros: new Map([[1, macro]]), curves: new Map(), keymaps: new Map(), layers: new Map([[0x8001, layer]]) };
  const [voice] = mx.voicesFor(bank, 0x8001, 60, 100, 1, 0.01);
  assert.equal(voice.volumeAt(0), Math.floor(100 * 64 / 127) / 127);
});

test('a note that ends under the sustain pedal rings on until the pedal comes up', () => {
  const held = tiny({ pedal: true }), plain = tiny();
  const withPedal = mx.render(held.bank, held.song, null, { seconds: 2, noReverb: true });
  const without = mx.render(plain.bank, plain.song, null, { seconds: 2, noReverb: true });
  assert.equal(withPedal.notes, 1);
  assert.ok(energy(withPedal.left, 20000, 28000) + energy(withPedal.right, 20000, 28000) > 10);   // at 0.6 to 0.9 s: the pedal is still down
  assert.equal(energy(without.left, 20000, 28000) + energy(without.right, 20000, 28000), 0);       // with none, the note is long over
  assert.equal(energy(withPedal.left, 40000, 64000) + energy(withPedal.right, 40000, 64000), 0);   // and it stops after the pedal
});

test('a song\'s length is its last note\'s end, or its loop\'s, and the loop is the part that repeats', () => {
  const plain = tiny();
  assert.deepEqual(mx.songSeconds(plain.song), { seconds: 0.5, region: null });
  const looped = tiny({ loop: true });
  assert.deepEqual(mx.songSeconds(looped.song), { seconds: 0.5, region: { start: 0, end: 0.5 } });
  const render = mx.render(looped.bank, looped.song, null, { seconds: 2, noReverb: true });
  assert.deepEqual(render.region, { start: 0, end: 0.5 });   // a render says it even when it plays the loop once
  assert.equal(render.loop, null);
});

test('the limiter leaves a quiet render exactly as it is, and keeps a loud burst under its ceiling without disturbing what is far from it', () => {
  const quiet = Float32Array.from({ length: 4000 }, (_, i) => 0.5 * Math.sin(i / 7)), copy = Float32Array.from(quiet);
  mx.limit(quiet, Float32Array.from(quiet));
  assert.deepEqual(quiet, copy);                                     // nothing over the ceiling: nothing changes

  const n = 96000, left = new Float32Array(n), right = new Float32Array(n);
  for (let i = 0; i < n; i++) { left[i] = right[i] = 0.5 * Math.sin(i / 9); }
  for (let i = 40000; i < 40400; i++) left[i] = 3 * Math.sin(i / 9);   // a burst at three times full scale
  const before = Float32Array.from(left);
  mx.limit(left, right, 0.9);
  let peak = 0; for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(left[i]));
  assert.ok(peak <= 0.9 + 1e-6, `peak ${peak}`);
  for (const i of [1000, 20000, 39000]) assert.equal(left[i], before[i]);   // well before the burst: untouched
  assert.ok(left[39900] !== before[39900]);                           // the gain is already down just ahead of it
  assert.ok(Math.abs(left[90000] - before[90000]) < 0.01 * 0.5 + 1e-9 || Math.abs(left[90000]) > 0.9 * Math.abs(before[90000]));   // and back up well after
});
