'use strict';
// A song of the player's disc, rendered for the Jukebox's page (jukebox-songs.js lists them by sound id). The sound id's row of
// common_rel's sound table says which music project (group 0 is the songs, 1 the atmospheres), the song's reverb setting, and,
// by its wave index, the song's entry in the song table, whose file id names the song in bgm_archive.fsys.
const fsys = require('./fsys');
const pokedex = require('./pokedex');
const { SOUNDS } = require('./pokemon-cries');
const music = require('./musyx-music');
const xdDisc = require('./xd-disc');

const SONG_TABLE = { offset: 0x111B8C, size: 8, countAt: 0x14A6BC, most: 256 };
const PROJECTS = new Map([[0, { base: 'snd_music', samples: 'sound/snd_music.samp' }], [1, { base: 'snd_music_atmos', samples: 'sound/snd_music_atmos.samp' }]]);
const TAIL = 4;   // seconds of ringing, and reverb, left after a song's last note

// What renders songs of one disc: keeps the disc's tables, and each music project's samples once they are decoded.
// Pokémon XD's songs are streams, decoded rather than mixed (xd-disc.js songRenderer).
function create(disc) {
  if (xdDisc.isXd(disc)) return xdDisc.songRenderer(disc);
  const common = new Map(fsys.entries(disc.file('common.fsys')).map(entry => [entry.name, entry]));
  const rel = common.get('common_rel');
  if (!rel) throw new Error('The game disc has no sound data.');
  const data = Buffer.from(pokedex.relData(rel.data()));
  const count = data.readUInt32BE(SONG_TABLE.countAt);
  if (!count || count > SONG_TABLE.most) throw new Error('The game disc has no song list.');
  const songFiles = Array.from({ length: count }, (_, i) => data.readUInt32BE(SONG_TABLE.offset + i * SONG_TABLE.size));
  const archive = new Map(fsys.entries(disc.file('bgm_archive.fsys')).map(entry => [entry.id, entry]));
  const banks = new Map();
  const bank = group => {
    const project = PROJECTS.get(group);
    if (!project) throw new Error('That song has no instruments on the disc.');
    if (!banks.has(group)) banks.set(group, music.loadBank(disc, project.base, project.samples, group));
    return banks.get(group);
  };

  // sound: a sound id of the sound table. Returns { left, right, rate, loop: { start, end } | null } (seconds), soft-limited.
  function render(sound, options = {}) {
    if (!Number.isInteger(sound) || sound < 1 || sound >= SOUNDS.count) throw new Error('That song is not on the disc.');
    const row = SOUNDS.offset + sound * SOUNDS.size;
    const entry = archive.get(songFiles[data[row + 3]]);
    if (!entry) throw new Error('That song is not on the disc.');
    const song = music.readSong(Buffer.from(entry.data()));
    const project = bank(data[row + 1]);
    const setup = music.midiSetupFor(project.proj, project.group.midiSetup, data.readUInt16BE(row + 4));
    const { seconds, region } = music.songSeconds(song);
    const length = Math.min(options.most ?? 600, seconds + TAIL);
    const result = music.render(project, song, setup, { seconds: length, reverb: data[row + 2], loops: 0 });
    if (options.limit !== false) music.limit(result.left, result.right);   // (options.limit: false is for measuring a render as mixed)
    const frames = Math.floor(length * result.rate);
    return { left: result.left.subarray(0, frames), right: result.right.subarray(0, frames), rate: result.rate, loop: region };
  }
  return { render };
}

module.exports = { create, TAIL };
