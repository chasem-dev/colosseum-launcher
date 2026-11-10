'use strict';

// GameCube textures to RGBA, top row first.

// Each format's tile, in pixels.
const TILES = { 0: [8, 8], 1: [8, 4], 2: [8, 4], 3: [4, 4], 4: [4, 4], 5: [4, 4], 6: [4, 4], 8: [8, 8], 9: [8, 4], 10: [4, 4], 14: [8, 8] };
const PALETTE = { IA8: 0, RGB565: 1, RGB5A3: 2 };

function rgb565(value, out, at) {
  const r = value >> 11, g = (value >> 5) & 63, b = value & 31;
  out[at] = (r << 3) | (r >> 2);
  out[at + 1] = (g << 2) | (g >> 4);
  out[at + 2] = (b << 3) | (b >> 2);
  out[at + 3] = 255;
}

function rgb5a3(value, out, at) {
  if (value & 0x8000) {
    const r = (value >> 10) & 31, g = (value >> 5) & 31, b = value & 31;
    out[at] = (r << 3) | (r >> 2);
    out[at + 1] = (g << 3) | (g >> 2);
    out[at + 2] = (b << 3) | (b >> 2);
    out[at + 3] = 255;
    return;
  }
  const a = (value >> 12) & 7;
  out[at] = ((value >> 8) & 15) * 17;
  out[at + 1] = ((value >> 4) & 15) * 17;
  out[at + 2] = (value & 15) * 17;
  out[at + 3] = (a << 5) | (a << 2) | (a >> 1);
}

function paletteColor(palette, format, index, out, at) {
  const value = palette && index * 2 + 1 < palette.length ? palette.readUInt16BE(index * 2) : 0;
  if (format === PALETTE.RGB565) rgb565(value, out, at);
  else if (format === PALETTE.RGB5A3) rgb5a3(value, out, at);
  else {
    out[at] = out[at + 1] = out[at + 2] = value & 255;
    out[at + 3] = value >> 8;
  }
}

// One 4x4 block of a CMPR texture, whose DXT1 block starts at `from`.
function cmprBlock(source, from, width, height, left, top, out) {
  const first = source.readUInt16BE(from), second = source.readUInt16BE(from + 2), colors = new Uint8Array(16);
  rgb565(first, colors, 0);
  rgb565(second, colors, 4);
  for (let k = 0; k < 3; k++) {
    if (first > second) {
      colors[8 + k] = (2 * colors[k] + colors[4 + k]) / 3;
      colors[12 + k] = (colors[k] + 2 * colors[4 + k]) / 3;
    } else {
      colors[8 + k] = (colors[k] + colors[4 + k]) / 2;
      colors[12 + k] = 0;
    }
  }
  colors[11] = 255;
  colors[15] = first > second ? 255 : 0;
  for (let y = 0; y < 4; y++) {
    const row = source[from + 4 + y];
    for (let x = 0; x < 4; x++) {
      const px = left + x, py = top + y;
      if (px >= width || py >= height) continue;
      const color = ((row >> (6 - x * 2)) & 3) * 4, at = (py * width + px) * 4;
      out[at] = colors[color];
      out[at + 1] = colors[color + 1];
      out[at + 2] = colors[color + 2];
      out[at + 3] = colors[color + 3];
    }
  }
}

// The bytes a texture of this format and size takes.
function textureSize(format, width, height) {
  const tile = TILES[format];
  if (!tile) return 0;
  const bytes = format === 6 ? 64 : 32;
  return Math.ceil(width / tile[0]) * Math.ceil(height / tile[1]) * bytes;
}

// `source` as RGBA, or null for a format it can't be. `palette` holds the palette's
// entries, in `paletteFormat`, for the colour-index formats.
function decode(format, width, height, source, palette = null, paletteFormat = 0) {
  const tile = TILES[format];
  if (!tile || source.length < textureSize(format, width, height)) return null;
  const [tileWidth, tileHeight] = tile, out = new Uint8Array(width * height * 4), pixel = new Uint8Array(4);
  let from = 0;
  for (let top = 0; top < height; top += tileHeight) {
    for (let left = 0; left < width; left += tileWidth) {
      if (format === 14) {
        for (let block = 0; block < 4; block++, from += 8)
          cmprBlock(source, from, width, height, left + (block & 1) * 4, top + (block >> 1) * 4, out);
        continue;
      }
      if (format === 6) {
        for (let i = 0; i < 16; i++) {
          const px = left + (i & 3), py = top + (i >> 2);
          if (px >= width || py >= height) continue;
          const at = (py * width + px) * 4;
          out[at + 3] = source[from + i * 2];
          out[at] = source[from + i * 2 + 1];
          out[at + 1] = source[from + 32 + i * 2];
          out[at + 2] = source[from + 33 + i * 2];
        }
        from += 64;
        continue;
      }
      for (let y = 0; y < tileHeight; y++) {
        for (let x = 0; x < tileWidth; x++) {
          const i = y * tileWidth + x;
          switch (format) {
            case 0: pixel[0] = pixel[1] = pixel[2] = pixel[3] = ((source[from + (i >> 1)] >> (i & 1 ? 0 : 4)) & 15) * 17; break;
            case 1: pixel[0] = pixel[1] = pixel[2] = pixel[3] = source[from + i]; break;
            case 2: pixel[0] = pixel[1] = pixel[2] = (source[from + i] & 15) * 17; pixel[3] = (source[from + i] >> 4) * 17; break;
            case 3: pixel[0] = pixel[1] = pixel[2] = source[from + i * 2 + 1]; pixel[3] = source[from + i * 2]; break;
            case 4: rgb565(source.readUInt16BE(from + i * 2), pixel, 0); break;
            case 5: rgb5a3(source.readUInt16BE(from + i * 2), pixel, 0); break;
            case 8: paletteColor(palette, paletteFormat, (source[from + (i >> 1)] >> (i & 1 ? 0 : 4)) & 15, pixel, 0); break;
            case 9: paletteColor(palette, paletteFormat, source[from + i], pixel, 0); break;
            default: paletteColor(palette, paletteFormat, source.readUInt16BE(from + i * 2) & 0x3fff, pixel, 0);
          }
          const px = left + x, py = top + y;
          if (px < width && py < height) out.set(pixel, (py * width + px) * 4);
        }
      }
      from += 32;
    }
  }
  return out;
}

// The game's standalone menu textures: a 0x80-byte header (width and height, then the
// format code at 0x0B) and the image.
const STANDALONE = { 0x90: 5, 0x45: 6, 0xb0: 14, 0x44: 3 };
function decodeStandalone(file) {
  if (file.length < 0x80) return null;
  const width = file.readUInt16BE(0), height = file.readUInt16BE(2), format = STANDALONE[file[0x0b]];
  if (format === undefined || !width || !height) return null;
  const data = file.subarray(0x80), rgba = decode(format, width, height, data);
  // `disc`: the texture as the disc has it, for finding its HD replacement (texture-pack-lookup.js).
  return rgba && { width, height, rgba, disc: { data, format, width, height } };
}

module.exports = { decode, decodeStandalone, textureSize };
