'use strict';
// The game's songs, played from the disc without the game: MusyX sequenced music, rendered by the launcher.
//
// A song (a file of bgm_archive.fsys) is tracks of note patterns on MIDI channels, with a tempo track. A channel's
// program picks an instrument by id (a macro, a keymap or a layer of the music project); a macro is a short script
// that starts a sample, sets its envelope and waits for the note to end. This follows MusyX 2.0's sequencer (seq.c)
// and macro interpreter (synthmacros.c) in the open reconstruction at github.com/AxioDL/musyx, for the commands the
// game's music uses: envelopes (also from channel controllers), volume programs, pitch bend, vibrato, the sustain pedal,
// volume, pan and expression automation, song loops, and the game's reverb. What it leaves out: chorus, the filter,
// portamento, key groups and voice stealing.
const fsys = require('./fsys');
const { decodeAdpcm } = require('./pokemon-cries');

const RATE = 32000;               // the game's own output rate
const DEFAULT_GAIN = 0.95;        // what the game's output measures at, against this mix of the same songs
const TICKS_PER_BEAT = 384;
// A MIDI value, 0 to 127, as a time in milliseconds (midi2TimeTab, synthmacros.c): what SetADSRFromCtrl turns controllers into.
const MIDI_TIME = [
  0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110,
  110, 120, 130, 140, 150, 160, 170, 190, 200, 220, 230, 250,
  270, 290, 310, 330, 350, 380, 410, 440, 470, 500, 540, 580,
  620, 660, 710, 760, 820, 880, 940, 1000, 1000, 1100, 1200, 1300,
  1400, 1500, 1600, 1700, 1800, 2000, 2100, 2300, 2400, 2600, 2800, 3000,
  3200, 3500, 3700, 4000, 4300, 4600, 4900, 5300, 5700, 6100, 6500, 7000,
  7500, 8100, 8600, 9300, 9900, 10000, 11000, 12000, 13000, 14000, 15000, 16000,
  17000, 18000, 19000, 21000, 22000, 24000, 26000, 28000, 30000, 32000, 34000, 37000,
  39000, 42000, 45000, 49000, 50000, 55000, 60000, 65000, 70000, 75000, 80000, 85000,
  90000, 95000, 100000, 105000, 110000, 115000, 120000, 125000, 130000, 135000, 140000, 145000,
  150000, 155000, 160000, 165000, 170000, 175000, 180000, 0
];
const FRAME = 8, PER_FRAME = 14;  // DSP-ADPCM
const STEP = 8;                   // a macro step: two words
const END = 0xffffffff;
const OP = { end: 0x00, stop: 0x01, waitMs: 0x07, wait: 0x04, setAdsr: 0x0c, scaleVolume: 0x0d, setPanning: 0x0e, envelope: 0x0f,
  startSample: 0x10, stopSample: 0x11, keyOff: 0x12, fadeIn: 0x14, addKey: 0x18, setKey: 0x19, vibrato: 0x1c, adsrFromCtrl: 0x16 };

// --- The project: what a group of the music project lists, and what its pool holds ---------------------------------

// A pool's objects: records of { next, id, ..., data } from an offset to a next of 0xFFFFFFFF.
function poolChain(pool, start) {
  const objects = new Map();
  for (let at = start; start && at + 8 <= pool.length;) {
    const next = pool.readUInt32BE(at);
    if (next === END) break;
    objects.set(pool.readUInt16BE(at + 4), pool.subarray(at + 8, next ? at + next : pool.length));
    if (!next) break;
    at += next;
  }
  return objects;
}

// The sample directory: 0x20-byte rows to an id of 0xFFFF. info: root key and rate; length: format and count.
function sampleRows(sdir) {
  const samples = new Map();
  for (let at = 0; at + 0x20 <= sdir.length && sdir.readUInt16BE(at) !== 0xffff; at += 0x20) {
    const info = sdir.readUInt32BE(at + 12), length = sdir.readUInt32BE(at + 16), extra = sdir.readUInt32BE(at + 28);
    samples.set(sdir.readUInt16BE(at), { offset: sdir.readUInt32BE(at + 4), rootKey: info >>> 24, rate: info & 0xffffff,
      format: length >>> 24, count: length & 0xffffff, loopStart: sdir.readUInt32BE(at + 20), loopLength: sdir.readUInt32BE(at + 24),
      coefficients: extra && extra + 0x28 <= sdir.length ? Array.from({ length: 16 }, (_, i) => sdir.readInt16BE(extra + 8 + i * 2)) : null });
  }
  return samples;
}

// A project's group: its page tables and MIDI setups (GROUP_DATA, synthdata.h).
function readGroup(proj, id) {
  for (let at = 0; at + 0x28 <= proj.length;) {
    const next = proj.readUInt32BE(at);
    if (next === END) break;
    if (proj.readUInt16BE(at + 4) === id) {
      return { type: proj.readUInt16BE(at + 6), normpage: proj.readUInt32BE(at + 28), drumpage: proj.readUInt32BE(at + 32), midiSetup: proj.readUInt32BE(at + 36) };
    }
    if (!next) break;
    at += next;
  }
  return null;
}

// A page table's program -> row (BuildTransTab): a row of 6 bytes, each for the program in its index byte, to index 0xFF.
function pageTable(proj, offset) {
  const pages = [], translate = new Array(128).fill(0xff);
  for (let at = offset, i = 0; at + 6 <= proj.length && proj[at + 4] !== 0xff; at += 6, i++) {
    pages.push({ macro: proj.readUInt16BE(at), priority: proj[at + 2], maxVoices: proj[at + 3], index: proj[at + 4] });
    translate[proj[at + 4] & 0x7f] = i;
  }
  return { pages, translate };
}

