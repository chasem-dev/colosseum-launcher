'use strict';

// The randomizer's settings, and what a save says about its run. The game does the choosing
// (host/randomizer.c in the port): a new save takes the setting, and keeps its seed from then on.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { newestPlain } = require('./gci-save');
const xdSave = require('./xd-save');

// What can change, as the game's stamp holds it.
const OPTIONS = { randomizerStarters: 1, randomizerShadow: 2, randomizerTrainers: 4, randomizerGifts: 8, randomizerSimilar: 16, randomizerNoLegendaries: 32,
  randomizerPacks: 64 };
const PARTS = 15;
const PACKS = 64;   // Pokémon packs' own Pokémon too (src/pokemon-packs.js)
// A pack's own Pokémon in the game's spoiler log: this much past its place in the species table, as it may share its base's number.
const PACK_SPECIES = 0x10000;
const GENERATIONS = { randomizerGen1: 1, randomizerGen2: 2, randomizerGen3: 4, randomizerGen4: 8 };
const GAME_GENERATIONS = 7;   // the game's own: the first three
const GEN4 = 8;

// The stamp, in a save's unscrambled slot: its place in the body, past where the body starts.
const STAMP = 8 + 0x1df80;
const STAMP_MAGIC = 0x43524e44;
const STAMP_VERSION = 1;
const CHECK = 0x5eedc01d;

const SAVE_FILE = 'pokemon_colosseum.dat';
// Each game's card file, and where its stamp is in the save it loads: XD keeps it in reserve 1's room of its pack
// (host/randomizer.c), which moves from save to save (xd-save.js).
const SAVES = {
  colosseum: { file: SAVE_FILE, read: data => ({ plain: newestPlain(data).plain, at: STAMP }) },
  xd: { file: 'PokemonXD.dat', read: data => {
    const pack = xdSave.newestPack(data);
    if (!pack) throw new Error('no save the game would load');
    return { plain: pack.plain, at: xdSave.stampAt(pack.plain) };
  } }
};
const saveOf = gameId => SAVES[gameId] || SAVES.colosseum;
const SPOILER_FILE = 'randomizer-spoiler.txt';

function newSeed() { return crypto.randomBytes(4).toString('hex').toUpperCase(); }

function normalizeSeed(input) {
  const seed = String(input ?? '').trim().toUpperCase();
  return /^[0-9A-F]{1,8}$/.test(seed) ? seed.padStart(8, '0') : '';
}

// The settings as they are kept: on, a seed once it's on, and at least one generation, as a run needs one. The fourth
// counts only with Generation 4 Pokémon added (environmentValue), and is chosen to start with, as the first three are.
// So are Pokémon packs' Pokémon, which count only when there are some.
function normalize(input = {}) {
  const settings = { randomizer: Boolean(input.randomizer), randomizerSeed: normalizeSeed(input.randomizerSeed),
    randomizerStarters: input.randomizerStarters !== false, randomizerShadow: input.randomizerShadow !== false,
    randomizerTrainers: Boolean(input.randomizerTrainers), randomizerGifts: Boolean(input.randomizerGifts),
    randomizerSimilar: input.randomizerSimilar !== false, randomizerNoLegendaries: Boolean(input.randomizerNoLegendaries),
    randomizerGen1: input.randomizerGen1 !== false, randomizerGen2: input.randomizerGen2 !== false, randomizerGen3: input.randomizerGen3 !== false,
    randomizerGen4: input.randomizerGen4 !== false, randomizerPacks: input.randomizerPacks !== false };
  if (!settings.randomizerGen1 && !settings.randomizerGen2 && !settings.randomizerGen3 && !settings.randomizerGen4)
    settings.randomizerGen1 = settings.randomizerGen2 = settings.randomizerGen3 = settings.randomizerGen4 = true;
  if (settings.randomizer && !settings.randomizerSeed) settings.randomizerSeed = newSeed();
  return settings;
}

function flags(settings, table) {
  return Object.entries(table).reduce((bits, [key, bit]) => (settings[key] ? bits | bit : bits), 0);
}

// Whether a run would have the fourth generation: it's chosen, its Pokémon are added (settings.generationPokemon), and
// the game knows it (laterGenerations: a game before it would stamp the save with it and ignore it, and the run would
// change once the game updates).
const hasGen4 = (settings, laterGenerations) => Boolean(settings.randomizerGen4 && laterGenerations
  && Array.isArray(settings.generationPokemon) && settings.generationPokemon.includes(4));

