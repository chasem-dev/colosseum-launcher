'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const lookup = require('../src/texture-pack-lookup');

test('xxh64 matches the reference values', () => {
  assert.equal(lookup.xxh64(Buffer.alloc(0)).toString(16), 'ef46db3751d8e999');
  assert.equal(lookup.xxh64(Buffer.from('abc')).toString(16), '44bc2cf5ad770999');
  assert.equal(lookup.xxh64(Buffer.from('Nobody inspects the spammish repetition')).toString(16), 'fbcea83c8a378bf1');
});

test('a texture is named as the game names it, without and with _m', () => {
  const data = Buffer.alloc(32), hash = lookup.xxh64(data).toString(16).padStart(16, '0');
  assert.deepEqual(lookup.textureNames({ data, format: 14, width: 8, height: 8 }),
    [`tex1_8x8_${hash}_14`, `tex1_8x8_m_${hash}_14`]);
});

test('an indexed texture hashes only the palette entries it uses, then matches any palette', () => {
  const data = Buffer.alloc(32, 0x32), palette = Buffer.alloc(32);   // C4: entries 2 and 3
  palette.writeUInt16BE(0x1234, 4);
  palette.writeUInt16BE(0x5678, 6);
  const hash = lookup.xxh64(data).toString(16).padStart(16, '0'), used = lookup.xxh64(palette.subarray(4, 8)).toString(16).padStart(16, '0');
  assert.deepEqual(lookup.textureNames({ data, format: 8, width: 8, height: 8, palette }).slice(0, 3),
    [`tex1_8x8_${hash}_${used}_8`, `tex1_8x8_${hash}_$_8`, `tex1_8x8_${hash}_8`]);
});

test('the index keeps level 0 PNGs, the first folder winning', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-lookup-'));
  try {
    const custom = path.join(root, 'custom'), pack = path.join(root, 'pack', 'colo-upscale-4x');
    fs.mkdirSync(path.join(custom, 'nested'), { recursive: true });
    fs.mkdirSync(pack, { recursive: true });
    for (const file of ['tex1_8x8_aa_14.png', 'tex1_8x8_bb_14.png', 'tex1_8x8_bb_14_mip1.png', 'tex1_8x8_cc_14_arb.png', 'tex1_8x8_dd_14.dds', 'notes.txt'])
      fs.writeFileSync(path.join(pack, file), '');
    fs.writeFileSync(path.join(custom, 'nested', 'tex1_8x8_aa_14.png'), '');
    const index = lookup.indexFolders([custom, path.join(root, 'pack'), path.join(root, 'missing')]);
    assert.deepEqual([...index.keys()].sort(), ['tex1_8x8_aa_14', 'tex1_8x8_bb_14', 'tex1_8x8_cc_14']);
    assert.equal(index.get('tex1_8x8_aa_14'), path.join(custom, 'nested', 'tex1_8x8_aa_14.png'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// --- The real disc: COLO_TEST_DISC=/path/to/GC6E01.iso npm test --------------------------

const disc = process.env.COLO_TEST_DISC;
const withDisc = { skip: disc && fs.existsSync(disc) ? false : 'set COLO_TEST_DISC to your disc to run this' };

test("Pikachu's textures and sprite get the HD pack's names", withDisc, () => {
  const pokedex = require('../src/pokedex').create(), entry = pokedex.list(disc).find(item => item.national === 25);
  const names = pokedex.model(disc, 25, entry.forms[0].id).textures.map(texture => lookup.textureNames(texture.disc)[0]);
  assert.equal(names[0], 'tex1_32x64_211208d76abf3bc4_14');
  assert.equal(names[6], 'tex1_224x32_6f94ef52aba6308e_432eb45236dec6e5_9');
  assert.equal(names[9], 'tex1_32x32_1bc0a3f2d756a2c9_b5706e34132c6375_8');
  assert.equal(lookup.textureNames(pokedex.spriteTexture(disc, 25))[0], 'tex1_64x64_cc6ddfed30283bde_5');
});
