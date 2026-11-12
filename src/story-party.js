'use strict';

// The Story party: the Pokémon in the player's own save, to battle online with. Each comes along as it is, with its
// moves, nature, IVs and EVs, ability, held item, nickname and Poké Ball, and the game makes it at the room's level
// (host/online.c, its `member` lines). Shadow Pokémon stay home until they're purified: their Shadow moves and heart
// gauge belong to the save they came from.

const fs = require('node:fs');
const path = require('node:path');
const { newestPlain } = require('./gci-save');
const { isPackSpecies } = require('./pokemon-packs');
const xdSave = require('./xd-save');

const SAVE = 'pokemon_colosseum.dat';
const XD_SAVE = 'PokemonXD.dat';
// XD numbers the moves after Gen 3's 354 differently: its own Shadow moves first (355 to 374), then later generations'
// 17 past Colosseum's (host/mechanics.c colo_xd_move). A member goes in Colosseum's numbers, which both games read.
const XD_SHADOW_MOVES = [355, 374], XD_MOVE_SHIFT = 17;
const PARTY = 0xa8;          // where an unscrambled slot keeps the party (src/gci-save.js)
const PARTY_SIZE = 6;
const POKEMON = 0x138;
const NICKNAME_LENGTH = 10;

// Where a Pokémon keeps each of these (the decomp's PokemonBios, include/game/pokemon_data.h).
const AT = { species: 0x00, rnd: 0x04, ball: 0x0f, trainer: 0x14, nickname: 0x2e, level: 0x60, moves: 0x78, item: 0x88,
  evs: 0x98, ivs: 0xa4, friendship: 0xb0, egg: 0xcb, ability: 0xcc, shadow: 0xd8, heart: 0xdc };

// Its nickname as UTF-16 code units, which go to the game unchanged.
function nicknameUnits(plain, at) {
  const units = [];
  for (let i = 0; i < NICKNAME_LENGTH; i++) {
    const unit = plain.readUInt16BE(at + AT.nickname + i * 2);
    if (!unit) break;
    units.push(unit);
  }
  return units;
}

function readMember(plain, at) {
  const stats = start => Array.from({ length: 6 }, (_, i) => plain.readUInt16BE(at + start + i * 2));
  const units = nicknameUnits(plain, at);
  return {
    species: plain.readUInt16BE(at + AT.species),
    rnd: plain.readUInt32BE(at + AT.rnd),
    trainer: plain.readUInt32BE(at + AT.trainer),
    ball: plain[at + AT.ball],
    ability: plain[at + AT.ability],
    item: plain.readUInt16BE(at + AT.item),
    friendship: plain.readUInt16BE(at + AT.friendship),
    moves: Array.from({ length: 4 }, (_, i) => [plain.readUInt16BE(at + AT.moves + i * 4), plain[at + AT.moves + i * 4 + 3]]),
    ivs: stats(AT.ivs),
    evs: stats(AT.evs),
    nickname: String.fromCharCode(...units),
    nicknameUnits: units,
    level: plain[at + AT.level],
    // A Shadow Pokémon has its Shadow data's number, and a heart gauge that isn't spent (pokemonBiosGetDarkFlag).
    shadow: plain.readUInt16BE(at + AT.shadow) !== 0 && plain.readInt32BE(at + AT.heart) >= 0,
    egg: plain[at + AT.egg] !== 0
  };
}

// Personality and trainer ID together: the game's own test for a shiny (pokemonCheckRare).
const isShiny = member => ((member.trainer >>> 16) ^ (member.trainer & 0xffff) ^ (member.rnd >>> 16) ^ (member.rnd & 0xffff)) < 8;

// A move of XD's save in Colosseum's numbers; a Shadow move (which a purified Pokémon never has) is none.
function xdMove(move) {
  if (move >= XD_SHADOW_MOVES[0] && move <= XD_SHADOW_MOVES[1]) return 0;
  return move > XD_SHADOW_MOVES[1] ? move - XD_MOVE_SHIFT : move;
}

