'use strict';
// The songs on the player's disc, for the Jukebox. The game plays music by sound id (soundPlay in main.dol):
//   sound id -> its row in common_rel's sound table (pokemon-cries.js SOUNDS; a row without the sound effect flag
//   is music) -> that row's wave index -> the song table (snd_song_table.c, 79 entries of an FSYS member id and
//   a path) -> the song's file in bgm_archive.fsys, whose name is the song's.
const fsys = require('./fsys');
const pokedex = require('./pokedex');
const { SOUNDS, SOUND_EFFECT } = require('./pokemon-cries');
const { NAMES } = require('./jukebox-names');
const xdDisc = require('./xd-disc');

// common_rel's .data: the song table, and the word after it that holds its length (module 125).
const SONG_TABLE = { offset: 0x111B8C, size: 8, countAt: 0x14A6BC, most: 256 };
const WAVE_INDEX = 3;  // a sound table row's byte for it

// A song's name to show: the one we know it by (jukebox-names.js), else its file name made readable:
// "battle2_song" shows as "Battle2", "me_win_song" as "Me win".
function title(name) {
  const file = String(name).replace(/_song$/, '');
  if (Object.hasOwn(NAMES, file)) return NAMES[file];
  const words = file.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// The music in a sound table, named. songs: each song table entry's FSYS member id (0 for none); names: member id -> name.
// A song several sound ids play is listed once, by the first. Sound id 0 is never played.
function build({ sounds, songs, names }) {
  const tracks = [], seen = new Set();
  for (let sound = 1; sound < SOUNDS.count; sound++) {
    const row = sound * SOUNDS.size;
    if (sounds[row] & SOUND_EFFECT) continue;
    const song = songs[sounds[row + WAVE_INDEX]], name = song ? names.get(song) : null;
    if (!name || seen.has(song)) continue;
    seen.add(song);
    tracks.push({ id: String(sound), sound, name: title(name) });
  }
  return tracks;
}

// Pokémon XD's disc streams its music: its own sound test's list (xd-disc.js readSongs).
function read(disc) {
  if (xdDisc.isXd(disc)) return xdDisc.readSongs(disc);
  const common = fsys.entries(disc.file('common.fsys')).find(entry => entry.name === 'common_rel');
  if (!common) throw new Error('The game disc has no sound data.');
  const data = pokedex.relData(common.data());
  const count = data.readUInt32BE(SONG_TABLE.countAt);
  if (!count || count > SONG_TABLE.most) throw new Error('The game disc has no song list.');
  const songs = Array.from({ length: count }, (_, index) => data.readUInt32BE(SONG_TABLE.offset + index * SONG_TABLE.size));
  const names = new Map(fsys.entries(disc.file('bgm_archive.fsys')).map(entry => [entry.id, entry.name]));
  return build({ sounds: data.subarray(SOUNDS.offset, SOUNDS.offset + SOUNDS.count * SOUNDS.size), songs, names });
}

module.exports = { title, build, read };
