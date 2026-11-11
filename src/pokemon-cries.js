'use strict';

// Pokémon cries, decoded straight from the player's disc: the sound the game plays when a Pokémon is sent out or looked
// at in its summary. How the game gets there (from the decompilation):
//   - a species' row has its voice at +0x0E (pokemonDataBiosGetVoice), a sound id;
//   - common_rel's sound table (snd_volume_data.c, published for _sndSetVolumeWork) has a 12-byte row for each sound
//     id: flags (0x80 a sound effect), its MusyX group, reverb, wave index and its MusyX sound effect (FX) id;
//   - soundStartRaw starts that FX (soundStartFX, sndFXStartEx), changing only its volume (sndFXCtrl 7), never its pitch;
//   - the FX table of the group's project file names a macro and a key (synthFXStart); the macro, in the pool file,
//     starts one sample (StartSample, macro command 0x10) and waits for it to end;
//   - the sample directory gives the sample's place in its .samp file, its root key and rate, and its DSP-ADPCM
//     coefficients. MusyX plays it at rate * 2^((key - root key) / 12) (sndGetPitch). Every cry has key 60 and root
//     key 60, so it plays at its own rate, 11025 Hz.
// Cries are in two groups, each with its own files in common.fsys and its own .samp (common_rel's snd_sample_table.c).
const { Disc } = require('./disc');
const fsys = require('./fsys');
const pokedex = require('./pokedex');

const VOICE = 0x0e;
const SOUNDS = { offset: 0x13fe08, count: 1236, size: 12 };
const SOUND_EFFECT = 0x80;
const ARCHIVES = new Map([
  [4, { pool: 0x01b90000, project: 0x01ba0000, sdir: 0x01bc0000, samples: 'sound/snd_se_nakigoe.samp' }],
  [9, { pool: 0x01bd0000, project: 0x01be0000, sdir: 0x01c00000, samples: 'sound/snd_se_nakigoe2.samp' }]
]);
const END = 0xffffffff;
const MACRO = { end: 0x00, stop: 0x01, startSample: 0x10 };
const ADPCM = 0;              // a sample's format, the top byte of its length: DSP-ADPCM
const FRAME = 8, PER_FRAME = 14;
const LONGEST = 11025 * 30;   // no cry is near this long; a damaged directory isn't decoded past it

// A MusyX project's sound effect groups: FX id -> { macro, key }. The group list ends at a next offset of 0xFFFFFFFF;
// a group of type 1 (sound effects) has its FX table, a count then 10-byte rows, at +0x1C (s_data.c sndPushGroup).
function fxTable(project, group) {
  const table = new Map();
  for (let at = 0; at + 0x20 <= project.length && project.readUInt32BE(at) !== END; at = project.readUInt32BE(at)) {
    if (project.readUInt16BE(at + 4) !== group || project.readUInt16BE(at + 6) !== 1) continue;
    const start = project.readUInt32BE(at + 0x1c), count = project.readUInt16BE(start);
    for (let i = 0; i < count; i++) {
      const row = start + 4 + i * 10;
      table.set(project.readUInt16BE(row), { macro: project.readUInt16BE(row + 2), key: project[row + 8] });
    }
    break;
  }
  return table;
}

// A pool's macros, by id: each a list of 8-byte steps (MusyxPoolEntry: next offset, id, 0, then the steps).
function macros(pool) {
  const list = new Map();
  for (let at = pool.readUInt32BE(0); at + 8 <= pool.length && pool.readUInt32BE(at) !== END;) {
    const next = pool.readUInt32BE(at);
    if (next < 8) break;
    list.set(pool.readUInt16BE(at + 4), pool.subarray(at + 8, at + next));
    at += next;
  }
  return list;
}

// The sample a macro starts, by id, or null. The step's first word has the command in its low 7 bits.
function macroSample(steps) {
  for (let at = 0; at + 8 <= steps.length; at += 8) {
    const word = steps.readUInt32BE(at), command = word & 0x7f;
    if (command === MACRO.startSample) return (word >>> 8) & 0xffff;
    if (command === MACRO.end || command === MACRO.stop) break;
  }
  return null;
}

// A sample directory's samples, by id: 0x20-byte rows to an id of 0xFFFF, each with its ADPCM coefficients.
function sampleDirectory(sdir) {
  const samples = new Map();
  for (let at = 0; at + 0x20 <= sdir.length && sdir.readUInt16BE(at) !== 0xffff; at += 0x20) {
    const info = sdir.readUInt32BE(at + 12), length = sdir.readUInt32BE(at + 16), extra = sdir.readUInt32BE(at + 28);
    const coefficients = extra && extra + 0x28 <= sdir.length ? Array.from({ length: 16 }, (_, i) => sdir.readInt16BE(extra + 8 + i * 2)) : null;
    samples.set(sdir.readUInt16BE(at), { offset: sdir.readUInt32BE(at + 4), rootKey: info >>> 24, rate: info & 0xffffff,
      format: length >>> 24, count: length & 0xffffff, coefficients });
  }
  return samples;
}

