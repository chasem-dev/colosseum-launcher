'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const randomizer = require('../src/randomizer');
const port = require('../src/port');

const on = (extra = {}) => randomizer.normalize({ randomizer: true, randomizerSeed: 'C0FFEE11', ...extra });

test('off, nothing reaches the game, and no seed is made', () => {
  const settings = randomizer.normalize({});
  assert.equal(settings.randomizer, false);
  assert.equal(settings.randomizerSeed, '');
  assert.equal(randomizer.environmentValue(settings), null);
});

test('the setting says the seed, what changes and which generations', () => {
  assert.equal(randomizer.environmentValue(on()), 'C0FFEE11:19:7');
  assert.equal(randomizer.environmentValue(on({ randomizerTrainers: true, randomizerGifts: true })), 'C0FFEE11:31:7');
  assert.equal(randomizer.environmentValue(on({ randomizerNoLegendaries: true, randomizerGen2: false })), 'C0FFEE11:51:5');
});

test('by default a run changes the starters and Shadow Pokémon, from every generation, at similar strength', () => {
  const { randomizerStarters, randomizerShadow, randomizerTrainers, randomizerGifts, randomizerSimilar, randomizerNoLegendaries,
    randomizerGen1, randomizerGen2, randomizerGen3 } = randomizer.normalize({});
  assert.deepEqual({ randomizerStarters, randomizerShadow, randomizerTrainers, randomizerGifts, randomizerSimilar, randomizerNoLegendaries },
    { randomizerStarters: true, randomizerShadow: true, randomizerTrainers: false, randomizerGifts: false, randomizerSimilar: true, randomizerNoLegendaries: false });
  assert.deepEqual([randomizerGen1, randomizerGen2, randomizerGen3], [true, true, true]);
});

test('similar strength can be turned off', () => {
  assert.equal(randomizer.environmentValue(on({ randomizerSimilar: false })), 'C0FFEE11:3:7');
});

test('turning it on makes a seed, and a seed the player typed is kept', () => {
  assert.match(randomizer.normalize({ randomizer: true }).randomizerSeed, /^[0-9A-F]{8}$/);
  assert.equal(on({ randomizerSeed: 'abc' }).randomizerSeed, '00000ABC');
  assert.match(on({ randomizerSeed: 'not hex!' }).randomizerSeed, /^[0-9A-F]{8}$/);
});

test('a run needs a generation, so choosing none means all of them', () => {
  const settings = on({ randomizerGen1: false, randomizerGen2: false, randomizerGen3: false });
  assert.equal(randomizer.environmentValue(settings), 'C0FFEE11:19:7');
});

test('with nothing to change, a new save is the normal game', () => {
  const settings = on({ randomizerStarters: false, randomizerShadow: false, randomizerTrainers: false, randomizerGifts: false, randomizerSimilar: true });
  assert.equal(randomizer.environmentValue(settings), null);
});

test('the game is told only when it is on', () => {
  const env = settings => port.buildEnvironment(port.normalizeSettings(settings), '/disc.iso', '/game');
  assert.equal(env({}).COLO_RANDOMIZER, undefined);
  assert.equal(env({ randomizer: true, randomizerSeed: 'C0FFEE11' }).COLO_RANDOMIZER, 'C0FFEE11:19:7');
});

