'use strict';

// Pokémon XD's disc (GXXE01, revision 0: port.validateRom), read as the Pokédex and the Jukebox read Colosseum's. Its
// formats are Colosseum's family with XD's own tables:
//   - common_rel's data section has the species, messages and sound tables; the rel's prolog publishes each to a pointer
//     of main.dol's (relglobal.c: pokemon_data, snd_data, ...), so their places here are those it stores;
//   - a species row is 0x124 bytes (host/xd/packs.c in the port has its layout), metric where Colosseum's is imperial;
//   - the decks (deck_archive.fsys) list the trainers' Pokémon (DPKM) and which row each Shadow Pokémon battles with (DDPK);
//   - a model is a .pkx with XD's header in front (colosseumPkx);
//   - cries and music are streams: two channels of DSP-ADPCM in 0x8000-byte blocks, with an "I_SF" header
//     (host/xd/cries.c in the port), played by sound id through the sound table and its file table.
const fsys = require('./fsys');
const evolutionWays = require('./evolution-ways');

// common_rel's .data, as its prolog publishes it (offsets in the data section; each table's count is a word there too)
const TABLES = {
  species: { offset: 0x280f8, countAt: 0xa63ac, size: 0x124 },
  messages: [0x4c5c4],
  sounds: { offset: 0x45ff0, countAt: 0xa63cc, size: 12 },
  soundFiles: { offset: 0x4a694, countAt: 0xa63d0, size: 12 },
  music: { offset: 0x4bffc, countAt: 0xa63d8 },   // snd_test_bgm: the game's own sound test's songs, by sound id
  // Poké Spots (esabapokemondata_E1 to E3): 12-byte rows, the species at +2
  spots: [[0x12fc, 0xa62f8, 'Rock Poké Spot'], [0x1320, 0xa6304, 'Oasis Poké Spot'], [0x1344, 0xa6310, 'Cave Poké Spot']]
};
// main.dol: pokemon_pkx_data, an 8-byte row for each model id, the file's id at +4
const MODEL_TABLE = { address: 0x8040d0a8, countAddress: 0x804e84f8, size: 8, id: 4 };

// A species row (host/xd/packs.c make_species_row)
const SP = { catchRate: 0x01, height: 0x08, weight: 0x0a, voice: 0x0c, national: 0x12, name: 0x18, model: 0x2c, types: 0x30, abilities: 0x32,
  stats: 0x8e, evolutions: 0xa6 };
const SOUND_STREAM = 0x40;   // a sound table row's flags (its third byte): a stream

// The decks' sections: a tag, its size and row count, then the rows
const DPKM_ROW = 0x20, DDPK_ROW = 0x18, DDPK_STORY_ROW = 6;
const PLAYED_DECKS = ['DeckData_Story.bin', 'DeckData_Hundred.bin', 'DeckData_Colosseum.bin', 'DeckData_Virtual.bin', 'DeckData_Imasugu.bin'];

// How each of XD's gifts comes (host/randomizer.c: scriptCatchPokemon 8 to 14, and the starter), by species
const GIFTS = {
  133: 'Your partner from the very start of the game.',
  239: 'Traded to you in the story, for a Togepi or Togetic.',
  356: 'Traded to you in the story.',
  213: 'Traded to you in the story.',
  246: 'Traded to you in the story.',
  152: 'A reward from Mt. Battle: one of Chikorita, Cyndaquil and Totodile.',
  155: 'A reward from Mt. Battle: one of Chikorita, Cyndaquil and Totodile.',
  158: 'A reward from Mt. Battle: one of Chikorita, Cyndaquil and Totodile.'
};
const XD_STATUS = {
  shadow: { label: 'Shadow', locked: false, note: 'A Shadow Pokémon: snag it from a trainer in the story.' },
  gift: { label: 'Gift', locked: false },
  wild: { label: 'Poké Spot', locked: false },
  evolve: { label: 'Evolution', locked: false },
  battle: { label: 'Battle only', locked: true, note: 'Trainers use it, but XD has no way to catch one.' },
  hidden: { label: 'Hidden on disc', locked: true, note: 'Its model and data are on the disc, but nothing in the game uses it. It could only arrive by trade from a Game Boy Advance game.' }
};
// Deoxys's other looks are files of their own in XD
const DEOXYS = [['deoxys_atk', 'Attack'], ['deoxys_def', 'Defense'], ['deoxys_sp', 'Speed']];
const NATIONAL_DEOXYS = 386;

