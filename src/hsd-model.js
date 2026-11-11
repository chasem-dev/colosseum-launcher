'use strict';

// A Pokémon's model from its pkx file: a 0x40-byte header, then a HAL sysdolphin (HSD)
// file whose scene_data root holds the joints, meshes, materials and animations. What
// it returns is drawn by model-rig.js.
const gx = require('./gx-texture');

const PKX_HEADER = 0x40;

// JObj flags
const SKELETON = 1 << 0, SKELETON_ROOT = 1 << 1, CLASSICAL_SCALE = 1 << 3, HIDDEN = 1 << 4, PARTICLE = 1 << 5, SPLINE = 1 << 14;
const BILLBOARD_SHIFT = 9, BILLBOARD_MASK = 7, PERSPECTIVE_BILLBOARD = 1 << 13;
// PObj flags
const POBJ_TYPE = 0x3000, POBJ_ENVELOPE = 0x2000, CULL_FRONT = 0x4000, CULL_BACK = 0x8000;
// MObj render mode: where the diffuse colour and the alpha come from (1 the material, 2 the vertices, 3 both), lit or
// not, specular, and how it's drawn (src/hsd/mobj.c MObjMakeTExp, state.c HSD_SetupPEMode in the decompilation)
const RENDER_DIFFUSE_BITS = 3, RENDER_LIT = 1 << 2, RENDER_SPECULAR = 1 << 3, RENDER_ALPHA_SHIFT = 13, RENDER_ZMODE_ALWAYS = 1 << 27,
  RENDER_NO_ZUPDATE = 1 << 29, RENDER_XLU = 1 << 30;
// TObj flags
const COORD_MASK = 0x0f, COORD_UV = 0, COORD_REFLECTION = 1, COORD_HILIGHT = 2, LIGHTMAP_MASK = 0x1f0, TEX_BUMP = 1 << 24;
const LIGHTMAP_DIFFUSE = 1 << 4, LIGHTMAP_SPECULAR = 1 << 5, LIGHTMAP_AMBIENT = 1 << 6, LIGHTMAP_EXT = 1 << 7;
// GX vertex attributes, and how a vertex holds each
const VA_PNMTXIDX = 0, VA_TEX7MTXIDX = 8, VA_POS = 9, VA_NRM = 10, VA_CLR0 = 11, VA_CLR1 = 12, VA_TEX0 = 13, VA_TEX7 = 20, VA_NBT = 25, VA_NULL = 0xff;
const DIRECT = 1, INDEX8 = 2, INDEX16 = 3;
const GX_TEXCOORD_SOURCE0 = 4, GX_MIRROR = 2;
// Display list primitives
const QUADS = 0x80, TRIANGLES = 0x90, STRIP = 0x98, FAN = 0xa0;
// Animation tracks. What each sets, in a joint's nine values: scale, rotation, translation.
const TRACK_CHANNEL = { 1: 3, 2: 4, 3: 5, 5: 6, 6: 7, 7: 8, 8: 0, 9: 1, 10: 2 };
// What a texture track sets, of a material's translation and scale.
const TEXTURE_CHANNEL = { 2: 0, 3: 1, 4: 2, 5: 3 };
// A material track that sets its alpha (HSD_A_M_ALPHA): a Battle Revolution model shows and hides meshes this way.
const MATERIAL_ALPHA = 10;
const MIN_SCALE = 0.001, MAX_FRAMES = 1200, FRAME_RATE = 30;

class Dat {
  constructor(file) {
    if (file.length < 0x20) throw new Error('A model file ended early.');
    const size = file.readUInt32BE(0), dataSize = file.readUInt32BE(4), relocations = file.readUInt32BE(8);
    const roots = file.readUInt32BE(12), references = file.readUInt32BE(16);
    const table = 0x20 + dataSize + relocations * 4;
    if (size > file.length || table + (roots + references) * 8 > file.length) throw new Error('A model file is damaged.');
    this.data = file.subarray(0x20, 0x20 + dataSize);
    this.pointers = new Set();
    for (let i = 0; i < relocations; i++) this.pointers.add(file.readUInt32BE(0x20 + dataSize + i * 4));
    this.roots = new Map();
    const strings = table + (roots + references) * 8;
    for (let i = 0; i < roots; i++) {
      const name = strings + file.readUInt32BE(table + i * 8 + 4);
      this.roots.set(file.toString('latin1', name, file.indexOf(0, name)), file.readUInt32BE(table + i * 8));
    }
  }
  u8(at) { return this.data[at]; }
  u16(at) { return this.data.readUInt16BE(at); }
  u32(at) { return this.data.readUInt32BE(at); }
  f32(at) { return this.data.readFloatBE(at); }
  // A pointer in the file: only words in its relocation table are, and null is 0.
  pointer(at) { return this.pointers.has(at) ? this.data.readUInt32BE(at) : 0; }
  // The pointers of a null-ended list.
  list(at) {
    const items = [];
    if (at) for (let item; (item = this.pointer(at + items.length * 4));) items.push(item);
    return items;
  }
}

// --- Joints --------------------------------------------------------------------------

// A column-major 4x4 from a row-major 3x4 matrix in the file.
function matrixAt(dat, at) {
  const m = new Float32Array(16);
  for (let row = 0; row < 3; row++) for (let column = 0; column < 4; column++) m[column * 4 + row] = dat.f32(at + (row * 4 + column) * 4);
  m[15] = 1;
  return m;
}

