'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const xdSave = require('../src/xd-save');
const randomizer = require('../src/randomizer');
const story = require('../src/story-party');

const CARD = 43 * 0x2000;
const utf16 = (bytes, offset, value) => Buffer.from(value, 'utf16le').swap16().copy(bytes, offset);

// A pack as the game lays it out before enciphering: keys, the sections' places (shuffled, as each save shuffles
// them), the trainer and party, the Shadow Pokémon records and the randomizer's stamp in reserve 1.
function pack({ keys = [0x1234, 0xbeef, 0x0042, 0xf00d], hero = 0x5000, dark = 0x100, reserve = 0x1f000, party = [], darkStatus = {}, run = null } = {}) {
  const plain = Buffer.alloc(xdSave.PACK_SIZE);
  keys.forEach((key, i) => plain.writeUInt16BE(key, i * 2));
  const place = (table, at) => { plain.writeUInt16BE(at & 0xffff, table); plain.writeUInt16BE(at >>> 16, table + 2); };
  place(xdSave.SECTION.hero, hero);
  place(xdSave.SECTION.darkPokemon, dark);
  place(xdSave.SECTION.reserve1, reserve);
  const heroAt = xdSave.BODY + hero;
  utf16(plain, heroAt, 'MICHAEL');
  plain.writeUInt32BE(0xd183a6d5, heroAt + 0x2c);
  party.forEach((pokemon, i) => {
    const at = heroAt + xdSave.PARTY + i * xdSave.POKEMON;
    plain.writeUInt16BE(pokemon.species, at);
    plain.writeUInt16BE(pokemon.item ?? 0, at + 0x02);
    plain.writeUInt16BE(pokemon.friendship ?? 70, at + 0x06);
    plain[at + 0x0f] = pokemon.ball ?? 4;
    plain[at + 0x11] = pokemon.level ?? 10;
    plain[at + 0x1d] = (pokemon.egg ? 0x80 : 0) | (pokemon.ability ? 0x40 : 0);
    plain.writeUInt32BE(pokemon.trainer ?? 0xd183a6d5, at + 0x24);
    plain.writeUInt32BE(pokemon.rnd ?? 0xa7c39f64, at + 0x28);
    utf16(plain, at + 0x4e, pokemon.nickname ?? 'EEVEE');
    (pokemon.moves || [[33, 0]]).forEach(([move, ups], k) => { plain.writeUInt16BE(move, at + 0x80 + k * 4); plain[at + 0x83 + k * 4] = ups; });
    (pokemon.evs || []).forEach((value, k) => plain.writeUInt16BE(value, at + 0x9c + k * 2));
    (pokemon.ivs || []).forEach((value, k) => { plain[at + 0xa8 + k] = value; });
    plain.writeUInt16BE(pokemon.shadowId ?? 0, at + 0xba);
  });
  for (const [id, status] of Object.entries(darkStatus)) plain[xdSave.BODY + dark + Number(id) * xdSave.DARK_POKEMON] = status << 5;
  if (run) {
    const at = xdSave.BODY + reserve;
    plain.writeUInt32BE(0x43524e44, at);
    plain[at + 4] = 1; plain[at + 5] = run.options; plain[at + 6] = run.generations;
    plain.writeUInt32BE(run.seed, at + 8);
    plain.writeUInt32BE((run.seed ^ 0x5eedc01d ^ (run.options << 8) ^ run.generations) >>> 0, at + 12);
  }
  return plain;
}

// A card file of slots, each { count, plain } enciphered (or broken: its sums wrong).
function card(...slots) {
  const data = Buffer.alloc(CARD);
  slots.forEach((slot, i) => {
    if (!slot) return;
    const start = xdSave.SLOTS[i];
    data[start] = data[start + 1] = data[start + 2] = 1;
    data.writeInt32BE(slot.count, start + 4);
    const out = xdSave.encipher(slot.plain);
    if (slot.broken) out[0x9000] ^= 1;
    out.copy(data, start + xdSave.PACK);
  });
  return data;
}