const isXd = disc => /^GXX/.test(disc.gameId || '');

function relOf(disc) {
  const rel = fsys.entries(disc.file('common.fsys')).find(entry => entry.name === 'common_rel');
  if (!rel) throw new Error('The game disc has no Pokémon data.');
  const bytes = rel.data(), sections = bytes.readUInt32BE(0x10);
  return Buffer.from(bytes.subarray(bytes.readUInt32BE(sections + 4 * 8) & ~1));
}

function table(data, { offset, countAt, size = 0 }, most = 4096) {
  const count = data.readUInt32BE(countAt);
  if (!count || count > most || offset + count * size > data.length) throw new Error('The game data on this disc isn\'t where it should be.');
  return count;
}

// The decks' rows: { story: Buffer of DPKM rows, shadow: [species by Shadow id], seen: Set of species }
function readDecks(disc) {
  const files = new Map(fsys.entries(disc.file('deck_archive.fsys')).map(entry => [entry.name, entry]));
  const sections = name => {
    const entry = files.get(name), found = {};
    if (!entry) return found;
    const deck = Buffer.from(entry.data());
    for (let at = 0x10; at + 0x10 <= deck.length;) {
      const tag = deck.toString('latin1', at, at + 4), size = deck.readUInt32BE(at + 4), count = deck.readUInt32BE(at + 8);
      if (!/^D[A-Z]{3}$/.test(tag) || size < 0x10) break;
      found[tag] = { rows: deck.subarray(at + 0x10, at + size), count };
      at += size;
    }
    return found;
  };
  const seen = new Set();
  for (const name of PLAYED_DECKS) {
    const pokemon = sections(name).DPKM;
    if (!pokemon) continue;
    for (let i = 0; i < pokemon.count; i++) {
      const species = pokemon.rows.readUInt16BE(i * DPKM_ROW);
      if (species) seen.add(species);
    }
  }
  const story = sections('DeckData_Story.bin').DPKM, dark = sections('DeckData_DarkPokemon.bin').DDPK, shadow = new Set();
  if (story && dark)
    for (let id = 1; id < dark.count; id++) {
      const row = dark.rows.readUInt16BE(id * DDPK_ROW + DDPK_STORY_ROW);
      const species = row && row < story.count ? story.rows.readUInt16BE(row * DPKM_ROW) : 0;
      if (species) shadow.add(species);
    }
  return { seen, shadow };
}

function readSpots(data) {
  const spots = new Map();
  for (const [offset, countAt, place] of TABLES.spots) {
    const count = data.readUInt32BE(countAt);
    for (let i = 0; i < count && i < 16; i++) {
      const species = data.readUInt16BE(offset + i * 12 + 2);
      if (species && !spots.has(species)) spots.set(species, place);
    }
  }
  return spots;
}

// Tenths of a metre and of a kilogram, shown as Colosseum's Pokédex shows its own: feet and inches, pounds
const height = tenths => { const inches = Math.round(tenths * 3.937); return `${Math.floor(inches / 12)}'${String(inches % 12).padStart(2, '0')}"`; };
const weight = tenths => `${(tenths * 0.220462).toFixed(1)} lbs`;