function readJoints(dat, first) {
  const joints = [], byOffset = new Map();
  const walk = (start, parent) => {
    for (let at = start; at; at = dat.pointer(at + 0x0c)) {
      const index = joints.length, inverse = dat.pointer(at + 0x38);
      joints.push({ offset: at, parent, flags: dat.u32(at + 4),
        scale: [dat.f32(at + 0x20), dat.f32(at + 0x24), dat.f32(at + 0x28)],
        rotation: [dat.f32(at + 0x14), dat.f32(at + 0x18), dat.f32(at + 0x1c)],
        translation: [dat.f32(at + 0x2c), dat.f32(at + 0x30), dat.f32(at + 0x34)],
        inverseBind: inverse ? matrixAt(dat, inverse) : null });
      byOffset.set(at, index);
      walk(dat.pointer(at + 0x08), index);
    }
  };
  walk(first, -1);
  return { joints, byOffset };
}

// The nearest joint at or above `index` that is part of a skeleton (HSD_JObjFindSkeleton).
function findSkeleton(joints, index) {
  for (let j = index; j >= 0; j = joints[j].parent) if (joints[j].flags & (SKELETON | SKELETON_ROOT)) return j;
  return -1;
}

// --- Textures and materials ----------------------------------------------------------

function readTexture(dat, at, textures, cache) {
  const image = dat.pointer(at + 0x4c), tlut = dat.pointer(at + 0x50);
  if (!image) return -1;
  const key = `${image}:${tlut}:${dat.u32(at + 0x34)}:${dat.u32(at + 0x38)}`;
  if (cache.has(key)) return cache.get(key);
  const pixels = dat.pointer(image), width = dat.u16(image + 4), height = dat.u16(image + 6), format = dat.u32(image + 8);
  let palette = null, paletteFormat = 0;
  if (tlut) {
    const table = dat.pointer(tlut), count = dat.u16(tlut + 12);
    paletteFormat = dat.u32(tlut + 4);
    palette = dat.data.subarray(table, table + count * 2);
  }
  const data = dat.data.subarray(pixels, pixels + gx.textureSize(format, width, height)), rgba = gx.decode(format, width, height, data, palette, paletteFormat);
  // `disc` is the texture as the disc has it, for finding its HD replacement (texture-pack-lookup.js).
  const index = rgba ? textures.push({ width, height, rgba, wrapS: dat.u32(at + 0x34), wrapT: dat.u32(at + 0x38), disc: { data, format, width, height, palette } }) - 1 : -1;
  cache.set(key, index);
  return index;
}

// A texture layer's own colour stage (HSD_TObjTev): its inputs, ops and three colours, used when `active` says so.
function readTev(dat, at) {
  const bytes = i => dat.u8(at + i), color = i => [bytes(i), bytes(i + 1), bytes(i + 2), bytes(i + 3)].map(v => v / 255);
  return { colorOp: bytes(0), alphaOp: bytes(1), colorBias: bytes(2), alphaBias: bytes(3), colorScale: bytes(4), alphaScale: bytes(5),
    colorClamp: bytes(6), alphaClamp: bytes(7), colorIn: [bytes(8), bytes(9), bytes(10), bytes(11)], alphaIn: [bytes(12), bytes(13), bytes(14), bytes(15)],
    konst: color(16), tev0: color(20), tev1: color(24), active: dat.u32(at + 28) };
}

// A material's texture layers in their order, as the game combines them (TObjMakeTExp): each one's map and
// coordinates, where it goes (its lightmap: diffuse, specular or after lighting), and how it mixes in.
// The texture layers (TObjs) a material draws with, in order: those with an image, on the mesh's coordinates or its
// normals (shadows, toon and gradation: none of the Pokémon have them).
function layerObjects(dat, material) {
  const layers = [];
  for (let at = dat.pointer(material + 8); at; at = dat.pointer(at + 4))
    if ((dat.u32(at + 0x40) & COORD_MASK) <= COORD_HILIGHT && dat.pointer(at + 0x4c)) layers.push(at);
  return layers;
}

function readLayers(dat, material, textures, cache) {
  const layers = [];
  for (const at of layerObjects(dat, material)) {
    const flags = dat.u32(at + 0x40), coord = flags & COORD_MASK, tev = dat.pointer(at + 0x58);
    // -1: a format this can't read, which draws as white
    const texture = readTexture(dat, at, textures, cache);
    layers.push({ texture, id: dat.u32(at + 8), source: Math.max(dat.u32(at + 0x0c) - GX_TEXCOORD_SOURCE0, 0), coord,
      lightmap: flags & LIGHTMAP_MASK, colorOp: (flags >> 16) & 0x0f, alphaOp: (flags >> 20) & 0x0f, bump: Boolean(flags & TEX_BUMP),
      blending: dat.f32(at + 0x44), translate: [dat.f32(at + 0x28), dat.f32(at + 0x2c)], scale: [dat.f32(at + 0x1c), dat.f32(at + 0x20)],
      repeat: [dat.u8(at + 0x3c) || 1, dat.u8(at + 0x3d) || 1], mirrorT: dat.u32(at + 0x38) === GX_MIRROR, tev: tev ? readTev(dat, tev) : null });
  }
  return layers;
}