// The party in the save of Pokémon XD the game would load (xd-save.js), as readStoryParty gives Colosseum's.
function readXdParty(saveDir) {
  const file = path.join(saveDir, XD_SAVE);
  let data;
  try { data = fs.readFileSync(file); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const pack = xdSave.newestPack(data);
  if (!pack) {
    if (data.subarray(0x6000).some(Boolean)) throw new Error('This save is damaged: neither of its two copies can be read. Restore a backup from the Saves tab.');
    return null;
  }
  const { trainer, party } = xdSave.party(pack.plain);
  const members = [];
  let leftOut = 0, packsLeftOut = 0;
  for (const member of party) {
    if (member.egg) continue;
    if (member.shadow) { leftOut++; continue; }
    if (isPackSpecies(member.species)) { packsLeftOut++; continue; }
    const moves = member.moves.map(([move, ups]) => [xdMove(move), ups]).map(([move, ups]) => (move ? [move, ups] : [0, 0]));
    members.push({ ...member, moves, shiny: isShiny(member) });
  }
  return { trainer, members, leftOut, packsLeftOut, modified: fs.statSync(file).mtimeMs };
}

// The party in the save the game would load, or null when there's no save yet. members are those that can battle;
// leftOut counts the Shadow Pokémon that stay behind, packsLeftOut the Pokémon of Pokémon packs. gameId: whose save
// (games.js), Colosseum's or XD's.
function readStoryParty(saveDir, gameId = 'colosseum') {
  if (gameId === 'xd') return readXdParty(saveDir);
  const file = path.join(saveDir, SAVE);
  let data;
  try { data = fs.readFileSync(file); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  let plain;
  try { ({ plain } = newestPlain(data, 'Restore a backup from the Saves tab.')); }
  catch (error) {
    if (error.code === 'NO_PROGRESS') return null;
    throw error;
  }
  const trainer = [];
  for (let i = 0; i < NICKNAME_LENGTH; i++) {
    const unit = plain.readUInt16BE(0x78 + i * 2);
    if (!unit) break;
    trainer.push(unit);
  }
  const members = [];
  let leftOut = 0, packsLeftOut = 0;
  for (let i = 0; i < PARTY_SIZE; i++) {
    const at = PARTY + i * POKEMON;
    if (!plain.readUInt16BE(at)) continue;
    const member = readMember(plain, at);
    if (member.egg) continue;
    if (member.shadow) { leftOut++; continue; }
    // A Pokémon of a Pokémon pack (src/pokemon-packs.js): the other player's game wouldn't have it.
    if (isPackSpecies(member.species)) { packsLeftOut++; continue; }
    members.push({ ...member, shiny: isShiny(member) });
  }
  return { trainer: String.fromCharCode(...trainer), members, leftOut, packsLeftOut, modified: fs.statSync(file).mtimeMs };
}

// What goes to the room and on to the other player's game, as numbers in the game's order, and the nickname in hex.
function wireMember(member) {
  const hex = member.nicknameUnits.map(unit => unit.toString(16).padStart(4, '0')).join('') || '-';
  return [member.species, member.rnd, member.trainer, member.ball, member.ability, member.item, member.friendship,
    ...member.moves.flat(), ...member.ivs, ...member.evs, hex];
}

const WIRE_NUMBERS = 27;
const u32 = value => Number.isInteger(value) && value >= 0 && value <= 0xffffffff;

// A member as it came from the room: the shape only. The game checks every value again when it makes the Pokémon.
function validWireMember(member, species) {
  return Array.isArray(member) && member.length === WIRE_NUMBERS + 1 && member[0] === species
    && member.slice(0, WIRE_NUMBERS).every(u32) && typeof member[WIRE_NUMBERS] === 'string'
    && /^(-|([0-9a-f]{4}){1,10})$/.test(member[WIRE_NUMBERS]);
}

// The game's line for one member of side's party.
function memberLine(side, slot, member) {
  return `member ${side} ${slot} ${member.join(' ')}`;
}

module.exports = { PARTY_SIZE, SAVE, XD_SAVE, readStoryParty, readMember, xdMove, isShiny, wireMember, validWireMember, memberLine, WIRE_NUMBERS };