// A song's MIDI setup: 0x54-byte rows (a song id, then each channel's program, volume, pan, reverb and chorus) to 0xFFFF.
function midiSetupFor(proj, offset, songId) {
  for (let at = offset; at + 0x54 <= proj.length && proj.readUInt16BE(at) !== 0xffff; at += 0x54) {
    if (proj.readUInt16BE(at) !== songId) continue;
    return Array.from({ length: 16 }, (_, c) => ({ program: proj[at + 4 + c * 5], volume: proj[at + 5 + c * 5], pan: proj[at + 6 + c * 5], reverb: proj[at + 7 + c * 5] }));
  }
  return null;
}

function loadBank(disc, base, sampleFile, groupId = 0) {
  const entries = new Map(fsys.entries(disc.file('common.fsys')).map(entry => [entry.name, entry]));
  const part = name => { const entry = entries.get(name); if (!entry) throw new Error(`The game disc has no ${name}.`); return Buffer.from(entry.data()); };
  const proj = part(`${base}_proj`), pool = part(`${base}_pool`), sdir = part(`${base}_sdir`);
  const group = readGroup(proj, groupId);
  if (!group) throw new Error('The game disc has no music group.');
  const pools = [0, 4, 8, 12].map(o => pool.readUInt32BE(o));
  return { proj, group, samples: sampleRows(sdir), samp: disc.file(sampleFile), pcm: new Map(),
    macros: poolChain(pool, pools[0]), curves: poolChain(pool, pools[1]), keymaps: poolChain(pool, pools[2]), layers: poolChain(pool, pools[3]),
    normal: pageTable(proj, group.normpage), drums: pageTable(proj, group.drumpage) };
}

// A sample, decoded: { pcm: Int16Array, rate, rootKey, loopStart, loopEnd (or -1) }, or null.
function samplePcm(bank, id) {
  if (bank.pcm.has(id)) return bank.pcm.get(id);
  const row = bank.samples.get(id);
  let result = null;
  if (row && row.count > 0) {
    if (row.format === 0 && row.coefficients) {
      const bytes = Math.ceil(row.count / PER_FRAME) * FRAME;
      result = { pcm: decodeAdpcm(bank.samp.subarray(row.offset, row.offset + bytes), row.count, row.coefficients) };
    } else if (row.format === 2 || row.format === 3) {
      const wide = row.format === 2, pcm = new Int16Array(row.count);
      for (let i = 0; i < row.count; i++) pcm[i] = wide ? bank.samp.readInt16BE(row.offset + i * 2) : bank.samp.readInt8(row.offset + i) << 8;
      result = { pcm };
    }
    if (result) Object.assign(result, { rate: row.rate, rootKey: row.rootKey, loopStart: row.loopLength > 1 ? row.loopStart : -1, loopEnd: row.loopLength > 1 ? Math.min(row.count, row.loopStart + row.loopLength) : -1 });
  }
  bank.pcm.set(id, result);
  return result;
}

// --- The song --------------------------------------------------------------------------------------------------------

// ARR (seq.h): offsets of the track table, pattern table, channel table, tempo track, and the song's tempo.
function readSong(d) {
  const u32 = o => d.readUInt32BE(o);
  const tTab = u32(0), pTab = u32(4), tmTab = u32(8), mTrack = u32(12), info = u32(16);
  const bpmOf = raw => (info & 0x40000000 ? raw >>> 10 : raw);
  const tempo = [];
  if (mTrack) for (let at = mTrack; at + 8 <= d.length && u32(at) !== END; at += 8) tempo.push({ tick: u32(at), bpm: bpmOf(u32(at + 4)) });
  const tracks = [];
  for (let t = 0; t < 64; t++) {
    const offset = u32(tTab + t * 4);
    if (!offset) { tracks.push(null); continue; }
    const entries = [];
    for (let at = offset; at + 12 <= d.length; at += 12) {
      const pattern = d.readUInt16BE(at + 8);
      if (pattern === 0xffff) break;
      if (pattern === 0xfffe) { entries.push({ loop: true, time: u32(at), target: d.readUInt16BE(at + 10) }); break; }
      entries.push({ time: u32(at), program: d[at + 4], velocity: d[at + 5], pattern, transpose: d.readInt8(at + 10), velocityAdd: d.readInt8(at + 11) });
    }
    tracks.push({ midi: d[tmTab + t], entries });
  }
  return { d, initialBpm: bpmOf(info & 0x0fffffff), tempo, tracks, pTab, loopPoint: u32(20) };
}

// A pattern's events: notes (key, velocity, length) and controller changes, times in ticks from its start.
function readPattern(song, index) {
  const d = song.d, at = d.readUInt32BE(song.pTab + index * 4);
  const events = [];
  let time = 0;
  for (let o = at + 12; o + 4 <= d.length;) {
    const delta = d.readUInt16BE(o), key = d[o + 2], velocity = d[o + 3];
    if (key === 0xff && velocity === 0xff) break;
    if (key & 0x80) { time += delta; events.push({ time, control: velocity & 0x7f, value: key & 0x7f, flag: velocity }); o += 4; continue; }
    if ((key | velocity) === 0) { o += 4; continue; }
    time += delta;
    events.push({ time, key, velocity, length: d.readUInt16BE(o + 4) });
    o += 6;
  }
  return events;
}