// Nintendo's DSP-ADPCM, as the GameCube's DSP decodes it: 8-byte frames, a predictor/scale byte then 14 nibbles, the
// history starting at 0 (MusyX sets yn1 and yn2 to 0 when a sample starts).
function decodeAdpcm(bytes, count, coefficients) {
  const out = new Int16Array(count);
  let previous = 0, before = 0;
  for (let frame = 0, n = 0; n < count && frame + 1 <= bytes.length; frame += FRAME) {
    const header = bytes[frame], scale = 1 << (header & 0x0f), predictor = (header >> 4) & 7;
    const c1 = coefficients[predictor * 2], c2 = coefficients[predictor * 2 + 1];
    for (let k = 0; k < PER_FRAME && n < count; k++) {
      const byte = bytes[frame + 1 + (k >> 1)] ?? 0;
      let nibble = k & 1 ? byte & 0x0f : byte >> 4;
      if (nibble >= 8) nibble -= 16;
      // in doubles: the sum can pass 32 bits, which >> would wrap
      const value = Math.max(-32768, Math.min(32767, Math.floor((nibble * scale * 2048 + c1 * previous + c2 * before + 1024) / 2048)));
      before = previous;
      previous = value;
      out[n++] = value;
    }
  }
  return out;
}

// 16-bit mono PCM as a WAV file.
function wav(samples, rate) {
  const out = Buffer.alloc(44 + samples.length * 2);
  out.write('RIFF', 0, 'latin1');
  out.writeUInt32LE(36 + samples.length * 2, 4);
  out.write('WAVEfmt ', 8, 'latin1');
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(rate, 24);
  out.writeUInt32LE(rate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write('data', 36, 'latin1');
  out.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) out.writeInt16LE(samples[i], 44 + i * 2);
  return out;
}

// What the disc has to find cries: each species' voice, the sound table, and each group's FX, macros and samples.
function readTables(disc) {
  const common = new Map(fsys.entries(disc.file('common.fsys')).map(entry => [entry.id, entry]));
  const rel = [...common.values()].find(entry => entry.name === 'common_rel');
  if (!rel) throw new Error('The game disc has no Pokémon data.');
  const data = pokedex.relData(rel.data()), voices = new Map();
  for (let id = 0; id < pokedex.SPECIES.count; id++) {
    const at = pokedex.SPECIES.offset + id * pokedex.SPECIES.size, national = data.readUInt16BE(at + 0x12);
    if (national && !voices.has(national)) voices.set(national, data.readUInt16BE(at + VOICE));
  }
  const groups = new Map();
  for (const [group, files] of ARCHIVES) {
    const part = id => { const entry = common.get(id); if (!entry) throw new Error('The game disc has no Pokémon cries.'); return Buffer.from(entry.data()); };
    groups.set(group, { fx: fxTable(part(files.project), group), macros: macros(part(files.pool)), samples: sampleDirectory(part(files.sdir)), file: files.samples });
  }
  return { voices, sounds: Buffer.from(data.subarray(SOUNDS.offset, SOUNDS.offset + SOUNDS.count * SOUNDS.size)), groups };
}

// Where a sound id's cry is: { group, sample, rate } or null when it isn't one.
function locate(tables, sound) {
  if (!Number.isInteger(sound) || sound < 0 || sound >= SOUNDS.count) return null;
  const at = sound * SOUNDS.size;
  const flags = tables.sounds[at], group = tables.groups.get(tables.sounds[at + 1]), fx = tables.sounds.readUInt16BE(at + 4);
  if (!(flags & SOUND_EFFECT) || !group) return null;
  const effect = group.fx.get(fx), steps = effect && group.macros.get(effect.macro);
  const id = steps ? macroSample(steps) : null, sample = id === null ? null : group.samples.get(id);
  if (!sample || sample.format !== ADPCM || !sample.coefficients || !sample.count || sample.count > LONGEST) return null;
  return { group, sample, rate: Math.round(sample.rate * 2 ** ((effect.key - sample.rootKey) / 12)) };
}

// A cry as the game plays it: { wav, rate, samples (Int16Array) }, or null.
function decodeCry(disc, tables, sound) {
  const found = locate(tables, sound);
  if (!found) return null;
  const { sample } = found, file = disc.files.get(found.group.file);
  const bytes = Math.ceil(sample.count / PER_FRAME) * FRAME;
  if (!file || sample.offset + bytes > file.size) return null;
  const samples = decodeAdpcm(disc.read(file.offset + sample.offset, bytes), sample.count, sample.coefficients);
  return { wav: wav(samples, found.rate), rate: found.rate, samples };
}

// The cries of one disc. Its tables are kept once read, and the last cry decoded, as the player often plays it again.
function create() {
  let tables = null, last = null;
  // A disc whose cries can't be read is read once: the Pokédex asks of every Pokémon.
  const read = rom => {
    if (tables?.rom !== rom) {
      let disc = null;
      try { disc = new Disc(rom); tables = { rom, ...readTables(disc) }; }
      catch (error) { tables = { rom, error }; }
      finally { disc?.close(); }
    }
    if (tables.error) throw tables.error;
    return tables;
  };
  return {
    // A disc Pokémon's sound id, by National Pokédex number. Unown's and Castform's forms are one species, one cry.
    soundOf: (rom, national) => read(rom).voices.get(national) ?? null,
    // Whether it's a cry this disc has. False when the disc's cries can't be read.
    has(rom, sound) {
      try { return locate(read(rom), sound) !== null; } catch (_) { return false; }
    },
    // The cry's WAV file, or null.
    wav(rom, sound) {
      if (last?.rom === rom && last.sound === sound) return last.wav;
      const found = read(rom), disc = new Disc(rom);
      let cry;
      try { cry = decodeCry(disc, found, sound); } finally { disc.close(); }
      last = { rom, sound, wav: cry?.wav || null };
      return last.wav;
    }
  };
}

module.exports = { SOUNDS, SOUND_EFFECT, create, readTables, locate, decodeCry, decodeAdpcm, wav, fxTable, macros, macroSample, sampleDirectory, VOICE };
