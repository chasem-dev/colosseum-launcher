'use strict';

// The Pokédex: every Pokémon on the player's disc, read from the disc itself. The species
// and trainers' teams are tables in common_rel, the sprites are in poke_body.fsys, and
// each model is a pkx_*.fsys that a table in main.dol names.
const zlib = require('node:zlib');
const { Disc } = require('./disc');
const fsys = require('./fsys');
const gx = require('./gx-texture');
const hsd = require('./hsd-model');
const xdDisc = require('./xd-disc');

// Places in the one release the launcher accepts (GC6E01, revision 0: port.validateRom).
const REL_DATA_SECTION = 4;
const SPECIES = { offset: 0x121a04, count: 413, size: 0x11c };
const TRAINERS = { offset: 0x91684, count: 820, size: 0x34 };
const TRAINER_POKEMON = { offset: 0x9e5dc, count: 5510, size: 0x50 };
const MESSAGES = [0x58044, 0x647b4, 0x76c94];
const TEAM_SIZE = 6;
// main.dol's table of models, one 12-byte row for each pkxDataId, the file's id at +4.
const MODEL_TABLE = { address: 0x80370bd0, size: 12, id: 4 };
const ABILITY_MESSAGES = 3100;
const HEAD = 0x200;

const TYPES = ['Normal', 'Fighting', 'Flying', 'Poison', 'Ground', 'Rock', 'Bug', 'Ghost', 'Steel', '???', 'Fire', 'Water', 'Grass', 'Electric', 'Psychic', 'Ice', 'Dragon', 'Dark'];

// The game's gifts, by species (heroPokemonGet... in the decompilation). Trainers' teams
// show the rest of what can be had: a Shadow Pokémon can be snagged.
const GIFTS = {
  196: 'Your partner from the very start of the game.',
  197: 'Your partner from the very start of the game.',
  250: 'A reward from Mt. Battle.',
  353: 'A gift from Duking in the story.'
};
// The game holds these gifts for its bonus disc (menuExDiscShrineRun, exDiscCouponGive),
// which only Japan had: there's no other way to get them in this game.
const BONUS_DISC_GIFTS = {
  25: 'Trainers use it. The only way to get one here is a gift held for the Japanese bonus disc.',
  251: 'Its model and data are on the disc. The only way to get one here is a gift held for the Japanese bonus disc, or a trade from a Game Boy Advance game.'
};

const STATUS = {
  shadow: { label: 'Shadow', locked: false, note: 'A Shadow Pokémon: snag it from a trainer in the story.' },
  gift: { label: 'Gift', locked: false },
  evolve: { label: 'Evolution', locked: false },
  battle: { label: 'Battle only', locked: true, note: 'Trainers use it, but this game has no way to catch one.' },
  hidden: { label: 'Hidden on disc', locked: true, note: 'Its model and data are on the disc, but nothing in the game uses it. It could only arrive by trade from a Game Boy Advance game.' }
};

// Models that aren't a species' own: its other looks, each its own file.
const CASTFORM = [['powalen_f', 'Sunny'], ['powalen_w', 'Rainy'], ['powalen_i', 'Snowy']];
const UNOWN_FORMS = [...'abcdefghijklmnopqrstuvwxyz'].map(letter => [`unknown_${letter}`, letter.toUpperCase()]).concat([['unknown_ex', '!'], ['unknown_qu', '?']]);
const NATIONAL_CASTFORM = 351, NATIONAL_UNOWN = 201;
// A shiny look drawn with the model's colour filter: its form is this and the model's own stem
const SHINY_FILTER = 'shiny:';
// Unown's sprites are one for each letter, so its row names none.
const UNOWN_SPRITE = 'body201a';

// BULBASAUR to Bulbasaur, MR. MIME to Mr. Mime, HO-OH to Ho-Oh.
function displayName(text) {
  return text.toLowerCase().replace(/(^|[\s.-])(\p{L})/gu, (_, before, letter) => before + letter.toUpperCase());
}