// A pattern's pitch bend or modulation stream: pairs of a time step and a value step (GetStreamValue in seq.c), as
// [{ time (ticks from the pattern's start), value }]. The value starts at `initial`; an entry of 0x80 0x00 ends it.
function readStream(song, offset, initial) {
  const out = [], d = song.d;
  if (!offset) return out;
  let at = offset, time = 0, value = initial;
  while (at + 2 <= d.length) {
    let b1 = d[at], b2 = d[at + 1];
    if (b1 === 0x80 && b2 === 0) break;
    let delta;
    if (b1 & 0x80) { delta = ((b1 & 0x7f) << 8) | b2; at += 2; } else { delta = b1; at += 1; }
    b1 = d[at]; b2 = d[at + 1];
    let step;
    if (b1 & 0x80) { step = ((b1 & 0x7f) << 8) | b2; step |= (step & 0x4000) << 1; step = step << 16 >> 16; at += 2; } else { step = (b1 | ((b1 & 0x40) << 1)) << 24 >> 24; at += 1; }
    time += delta; value += step;
    out.push({ time, value });
  }
  return out;
}
function readPatternStreams(song, index) {
  const at = song.d.readUInt32BE(song.pTab + index * 4);
  return { bend: readStream(song, song.d.readUInt32BE(at + 4), 0x2000), modulation: readStream(song, song.d.readUInt32BE(at + 8), 0) };
}

// The value of a [{ time (seconds), value }] list at a time (the last at or before it), by a moving index.
function valueAt(list, time, initial, cursor) {
  let i = cursor.i;
  while (i < list.length && list[i].time <= time) i++;
  cursor.i = i;
  return i ? list[i - 1].value : initial;
}

// The seconds a tick is at, over the tempo track (384 ticks to a beat).
function tickClock(song) {
  const points = [{ tick: 0, seconds: 0, bpm: song.initialBpm }];
  for (const change of song.tempo) {
    const last = points[points.length - 1];
    if (change.tick === last.tick) { last.bpm = change.bpm; continue; }
    points.push({ tick: change.tick, seconds: last.seconds + (change.tick - last.tick) * 60 / (TICKS_PER_BEAT * last.bpm), bpm: change.bpm });
  }
  return tick => {
    let p = points[0];
    for (const q of points) { if (q.tick <= tick) p = q; else break; }
    return p.seconds + (tick - p.tick) * 60 / (TICKS_PER_BEAT * p.bpm);
  };
}

// --- Instruments ---------------------------------------------------------------------------------------------------------

// The game's volume curve (hw_volconv.c musyx_vol_tab): a voice's volume, 0 to 1, to the gain it plays at.
const VOLUME_CURVE = [
  0.0, 3.052e-05, 0.00015259, 0.00039674, 0.00070193, 0.00112918, 0.001648, 0.00222785,
  0.00292978, 0.00372326, 0.00460829, 0.00558489, 0.00665304, 0.00784326, 0.00912503, 0.0104984,
  0.0119633, 0.0135502, 0.0151982, 0.0169988, 0.0188604, 0.0208441, 0.0229194, 0.0251167,
  0.0274056, 0.0298166, 0.0323191, 0.0349437, 0.0376598, 0.0404675, 0.0434278, 0.0464797,
  0.0496231, 0.0528886, 0.0562761, 0.0597858, 0.0633869, 0.0671102, 0.0709555, 0.0749229,
  0.0789819, 0.0831629, 0.087466, 0.0919218, 0.096469, 0.101138, 0.10593, 0.110843,
  0.115879, 0.121036, 0.12634701, 0.13174801, 0.13730299, 0.142979, 0.14877801, 0.15472899,
  0.160772, 0.166997, 0.173315, 0.179785, 0.186407, 0.193121, 0.200018, 0.20700701,
  0.21417899, 0.22147299, 0.228919, 0.236488, 0.24420901, 0.252083, 0.260079, 0.26825801,
  0.276559, 0.28501201, 0.29364899, 0.30240801, 0.31131899, 0.32038301, 0.32960001, 0.33899999,
  0.34852099, 0.358226, 0.36808401, 0.37809399, 0.38828701, 0.398633, 0.40913099, 0.41981301,
  0.43064699, 0.44166401, 0.45286399, 0.46421701, 0.47575301, 0.48744199, 0.499313, 0.51139897,
  0.523606, 0.53602701, 0.54863101, 0.56141901, 0.57438898, 0.587542, 0.60087901, 0.61439902,
  0.62813199, 0.64201802, 0.65614802, 0.67043102, 0.68492699, 0.699637, 0.71452999, 0.72963703,
  0.74492598, 0.76042998, 0.77614701, 0.792077, 0.808191, 0.82454902, 0.84109002, 0.85784501,
  0.87484401, 0.89205599, 0.90945202, 0.927122, 0.94500601, 0.96307302, 0.98141402, 1.0,
  1.0
];
function volumeGain(volume) {
  const position = Math.max(0, Math.min(1, volume)) * 127, i = Math.floor(position), f = position - i;
  return (1 - f) * VOLUME_CURVE[i] + f * VOLUME_CURVE[i + 1];
}
// Panning, 0 (left) to 127 (right), as the game's pan_tab spreads it: [0, 0.7079, 1, 1] over the pan's two halves.
function panGains(pan) {
  const tab = [0, 0.7079, 1, 1], at = x => { const i = Math.min(2, Math.floor(x)), f = x - i; return (1 - f) * tab[i] + f * tab[i + 1]; };
  const p = Math.max(0, Math.min(127, pan)) / 127;
  return { left: at(2 * (1 - p)), right: at(2 * p) };
}
const attenuation = index => Math.pow(10, -index / 40);   // 0.5 dB to the index; the game's dspAttenuationTab
const attenuationIndex = gain => Math.min(193, Math.max(0, Math.round(-40 * Math.log10(Math.max(gain, 1e-6)))));
const dlsVolume = index => (index / 128) ** 2;             // dspDLSVolTab

