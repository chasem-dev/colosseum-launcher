'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const story = require('../src/story-party');

const SLOT_START = 0x6000, SLOT_SIZE = 0x1e000, HASHED = 0x1dfd8, HASH = 0x1dfec, SIZE = 48 * 0x2000;
const sha1 = bytes => crypto.createHash('sha1').update(bytes).digest();

// As test/gci-save.test.js: the game's scrambling, then the header sum.
function scramble(slot) {
  const hash = sha1(slot.subarray(0, HASHED));
  let key = Buffer.from(hash.map(byte => ~byte & 0xff));
  for (let offset = 0x18; offset < HASHED; offset += 20) {
    for (let i = 0; i < 20; i++) slot[offset + i] ^= key[i];
    key = sha1(slot.subarray(offset, offset + 20));
  }
  hash.copy(slot, HASH);
  let sum = 0;
  for (let word = 0; word < 8; word++) sum = (sum + slot.readUInt32BE(word * 4)) >>> 0;
  slot.writeUInt32BE((0x100000000 - sum) >>> 0, 0x0c);
}

const utf16 = (bytes, offset, value) => Buffer.from(value, 'utf16le').swap16().copy(bytes, offset);

// The Umbreon a new game starts with, as the port saved it.
const UMBREON = { species: 197, rnd: 0x372407cb, trainer: 0xae3b618b, ball: 4, level: 26, nickname: 'UMBREON', friendship: 220,
  moves: [[44, 0], [290, 0], [269, 0], [289, 0]], ivs: [23, 17, 30, 19, 2, 17], evs: [0, 0, 0, 0, 0, 0] };

function writePokemon(slot, index, pokemon) {
  const at = 0xa8 + index * 0x138;
  slot.writeUInt16BE(pokemon.species, at);
  slot.writeUInt32BE(pokemon.rnd ?? 1, at + 0x04);
  slot[at + 0x0f] = pokemon.ball ?? 4;
  slot.writeUInt32BE(pokemon.trainer ?? 2, at + 0x14);
  utf16(slot, at + 0x2e, pokemon.nickname ?? 'MON');
  slot[at + 0x60] = pokemon.level ?? 30;
  (pokemon.moves || [[33, 0]]).forEach(([id, ups], i) => { slot.writeUInt16BE(id, at + 0x78 + i * 4); slot[at + 0x7b + i * 4] = ups; });
  slot.writeUInt16BE(pokemon.item ?? 0, at + 0x88);
  (pokemon.evs || []).forEach((value, i) => slot.writeUInt16BE(value, at + 0x98 + i * 2));
  (pokemon.ivs || []).forEach((value, i) => slot.writeUInt16BE(value, at + 0xa4 + i * 2));
  slot.writeUInt16BE(pokemon.friendship ?? 70, at + 0xb0);
  slot[at + 0xcb] = pokemon.egg ? 1 : 0;
  slot[at + 0xcc] = pokemon.ability ?? 0;
  slot.writeUInt16BE(pokemon.shadowId ?? 0, at + 0xd8);
  slot.writeInt32BE(pokemon.heart ?? -100, at + 0xdc);
}

function saveFolder(party, trainer = 'WES') {
  const data = Buffer.alloc(SIZE);
  for (let index = 0; index < 3; index++) {
    const slot = data.subarray(SLOT_START + index * SLOT_SIZE, SLOT_START + (index + 1) * SLOT_SIZE);
    slot[0] = 1; slot[1] = 1;
    slot.writeInt32BE(index + 1, 4);
    utf16(slot, 0x78, trainer);
    party.forEach((pokemon, i) => writePokemon(slot, i, pokemon));
    scramble(slot);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'colo-story-'));
  fs.writeFileSync(path.join(dir, 'pokemon_colosseum.dat'), data);
  return dir;
}