// How a material is drawn when it says (HSD_PEDesc): blending, depth and alpha test.
function readPixelEngine(dat, at) {
  if (!at) return null;
  const b = i => dat.u8(at + i);
  return { flags: b(0), ref0: b(1), ref1: b(2), blendType: b(4), srcFactor: b(5), dstFactor: b(6), zCompare: b(8),
    alphaCompare0: b(9), alphaOp: b(10), alphaCompare1: b(11) };
}

function readMaterial(dat, at, textures, cache) {
  const material = { lit: false, diffuseSource: 1, alphaSource: 1, specular: false, xlu: false, zUpdate: true, zAlways: false,
    ambient: [0.5, 0.5, 0.5], diffuse: [1, 1, 1], specularColor: [1, 1, 1], alpha: 1, shininess: 50, pe: null, layers: [] };
  if (!at) return material;
  const mode = dat.u32(at + 4), colors = dat.pointer(at + 0x0c), diffuseSource = mode & RENDER_DIFFUSE_BITS || 1;
  Object.assign(material, { lit: Boolean(mode & RENDER_LIT), diffuseSource, alphaSource: (mode >> RENDER_ALPHA_SHIFT) & 3 || diffuseSource,
    specular: Boolean(mode & RENDER_SPECULAR), xlu: Boolean(mode & RENDER_XLU), zUpdate: !(mode & RENDER_NO_ZUPDATE), zAlways: Boolean(mode & RENDER_ZMODE_ALWAYS),
    pe: readPixelEngine(dat, dat.pointer(at + 0x14)), layers: readLayers(dat, at, textures, cache) });
  if (colors) {
    const rgb = from => [dat.u8(from) / 255, dat.u8(from + 1) / 255, dat.u8(from + 2) / 255];
    Object.assign(material, { ambient: rgb(colors), diffuse: rgb(colors + 4), specularColor: rgb(colors + 8),
      alpha: Math.min(1, Math.max(0, dat.f32(colors + 0x0c))), shininess: dat.f32(colors + 0x10) });
  }
  return material;
}

// --- Meshes --------------------------------------------------------------------------

function readAttributes(dat, at) {
  const attributes = [];
  for (let item = at; dat.u32(item) !== VA_NULL; item += 0x18)
    attributes.push({ name: dat.u32(item), kind: dat.u32(item + 4), components: dat.u32(item + 8), type: dat.u32(item + 12),
      scale: 2 ** -dat.u8(item + 0x10), stride: dat.u16(item + 0x12), base: dat.pointer(item + 0x14) });
  return attributes;
}

const COMPONENT_SIZE = [1, 1, 2, 2, 4];
function component(data, at, type, scale) {
  switch (type) {
    case 0: return data.readUInt8(at) * scale;
    case 1: return data.readInt8(at) * scale;
    case 2: return data.readUInt16BE(at) * scale;
    case 3: return data.readInt16BE(at) * scale;
    default: return data.readFloatBE(at);
  }
}

function readColor(data, at, type) {
  switch (type) {
    case 0: { const v = data.readUInt16BE(at); return [(v >> 11) / 31, ((v >> 5) & 63) / 63, (v & 31) / 31, 1]; }
    case 1: case 2: return [data[at] / 255, data[at + 1] / 255, data[at + 2] / 255, 1];
    case 3: { const v = data.readUInt16BE(at); return [(v >> 12) / 15, ((v >> 8) & 15) / 15, ((v >> 4) & 15) / 15, (v & 15) / 15]; }
    case 4: { const v = data.readUIntBE(at, 3); return [(v >> 18) / 63, ((v >> 12) & 63) / 63, ((v >> 6) & 63) / 63, (v & 63) / 63]; }
    default: return [data[at] / 255, data[at + 1] / 255, data[at + 2] / 255, data[at + 3] / 255];
  }
}

const COLOR_SIZE = [2, 3, 4, 2, 3, 4];
function positionCount(attribute) {
  if (attribute.name === VA_POS) return attribute.components === 0 ? 2 : 3;
  if (attribute.name === VA_NRM || attribute.name === VA_NBT) return attribute.components === 0 ? 3 : 9;
  return attribute.components === 0 ? 1 : 2;
}

// One vertex's value of an attribute that holds it directly: how many bytes it takes.
function directSize(attribute) {
  if (attribute.name <= VA_TEX7MTXIDX) return 1;
  if (attribute.name === VA_CLR0 || attribute.name === VA_CLR1) return COLOR_SIZE[attribute.type] || 4;
  return positionCount(attribute) * COMPONENT_SIZE[attribute.type];
}

