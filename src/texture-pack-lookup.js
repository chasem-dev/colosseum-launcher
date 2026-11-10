'use strict';

// Finding a disc texture's HD replacement the way the game does (the port's gx_hires.cpp), for the
// Pokédex's models and sprites. A pack is a folder of Dolphin-style images named after the texture:
//   tex1_<w>x<h>[_m]_<data hash>[_<palette hash>]_<format>.png
// The hashes are XXH64 (seed 0) of the base level's bytes as they are on the disc and, for the
// colour-index formats, of the palette entries the texture uses ("$" matches any palette).

const fs = require('fs');
const path = require('path');
const gx = require('./gx-texture');

const MASK = (1n << 64n) - 1n;
const P1 = 0x9E3779B185EBCA87n, P2 = 0xC2B2AE3D27D4EB4Fn, P3 = 0x165667B19E3779F9n, P4 = 0x85EBCA77C2B2AE63n, P5 = 0x27D4EB2F165667C5n;
const rotl = (x, r) => ((x << BigInt(r)) | (x >> BigInt(64 - r))) & MASK;
const round = (acc, lane) => (rotl((acc + lane * P2) & MASK, 31) * P1) & MASK;
const merge = (acc, v) => (((acc ^ round(0n, v)) * P1) & MASK) + P4 & MASK;

// XXH64 of `bytes` (a Buffer or Uint8Array), as a BigInt.
function xxh64(bytes, seed = 0n) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), end = bytes.length;
  let p = 0, h;
  if (end >= 32) {
    let v1 = (seed + P1 + P2) & MASK, v2 = (seed + P2) & MASK, v3 = seed, v4 = (seed - P1) & MASK;
    do {
      v1 = round(v1, view.getBigUint64(p, true));
      v2 = round(v2, view.getBigUint64(p + 8, true));
      v3 = round(v3, view.getBigUint64(p + 16, true));
      v4 = round(v4, view.getBigUint64(p + 24, true));
      p += 32;
    } while (end - p >= 32);
    h = (rotl(v1, 1) + rotl(v2, 7) + rotl(v3, 12) + rotl(v4, 18)) & MASK;
    h = merge(merge(merge(merge(h, v1), v2), v3), v4);
  } else h = (seed + P5) & MASK;
  h = (h + BigInt(end)) & MASK;
  for (; end - p >= 8; p += 8) h = ((rotl(h ^ round(0n, view.getBigUint64(p, true)), 27) * P1) & MASK) + P4 & MASK;
  if (end - p >= 4) {
    h = ((rotl(h ^ ((BigInt(view.getUint32(p, true)) * P1) & MASK), 23) * P2) & MASK) + P3 & MASK;
    p += 4;
  }
  for (; p < end; p++) h = (rotl(h ^ ((BigInt(bytes[p]) * P5) & MASK), 11) * P1) & MASK;
  h ^= h >> 33n;
  h = (h * P2) & MASK;
  h ^= h >> 29n;
  h = (h * P3) & MASK;
  return h ^ (h >> 32n);
}

const hex = value => value.toString(16).padStart(16, '0');
const INDEXED = new Set([8, 9, 10]);   // C4, C8, C14X2

// The palette entries an indexed texture's pixels use, lowest to highest.
function paletteRange(data, format) {
  let low = 0xffff, high = 0;
  if (format === 8) for (const byte of data) { low = Math.min(low, byte & 15, byte >> 4); high = Math.max(high, byte & 15, byte >> 4); }
  else if (format === 9) for (const byte of data) { low = Math.min(low, byte); high = Math.max(high, byte); }
  else for (let i = 0; i + 1 < data.length; i += 2) {
    const value = ((data[i] << 8) | data[i + 1]) & 0x3fff;
    low = Math.min(low, value);
    high = Math.max(high, value);
  }
  return low > high ? [0, 0] : [low, high];
}

// The names a pack may give a texture, most exact first: without and with _m, as the game tries both
// (a texture dumped from a use with the other mipmap setting), each with its palette's hash, then any palette.
function textureNames({ data, format, width, height, palette = null }) {
  const bytes = gx.textureSize(format, width, height);
  if (!bytes || data.length < bytes) return [];
  const level = data.subarray(0, bytes), hash = hex(xxh64(level));
  let paletteHash = null;
  if (INDEXED.has(format) && palette) {
    const [low, high] = paletteRange(level, format), from = Math.min(2 * low, palette.length);
    paletteHash = hex(xxh64(palette.subarray(from, Math.min(from + 2 * (high + 1 - low), palette.length))));
  }
  const names = [];
  for (const mip of ['', '_m']) {
    const base = `tex1_${width}x${height}${mip}_${hash}`;
    if (paletteHash) names.push(`${base}_${paletteHash}_${format}`, `${base}_$_${format}`);
    names.push(`${base}_${format}`);
  }
  return names;
}

// The level-0 images in `folders`, by name; an earlier folder's image wins, as in the game. Only PNGs:
// the Pokédex draws with the browser's image decoding, which takes no DDS.
function indexFolders(folders) {
  const index = new Map();
  for (const folder of folders) {
    const pending = [folder], seen = new Set();
    while (pending.length) {
      const current = pending.pop();
      let entries, real;
      try { real = fs.realpathSync(current); entries = fs.readdirSync(current, { withFileTypes: true }); } catch (_) { continue; }
      if (seen.has(real)) continue;
      seen.add(real);
      for (const entry of entries) {
        const file = path.join(current, entry.name);
        let kind = entry;
        if (entry.isSymbolicLink()) try { kind = fs.statSync(file); } catch (_) { continue; }
        if (kind.isDirectory()) {
          if (entry.name !== 'widescreen_stars_fix') pending.push(file);
          continue;
        }
        const match = kind.isFile() && entry.name.match(/^(tex1_.+?)(_arb)?\.png$/i);
        if (match && !/_mip\d+$/.test(match[1]) && !index.has(match[1])) index.set(match[1], file);
      }
    }
  }
  return index;
}

// The pack image for a texture, or null: { name, file }.
function findReplacement(index, texture) {
  if (!index?.size) return null;
  for (const name of textureNames(texture)) if (index.has(name)) return { name, file: index.get(name) };
  return null;
}

module.exports = { xxh64, textureNames, indexFolders, findReplacement };
