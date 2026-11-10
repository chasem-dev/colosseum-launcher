'use strict';

// A Pokémon's model from its pkx file: a 0x40-byte header, then a HAL sysdolphin (HSD)
// file whose scene_data root holds the joints, meshes, materials and animations. What
// it returns is drawn by model-rig.js.
const gx = require('./gx-texture');

const PKX_HEADER = 0x40;

// JObj flags
const SKELETON = 1 << 0, SKELETON_ROOT = 1 << 1, CLASSICAL_SCALE = 1 << 3, HIDDEN = 1 << 4, PARTICLE = 1 << 5, SPLINE = 1 << 14;
// PObj flags
const POBJ_TYPE = 0x3000, POBJ_ENVELOPE = 0x2000, CULL_FRONT = 0x4000, CULL_BACK = 0x8000;
// MObj render mode
const RENDER_DIFFUSE_VERTEX = 1 << 1, RENDER_XLU = 1 << 30;
// TObj flags
const COORD_MASK = 0x0f, COORD_UV = 0, COLORMAP_MASK = 0x0f << 16, COLORMAP_ALPHA_MASK = 1 << 16, COLORMAP_MODULATE = 4 << 16, LIGHTMAP_MASK = 0xf0, LIGHTMAP_DIFFUSE = 1 << 4;
// GX vertex attributes, and how a vertex holds each
const VA_PNMTXIDX = 0, VA_TEX7MTXIDX = 8, VA_POS = 9, VA_NRM = 10, VA_CLR0 = 11, VA_CLR1 = 12, VA_TEX0 = 13, VA_TEX7 = 20, VA_NULL = 0xff;
const DIRECT = 1, INDEX8 = 2, INDEX16 = 3;
const GX_TEXCOORD_SOURCE0 = 4, GX_MIRROR = 2;
// Display list primitives
const QUADS = 0x80, TRIANGLES = 0x90, STRIP = 0x98, FAN = 0xa0;
// Animation tracks. What each sets, in a joint's nine values: scale, rotation, translation.
const TRACK_CHANNEL = { 1: 3, 2: 4, 3: 5, 5: 6, 6: 7, 7: 8, 8: 0, 9: 1, 10: 2 };
// What a texture track sets, of a material's translation and scale.
const TEXTURE_CHANNEL = { 2: 0, 3: 1, 4: 2, 5: 3 };
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

// The layer of a material that its colour comes from: a texture on the mesh's own
// coordinates, not a reflection or a mask.
function pickLayer(dat, material) {
  for (let at = dat.pointer(material + 8); at; at = dat.pointer(at + 4)) {
    const flags = dat.u32(at + 0x40);
    if ((flags & COORD_MASK) !== COORD_UV || (flags & COLORMAP_MASK) === COLORMAP_ALPHA_MASK) continue;
    if ((flags & LIGHTMAP_MASK) && !(flags & LIGHTMAP_DIFFUSE)) continue;
    if (dat.pointer(at + 0x4c)) return at;
  }
  return 0;
}

