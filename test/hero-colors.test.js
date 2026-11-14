'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const colors = require('../src/hero-colors');
const heroLook = require('../src/hero-look');

// A texture of flat patches, each a colour as the disc has it, with a darker and a lighter shade of each.
function patches(list) {
  const width = list.length * 3, height = 2, rgba = new Uint8Array(width * height * 4);
  list.forEach((hex, i) => {
    const [r, g, b] = [1, 3, 5].map(k => parseInt(hex.slice(k, k + 2), 16));
    [0.7, 1, 1.15].forEach((shade, j) => {
      for (let y = 0; y < height; y++) rgba.set([r * shade, g * shade, b * shade, 255].map(v => Math.min(255, Math.round(v))), ((y * width) + i * 3 + j) * 4);
    });
  });
  return { rgba, width, height };
}

test('every hero has its model file, regions with seeds, and presets of its own regions', () => {
  assert.deepEqual(colors.HEROES.map(hero => hero.id), ['wes', 'brendan', 'may', 'red', 'leaf']);
  for (const hero of colors.HEROES) {
    assert.match(hero.battle.file, /^pkx_\w+\.fsys$/);
    const ids = hero.regions.map(region => region.id);
    assert.equal(new Set(ids).size, ids.length, `${hero.id}'s regions are named once`);
    assert.ok(hero.regions.every(region => region.seeds.length && region.seeds.every(seed => seed.length === 3)));
    assert.ok(ids.includes('skin') && ids.includes('eyes'), `${hero.id} has skin and eyes for its face`);
    for (const preset of hero.presets) for (const id of Object.keys(preset.colors)) assert.ok(ids.includes(id), `${hero.id}'s ${preset.id} colours ${id}`);
  }
});

test('the looks keep only real heroes, real regions and #rrggbb colours', () => {
  const looks = colors.normalizeLooks({ shown: 'ash', colors: { wes: { coat: '#AA0000', cape: '#00ff00', trim: 'red' }, gary: { coat: '#000000' } } });
  assert.equal(looks.shown, 'wes');
  assert.deepEqual(looks.colors.wes, { coat: '#aa0000' });
  assert.deepEqual(Object.keys(looks.colors), ['wes', 'brendan', 'may', 'red', 'leaf']);
  assert.deepEqual(colors.normalizeLooks(null).colors.leaf, {});
  assert.equal(colors.normalizeLooks({ shown: 'may' }).shown, 'may');
});

test('a texture is sorted by region, repainted only where a colour is chosen, and keeps its shading', () => {
  // Wes's coat blue, his trim's orange and his suit's black
  const texture = patches(['#0d4f78', '#7f2200', '#2b2526']);
  const { textures: [sorted] } = colors.prepare('wes', [texture]);
  const regions = colors.hero('wes').regions.map(region => region.id);
  // too small a texture is left alone: this one is padded out to a real size first
  assert.ok(sorted.mask.every(region => region === 255), 'a lens-sized texture keeps every texel');
  const big = { width: 48, height: 48, rgba: new Uint8Array(48 * 48 * 4) };
  for (let y = 0; y < 48; y++) for (let x = 0; x < 48; x++) big.rgba.set(texture.rgba.subarray(((y % 2) * texture.width + (x % texture.width)) * 4, ((y % 2) * texture.width + (x % texture.width)) * 4 + 4), (y * 48 + x) * 4);
  const prepared = colors.prepare('wes', [big]), [one] = prepared.textures;
  assert.equal(one.face, false);
  assert.equal(regions[one.mask[1]], 'coat');
  assert.equal(regions[one.mask[4]], 'trim');
  assert.equal(regions[one.mask[7]], 'suit');

  const unchanged = colors.recolor('wes', big.rgba, one, prepared.refs, {});
  assert.deepEqual(Array.from(unchanged), Array.from(big.rgba), 'no colour chosen leaves the texture as it was');
  const red = colors.recolor('wes', big.rgba, one, prepared.refs, { coat: '#c02020' });
  const at = i => Array.from(red.subarray(i * 4, i * 4 + 3));
  assert.ok(at(1)[0] > at(1)[2] + 60, 'the coat is red now');
  assert.ok(at(0)[0] < at(1)[0] && at(1)[0] < at(2)[0], 'its darker and lighter shades stay darker and lighter');
  assert.deepEqual(at(7), Array.from(big.rgba.subarray(28, 31)), 'the suit is left as it was');
});

test('a hero\'s idle motion is the one the model names, else its first', () => {
  assert.equal(heroLook.idleOf({ motions: [{ index: 2, kind: 'special' }, { index: 1, kind: 'idle' }], animations: [10, 30, 30] }), 1);
  assert.equal(heroLook.idleOf({ motions: [], animations: [10] }), 0);
  assert.equal(heroLook.idleOf({ motions: [], animations: [] }), -1);
});

test('a joint\'s rotation read back from its matrix is the one it was made with', () => {
  const retarget = require('../src/hero-retarget');
  for (const rotation of [[0, 0, 0], [0.3, -0.7, 1.2], [-1.1, 0.4, -2.5], [2.9, 1.2, 0.1]]) {
    const m = retarget.jointLocal([1, 1, 1], rotation, [0, 0, 0]);
    const r = [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]];
    const again = retarget.jointLocal([1, 1, 1], retarget.eulerOf(r), [0, 0, 0]);
    for (let e = 0; e < 16; e++) assert.ok(Math.abs(again[e] - m[e]) < 1e-9, `rotation ${rotation} element ${e}`);
  }
});

test('a pkx\'s battle slots name their first clip, and an empty slot -1', () => {
  // the header (0x40), a model and its particles of 0x20 bytes each, then three 0xD0-byte slots
  const pkx = Buffer.alloc(0x40 + 0x20 + 0x20 + 3 * 0xd0);
  pkx.writeUInt32BE(0x20, 0); pkx.writeUInt32BE(0x20, 4); pkx.writeUInt32BE(3, 8); pkx.writeUInt32BE(5, 0x10);
  const slot = i => 0x80 + i * 0xd0;
  pkx.writeUInt32BE(1, slot(0) + 4); pkx.writeUInt32BE(0, slot(0) + 0x8c); pkx.writeUInt32BE(4, slot(0) + 0x90);
  pkx.writeUInt32BE(2, slot(2) + 4); pkx.writeUInt32BE(1, slot(2) + 0x8c); pkx.writeUInt32BE(9, slot(2) + 0x90); pkx.writeUInt32BE(0, slot(2) + 0x94); pkx.writeUInt32BE(2, slot(2) + 0x98);
  assert.deepEqual(heroLook.slotClips(pkx, 10), [4, -1, 2]);
  assert.deepEqual(heroLook.slotClips(pkx, 3), [-1, -1, 2], 'a clip past the model\'s isn\'t played');
  assert.deepEqual(heroLook.slotClips(Buffer.alloc(0x40), 3), [], 'no battle header, no slots');
});

test('every motion is named once; Idle comes first and is played standing when a hero has a model to stand as', () => {
  const ids = colors.MOTIONS.map(motion => motion.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ids[0], 'idle');
  assert.equal(colors.modelFor('wes', 'idle'), 'stand');
  assert.equal(colors.modelFor('wes', 'snag'), 'battle');
  assert.equal(colors.modelFor('brendan', 'idle'), 'battle');
  assert.ok(colors.MOTIONS.filter(motion => motion.id !== 'idle').every(motion => Number.isInteger(motion.slot)));
});
