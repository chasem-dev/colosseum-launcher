'use strict';
// The sound effects on the player's disc, for the Jukebox's second tab. Both games play them from the same two MusyX projects in
// common.fsys, snd_se (the menus' and field's) and snd_se_battle (the battle's), with their samples in sound/snd_se.samp and
// sound/snd_se_battle.samp (Colosseum also has the Pokémon's movements, snd_se_motion). How a sound is found is the cries' way
// (pokemon-cries.js): the sound table's row gives its group and FX id -> the group's FX table (a macro and a key) -> the macro's
// first StartSample -> the sample directory's DSP-ADPCM sample, played at its rate raised by the key's distance from its root.
// The two games lay a sound table's 12-byte row out differently:
//   Colosseum: the flags (0x80: a sound effect), the group (5 the battle's, 6 the general; their project files list them the other
//              way round: the battle's project holds group 5 and snd_se holds 6, as it does here), reverb, wave index, FX id at +4;
//   XD:        the group in the high nibble of the first byte (2 general, 3 battle), the flags at +2 (0x40: a stream, that is a song
//              or a cry), the FX id at +4. A row of group 1 is a stand-in.
const fsys = require('./fsys');
const cries = require('./pokemon-cries');
const xdDisc = require('./xd-disc');

const SIZE = 12;
const GENERAL = { base: 'snd_se', samples: 'sound/snd_se.samp', label: 'General' };
const BATTLE = { base: 'snd_se_battle', samples: 'sound/snd_se_battle.samp', label: 'Battle' };
const LAYOUTS = {
  colosseum: {
    groups: new Map([[6, GENERAL], [5, BATTLE], [8, { base: 'snd_se_motion', samples: 'sound/snd_se_motion.samp', label: 'Motion' }]]),
    group: (rows, at) => (rows[at] & cries.SOUND_EFFECT ? rows[at + 1] : null)
  },
  xd: {
    groups: new Map([[2, GENERAL], [3, BATTLE]]),
    group: (rows, at) => (rows[at + 2] & 0x40 ? null : rows[at] >> 4)
  }
};
const ADPCM = 0;
const FRAME = 8, PER_FRAME = 14;
const LONGEST = 48000 * 30;   // no effect is near this long; a damaged directory isn't decoded past it

// What a disc's effects are made from: { layout, rows (the sound table), banks: group -> { fx, macros, samples, file, label } }, or null.
function read(disc) {
  const xd = xdDisc.isXd(disc), layout = LAYOUTS[xd ? 'xd' : 'colosseum'];
  let rows;
  if (xd) rows = xdDisc.soundRows(disc);
  else {
    const rel = fsys.entries(disc.file('common.fsys')).find(entry => entry.name === 'common_rel');
    if (!rel) return null;
    rows = Buffer.from(require('./pokedex').relData(rel.data()).subarray(cries.SOUNDS.offset, cries.SOUNDS.offset + cries.SOUNDS.count * cries.SOUNDS.size));
  }
  const common = new Map(fsys.entries(disc.file('common.fsys')).map(entry => [entry.name, entry]));
  const banks = new Map();
  for (const [group, info] of layout.groups) {
    const part = suffix => common.get(`${info.base}_${suffix}`);
    if (!part('proj') || !part('pool') || !part('sdir')) continue;
    banks.set(group, {
      fx: cries.fxTable(Buffer.from(part('proj').data()), group), macros: cries.macros(Buffer.from(part('pool').data())),
      samples: cries.sampleDirectory(Buffer.from(part('sdir').data())), file: info.samples, label: info.label
    });
  }
  return { layout, rows, banks };
}

// Where a sound id's effect is: { bank, sample, rate }, or null when it isn't one of these.
function locate(set, sound) {
  const at = sound * SIZE;
  if (!Number.isInteger(sound) || sound < 1 || at + SIZE > set.rows.length) return null;
  const group = set.layout.group(set.rows, at), bank = group === null ? null : set.banks.get(group);
  if (!bank) return null;
  const effect = bank.fx.get(set.rows.readUInt16BE(at + 4)), steps = effect && bank.macros.get(effect.macro);
  const id = steps ? cries.macroSample(steps) : null, sample = id === null ? null : bank.samples.get(id);
  if (!sample || sample.format !== ADPCM || !sample.coefficients || !sample.count || sample.count > LONGEST) return null;
  return { bank, sample, rate: Math.round(sample.rate * 2 ** ((effect.key - sample.rootKey) / 12)) };
}

// The effects as tracks for the page: { id, sound, name, kind: 'sfx', group, seconds }, the general ones first, then the battle's
// and the movements', each in sound id order and numbered from 1 in its group.
function list(set) {
  const tracks = [], counts = new Map();
  for (let sound = 1; sound < set.rows.length / SIZE; sound++) {
    const found = locate(set, sound);
    if (!found) continue;
    const label = found.bank.label, number = (counts.get(label) ?? 0) + 1;
    counts.set(label, number);
    tracks.push({ id: String(sound), sound, name: `${label} effect ${number}`, kind: 'sfx', group: label, seconds: found.sample.count / found.rate });
  }
  const order = [GENERAL.label, BATTLE.label, 'Motion'];
  return tracks.sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group) || a.sound - b.sound);
}

// An effect, decoded: { samples (Int16Array), rate }, or null.
function decode(disc, set, sound) {
  const found = locate(set, sound);
  if (!found) return null;
  const file = disc.files.get(found.bank.file), bytes = Math.ceil(found.sample.count / PER_FRAME) * FRAME;
  if (!file || found.sample.offset + bytes > file.size) return null;
  const samples = cries.decodeAdpcm(disc.read(file.offset + found.sample.offset, bytes), found.sample.count, found.sample.coefficients);
  return { samples, rate: found.rate };
}

module.exports = { LAYOUTS, read, locate, list, decode };
