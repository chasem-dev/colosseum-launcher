'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const titleLogo = require('../src/title-logo');
const gx = require('../src/gx-texture');

// --- Made-up files in the disc's formats ------------------------------------------------

// An RGBA8 texture's bytes (GX tiles of 4x4: AR then GB), every pixel `rgba`, or transparent where `clear` says.
function rgba8(width, height, rgba, clear = () => false) {
  const out = Buffer.alloc(gx.textureSize(6, width, height));
  let at = 0;
  for (let top = 0; top < height; top += 4) for (let left = 0; left < width; left += 4, at += 64) {
    for (let i = 0; i < 16; i++) {
      const x = left + (i & 3), y = top + (i >> 2), [r, g, b, a] = clear(x, y) ? [0, 0, 0, 0] : rgba;
      out[at + i * 2] = a; out[at + i * 2 + 1] = r; out[at + 32 + i * 2] = g; out[at + 33 + i * 2] = b;
    }
  }
  return out;
}

// A model file holding `textures` ({ width, height, format, pixels }), each on a texture object, as the game's are.
function datFile(textures) {
  const parts = [], pointers = [];
  let size = 0;
  const reserve = bytes => { const at = size; size += (bytes + 31) & ~31; return at; };
  for (const texture of textures) {
    const tobj = reserve(0x60), image = reserve(0x20), pixels = reserve(texture.pixels.length);
    parts.push({ tobj, image, pixels, texture });
    pointers.push(tobj + 0x4c, image);
  }
  const data = Buffer.alloc(size);
  for (const { tobj, image, pixels, texture } of parts) {
    data.writeUInt32BE(image, tobj + 0x4c);
    data.writeUInt32BE(pixels, image);
    data.writeUInt16BE(texture.width, image + 4); data.writeUInt16BE(texture.height, image + 6); data.writeUInt32BE(texture.format, image + 8);
    texture.pixels.copy(data, pixels);
  }
  const header = Buffer.alloc(0x20), table = Buffer.alloc(pointers.length * 4);
  pointers.forEach((pointer, i) => table.writeUInt32BE(pointer, i * 4));
  header.writeUInt32BE(0x20 + size + table.length, 0); header.writeUInt32BE(size, 4); header.writeUInt32BE(pointers.length, 8);
  return Buffer.concat([header, data, table]);
}

test('Colosseum\'s logo is the wide full-colour picture clear at its corners, not the scene\'s clouds or stone', () => {
  const corner = (width, height) => (x, y) => (x === 0 || x === width - 1) && (y === 0 || y === height - 1);
  const dat = datFile([
    { width: 16, height: 16, format: 6, pixels: rgba8(16, 16, [200, 190, 150, 255]) },        // a square cloud
    { width: 32, height: 8, format: 6, pixels: rgba8(32, 8, [90, 80, 70, 255]) },             // a wide stone strip, solid
    { width: 24, height: 8, format: 6, pixels: rgba8(24, 8, [255, 0, 0, 255], corner(24, 8)) } // the logo
  ]);
  const textures = titleLogo.datTextures(dat);
  assert.equal(textures.length, 3);
  const logo = titleLogo.pickColosseumLogo(textures);
  assert.deepEqual([logo.width, logo.height, logo.disc.format], [24, 8, 6]);
  assert.deepEqual([...logo.rgba.subarray(4, 8)], [255, 0, 0, 255]);
  assert.equal(titleLogo.pickColosseumLogo(textures.slice(0, 2)), null);
});