// XD's Pokémon, as pokedex.js readSpecies gives Colosseum's (it passes its own helpers: names, messages and TYPES)
function readSpecies(data, messages, { displayName, TYPES, ABILITY_MESSAGES }) {
  const { offset, size } = TABLES.species, count = table(data, TABLES.species, 1024), species = [];
  for (let id = 0; id < count; id++) {
    const at = offset + id * size, national = data.readUInt16BE(at + SP.national);
    if (!national) continue;
    const name = messages.get(data.readUInt32BE(at + SP.name));
    if (!name) continue;
    const types = [TYPES[data[at + SP.types]], TYPES[data[at + SP.types + 1]]], evolutions = [], ways = [];
    for (let i = 0; i < 5; i++) {
      const target = data.readUInt16BE(at + SP.evolutions + i * 6 + 4);
      if (data[at + SP.evolutions + i * 6] && target) evolutions.push(target), ways.push(evolutionWays.describeBytes(data, at + SP.evolutions + i * 6, { game: 'xd' }));
    }
    const abilities = [data[at + SP.abilities], data[at + SP.abilities + 1]].filter(Boolean).map(ability => displayName(messages.get(ABILITY_MESSAGES + ability) || ''));
    species.push({ id, national, name: displayName(name), types: types[0] === types[1] ? types.slice(0, 1) : types,
      abilities: [...new Set(abilities)].filter(Boolean), height: height(data.readUInt16BE(at + SP.height)), weight: weight(data.readUInt16BE(at + SP.weight)),
      catchRate: data[at + SP.catchRate], stats: Array.from({ length: 6 }, (_, i) => data.readUInt16BE(at + SP.stats + i * 2)), evolutions, evolutionWays: ways,
      model: data.readUInt32BE(at + SP.model) });
  }
  return species;
}

// How the player can come by each species in XD: the starter and gifts, Shadow Pokémon, Poké Spots, or by evolving one
// of those. There's no breeding in XD either.
function classify(species, { seen, shadow, spots }) {
  const byId = new Map(species.map(entry => [entry.id, entry])), from = new Map();
  const reached = [...shadow, ...Object.keys(GIFTS).map(Number), ...spots.keys()];
  for (let i = 0; i < reached.length; i++) {
    for (const target of byId.get(reached[i])?.evolutions || []) {
      if (from.has(target) || shadow.has(target) || GIFTS[target] || spots.has(target)) continue;
      from.set(target, reached[i]);
      reached.push(target);
    }
  }
  for (const entry of species) {
    const kind = shadow.has(entry.id) ? 'shadow' : GIFTS[entry.id] ? 'gift' : spots.has(entry.id) ? 'wild'
      : from.has(entry.id) ? 'evolve' : seen.has(entry.id) ? 'battle' : 'hidden';
    const note = kind === 'gift' ? GIFTS[entry.id] : kind === 'wild' ? `Found at the ${spots.get(entry.id)}, with Poké Snack laid out.`
      : kind === 'evolve' ? `Evolve ${byId.get(from.get(entry.id)).name} to get it.` : XD_STATUS[kind].note;
    entry.status = { kind, label: XD_STATUS[kind].label, locked: XD_STATUS[kind].locked, note };
  }
}

// The looks a species has on XD's disc: its model, its shiny model or filter, and Castform's, Unown's and Deoxys's others
function formsOf(entry, file, disc, colosseumForms) {
  const forms = colosseumForms(entry, file, disc);
  const has = stem => disc.files.has(`pkx_${stem}.fsys`);
  if (entry.national === NATIONAL_DEOXYS && forms.length) forms.push(...DEOXYS.filter(([stem]) => has(stem)).map(([id, label]) => ({ id, label })));
  return forms;
}

