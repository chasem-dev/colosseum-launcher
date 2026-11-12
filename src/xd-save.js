'use strict';

// Pokémon XD's save, as the launcher reads it: the run the randomizer stamped it with, and the party. The card file
// (PokemonXD.dat, 43 blocks: gci-save.js OTHER_SAVES) has a banner and icon, then two slots the game writes in turn
// (memcard.cpp in the decomp). A slot opens with 1, 1, 1, its save count at +4, then the pack: 0x27FD0 bytes, all but
// its first 8 enciphered, each 4 halfwords taking the four keys from the pack's first 8 bytes away, the keys stepped
// after each 4 (_memcardKeyStep). Four sums of the plain halfwords, the stored sums zeroed, check it.
//
// The pack's sections are shuffled at each save (_memcardDuplicateSaveData_multi): a table at 0x3C holds each one's
// place, a halfword pair (low, high) past 0xA0, so a section moves from save to save.

const SLOTS = [0x6000, 0x2e000];
const SLOT_SIZE = 0x28000;
const PACK = 8;              // where a slot's pack starts
const PACK_SIZE = 0x27fd0;
const HALVES = PACK_SIZE / 2;
const SUM_HALVES = 0x4ffa;   // each of the four sums covers this many halfwords
const BODY = 0xa0;           // sections' places count from here

// The table of sections' places in the pack, by what each holds (memcard.cpp, its MEMCARD_SET_OFFSET calls).
const SECTION = { hero: 0x3c, pcBox: 0x40, darkPokemon: 0x54, reserve1: 0x60 };

// The trainer and the party (heroBios.cpp's Hero), and a Pokémon (pokemon.hpp's Pokemon, 0xC4 bytes).
const HERO_NAME = 0x00, HERO_ID = 0x2c, PARTY = 0x30, PARTY_SIZE = 6, POKEMON = 0xc4, NAME_LENGTH = 10;
// A Shadow Pokémon's record (darkPokemon.hpp, 0x48 bytes each): its status in the top 3 bits of its first byte, 4 once
// it is purified (darkPokemonBiosGetReliveFlag).
const DARK_POKEMON = 0x48, DARK_RECORDS = 128, PURIFIED = 4;

function step(k) {
  const v = [0x43, 0x29, 0x17, 0x13].map((add, j) => (k[j] + add) & 0xffff);
  return [
    (v[0] & 0xf) | ((v[1] << 4) & 0xf0) | ((v[2] << 8) & 0xf00) | ((v[3] << 12) & 0xf000),
    ((v[0] >> 4) & 0xf) | (v[1] & 0xf0) | ((v[2] << 4) & 0xf00) | ((v[3] << 8) & 0xf000),
    ((v[0] & 0xf00) >> 8) | ((v[1] & 0xf00) >> 4) | (v[2] & 0xf00) | ((v[3] << 4) & 0xf000),
    ((v[0] & 0xf000) >> 12) | ((v[1] & 0xf000) >> 8) | ((v[2] & 0xf000) >> 4) | (v[3] & 0xf000)
  ];
}

// A pack, deciphered: { plain, valid }. `plain` is the whole pack, its keys and sums as they were.
function decipher(pack) {
  if (pack.length < PACK_SIZE) return { plain: null, valid: false };
  const plain = Buffer.from(pack.subarray(0, PACK_SIZE));
  let keys = [0, 1, 2, 3].map(j => plain.readUInt16BE(j * 2));
  for (let i = 4; i < HALVES; i += 4) {
    for (let j = 0; j < 4; j++) plain.writeUInt16BE((plain.readUInt16BE((i + j) * 2) - keys[j]) & 0xffff, (i + j) * 2);
    keys = step(keys);
  }
  // the sums are stored last first, each as low half then high half, and count as zero in the sums
  const half = i => plain.readUInt16BE(i * 2);
  const stored = [10, 8, 6, 4].map(i => (half(i) | (half(i + 1) << 16)) >>> 0);
  const sums = [0, 0, 0, 0];
  for (let part = 0; part < 4; part++) {
    let sum = 0;
    for (let i = part * SUM_HALVES; i < (part + 1) * SUM_HALVES; i++) if (i < 4 || i >= 12) sum += half(i);
    sums[part] = sum >>> 0;
  }
  return { plain, valid: sums.every((sum, i) => sum === stored[i]) };
}

