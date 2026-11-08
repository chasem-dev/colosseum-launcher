'use strict';

// Pokémon packs: Pokémon of the player's own making, each in a folder of a pack's,
// mods/pokemon/<pack>/<pokemon>/, with a pokemon.json and, if it has its own looks, a model
// and sprites. docs/pokemon-packs.md is the guide for making one.
//
// The launcher reads them, checks them against the game on the player's disc, and writes
// them to one file for the game (COLO_POKEMON_PACKS; host/pokemonpacks.c in the port).
// Every Pokémon starts as a copy of the one it's based on and changes what its pokemon.json
// says. Each takes one of the 25 rows of the game's species table that the game leaves
// empty, and keeps it: which row is whose is kept beside the saves (pokemon-packs.json), so
// a Pokémon in a save stays itself when packs come and go.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { Disc } = require('./disc');
const fsys = require('./fsys');
const pokedex = require('./pokedex');

const FIRST_ID = 252, LAST_ID = 276;
// Past the gap, pack Pokémon go after the rows kept for later generations' Pokémon (src/generations.js: 413 up).
const FIRST_PAST_GAP = 1100, LAST_ID_PAST_GAP = 4000;
const REGISTRY_FILE = 'pokemon-packs.json';
const ENTRY_FILE = 'pokemon.json', PACK_FILE = 'pack.json';
const FILES = { model: 'model.pkx', modelShiny: 'model-shiny.pkx', body: 'body.png', bodyShiny: 'body-shiny.png', face: 'face.png', faceShiny: 'face-shiny.png' };
const ASSETS = ['model', 'modelShiny', 'body', 'bodyShiny', 'face', 'faceShiny'];
const SPRITE_SIZE = { body: [64, 64], face: [42, 42] };
const MAX_MODEL = 8 << 20, MAX_PNG = 4 << 20, MAX_JSON = 256 << 10;
const NAME_LENGTH = 10;
const MAGIC = 0x43504b4d, VERSION = 2;

// The species row (PokemonData in the decompilation).
const ROW = {
  growth: 0x00, catchRate: 0x01, gender: 0x02, exp: 0x06, friendship: 0x08, height: 0x0a, weight: 0x0c, cry: 0x0e,
  national: 0x12, types: 0x30, abilities: 0x32, tms: 0x34, stats: 0x84, evYield: 0x90, evolutions: 0x9c, moves: 0xba
};
const ABILITY_COUNT = 77;   // Stench to Cacophony; the messages after them are other text
const TM_TABLE = 0x80368018;
const TM_COUNT = 50, HM_COUNT = 8, EVOLUTIONS = 5, LEVEL_MOVES = 20;
const MOVES = { offset: 0x11c7c4, count: 358, size: 0x38, name: 0x20 };
const STATS = ['hp', 'attack', 'defense', 'spAttack', 'spDefense', 'speed'];
const GROWTH = ['mediumFast', 'erratic', 'fluctuating', 'mediumSlow', 'fast', 'slow'];
const EVOLVE = { friendship: 1, friendshipDay: 2, friendshipNight: 3, level: 4, trade: 5, tradeItem: 6, item: 7 };
// Items that make a Pokémon evolve, by the game's numbers for them.
const EVOLUTION_ITEMS = { 'sun stone': 93, 'moon stone': 94, 'fire stone': 95, 'thunder stone': 96, 'thunderstone': 96, 'water stone': 97,
  'leaf stone': 98, "king's rock": 187, 'deep sea tooth': 192, 'deepseatooth': 192, 'deep sea scale': 193, 'deepseascale': 193,
  'metal coat': 199, 'dragon scale': 201, 'up-grade': 218 };