// A curve's envelope: { atk, dec, sus (gain), rel } in seconds, as MusyX's mcmdSetADSR reads it (the data is little-endian).
function envelopeOf(curve, dls, velocity, key) {
  if (!curve) return null;
  if (!dls) {
    return { linear: true, atk: curve.readUInt16LE(0) / 1000, dec: curve.readUInt16LE(2) / 1000, sus: Math.min(0x7fff, curve.readUInt16LE(4) << 3) / 0x7fff, rel: curve.readUInt16LE(6) / 1000 };   // hwSetADSR: the sustain is 12 bits, shifted up 3
  }
  const seconds = tc => Math.pow(2, tc / 65536 / 1200);
  let atk = curve.readInt32LE(0), dec = curve.readInt32LE(4);
  const slevel = curve.readUInt16LE(8), rel = curve.readUInt16LE(10), ascale = curve.readInt32LE(12), dscale = curve.readInt32LE(16);
  if (ascale !== -0x80000000) atk += Math.trunc(velocity * ascale / 128);
  if (dscale !== -0x80000000) dec += Math.trunc(key * dscale / 128);
  return { linear: false, atk: seconds(atk), dec: seconds(dec), sus: dlsVolume(Math.min(128, slevel >> 5)), rel: rel / 1000 };
}

// An envelope's gain at a time since the note began, with the note ending at releaseAt (seconds); null once it has died away.
function gainAt(env, t, releaseAt) {
  if (!env) return t < releaseAt ? 1 : (t - releaseAt < 0.05 ? 1 - (t - releaseAt) / 0.05 : null);
  const level = time => {
    if (time < env.atk) return env.atk > 0 ? time / env.atk : 1;
    const since = time - env.atk;
    if (env.linear) return since < env.dec ? 1 - (1 - env.sus) * (since / (env.dec || 1)) : env.sus;
    const target = attenuationIndex(env.sus), span = env.dec * (target / 193);
    return span > 0 && since < span ? attenuation(target * since / span) : env.sus > 0 ? attenuation(target) : 0;
  };
  if (t < releaseAt) return level(t);
  const from = level(releaseAt), since = t - releaseAt;
  if (env.rel <= 0) return null;
  if (env.linear) { const v = from * (1 - since / env.rel); return v > 0 ? v : null; }
  const fromIndex = attenuationIndex(from), duration = env.rel * ((193 - fromIndex) / 193);
  return since < duration ? attenuation(fromIndex + (193 - fromIndex) * since / duration) : null;
}

// The notes a macro makes of a key and velocity at some time: a list of voices { sample, note, ... }. A macro is run to
// find the sample it starts, its envelope and key changes, and when it releases (a KeyOff, or the note ending).
// context: { tickSeconds: how long a tick lasts, ctrl(n): the 7-bit value of the channel's controller n now }, or just tickSeconds.
function runMacro(bank, id, key, velocity, noteLength, context = 0.01) {
  const steps = bank.macros.get(id);
  if (!steps) return null;
  const ctx = typeof context === 'number' ? { tickSeconds: context } : context || {};
  const tickSeconds = ctx.tickSeconds ?? 0.01, ctrl = ctx.ctrl || (() => 0);
  // The voice's volume, as a fraction of full, over the macro's time: it starts at the velocity, and ScaleVolume steps it and
  // Envelope and FadeIn ramp it. TranslateVolume's curve (a table of 128 bytes in the pool) reshapes a target.
  const volume0 = velocity / 127, ramps = [];
  const volumeAt = t => {
    let v = volume0;
    for (const r of ramps) { if (t < r.t0) break; v = t >= r.t1 ? r.v1 : r.v0 + (r.v1 - r.v0) * (t - r.t0) / (r.t1 - r.t0); }
    return v;
  };
  const translate = (v, curveId) => {
    const table = curveId === 0xffff ? null : bank.curves.get(curveId);
    if (!table || table.length < 128) return v;
    const at = Math.max(0, Math.min(127, v * 127)), i = Math.floor(at);
    return (i < 127 ? table[i] + (table[i + 1] - table[i]) * (at - i) : table[127]) / 127;
  };
  const voice = { sample: null, note: key, detune: 0, env: null, startAt: 0, releaseAt: null, volume: 1, vibrato: null, volumeAt };
  let time = 0;
  for (let at = 0; at + STEP <= steps.length; at += STEP) {
    const a = steps.readUInt32BE(at), b = steps.readUInt32BE(at + 4), op = a & 0x7f;
    if (op === OP.end || op === OP.stop) break;
    if (op === OP.startSample) { voice.sample = (a >>> 8) & 0xffff; voice.startAt = time; }
    else if (op === OP.setAdsr) voice.env = envelopeOf(bank.curves.get((a >>> 8) & 0xffff), (a >>> 24) !== 0, velocity, key);
    else if (op === OP.adsrFromCtrl) {   // an envelope from the channel's controllers: attack 20, decay 22, sustain 23, release 24 in the game's data
      voice.env = { linear: false, atk: MIDI_TIME[ctrl((a >>> 8) & 0xff) & 127] / 1000, dec: MIDI_TIME[ctrl((a >>> 16) & 0xff) & 127] / 1000, sus: dlsVolume(Math.min(128, ctrl(a >>> 24))), rel: MIDI_TIME[ctrl(b & 0xff) & 127] / 1000 };
    }
    else if (op === OP.scaleVolume) {
      const scale = (a >>> 8) & 0xff, add = (a >>> 16) & 0xff, fromStart = ((b >>> 8) & 0xff) !== 0;
      const v = translate(Math.min(1, (fromStart ? volume0 : volumeAt(time)) * scale / 127 + add / 127), (a >>> 24) | ((b & 0xff) << 8));
      ramps.push({ t0: time, t1: time, v0: v, v1: v });
    }
    else if (op === OP.envelope || op === OP.fadeIn) {
      const scale = (a >>> 8) & 0xff, add = (a >>> 16) & 0xff, ticks = b >>> 16, seconds = ((b >>> 8) & 1) ? ticks / 1000 : ticks * tickSeconds;
      const target = translate(Math.min(1, volumeAt(time) * scale / 128 + add / 127), (a >>> 24) | ((b & 0xff) << 8));
      ramps.push({ t0: time, t1: time + Math.max(seconds, 0.001), v0: op === OP.fadeIn ? 0 : volumeAt(time), v1: target });
    }
    else if (op === OP.keyOff || op === OP.stopSample) { if (voice.releaseAt === null) voice.releaseAt = time; }
    else if (op === OP.setKey) { voice.note = (a >>> 8) & 0x7f; voice.detune = (a << 8 >> 24); }
    else if (op === OP.addKey) { voice.note = Math.max(0, Math.min(127, ((a >>> 24) === 0 ? voice.note : key) + (a << 16 >> 24))); voice.detune = (a << 8 >> 24); }
    else if (op === OP.vibrato) {
      // mcmdVibrato: a range of keys and cents, a period (milliseconds or ticks), and a flag that the modulation wheel scales it
      const kr = a << 16 >> 24, cr = a << 8 >> 24, ticks = b >>> 16, period = ((b >>> 8) & 1) ? ticks / 1000 : ticks * tickSeconds;
      if (ticks) {
        let keys = kr, cents = cr, phase = 0;
        if (kr < 0) { keys = -kr; cents = Math.abs(cr); phase = period / 2; }
        else if (cr < 0) { if (kr === 0) { cents = -cr; phase = period / 2; } else { keys = kr - 1; cents = 100 - cr; } }
        voice.vibrato = { semitones: keys + cents / 100, period, phase, modulated: ((a >>> 24) & 3) !== 0, startAt: time };
      } else voice.vibrato = null;
    }
    else if (op === OP.waitMs || op === OP.wait) {
      const ms = b >>> 16, untilKeyOff = (a >>> 8) & 1;
      if (untilKeyOff && voice.releaseAt === null) time = Math.max(time, ms === 0xffff ? noteLength : Math.min(time + ms / 1000, noteLength));
      else if (ms && ms !== 0xffff) time += ms / 1000;
    }
  }
  if (voice.releaseAt === null) voice.releaseAt = Math.max(time, noteLength);
  return voice;
}

