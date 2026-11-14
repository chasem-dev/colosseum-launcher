'use strict';

// The Customize page's heroes: each one's model read from the player's disc, with its idle motion, its
// textures as the HD pack has them when it does, and those textures sorted into the hero's colour regions
// (hero-colors.js), so the page can repaint them as colours are chosen. The colours chosen are kept in their own
// file, beside the launcher's settings.

const fs = require('node:fs');
const path = require('node:path');
const { Disc } = require('./disc');
const fsys = require('./fsys');
const hsd = require('./hsd-model');
const colors = require('./hero-colors');
const texturePackLookup = require('./texture-pack-lookup');
const { decodePng } = require('./pokemon-packs');

const PKX_HEADER = 0x40;   // hsd-model.js's

// The motion the page plays: the idle a battle opens on (the model's header names it), else the first.
function idleOf(model) {
  return model.motions.find(motion => motion.kind === 'idle')?.index ?? (model.animations.length ? 0 : -1);
}

// A hero's model as the page draws it. `index` is texture-pack-lookup.js's index of the texture folders, for the
// HD images: each one found takes its texture's place (an image this can't read leaves the disc's).
function readHero(rom, id, index = null) {
  const hero = colors.hero(id);
  if (!hero) throw new Error('There\'s no such hero.');
  const disc = new Disc(rom);
  let pkx;
  try {
    if (!disc.files.has(hero.model)) throw new Error(`${hero.label}'s model isn't on this disc.`);
    const entries = fsys.entries(disc.file(hero.model)), entry = hero.entry === undefined ? entries[0] : entries.find(each => each.id === hero.entry);
    if (!entry) throw new Error(`${hero.label}'s model isn't on this disc.`);
    pkx = Buffer.from(entry.data());
    // A people model is the model alone: given the pkx's header, as hsd-model.js reads them (no battle motions)
    if (hero.entry !== undefined) pkx = Buffer.concat([Buffer.alloc(PKX_HEADER), pkx]).fill(0, 0, PKX_HEADER), pkx.writeUInt32BE(pkx.length - PKX_HEADER, 0);
  } finally { disc.close(); }
  const model = hsd.parseModel(pkx);
  const motion = hero.idle ?? idleOf(model);
  let hd = 0;
  for (const texture of model.textures) {
    const found = index && texturePackLookup.findReplacement(index, texture.disc);
    delete texture.disc;
    if (!found) continue;
    try {
      const image = decodePng(fs.readFileSync(found.file));
      Object.assign(texture, { rgba: new Uint8Array(image.rgba.buffer, image.rgba.byteOffset, image.rgba.length), width: image.width, height: image.height });
      hd++;
    } catch (_) { /* the disc's, then */ }
  }
  const clip = motion >= 0 ? hsd.parseClip(pkx, motion) : null;
  return { id, label: hero.label, model, clip, hd, ...colors.prepare(id, model.textures) };
}

function looksFile(userData) { return path.join(userData, 'hero-looks.json'); }

function readLooks(userData) {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(looksFile(userData), 'utf8')); } catch (_) { /* none yet */ }
  return colors.normalizeLooks(saved);
}

// The looks as the page has changed them: saved, and returned as kept.
function saveLooks(userData, looks) {
  const kept = colors.normalizeLooks(looks), file = looksFile(userData), temporary = `${file}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(temporary, JSON.stringify(kept, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, file);
  return kept;
}

module.exports = { readHero, readLooks, saveLooks, idleOf };