// XD's Pokémon, read as pokedex.js reads Colosseum's. helpers: pokedex.js's own (readDol, dolOffset, modelFiles, ...).
function readPokedex(disc, discSprites, helpers) {
  const data = relOf(disc), messages = helpers.readMessages(data, undefined, TABLES.messages);
  const species = readSpecies(data, messages, helpers);
  if (species[0]?.national !== 1 || species[0].stats[0] !== 45) throw new Error('The Pokémon data on this disc isn\'t where it should be.');
  classify(species, { ...readDecks(disc), spots: readSpots(data) });
  const dol = helpers.readDol(disc), files = helpers.modelFiles(disc), sprite = helpers.spritesOf(disc);
  const models = helpers.dolOffset(dol, MODEL_TABLE.address), modelCount = dol.readUInt32BE(helpers.dolOffset(dol, MODEL_TABLE.countAddress));
  for (const entry of species) {
    const file = entry.model < modelCount ? files.get(dol.readUInt32BE(models + entry.model * MODEL_TABLE.size + MODEL_TABLE.id)) : null;
    entry.forms = formsOf(entry, file, disc, helpers.formsOf);
    // body sprites are named by species, as Colosseum's are (body001, and body001_c for its shiny one); Unown's by letter
    const stem = `body${String(entry.id).padStart(3, '0')}`, image = sprite(null, stem) || sprite(null, `${stem}a`);
    entry.sprite = image?.url || null;
    if (image) discSprites?.set(entry.national, image.disc);
    delete entry.model;
  }
  helpers.nationalEvolutions(species);
  return species.sort((a, b) => a.national - b.national);
}

// --- Models: XD's .pkx as Colosseum's ------------------------------------------------------------------------------
// XD's (the reverse of host/xd/packs.c xd_pkx): a 0x84-byte header (the model's size at 0, its particles' at 8, the
// motion slots' count at 0x10, Colosseum's word 0xC at 0x14, the species at 0x18, four 19-byte eye and mouth
// animations from 0x1C (a flag, then the animation at +18), the shiny filter at 0x70: four channels, then RGBA), the
// slots (0xD0 bytes, timings in seconds, a motion in use marked non-zero), then the particles and the model. Colosseum's
// (hsd-model.js readHeader): a 0x40-byte header, the model, the particles, the slots (timings in frames, a motion in
// use marked 0), then the shiny filter.
const X_HEAD = 0x84, C_HEAD = 0x40, SLOT = 0xd0, SHINY = 0x14, PARTS = 0x1c, PART = 19, LOAD_MODE = 5, HAS_SHINY = 0x80000000;
const align32 = n => (n + 31) & ~31;

function colosseumPkx(x) {
  if (x.length < X_HEAD) throw new Error('A Pokémon\'s model file is damaged.');
  const dat = x.readUInt32BE(0), gpt = x.readUInt32BE(8), count = x.readUInt32BE(0x10);
  const head = align32(X_HEAD + count * SLOT), datAt = head + align32(gpt);
  if (count > 32 || datAt + dat > x.length) throw new Error('A Pokémon\'s model file is damaged.');
  const slots = C_HEAD + align32(dat) + align32(gpt), shiny = slots + align32(count * SLOT);
  const out = Buffer.alloc(shiny + SHINY);
  out.writeUInt32BE(dat, 0);
  out.writeUInt32BE(gpt, 4);
  out.writeUInt32BE(count, 8);
  x.copy(out, 0x0c, 0x14, 0x18);
  out.writeUInt32BE(LOAD_MODE, 0x10);
  out.writeUInt32BE(HAS_SHINY, 0x14);
  // sleep, wake and blink: the first three of XD's part animations
  for (let k = 0; k < 3; k++) out.writeInt32BE(x[PARTS + k * PART] ? x[PARTS + k * PART + 18] : -1, 0x18 + k * 4);
  x.copy(out, C_HEAD, datAt, datAt + dat);
  x.copy(out, C_HEAD + align32(dat), head, head + gpt);
  for (let i = 0; i < count; i++) {
    const from = X_HEAD + i * SLOT, to = slots + i * SLOT;
    x.copy(out, to, from, from + SLOT);
    for (let t = 0; t < 4; t++) out.writeUInt32BE(Math.round(x.readFloatBE(from + 0x10 + t * 4) * 60) >>> 0, to + 0x10 + t * 4);
    const motions = Math.min(x.readUInt32BE(from + 4), 8);
    for (let k = 0; k < motions; k++) out.writeUInt32BE(x.readUInt32BE(from + 0x8c + k * 8) ? 0 : 1, to + 0x8c + k * 8);
  }
  x.copy(out, shiny, 0x70, 0x80);
  out.set([x[0x83], x[0x80], x[0x81], x[0x82]], shiny + 0x10);
  return out;
}