// The voices a program makes of a note: a macro, or a keymap's or layer's entries for the key (ids' top bits say which).
function voicesFor(bank, id, key, velocity, length, context, depth = 0) {
  if (id === 0xffff || depth > 4) return [];
  switch (id & 0xc000) {
    case 0: { const v = runMacro(bank, id, key, velocity, length, context); return v && v.sample !== null ? [v] : []; }
    case 0x4000: {
      const map = bank.keymaps.get(id);
      if (!map || key * 8 + 8 > map.length) return [];
      const entry = { id: map.readUInt16BE(key * 8), transpose: map.readInt8(key * 8 + 2) };
      return voicesFor(bank, entry.id, Math.max(0, Math.min(127, key + entry.transpose)), velocity, length, context, depth + 1);
    }
    case 0x8000: {
      const layer = bank.layers.get(id);
      if (!layer || layer.length < 4) return [];
      const count = layer.readUInt32BE(0), out = [];
      for (let i = 0; i < count && 4 + i * 12 + 12 <= layer.length; i++) {
        const at = 4 + i * 12, entry = { id: layer.readUInt16BE(at), low: layer[at + 2], high: layer[at + 3], transpose: layer.readInt8(at + 4), volume: layer[at + 5] };
        if (entry.id === 0xffff || key < entry.low || key > entry.high) continue;
        const sub = voicesFor(bank, entry.id, Math.max(0, Math.min(127, key + entry.transpose)), Math.floor(velocity * entry.volume / 127), length, context, depth + 1);
        out.push(...sub);
      }
      return out;
    }
  }
  return [];
}

// --- Reverb ---------------------------------------------------------------------------------------------------------------
// The game's reverb (MusyX's StdReverb, reverb.c): per side, three feedback delays in parallel (their feedback set so the
// tail falls 60 dB in `time`), two short delays, a dark low-pass and a third short delay. The game has 12 settings
// (the table in common_rel, 0x1437F8: coloration 0, mix 1, damping 0 in all of them); a song names one in its sound row.
const REVERB_PRESETS = [[1.8, 0.02], [1.8, 0.02], [2.0, 0.02], [1.6, 0.06], [1.6, 0.1], [3.0, 0.1], [1.2, 0.04], [1.8, 0.06], [2.0, 0.1], [2.5, 0.04], [2.0, 0.04], [1.0, 0.1]];

function delayLine(length) {   // DLcreate / DLsetdelay: what is read is what was written `length` writes before
  const size = length + 2;
  return { buf: new Float32Array(size), size, inAt: 0, outAt: ((size - length) % size + size) % size, last: 0 };
}
const write = (d, v) => { d.buf[d.inAt] = v; if (++d.inAt >= d.size) d.inAt = 0; };
const read = d => { const v = d.buf[d.outAt]; if (++d.outAt >= d.size) d.outAt = 0; d.last = v; return v; };