// XD's Flash title menu: one red bitmap, on a quad of 80x40, placed at (10, 5) at half alpha, then the label "back".
function flashMovie({ alpha = 128 } = {}) {
  const tags = [];
  const tag = (code, body) => tags.push({ code, body });
  // the bitmap: a block whose texture (a GStexture: 0x80-byte header, then RGBA8) is 0x20 after it
  const texture = Buffer.alloc(0x80);
  texture.writeUInt16BE(4, 0); texture.writeUInt16BE(4, 2); texture[4] = 32; texture[0x0b] = 0x45;
  const block = Buffer.alloc(0x20);
  block.writeUInt16BE(1, 2); block.writeUInt32BE(0x20, 0x10);
  tag(36, Buffer.concat([Buffer.alloc(8), block, texture, rgba8(4, 4, [255, 0, 0, 255])]));   // 8 to align the block
  // the shape: one bitmap fill (scaled 20 times), and a style change then four edges, in twips
  const shape = Buffer.alloc(0x200);
  shape.writeUInt32BE(2, 0); shape.writeUInt32BE(1, 4); shape.writeUInt32BE(0x20, 8); shape.writeUInt32BE(0xa0, 0x18);
  shape[0x20] = 0x41; shape.writeUInt32BE(1, 0x20 + 0x64);
  shape.writeInt32BE(20 * 1310720, 0x20 + 0x68); shape.writeInt32BE(20 * 1310720, 0x20 + 0x74);
  const edges = [[1600, 0], [0, 800], [-1600, 0], [0, -800]];
  let record = 0xa0, data = 0x120;
  const link = (type, body) => { shape[record] = type; shape.writeUInt32BE(data, record + 4); shape.writeUInt32BE(record + 12, record + 8); body.copy(shape, data); record += 12; data += body.length; };
  const change = Buffer.alloc(0x18); change[0] = 1 | 4; change[0x0d] = 1;
  link(1, change);
  for (const [dx, dy] of edges) { const edge = Buffer.alloc(12); edge.writeInt32BE(dx, 4); edge.writeInt32BE(dy, 8); link(2, edge); }
  shape[record] = 0;   // the end record, whose next is 0
  tag(2, shape);
  const place = Buffer.alloc(0x3c);
  place[0] = 2 | 4 | 8; place.writeUInt32BE(2, 4); place.writeUInt32BE(1, 8);
  [65536, 0, 0, 65536, 200, 100].forEach((value, i) => place.writeInt32BE(value, 0x0c + i * 4));
  [alpha, 0, 256, 0, 256, 0, 256, 0].forEach((value, i) => place.writeInt16BE(value, 0x24 + i * 2));
  tag(26, place);
  const show = Buffer.alloc(4); show.writeInt32BE(1, 0);
  tag(1, show);
  const label = Buffer.alloc(12); label.writeUInt32BE(4, 0); label.write('back\0', 4, 'latin1');
  tag(43, label);
  const out = [Buffer.alloc(0x30)];
  for (const { code, body } of tags) { const head = Buffer.alloc(8); head.writeUInt32BE(code, 0); head.writeUInt32BE(body.length, 4); out.push(head, body); }
  out.push(Buffer.alloc(16));
  return Buffer.concat(out);
}

test('XD\'s logo is its title menu\'s frame before "back", drawn as the game draws its bitmap quads', () => {
  const movie = flashMovie(), flash = titleLogo.readFlash(movie);
  assert.deepEqual(flash.labels, [{ frame: 1, name: 'back' }]);
  assert.deepEqual([...flash.bitmaps.keys()], [1]);
  const quads = titleLogo.frameQuads(movie, flash, flash.timeline, 0);
  assert.equal(quads.length, 1);
  assert.deepEqual(quads[0].points, [[80, 0], [80, 40], [0, 40], [0, 0]]);
  assert.deepEqual(quads[0].matrix, [1, 0, 0, 1, 10, 5]);
  const logo = titleLogo.xdLogoFromMovie(movie);
  // cut to what was drawn: the quad, red at the cxform's half alpha
  assert.deepEqual([logo.width, logo.height], [80, 40]);
  assert.deepEqual([...logo.rgba.subarray(0, 4)], [255, 0, 0, 128]);
  // a movie that draws nothing there has no logo
  assert.throws(() => titleLogo.xdLogoFromMovie(flashMovie({ alpha: 0 })), /drew no logo/);
});

test('a GStexture with a palette decodes through it', () => {
  // 8x4 C8 (the game's code 0x01), palette in RGB5A3 (3) right after the pixels
  const file = Buffer.alloc(0x80 + 32 + 512);
  file.writeUInt16BE(8, 0); file.writeUInt16BE(4, 2); file[0x0b] = 0x01; file[0x0f] = 3; file.writeUInt32BE(0x80 + 32, 0x48);
  file.fill(1, 0x80, 0x80 + 32);
  file.writeUInt16BE(0xfc00, 0x80 + 32 + 2);   // entry 1: opaque red
  const image = gx.decodeStandalone(file);
  assert.deepEqual([image.width, image.height, image.disc.format], [8, 4, 9]);
  assert.deepEqual([...image.rgba.subarray(0, 4)], [255, 0, 0, 255]);
  assert.equal(image.disc.palette.length, 512);
});