// The letters the game's font has for a name.
const NAME_CHARACTERS = /^[A-Za-z0-9 .'\-♂♀éÉ]+$/u;

const key = text => String(text).toLowerCase().replace(/[\s_]+/g, ' ').replace(/é/g, 'e').trim();

const isPackRow = id => Number.isInteger(id) && ((id >= FIRST_ID && id <= LAST_ID) || (id >= FIRST_PAST_GAP && id <= LAST_ID_PAST_GAP));

function packsDirectory(userData) { return path.join(userData, 'mods', 'pokemon'); }

// --- What the disc has: species, moves and abilities by name, and the sprites' headers ----

function readGameTables(rom) {
  const disc = new Disc(rom);
  try {
    const rel = fsys.entries(disc.file('common.fsys')).find(entry => entry.name === 'common_rel');
    if (!rel) throw new Error('The game disc has no Pokémon data.');
    const data = pokedex.relData(rel.data()), messages = pokedex.readMessages(data);
    const species = [];
    for (let id = 0; id < pokedex.SPECIES.count; id++) {
      const at = pokedex.SPECIES.offset + id * pokedex.SPECIES.size, national = data.readUInt16BE(at + ROW.national);
      const name = national && messages.get(data.readUInt32BE(at + 0x18));
      if (name) species.push({ id, national, name: pokedex.displayName(name), row: Buffer.from(data.subarray(at, at + pokedex.SPECIES.size)) });
    }
    const moves = new Map(), moveRows = [];
    for (let id = 0; id < MOVES.count; id++) moveRows.push(Buffer.from(data.subarray(MOVES.offset + id * MOVES.size, MOVES.offset + (id + 1) * MOVES.size)));
    for (let id = 1; id < MOVES.count; id++) {
      const name = messages.get(data.readUInt32BE(MOVES.offset + id * MOVES.size + MOVES.name));
      if (name && !moves.has(key(name))) moves.set(key(name), id);
    }
    const abilities = new Map();
    for (let id = 1; id <= ABILITY_COUNT; id++) {
      const name = messages.get(pokedex.ABILITY_MESSAGES + id);
      if (name && !abilities.has(key(name))) abilities.set(key(name), id);
    }
    // The move each TM and HM teaches (main.dol's table: 8 bytes a row, the move at +4).
    const dol = pokedex.readDol(disc), tmTable = pokedex.dolOffset(dol, TM_TABLE);
    const tmMoves = new Map();
    for (let i = TM_COUNT + HM_COUNT - 1; i >= 0; i--) tmMoves.set(dol.readUInt32BE(tmTable + i * 8 + 4), i);
    // A sprite's 0x80-byte header, from one of the disc's own in the format a pack's is made in (RGBA8).
    const header = (file, width, height) => {
      const entry = fsys.entries(disc.file(file)).find(each => {
        const head = each.data();
        return head.readUInt16BE(0) === width && head.readUInt16BE(2) === height && head[0x0b] === 0x45;
      });
      if (!entry) throw new Error(`The game disc has no sprite to copy in ${file}.`);
      return Buffer.from(entry.data().subarray(0, 0x80));
    };
    return { species, moves, moveRows, abilities, tmMoves, types: pokedex.TYPES.map(key),
      headers: { body: header('poke_body.fsys', 64, 64), face: header('poke_face.fsys', 42, 84) } };
  } finally { disc.close(); }
}

// --- The rows kept beside the saves --------------------------------------------------------

function readRegistry(saveDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(saveDir, REGISTRY_FILE), 'utf8'));
    const ids = {};
    for (const [name, id] of Object.entries(parsed?.ids || {}))
      if (isPackRow(id) && !Object.values(ids).includes(id)) ids[name] = id;
    return { ids };
  } catch (error) {
    if (error.code === 'ENOENT') return { ids: {} };
    throw new Error(`${REGISTRY_FILE} beside your saves can't be read: ${error.message}`);
  }
}