// --- Sound: the sound table, its files, and streams -----------------------------------------------------------------

// Every archive's number (an FSYS header's word at +8, the number GSfsys.toc and the file table use) -> its disc file.
function archiveNames(disc, prefix = 'stm_') {
  const names = new Map();
  for (const [name, { offset, size }] of disc.files) {
    if (!name.startsWith(prefix) || !name.endsWith('.fsys') || size < 0x60) continue;
    const head = disc.read(offset, 0x10);
    if (head.toString('latin1', 0, 4) === 'FSYS') names.set(head.readUInt32BE(8), name);
  }
  return names;
}

function soundTables(data) {
  const sounds = TABLES.sounds, files = TABLES.soundFiles;
  return { data, sounds: table(data, sounds, 8192), files: table(data, files, 8192) };
}

// XD's sound table, whole, as the jukebox's effects read it (jukebox-effects.js): its rows of TABLES.sounds.size bytes.
function soundRows(disc) {
  const data = relOf(disc), count = soundTables(data).sounds;
  return Buffer.from(data.subarray(TABLES.sounds.offset, TABLES.sounds.offset + count * TABLES.sounds.size));
}

// A sound id's stream: { archive, head, data } (the archive's number and its two entries' ids, 0 for its own), or null.
function streamOf(tables, sound) {
  if (!Number.isInteger(sound) || sound < 0 || sound >= tables.sounds) return null;
  const row = TABLES.sounds.offset + sound * TABLES.sounds.size, data = tables.data;
  if (!(data[row + 2] & SOUND_STREAM)) return null;
  const file = data.readUInt16BE(row + 6);
  if (file >= tables.files) return null;
  const at = TABLES.soundFiles.offset + file * TABLES.soundFiles.size;
  const archive = data.readUInt32BE(at);
  return archive ? { archive, head: data.readUInt32BE(at + 4), data: data.readUInt32BE(at + 8) } : null;
}

// One channel of DSP-ADPCM, its history carried from frame to frame, from yn1 and yn2.
function decodeChannel(bytes, count, coefficients, yn1 = 0, yn2 = 0) {
  const out = new Int16Array(count);
  let previous = yn1, before = yn2;
  for (let frame = 0, n = 0; n < count && frame < bytes.length; frame += 8) {
    const header = bytes[frame], scale = 1 << (header & 0x0f), predictor = (header >> 4) & 7;
    const c1 = coefficients[predictor * 2], c2 = coefficients[predictor * 2 + 1];
    for (let k = 0; k < 14 && n < count; k++) {
      const byte = bytes[frame + 1 + (k >> 1)] ?? 0;
      let nibble = k & 1 ? byte & 0x0f : byte >> 4;
      if (nibble >= 8) nibble -= 16;
      const value = Math.max(-32768, Math.min(32767, Math.floor((nibble * scale * 2048 + c1 * previous + c2 * before + 1024) / 2048)));
      before = previous;
      previous = value;
      out[n++] = value;
    }
  }
  return out;
}

// A nibble address (2 past each frame's 16 nibbles' header byte) as a sample
const sampleAt = address => Math.floor(address / 16) * 14 + Math.max(0, (address % 16) - 2);