// The primitives of a mesh's display list, as triangles of vertices. A vertex keeps
// where each attribute's value is: a byte in the file, or a matrix index.
function readTriangles(dat, list, size, attributes) {
  const triangles = [], data = dat.data, end = list + size;
  let at = list;
  const readVertex = () => {
    const vertex = new Array(attributes.length);
    attributes.forEach((attribute, i) => {
      if (attribute.kind === DIRECT) {
        vertex[i] = attribute.name <= VA_TEX7MTXIDX ? data[at] : at;
        at += directSize(attribute);
      } else if (attribute.kind === INDEX8) {
        vertex[i] = attribute.base + data[at] * attribute.stride;
        at += 1;
      } else if (attribute.kind === INDEX16) {
        vertex[i] = attribute.base + data.readUInt16BE(at) * attribute.stride;
        at += 2;
      } else vertex[i] = -1;
    });
    return vertex;
  };
  while (at + 3 <= end) {
    const primitive = data[at] & 0xf8;
    if (!primitive) break;
    const count = data.readUInt16BE(at + 1);
    at += 3;
    const vertices = Array.from({ length: count }, readVertex);
    if (primitive === TRIANGLES) for (let i = 0; i + 2 < count; i += 3) triangles.push([vertices[i], vertices[i + 1], vertices[i + 2]]);
    else if (primitive === STRIP) for (let i = 0; i + 2 < count; i++) triangles.push(i & 1 ? [vertices[i + 1], vertices[i], vertices[i + 2]] : [vertices[i], vertices[i + 1], vertices[i + 2]]);
    else if (primitive === FAN) for (let i = 1; i + 1 < count; i++) triangles.push([vertices[0], vertices[i], vertices[i + 1]]);
    else if (primitive === QUADS) for (let i = 0; i + 3 < count; i += 4) triangles.push([vertices[i], vertices[i + 1], vertices[i + 2]], [vertices[i], vertices[i + 2], vertices[i + 3]]);
  }
  return triangles;
}

// A mesh's envelopes: for each, its joints and how much each counts.
function readEnvelopes(dat, at, byOffset) {
  return dat.list(at).map(envelope => {
    const parts = [];
    for (let item = envelope; dat.pointer(item); item += 8) {
      const joint = byOffset.get(dat.pointer(item));
      if (joint !== undefined) parts.push({ joint, weight: dat.f32(item + 4) });
    }
    return parts;
  });
}

// How a joint places what's skinned to it (SetupEnvelopeModelMtx): a part at full weight
// is in that joint's own frame when the mesh sits on the skeleton's root, and the mesh
// is moved from its own joint to the skeleton's frame when it doesn't.
function nodeOf(joints, owner) {
  if (joints[owner].flags & SKELETON_ROOT) return null;
  const skeleton = findSkeleton(joints, owner);
  if (skeleton < 0) return null;
  return { owner, skeleton, kind: skeleton === owner ? 'bind' : joints[skeleton].flags & SKELETON_ROOT ? 'root' : 'skeleton' };
}

function makeDrawTable() {
  const draw = [], keys = new Map();
  return {
    draw,
    add(parts, node) {
      const key = `${node ? `${node.owner}` : ''}|${parts.map(({ joint, weight, inverse }) => `${joint}:${weight}:${inverse ? 1 : 0}`).join(',')}`;
      if (!keys.has(key)) keys.set(key, draw.push({ parts, node }) - 1);
      return keys.get(key);
    }
  };
}

function readShape(dat, pobj, owner, material, materialIndex, model, table) {
  const attributes = readAttributes(dat, dat.pointer(pobj + 8)), flags = dat.u16(pobj + 0x0c);
  const triangles = readTriangles(dat, dat.pointer(pobj + 0x10), dat.u16(pobj + 0x0e) * 32, attributes);
  if (!triangles.length) return null;
  const find = name => attributes.findIndex(attribute => attribute.name === name);
  const position = find(VA_POS), matrix = find(VA_PNMTXIDX), color = find(VA_CLR0);
  // A bump-mapped mesh holds its normals with binormals and tangents (NBT) instead of alone
  const nbt = find(VA_NRM) < 0 ? find(VA_NBT) : -1, normal = nbt >= 0 ? nbt : find(VA_NRM);
  const bumped = nbt >= 0 && attributes[nbt].components === 1 && material.layers.some(layer => layer.bump);
  // Each texture coordinate set its layers read
  const sources = [...new Set(material.layers.filter(layer => layer.coord === COORD_UV).map(layer => layer.source))];
  if (position < 0) return null;

  const enveloped = (flags & POBJ_TYPE) === POBJ_ENVELOPE, { joints } = model, node = enveloped ? nodeOf(joints, owner) : null;
  const envelopes = enveloped ? readEnvelopes(dat, dat.pointer(pobj + 0x14), model.byOffset) : [];
  const drawOf = pnmtx => {
    if (!enveloped) return table.add([{ joint: owner, weight: 1, inverse: false }], null);
    const parts = envelopes[(pnmtx === undefined ? 0 : pnmtx) / 3 | 0] || [];
    if (!parts.length) return table.add([{ joint: owner, weight: 1, inverse: false }], null);
    // At full weight, a mesh on the skeleton's root is drawn in the joint's frame.
    const single = parts[0].weight >= 1;
    return table.add((single ? parts.slice(0, 1) : parts).map(({ joint, weight }) => ({ joint, weight: single ? 1 : weight, inverse: !(single && !node) })), node);
  };

  const vertices = new Map(), positions = [], normals = [], binormals = [], tangents = [], uvs = sources.map(() => []), colors = [], draws = [], index = [];
  const { data } = dat, positionAttribute = attributes[position], normalAttribute = attributes[normal], colorAttribute = attributes[color];
  const uvAttributes = sources.map(source => find(VA_TEX0 + source));
  const positionSize = COMPONENT_SIZE[positionAttribute.type], normalSize = normalAttribute ? COMPONENT_SIZE[normalAttribute.type] : 0;
  const vector = (at, first) => [0, 1, 2].map(k => component(data, at + (first + k) * normalSize, normalAttribute.type, normalAttribute.scale));
  const add = vertex => {
    const key = vertex.join(',');
    const known = vertices.get(key);
    if (known !== undefined) return known;
    const id = draws.length, at = vertex[position];
    for (let k = 0; k < 3; k++) positions.push(k < positionCount(positionAttribute) ? component(data, at + k * positionSize, positionAttribute.type, positionAttribute.scale) : 0);
    if (normalAttribute) normals.push(...vector(vertex[normal], 0));
    else normals.push(0, 1, 0);
    if (bumped) { binormals.push(...vector(vertex[normal], 3)); tangents.push(...vector(vertex[normal], 6)); }
    uvAttributes.forEach((uvAttribute, i) => {
      const uvAttr = attributes[uvAttribute];
      if (!uvAttr) { uvs[i].push(0, 0); return; }
      const size = COMPONENT_SIZE[uvAttr.type];
      uvs[i].push(component(data, vertex[uvAttribute], uvAttr.type, uvAttr.scale), uvAttr.components ? component(data, vertex[uvAttribute] + size, uvAttr.type, uvAttr.scale) : 0);
    });
    if (colorAttribute) colors.push(...readColor(data, vertex[color], colorAttribute.type));
    draws.push(drawOf(matrix >= 0 ? vertex[matrix] : undefined));
    vertices.set(key, id);
    return id;
  };
  // The GameCube's triangles wind the other way round from WebGL's.
  for (const [a, b, c] of triangles) index.push(add(a), add(c), add(b));

  const usesVertices = (material.diffuseSource | material.alphaSource) & 2;
  return { position: Float32Array.from(positions), normal: Float32Array.from(normals),
    // uv: each coordinate set by its number (TEX0 is 0), for the layers that read it
    uv: Object.fromEntries(sources.map((source, i) => [source, Float32Array.from(uvs[i])])),
    binormal: bumped ? Float32Array.from(binormals) : null, tangent: bumped ? Float32Array.from(tangents) : null,
    color: colorAttribute && usesVertices ? Float32Array.from(colors) : null,
    index: draws.length > 0xffff ? Uint32Array.from(index) : Uint16Array.from(index), drawIndex: Uint16Array.from(draws),
    material: materialIndex, doubleSided: !(flags & (CULL_FRONT | CULL_BACK)) };
}