function writeRegistry(saveDir, registry) {
  fs.mkdirSync(saveDir, { recursive: true });
  const file = path.join(saveDir, REGISTRY_FILE), temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify({ about: 'Which species row each Pokémon pack\'s Pokémon has. Your saves hold these numbers: keep this file with them.', ids: registry.ids }, null, 2)}\n`);
  fs.renameSync(temporary, file);
}

// The row each Pokémon has, or gets: the one it had before, else the first that no Pokémon,
// here now or before, has had: the 25 the game leaves empty, then rows past its own.
function assignIds(names, registry) {
  const ids = { ...registry.ids }, taken = new Set(Object.values(ids)), out = new Map(), full = [];
  const next = id => id === LAST_ID ? FIRST_PAST_GAP : id + 1;
  for (const name of names) {
    if (ids[name]) { out.set(name, ids[name]); continue; }
    let id = FIRST_ID;
    while (taken.has(id) && id <= LAST_ID_PAST_GAP) id = next(id);
    if (id > LAST_ID_PAST_GAP) { full.push(name); continue; }
    ids[name] = id;
    taken.add(id);
    out.set(name, id);
  }
  return { ids: out, registry: { ids }, full, changed: Object.keys(ids).length !== Object.keys(registry.ids).length };
}

// --- PNG -----------------------------------------------------------------------------------

// RGBA from a PNG of 8 bits a channel (or a palette of up to 8 bits), not interlaced.
function decodePng(file) {
  if (file.length < 8 || file.readUInt32BE(0) !== 0x89504e47) throw new Error('isn\'t a PNG image');
  let at = 8, width = 0, height = 0, depth = 0, color = 0, interlace = 0, palette = null, alpha = null;
  const data = [];
  while (at + 12 <= file.length) {
    const length = file.readUInt32BE(at), type = file.toString('latin1', at + 4, at + 8), body = file.subarray(at + 8, at + 8 + length);
    at += 12 + length;
    if (type === 'IHDR') {
      width = body.readUInt32BE(0); height = body.readUInt32BE(4);
      depth = body[8]; color = body[9]; interlace = body[12];
    }
    else if (type === 'PLTE') palette = body;
    else if (type === 'tRNS') alpha = body;
    else if (type === 'IDAT') data.push(body);
    else if (type === 'IEND') break;
  }
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[color];
  if (!width || !height || width > 1024 || height > 1024) throw new Error('has no size, or is over 1024 pixels on a side');
  if (!channels || interlace || (color === 3 ? ![1, 2, 4, 8].includes(depth) : depth !== 8) || (color === 3 && !palette))
    throw new Error('is a kind of PNG this can\'t read: save it as 8-bit RGBA, not interlaced');
  const raw = zlib.inflateSync(Buffer.concat(data)), bits = depth * channels, stride = Math.ceil(width * bits / 8), step = Math.max(1, bits >> 3);
  if (raw.length < (stride + 1) * height) throw new Error('is cut short');
  const rows = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), out = rows.subarray(y * stride, (y + 1) * stride);
    const up = y ? rows.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const left = x >= step ? out[x - step] : 0, above = up[x], corner = x >= step ? up[x - step] : 0;
      let predict = 0;
      if (filter === 1) predict = left;
      else if (filter === 2) predict = above;
      else if (filter === 3) predict = (left + above) >> 1;
      else if (filter === 4) {
        const p = left + above - corner, pa = Math.abs(p - left), pb = Math.abs(p - above), pc = Math.abs(p - corner);
        predict = pa <= pb && pa <= pc ? left : pb <= pc ? above : corner;
      }
      out[x] = (line[x] + predict) & 0xff;
    }
  }
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const o = (y * width + x) * 4, row = rows.subarray(y * stride);
    if (color === 3) {
      const index = (row[(x * depth) >> 3] >> (8 - depth - ((x * depth) & 7))) & ((1 << depth) - 1);
      rgba[o] = palette[index * 3]; rgba[o + 1] = palette[index * 3 + 1]; rgba[o + 2] = palette[index * 3 + 2];
      rgba[o + 3] = alpha && index < alpha.length ? alpha[index] : 255;
    } else {
      const p = row.subarray(x * channels);
      const gray = color === 0 || color === 4;
      rgba[o] = p[0]; rgba[o + 1] = gray ? p[0] : p[1]; rgba[o + 2] = gray ? p[0] : p[2];
      rgba[o + 3] = color === 4 ? p[1] : color === 6 ? p[3] : 255;
    }
  }
  return { width, height, rgba };
}

// The image at another size, each pixel the average of what it covers (or the nearest, when larger).
function resize(image, width, height) {
  if (image.width === width && image.height === height) return image;
  const out = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const x0 = Math.floor(x * image.width / width), x1 = Math.max(x0 + 1, Math.floor((x + 1) * image.width / width));
    const y0 = Math.floor(y * image.height / height), y1 = Math.max(y0 + 1, Math.floor((y + 1) * image.height / height));
    const sum = [0, 0, 0, 0];
    let weight = 0;
    for (let sy = y0; sy < y1; sy++) for (let sx = x0; sx < x1; sx++) {
      const o = (sy * image.width + sx) * 4, a = image.rgba[o + 3];
      sum[0] += image.rgba[o] * a; sum[1] += image.rgba[o + 1] * a; sum[2] += image.rgba[o + 2] * a; sum[3] += a;
      weight++;
    }
    const o = (y * width + x) * 4;
    for (let c = 0; c < 3; c++) out[o + c] = sum[3] ? Math.round(sum[c] / sum[3]) : 0;
    out[o + 3] = Math.round(sum[3] / weight);
  }
  return { width, height, rgba: out };
}

// A GameCube RGBA8 texture: 4x4 tiles, each the alpha-red pairs then the green-blue ones.
function encodeRgba8(image) {
  const { width, height, rgba } = image, out = Buffer.alloc(Math.ceil(width / 4) * Math.ceil(height / 4) * 64);
  let at = 0;
  for (let ty = 0; ty < height; ty += 4) for (let tx = 0; tx < width; tx += 4) {
    for (let i = 0; i < 16; i++) {
      const x = tx + (i & 3), y = ty + (i >> 2), o = (y * width + x) * 4, inside = x < width && y < height;
      out[at + i * 2] = inside ? rgba[o + 3] : 0; out[at + i * 2 + 1] = inside ? rgba[o] : 0;
      out[at + 32 + i * 2] = inside ? rgba[o + 1] : 0; out[at + 32 + i * 2 + 1] = inside ? rgba[o + 2] : 0;
    }
    at += 64;
  }
  return out;
}

// A sprite as the game's archives hold one: the disc's header for its size, then the image.
// A body sprite is one 64x64 image. A face is 42x42, and its texture holds two, the normal
// face above the shiny one (the game crops the one it shows): a face without a shiny one of
// its own has the normal face in both.
function spriteFile(kind, header, png, shinyPng = null) {
  const [width, height] = SPRITE_SIZE[kind];
  const image = resize(decodePng(png), width, height);
  if (kind === 'body') return Buffer.concat([header, encodeRgba8(image)]);
  const shiny = shinyPng ? resize(decodePng(shinyPng), width, height) : image;
  return Buffer.concat([header, encodeRgba8({ width, height: height * 2, rgba: Buffer.concat([image.rgba, shiny.rgba]) })]);
}

// --- Reading a pack -------------------------------------------------------------------------

function readJson(file) {
  const size = fs.statSync(file).size;
  if (size > MAX_JSON) throw new Error(`${path.basename(file)} is too big`);
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw new Error(`${path.basename(file)} isn't valid JSON: ${error.message}`); }
}

