'use strict';

// Each game's title logo, read from the player's own disc, for the Play page: the picture the game's title screen
// shows, with transparency around it. The launcher ships none of it; main.js caches what it reads in userData.
//
// - Colosseum's is one texture of its title scene (title.fsys logo_demo, a model file): a 540x224 RGBA8 picture,
//   drawn as it is. The European disc's has TM after "Pokémon" for the North American ®, the same in every language
//   (title_fr/ge/it/sp.fsys hold the same logo_demo), and the language packs leave it alone.
// - XD's is put together by its title menu, a Flash movie (title.fsys title_start_00, menuTitle.cpp; the player is
//   pxdvs/app/flashmenu): bitmaps on quads, placed, scaled and faded frame by frame. The logo stands complete on the
//   frame before the label "back", before PRESS START and the copyright come in, and that frame is drawn here as the
//   game draws it (vecGraph.cpp SpriteCode, SpriteDisp, getUV).

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Disc } = require('./disc');
const games = require('./games');
const fsys = require('./fsys');
const gx = require('./gx-texture');
const { png } = require('./pokedex');
const texturePackLookup = require('./texture-pack-lookup');

// --- Colosseum -------------------------------------------------------------------

// The textures of a model file (HSD .dat), each once: { width, height, rgba, disc }.
function datTextures(file) {
  if (file.length < 0x20) return [];
  const dataSize = file.readUInt32BE(4), relocations = file.readUInt32BE(8);
  if (0x20 + dataSize + relocations * 4 > file.length) return [];
  const data = file.subarray(0x20, 0x20 + dataSize), pointers = new Set();
  for (let i = 0; i < relocations; i++) pointers.add(file.readUInt32BE(0x20 + dataSize + i * 4));
  const textures = [], seen = new Set();
  // A texture object (TObj) points at its image at +0x4C and its palette at +0x50; an image is a pointer to its
  // pixels, then its width, height and format.
  for (const at of pointers) {
    if (at < 0x4c || at + 4 > data.length) continue;
    const image = data.readUInt32BE(at);
    if (!pointers.has(image) || seen.has(image) || image + 12 > data.length || !pointers.has(image)) continue;
    const width = data.readUInt16BE(image + 4), height = data.readUInt16BE(image + 6), format = data.readUInt32BE(image + 8);
    if (!width || !height || width > 1024 || height > 1024 || format > 14 || format === 8 || format === 9 || format === 10) continue;
    seen.add(image);
    const pixels = data.readUInt32BE(image), bytes = gx.textureSize(format, width, height);
    if (!bytes || pixels + bytes > data.length) continue;
    const source = data.subarray(pixels, pixels + bytes), rgba = gx.decode(format, width, height, source);
    if (rgba) textures.push({ width, height, rgba, disc: { data: source, format, width, height } });
  }
  return textures;
}

const alphaAt = (texture, x, y) => texture.rgba[(y * texture.width + x) * 4 + 3];

// The logo among the title scene's textures: the full-colour (RGBA8) picture wider than it is tall, clear at its
// corners. The rest are square clouds and the colosseum's stone.
function pickColosseumLogo(textures) {
  const candidates = textures.filter(t => t.disc.format === 6 && t.width > t.height * 1.5
    && [[0, 0], [t.width - 1, 0], [0, t.height - 1], [t.width - 1, t.height - 1]].every(([x, y]) => alphaAt(t, x, y) === 0));
  return candidates.sort((a, b) => b.width * b.height - a.width * a.height)[0] || null;
}

// The archive member named `name`, unpacked, or null.
function member(archive, name) {
  const entry = fsys.entries(archive).find(each => each.name === name);
  return entry ? entry.data() : null;
}

// Colosseum's logo from the disc (a Disc), or from `override`, a logo_demo model a language pack holds.
function colosseumLogo(disc, override = null) {
  const scene = override || member(disc.file('title.fsys'), 'logo_demo');
  if (!scene) throw new Error('The disc\'s title screen has no logo scene.');
  const logo = pickColosseumLogo(datTextures(scene));
  if (!logo) throw new Error('The disc\'s title screen has no logo picture.');
  return logo;
}