// Reverb of one side's aux sends (Float32Array), the wet signal to add back. `side` 0 is left and 1 is right (they differ in one delay).
function reverbSide(input, time, preDelay, side) {
  const lens = [1789, 1999, 2333, 433, 149, 47, 73, 67], coloration = 0, damping = 1 - (0.05 * 0.8 + 0.05), level = 1;
  const combs = [0, 1, 2].map(i => ({ line: delayLine(lens[i]), coef: Math.pow(10, (lens[i] * -3) / (32000 * time)) }));
  const ap0 = delayLine(lens[3]), ap1 = delayLine(lens[4]), ap2 = delayLine(lens[side + 5]);
  const wet = level * 0.6, pre = Math.round(preDelay * 32000), preLine = new Float32Array(Math.max(1, pre));
  let prePos = 0, low = 0;
  const out = new Float32Array(input.length);
  for (let n = 0; n < input.length; n++) {
    const sample = input[n];
    let delayed = sample;
    if (pre) { delayed = preLine[prePos]; preLine[prePos] = sample; if (++prePos >= pre) prePos = 0; }
    let sum = 0;
    for (const c of combs) { write(c.line, c.coef * c.line.last + delayed); sum += read(c.line); }
    let last = ap0.last, inValue = coloration * last + sum;
    write(ap0, inValue); let x = last - coloration * inValue; read(ap0);
    last = ap1.last; inValue = coloration * last + x;
    write(ap1, inValue); x = last - coloration * inValue; read(ap1);
    x *= 0.3;
    low = damping * low + x;
    last = ap2.last; inValue = coloration * last + low;
    write(ap2, inValue); const allPass = last - coloration * inValue; read(ap2);
    out[n] = wet * allPass;
  }
  return out;
}

// --- The render ------------------------------------------------------------------------------------------------------------