test('the Story party is the save\'s party, each Pokemon whole', t => {
  const dir = saveFolder([UMBREON, { species: 196, nickname: 'Sunny', item: 0x44, ability: 1, evs: [252, 0, 0, 252, 6, 0], moves: [[93, 3], [0, 0], [0, 0], [0, 0]] }]);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const party = story.readStoryParty(dir);
  assert.equal(party.trainer, 'WES');
  assert.equal(party.leftOut, 0);
  assert.equal(party.members.length, 2);
  const [umbreon, espeon] = party.members;
  assert.deepEqual({ species: umbreon.species, rnd: umbreon.rnd, trainer: umbreon.trainer, ball: umbreon.ball, level: umbreon.level,
    nickname: umbreon.nickname, friendship: umbreon.friendship, moves: umbreon.moves, ivs: umbreon.ivs, evs: umbreon.evs },
  { ...UMBREON });
  assert.deepEqual(story.wireMember(umbreon),
    [197, 925108171, 2923127179, 4, 0, 0, 220, 44, 0, 290, 0, 269, 0, 289, 0, 23, 17, 30, 19, 2, 17, 0, 0, 0, 0, 0, 0, '0055004d004200520045004f004e']);
  assert.equal(espeon.nickname, 'Sunny');
  assert.equal(espeon.item, 0x44);
  assert.equal(espeon.ability, 1);
  assert.deepEqual(espeon.moves[0], [93, 3]);
  assert.deepEqual(espeon.evs, [252, 0, 0, 252, 6, 0]);
  assert.ok(story.validWireMember(story.wireMember(espeon), 196));
  assert.equal(story.memberLine(1, 0, story.wireMember(umbreon)).split(' ').length, 3 + story.WIRE_NUMBERS + 1);
});

test('Shadow Pokemon stay home until purified, and eggs never come', t => {
  const dir = saveFolder([
    { species: 155, shadowId: 1, heart: 1500, nickname: 'MAKUHITA' },   // still a Shadow Pokemon
    { species: 156, shadowId: 2, heart: -1, nickname: 'PURIFIED' },     // purified: its gauge is spent
    { species: 157, egg: true },
    UMBREON
  ]);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const party = story.readStoryParty(dir);
  assert.equal(party.leftOut, 1);
  assert.deepEqual(party.members.map(member => member.species), [156, 197]);
});

test('Pokemon of Pokemon packs stay home: the other player\'s game wouldn\'t have them', t => {
  const dir = saveFolder([{ species: 253, nickname: 'MOONFANG' }, UMBREON]);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const party = story.readStoryParty(dir);
  assert.deepEqual([party.leftOut, party.packsLeftOut], [0, 1]);
  assert.deepEqual(party.members.map(member => member.species), [197]);
});

test('no save, or one with no progress, is no Story party yet', t => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'colo-story-'));
  t.after(() => fs.rmSync(empty, { recursive: true, force: true }));
  assert.equal(story.readStoryParty(empty), null);
  const blank = Buffer.alloc(SIZE);
  for (let index = 0; index < 3; index++) {
    const slot = blank.subarray(SLOT_START + index * SLOT_SIZE, SLOT_START + (index + 1) * SLOT_SIZE);
    slot[0] = 1; slot[1] = 1;
    slot.writeUInt32BE((0x100000000 - 0x01010000) >>> 0, 0x0c);
  }
  fs.writeFileSync(path.join(empty, 'pokemon_colosseum.dat'), blank);
  assert.equal(story.readStoryParty(empty), null);
});

test('a shiny is the game\'s test of personality against the trainer ID', () => {
  assert.equal(story.isShiny({ rnd: 0x12345678, trainer: 0x12345678 }), true);
  assert.equal(story.isShiny({ rnd: 0x372407cb, trainer: 0xae3b618b }), false);
});

test('a member from the room is checked for its shape before it reaches the game', () => {
  const good = [197, 1, 2, 4, 0, 0, 220, 44, 0, 0, 0, 0, 0, 0, 0, 31, 31, 31, 31, 31, 31, 0, 0, 0, 0, 0, 0, '-'];
  assert.ok(story.validWireMember(good, 197));
  assert.equal(story.validWireMember(good, 196), false);                       // not the party's species
  assert.equal(story.validWireMember([...good.slice(0, 27), '00zz'], 197), false);
  assert.equal(story.validWireMember([...good.slice(0, 26), -1, '-'], 197), false);
  assert.equal(story.validWireMember(good.slice(1), 197), false);
});

test('an XD save\'s items go in Colosseum\'s numbers', () => {
  const { xdItem, xdMove } = require('../src/story-party');
  assert.equal(xdItem(200), 200);              // Leftovers: the same in both
  assert.equal(xdItem(0x252), 0x224);          // Diamond and Pearl's first, past XD's key items
  assert.equal(xdItem(0x281), 0x253);          // Life Orb (593 in Colosseum's numbers)
  assert.equal(xdItem(0x230), 0);              // one of XD's key items: none
  assert.equal(xdMove(360), 0);                // and an XD Shadow move
  assert.equal(xdMove(375 + 89), 358 + 89);    // a later generation's move
});
