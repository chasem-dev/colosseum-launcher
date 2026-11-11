'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const zlib = require('node:zlib');
const fsys = require('../src/fsys');
const gx = require('../src/gx-texture');
const hsd = require('../src/hsd-model');
const pokedex = require('../src/pokedex');

// --- FSYS ----------------------------------------------------------------------------

function lzssFile(body, size) {
  const header = Buffer.alloc(16);
  header.write('LZSS', 0, 'latin1');
  header.writeUInt32BE(size, 4);
  return Buffer.concat([header, Buffer.from(body)]);
}

// An archive of one entry, laid out as the disc's are: header, list, record, name, data.
function archive(data, { id = 0x12340000, name = 'thing', compressed = false, size = data.length } = {}) {
  const out = Buffer.alloc(0x100 + data.length);
  out.write('FSYS', 0, 'latin1');
  out.writeUInt32BE(1, 0x0c);
  out.writeUInt32BE(0x40, 0x18);
  out.writeUInt32BE(0x50, 0x40);
  out.writeUInt32BE(0x60, 0x50);
  out.writeUInt32BE(id, 0x60);
  out.writeUInt32BE(0x100, 0x64);
  out.writeUInt32BE(size, 0x68);
  out.writeUInt32BE(compressed ? 0x80000000 : 0, 0x6c);
  out.writeUInt32BE(data.length, 0x74);
  out.writeUInt32BE(15, 0x80);
  out.writeUInt32BE(0xa0, 0x84);
  out.write(name, 0xa0, 'latin1');
  data.copy(out, 0x100);
  return out;
}

test('lzss unpacks literals and copies from its window', () => {
  // Flags 0b0111: three literals, then a copy of those three from the window's start.
  const packed = lzssFile([0b0111, 0x41, 0x42, 0x43, 0xee, 0xf0], 6);
  assert.equal(fsys.lzss(packed).toString('latin1'), 'ABCABC');
});

test('lzss leaves anything else as it is', () => {
  const plain = Buffer.from('plain');
  assert.equal(fsys.lzss(plain), plain);
});

test('entries reads an archive and unpacks what is compressed', () => {
  const [entry] = fsys.entries(archive(lzssFile([0b0111, 0x41, 0x42, 0x43, 0xee, 0xf0], 6), { compressed: true, size: 6 }));
  assert.equal(entry.name, 'thing');
  assert.equal(entry.type, 15);
  assert.equal(entry.data().toString('latin1'), 'ABCABC');
});

test('firstEntryId needs only the start of an archive', () => {
  assert.equal(fsys.firstEntryId(archive(Buffer.alloc(0x1000), { id: 0x033f1e00 }).subarray(0, 0x80)), 0x033f1e00);
  assert.equal(fsys.firstEntryId(Buffer.alloc(0x80)), null);
});