const isObject = value => value && typeof value === 'object' && !Array.isArray(value);
const integer = (value, min, max, what) => {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${what} must be a whole number from ${min} to ${max}`);
  return value;
};

// A species by its name or National Pokédex number.
function findSpecies(tables, value, what) {
  const found = typeof value === 'number' ? tables.species.find(each => each.national === value)
    : typeof value === 'string' ? tables.species.find(each => key(each.name) === key(value)) : null;
  if (!found) throw new Error(`${what} "${value}" isn't a Pokémon in the game`);
  return found;
}

// A move or ability by its name, or by its number (the same in every game from Ruby and Sapphire on).
function named(map, value, what) {
  const id = typeof value === 'string' ? map.get(key(value)) : Number.isInteger(value) && [...map.values()].includes(value) ? value : undefined;
  if (!id) throw new Error(`${what} ${JSON.stringify(value)} isn't one the game has`);
  return id;
}

// One pokemon.json, applied to a copy of its base's row. `target` finds an evolution's
// species: a Pokémon of a pack (by its folder, or pack/folder) or of the game.
function buildRow(spec, tables, target) {
  if (!isObject(spec)) throw new Error(`${ENTRY_FILE} must hold an object`);
  if (spec.base === undefined) throw new Error('"base" is missing: the Pokémon this one starts from');
  const base = findSpecies(tables, spec.base, 'base');
  const row = Buffer.from(base.row);
  const form = spec.form === undefined ? null : String(spec.form).trim();
  if (form === '') throw new Error('"form" can\'t be empty');
  // In capitals, as the game's own names are.
  const name = spec.name === undefined ? (form ? base.name.toUpperCase() : null) : String(spec.name).trim().toUpperCase();
  if (!name) throw new Error('"name" is missing (only a form can go without, and keep its base\'s)');
  if (name.length > NAME_LENGTH || !NAME_CHARACTERS.test(name)) throw new Error(`"name" must be 1 to ${NAME_LENGTH} letters, numbers, spaces or . ' - ♂ ♀ é`);

  if (spec.types !== undefined) {
    if (!Array.isArray(spec.types) || !spec.types.length || spec.types.length > 2) throw new Error('"types" must list one or two types');
    const ids = spec.types.map(type => {
      const id = tables.types.indexOf(key(type));
      if (id < 0 || key(type) === '???') throw new Error(`type "${type}" isn't one the game has`);
      return id;
    });
    row[ROW.types] = ids[0]; row[ROW.types + 1] = ids[1] ?? ids[0];
  }
  if (spec.abilities !== undefined) {
    if (!Array.isArray(spec.abilities) || !spec.abilities.length || spec.abilities.length > 2) throw new Error('"abilities" must list one or two abilities');
    const ids = spec.abilities.map(ability => named(tables.abilities, ability, 'ability'));
    row[ROW.abilities] = ids[0]; row[ROW.abilities + 1] = ids[1] ?? 0;
  }
  for (const [field, at] of [['stats', ROW.stats], ['evYield', ROW.evYield]]) {
    if (spec[field] === undefined) continue;
    if (!isObject(spec[field])) throw new Error(`"${field}" must be an object of ${STATS.join(', ')}`);
    for (const stat of Object.keys(spec[field])) if (!STATS.includes(stat)) throw new Error(`"${field}" has "${stat}": use ${STATS.join(', ')}`);
    STATS.forEach((stat, i) => {
      if (spec[field][stat] !== undefined) row.writeUInt16BE(integer(spec[field][stat], field === 'stats' ? 1 : 0, field === 'stats' ? 255 : 3, `${field}.${stat}`), at + i * 2);
    });
  }
  if (spec.catchRate !== undefined) row[ROW.catchRate] = integer(spec.catchRate, 1, 255, '"catchRate"');
  if (spec.baseExp !== undefined) row.writeUInt16BE(integer(spec.baseExp, 1, 0xffff, '"baseExp"'), ROW.exp);
  if (spec.baseFriendship !== undefined) row.writeUInt16BE(integer(spec.baseFriendship, 0, 255, '"baseFriendship"'), ROW.friendship);
  if (spec.growthRate !== undefined) {
    const id = GROWTH.indexOf(spec.growthRate);
    if (id < 0) throw new Error(`"growthRate" must be one of ${GROWTH.join(', ')}`);
    row[ROW.growth] = id;
  }
  if (spec.gender !== undefined) {
    if (spec.gender === 'genderless') row[ROW.gender] = 255;
    // The game's number is out of 256, one under: 12.5 in 100 is 31, half is 127.
    else if (typeof spec.gender === 'number' && spec.gender >= 0 && spec.gender <= 100) row[ROW.gender] = Math.max(0, Math.min(254, Math.round(spec.gender * 2.56) - 1));
    else throw new Error('"gender" must be "genderless", or how many in 100 are female (0 to 100)');
  }
  if (spec.height !== undefined) {
    if (typeof spec.height !== 'number' || spec.height <= 0 || spec.height > 100) throw new Error('"height" must be in metres, more than 0 and up to 100');
    const inches = Math.max(1, Math.round(spec.height / 0.0254));
    row.writeUInt16BE(Math.floor(inches / 12) * 100 + inches % 12, ROW.height);
  }
  if (spec.weight !== undefined) {
    if (typeof spec.weight !== 'number' || spec.weight <= 0 || spec.weight > 2000) throw new Error('"weight" must be in kilograms, more than 0 and up to 2000');
    row.writeUInt16BE(Math.max(1, Math.round(spec.weight * 22.0462)), ROW.weight);
  }
  // Its own National Pokédex number (a later generation's Pokémon have theirs), else its base's
  if (spec.national !== undefined) row.writeUInt16BE(integer(spec.national, 1, 2000, '"national"'), ROW.national);
  if (spec.cry !== undefined) row.writeUInt16BE(findSpecies(tables, spec.cry, 'cry').row.readUInt16BE(ROW.cry), ROW.cry);
  if (spec.moves !== undefined) {
    if (!Array.isArray(spec.moves) || !spec.moves.length || spec.moves.length > LEVEL_MOVES) throw new Error(`"moves" must list 1 to ${LEVEL_MOVES} [level, "Move"] pairs`);
    row.fill(0, ROW.moves, ROW.moves + LEVEL_MOVES * 4);
    spec.moves.map(pair => {
      if (!Array.isArray(pair) || pair.length !== 2) throw new Error('each of "moves" must be [level, "Move"]');
      return [integer(pair[0], 1, 100, 'a move\'s level'), named(tables.moves, pair[1], 'move')];
    }).sort((a, b) => a[0] - b[0]).forEach(([level, move], i) => {
      row[ROW.moves + i * 4] = level;
      row.writeUInt16BE(move, ROW.moves + i * 4 + 2);
    });
  }
  if (spec.tms !== undefined) {
    if (!Array.isArray(spec.tms)) throw new Error('"tms" must list TMs and HMs, such as "TM06" or "HM01"');
    row.fill(0, ROW.tms, ROW.tms + TM_COUNT + HM_COUNT);
    for (const tm of spec.tms) {
      const match = /^(TM|HM)(\d{1,2})$/i.exec(String(tm).trim());
      const number = match && Number(match[2]), hm = match && match[1].toUpperCase() === 'HM';
      if (!match || number < 1 || number > (hm ? HM_COUNT : TM_COUNT)) throw new Error(`"${tm}" isn't a TM (TM01 to TM50) or HM (HM01 to HM08)`);
      row[ROW.tms + (hm ? TM_COUNT : 0) + number - 1] = 1;
    }
  }
  // Moves it can learn from a TM or HM in any game: those this game's TMs and HMs teach.
  if (spec.tmMoves !== undefined) {
    if (!Array.isArray(spec.tmMoves)) throw new Error('"tmMoves" must list moves, by name or number');
    if (spec.tms === undefined) row.fill(0, ROW.tms, ROW.tms + TM_COUNT + HM_COUNT);
    for (const move of spec.tmMoves) {
      const id = typeof move === 'string' ? tables.moves.get(key(move)) : move;
      if (Number.isInteger(id) && tables.tmMoves.has(id)) row[ROW.tms + tables.tmMoves.get(id)] = 1;
    }
  }
  if (spec.evolutions !== undefined) {
    if (!Array.isArray(spec.evolutions) || spec.evolutions.length > EVOLUTIONS) throw new Error(`"evolutions" must list up to ${EVOLUTIONS} evolutions`);
    row.fill(0, ROW.evolutions, ROW.evolutions + EVOLUTIONS * 6);
    spec.evolutions.forEach((evolution, i) => {
      if (!isObject(evolution) || evolution.into === undefined) throw new Error('each evolution needs "into": what it evolves into');
      const methods = ['level', 'item', 'friendship', 'trade'].filter(method => evolution[method] !== undefined);
      if (methods.length !== 1) throw new Error('each evolution needs one of "level", "item", "friendship" or "trade"');
      let method, condition = 0;
      if (methods[0] === 'level') { method = EVOLVE.level; condition = integer(evolution.level, 1, 100, 'an evolution\'s level'); }
      else if (methods[0] === 'item') {
        method = EVOLVE.item;
        condition = EVOLUTION_ITEMS[key(evolution.item)];
        if (!condition) throw new Error(`"${evolution.item}" isn't an evolution item: use ${Object.keys(EVOLUTION_ITEMS).filter((k, at, all) => all.findIndex(o => EVOLUTION_ITEMS[o] === EVOLUTION_ITEMS[k]) === at).join(', ')}`);
      } else if (methods[0] === 'friendship') {
        if (![true, 'day', 'night'].includes(evolution.friendship)) throw new Error('"friendship" must be true, "day" or "night"');
        method = { true: EVOLVE.friendship, day: EVOLVE.friendshipDay, night: EVOLVE.friendshipNight }[evolution.friendship];
      } else {
        if (evolution.trade === true) method = EVOLVE.trade;
        else {
          method = EVOLVE.tradeItem;
          condition = EVOLUTION_ITEMS[key(evolution.trade)];
          if (!condition) throw new Error('"trade" must be true, or the item it holds while traded');
        }
      }
      row[ROW.evolutions + i * 6] = method;
      row.writeUInt16BE(condition, ROW.evolutions + i * 6 + 2);
      row.writeUInt16BE(target(evolution.into), ROW.evolutions + i * 6 + 4);
    });
  }
  return { row, base, name, form, description: typeof spec.description === 'string' ? spec.description.slice(0, 500) : '' };
}