// A message's text: UTF-16, with 0xFFFF and a byte for each of the game's control codes. Code 0 starts a
// new line of the game's box, which reads as a space on one line here.
function messageText(data, at, limit = 200) {
  let text = '';
  for (let from = at; from + 2 <= data.length && text.length < limit;) {
    const unit = data.readUInt16BE(from);
    from += 2;
    if (!unit) break;
    if (unit === 0xffff) {
      if (data[from] === 0 && text && !/[ -]$/.test(text)) text += ' ';
      from += 1;
    } else text += String.fromCharCode(unit);
  }
  return text.trim();
}

function readMessages(data, limit, tables = MESSAGES) {
  const messages = new Map();
  for (const table of tables) {
    const count = data.readUInt16BE(table + 4);
    for (let i = 0; i < count; i++) {
      const key = data.readUInt32BE(table + 0x10 + i * 8);
      if (!messages.has(key)) messages.set(key, messageText(data, table + data.readUInt32BE(table + 0x14 + i * 8), limit));
    }
  }
  return messages;
}

function relData(rel) {
  const sections = rel.readUInt32BE(0x10);
  return rel.subarray(rel.readUInt32BE(sections + REL_DATA_SECTION * 8) & ~1);
}

function readSpecies(data, messages) {
  const species = [];
  for (let id = 0; id < SPECIES.count; id++) {
    const at = SPECIES.offset + id * SPECIES.size, national = data.readUInt16BE(at + 0x12);
    if (!national) continue;
    const name = messages.get(data.readUInt32BE(at + 0x18));
    if (!name) continue;
    const height = data.readUInt16BE(at + 0x0a), types = [TYPES[data[at + 0x30]], TYPES[data[at + 0x31]]];
    const evolutions = [];
    for (let i = 0; i < 5; i++) {
      const target = data.readUInt16BE(at + 0x9c + i * 6 + 4);
      if (data[at + 0x9c + i * 6] && target) evolutions.push(target);
    }
    const abilities = [data[at + 0x32], data[at + 0x33]].filter(Boolean).map(ability => displayName(messages.get(ABILITY_MESSAGES + ability) || ''));
    species.push({ id, national, name: displayName(name), types: types[0] === types[1] ? types.slice(0, 1) : types,
      abilities: [...new Set(abilities)].filter(Boolean), height: `${Math.floor(height / 100)}'${String(height % 100).padStart(2, '0')}"`,
      weight: `${(data.readUInt16BE(at + 0x0c) / 10).toFixed(1)} lbs`, catchRate: data[at + 1],
      stats: Array.from({ length: 6 }, (_, i) => data.readUInt16BE(at + 0x84 + i * 2)), evolutions,
      model: data.readUInt32BE(at + 0x2c), sprites: [data.readUInt32BE(at + 0x10c + 4), data.readUInt32BE(at + 0x114 + 4)] });
  }
  return species;
}

// What trainers bring: the species of every Pokémon on a team, and those that are Shadow.
function readTeams(data) {
  const onTeam = new Set();
  for (let i = 0; i < TRAINERS.count; i++) {
    const first = data.readUInt16BE(TRAINERS.offset + i * TRAINERS.size + 4);
    for (let slot = 0; slot < TEAM_SIZE; slot++) onTeam.add(first + slot);
  }
  const seen = new Set(), shadow = new Set();
  for (const row of onTeam) {
    if (row >= TRAINER_POKEMON.count) continue;
    const at = TRAINER_POKEMON.offset + row * TRAINER_POKEMON.size, species = data.readUInt16BE(at + 0x0a);
    if (!species) continue;
    seen.add(species);
    if (data[at + 3]) shadow.add(species);
  }
  return { seen, shadow };
}