// A save's slot as the game writes it: the header, then the body scrambled against its own hash.
const SLOT = 0x1e000, FIRST = 0x6000, HASH = 0x1dfec, HASHED = 0x1dfd8, START = 0x18;
const sha1 = bytes => crypto.createHash('sha1').update(bytes).digest();
function slot(count, stamp) {
  const plain = Buffer.alloc(SLOT);
  plain[0] = plain[1] = 1;
  plain.writeInt32BE(count, 4);
  if (stamp) stamp.copy(plain, 8 + 0x1df80);
  const hash = sha1(plain.subarray(0, HASHED)), out = Buffer.from(plain);
  hash.copy(out, HASH);
  let key = Buffer.from(hash.map(byte => byte ^ 0xff));
  for (let offset = START; offset < HASHED; offset += 20) {
    for (let i = 0; i < 20; i++) out[offset + i] ^= key[i];
    key = sha1(out.subarray(offset, offset + 20));
  }
  let sum = 0;
  for (let word = 0; word < 8; word++) if (word !== 3) sum = (sum + out.readUInt32BE(word * 4)) >>> 0;
  out.writeUInt32BE((0x100000000 - sum) >>> 0, 0x0c);
  return out;
}
function stamp(seed, options = 15, generations = 7) {
  const out = Buffer.alloc(16);
  out.writeUInt32BE(0x43524e44, 0);
  out[4] = 1;
  out[5] = options;
  out[6] = generations;
  out.writeUInt32BE(seed, 8);
  out.writeUInt32BE((seed ^ 0x5eedc01d ^ (options << 8) ^ generations) >>> 0, 12);
  return out;
}
// temporary card folders, removed when the tests are done (they used to pile up in the system's temp folder)
const made = [];
test.after(() => { for (const folder of made) fs.rmSync(folder, { recursive: true, force: true }); });
function tempFolder() {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'colo-randomizer-'));
  made.push(folder);
  return folder;
}
function card(...slots) {
  const folder = tempFolder();
  fs.writeFileSync(path.join(folder, 'pokemon_colosseum.dat'), Buffer.concat([Buffer.alloc(FIRST), ...slots]));
  return folder;
}

test('a save says its run, from the copy the game would load', () => {
  const folder = card(slot(1, stamp(0xc0ffee11)), slot(2, stamp(0xbadc0de5, 31, 2)), slot(0));
  assert.deepEqual(randomizer.readSave(folder), { exists: true, run: { seed: 'BADC0DE5', options: 31, generations: 2 } });
});

test('a save with no stamp is the normal game, even over an older run', () => {
  assert.deepEqual(randomizer.readSave(card(slot(1, stamp(0xc0ffee11)), slot(2), slot(0))), { exists: true, run: null });
});

test('a stamp that does not check out is no run', () => {
  const broken = stamp(0xc0ffee11);
  broken[9] ^= 1;
  assert.equal(randomizer.readSave(card(slot(1, broken), slot(0), slot(0))).run, null);
});

test('no save, or one that cannot be read, is no run', () => {
  assert.deepEqual(randomizer.readSave(tempFolder()), { exists: false, run: null });
  const folder = tempFolder();
  fs.writeFileSync(path.join(folder, 'pokemon_colosseum.dat'), Buffer.alloc(16));
  assert.equal(randomizer.readSave(folder).run, null);
});

test('the reader follows the save when it changes', () => {
  const folder = card(slot(1, stamp(0xc0ffee11)), slot(0), slot(0)), read = randomizer.createSaveReader();
  assert.equal(read(folder).run.seed, 'C0FFEE11');
  const later = new Date(Date.now() + 5000), file = path.join(folder, 'pokemon_colosseum.dat');
  fs.writeFileSync(file, Buffer.concat([Buffer.alloc(FIRST), slot(1, stamp(0xbadc0de5)), slot(0), slot(0)]));
  fs.utimesSync(file, later, later);
  assert.equal(read(folder).run.seed, 'BADC0DE5');
});

test('spoilers name the Pokémon and leave the teams out', () => {
  const raw = 'seed C0FFEE11 options 15 generations 7\nstarter 197 25\ngift 311 6\nshadow 1 296 28\nrow 8 100 296 28 1 2 3 4\n';
  const text = randomizer.spoilerText(raw, [{ national: 197, name: 'Umbreon' }, { national: 25, name: 'Pikachu' }, { national: 311, name: 'Plusle' },
    { national: 6, name: 'Charizard' }, { national: 296, name: 'Makuhita' }, { national: 28, name: 'Sandslash' }]);
  assert.match(text, /seed C0FFEE11/);
  assert.match(text, /Umbreon is now Pikachu/);
  assert.match(text, /Plusle is now Charizard/);
  assert.match(text, /Makuhita is now Sandslash/);
  assert.doesNotMatch(text, /row/);
  assert.equal(randomizer.spoilerSeed(raw), 'C0FFEE11');
  assert.equal(randomizer.spoilerSeed(null), null);
});