// A stream's "I_SF" header and its data: { rate, channels: [Int16Array], loop: { start, end } | null } (samples).
function decodeStream(head, data, most = Infinity) {
  if (head.toString('latin1', 0, 4) !== 'I_SF') throw new Error('That sound isn\'t on the disc as it should be.');
  const rate = head.readUInt32BE(8), count = Math.min(head.readUInt32BE(0x0c), most), channels = head.readUInt32BE(0x14), block = head.readUInt32BE(0x18);
  if (!rate || !channels || channels > 2 || !block) throw new Error('That sound isn\'t on the disc as it should be.');
  const bytes = Math.ceil(count / 14) * 8, out = [];
  for (let ch = 0; ch < channels; ch++) {
    const at = 0x40 + ch * 0x40, coefficients = Array.from({ length: 16 }, (_, i) => head.readInt16BE(at + i * 2));
    // the channel's blocks, one after another: the data alternates them, a block of each channel in turn
    const own = Buffer.alloc(bytes);
    for (let done = 0, index = ch; done < bytes; index += channels) {
      const from = index * block, take = Math.min(block, bytes - done, Math.max(0, data.length - from));
      if (take <= 0) break;
      data.copy(own, done, from, from + take);
      done += take;
    }
    out.push(decodeChannel(own, count, coefficients, head.readInt16BE(at + 0x24), head.readInt16BE(at + 0x26)));
  }
  const looped = head.readUInt32BE(0x1c) === 1;
  const loop = looped ? { start: sampleAt(head.readUInt32BE(0x20)), end: Math.min(count, sampleAt(head.readUInt32BE(0x28)) + 1) } : null;
  return { rate, channels: out, loop: loop && loop.end > loop.start ? loop : null };
}

// A stream's two entries: an archive's own (a song's archive has just its header and data), or the ones a cry's row names.
function streamEntries(disc, names, stream) {
  const name = names.get(stream.archive);
  if (!name) return null;
  const entries = fsys.entries(disc.file(name));
  const pick = (id, type) => (id ? entries.find(entry => entry.id === id) : entries.find(entry => entry.type === type));
  const head = pick(stream.head, 0x14), data = pick(stream.data, 0x15);
  return head && data ? { name, head: Buffer.from(head.data()), data: Buffer.from(data.data()) } : null;
}

// --- Cries -------------------------------------------------------------------------------------------------------

// What finding cries takes: each species' voice (a sound id), by National Pokédex number, and the sound tables.
function readCryTables(disc) {
  const data = relOf(disc), voices = new Map(), { offset, size } = TABLES.species, count = table(data, TABLES.species, 1024);
  for (let id = 0; id < count; id++) {
    const at = offset + id * size, national = data.readUInt16BE(at + SP.national);
    if (national && !voices.has(national)) voices.set(national, data.readUInt16BE(at + SP.voice));
  }
  return { voices, ...soundTables(data), names: archiveNames(disc, 'stm_se_nakigoe') };
}

function locateCry(tables, sound) {
  const stream = streamOf(tables, sound);
  return stream && tables.names.has(stream.archive) ? stream : null;
}

// A cry as XD plays it, mono: { samples, rate }, or null.
function decodeCry(disc, tables, sound) {
  const stream = locateCry(tables, sound), entries = stream && streamEntries(disc, tables.names, stream);
  if (!entries) return null;
  const { rate, channels } = decodeStream(entries.head, entries.data, 48000 * 10);
  const samples = channels.length === 1 ? channels[0] : channels[0].map((value, i) => (value + channels[1][i]) >> 1);
  return { samples, rate };
}

// --- Music -------------------------------------------------------------------------------------------------------