// A song rendered to stereo floats at 32 kHz: { left, right, rate }. options: seconds (the most to render).
function render(bank, song, midiSetup, options = {}) {
  const seconds = options.seconds || 60, clock = tickClock(song);
  const channels = Array.from({ length: 16 }, (_, c) => ({ program: midiSetup?.[c]?.program ?? 0, volume: midiSetup?.[c]?.volume ?? 100, pan: midiSetup?.[c]?.pan ?? 64, expression: 127, reverb: midiSetup?.[c]?.reverb ?? 0, ctrls: {} }));
  const pedals = Array.from({ length: 16 }, () => []);   // each channel's sustain pedal: [{ time, down }]
  const bends = Array.from({ length: 16 }, () => []), mods = Array.from({ length: 16 }, () => []);
  // volume, expression and pan follow their controllers while a note sounds: each channel's changes, by seconds
  const levels = Array.from({ length: 16 }, () => ({ volume: [], expression: [], pan: [], reverb: [] }));
  const auxLeft = new Float32Array(Math.floor((options.seconds || 60) * RATE) + RATE), auxRight = new Float32Array(auxLeft.length);
  // When a song loops: every track ends in an entry that sends it back to an earlier entry, and once the last has,
  // the clock goes back to the song's loop point. loops: how many times to play the looped part after the first time.
  const loopEnds = song.tracks.filter(t => t && t.midi !== 0xff && t.entries.some(e => e.loop)).map(t => t.entries.find(e => e.loop).time);
  const loopEnd = loopEnds.length ? Math.max(...loopEnds) : null, loopStartTick = song.loopPoint;
  const loops = loopEnd !== null && loopEnd > loopStartTick ? (options.loops ?? 0) : 0;
  const loopSeconds = loops ? clock(loopEnd) - clock(loopStartTick) : 0;
  const secondsAt = (tick, pass) => pass === 0 ? clock(tick) : clock(loopEnd) + (pass - 1) * loopSeconds + clock(tick) - clock(loopStartTick);
  // gather every event in time order: program changes and controllers, then notes
  const timeline = [];
  for (const track of song.tracks) {
    if (!track || track.midi === 0xff) continue;
    const midi = track.midi, loopEntry = track.entries.find(e => e.loop);
    for (let pass = 0; pass <= (loopEntry ? loops : 0); pass++) {
      const first = pass === 0 ? 0 : loopEntry.target;
      for (let i = first; i < track.entries.length; i++) {
        const entry = track.entries[i];
        if (entry.loop) break;
        const base = entry.time, at = tick => secondsAt(tick, pass);
        if (entry.program !== 0xff) timeline.push({ tick: base, time: at(base), order: 0, midi, set: { program: entry.program } });
        if (entry.velocity !== 0xff) timeline.push({ tick: base, time: at(base), order: 0, midi, set: { volume: entry.velocity } });
        const streams = readPatternStreams(song, entry.pattern);
        for (const point of streams.bend) bends[midi & 15].push({ time: at(base + point.time), value: point.value });
        for (const point of streams.modulation) mods[midi & 15].push({ time: at(base + point.time), value: point.value });
        for (const ev of readPattern(song, entry.pattern)) {
          const tick = base + ev.time, time = at(tick);
          if (ev.control !== undefined) {
            if (ev.flag === 0) timeline.push({ tick, time, order: 0, midi, set: { program: ev.value } });
            else if (ev.control === 7) timeline.push({ tick, time, order: 0, midi, set: { volume: ev.value } });
            else if (ev.control === 10) timeline.push({ tick, time, order: 0, midi, set: { pan: ev.value } });
            else if (ev.control === 11) timeline.push({ tick, time, order: 0, midi, set: { expression: ev.value } });
            else if (ev.control === 91) timeline.push({ tick, time, order: 0, midi, set: { reverb: ev.value } });
            else if (ev.control === 20 || ev.control === 22 || ev.control === 23 || ev.control === 24) timeline.push({ tick, time, order: 0, midi, set: { ctrl: [ev.control, ev.value] } });
            else if (ev.control === 64) pedals[midi & 15].push({ time, down: ev.value >= 64 });
          } else {
            timeline.push({ tick, time, order: 1, midi, note: { key: Math.max(0, Math.min(127, ev.key + entry.transpose)), velocity: Math.max(0, Math.min(127, ev.velocity + entry.velocityAdd)), length: ev.length } });
          }
        }
      }
    }
  }
  timeline.sort((a, b) => a.time - b.time || a.order - b.order);
  for (const list of [...bends, ...mods, ...pedals]) list.sort((x, y) => x.time - y.time);
  for (const ev of timeline) {   // all of a channel's level changes first, so a note sounding over one follows it
    if (ev.set) for (const name of ['volume', 'expression', 'pan', 'reverb']) if (name in ev.set) levels[ev.midi & 15][name].push({ time: ev.time, value: ev.set[name] });
  }
  const total = Math.floor(seconds * RATE) + RATE, left = new Float32Array(total), right = new Float32Array(total);
  let notes = 0, voices = 0, missing = new Set();
  for (const ev of timeline) {
    const channel = channels[ev.midi & 15], isDrums = (ev.midi & 15) === 9;
    if (options.only && !ev.set && !options.only.includes(ev.midi & 15)) continue;   // a debugging aid: play only these channels
    if (ev.set) { if (ev.set.ctrl) channel.ctrls[ev.set.ctrl[0]] = ev.set.ctrl[1]; else Object.assign(channel, ev.set); continue; }
    const start = ev.time;
    if (start >= seconds) continue;
    let length = clock(ev.tick + ev.note.length) - clock(ev.tick);
    // a note ending under the sustain pedal rings on until the pedal comes up
    const pedal = pedals[ev.midi & 15];
    if (pedal.length) {
      const endAt = start + length;
      let down = false, release = null;
      for (const p of pedal) { if (p.time <= endAt) down = p.down; else if (down && !p.down) { release = p.time; break; } }
      if (down && release !== null) length = release - start;
    }
    const page = isDrums ? bank.drums : bank.normal, row = page.translate[channel.program & 0x7f];
    if (row === 0xff || !page.pages[row]) { missing.add(`program ${channel.program}`); continue; }
    notes++;
    const tickSeconds = (clock(ev.tick + TICKS_PER_BEAT) - clock(ev.tick)) / TICKS_PER_BEAT;
    const made = voicesFor(bank, page.pages[row].macro, ev.note.key, ev.note.velocity, length, { tickSeconds, ctrl: n => channel.ctrls[n] ?? 0 });
    if (options.trace) options.trace({ time: start, midi: ev.midi & 15, program: channel.program, key: ev.note.key, velocity: ev.note.velocity, length, voices: made.map(v => ({ sample: v.sample, note: v.note, volume: v.volumeAt(0), startAt: v.startAt })) });
    if (!made.length) missing.add(`macro ${page.pages[row].macro.toString(16)}`);
    for (const voice of made) {
      const sample = samplePcm(bank, voice.sample);
      if (!sample) { missing.add(`sample ${voice.sample}`); continue; }
      voices++;
      const level = levels[ev.midi & 15], cursors = { volume: { i: 0 }, expression: { i: 0 }, pan: { i: 0 }, reverb: { i: 0 } };
      const start0 = { volume: midiSetup?.[ev.midi & 15]?.volume ?? 100, expression: 127, pan: midiSetup?.[ev.midi & 15]?.pan ?? 64, reverb: midiSetup?.[ev.midi & 15]?.reverb ?? 0 };
      let gl = 0, gr = 0, al = 0, ar = 0;
      const first = Math.floor((start + voice.startAt) * RATE);
      const baseSemis = voice.note + voice.detune / 100 - sample.rootKey, startTime = start + voice.startAt;
      // A one-shot sample with no envelope of its own rings out to its end: the game's key off only releases an envelope, and these
      // voices (drum hits, bells) have none. A looped sample with none stops with its note, as it would hold for ever otherwise.
      const ringsOut = !voice.env && !(sample.loopEnd > 0);
      const releaseAt = ringsOut ? Infinity : voice.releaseAt - voice.startAt, bendList = bends[ev.midi & 15], modList = mods[ev.midi & 15];
      const bendCursor = { i: 0 }, modCursor = { i: 0 };
      let position = 0, ratio = 0;
      for (let n = first, t = 0; n < total; n++, t = (n - first) / RATE) {
        const g = gainAt(voice.env, t, releaseAt);
        if (g === null) break;
        if (((n - first) & 31) === 0) {   // the pitch and volume are worked out each millisecond, as the game does
          const at = startTime + t;
          const velocity = voice.volumeAt(voice.startAt + t);
          const gainNow = volumeGain(velocity * (options.staticLevels ? channel.volume : valueAt(level.volume, at, start0.volume, cursors.volume)) / 127 * (options.staticLevels ? channel.expression : valueAt(level.expression, at, start0.expression, cursors.expression)) / 127) * (options.gain ?? DEFAULT_GAIN);
          const pans = panGains(options.staticLevels ? channel.pan : valueAt(level.pan, at, start0.pan, cursors.pan));
          gl = gainNow * pans.left; gr = gainNow * pans.right;
          if (!options.noReverb) {   // the reverb send: the same curve and pan, of the voice's volume times its channel's reverb controller
            const sendVolume = velocity * valueAt(level.volume, at, start0.volume, cursors.volume) / 127 * valueAt(level.expression, at, start0.expression, cursors.expression) / 127 * valueAt(level.reverb, at, start0.reverb, cursors.reverb) / 127 * (128 / 127);
            const send = volumeGain(sendVolume) * (options.gain ?? DEFAULT_GAIN);
            al = send * pans.left; ar = send * pans.right;
          }
          const bend = valueAt(bendList, startTime + t, 0x2000, bendCursor);
          let semis = baseSemis + (options.noBend ? 0 : (bend - 0x2000) * (options.bendRange ?? 2) / 8192);
          if (voice.vibrato && !options.noVibrato) {
            const vib = voice.vibrato, depth = vib.modulated ? (valueAt(modList, startTime + t, 0, modCursor) >> 7) / 128 : 1;
            semis += vib.semitones * depth * Math.sin(2 * Math.PI * ((t - (vib.startAt - voice.startAt) + vib.phase) / vib.period));
          }
          ratio = (sample.rate / RATE) * Math.pow(2, semis / 12);
        }
        let index = Math.floor(position);
        const looping = sample.loopEnd > 0;
        if (looping && index >= sample.loopEnd) { position = sample.loopStart + (position - sample.loopEnd) % Math.max(1, sample.loopEnd - sample.loopStart); index = Math.floor(position); }
        if (!looping && index + 1 >= sample.pcm.length) break;
        // a loop that ends on the sample's last point (as they do) joins back to its start, so the point after the last is the loop's first
        const next = looping && index + 1 >= sample.loopEnd ? sample.loopStart : index + 1;
        const frac = position - index, value = (sample.pcm[index] * (1 - frac) + sample.pcm[next] * frac) / 32768 * g;
        left[n] += value * gl; right[n] += value * gr;
        if (al || ar) { auxLeft[n] += value * al; auxRight[n] += value * ar; }
        position += ratio;
      }
    }
  }
  if (!options.noReverb) {
    const [time, preDelay] = REVERB_PRESETS[(options.reverb ?? 0) % REVERB_PRESETS.length];
    const wetLeft = reverbSide(auxLeft, time, preDelay, 0), wetRight = reverbSide(auxRight, time, preDelay, 1);
    for (let n = 0; n < total; n++) { left[n] += wetLeft[n]; right[n] += wetRight[n]; }
  }
  // loop: where a second pass starts and how long it is, in seconds, when loops were asked for (null for a song that plays once);
  // region: the part of the song that repeats, { start, end } in seconds, whether or not it was rendered more than once.
  return { left, right, rate: RATE, notes, voices, missing: [...missing], loop: loopSeconds ? { start: clock(loopEnd), length: loopSeconds } : null,
    region: loopEnd !== null && loopEnd > loopStartTick ? { start: clock(loopStartTick), end: clock(loopEnd) } : null };
}