// Calls `visit` with every drawn joint's display objects, in file order, and the index
// of each one's material: the order hsd-model's meshes and animations both go by.
function eachDisplayObject(dat, joints, visit) {
  const materials = new Map();
  joints.forEach((joint, owner) => {
    if (joint.flags & (SPLINE | PARTICLE | HIDDEN)) return;
    for (let dobj = dat.pointer(joint.offset + 0x10); dobj; dobj = dat.pointer(dobj + 4)) {
      const material = dat.pointer(dobj + 8);
      if (!materials.has(material)) materials.set(material, materials.size);
      visit(dobj, owner, material, materials.get(material));
    }
  });
}

function readShapes(dat, model, table, textures) {
  const shapes = [], materials = [], cache = new Map();
  eachDisplayObject(dat, model.joints, (dobj, owner, at, index) => {
    materials[index] ||= readMaterial(dat, at, textures, cache);
    for (let pobj = dat.pointer(dobj + 0x0c); pobj; pobj = dat.pointer(pobj + 4)) {
      const shape = readShape(dat, pobj, owner, materials[index], index, model, table);
      if (shape) shapes.push(shape);
    }
  });
  return { shapes, materials };
}

// --- Animation -----------------------------------------------------------------------

// One animation track, as the game plays it (HSD_FObjInterpretAnim): a small machine
// that reads keys as time reaches them, calling `update` when the value changes.
class Track {
  constructor(data, at, length, startFrame, fracValue, fracSlope, update) {
    Object.assign(this, { data, ad: at, head: at, length, fracValue, fracSlope, update });
    this.time = Math.trunc(startFrame);
    this.state = 1;
    this.op = this.interpolation = this.pack = this.term = 0;
    this.p0 = this.p1 = this.d0 = this.d1 = 0;
    this.keyPending = this.keyHit = this.slopeDirty = false;
  }
  float(frac) {
    const { data } = this;
    if (frac === 0) { const value = data.readFloatLE(this.ad); this.ad += 4; return value; }
    const denominator = 2 ** (frac & 0x1f);
    switch (frac & 0xe0) {
      case 0x20: { const value = data.readInt16LE(this.ad); this.ad += 2; return value / denominator; }
      case 0x40: { const value = data.readUInt16LE(this.ad); this.ad += 2; return value / denominator; }
      case 0x60: { const value = data.readInt8(this.ad); this.ad += 1; return value / denominator; }
      case 0x80: { const value = data[this.ad]; this.ad += 1; return value / denominator; }
      default: return 0;
    }
  }
  packInfo() {
    let byte = this.data[this.ad++], count = ((byte >> 4) & 7) + 1, shift = 3;
    if (!(byte & 0x80)) return count;
    do {
      byte = this.data[this.ad++];
      count += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    } while (byte & 0x80);
    return count;
  }
  wait() {
    let value = 0, shift = 0, byte;
    do {
      byte = this.data[this.ad++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    } while (byte & 0x80);
    return value;
  }
  launchKey() {
    if (!this.keyPending) return;
    this.interpolation = this.op;
    this.keyPending = false;
    this.keyHit = true;
    this.p0 = this.p1;
  }
  load() {
    if (this.ad - this.head >= this.length) return 6;
    this.interpolation = this.op;
    if (!this.pack) {
      this.op = this.data[this.ad] & 0x0f;
      this.pack = this.packInfo();
    }
    this.pack--;
    const next = this.state === 1 ? 3 : 4;
    switch (this.op) {
      case 1: case 2:
        this.p0 = this.p1;
        this.p1 = this.float(this.fracValue);
        if (this.interpolation !== 5) { this.d0 = this.d1; this.d1 = 0; }
        return (this.state = next);
      case 3:
        this.p0 = this.p1;
        this.d0 = this.d1;
        this.p1 = this.float(this.fracValue);
        this.d1 = 0;
        return (this.state = next);
      case 4:
        this.p0 = this.p1;
        this.p1 = this.float(this.fracValue);
        this.d0 = this.d1;
        this.d1 = this.float(this.fracSlope);
        return (this.state = next);
      case 5:
        this.d0 = this.d1;
        this.d1 = this.float(this.fracSlope);
        return this.state;
      case 6:
        this.launchKey();
        this.p1 = this.float(this.fracValue);
        this.keyPending = true;
        return (this.state = next);
      default:
        return 0;
    }
  }
  emit() {
    const { p0, p1, d0, d1, term, time } = this;
    switch (this.interpolation) {
      case 6:
        if (!this.keyHit) return;
        this.keyHit = false;
        this.update(p0);
        return;
      case 1: this.update(time >= term ? p1 : p0); return;
      case 2:
        if (this.slopeDirty) {
          this.slopeDirty = false;
          if (term) this.d0 = (p1 - p0) / term;
          else { this.d0 = 0; this.p0 = p1; }
        }
        this.update(this.d0 * time + this.p0);
        return;
      case 3: case 4: case 5:
        this.update(term ? hermite(1 / term, time, p0, p1, d0, d1) : p1);
        return;
      default:
    }
  }
  advance(rate) {
    if (!this.state) return;
    this.time += rate;
    if (this.time < 0) return;
    let state = this.state, carry = 0;
    for (;;) {
      switch (state) {
        case 6:
          this.time += carry;
          this.launchKey();
          this.emit();
          this.state = 6;
          return;
        case 1: case 2:
          state = this.load();
          break;
        case 3:
          if (this.keyHit) this.emit();
          if (this.ad - this.head >= this.length) state = 6;
          else {
            this.term = this.wait();
            this.slopeDirty = true;
            state = this.state = 2;
          }
          break;
        case 4:
          if (this.term <= this.time) {
            state = this.state = 3;
            carry = this.term;
            this.time -= this.term;
            break;
          }
          this.emit();
          this.state = 5;
          return;
        case 5:
          state = this.state = 4;
          break;
        default:
          this.state = 0;
          return;
      }
    }
  }
}

function hermite(inverse, time, p0, p1, d0, d1) {
  const squared = time * time, inverse2 = inverse * inverse;
  const a = squared * inverse, b = inverse2 * (squared * time), c = 2 * b * inverse, d = 3 * squared * inverse2;
  return d1 * (b - a) + d0 * (time + (b - a) - a) + p0 * (1 + (c - d)) + p1 * (-c + d);
}

// Every animation of a joint tree: the root of each, and how long it runs.
function readClipRoots(dat, set) {
  return dat.list(dat.pointer(set + 4));
}

function clipLength(dat, root) {
  let length = 0;
  const walk = start => {
    for (let at = start; at; at = dat.pointer(at + 4)) {
      const aobj = dat.pointer(at + 8);
      if (aobj) length = Math.max(length, dat.f32(aobj + 4));
      walk(dat.pointer(at));
    }
  };
  walk(root);
  return length;
}

// An animation's frames: nine values for every joint, as the game's update sets them.
function bakeClip(dat, joints, firstJoint, root, textureRoot) {
  const frames = Math.max(1, Math.min(MAX_FRAMES, Math.ceil(clipLength(dat, root)))), jointCount = joints.length;
  const values = new Float32Array(frames * jointCount * 9);
  joints.forEach((joint, j) => {
    const rest = [...joint.scale, ...joint.rotation, ...joint.translation];
    for (let frame = 0; frame < frames; frame++) values.set(rest, (frame * jointCount + j) * 9);
  });
  const tracks = [], current = new Float32Array(jointCount * 9);
  joints.forEach((joint, j) => current.set([...joint.scale, ...joint.rotation, ...joint.translation], j * 9));
  const addTracks = (joint, anim) => {
    const aobj = dat.pointer(anim + 8);
    if (!aobj) return;
    for (let at = dat.pointer(aobj + 8); at; at = dat.pointer(at)) {
      const channel = TRACK_CHANNEL[dat.u8(at + 0x0c)], data = dat.pointer(at + 0x10);
      if (channel === undefined || !data) continue;
      const slot = joint * 9 + channel, scale = channel < 3;
      tracks.push(new Track(dat.data, data, dat.u32(at + 4), dat.f32(at + 8), dat.u8(at + 0x0d), dat.u8(at + 0x0e), value => {
        current[slot] = scale && Math.abs(value) < MIN_SCALE ? MIN_SCALE : value;
      }));
    }
  };
  // The animation's tree has the joints' shape: walked together, they pair up.
  let next = 0;
  const walk = (start, jointStart) => {
    for (let anim = start, joint = jointStart; anim && joint; anim = dat.pointer(anim + 4), joint = dat.pointer(joint + 0x0c)) {
      addTracks(next++, anim);
      walk(dat.pointer(anim), dat.pointer(joint + 8));
    }
  };
  walk(root, firstJoint);
  const textures = textureRoot ? bakeTextureTracks(dat, joints, firstJoint, textureRoot, frames) : { tracks: [], materials: [], alphas: [] };
  for (let frame = 0; frame < frames; frame++) {
    for (const track of tracks) track.advance(frame ? 1 : 0);
    values.set(current, frame * jointCount * 9);
    for (const track of textures.tracks) track.advance(frame ? 1 : 0);
    for (const material of textures.materials) material.values.set(material.current, frame * 4);
    for (const alpha of textures.alphas) alpha.values[frame] = alpha.current[0];
  }
  return { frames, fps: FRAME_RATE, values, materials: textures.materials.map(({ material, layer, values: tracked }) => ({ material, layer, values: tracked })),
    alphas: textures.alphas.map(({ material, values: tracked }) => ({ material, values: tracked })) };
}

// The tracks that move the materials' textures: the game slides a face along a strip
// of expressions this way. The material animation's tree has the joints' shape, and
// each joint's list has its display objects' order.
function bakeTextureTracks(dat, joints, firstJoint, root, frames) {
  const ownerMaterials = new Map(), materials = new Map(), alphas = new Map(), tracks = [];
  eachDisplayObject(dat, joints, (dobj, _owner, at, index) => ownerMaterials.set(dobj, { at, index }));
  const addTrack = (dobj, textureAnimation) => {
    const known = ownerMaterials.get(dobj), aobj = dat.pointer(textureAnimation + 8);
    if (!known || !aobj) return;
    // The layer it moves: the one whose texture map is the animation's (lookupTextureAnim)
    const layers = layerObjects(dat, known.at), index = layers.findIndex(at => dat.u32(at + 8) === dat.u32(textureAnimation + 4));
    if (index < 0) return;
    const layer = layers[index], key = `${known.index}:${index}`;
    if (!materials.has(key)) materials.set(key, { material: known.index, layer: index, values: new Float32Array(frames * 4),
      current: Float32Array.of(dat.f32(layer + 0x28), dat.f32(layer + 0x2c), dat.f32(layer + 0x1c), dat.f32(layer + 0x20)) });
    const { current } = materials.get(key);
    for (let at = dat.pointer(aobj + 8); at; at = dat.pointer(at)) {
      const slot = TEXTURE_CHANNEL[dat.u8(at + 0x0c)], data = dat.pointer(at + 0x10);
      if (slot === undefined || !data) continue;
      tracks.push(new Track(dat.data, data, dat.u32(at + 4), dat.f32(at + 8), dat.u8(at + 0x0d), dat.u8(at + 0x0e), value => { current[slot] = value; }));
    }
  };
  // The material's own tracks (its animation at +4): its alpha, on each frame, as the game sets it
  const addAlpha = (dobj, item) => {
    const known = ownerMaterials.get(dobj), aobj = dat.pointer(item + 4);
    if (!known || !aobj) return;
    for (let at = dat.pointer(aobj + 8); at; at = dat.pointer(at)) {
      const data = dat.pointer(at + 0x10);
      if (dat.u8(at + 0x0c) !== MATERIAL_ALPHA || !data) continue;
      if (!alphas.has(known.index)) alphas.set(known.index, { material: known.index, values: new Float32Array(frames).fill(1), current: Float32Array.of(1) });
      const { current } = alphas.get(known.index);
      // The game takes the track's value from 1 (MObjUpdateFunc): 0 is solid, 1 clear
      tracks.push(new Track(dat.data, data, dat.u32(at + 4), dat.f32(at + 8), dat.u8(at + 0x0d), dat.u8(at + 0x0e), value => { current[0] = Math.min(1, Math.max(0, 1 - value)); }));
    }
  };
  const walk = (start, jointStart) => {
    for (let anim = start, joint = jointStart; anim && joint; anim = dat.pointer(anim + 4), joint = dat.pointer(joint + 0x0c)) {
      for (let item = dat.pointer(anim + 8), dobj = dat.pointer(joint + 0x10); item && dobj; item = dat.pointer(item), dobj = dat.pointer(dobj + 4)) {
        for (let texture = dat.pointer(item + 8); texture; texture = dat.pointer(texture)) addTrack(dobj, texture);
        addAlpha(dobj, item);
      }
      walk(dat.pointer(anim), dat.pointer(joint + 8));
    }
  };
  walk(root, firstJoint);
  return { tracks, materials: [...materials.values()], alphas: [...alphas.values()] };
}

// --- The model -----------------------------------------------------------------------

function open(pkx) {
  const size = pkx.readUInt32BE(0);
  if (pkx.length < PKX_HEADER + 0x20 || PKX_HEADER + size > pkx.length) throw new Error('A Pokémon\'s model file is damaged.');
  const dat = new Dat(pkx.subarray(PKX_HEADER, PKX_HEADER + size)), scene = dat.roots.get('scene_data');
  if (scene === undefined) throw new Error('A Pokémon\'s model file has no scene.');
  const set = dat.list(dat.pointer(scene))[0];
  if (!set) throw new Error('A Pokémon\'s model file has no model.');
  return { dat, set, firstJoint: dat.pointer(set) };
}

// --- The pkx's own header ---------------------------------------------------------
// What the game reads around the model (sequence.c fn_801DD5E8 in the decompilation): a 0x40-byte header, the model,
// its particles, then a 0xD0-byte entry for each battle motion slot, then the shiny colour filter.
const LOAD_MODE = 5, SLOT_SIZE = 0xd0, SLOT_MOTIONS = 0x8c, SHINY_SIZE = 0x14, HAS_SHINY = 0x80000000;
// The slots, in order: idle, a special move, four physical moves, a special move, a physical move, hit, hit then
// faint, faint, then extras. Read with the hit-then-faint slot last, so each motion is named by a slot of its own.
const SLOT_KIND = ['idle', 'special', 'physical', 'physical', 'physical', 'physical', 'special', 'physical', 'hit', 'extra', 'faint'];
const SLOT_ORDER = [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 9];
const align32 = n => (n + 31) & ~31;

function readHeader(pkx, animationCount) {
  const header = { motions: [], sleep: -1, wake: -1, blink: -1, shiny: null };
  if (pkx.length < PKX_HEADER || pkx.readUInt32BE(0x10) !== LOAD_MODE) return header;
  const ref = at => { const value = pkx.readInt32BE(at); return value >= 0 && value < animationCount ? value : -1; };
  Object.assign(header, { sleep: ref(0x18), wake: ref(0x1c), blink: ref(0x20) });
  const count = pkx.readUInt32BE(8), slots = PKX_HEADER + align32(pkx.readUInt32BE(0)) + align32(pkx.readUInt32BE(4));
  if (count > 32 || slots + count * SLOT_SIZE > pkx.length) return header;
  // Each slot's motions, the first time one is named: Colosseum marks a slot in use with motion type 0
  const overlays = new Set([header.sleep, header.wake, header.blink]), seen = new Set();
  for (let i = 0; i < count; i++) {
    const slot = SLOT_ORDER[i] ?? i, at = slots + slot * SLOT_SIZE, n = Math.min(pkx.readUInt32BE(at + 4), 8);
    for (let k = 0; k < n; k++) {
      const type = pkx.readUInt32BE(at + SLOT_MOTIONS + k * 8), index = pkx.readUInt32BE(at + SLOT_MOTIONS + k * 8 + 4);
      if (type || index >= animationCount || seen.has(index) || overlays.has(index)) continue;
      seen.add(index);
      header.motions.push({ index, kind: SLOT_KIND[slot] || 'extra' });
    }
  }
  // The shiny filter (fn_801DCE0C): which channel each of red, green, blue and alpha reads, and a brightness to scale
  // red, green and blue by twice over (its low byte is red). A model with its own shiny model doesn't use it.
  const shiny = slots + align32(count * SLOT_SIZE);
  if ((pkx.readUInt32BE(0x14) & HAS_SHINY) && shiny + SHINY_SIZE <= pkx.length) {
    const route = [0, 1, 2, 3].map(i => pkx.readUInt32BE(shiny + i * 4) & 3), word = pkx.readUInt32BE(shiny + 0x10);
    const scale = [word & 0xff, (word >> 8) & 0xff, (word >> 16) & 0xff].map(v => v / 255 * 2);
    const plain = route.every((channel, i) => channel === i) && [word & 0xff, (word >> 8) & 0xff, (word >> 16) & 0xff].every(v => v === 0x7f);
    if (!plain) header.shiny = { route, scale };
  }
  return header;
}

// The model as model-rig.js draws it, with each animation's length, its battle motions, the eye animations the
// game plays over them (sleep, wake and blink), and its shiny filter.
function parseModel(pkx) {
  const { dat, set, firstJoint } = open(pkx);
  const { joints, byOffset } = readJoints(dat, firstJoint);
  const table = makeDrawTable(), textures = [];
  const { shapes, materials } = readShapes(dat, { joints, byOffset }, table, textures);
  if (!shapes.length) throw new Error('A Pokémon\'s model has nothing to draw.');
  const animations = readClipRoots(dat, set).map(root => Math.ceil(clipLength(dat, root)));
  return { joints: joints.map(({ parent, flags, scale, rotation, translation }) => ({ parent, classicalScale: Boolean(flags & CLASSICAL_SCALE), scale, rotation, translation,
      // a joint whose meshes face the camera (displayfunc.c mkBillBoardMtx): 1 all round, 2 upright, 3 level, 4 turning in the view
      billboard: (flags >> BILLBOARD_SHIFT) & BILLBOARD_MASK, perspective: Boolean(flags & PERSPECTIVE_BILLBOARD) })),
    inverseBind: joints.map(joint => joint.inverseBind), draw: table.draw, shapes, materials, textures, animations, ...readHeader(pkx, animations.length) };
}

// One of the model's animations, baked to frames.
function parseClip(pkx, index) {
  const { dat, set, firstJoint } = open(pkx);
  const roots = readClipRoots(dat, set);
  if (!roots[index]) throw new Error('That animation isn\'t in this Pokémon\'s model.');
  const { joints } = readJoints(dat, firstJoint);
  return bakeClip(dat, joints, firstJoint, roots[index], dat.list(dat.pointer(set + 8))[index] || 0);
}

module.exports = { parseModel, parseClip, hermite };