function readMaterial(dat, at, textures, cache) {
  const blank = { texture: -1, source: 0, diffuse: [1, 1, 1], alpha: 1, translucent: false, vertexColors: false, tint: false,
    translate: [0, 0], scale: [1, 1], repeat: [1, 1], mirrorT: false };
  if (!at) return blank;
  const colors = dat.pointer(at + 0x0c), mode = dat.u32(at + 4), alpha = colors ? dat.f32(colors + 0x0c) : 1;
  const material = { ...blank, alpha, translucent: Boolean(mode & RENDER_XLU) || alpha < 1, vertexColors: Boolean(mode & RENDER_DIFFUSE_VERTEX) };
  if (colors) material.diffuse = [dat.u8(colors + 4) / 255, dat.u8(colors + 5) / 255, dat.u8(colors + 6) / 255];
  const layer = pickLayer(dat, at);
  if (!layer) return material;
  material.texture = readTexture(dat, layer, textures, cache);
  material.source = Math.max(dat.u32(layer + 0x0c) - GX_TEXCOORD_SOURCE0, 0);
  material.tint = (dat.u32(layer + 0x40) & COLORMAP_MASK) === COLORMAP_MODULATE;
  material.translate = [dat.f32(layer + 0x28), dat.f32(layer + 0x2c)];
  material.scale = [dat.f32(layer + 0x1c), dat.f32(layer + 0x20)];
  material.repeat = [dat.u8(layer + 0x3c), dat.u8(layer + 0x3d)];
  material.mirrorT = dat.u32(layer + 0x38) === GX_MIRROR;
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
  if (attribute.name === VA_NRM) return attribute.components === 0 ? 3 : 9;
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
  const position = find(VA_POS), normal = find(VA_NRM), matrix = find(VA_PNMTXIDX), color = find(VA_CLR0);
  const uvAttribute = find(VA_TEX0 + material.source);
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

  const vertices = new Map(), positions = [], normals = [], uvs = [], colors = [], draws = [], index = [];
  const { data } = dat, positionAttribute = attributes[position], normalAttribute = attributes[normal], uvAttr = attributes[uvAttribute], colorAttribute = attributes[color];
  const positionSize = COMPONENT_SIZE[positionAttribute.type], normalSize = normalAttribute ? COMPONENT_SIZE[normalAttribute.type] : 0;
  const add = vertex => {
    const key = vertex.join(',');
    const known = vertices.get(key);
    if (known !== undefined) return known;
    const id = draws.length, at = vertex[position];
    for (let k = 0; k < 3; k++) positions.push(k < positionCount(positionAttribute) ? component(data, at + k * positionSize, positionAttribute.type, positionAttribute.scale) : 0);
    if (normalAttribute) for (let k = 0; k < 3; k++) normals.push(component(data, vertex[normal] + k * normalSize, normalAttribute.type, normalAttribute.scale));
    else normals.push(0, 1, 0);
    let u = 0, v = 0;
    if (uvAttr) {
      const size = COMPONENT_SIZE[uvAttr.type];
      u = component(data, vertex[uvAttribute], uvAttr.type, uvAttr.scale);
      v = uvAttr.components ? component(data, vertex[uvAttribute] + size, uvAttr.type, uvAttr.scale) : 0;
    }
    uvs.push(u, v);
    if (colorAttribute) colors.push(...readColor(data, vertex[color], colorAttribute.type));
    draws.push(drawOf(matrix >= 0 ? vertex[matrix] : undefined));
    vertices.set(key, id);
    return id;
  };
  // The GameCube's triangles wind the other way round from WebGL's.
  for (const [a, b, c] of triangles) index.push(add(a), add(c), add(b));

  return { position: Float32Array.from(positions), normal: Float32Array.from(normals), uv: Float32Array.from(uvs),
    color: colorAttribute && material.vertexColors ? Float32Array.from(colors) : null,
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
  const textures = textureRoot ? bakeTextureTracks(dat, joints, firstJoint, textureRoot, frames) : { tracks: [], materials: [] };
  for (let frame = 0; frame < frames; frame++) {
    for (const track of tracks) track.advance(frame ? 1 : 0);
    values.set(current, frame * jointCount * 9);
    for (const track of textures.tracks) track.advance(frame ? 1 : 0);
    for (const material of textures.materials) material.values.set(material.current, frame * 4);
  }
  return { frames, fps: FRAME_RATE, values, materials: textures.materials.map(({ material, values: tracked }) => ({ material, values: tracked })) };
}

// The tracks that move the materials' textures: the game slides a face along a strip
// of expressions this way. The material animation's tree has the joints' shape, and
// each joint's list has its display objects' order.
function bakeTextureTracks(dat, joints, firstJoint, root, frames) {
  const ownerMaterials = new Map(), materials = new Map(), tracks = [];
  eachDisplayObject(dat, joints, (dobj, _owner, at, index) => ownerMaterials.set(dobj, { at, index }));
  const addTrack = (dobj, textureAnimation) => {
    const known = ownerMaterials.get(dobj), aobj = dat.pointer(textureAnimation + 8);
    if (!known || !aobj) return;
    const layer = pickLayer(dat, known.at);
    if (!layer || dat.u32(layer + 8) !== dat.u32(textureAnimation + 4)) return;
    if (!materials.has(known.index)) materials.set(known.index, { material: known.index, values: new Float32Array(frames * 4),
      current: Float32Array.of(dat.f32(layer + 0x28), dat.f32(layer + 0x2c), dat.f32(layer + 0x1c), dat.f32(layer + 0x20)) });
    const { current } = materials.get(known.index);
    for (let at = dat.pointer(aobj + 8); at; at = dat.pointer(at)) {
      const slot = TEXTURE_CHANNEL[dat.u8(at + 0x0c)], data = dat.pointer(at + 0x10);
      if (slot === undefined || !data) continue;
      tracks.push(new Track(dat.data, data, dat.u32(at + 4), dat.f32(at + 8), dat.u8(at + 0x0d), dat.u8(at + 0x0e), value => { current[slot] = value; }));
    }
  };
  const walk = (start, jointStart) => {
    for (let anim = start, joint = jointStart; anim && joint; anim = dat.pointer(anim + 4), joint = dat.pointer(joint + 0x0c)) {
      for (let item = dat.pointer(anim + 8), dobj = dat.pointer(joint + 0x10); item && dobj; item = dat.pointer(item), dobj = dat.pointer(dobj + 4))
        for (let texture = dat.pointer(item + 8); texture; texture = dat.pointer(texture)) addTrack(dobj, texture);
      walk(dat.pointer(anim), dat.pointer(joint + 8));
    }
  };
  walk(root, firstJoint);
  return { tracks, materials: [...materials.values()] };
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

// The model as model-rig.js draws it, with each animation's length.
function parseModel(pkx) {
  const { dat, set, firstJoint } = open(pkx);
  const { joints, byOffset } = readJoints(dat, firstJoint);
  const table = makeDrawTable(), textures = [];
  const { shapes, materials } = readShapes(dat, { joints, byOffset }, table, textures);
  if (!shapes.length) throw new Error('A Pokémon\'s model has nothing to draw.');
  return { joints: joints.map(({ parent, flags, scale, rotation, translation }) => ({ parent, classicalScale: Boolean(flags & CLASSICAL_SCALE), scale, rotation, translation })),
    inverseBind: joints.map(joint => joint.inverseBind), draw: table.draw, shapes, materials, textures,
    animations: readClipRoots(dat, set).map(root => Math.ceil(clipLength(dat, root))) };
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
