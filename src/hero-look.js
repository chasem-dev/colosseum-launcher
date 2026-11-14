'use strict';

// The Customize page's heroes: each one's models read from the player's disc, with their textures as the HD pack
// has them when it does, sorted into the hero's colour regions (hero-colors.js) so the page can repaint them as
// colours are chosen; and their motions, a Game Boy Advance hero's missing ones played from Wes's
// (hero-retarget.js). The colours chosen are kept in their own file, beside the launcher's settings.

const fs = require('node:fs');
const path = require('node:path');
const { Disc } = require('./disc');
const fsys = require('./fsys');
const hsd = require('./hsd-model');
const colors = require('./hero-colors');
const retarget = require('./hero-retarget');
const texturePackLookup = require('./texture-pack-lookup');
const { decodePng } = require('./pokemon-packs');

const PKX_HEADER = 0x40;   // hsd-model.js's
// A pkx's battle motion slots (sequence.c fn_801DD5E8, as hsd-model.js readHeader reads them)
const LOAD_MODE = 5, SLOT_SIZE = 0xd0, SLOT_MOTIONS = 0x8c;
const align32 = n => (n + 31) & ~31;

// The clip each battle motion slot plays first, -1 for an empty slot.
function slotClips(pkx, animationCount) {
  if (pkx.length < PKX_HEADER || pkx.readUInt32BE(0x10) !== LOAD_MODE) return [];
  const count = pkx.readUInt32BE(8), slots = PKX_HEADER + align32(pkx.readUInt32BE(0)) + align32(pkx.readUInt32BE(4));
  if (count > 32 || slots + count * SLOT_SIZE > pkx.length) return [];
  return Array.from({ length: count }, (_, slot) => {
    const at = slots + slot * SLOT_SIZE, n = Math.min(pkx.readUInt32BE(at + 4), 8);
    for (let k = 0; k < n; k++) {
      const type = pkx.readUInt32BE(at + SLOT_MOTIONS + k * 8), index = pkx.readUInt32BE(at + SLOT_MOTIONS + k * 8 + 4);
      if (!type && index < animationCount) return index;
    }
    return -1;
  });
}

// The idle a pkx's header names, else its first clip (for a model with no header).
function idleOf(model) {
  return model.motions.find(motion => motion.kind === 'idle')?.index ?? (model.animations.length ? 0 : -1);
}

// A model's file: a pkx archive's model, or a people model (an archive's entry), given the pkx header hsd-model.js
// reads (with no battle motions).
function readFile(rom, label, { file, entry }) {
  const disc = new Disc(rom);
  try {
    if (!disc.files.has(file)) throw new Error(`${label}'s model isn't on this disc.`);
    const entries = fsys.entries(disc.file(file)), found = entry === undefined ? entries[0] : entries.find(each => each.id === entry);
    if (!found) throw new Error(`${label}'s model isn't on this disc.`);
    const data = Buffer.from(found.data());
    if (entry === undefined) return data;
    const pkx = Buffer.concat([Buffer.alloc(PKX_HEADER), data]);
    pkx.writeUInt32BE(data.length, 0);
    return pkx;
  } finally { disc.close(); }
}

// Reads one disc's heroes; each model's file is read once while the reader lasts.
function createReader(rom) {
  const files = new Map(), models = new Map(), matches = new Map();
  const fileOf = (id, kind) => {
    const key = `${id}:${kind}`;
    if (!files.has(key)) {
      const hero = colors.hero(id);
      if (!hero) throw new Error('There\'s no such hero.');
      files.set(key, readFile(rom, hero.label, hero[kind] || hero.battle));
    }
    return files.get(key);
  };
  const modelOf = (id, kind) => {
    const key = `${id}:${kind}`;
    if (!models.has(key)) {
      const pkx = fileOf(id, kind), model = hsd.parseModel(pkx);
      models.set(key, { pkx, model, slots: slotClips(pkx, model.animations.length) });
    }
    return models.get(key);
  };

  // A hero's model (`kind` 'stand' or 'battle') as the page draws it: `index` is texture-pack-lookup.js's index of the
  // texture folders, for the HD images (each one found takes its texture's place; one this can't read leaves the
  // disc's).
  function hero(id, kind, index = null) {
    const hero = colors.hero(id);
    if (!hero) throw new Error('There\'s no such hero.');
    const model = hsd.parseModel(fileOf(id, kind));
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
    return { id, kind, label: hero.label, model, hd, ...colors.prepare(id, model.textures) };
  }

  // Wes's motion on another hero's model: his standing idle (from his field model) or a battle slot's.
  function fromWes(id, kind, motionId, slot) {
    const sourceKind = motionId === 'idle' ? 'stand' : 'battle', wes = modelOf('wes', sourceKind), own = modelOf(id, kind);
    const index = motionId === 'idle' ? colors.hero('wes').stand.idle : wes.slots[slot] ?? -1;
    if (index < 0) return { clip: null, from: null };
    const key = `${id}:${kind}:${sourceKind}`;
    if (!matches.has(key)) matches.set(key, retarget.matchJoints(wes.model, own.model));
    return { clip: retarget.retarget(wes.model, hsd.parseClip(wes.pkx, index), own.model, matches.get(key)), from: 'wes' };
  }

  // A motion of a hero's, on the model modelFor says: { clip, from }, `from` 'wes' for one moved over from Wes's
  // (every one, with `wesMoves`, else those the hero hasn't); clip null when there's no such motion.
  function clip(id, motionId, { wesMoves = false } = {}) {
    const hero = colors.hero(id), motion = colors.MOTIONS.find(each => each.id === motionId);
    if (!hero || !motion) throw new Error('There\'s no such motion.');
    const kind = colors.modelFor(id, motionId), own = modelOf(id, kind);
    if (wesMoves && id !== 'wes') return fromWes(id, kind, motionId, motion.slot);
    if (motionId === 'idle') {
      const index = kind === 'stand' ? hero.stand.idle : own.slots[0] ?? idleOf(own.model);
      return { clip: index >= 0 ? hsd.parseClip(own.pkx, index) : null, from: null };
    }
    const index = own.slots[motion.slot] ?? -1;
    if (index >= 0) return { clip: hsd.parseClip(own.pkx, index), from: null };
    if (id === 'wes') return { clip: null, from: null };
    return fromWes(id, kind, motionId, motion.slot);
  }

  return { hero, clip };
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

module.exports = { createReader, readLooks, saveLooks, idleOf, slotClips };