// How the player can come by each species. Nothing can be bred in this game, so a
// species can be had only as itself or by evolving one that can.
function classify(species, { seen, shadow }) {
  const byId = new Map(species.map(entry => [entry.id, entry])), from = new Map();
  const reached = [...shadow, ...Object.keys(GIFTS).map(Number)];
  for (let i = 0; i < reached.length; i++) {
    for (const target of byId.get(reached[i])?.evolutions || []) {
      if (from.has(target) || shadow.has(target) || GIFTS[target]) continue;
      from.set(target, reached[i]);
      reached.push(target);
    }
  }
  for (const entry of species) {
    const kind = shadow.has(entry.id) ? 'shadow' : GIFTS[entry.id] ? 'gift' : from.has(entry.id) ? 'evolve' : seen.has(entry.id) ? 'battle' : 'hidden';
    const note = kind === 'gift' ? GIFTS[entry.id] : kind === 'evolve' ? `Evolve ${byId.get(from.get(entry.id)).name} to get it.` : STATUS[kind].note;
    entry.status = { kind, label: STATUS[kind].label, locked: STATUS[kind].locked, note: BONUS_DISC_GIFTS[entry.id] || note };
  }
}

// Where an address of the running game is in main.dol.
function dolOffset(dol, address) {
  for (let i = 0; i < 18; i++) {
    const start = dol.readUInt32BE(0x48 + i * 4), size = dol.readUInt32BE(0x90 + i * 4);
    if (size && address >= start && address < start + size) return dol.readUInt32BE(i * 4) + address - start;
  }
  throw new Error('The game on this disc isn\'t laid out as it should be.');
}

function readDol(disc) {
  const offset = disc.read(0, 0x440).readUInt32BE(0x420), header = disc.read(offset, 0x100);
  let end = 0;
  for (let i = 0; i < 18; i++) end = Math.max(end, header.readUInt32BE(i * 4) + header.readUInt32BE(0x90 + i * 4));
  return disc.read(offset, end);
}

// Every Pokémon model's file by the id of the entry it holds.
function modelFiles(disc) {
  const files = new Map();
  for (const [name, { offset, size }] of disc.files) {
    if (!name.startsWith('pkx_')) continue;
    const id = fsys.firstEntryId(disc.read(offset, Math.min(HEAD, size)));
    if (id !== null) files.set(id, name);
  }
  return files;
}

// The looks a species has on the disc: its own model, then the others.
function formsOf(entry, file, disc) {
  const has = stem => disc.files.has(`pkx_${stem}.fsys`);
  if (entry.national === NATIONAL_UNOWN) return UNOWN_FORMS.filter(([stem]) => has(stem)).map(([stem, label]) => ({ id: stem, label }));
  if (!file) return [];
  const stem = file.slice('pkx_'.length, -'.fsys'.length), forms = [{ id: stem, label: 'Normal' }];
  if (entry.national === NATIONAL_CASTFORM) forms.push(...CASTFORM.filter(([form]) => has(form)).map(([id, label]) => ({ id, label })));
  // Its shiny model when it has one (fn_801DE190's table of them); the rest are drawn with the colour filter in the
  // model's own file (fn_801DCE0C)
  forms.splice(1, 0, has(`rare_${stem}`) ? { id: `rare_${stem}`, label: 'Shiny' } : { id: `${SHINY_FILTER}${stem}`, label: 'Shiny' });
  return forms;
}