// --- XD: its Flash title menu ----------------------------------------------------
// The movie is Flash's tags laid out for the GameCube: each tag a u32 code and u32 length, then its body, from 0x30.
// Pointers in the bodies are offsets from the start of the body that holds them.

const TAG = { END: 0, SHOW_FRAME: 1, SHAPE: 2, BITS: 20, SHAPE2: 22, PLACE: 26, REMOVE: 28, SHAPE3: 32, BITS2: 36, SPRITE: 39, LABEL: 43 };

function readFlash(movie) {
  const u32 = at => movie.readUInt32BE(at), s32 = at => movie.readInt32BE(at), u16 = at => movie.readUInt16BE(at);
  const flash = { labels: [], shapes: new Map(), bitmaps: new Map(), sprites: new Map(), timeline: [] };
  let pos = 0x30, frame = 0, depth = 0, tags = flash.timeline;
  while (pos + 8 <= movie.length) {
    const tag = u32(pos), length = u32(pos + 4), at = pos + 8;
    if (tag === TAG.END) {
      // the end of a sprite's tags, or of the movie
      if (--depth < 0) break;
      tags = flash.timeline;
      pos = at + length;
      continue;
    }
    if (at + length > movie.length) throw new Error('XD\'s title menu file is damaged.');
    switch (tag) {
      case TAG.SHOW_FRAME:
        tags.push({ show: s32(at) });
        if (!depth) frame++;
        break;
      case TAG.SHAPE: case TAG.SHAPE2: case TAG.SHAPE3:
        flash.shapes.set(u32(at), at);
        break;
      case TAG.BITS: case TAG.BITS2: {
        const body = (at + 0x1f) & ~0x1f, texture = body + u32(body + 0x10);
        const image = gx.decodeStandalone(movie.subarray(texture, at + length));
        if (image) flash.bitmaps.set(u16(body + 2), image);
        break;
      }
      case TAG.SPRITE:
        tags = [];
        flash.sprites.set(u16(at), tags);
        depth++;
        break;
      case TAG.PLACE:
        tags.push({ flags: movie[at], character: u32(at + 4), depth: u32(at + 8),
          matrix: [0, 1, 2, 3, 4, 5].map(i => s32(at + 0x0c + i * 4)),
          cxform: [0, 1, 2, 3, 4, 5, 6, 7].map(i => movie.readInt16BE(at + 0x24 + i * 2)) });
        break;
      case TAG.REMOVE:
        tags.push({ remove: u16(at) });
        break;
      case TAG.LABEL: {
        const name = at + u32(at);
        flash.labels.push({ frame, name: movie.toString('latin1', name, movie.indexOf(0, name)) });
        break;
      }
    }
    pos = at + length;
  }
  return flash;
}

const UNIT_MATRIX = [1, 0, 0, 1, 0, 0];
// A cxform: alpha, red, green, blue, each a multiplier (256 is 1) and an addition.
const UNIT_CXFORM = [256, 0, 256, 0, 256, 0, 256, 0];
const PLACE_CHARACTER = 2, PLACE_MATRIX = 4, PLACE_CXFORM = 8;

// What a timeline shows at `frame`: its tags up to the first frame after it. [{ depth, character, matrix, cxform }]
function displayList(tags, frame) {
  const depths = new Map();
  for (const tag of tags) {
    if (tag.show !== undefined) { if (tag.show > frame) break; continue; }
    if (tag.remove !== undefined) { depths.delete(tag.remove); continue; }
    const entry = depths.get(tag.depth) || { character: 0, matrix: [65536, 0, 0, 65536, 0, 0], cxform: UNIT_CXFORM };
    if (tag.flags & PLACE_CHARACTER) entry.character = tag.character;
    if (tag.flags & PLACE_MATRIX) entry.matrix = tag.matrix;
    if (tag.flags & PLACE_CXFORM) entry.cxform = tag.cxform;
    depths.set(tag.depth, entry);
  }
  return [...depths].sort((a, b) => a[0] - b[0]).map(([depth, entry]) => ({ depth, ...entry }));
}