test('the cache key follows the disc file, its time and the language', t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'title-logo-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const disc = path.join(folder, 'game.iso'), other = path.join(folder, 'other.iso');
  fs.writeFileSync(disc, 'disc'); fs.writeFileSync(other, 'disc');
  const key = titleLogo.cacheKey('colosseum', disc, 'en');
  assert.match(key, /^colosseum-[0-9a-f]{20}$/);
  assert.equal(titleLogo.cacheKey('colosseum', disc, 'en'), key);
  assert.notEqual(titleLogo.cacheKey('colosseum', other, 'en'), key);
  assert.notEqual(titleLogo.cacheKey('colosseum', disc, 'fr'), key);
  assert.notEqual(titleLogo.cacheKey('xd', disc, 'en'), key);
  fs.utimesSync(disc, new Date(), new Date(Date.now() + 60000));
  assert.notEqual(titleLogo.cacheKey('colosseum', disc, 'en'), key);
  // a pack's own logo is part of it too
  const pack = path.join(folder, 'fr'), before = titleLogo.cacheKey('colosseum', disc, 'fr', pack);
  fs.mkdirSync(path.dirname(titleLogo.packLogoFile(pack)), { recursive: true });
  fs.writeFileSync(titleLogo.packLogoFile(pack), 'logo');
  assert.notEqual(titleLogo.cacheKey('colosseum', disc, 'fr', pack), before);
});

test('an HD pack\'s image of the logo is found by the texture\'s names', () => {
  const index = new Map([['tex1_540x224_aa_6', '/pack/logo.png']]);
  assert.equal(titleLogo.hdLogoFile(index, ['tex1_540x224_bb_6', 'tex1_540x224_aa_6']), '/pack/logo.png');
  assert.equal(titleLogo.hdLogoFile(index, []), null);
  assert.equal(titleLogo.hdLogoFile(new Map(), ['tex1_540x224_aa_6']), null);
});

// --- The real discs: COLO_TEST_DISC=/path/to/GC6E01.iso XD_TEST_DISC=/path/to/GXXE01.iso npm test ---

const coloDisc = process.env.COLO_TEST_DISC, xdDisc = process.env.XD_TEST_DISC;
const withColo = { skip: coloDisc && fs.existsSync(coloDisc) ? false : 'set COLO_TEST_DISC to your Colosseum disc to run this' };
const withXd = { skip: xdDisc && fs.existsSync(xdDisc) ? false : 'set XD_TEST_DISC to your XD disc to run this' };
const clearCorners = logo => [[0, 0], [logo.width - 1, 0], [0, logo.height - 1], [logo.width - 1, logo.height - 1]]
  .every(([x, y]) => logo.rgba[(y * logo.width + x) * 4 + 3] === 0);

test('Colosseum\'s disc gives its title logo, read once and then from the cache', withColo, t => {
  const logo = titleLogo.readLogo('colosseum', coloDisc);
  assert.deepEqual([logo.width, logo.height], [540, 224]);
  assert.equal(clearCorners(logo), true);
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'title-logo-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const first = titleLogo.cachedLogo(folder, 'colosseum', coloDisc);
  assert.equal(first.file.endsWith('.png'), true);
  assert.equal(first.hdNames[0].startsWith('tex1_540x224_'), true);
  const written = fs.statSync(first.file).mtimeMs;
  const again = titleLogo.cachedLogo(folder, 'colosseum', coloDisc);
  assert.deepEqual(again, first);
  assert.equal(fs.statSync(again.file).mtimeMs, written);
  // the disc isn't XD's
  assert.throws(() => titleLogo.readLogo('xd', coloDisc), /isn't Pokémon XD/);
});

test('XD\'s disc gives its title logo, put together from its title menu', withXd, () => {
  const logo = titleLogo.readLogo('xd', xdDisc);
  // the frame's logo: the plate, Pokémon, XD, Gale of Darkness and TM, 545x221 of the 640x480 screen
  assert.deepEqual([logo.width, logo.height], [545, 221]);
  assert.equal(logo.disc, null);
  const opaque = logo.rgba.filter((_, i) => i % 4 === 3 && logo.rgba[i] === 255).length;
  assert.ok(opaque > logo.width * logo.height * 0.5, `only ${opaque} opaque pixels`);
});