// A small PNG, for a sprite the page can show as an image.
function png(width, height, rgba) {
  const chunk = (type, body) => {
    const out = Buffer.alloc(body.length + 12), name = Buffer.from(type, 'latin1');
    out.writeUInt32BE(body.length, 0);
    name.copy(out, 4);
    body.copy(out, 8);
    out.writeUInt32BE(zlib.crc32(Buffer.concat([name, body])), body.length + 8);
    return out;
  };
  const header = Buffer.alloc(13), rows = Buffer.alloc((width * 4 + 1) * height);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  for (let y = 0; y < height; y++) rows.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

// A Pokémon's body sprite: { url, disc } (the texture as the disc has it), or null.
function spritesOf(disc) {
  const sprites = new Map();
  for (const entry of fsys.entries(disc.file('poke_body.fsys'))) sprites.set(entry.id, entry).set(entry.name, entry);
  return (id, name) => {
    const sprite = sprites.get(id) || sprites.get(name), image = sprite ? gx.decodeStandalone(sprite.data()) : null;
    return image ? { url: `data:image/png;base64,${png(image.width, image.height, image.rgba).toString('base64')}`, disc: image.disc } : null;
  };
}

// The disc's Pokémon. `discSprites`, when given, gets each one's sprite texture by National Pokédex number.
function readPokedex(rom, discSprites = null) {
  const disc = new Disc(rom);
  try {
    // Pokémon XD's disc: its own tables, read with these same helpers (xd-disc.js)
    if (xdDisc.isXd(disc))
      return xdDisc.readPokedex(disc, discSprites, { readMessages, displayName, TYPES, ABILITY_MESSAGES, readDol, dolOffset, modelFiles, spritesOf, formsOf });
    const rel = fsys.entries(disc.file('common.fsys')).find(entry => entry.name === 'common_rel');
    if (!rel) throw new Error('The game disc has no Pokémon data.');
    const data = relData(rel.data()), messages = readMessages(data), species = readSpecies(data, messages);
    if (species[0]?.national !== 1 || species[0].stats[0] !== 45) throw new Error('The Pokémon data on this disc isn\'t where it should be.');
    classify(species, readTeams(data));
    const dol = readDol(disc), files = modelFiles(disc), sprite = spritesOf(disc), table = dolOffset(dol, MODEL_TABLE.address);
    for (const entry of species) {
      const at = table + entry.model * MODEL_TABLE.size + MODEL_TABLE.id;
      entry.forms = formsOf(entry, files.get(dol.readUInt32BE(at)), disc);
      const image = sprite(entry.sprites[0], entry.national === NATIONAL_UNOWN ? UNOWN_SPRITE : null);
      entry.sprite = image?.url || null;
      if (image) discSprites?.set(entry.national, image.disc);
      delete entry.sprites;
      delete entry.model;
      entry.evolutions = entry.evolutions.map(id => species.find(other => other.id === id)?.national).filter(Boolean);
    }
    return species.sort((a, b) => a.national - b.national);
  } finally { disc.close(); }
}

// The Pokédex for one disc, kept once read. Models are kept one at a time: the player
// looks at them in turn, and a model and its frames are a few megabytes.
function create() {
  let list = null, shown = null;
  const read = rom => {
    if (list?.rom !== rom) {
      const sprites = new Map();
      list = { rom, species: readPokedex(rom, sprites), sprites };
    }
    return list.species;
  };
  const pkxOf = (rom, national, form) => {
    const entry = read(rom).find(item => item.national === national);
    if (!entry?.forms.some(item => item.id === form)) throw new Error('That Pokémon has no such model on this disc.');
    if (shown?.rom === rom && shown.form === form) return shown;
    const disc = new Disc(rom), file = form.startsWith(SHINY_FILTER) ? form.slice(SHINY_FILTER.length) : form;
    try {
      const pkx = Buffer.from(fsys.entries(disc.file(`pkx_${file}.fsys`))[0].data());
      // XD's models have XD's header in front: made Colosseum's, which hsd-model.js reads
      shown = { rom, form, pkx: xdDisc.isXd(disc) ? xdDisc.colosseumPkx(pkx) : pkx };
    } finally { disc.close(); }
    return shown;
  };
  return {
    list: read,
    // A Pokémon's sprite as the disc has it, for its HD replacement.
    spriteTexture: (rom, national) => (read(rom), list.sprites.get(national) || null),
    // shinyFilter: drawn with its shiny filter, for a shiny look without a model of its own
    model: (rom, national, form) => ({ ...hsd.parseModel(pkxOf(rom, national, form).pkx), shinyFilter: form.startsWith(SHINY_FILTER) }),
    clip: (rom, national, form, index) => hsd.parseClip(pkxOf(rom, national, form).pkx, index)
  };
}

module.exports = { create, readPokedex, classify, displayName, messageText, png, relData, readMessages, readDol, dolOffset, spritesOf,
  SPECIES, TYPES, ABILITY_MESSAGES, GIFTS, BONUS_DISC_GIFTS };