// flcalcConvFlashMatrix: 16.16 scale and skew, translation in twips.
const toMatrix = m => [m[0] / 65536, m[1] / 65536, m[2] / 65536, m[3] / 65536, m[4] / 20, m[5] / 20];
// flcalcMulMatrixf: `child`, then `parent`.
function multiply(child, parent) {
  const [a, b, c, d, tx, ty] = child, [pa, pb, pc, pd, ptx, pty] = parent;
  return [a * pa + b * pc, a * pb + b * pd, c * pa + d * pc, c * pb + d * pd, tx * pa + ty * pc + ptx, tx * pb + ty * pd + pty];
}
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
// flcalcMulCxform
function combine(cx, parent) {
  return cx.map((value, i) => i % 2 ? value + parent[i] : Math.trunc(value * parent[i] / 256));
}

// The bitmap quads of a shape (vecExec): a style change that picks a bitmap fill, then four straight edges.
// [{ bitmap, points: [[x, y] x4] in pixels, fill: the bitmap's matrix }]
function shapeQuads(movie, shape) {
  const u32 = at => movie.readUInt32BE(at), s32 = at => movie.readInt32BE(at);
  const quads = [];
  let styles = shape + u32(shape + 8), record = shape + u32(shape + 0x18), x = 0, y = 0, fill = -1, line = -1;
  const records = [];
  for (let guard = 0; guard < 100000 && u32(record + 8); guard++, record = shape + u32(record + 8))
    records.push({ type: movie[record], data: shape + u32(record + 4) });
  for (let i = 0; i < records.length; i++) {
    const { type, data } = records[i];
    if (type === 2) { x += s32(data + 4); y += s32(data + 8); continue; }
    if (type !== 1) continue;
    const flags = movie[data];
    if (flags & 1) { x = s32(data + 4); y = s32(data + 8); }
    if (flags & 4) fill = movie[data + 0x0d] - 1;
    if (flags & 2) line = movie[data + 0x0c] - 1;
    if ((flags & 0x10) && u32(data + 0x14)) { styles = shape + u32(data + 0x14); fill = line = -1; continue; }
    for (const index of [line, fill]) {
      if (index < 0) continue;
      const style = styles + index * 0x80;
      if (!(movie[style] & 0x40)) continue;
      if (!(flags & 1)) x = y = 0;
      const points = [];
      while (records[i + 1]?.type === 2 && points.length < 4) {
        const edge = records[++i].data;
        x += s32(edge + 4); y += s32(edge + 8);
        points.push([x / 20, y / 20]);
      }
      if (points.length === 4) {
        const m = [0, 1, 2, 3].map(k => s32(style + 0x68 + k * 4) / 1310720);
        quads.push({ bitmap: u32(style + 0x64), points, fill: [...m, s32(style + 0x78) / 20, s32(style + 0x7c) / 20] });
      }
    }
  }
  return quads;
}

// Every bitmap quad a timeline shows at `frame`, back to front, with its place on screen and its colour. A sprite's
// own timeline is taken at its first frame, as it is when placed.
function frameQuads(movie, flash, tags, frame, parent = UNIT_MATRIX, parentCxform = UNIT_CXFORM, out = [], depth = 0) {
  for (const entry of displayList(tags, frame)) {
    const matrix = multiply(toMatrix(entry.matrix), parent), cxform = combine(entry.cxform, parentCxform);
    if (flash.shapes.has(entry.character)) {
      for (const quad of shapeQuads(movie, flash.shapes.get(entry.character))) out.push({ ...quad, matrix, cxform });
    } else if (flash.sprites.has(entry.character) && depth < 8) {
      frameQuads(movie, flash, flash.sprites.get(entry.character), 0, matrix, cxform, out, depth + 1);
    }
  }
  return out;
}

// --- Drawing ---------------------------------------------------------------------

// A picture's texel, filtered as GX_LINEAR does, clamped at its edges.
function sample(image, u, v, out) {
  const { width, height, rgba } = image;
  const fx = Math.min(Math.max(u - 0.5, 0), width - 1), fy = Math.min(Math.max(v - 0.5, 0), height - 1);
  const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(x0 + 1, width - 1), y1 = Math.min(y0 + 1, height - 1);
  const wx = fx - x0, wy = fy - y0;
  for (let c = 0; c < 4; c++) {
    const top = rgba[(y0 * width + x0) * 4 + c] * (1 - wx) + rgba[(y0 * width + x1) * 4 + c] * wx;
    const bottom = rgba[(y1 * width + x0) * 4 + c] * (1 - wx) + rgba[(y1 * width + x1) * 4 + c] * wx;
    out[c] = top * (1 - wy) + bottom * wy;
  }
}