// What a song's file is called in the Jukebox: the ones we know by name, else the file's name made readable.
// The names are the fan labels of KHInsider's XD gamerip, matched by the file's name (often a Japanese word: kinkyu is an
// emergency, esaba a feeding spot, ketsui resolve, imasugu "right now", the Japanese name of Quick Battle) and its length. Those
// marked "?" fit one way, not both; the jingles the two games share are named as Colosseum's are (jukebox-names.js). A file that
// is another song's audio (the same length and loop) is named after it: with its place where its name gives one, else "(copy)".
// A song with no name here shows its file's name, until someone who knows it can tell.
const SONG_NAMES = {
  title: 'Title Screen', open_roll: 'Demo Opening', stand: 'Outskirt Stand', pokelabo: 'Pokémon HQ Lab', ioport: 'Gateon Port',
  pokecen: 'Pokémon Center', watercity: 'Phenac City', watercity2: 'Phenac City Crisis' /* ? */, libra: 'S.S. Libra', worldmap: 'World Map',
  mt_battle: 'Mt. Battle', mt_battle_uketsuke: 'Mt. Battle - Reception Counter', mt_battle_kyukei: 'Mt. Battle - Break Room' /* ? */,
  relivehall: 'Purification Chamber', relive_ceremony: 'Purification Ceremony',
  stage_perfect: 'Purification Chamber - Perfect', stage_verygood: 'Purification Chamber - Very Good', stage_good: 'Purification Chamber - Good',
  stage_bad: 'Purification Chamber - Bad',
  esaba: 'Poké Spot', b_esaba: 'Wild Pokémon Battle', bingo: 'Battle Bingo - Board', b_bingo: 'Battle Bingo - Battle',
  mirrorbo: 'Miror B.\'s Theme', b_mirrorbo: 'Miror B. Battle', snatch_ajito: 'Snagem Hideout', orecolosseum: 'Orre Colosseum',
  b_colosseum1: 'Colosseum - 1st Round', b_colosseum2: 'Colosseum - 2nd Round', b_colosseum3: 'Colosseum - Semi-Finals', b_colosseum4: 'Colosseum - Finals',
  nikeldark: 'Citadark Isle', dark_factory: 'Cipher Key Lair' /* ? */, darkside4: 'Cipher Lab' /* ? */, saint: 'Realgam Tower' /* ? */,
  shinpi: 'Fateen\'s Fortune Telling' /* ? */, tretre: 'Pre Gym' /* ? */,
  kaminko: 'Dr. Kaminko\'s Manor' /* ? */, kaminko2: 'Dr. Kaminko\'s Yard' /* ? */,
  ev_mechagradon: 'Robo Groudon', ev_6brothers: 'The Hexagon Brothers', ev_ketsui: 'We\'ll Finish the Purify Chamber Ourselves!',
  ev_ketsui2: 'Our Pride as Scientists' /* ? */, ev_kinkyu: 'Prof. Krane\'s Kidnap' /* ? */, ev_fuan: 'Trouble' /* ? */,
  ev_honobono: 'Jovi\'s Theme' /* ? */, ev_sad: 'Jovi Is Sad (unused)' /* ? */, ev_last: 'Master Greevil Defeated' /* ? */,
  ev_last2: 'Master Greevil Redeemed' /* ? */, ev_end: 'Ending',
  chr_rugia: 'Shadow Lugia\'s Theme', chr_helgonza: 'Gonzap\'s Theme', chr_boss01: 'Mr. Verich\'s Theme' /* ? */,
  b_rugia: 'Shadow Lugia Battle', b_lastboss: 'Master Greevil Final Battle', b_virtual: 'Battle Sim', b_wirie: 'Rider Willie Battle',
  xdbattle01: 'Normal Battle', xdbattle02: 'Cipher Battle', xdbattle03: 'Cipher Admin Battle' /* ? */,
  tool_minnade: 'VS Battle Mode (Version 1)', tool_imasugu: 'VS Battle Mode (Version 3)', tool_imasugu2: 'VS Battle Mode (Version 2)' /* ? */,
  tool_music: 'VS Mode Menu', clubtea: 'Krabby Klub' /* ? */,
  // copies of other songs' audio
  b_paira: 'Colosseum - 1st Round (Pyrite)', b_raruga: 'Colosseum - 2nd Round (Realgam)', b_nikeldark: 'Rider Willie Battle (Citadark)',
  xd_battle8: 'Rider Willie Battle (copy)', xd_battle0: 'Battle Sim (copy)', musicsoft: 'VS Mode Menu (copy)',
  me_win: 'Win Battle', me_level_up: 'Level Up', me_snatch: 'Snatch Shadow Pokémon', me_relive: 'Shadow Pokémon is Purified', me_welcome: 'Welcome',
  me_agb_fanfa1b: 'Get Item', me_agb_fanfa5: 'Congratulations (Evolution Success)', me_agb_me_asa: 'Heal Pokémon',
  me_agb_me_shinka: 'Evolution Jingle', me_agb_shinka: 'Pokémon is Evolving', me_fue: 'Time Flute', me_news: 'ONBS News Broadcast',
  me_snatchmachine: 'Snag Machine',
  ...Object.fromEntries([0, 1, 2, 3].map(i => [`me_fanfare0${i}`, `VS Battle Fanfare ${i + 1}`]))
};
function songTitle(file) {
  const stem = String(file).replace(/^stm_bgm_/, '').replace(/^stm_/, '').replace(/^me_me_/, 'me_').replace(/\.fsys$/, '');
  if (Object.hasOwn(SONG_NAMES, stem)) return SONG_NAMES[stem];
  const words = stem.replace(/^me_/, 'Jingle ').replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// The songs of XD's own sound test (snd_test_bgm), each once, without the silent stand-ins some licensed songs left:
// [{ id, sound, name }].
const SHORTEST_SONG = 2;   // seconds
function readSongs(disc) {
  const data = relOf(disc), tables = soundTables(data), names = archiveNames(disc, 'stm_');
  const { offset, countAt } = TABLES.music, count = data.readUInt32BE(countAt);
  if (!count || count > 1024) throw new Error('The game disc has no song list.');
  const tracks = [], seen = new Set();
  for (let i = 0; i < count; i++) {
    const sound = data.readUInt16BE(offset + i * 2), stream = streamOf(tables, sound), name = stream && names.get(stream.archive);
    if (!name || seen.has(stream.archive)) continue;
    seen.add(stream.archive);
    const head = fsys.entries(disc.file(name)).find(entry => entry.type === 0x14);
    if (!head) continue;
    const header = Buffer.from(head.data());
    if (header.toString('latin1', 0, 4) !== 'I_SF' || header.readUInt32BE(0x0c) < SHORTEST_SONG * header.readUInt32BE(8)) continue;
    tracks.push({ id: String(sound), sound, name: songTitle(name), seconds: header.readUInt32BE(0x0c) / header.readUInt32BE(8) });
  }
  return tracks;
}

// What renders XD's songs: { render(sound) -> { left, right, rate, loop } }, as jukebox-render.js's for Colosseum
// (Float32Array samples, the loop in seconds).
function songRenderer(disc) {
  const data = relOf(disc), tables = soundTables(data), names = archiveNames(disc, 'stm_');
  function render(sound, options = {}) {
    const stream = streamOf(tables, sound), entries = stream && streamEntries(disc, names, stream);
    if (!entries) throw new Error('That song is not on the disc.');
    const most = Math.round((options.most ?? 600) * entries.head.readUInt32BE(8));
    const { rate, channels, loop } = decodeStream(entries.head, entries.data, most);
    const left = Float32Array.from(channels[0], value => value / 32768);
    const right = channels[1] ? Float32Array.from(channels[1], value => value / 32768) : left;
    return { left, right, rate, loop: loop ? { start: loop.start / rate, end: loop.end / rate } : null };
  }
  return { render };
}

module.exports = { TABLES, MODEL_TABLE, GIFTS, isXd, relOf, readDecks, readSpots, readSpecies, classify, readPokedex, colosseumPkx, archiveNames,
  streamOf, decodeChannel, decodeStream, readCryTables, locateCry, decodeCry, songTitle, readSongs, songRenderer, soundRows, sampleAt };