// The enciphering the game does, for tests: plain's sums written, then each halfword past the keys enciphered.
function encipher(plain) {
  const out = Buffer.from(plain);
  for (let i = 4; i < 12; i++) out.writeUInt16BE(0, i * 2);
  const half = i => out.readUInt16BE(i * 2);
  const sums = [0, 1, 2, 3].map(part => {
    let sum = 0;
    for (let i = part * SUM_HALVES; i < (part + 1) * SUM_HALVES; i++) sum += half(i);
    return sum >>> 0;
  });
  [10, 8, 6, 4].forEach((i, part) => { out.writeUInt16BE(sums[part] & 0xffff, i * 2); out.writeUInt16BE(sums[part] >>> 16, (i + 1) * 2); });
  let keys = [0, 1, 2, 3].map(j => out.readUInt16BE(j * 2));
  for (let i = 4; i < HALVES; i += 4) {
    for (let j = 0; j < 4; j++) out.writeUInt16BE((out.readUInt16BE((i + j) * 2) + keys[j]) & 0xffff, (i + j) * 2);
    keys = step(keys);
  }
  return out;
}

// The pack the game would load: the newest slot whose sums hold. { plain, count, slot }, or null when there's none.
function newestPack(data) {
  let best = null;
  SLOTS.forEach((start, slot) => {
    if (data.length < start + SLOT_SIZE) return;
    if (data[start] !== 1 || data[start + 1] !== 1 || data[start + 2] !== 1) return;
    const count = data.readInt32BE(start + 4);
    if (best && count <= best.count) return;
    const { plain, valid } = decipher(data.subarray(start + PACK, start + SLOT_SIZE));
    if (valid) best = { plain, count, slot };
  });
  return best;
}

// Where a section is in a deciphered pack.
function sectionAt(plain, section) {
  const at = SECTION[section];
  return BODY + ((plain.readUInt16BE(at + 2) << 16) | plain.readUInt16BE(at)) >>> 0;
}

function text(plain, at, length = NAME_LENGTH) {
  const units = [];
  for (let i = 0; i < length; i++) {
    const unit = plain.readUInt16BE(at + i * 2);
    if (!unit) break;
    units.push(unit);
  }
  return units;
}

// A Pokémon of the party, with what an online battle takes of it (story-party.js wireMember), as Colosseum's reader
// gives it. XD's IVs are a byte each.
function readPokemon(plain, at, darkPokemon) {
  const words = start => Array.from({ length: 6 }, (_, i) => plain.readUInt16BE(at + start + i * 2));
  const units = text(plain, at + 0x4e);
  const flags = plain[at + 0x1d], shadowId = plain.readUInt16BE(at + 0xba);
  const record = darkPokemon + shadowId * DARK_POKEMON;
  const purified = shadowId < DARK_RECORDS && record < plain.length && (plain[record] >> 5) === PURIFIED;
  return {
    species: plain.readUInt16BE(at),
    item: plain.readUInt16BE(at + 0x02),
    friendship: plain.readUInt16BE(at + 0x06),
    ball: plain[at + 0x0f],
    level: plain[at + 0x11],
    trainer: plain.readUInt32BE(at + 0x24),
    rnd: plain.readUInt32BE(at + 0x28),
    nickname: String.fromCharCode(...units),
    nicknameUnits: units,
    moves: Array.from({ length: 4 }, (_, i) => [plain.readUInt16BE(at + 0x80 + i * 4), plain[at + 0x80 + i * 4 + 3]]),
    evs: words(0x9c),
    ivs: Array.from({ length: 6 }, (_, i) => plain[at + 0xa8 + i]),
    ability: (flags & 0x40) ? 1 : 0,
    egg: Boolean(flags & 0x80),
    // a Shadow Pokémon keeps its Shadow id once purified; its record says whether it is (pokemonBiosGetDarkFlag)
    shadow: shadowId !== 0 && !purified
  };
}

// The save's trainer and party: { trainer, party: [Pokémon] }, from a deciphered pack.
function party(plain) {
  const hero = sectionAt(plain, 'hero'), darkPokemon = sectionAt(plain, 'darkPokemon');
  const members = [];
  for (let i = 0; i < PARTY_SIZE; i++) {
    const at = hero + PARTY + i * POKEMON;
    if (at + POKEMON > plain.length || !plain.readUInt16BE(at)) continue;
    members.push(readPokemon(plain, at, darkPokemon));
  }
  return { trainer: String.fromCharCode(...text(plain, hero + HERO_NAME)), trainerId: plain.readUInt32BE(hero + HERO_ID), party: members };
}

// Where the randomizer's stamp is: reserve 1's room (host/randomizer.c), in Colosseum's 16-byte format.
function stampAt(plain) { return sectionAt(plain, 'reserve1'); }

module.exports = { SLOTS, SLOT_SIZE, PACK, PACK_SIZE, SECTION, BODY, PARTY, POKEMON, DARK_POKEMON, step, decipher, encipher, newestPack,
  sectionAt, party, stampAt };
