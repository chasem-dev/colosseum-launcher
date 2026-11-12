'use strict';

// Rooms for both games (src/online.js crossBuildId): the Pokémon a Colosseum game and an XD game make alike.
//
// Both games make both teams from the same `member` lines and play the battle in lockstep, so each value has to mean
// the same to both. The game's host/crossplay.c holds one set of what both games' tables have the same (compared
// from both discs), and both games make every Pokémon by it: a value outside it is put in its place the same way in
// both, and a species outside it is left out of the party. This is the launcher's copy of that set, so that a player
// hears beforehand what their party would lose, rather than battling with something other than what they chose:
// - species 1 to 251 and 277 to 411 (not the empty rows between, the egg's, XD's Poké Spot rows, or a later
//   generation's);
// - moves 1 to 354 (not Colosseum's Shadow moves 355 to 357, XD's 355 to 374, or a later generation's);
// - the third generation's held items a Pokémon can hold (src/formats.js HOLDABLE), the same in both games;
// - the second ability only for a species that has one; balls 1 to 12; IVs up to 31; EVs up to 255 each and 510 in
//   all; friendship up to 255; PP Ups up to 3; nickname letters both games take (src/team-sets.js nicknameLetter).
// A member's numbers are src/story-party.js wireMember's.

const SPECIES = [[1, 251], [277, 411]];
const LAST_MOVE = 354;
// The Shadow moves of either game: Colosseum's 355 to 357 (Shadow Rush and two without names), XD's 355 to 374.
const SHADOW_MOVES = [355, 374];
// host/crossplay.c ITEMS: src/formats.js HOLDABLE, which both games' item tables have alike.
const ITEMS = [[1, 51], [63, 71], [73, 81], [83, 86], [93, 98], [103, 104], [106, 111], [133, 174], [179, 225], [254, 258]];
// host/crossplay.c SECOND_ABILITY: the species with a second ability, in both games' tables alike.
const SECOND_ABILITY = new Set([
  19, 20, 23, 24, 50, 51, 54, 55, 58, 59, 60, 61, 62, 63, 64, 65, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82, 83, 84,
  85, 88, 89, 95, 98, 99, 100, 101, 104, 105, 108, 111, 112, 113, 118, 119, 120, 121, 131, 138, 139, 140, 141, 142,
  143, 161, 162, 163, 164, 165, 166, 167, 168, 170, 171, 175, 176, 177, 178, 183, 184, 185, 186, 190, 193, 194, 195,
  199, 203, 206, 207, 208, 209, 210, 211, 214, 215, 218, 219, 222, 225, 226, 227, 228, 229, 242, 295, 296, 297, 298,
  299, 300, 313, 314, 320, 326, 327, 332, 333, 334, 335, 336, 337, 338, 350, 351, 352, 355, 363, 367, 368, 381, 382,
  383, 384, 386, 392, 393, 394]);
const BALLS = 12, IV_MOST = 31, EV_MOST = 255, EV_TOTAL = 510, PP_UPS = 3;

const within = (ranges, id) => Number.isInteger(id) && ranges.some(([first, last]) => id >= first && id <= last);
const isSpecies = id => within(SPECIES, id);
const isMove = id => Number.isInteger(id) && id >= 1 && id <= LAST_MOVE;
const isShadowMove = id => Number.isInteger(id) && id >= SHADOW_MOVES[0] && id <= SHADOW_MOVES[1];
const isItem = id => within(ITEMS, id);
const hasSecondAbility = species => SECOND_ABILITY.has(species);
// host/online.c nickname_letter, which both games share
const isLetter = code => (code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0x17f) || code === 0x2640 || code === 0x2642 || (code >= 0x3041 && code <= 0x30fe);

// Why one Pokémon can't battle as it is in a room for both games: [] when it can. `species` is its species, `wire` its
// member numbers (or null for a species alone), `shadow` whether it's a Shadow Pokémon. `names` as formats.problems's.
function memberProblems(species, wire, names = {}, shadow = false) {
  const name = names.species?.(species) || `Pokémon #${species}`;
  const itemName = id => names.item?.(id) || `item #${id}`, moveName = id => names.move?.(id) || `move #${id}`;
  if (shadow) return [`${name} is a Shadow Pokémon: it stays home until it's purified.`];
  if (!isSpecies(species)) return [`${name} isn't a Pokémon both games have.`];
  if (!wire) return [];
  const out = [];
  const [, , , ball, ability, item, friendship] = wire;
  const moves = [wire[7], wire[9], wire[11], wire[13]].filter(move => move);
  const seen = new Set();
  for (const move of moves) {
    if (isShadowMove(move)) out.push(`${name} knows a Shadow move (${moveName(move)}): rooms for both games have none.`);
    else if (!isMove(move)) out.push(`${name} knows ${moveName(move)}, which the other game doesn't have.`);
    else if (seen.has(move)) out.push(`${name} knows ${moveName(move)} twice.`);
    seen.add(move);
  }
  if (item && !isItem(item)) out.push(`${name} holds ${itemName(item)}, which the other game doesn't have as a held item.`);
  if (ability && !(ability === 1 && hasSecondAbility(species))) out.push(`${name} has a second ability its species doesn't have.`);
  if (!(ball >= 1 && ball <= BALLS)) out.push(`${name} is in a ball the other game doesn't have.`);
  const evs = wire.slice(21, 27), ivs = wire.slice(15, 21);
  if (evs.some(ev => !(ev >= 0 && ev <= EV_MOST)) || evs.reduce((sum, ev) => sum + ev, 0) > EV_TOTAL)
    out.push(`${name} has more EVs than a Pokémon can have (${EV_MOST} in a stat, ${EV_TOTAL} in all).`);
  if (ivs.some(iv => !(iv >= 0 && iv <= IV_MOST))) out.push(`${name} has an IV above ${IV_MOST}.`);
  if ([wire[8], wire[10], wire[12], wire[14]].some(ups => !(ups >= 0 && ups <= PP_UPS))) out.push(`${name} has more than ${PP_UPS} PP Ups on a move.`);
  if (!(friendship >= 0 && friendship <= 255)) out.push(`${name}'s friendship is more than 255.`);
  const hex = typeof wire[27] === 'string' && wire[27] !== '-' ? wire[27] : '';
  const units = (hex.match(/.{4}/g) || []).map(unit => parseInt(unit, 16));
  if (units.some(unit => !isLetter(unit))) out.push(`${name}'s nickname has a letter the games can't show.`);
  return out;
}

// Why a party (species, and members as wireMember's, or null) can't battle in a room for both games.
function problems(party, members = null, names = {}) {
  const out = [];
  (Array.isArray(party) ? party : []).forEach((species, slot) => {
    if (!species) return;
    out.push(...memberProblems(species, Array.isArray(members) ? members[slot] || null : null, names));
  });
  return [...new Set(out)];
}

// A Story party in a room for both games (src/story-party.js readStoryParty's members): those that can go as they
// are, and why each of the others stays home, as Shadow Pokémon do.
function storyMembers(members, wireMember, names = {}) {
  const kept = [], leftOut = [];
  for (const member of members) {
    const why = memberProblems(member.species, wireMember(member), names, Boolean(member.shadow));
    if (why.length) leftOut.push({ member, why });
    else kept.push(member);
  }
  return { kept, leftOut };
}

module.exports = { SPECIES, LAST_MOVE, SHADOW_MOVES, ITEMS, SECOND_ABILITY, isSpecies, isMove, isShadowMove, isItem, hasSecondAbility,
  isLetter, memberProblems, problems, storyMembers };