// A pack folder's own name: letters, numbers, - and _, so it can't reach outside mods/pokemon.
const FOLDER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/;

function listFolders(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isDirectory() && FOLDER.test(entry.name)).map(entry => entry.name).sort(); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

// Every pack in `dir`, checked against `tables` (readGameTables). Pokémon with something
// wrong are left out, each with a problem saying what. ids gives each its row.
function loadPacks(dir, tables, registry) {
  const problems = [], found = [];
  for (const pack of listFolders(dir)) {
    let about = {};
    const packFile = path.join(dir, pack, PACK_FILE);
    if (fs.existsSync(packFile)) {
      try { about = readJson(packFile); if (!isObject(about)) throw new Error(`${PACK_FILE} must hold an object`); }
      catch (error) { problems.push({ pack, message: error.message }); continue; }
    }
    const folders = listFolders(path.join(dir, pack)).filter(folder => fs.existsSync(path.join(dir, pack, folder, ENTRY_FILE)));
    if (!folders.length) problems.push({ pack, message: `has no Pokémon: each goes in a folder of its own with a ${ENTRY_FILE}` });
    for (const folder of folders) found.push({ pack, folder, key: `${pack}/${folder}`, about, dir: path.join(dir, pack, folder) });
  }
  const assigned = assignIds(found.map(each => each.key), registry);
  for (const name of assigned.full) {
    const each = found.find(item => item.key === name);
    problems.push({ pack: each.pack, entry: each.folder, message: `doesn't fit: the game has room for ${LAST_ID - FIRST_ID + 1} Pokémon from packs` });
  }
  const placed = found.filter(each => assigned.ids.has(each.key));
  const target = pack => value => {
    if (typeof value === 'string') {
      const name = value.includes('/') ? value : `${pack}/${value}`;
      if (assigned.ids.has(name) && placed.some(each => each.key === name)) return assigned.ids.get(name);
    }
    return findSpecies(tables, value, 'evolution "into"').id;
  };
  const pokemon = [];
  for (const each of placed) {
    try {
      const spec = readJson(path.join(each.dir, ENTRY_FILE));
      const built = buildRow(spec, tables, target(each.pack));
      const files = {};
      for (const asset of ASSETS) {
        const file = path.join(each.dir, FILES[asset]);
        if (!fs.existsSync(file)) continue;
        if (fs.statSync(file).size > (asset.startsWith('model') ? MAX_MODEL : MAX_PNG)) throw new Error(`${FILES[asset]} is too big`);
        files[asset] = fs.readFileSync(file);
      }
      if (files.modelShiny && !files.model) throw new Error(`${FILES.modelShiny} needs a ${FILES.model} beside it`);
      if (files.faceShiny && !files.face) throw new Error(`${FILES.faceShiny} needs a ${FILES.face} beside it`);
      if (files.bodyShiny && !files.body) throw new Error(`${FILES.bodyShiny} needs a ${FILES.body} beside it`);
      for (const asset of ['model', 'modelShiny']) if (files[asset] && files[asset].length < 0x100) throw new Error(`${FILES[asset]} is too small to be a model`);
      const sprite = (asset, make) => {
        try { return make(); } catch (error) { throw new Error(`${FILES[asset]} ${error.message}`); }
      };
      const assets = { model: files.model, modelShiny: files.modelShiny,
        body: files.body && sprite('body', () => spriteFile('body', tables.headers.body, files.body)),
        bodyShiny: files.bodyShiny && sprite('bodyShiny', () => spriteFile('body', tables.headers.body, files.bodyShiny)),
        face: files.face && sprite(files.faceShiny ? 'faceShiny' : 'face', () => spriteFile('face', tables.headers.face, files.face, files.faceShiny)) };
      // Images the Pokédex shows, as they are
      const images = { body: files.body || null, bodyShiny: files.bodyShiny || null, face: files.face || null };
      pokemon.push({ ...each, id: assigned.ids.get(each.key), ...built, assets, images,
        packName: typeof each.about.name === 'string' ? each.about.name.slice(0, 80) : each.pack,
        author: typeof each.about.author === 'string' ? each.about.author.slice(0, 80) : '',
        credits: typeof each.about.credits === 'string' ? each.about.credits.slice(0, 300) : '' });
    } catch (error) {
      problems.push({ pack: each.pack, entry: each.folder, message: error.message });
    }
  }
  // An evolution into a Pokémon that was left out is no evolution.
  for (const each of pokemon) for (let i = 0; i < EVOLUTIONS; i++) {
    const into = each.row.readUInt16BE(ROW.evolutions + i * 6 + 4);
    if (into >= FIRST_ID && into <= LAST_ID && !pokemon.some(other => other.id === into)) {
      each.row.fill(0, ROW.evolutions + i * 6, ROW.evolutions + i * 6 + 6);
      problems.push({ pack: each.pack, entry: each.folder, message: 'evolves into a Pokémon that couldn\'t be loaded, so that evolution is left out' });
    }
  }
  const missing = Object.keys(assigned.registry.ids).filter(name => !found.some(each => each.key === name));
  return { pokemon, problems, registry: assigned.registry, registryChanged: assigned.changed, missing };
}