function saveFolder(t, data) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xd-save-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  if (data) fs.writeFileSync(path.join(dir, 'PokemonXD.dat'), data);
  return dir;
}

test('a pack goes back to what it was, its sums checked', () => {
  const plain = pack({ party: [{ species: 133 }] });
  const { plain: back, valid } = xdSave.decipher(xdSave.encipher(plain));
  assert.equal(valid, true);
  assert.deepEqual(back.subarray(24), plain.subarray(24), 'past the keys and sums, every byte as it was');
  const broken = xdSave.encipher(plain);
  broken[0x2000] ^= 0x10;
  assert.equal(xdSave.decipher(broken).valid, false);
});

test('the game loads the newest slot whose sums hold', () => {
  const older = pack({ party: [{ species: 133, nickname: 'OLD' }] }), newer = pack({ hero: 0x9000, party: [{ species: 133, nickname: 'NEW' }] });
  assert.equal(xdSave.party(xdSave.newestPack(card({ count: 1, plain: older }, { count: 2, plain: newer })).plain).party[0].nickname, 'NEW');
  assert.equal(xdSave.party(xdSave.newestPack(card({ count: 3, plain: older }, { count: 2, plain: newer })).plain).party[0].nickname, 'OLD');
  assert.equal(xdSave.party(xdSave.newestPack(card({ count: 1, plain: older }, { count: 2, plain: newer, broken: true })).plain).party[0].nickname, 'OLD');
  assert.equal(xdSave.newestPack(Buffer.alloc(CARD)), null);
});

test('the randomizer\'s run is read from reserve 1, wherever this save put it', t => {
  const run = { seed: 0x1234abcd, options: 15, generations: 7 };
  for (const reserve of [0x1f000, 0x22c50]) {
    const dir = saveFolder(t, card({ count: 1, plain: pack({ reserve, run }) }));
    assert.deepEqual(randomizer.readSave(dir, 'xd'), { exists: true, run: { seed: '1234ABCD', options: 15, generations: 7 } });
  }
  assert.deepEqual(randomizer.readSave(saveFolder(t, card({ count: 1, plain: pack() })), 'xd'), { exists: true, run: null });
  assert.deepEqual(randomizer.readSave(saveFolder(t, null), 'xd'), { exists: false, run: null });
  // Colosseum's save in the same folder is another file
  assert.deepEqual(randomizer.readSave(saveFolder(t, card({ count: 1, plain: pack({ run }) }))), { exists: false, run: null });
});

test('the save reader reads each game\'s save', t => {
  const dir = saveFolder(t, card({ count: 1, plain: pack({ run: { seed: 0xbadf00d, options: 15, generations: 15 } }) }));
  const read = randomizer.createSaveReader();
  assert.equal(read(dir, 'xd').run.seed, '0BADF00D');
  assert.equal(read(dir).run, null);
  assert.equal(read(dir, 'xd').run.generations, 15);
});

test('XD\'s spoilers name its starter and its gifts and trades', () => {
  const species = [{ national: 133, name: 'Eevee' }, { national: 370, name: 'Luvdisc' }, { national: 239, name: 'Elekid' }, { national: 49, name: 'Venomoth' },
    { national: 216, name: 'Teddiursa' }, { national: 209, name: 'Snubbull' }];
  const text = randomizer.spoilerText('seed 1234ABCD options 15 generations 7\nstarter 133 370\ngift 239 49\nshadow 1 216 209\nrow 24577 216 209\n', species, [], 'xd');
  assert.equal(text, ['Pokémon XD: Gale of Darkness randomizer: seed 1234ABCD', '', 'Starter', '  Eevee is now Luvdisc', '',
    'Gifts and trades', '  Elekid is now Venomoth', '', 'Shadow Pokémon', '  Teddiursa is now Snubbull', ''].join('\n'));
  assert.match(randomizer.spoilerText('seed 1234ABCD\nstarter 197 1\n', [{ national: 197, name: 'Umbreon' }, { national: 1, name: 'Bulbasaur' }]), /^Pokémon Colosseum randomizer: seed 1234ABCD\n\nStarters\n/);
});

