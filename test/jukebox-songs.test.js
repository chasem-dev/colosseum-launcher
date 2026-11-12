'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const songs = require('../src/jukebox-songs');
const { SOUNDS, SOUND_EFFECT } = require('../src/pokemon-cries');

// A sound table where each given row is [sound id, flags, wave index]; the others are empty sound effects.
function table(rows) {
  const sounds = Buffer.alloc(SOUNDS.count * SOUNDS.size, 0);
  for (let id = 0; id < SOUNDS.count; id++) sounds[id * SOUNDS.size] = SOUND_EFFECT;
  for (const [id, flags, wave] of rows) { sounds[id * SOUNDS.size] = flags; sounds[id * SOUNDS.size + 3] = wave; }
  return sounds;
}

test('a song is named from the song table\'s entry for its sound id\'s wave index', () => {
  const names = new Map([[0x019f0800, 'null_bgm_song'], [0x03080800, 'battle2_song'], [0x08070800, 'fanfare00_song']]);
  const list = songs.build({ sounds: table([[1, 0, 0], [24, 0, 2], [973, 0, 1]]), songs: [0x019f0800, 0x08070800, 0x03080800], names });
  assert.deepEqual(list, [{ id: '1', sound: 1, name: 'Silence' }, { id: '24', sound: 24, name: 'Colosseum Round 3 Battle' }, { id: '973', sound: 973, name: 'Colosseum Round Intro 1' }]);
});

test('sound effects, sound id 0, empty entries and unknown songs are left out, and a song is listed once', () => {
  const names = new Map([[7, 'a_song']]);
  const sounds = table([[0, 0, 0], [1, 0, 1], [2, SOUND_EFFECT, 0], [3, 0, 2], [4, 0, 0], [5, 0, 9], [6, 0xc0, 0]]);
  // 1 is empty (entry 1 is 0), 3 and 5 name no song in the archive, 4 repeats entry 0, which 0 (never played) also names
  assert.deepEqual(songs.build({ sounds, songs: [7, 0, 99], names }), [{ id: '4', sound: 4, name: 'A' }]);
});

test('a song\'s name reads as words', () => {
  assert.equal(songs.title('stand2_song'), 'Stand2');   // not matched to a name yet: its file name
  assert.equal(songs.title('me_welcome_song'), 'Me welcome');   // words at underscores
  assert.equal(songs.title('title_song'), 'Title Screen');
  assert.equal(songs.title('title'), 'Title Screen');          // with or without "_song"
  assert.equal(songs.title('unknown_one'), 'Unknown one');
  assert.equal(songs.title('toString'), 'ToString');       // never a property of the table's prototype
});

test('the names are for songs of the disc, each once, in the style of the rest', () => {
  const { NAMES } = require('../src/jukebox-names');
  const names = Object.values(NAMES);
  assert.equal(new Set(names).size, names.length);                         // no two songs share a name
  for (const [file, name] of Object.entries(NAMES)) {
    assert.match(file, /^[a-z0-9_]+$/);
    assert.ok(name.length > 2 && name === name.trim(), file);
  }
  assert.equal(NAMES.chakumelo00, 'PDA Mail Ringtone 1');
  assert.equal(NAMES.chakumelo09, 'PDA Mail Ringtone 10');
  assert.equal(NAMES.fanfare03, 'Colosseum Round Intro 4');
  assert.ok(Object.keys(NAMES).length >= 60);
});