test('entries refuses a file that is not an archive', () => {
  assert.throws(() => fsys.entries(Buffer.alloc(0x100)), /isn't an archive/);
});

// --- Textures ------------------------------------------------------------------------

test('RGB5A3 decodes both of its pixel forms, tile by tile', () => {
  const source = Buffer.alloc(32);
  source.writeUInt16BE(0xfc00, 0);  // opaque red
  source.writeUInt16BE(0x7f00, 2);  // alpha 7, red 15
  assert.deepEqual([...gx.decode(5, 4, 4, source).subarray(0, 8)], [255, 0, 0, 255, 255, 0, 0, 255]);
});

test('a CMPR block picks its two colours', () => {
  const source = Buffer.alloc(32);
  source.writeUInt16BE(0xf800, 0);  // red
  source.writeUInt16BE(0x001f, 2);  // blue
  source[4] = 0b00010000;  // red, blue, red, red
  const rgba = gx.decode(14, 8, 8, source);
  assert.deepEqual([...rgba.subarray(0, 4)], [255, 0, 0, 255]);
  assert.deepEqual([...rgba.subarray(4, 8)], [0, 0, 255, 255]);
});

test('a colour-index texture looks up its palette', () => {
  const source = Buffer.alloc(32), palette = Buffer.alloc(4);
  source[0] = 1;
  palette.writeUInt16BE(0xf800, 2);
  assert.deepEqual([...gx.decode(9, 8, 4, source, palette, 1).subarray(0, 4)], [255, 0, 0, 255]);
});

test('decode turns down what it cannot read', () => {
  assert.equal(gx.decode(7, 8, 8, Buffer.alloc(64)), null);
  assert.equal(gx.decode(5, 8, 8, Buffer.alloc(8)), null);
});

test('a standalone texture is read from its header', () => {
  const file = Buffer.alloc(0x80 + 32);
  file.writeUInt16BE(4, 0);
  file.writeUInt16BE(4, 2);
  file[0x0b] = 0x90;
  file.writeUInt16BE(0xfc00, 0x80);
  const image = gx.decodeStandalone(file);
  assert.deepEqual([image.width, image.height, ...image.rgba.subarray(0, 4)], [4, 4, 255, 0, 0, 255]);
});

// --- Models --------------------------------------------------------------------------

// A pkx by hand: `layout` writes its data with pointer(), which records relocations.
function pkx(layout) {
  const data = Buffer.alloc(0x400), relocations = [];
  const pointer = (at, target) => { data.writeUInt32BE(target, at); relocations.push(at); };
  const root = layout(data, pointer);
  const table = Buffer.alloc(8), name = Buffer.from('scene_data\0', 'latin1');
  table.writeUInt32BE(root, 0);
  const list = Buffer.alloc(relocations.length * 4);
  relocations.forEach((at, i) => list.writeUInt32BE(at, i * 4));
  const header = Buffer.alloc(0x20);
  header.writeUInt32BE(data.length, 4);
  header.writeUInt32BE(relocations.length, 8);
  header.writeUInt32BE(1, 12);
  const file = Buffer.concat([header, data, list, table, name]);
  file.writeUInt32BE(file.length, 0);
  const head = Buffer.alloc(0x40);
  head.writeUInt32BE(file.length, 0);
  return Buffer.concat([head, file]);
}

// One joint holding one rigid triangle, and one animation that moves it along X.
function triangleModel(data, pointer) {
  const JOINT = 0x10, DOBJ = 0x60, POBJ = 0x80, ATTRS = 0xa0, LIST = 0x100, POSITIONS = 0x120, SET = 0x1a0, MODELS = 0x1b0, ROOT = 0x1b8;
  const ANIMS = 0x1c8, ANIM = 0x1d0, AOBJ = 0x1e8, FOBJ = 0x1f8, KEYS = 0x210;
  data.writeUInt32BE(1 << 1, JOINT + 4);  // the skeleton's root
  pointer(JOINT + 0x10, DOBJ);
  for (const at of [0x20, 0x24, 0x28]) data.writeFloatBE(1, JOINT + at);
  data.writeFloatBE(2, JOINT + 0x30);  // up by 2
  pointer(DOBJ + 0x0c, POBJ);
  pointer(POBJ + 8, ATTRS);
  data.writeUInt16BE(0x8000, POBJ + 0x0c);  // culls its back
  data.writeUInt16BE(1, POBJ + 0x0e);
  pointer(POBJ + 0x10, LIST);
  data.writeUInt32BE(9, ATTRS);  // position: 16-bit indices of three floats
  data.writeUInt32BE(3, ATTRS + 4);
  data.writeUInt32BE(1, ATTRS + 8);
  data.writeUInt32BE(4, ATTRS + 12);
  data.writeUInt16BE(12, ATTRS + 0x12);
  pointer(ATTRS + 0x14, POSITIONS);
  data.writeUInt32BE(0xff, ATTRS + 0x18);
  data.set([0x90, 0, 3, 0, 0, 0, 1, 0, 2], LIST);  // a triangle of vertices 0, 1, 2
  [[0, 0, 0], [1, 0, 0], [0, 1, 0]].flat().forEach((value, i) => data.writeFloatBE(value, POSITIONS + i * 4));
  pointer(SET, JOINT);
  pointer(SET + 4, ANIMS);
  pointer(MODELS, SET);
  pointer(ROOT, MODELS);
  pointer(ANIMS, ANIM);
  pointer(ANIM + 8, AOBJ);
  data.writeFloatBE(3, AOBJ + 4);
  pointer(AOBJ + 8, FOBJ);
  data.writeUInt32BE(11, FOBJ + 4);  // its keys' length
  data[FOBJ + 0x0c] = 5;  // the X translation
  pointer(FOBJ + 0x10, KEYS);
  // A pack of two linear keys, floats low byte first: 0, then 6 two frames on. As on the
  // disc, the last key's wait is 0: that's what lands a track on its last value.
  data[KEYS] = 0x12;
  data.writeFloatLE(0, KEYS + 1);
  data[KEYS + 5] = 2;
  data.writeFloatLE(6, KEYS + 6);
  data[KEYS + 10] = 0;
  return ROOT;
}

test('a model reads its joints and draws a rigid mesh on its joint', () => {
  const model = hsd.parseModel(pkx(triangleModel));
  assert.equal(model.joints.length, 1);
  assert.deepEqual(model.joints[0].translation, [0, 2, 0]);
  assert.deepEqual(model.draw, [{ parts: [{ joint: 0, weight: 1, inverse: false }], node: null }]);
  assert.deepEqual(model.animations, [3]);
});

test('triangles wind the other way round for WebGL', () => {
  const [shape] = hsd.parseModel(pkx(triangleModel)).shapes;
  assert.deepEqual([...shape.index], [0, 1, 2]);
  assert.deepEqual([...shape.position.subarray(3, 9)], [0, 1, 0, 1, 0, 0]);
  assert.equal(shape.doubleSided, false);
});

test('an animation holds the rest pose where it has no track, and moves where it has', () => {
  const clip = hsd.parseClip(pkx(triangleModel), 0);
  assert.equal(clip.frames, 3);
  assert.equal(clip.fps, 30);
  const x = frame => clip.values[frame * 9 + 6], y = frame => clip.values[frame * 9 + 7];
  assert.deepEqual([x(0), x(1), x(2)], [0, 3, 6]);
  assert.deepEqual([y(0), y(1), y(2)], [2, 2, 2]);
});

// The same, with its material's alpha going from 1 to 0 over the animation (a material track, HSD_A_M_ALPHA):
// how a Battle Revolution model shows one mesh and hides another.
function fadingModel(data, pointer) {
  const root = triangleModel(data, pointer);
  const SET = 0x1a0, MATANIMS = 0x240, MATJOINT = 0x248, MATANIM = 0x258, AOBJ = 0x268, FOBJ = 0x278, KEYS = 0x290;
  pointer(SET + 8, MATANIMS);
  pointer(MATANIMS, MATJOINT);
  pointer(MATJOINT + 8, MATANIM);   // the joint's first display object's material animation
  pointer(MATANIM + 4, AOBJ);   // its own tracks
  data.writeFloatBE(3, AOBJ + 4);
  pointer(AOBJ + 8, FOBJ);
  data.writeUInt32BE(11, FOBJ + 4);
  data[FOBJ + 0x0c] = 10;   // alpha
  pointer(FOBJ + 0x10, KEYS);
  data[KEYS] = 0x12;
  data.writeFloatLE(1, KEYS + 1);
  data[KEYS + 5] = 2;
  data.writeFloatLE(0, KEYS + 6);
  data[KEYS + 10] = 0;
  return root;
}

test('an animation bakes its materials\' alpha, frame by frame, as the game takes it from 1', () => {
  const clip = hsd.parseClip(pkx(fadingModel), 0);
  assert.equal(clip.alphas.length, 1);
  assert.equal(clip.alphas[0].material, 0);
  // The track runs 1 to 0; MObjUpdateFunc sets alpha to 1 - value
  assert.deepEqual([...clip.alphas[0].values], [0, 0.5, 1]);
  assert.deepEqual(hsd.parseClip(pkx(triangleModel), 0).alphas, []);
});

// The triangle with a material: white diffuse, lit, one 8x4 I8 texture laid over it by reflection after lighting
// (EXT), blended half way, and drawn added on top (a PE desc).
function texturedModel(data, pointer) {
  const root = triangleModel(data, pointer);
  const DOBJ = 0x60, MOBJ = 0x2a0, COLORS = 0x2c0, TOBJ = 0x2e0, IMAGE = 0x350, PIXELS = 0x360, PE = 0x380;
  pointer(DOBJ + 8, MOBJ);
  data.writeUInt32BE((1 << 2) | 1 | (1 << 30), MOBJ + 4);  // lit, the material's colour, see-through
  pointer(MOBJ + 8, TOBJ);
  pointer(MOBJ + 0x0c, COLORS);
  pointer(MOBJ + 0x14, PE);
  data.writeUInt32BE(0x808080ff, COLORS);
  data.writeUInt32BE(0xff8000ff, COLORS + 4);
  data.writeFloatBE(0.75, COLORS + 0x0c);
  data.writeFloatBE(1, TOBJ + 0x1c);
  data.writeFloatBE(1, TOBJ + 0x20);
  data.writeUInt32BE(4, TOBJ + 0x0c);  // GX_TG_TEX0
  data[TOBJ + 0x3c] = 2;
  data[TOBJ + 0x3d] = 1;
  data.writeUInt32BE(1 | (1 << 7) | (3 << 16) | (2 << 20), TOBJ + 0x40);  // reflection, after lighting, blend colour and alpha
  data.writeFloatBE(0.5, TOBJ + 0x44);
  pointer(TOBJ + 0x4c, IMAGE);
  pointer(IMAGE, PIXELS);
  data.writeUInt16BE(8, IMAGE + 4);
  data.writeUInt16BE(4, IMAGE + 6);
  data.writeUInt32BE(1, IMAGE + 8);  // I8
  data.fill(0x80, PIXELS, PIXELS + 32);
  data.set([0x31, 0, 0, 0, 1, 4, 1, 5, 3, 7, 0, 7], PE);  // blended, source alpha onto one: added
  return root;
}

test('a material reads its colours, its texture layers and how they mix, and how it lands on the screen', () => {
  const { materials: [material], textures } = hsd.parseModel(pkx(texturedModel));
  assert.equal(material.lit, true);
  assert.equal(material.xlu, true);
  assert.deepEqual(material.diffuse, [1, 128 / 255, 0]);
  assert.equal(material.alpha, 0.75);
  assert.equal(material.layers.length, 1);
  const [layer] = material.layers;
  assert.deepEqual([layer.coord, layer.lightmap, layer.colorOp, layer.alphaOp, layer.blending, layer.repeat], [1, 1 << 7, 3, 2, 0.5, [2, 1]]);
  assert.equal(layer.texture, 0);
  assert.deepEqual([...textures[0].rgba.subarray(0, 4)], [128, 128, 128, 128]);
  assert.deepEqual([material.pe.blendType, material.pe.srcFactor, material.pe.dstFactor, material.pe.alphaCompare0], [1, 4, 1, 7]);
});

// A pkx's own header around a model: the game's load mode, its sleep, wake and blink animations, a motion slot for
// each `slots` entry ([motion type, animation] pairs), and its shiny filter.
function withHeader(file, { refs = [-1, -1, -1], slots = [], shiny = null }) {
  const align = n => (n + 31) & ~31, dat = file.readUInt32BE(0), body = file.subarray(0, 0x40 + align(dat));
  const head = Buffer.concat([body, Buffer.alloc(0x40 + align(dat) - body.length)]), table = Buffer.alloc(align(slots.length * 0xd0)), tail = Buffer.alloc(shiny ? 20 : 0);
  head.writeUInt32BE(slots.length, 8);
  head.writeUInt32BE(5, 0x10);
  head.writeUInt32BE(shiny ? 0x80000000 : 0, 0x14);
  refs.forEach((ref, i) => head.writeInt32BE(ref, 0x18 + i * 4));
  slots.forEach((pairs, slot) => {
    table.writeUInt32BE(pairs.length, slot * 0xd0 + 4);
    pairs.forEach(([type, index], i) => { table.writeUInt32BE(type, slot * 0xd0 + 0x8c + i * 8); table.writeUInt32BE(index, slot * 0xd0 + 0x90 + i * 8); });
  });
  if (shiny) { shiny.route.forEach((channel, i) => tail.writeUInt32BE(channel, i * 4)); tail.writeUInt32BE(shiny.word, 16); }
  return Buffer.concat([head, table, tail]);
}

test('a model\'s header names its battle motions, its blink and its shiny filter', () => {
  const base = pkx(triangleModel);
  // One animation: the idle; the blink names a missing animation and is left out
  const model = hsd.parseModel(withHeader(base, { refs: [-1, -1, 4], slots: [[[0, 0]], [[1, 0]]], shiny: { route: [2, 1, 0, 3], word: 0x7ff27931 } }));
  assert.deepEqual(model.motions, [{ index: 0, kind: 'idle' }]);
  assert.equal(model.blink, -1);
  assert.deepEqual(model.shiny.route, [2, 1, 0, 3]);
  // Its low byte is red's brightness, 0x7F leaving a channel as it is
  assert.deepEqual(model.shiny.scale.map(v => Math.round(v * 255 / 2)), [0x31, 0x79, 0xf2]);
  // A filter that changes nothing is none
  assert.equal(hsd.parseModel(withHeader(base, { shiny: { route: [0, 1, 2, 3], word: 0x7f7f7f7f } })).shiny, null);
  // The eye animations aren't motions, and a slot already named isn't again
  const eyes = hsd.parseModel(withHeader(base, { refs: [0, -1, -1], slots: [[[0, 0]]] }));
  assert.deepEqual([eyes.motions, eyes.sleep], [[], 0]);
  // A file without the game's header has none of these
  assert.deepEqual(hsd.parseModel(base).motions, []);
});

test('a billboard keeps its place and scale and faces the camera', async () => {
  const THREE = await import('../node_modules/three/build/three.module.js');
  const { billboardMatrix } = await import('../src/model-rig.js');
  const view = new THREE.Matrix4().makeRotationY(0.7).scale(new THREE.Vector3(2, 2, 2)).setPosition(1, 2, 3), out = new THREE.Matrix4();
  billboardMatrix(1, false, 0, view, out);
  const e = out.elements, near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-5, `${actual} is not ${expected}`);
  [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 1, 2, 3, 1].forEach((expected, i) => near(e[i], expected));
  // Turning only about Z (RBillboard)
  billboardMatrix(4, false, Math.PI / 2, view, out);
  near(out.elements[1], 2);
  near(out.elements[10], 2);
});