// Draws a quad onto `canvas` (premultiplied floats, `width` x `height`): getUV's mapping, from the bitmap matrix's
// origin along its axes, then the place matrix; the colour is the cxform's (SpriteDisp), then blended over.
function drawQuad(canvas, width, height, quad, image) {
  const [aMul, aAdd, rMul, rAdd, gMul, gAdd, bMul, bAdd] = quad.cxform;
  if (aMul <= 0 && aAdd <= 0) return;
  const [a, b, c, d, tx, ty] = quad.matrix, det = a * d - b * c;
  if (Math.abs(det) < 1e-9) return;
  const [fa, fb, fc, fd, ux, uy] = quad.fill, sx = Math.hypot(fa, fb), sy = Math.hypot(fc, fd);
  if (!sx || !sy) return;
  const xs = quad.points.map(p => p[0]), ys = quad.points.map(p => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const corners = quad.points.map(([x, y]) => apply(quad.matrix, x, y));
  const left = Math.max(0, Math.floor(Math.min(...corners.map(p => p[0])))), right = Math.min(width, Math.ceil(Math.max(...corners.map(p => p[0]))));
  const top = Math.max(0, Math.floor(Math.min(...corners.map(p => p[1])))), bottom = Math.min(height, Math.ceil(Math.max(...corners.map(p => p[1]))));
  const texel = new Float64Array(4);
  const channel = (value, mul, add) => Math.min(255, Math.max(0, value * mul / 256 + add));
  for (let py = top; py < bottom; py++) {
    for (let px = left; px < right; px++) {
      // the point in the shape's space under this pixel's centre
      const X = px + 0.5 - tx, Y = py + 0.5 - ty;
      const lx = (d * X - c * Y) / det, ly = (a * Y - b * X) / det;
      if (lx < minX || lx > maxX || ly < minY || ly > maxY) continue;
      sample(image, Math.min(Math.abs(lx - ux) / sx, image.width), Math.min(Math.abs(ly - uy) / sy, image.height), texel);
      const alpha = channel(texel[3], aMul, aAdd) / 255;
      if (alpha <= 0) continue;
      const at = (py * width + px) * 4, keep = 1 - alpha;
      canvas[at] = channel(texel[0], rMul, rAdd) * alpha + canvas[at] * keep;
      canvas[at + 1] = channel(texel[1], gMul, gAdd) * alpha + canvas[at + 1] * keep;
      canvas[at + 2] = channel(texel[2], bMul, bAdd) * alpha + canvas[at + 2] * keep;
      canvas[at + 3] = alpha * 255 + canvas[at + 3] * keep;
    }
  }
}

// A premultiplied canvas -> RGBA, cut to what was drawn on it: { width, height, rgba }.
function crop(canvas, width, height) {
  let left = width, right = -1, top = height, bottom = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (canvas[(y * width + x) * 4 + 3] < 1) continue;
    left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
  }
  if (right < 0) return null;
  const w = right - left + 1, h = bottom - top + 1, rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const from = ((y + top) * width + x + left) * 4, to = (y * w + x) * 4, alpha = canvas[from + 3];
    if (alpha < 1) continue;
    for (let c = 0; c < 3; c++) rgba[to + c] = Math.round(Math.min(255, canvas[from + c] * 255 / alpha));
    rgba[to + 3] = Math.round(alpha);
  }
  return { width: w, height: h, rgba };
}

const SCREEN = [640, 480];