// --- The game's file ------------------------------------------------------------------------

// The game's file (host/pokemonpacks.c): chunks of Pokémon (SPEC), new moves (MOVE) and battle rules (MECH, host/
// mechanics.c). `contents` is { pokemon, moves, rules } (src/generations.js build makes the last two), or just the
// Pokémon.
function compile(contents) {
  const { pokemon = [], moves = [], rules = null } = Array.isArray(contents) ? { pokemon: contents } : contents;
  const padded = buffer => Buffer.concat([buffer, Buffer.alloc((4 - buffer.length % 4) % 4)]);
  const utf16 = text => { const out = Buffer.alloc(text.length * 2); [...text].forEach((c, i) => out.writeUInt16BE(c.charCodeAt(0), i * 2)); return out; };
  const u32 = value => { const out = Buffer.alloc(4); out.writeUInt32BE(value >>> 0, 0); return out; };
  const chunks = [];
  const chunk = (tag, parts) => { const body = Buffer.concat(parts); chunks.push(Buffer.from(tag, 'latin1'), u32(body.length), padded(body)); };
  if (pokemon.length) {
    const parts = [u32(pokemon.length)];
    for (const each of pokemon) {
      const head = Buffer.alloc(8);
      head.writeUInt16BE(each.id, 0); head.writeUInt16BE(each.base.id, 2); head.writeUInt16BE(each.name.length, 4);
      parts.push(head, each.row, padded(utf16(each.name)));
      for (const asset of ASSETS) {
        const data = each.assets[asset] || Buffer.alloc(0);
        parts.push(u32(data.length), padded(data));
      }
    }
    chunk('SPEC', parts);
  }
  if (moves.length) {
    const parts = [u32(moves.length)];
    for (const move of moves) {
      const head = Buffer.alloc(8), description = move.description.slice(0, 120);
      head.writeUInt16BE(move.id, 0); head.writeUInt16BE(move.name.length, 2); head.writeUInt16BE(description.length, 4);
      parts.push(head, move.row, padded(Buffer.concat([utf16(move.name), utf16(description)])));
    }
    chunk('MOVE', parts);
  }
  if (rules) {
    const head = Buffer.alloc(12);
    head[0] = rules.generation; head.writeUInt32BE(rules.features, 4);
    head.writeUInt16BE(rules.categories.length, 8); head.writeUInt16BE(rules.changed.length, 10);
    const parts = [head, padded(rules.categories)];
    for (const change of rules.changed) { const id = Buffer.alloc(4); id.writeUInt16BE(change.id, 0); parts.push(id, change.row); }
    chunk('MECH', parts);
  }
  const header = Buffer.alloc(16);
  header.writeUInt32BE(MAGIC, 0); header.writeUInt32BE(VERSION, 4); header.writeUInt32BE(chunks.length / 3, 8);
  return Buffer.concat([header, ...chunks]);
}