// How long a song lasts played once, in seconds, and the part of it that repeats ({ start, end }, or null): the end of its last
// note, or of its loop. The sound dies away after: a render adds a few seconds for that.
function songSeconds(song) {
  const clock = tickClock(song);
  let end = 0, loopEnd = null;
  for (const track of song.tracks) {
    if (!track || track.midi === 0xff) continue;
    for (const entry of track.entries) {
      if (entry.loop) { loopEnd = Math.max(loopEnd ?? 0, entry.time); end = Math.max(end, clock(entry.time)); break; }
      for (const ev of readPattern(song, entry.pattern)) if (ev.control === undefined) end = Math.max(end, clock(entry.time + ev.time + ev.length));
    }
  }
  const region = loopEnd !== null && loopEnd > song.loopPoint ? { start: clock(song.loopPoint), end: clock(loopEnd) } : null;
  return { seconds: end, region };
}

// Limits a render's peaks in place, so that it never passes `ceiling`. It turns the gain down smoothly before a peak (5 ms ahead) and
// lets it back up over about a tenth of a second, so what is below the ceiling is left exactly as it is: unlike a waveshaper
// (tanh), it adds no distortion to the quiet and loud passages that don't need it.
function limit(left, right, ceiling = 0.97) {   // the game's own mix reaches full scale; a little under it, and the sound card gets no overs
  const n = left.length, look = 160, release = Math.pow(0.001, 1 / (0.12 * RATE));   // the gain's way back up: -60 dB per 0.12 s
  const want = new Float32Array(n);                     // the gain each sample needs
  let any = false;
  for (let i = 0; i < n; i++) { const peak = Math.max(Math.abs(left[i]), Math.abs(right[i])); if (peak > ceiling) { want[i] = ceiling / peak; any = true; } else want[i] = 1; }
  if (!any) return;
  // the lowest gain asked for in the next `look` samples, then smoothed over `look`: it is never above what a sample needs
  const low = new Float32Array(n), queue = new Int32Array(n);
  let head = 0, tail = 0;
  for (let i = n - 1; i >= 0; i--) {
    while (tail > head && want[queue[tail - 1]] >= want[i]) tail--;
    queue[tail++] = i;
    while (queue[head] > i + look) head++;
    low[i] = want[queue[head]];
  }
  // the average of the last `look` of those (all 1 before the start): a sample's average includes the lowest gain asked of it, so it
  // is never above what that sample needs, and the gain eases down over the `look` samples before a peak
  let sum = look, gain = 1;
  for (let i = 0; i < n; i++) {
    sum += low[i] - (i >= look ? low[i - look] : 1);
    gain = Math.min(sum / look, gain / release);   // down at once, and back up slowly
    if (gain < 1) { left[i] *= gain; right[i] *= gain; } else gain = 1;
  }
}

// 16-bit stereo PCM as a WAV file.
function wavStereo(left, right, rate, length = left.length) {
  const out = Buffer.alloc(44 + length * 4);
  out.write('RIFF', 0, 'latin1'); out.writeUInt32LE(36 + length * 4, 4); out.write('WAVEfmt ', 8, 'latin1');
  out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(2, 22); out.writeUInt32LE(rate, 24);
  out.writeUInt32LE(rate * 4, 28); out.writeUInt16LE(4, 32); out.writeUInt16LE(16, 34); out.write('data', 36, 'latin1'); out.writeUInt32LE(length * 4, 40);
  const clip = x => Math.round(Math.tanh(x) * 32767);   // a soft limit: no harsh clipping when voices add up
  for (let i = 0; i < length; i++) { out.writeInt16LE(clip(left[i]), 44 + i * 4); out.writeInt16LE(clip(right[i]), 46 + i * 4); }
  return out;
}

module.exports = { songSeconds, limit, MIDI_TIME, reverbSide, REVERB_PRESETS, DEFAULT_GAIN, readStream, readPatternStreams, volumeGain, panGains, RATE, loadBank, readSong, readPattern, tickClock, midiSetupFor, samplePcm, voicesFor, runMacro, envelopeOf, gainAt, render, wavStereo };