// XD's logo from its title menu movie (title_start_00).
function xdLogoFromMovie(movie) {
  const flash = readFlash(movie), back = flash.labels.find(label => label.name === 'back');
  if (!back || back.frame < 1) throw new Error('XD\'s title menu has no logo frame.');
  const [width, height] = SCREEN, canvas = new Float64Array(width * height * 4);
  for (const quad of frameQuads(movie, flash, flash.timeline, back.frame - 1)) {
    const image = flash.bitmaps.get(quad.bitmap);
    if (image) drawQuad(canvas, width, height, quad, image);
  }
  const logo = crop(canvas, width, height);
  if (!logo || logo.width < 64 || logo.height < 32) throw new Error('XD\'s title menu drew no logo.');
  return logo;
}

function xdLogo(disc) {
  const movie = member(disc.file('title.fsys'), 'title_start_00');
  if (!movie) throw new Error('The disc\'s title screen has no title menu.');
  return xdLogoFromMovie(movie);
}

// --- Reading and caching -----------------------------------------------------------

// Where a language pack keeps an archive member it replaces (the port's host/language.c): logo_demo is type 1, .rdat.
const PACK_LOGO = ['files', 'title.fsys', 'logo_demo.rdat'];
function packLogoFile(packFolder) { return packFolder ? path.join(packFolder, ...PACK_LOGO) : null; }

// A game's logo from its disc: { width, height, rgba, disc }; `disc` is the texture as the disc has it when the logo
// is one (Colosseum's), for its HD replacement.
function readLogo(game, rom, { packFolder = null } = {}) {
  const disc = new Disc(rom);
  try {
    if (games.identifyDisc(disc.gameId)?.game.id !== game) throw new Error(`The disc isn't ${games.get(game).name} (it is ${disc.gameId}).`);
    if (game === 'xd') return { ...xdLogo(disc), disc: null };
    const override = packLogoFile(packFolder);
    return colosseumLogo(disc, override && fs.existsSync(override) ? fs.readFileSync(override) : null);
  } finally { disc.close(); }
}

// The cache's name for a game's logo from this disc file, as it is now, in this language (and the pack's own logo,
// when it has one): the disc's path, size and time, so a changed or replaced disc is read again.
function cacheKey(game, rom, language = 'en', packFolder = null) {
  const stat = fs.statSync(rom), override = packLogoFile(packFolder);
  let pack = null;
  try { pack = override && fs.statSync(override).mtimeMs; } catch (_) { /* the pack has no logo of its own */ }
  const key = JSON.stringify([game, path.resolve(rom), stat.size, stat.mtimeMs, language, pack]);
  return `${game}-${crypto.createHash('sha256').update(key).digest('hex').slice(0, 20)}`;
}

// A game's logo, from the cache in `folder` or read from the disc and kept there (others of the same game go):
// { file: the PNG, hdNames: the names an HD pack gives its texture (texture-pack-lookup.js), none for XD's }.
function cachedLogo(folder, game, rom, { language = 'en', packFolder = null } = {}) {
  const key = cacheKey(game, rom, language, packFolder), file = path.join(folder, `${key}.png`), info = path.join(folder, `${key}.json`);
  if (fs.existsSync(file)) {
    let hdNames = [];
    try { hdNames = JSON.parse(fs.readFileSync(info, 'utf8')).hdNames || []; } catch (_) {}
    return { file, hdNames };
  }
  const logo = readLogo(game, rom, { packFolder });
  fs.mkdirSync(folder, { recursive: true });
  for (const name of fs.readdirSync(folder)) if (name.startsWith(`${game}-`) && !name.startsWith(key)) fs.rmSync(path.join(folder, name), { force: true });
  const hdNames = logo.disc ? texturePackLookup.textureNames(logo.disc) : [];
  fs.writeFileSync(info, JSON.stringify({ width: logo.width, height: logo.height, hdNames }));
  fs.writeFileSync(file, png(logo.width, logo.height, logo.rgba));
  return { file, hdNames };
}

// The HD pack's image of a cached logo, or null: `index` is texture-pack-lookup.js indexFolders'.
function hdLogoFile(index, hdNames) {
  for (const name of hdNames || []) if (index?.has(name)) return index.get(name);
  return null;
}

module.exports = { readLogo, cacheKey, cachedLogo, hdLogoFile, packLogoFile, datTextures, pickColosseumLogo, colosseumLogo, readFlash, displayList, shapeQuads, frameQuads, drawQuad, crop,
  xdLogoFromMovie, xdLogo };