// A converted Pokémon's own model and icons, as a pack's are, or none.
function ownLooks(folder, tables) {
  const file = name => { const at = path.join(folder, name); return fs.existsSync(at) ? fs.readFileSync(at) : null; };
  const model = file(FILES.model);
  if (!model) return { assets: {}, images: {} };
  const body = file(FILES.body), bodyShiny = file(FILES.bodyShiny), face = file(FILES.face), faceShiny = file(FILES.faceShiny);
  const sprite = make => { try { return make(); } catch (_) { return undefined; } };
  return {
    assets: { model, modelShiny: file(FILES.modelShiny) || undefined,
      body: body ? sprite(() => spriteFile('body', tables.headers.body, body)) : undefined,
      bodyShiny: bodyShiny ? sprite(() => spriteFile('body', tables.headers.body, bodyShiny)) : undefined,
      face: face ? sprite(() => spriteFile('face', tables.headers.face, face, faceShiny)) : undefined },
    images: { body, bodyShiny, face }, converted: true
  };
}

// A later generation's Pokémon (src/generations.js build), as packs' Pokémon are: rows of their own, standing in
// for their looks with a Pokémon Colosseum has, and with that generation's new moves among the moves they can learn.
// modelsDirectory: where Battle Revolution models are made (src/pbr-models.js), a folder for each National Pokédex number
// with model.pkx, model-shiny.pkx and its icons: a Pokémon with one has its own looks there instead of a stand-in's.
function generationPokemon(tables, built, { modelsDirectory = null } = {}) {
  const generationsLib = require('./generations');
  const withMoves = { ...tables, moves: new Map([...tables.moves, ...built.moves.map(move => [key(move.name), move.id])]) };
  const target = value => {
    const match = /^generation:(\d+)$/.exec(String(value));
    if (match) return generationsLib.speciesId(Number(match[1]));
    return findSpecies(tables, value, 'evolution "into"').id;
  };
  const pokemon = [], problems = [];
  for (const { id, number, generation, spec } of built.species) {
    try {
      const made = buildRow(spec, withMoves, target);
      const own = modelsDirectory ? ownLooks(path.join(modelsDirectory, String(number)), tables) : { assets: {}, images: {} };
      pokemon.push({ pack: `generation-${generation}`, folder: String(number), key: `generation:${number}`, id, ...made, national: number,
        ...own, packName: `Generation ${generation}`, author: '', credits: 'Pokémon Showdown\'s data (MIT)', generation });
    } catch (error) {
      problems.push({ pack: `generation-${generation}`, entry: `#${number} ${spec.name}`, message: error.message });
    }
  }
  return { pokemon, problems };
}

