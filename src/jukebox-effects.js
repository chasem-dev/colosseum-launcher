'use strict';
// The sound effects on the player's disc, for the Jukebox's second tab. They are the rows of common_rel's sound table with the sound
// effect flag, in three MusyX groups (a Pokémon's cry is another group of them, and the Pokédex plays those):
//   5 the battle's sounds (snd_se_battle), 6 the menus' and field's (snd_se), 8 a Pokémon's movement (snd_se_motion).
// How a sound is found is the cries' way (pokemon-cries.js): the row's FX id -> the group's FX table (a macro and a key) -> the
// macro's first StartSample -> the sample directory's DSP-ADPCM sample, played at its rate raised by the key's distance from its root.
// (The project files list groups 5 and 6 the other way round: the battle's project file holds group 5, and the general one 6.)
const fsys = require('./fsys');
const cries = require('./pokemon-cries');

const GROUPS = new Map([
  [6, { base: 'snd_se', samples: 'sound/snd_se.samp', label: 'General' }],
  [5, { base: 'snd_se_battle', samples: 'sound/snd_se_battle.samp', label: 'Battle' }],
  [8, { base: 'snd_se_motion', samples: 'sound/snd_se_motion.samp', label: 'Motion' }]
]);
const ADPCM = 0;
const FRAME = 8, PER_FRAME = 14;
const LONGEST = 48000 * 30;   // no effect is near this long; a damaged directory isn't decoded past it

// What a group's effects are made from: { fx, macros, samples, file, label }, read from common.fsys's members.
function readBanks(disc) {
  const common = new Map(fsys.entries(disc.file('common.fsys')).map(entry => [entry.name, entry]));
  const banks = new Map();
  for (const [group, info] of GROUPS) {
    const part = suffix => common.get(`${info.base}_${suffix}`);
    if (!part('proj') || !part('pool') || !part('sdir')) continue;
    banks.set(group, {
      fx: cries.fxTable(Buffer.from(part('proj').data()), group), macros: cries.macros(Buffer.from(part('pool').data())),
      samples: cries.sampleDirectory(Buffer.from(part('sdir').data())), file: info.samples, label: info.label
    });
  }
  return banks;
}

// Where a sound id's effect is: { bank, sample, rate }, or null when it isn't one of these.
function locate(banks, sounds, sound) {
  const at = sound * cries.SOUNDS.size;
  if (!Number.isInteger(sound) || sound < 1 || at + cries.SOUNDS.size > sounds.length || !(sounds[at] & cries.SOUND_EFFECT)) return null;
  const bank = banks.get(sounds[at + 1]);
  if (!bank) return null;
  const effect = bank.fx.get(sounds.readUInt16BE(at + 4)), steps = effect && bank.macros.get(effect.macro);
  const id = steps ? cries.macroSample(steps) : null, sample = id === null ? null : bank.samples.get(id);
  if (!sample || sample.format !== ADPCM || !sample.coefficients || !sample.count || sample.count > LONGEST) return null;
  return { bank, sample, rate: Math.round(sample.rate * 2 ** ((effect.key - sample.rootKey) / 12)) };
}

// The effects as tracks for the page: { id, sound, name, kind: 'sfx', group, seconds }, the general ones first, then the battle's
// and the movements', each in sound id order and numbered from 1 in its group.
function list(banks, sounds) {
  const tracks = [], counts = new Map();
  for (let sound = 1; sound < sounds.length / cries.SOUNDS.size; sound++) {
    const found = locate(banks, sounds, sound);
    if (!found) continue;
    const label = found.bank.label, number = (counts.get(label) ?? 0) + 1;
    counts.set(label, number);
    tracks.push({ id: String(sound), sound, name: `${label} effect ${number}`, kind: 'sfx', group: label, seconds: found.sample.count / found.rate });
  }
  const order = [...GROUPS.values()].map(info => info.label);
  return tracks.sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group) || a.sound - b.sound);
}

// An effect, decoded: { samples (Int16Array), rate }, or null.
function decode(disc, banks, sounds, sound) {
  const found = locate(banks, sounds, sound);
  if (!found) return null;
  const file = disc.files.get(found.bank.file), bytes = Math.ceil(found.sample.count / PER_FRAME) * FRAME;
  if (!file || found.sample.offset + bytes > file.size) return null;
  const samples = cries.decodeAdpcm(disc.read(file.offset + found.sample.offset, bytes), found.sample.count, found.sample.coefficients);
  return { samples, rate: found.rate };
}

module.exports = { GROUPS, readBanks, locate, list, decode };