test('parseClip turns down an animation the model lacks', () => {
  assert.throws(() => hsd.parseClip(pkx(triangleModel), 5), /isn't in this Pokémon's model/);
});

test('a damaged model says so', () => {
  assert.throws(() => hsd.parseModel(Buffer.alloc(0x100, 0xff)), /damaged/);
});

test('hermite meets its ends', () => {
  assert.equal(hsd.hermite(1 / 4, 0, 2, 8, 0, 0), 2);
  assert.equal(hsd.hermite(1 / 4, 4, 2, 8, 0, 0), 8);
  assert.equal(hsd.hermite(1 / 4, 2, 2, 8, 0, 0), 5);
});

test('a joint matrix is the game\'s: Z, then Y, then X, with scale on its columns', async () => {
  const { jointMatrix } = await import('../src/model-rig.js');
  const out = { elements: new Array(16).fill(0) };
  jointMatrix([2, 3, 4], [0, 0, Math.PI / 2], [5, 6, 7], null, out);
  const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} is not ${expected}`);
  near(out.elements[1], 2);  // X turns to Y
  near(out.elements[4], -3);  // Y turns to -X
  near(out.elements[10], 4);
  assert.deepEqual(out.elements.slice(12, 15), [5, 6, 7]);
});

test('a parent\'s uneven scale is undone as the game does', async () => {
  const { jointMatrix } = await import('../src/model-rig.js');
  const out = { elements: new Array(16).fill(0) };
  jointMatrix([1, 1, 1], [0, 0, 0], [0, 0, 0], [2, 1, 1], out);
  assert.equal(out.elements[5], 1);
  assert.equal(out.elements[0], 1);
});

// --- The Pokédex ---------------------------------------------------------------------

test('names read as players know them', () => {
  assert.equal(pokedex.displayName('BULBASAUR'), 'Bulbasaur');
  assert.equal(pokedex.displayName('MR. MIME'), 'Mr. Mime');
  assert.equal(pokedex.displayName('HO-OH'), 'Ho-Oh');
  assert.equal(pokedex.displayName("FARFETCH'D"), "Farfetch'd");
  assert.equal(pokedex.displayName('NIDORAN♀'), 'Nidoran♀');
  assert.equal(pokedex.displayName('PORYGON2'), 'Porygon2');
});

test('message text skips the game\'s control codes', () => {
  const data = Buffer.alloc(12);
  data.writeUInt16BE(0x41, 0);
  data.writeUInt16BE(0xffff, 2);
  data[4] = 0x07;
  data.writeUInt16BE(0x42, 5);
  assert.equal(pokedex.messageText(data, 0), 'AB');
});

function species(id, name, evolutions = []) { return { id, name, evolutions }; }

test('how a Pokémon can be had follows the teams and its evolutions', () => {
  const list = [species(10, 'Shadow one', [11]), species(11, 'Its evolution', [12]), species(12, 'Evolved again'), species(13, 'On a team', [14]), species(14, 'Nowhere'), species(196, 'Espeon')];
  pokedex.classify(list, { seen: new Set([10, 13]), shadow: new Set([10]) });
  assert.deepEqual(list.map(entry => entry.status.kind), ['shadow', 'evolve', 'evolve', 'battle', 'hidden', 'gift']);
  assert.deepEqual(list.map(entry => entry.status.locked), [false, false, false, true, true, false]);
  assert.equal(list[2].status.note, 'Evolve Its evolution to get it.');
  assert.equal(list[5].status.note, pokedex.GIFTS[196]);
});

test('a Pokémon on a team stays locked when only its evolution can be had', () => {
  const list = [species(20, 'Baby', [21]), species(21, 'Grown')];
  pokedex.classify(list, { seen: new Set([20]), shadow: new Set([21]) });
  assert.deepEqual(list.map(entry => entry.status.kind), ['battle', 'shadow']);
});

test('the bonus disc\'s gifts stay locked, and say why', () => {
  const list = [species(25, 'Pikachu'), species(251, 'Celebi')];
  pokedex.classify(list, { seen: new Set([25]), shadow: new Set() });
  assert.deepEqual(list.map(entry => entry.status.kind), ['battle', 'hidden']);
  assert.match(list[0].status.note, /Japanese bonus disc/);
  assert.match(list[1].status.note, /Japanese bonus disc/);
});

test('a sprite is a real PNG', () => {
  const file = pokedex.png(2, 1, Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8));
  assert.equal(file.toString('latin1', 1, 4), 'PNG');
  assert.equal(file.readUInt32BE(16), 2);
  assert.equal(file.readUInt32BE(20), 1);
  const at = file.indexOf('IDAT'), length = file.readUInt32BE(at - 4);
  assert.deepEqual([...zlib.inflateSync(file.subarray(at + 4, at + 4 + length))], [0, 1, 2, 3, 4, 5, 6, 7, 8]);
});

// --- The real disc: COLO_TEST_DISC=/path/to/GC6E01.iso npm test --------------------------

const disc = process.env.COLO_TEST_DISC;
const withDisc = { skip: disc && fs.existsSync(disc) ? false : 'set COLO_TEST_DISC to your disc to run this' };

test('the disc holds every Pokémon, each with a model', withDisc, () => {
  const list = pokedex.readPokedex(disc), count = kind => list.filter(entry => entry.status.kind === kind).length;
  assert.equal(list.length, 386);
  assert.deepEqual(list.map(entry => entry.national), Array.from({ length: 386 }, (_, i) => i + 1));
  assert.deepEqual(list.filter(entry => !entry.forms.length), []);
  assert.deepEqual(list.filter(entry => !entry.sprite), []);
  assert.equal(count('shadow'), 48);
  assert.equal(count('gift'), 4);
  const find = name => list.find(entry => entry.name === name);
  assert.equal(find('Haunter').forms[0].id, 'ghost');  // its row's name key is wrong in the game
  assert.equal(find('Unown').forms.length, 28);
  assert.deepEqual(find('Castform').forms.map(form => form.label), ['Normal', 'Shiny', 'Sunny', 'Rainy', 'Snowy']);
  // A shiny look: Charizard's own model, Bulbasaur's colour filter
  assert.equal(find('Charizard').forms[1].id, 'rare_lizardon');
  assert.equal(find('Bulbasaur').forms[1].id, 'shiny:fushigidane');
  assert.deepEqual(find('Bulbasaur').stats, [45, 49, 49, 65, 65, 45]);
  assert.deepEqual(find('Bulbasaur').abilities, ['Overgrow']);
  assert.equal(find('Bulbasaur').status.kind, 'hidden');
  assert.equal(find('Espeon').status.kind, 'gift');
  assert.equal(find('Meganium').status.kind, 'evolve');
});

test('every look of every Pokémon parses, with all its motions', withDisc, () => {
  const dex = pokedex.create();
  for (const entry of dex.list(disc)) {
    for (const form of entry.forms) {
      const model = dex.model(disc, entry.national, form.id);
      assert.ok(model.shapes.length, form.id);
      for (const shape of model.shapes) assert.ok(shape.position.every(Number.isFinite), form.id);
      model.animations.forEach((_, index) => assert.ok(dex.clip(disc, entry.national, form.id, index).values.every(Number.isFinite), `${form.id} ${index}`));
    }
  }
});

test('the disc\'s models read as the game draws them', withDisc, () => {
  const dex = pokedex.create(), model = (national, form) => dex.model(disc, national, form);
  // Gastly's gas faces the camera; Onix's rock holds normals with binormals and tangents
  assert.equal(model(92, 'ghos').joints.filter(joint => joint.billboard).length, 2);
  assert.ok(model(95, 'iwark').shapes.some(shape => shape.binormal));
  // Exeggutor idles in its fourth animation; the first three are its eyes and a held pose
  assert.deepEqual(model(103, 'nassy').motions[0], { index: 3, kind: 'idle' });
  assert.equal(model(124, 'rougela').blink, 8);
  // Ditto's colour is a reflection laid over it after lighting
  assert.equal(model(132, 'metamon').materials.at(-1).layers[0].coord, 1);
  const shiny = model(1, 'shiny:fushigidane');
  assert.equal(shiny.shinyFilter, true);
  assert.ok(shiny.shiny);
});

test('a form the Pokémon does not have is turned down', withDisc, () => {
  assert.throws(() => pokedex.create().model(disc, 1, '../common'), /no such model/);
});