// What the Pokédex shows of each: as its own entries do (pokedex.js), and where it's from.
function pokedexEntries(pokemon, tables) {
  const TYPES = pokedex.TYPES;
  return pokemon.map(each => {
    const row = each.row, types = [TYPES[row[ROW.types]], TYPES[row[ROW.types + 1]]];
    const height = row.readUInt16BE(ROW.height);
    const abilities = [row[ROW.abilities], row[ROW.abilities + 1]].filter(Boolean)
      .map(id => [...tables.abilities].find(([, value]) => value === id)?.[0]).filter(Boolean).map(pokedex.displayName);
    const evolutions = [];
    for (let i = 0; i < EVOLUTIONS; i++) {
      const into = row.readUInt16BE(ROW.evolutions + i * 6 + 4);
      if (row[ROW.evolutions + i * 6] && into) evolutions.push(into);
    }
    return { pack: { id: each.pack, name: each.packName, author: each.author, credits: each.credits, folder: each.folder, key: each.key },
      packId: each.id, national: each.national || each.base.national, base: each.base.name, form: each.form,
      name: each.form ? `${pokedex.displayName(each.name)} (${each.form})` : pokedex.displayName(each.name), description: each.description,
      types: types[0] === types[1] ? types.slice(0, 1) : types, abilities: [...new Set(abilities)],
      height: `${Math.floor(height / 100)}'${String(height % 100).padStart(2, '0')}"`, weight: `${(row.readUInt16BE(ROW.weight) / 10).toFixed(1)} lbs`,
      catchRate: row[ROW.catchRate], stats: STATS.map((_, i) => row.readUInt16BE(ROW.stats + i * 2)),
      evolutions: evolutions.map(id => pokemon.find(other => other.id === id)?.key || tables.species.find(s => s.id === id)?.national).filter(Boolean),
      hasModel: Boolean(each.assets.model), hasShinyModel: Boolean(each.assets.modelShiny),
      status: each.generation
        ? { kind: 'generation', label: `Generation ${each.generation}`, locked: false,
          note: each.converted
            ? `Added by the Generation ${each.generation} Pokémon setting, with its model and icons made from your Battle Revolution disc (StarsMmd's Blender-Addon-Gamecube-Models writes them). ${each.base.name}'s cry stands in for its own. From Pokémon Showdown's data.`
            : `Added by the Generation ${each.generation} Pokémon setting. ${each.base.name} stands in for its looks and cry until Battle Revolution models are made. From Pokémon Showdown's data.` }
        : { kind: 'pack', label: each.form ? `${each.form} form, from a pack` : 'From a pack', locked: false,
          note: `${each.packName}${each.author ? `, by ${each.author}` : ''}. Based on ${each.base.name}.${each.description ? ` ${each.description}` : ''}` +
            `${each.credits ? ` Credits: ${each.credits}` : ''}` } };
  });
}

module.exports = { FIRST_ID, LAST_ID, FIRST_PAST_GAP, REGISTRY_FILE, FILES, packsDirectory, readGameTables, readRegistry, writeRegistry, assignIds,
  decodePng, resize, encodeRgba8, spriteFile, buildRow, loadPacks, compile, generationPokemon, pokedexEntries,
  // A species the original game hasn't: a pack's, or a later generation's
  isPackSpecies: id => (id >= FIRST_ID && id <= LAST_ID) || id >= 413 };