// COLO_RANDOMIZER for these settings, or null when a new save should be the normal game. A run of only the fourth
// generation without its Pokémon is a run of the game's own three. packPokemon: the player has Pokémon packs' Pokémon and
// the game can choose them. Without them the run isn't one with packs, so it stays as it is when a pack is added later.
function environmentValue(settings, { laterGenerations = false, packPokemon = false } = {}) {
  const options = flags(settings, OPTIONS) & (packPokemon ? ~0 : ~PACKS);
  if (!settings.randomizer || !settings.randomizerSeed || !(options & PARTS)) return null;
  let generations = flags(settings, GENERATIONS) & (hasGen4(settings, laterGenerations) ? GAME_GENERATIONS | GEN4 : GAME_GENERATIONS);
  if (!generations) generations = GAME_GENERATIONS;
  return `${settings.randomizerSeed}:${options}:${generations}`;
}

// The run a save's unscrambled slot holds, or null for the normal game. at: where the stamp is (XD's moves).
function runOf(plain, at = STAMP) {
  if (at < 0 || plain.length < at + 16 || plain.readUInt32BE(at) !== STAMP_MAGIC || plain[at + 4] !== STAMP_VERSION) return null;
  const options = plain[at + 5], generations = plain[at + 6], seed = plain.readUInt32BE(at + 8);
  const expected = (seed ^ CHECK ^ (options << 8) ^ generations) >>> 0;
  if (plain.readUInt32BE(at + 12) !== expected) return null;
  return { seed: seed.toString(16).toUpperCase().padStart(8, '0'), options, generations };
}

// What gameId's save in a memory card folder is: { exists: false }, or whether it's a run and which.
function readSave(saveDirectory, gameId = 'colosseum') {
  const save = saveOf(gameId);
  let data;
  try { data = fs.readFileSync(path.join(saveDirectory, save.file)); }
  catch (_) { return { exists: false, run: null }; }
  try {
    const { plain, at } = save.read(data);
    return { exists: true, run: runOf(plain, at) };
  } catch (_) { return { exists: false, run: null }; }
}

// readSave, read again only when the save file changes.
function createSaveReader() {
  let known = null;
  return (saveDirectory, gameId = 'colosseum') => {
    const { file } = saveOf(gameId);
    let stamp = `${gameId}:${saveDirectory}`;
    try {
      const stat = fs.statSync(path.join(saveDirectory, file));
      stamp += `:${stat.size}:${stat.mtimeMs}`;
    } catch (_) { stamp += ':none'; }
    if (known?.stamp !== stamp) known = { stamp, save: readSave(saveDirectory, gameId) };
    return known.save;
  };
}

// What each game's spoilers call its parts: XD starts with one Eevee, and its gifts are trades and Mt. Battle's.
const SPOILER_TEXT = {
  colosseum: { title: 'Pokémon Colosseum randomizer', starters: 'Starters', gifts: 'Gifts' },
  xd: { title: 'Pokémon XD: Gale of Darkness randomizer', starters: 'Starter', gifts: 'Gifts and trades' }
};

// The game's spoiler log (what host/randomizer.c writes) as a player reads it. Teams' rows are
// left out: thousands of lines, and each trainer's turn to surprise (in XD a row is its deck's kind * 4096 plus its
// row, which says nothing to a player either). species are named by their National Pokédex
// numbers, and packs (Pokémon packs' own, { packId, name }) by their places in the species table.
function spoilerText(raw, species, packs = [], gameId = 'colosseum') {
  const words = SPOILER_TEXT[gameId] || SPOILER_TEXT.colosseum;
  const nameOf = number => number >= PACK_SPECIES
    ? packs.find(entry => entry.packId === number - PACK_SPECIES)?.name || 'a Pokémon of a pack that isn\'t here now'
    : species.find(entry => entry.national === number)?.name || `#${number}`;
  const lines = String(raw).trim().split('\n'), [, seed] = (lines[0] || '').split(' ');
  const out = [`${words.title}: seed ${seed}`, ''];
  const section = (title, kind, describe) => {
    const items = lines.map(line => line.split(' ')).filter(parts => parts[0] === kind);
    if (items.length) out.push(title, ...items.map(describe), '');
  };
  const swap = ([, was, now]) => `  ${nameOf(Number(was))} is now ${nameOf(Number(now))}`;
  section(words.starters, 'starter', swap);
  section(words.gifts, 'gift', swap);
  section('Shadow Pokémon', 'shadow', ([, , was, now]) => `  ${nameOf(Number(was))} is now ${nameOf(Number(now))}`);
  return out.join('\n');
}

function spoilerSeed(raw) { return (String(raw).match(/^seed ([0-9A-F]{8})/) || [])[1] || null; }

module.exports = { OPTIONS, GENERATIONS, PACKS, SPOILER_FILE, hasGen4, newSeed, normalizeSeed, normalize, environmentValue, runOf, readSave, createSaveReader, spoilerText, spoilerSeed };
