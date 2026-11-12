'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const effects = require('../src/jukebox-effects');
const { SOUNDS, SOUND_EFFECT } = require('../src/pokemon-cries');

// A sound table where each given row is [sound id, flags, group, FX id]; the others are music (no flag, group 0).
function table(rows) {
  const sounds = Buffer.alloc(SOUNDS.count * SOUNDS.size, 0);
  for (const [id, flags, group, fx] of rows) { sounds[id * SOUNDS.size] = flags; sounds[id * SOUNDS.size + 1] = group; sounds.writeUInt16BE(fx, id * SOUNDS.size + 4); }
  return sounds;
}
// A bank whose FX id 1 starts macro 7, which starts sample 3 (at 1 s of 22050 Hz, root key 60, played at key 60).
function bank(label, key = 60, format = 0) {
  const steps = Buffer.alloc(8); steps.writeUInt32BE(0x10 | (3 << 8), 0);
  return { fx: new Map([[1, { macro: 7, key }]]), macros: new Map([[7, steps]]), samples: new Map([[3, { format, count: 22050, rate: 22050, rootKey: 60, coefficients: new Array(16).fill(0) }]]), file: 'x.samp', label };
}

test('the effects are the sound table\'s flagged rows of the known groups, numbered in their group', () => {
  const sounds = table([[5, SOUND_EFFECT, 5, 1], [6, SOUND_EFFECT, 6, 1], [7, SOUND_EFFECT, 6, 1], [8, 0, 6, 1], [9, SOUND_EFFECT, 4, 1], [10, SOUND_EFFECT, 6, 2]]);
  const banks = new Map([[5, bank('Battle')], [6, bank('General')]]);
  const list = effects.list(banks, sounds);
  assert.deepEqual(list.map(each => [each.id, each.name, each.group]), [['6', 'General effect 1', 'General'], ['7', 'General effect 2', 'General'], ['5', 'Battle effect 1', 'Battle']]);
  assert.ok(list.every(each => each.kind === 'sfx' && each.seconds === 1));
});

test('an effect played at another key is shorter or longer, and what is not DSP-ADPCM is left out', () => {
  const sounds = table([[5, SOUND_EFFECT, 5, 1], [6, SOUND_EFFECT, 6, 1]]);
  const up = effects.list(new Map([[5, bank('Battle', 72)], [6, bank('General', 60, 2)]]), sounds);
  assert.equal(up.length, 1);
  assert.equal(up[0].seconds, 0.5);
});