test('XD\'s Story party: each Pokémon whole, in Colosseum\'s numbers, Shadow Pokémon home until purified', t => {
  const party = [
    { species: 133, nickname: 'EEVEE', level: 24, friendship: 215, item: 0x8b, ability: 0, rnd: 0xa7c39f64, trainer: 0xd183a6d5, ivs: [14, 8, 3, 18, 6, 17],
      evs: [4, 0, 252, 0, 0, 252], moves: [[33, 3], [39, 0], [44, 1], [28, 0]] },
    { species: 216, nickname: 'TEDDIURSA', shadowId: 1 },             // still Shadow
    { species: 175, nickname: 'TOGEPI', shadowId: 81 },               // purified
    { species: 25, nickname: 'EGG', egg: true },
    { species: 160, nickname: 'FERALIGATR', ability: 1, moves: [[57, 0], [375 + 17, 2], [356, 0]] },   // a later generation's move, a Shadow move
    { species: 417, nickname: 'BUIZEL' }                              // a later generation's Pokémon
  ];
  const dir = saveFolder(t, card({ count: 1, plain: pack({ party, darkStatus: { 1: 2, 81: 4 } }) }));
  const read = story.readStoryParty(dir, 'xd');
  assert.equal(read.trainer, 'MICHAEL');
  assert.equal(read.leftOut, 1);
  assert.equal(read.packsLeftOut, 1);
  assert.deepEqual(read.members.map(member => member.nickname), ['EEVEE', 'TOGEPI', 'FERALIGATR']);
  assert.deepEqual(story.wireMember(read.members[0]), [133, 0xa7c39f64, 0xd183a6d5, 4, 0, 0x8b, 215, 33, 3, 39, 0, 44, 1, 28, 0,
    14, 8, 3, 18, 6, 17, 4, 0, 252, 0, 0, 252, '00450045005600450045']);
  assert.equal(read.members[0].level, 24);
  assert.deepEqual(read.members[2].moves, [[57, 0], [375, 2], [0, 0], [0, 0]]);
  assert.equal(read.members[2].ability, 1);
  assert.ok(story.validWireMember(story.wireMember(read.members[2]), 160));
  assert.equal(story.readStoryParty(saveFolder(t, null), 'xd'), null);
  assert.equal(story.readStoryParty(saveFolder(t, Buffer.alloc(CARD)), 'xd'), null);
  assert.throws(() => story.readStoryParty(saveFolder(t, card({ count: 1, plain: pack(), broken: true })), 'xd'), /damaged/);
});

// --- A real card the port wrote: XD_TEST_CARD=/path/to/PokemonXD.dat (a randomized new game) npm test ------------

const real = process.env.XD_TEST_CARD;
const withCard = { skip: real && fs.existsSync(real) ? false : 'set XD_TEST_CARD to a PokemonXD.dat of a randomized run to run this' };

test('a real randomized XD save: its run and its starter', withCard, t => {
  const dir = saveFolder(t, fs.readFileSync(real));
  const { run } = randomizer.readSave(dir, 'xd');
  assert.match(run.seed, /^[0-9A-F]{8}$/);
  assert.ok(run.options & 1, 'the starter is randomized');
  const party = story.readStoryParty(dir, 'xd');
  assert.ok(party.members.length >= 1);
  const first = party.members[0];
  assert.equal(first.level, 10);
  assert.equal(first.ball, 4);
  assert.notEqual(first.species, 133, 'not Eevee');
  assert.equal(first.trainer, xdSave.party(xdSave.newestPack(fs.readFileSync(real)).plain).trainerId);
});