test('a run has Pokémon packs\' Pokémon when there are some and the game can choose them, and is chosen to start with', () => {
  assert.equal(randomizer.normalize({}).randomizerPacks, true);
  assert.equal(randomizer.normalize({ randomizerPacks: false }).randomizerPacks, false);
  assert.equal(randomizer.environmentValue(on(), { packPokemon: true }), 'C0FFEE11:83:7');
  assert.equal(randomizer.environmentValue(on({ randomizerPacks: false }), { packPokemon: true }), 'C0FFEE11:19:7');
  // without packs, or with a game from before, the run is the one it always was, and stays so when a pack is added
  assert.equal(randomizer.environmentValue(on()), 'C0FFEE11:19:7');
  assert.equal(randomizer.environmentValue(on(), { packPokemon: false }), 'C0FFEE11:19:7');
  // packs alone randomize nothing
  const nothing = on({ randomizerStarters: false, randomizerShadow: false });
  assert.equal(randomizer.environmentValue(nothing, { packPokemon: true }), null);
  const env = (settings, options) => port.buildEnvironment(port.normalizeSettings(settings), '/disc.iso', '/game', options);
  assert.equal(env({ randomizer: true, randomizerSeed: 'C0FFEE11' }, { packPokemon: true }).COLO_RANDOMIZER, 'C0FFEE11:83:7');
  assert.equal(env({ randomizer: true, randomizerSeed: 'C0FFEE11' }, {}).COLO_RANDOMIZER, 'C0FFEE11:19:7');
});

test('spoilers name a pack\'s Pokémon by its place in the species table, not its base\'s number', () => {
  const raw = 'seed C0FFEE11 options 83 generations 7\nstarter 197 65788\nshadow 1 296 66636\n';
  const species = [{ national: 197, name: 'Umbreon' }, { national: 296, name: 'Makuhita' }];
  // Moonfang is based on Umbreon and keeps its number: 65788 is 65536 + its row, 252
  const text = randomizer.spoilerText(raw, species, [{ packId: 252, national: 197, name: 'Moonfang' }]);
  assert.match(text, /Umbreon is now Moonfang/);
  assert.match(text, /Makuhita is now a Pokémon of a pack that isn't here now/);
});

test('a run has Generation 4 Pokémon when they are added and the game knows them, and is chosen to start with', () => {
  // the settings as the launcher keeps them: the randomizer's, with the generations whose Pokémon are added
  const gen4 = extra => ({ ...on(extra), generationPokemon: [4] });
  assert.equal(randomizer.normalize({}).randomizerGen4, true);
  assert.equal(randomizer.environmentValue(gen4(), { laterGenerations: true }), 'C0FFEE11:19:15');
  assert.equal(randomizer.environmentValue(gen4({ randomizerGen4: false }), { laterGenerations: true }), 'C0FFEE11:19:7');
  // without the Pokémon, or with a game from before, the run is the game's own three: the same run it always was
  assert.equal(randomizer.environmentValue(on(), { laterGenerations: true }), 'C0FFEE11:19:7');
  assert.equal(randomizer.environmentValue(gen4()), 'C0FFEE11:19:7');
  // only the fourth, without its Pokémon: the game's own three rather than none
  const only4 = { randomizerGen1: false, randomizerGen2: false, randomizerGen3: false };
  assert.equal(randomizer.environmentValue(gen4(only4), { laterGenerations: true }), 'C0FFEE11:19:8');
  assert.equal(randomizer.environmentValue(on(only4), { laterGenerations: true }), 'C0FFEE11:19:7');
});
