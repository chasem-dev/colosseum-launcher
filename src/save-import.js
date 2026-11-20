'use strict';

// Import from a GBA or DS save: the Pokémon page's Import button opens a Ruby, Sapphire, Emerald, FireRed or LeafGreen
// save (src/gen3-save.js) or a Diamond, Pearl or Platinum one (src/ds-save.js), shows its party and PC boxes, and copies
// the Pokémon picked into the chosen game's save as Online Trades put one in (src/trade-convert.js write, then the
// save's tradeGive: the card with the game closed, the running game otherwise). The file is only read: a copy comes
// over, and the Pokémon stays in the GBA or DS game too. One already in the save (the same species, personality and
// trainer) isn't copied twice.
//
// A Pokémon is read into trade-convert.js's form (Colosseum's numbering) field by field:
// - from a GBA save, as Colosseum's own GBA trade does (pkmn-colosseum src/game/gba/gba_misc.c, GBA to GameCube): the
//   game and language codes, names through the game's character table (src/gba-text.js), the leftover bits it carries;
// - from a DS save, as Platinum's Pal Park takes one from a GBA game, the other way round (pokeplatinum
//   src/main_menu/gba_pokemon.c): the Hoenn Pokémon's numbers, items by their GBA numbers, contest ribbons by rank. A DS
//   game has no number Colosseum or XD knows, so one born there says "a Generation 4 game" (12) and no place met.
// Its level comes from its experience and its stats are worked out afresh (a boxed Pokémon keeps neither), with full
// HP and no status, as after a Pokémon Center. Bringing a DS save's Pokémon needs the game's Generation 4 Pokémon
// setting on (main.js). What the game can't have is said, per Pokémon: an item it can't hold comes off (the copy in
// the GBA or DS save keeps it); an egg, a damaged Pokémon, a move or a form the game hasn't got keep it from coming.
const fs = require('node:fs');
const path = require('node:path');
const gen3 = require('./gen3-save');
const ds = require('./ds-save');
const gbaText = require('./gba-text');
const convert = require('./trade-convert');
const gen4 = require('./generations/gen4.json');
const transfer = require('./generations/gen4-transfer.json');

const KINDS = { gba: 'GBA', ds: 'DS' };
const FIRST_HOENN = 277, LAST_HOENN = 411, EGG = 412, LATER_OFFSET = 26;
const NATIONAL_OF_HOENN = new Map(Object.entries(transfer.species).map(([national, gba]) => [gba, Number(national)]));
const HOENN_OF_NATIONAL = new Map(Object.entries(transfer.species).map(([national, gba]) => [Number(national), gba]));
// Generation 4 Pokémon whose other forms have their own stats or types, which the game doesn't have (only the first)
const FORM_SPECIES = new Map([[386, 'Deoxys'], [413, 'Wormadam'], [479, 'Rotom'], [487, 'Giratina'], [492, 'Shaymin']]);
const DS_GAME = 12;   // an attest game the games don't know: a DS game (they show it as from a trade)

// ---- numbers ----
// a species in Colosseum's numbering from the National Pokédex (a DS save's), and back
function speciesFromNational(n) {
  if (n >= 1 && n <= 251) return n;
  if (HOENN_OF_NATIONAL.has(n)) return HOENN_OF_NATIONAL.get(n);
  if (n >= 387 && n <= 493) return n + LATER_OFFSET;
  return 0;
}
function nationalOf(species) {
  if (species >= 1 && species <= 251) return species;
  if (species >= FIRST_HOENN && species <= LAST_HOENN) return NATIONAL_OF_HOENN.get(species) || 0;
  if (species >= 387 + LATER_OFFSET && species <= 493 + LATER_OFFSET) return species - LATER_OFFSET;
  return 0;
}
const moveFromNational = n => (n >= 355 ? n + 3 : n);
const moveNational = id => (id >= 358 ? id - 3 : id);

// The GBA game codes as the games' attest keeps them (gba_misc.c), by the GBA's own (Sapphire 1 ... Colosseum/XD 15)
const VERSION = { 1: 8, 2: 9, 3: 10, 4: 1, 5: 2, 15: 11 };
// region and language by the GBA and DS language (Japanese 1, English 2, French 3, Italian 4, German 5, Spanish 7, Korean 8)
const LANGUAGE = { 1: [1, 1], 2: [2, 2], 3: [3, 4], 4: [3, 5], 5: [3, 3], 7: [3, 6], 8: [2, 8] };

// ---- level and stats, as the games work them out ----
function expAt(rate, n) {
  if (n <= 1) return 0;
  const cube = n ** 3;
  switch (rate) {
    case 'fast': return Math.floor(4 * cube / 5);
    case 'slow': return Math.floor(5 * cube / 4);
    case 'mediumSlow': return Math.floor(6 * cube / 5) - 15 * n * n + 100 * n - 140;
    case 'erratic':
      if (n <= 50) return Math.floor(cube * (100 - n) / 50);
      if (n <= 68) return Math.floor(cube * (150 - n) / 100);
      if (n <= 98) return Math.floor(cube * Math.floor((1911 - 10 * n) / 3) / 500);
      return Math.floor(cube * (160 - n) / 100);
    case 'fluctuating':
      if (n <= 15) return Math.floor(cube * (Math.floor((n + 1) / 3) + 24) / 50);
      if (n <= 36) return Math.floor(cube * (n + 14) / 50);
      return Math.floor(cube * (Math.floor(n / 2) + 32) / 50);
    default: return cube;
  }
}
function levelOf(rate, exp) {
  let level = 1;
  while (level < 100 && expAt(rate, level + 1) <= exp) level++;
  return level;
}
// stats in the games' order (HP, Attack, Defense, Sp. Atk, Sp. Def, Speed); ivs and evs in that order too
function statsOf(national, level, ivs, evs, nature) {
  const base = gen4.species[national].stats;
  const b = [base.hp, base.attack, base.defense, base.spAttack, base.spDefense, base.speed];
  const core = i => Math.floor((2 * b[i] + ivs[i] + Math.floor(evs[i] / 4)) * level / 100);
  // a nature's raised and lowered stats by Attack, Defense, Speed, Sp. Atk, Sp. Def
  const up = Math.floor(nature / 5), down = nature % 5, byNature = [1, 2, 5, 3, 4];
  return b.map((_, i) => {
    if (i === 0) return national === 292 ? 1 : core(0) + level + 10;   // (Shedinja: always 1)
    const k = byNature.indexOf(i), value = core(i) + 5;
    if (up === down) return value;
    return k === up ? Math.floor(value * 11 / 10) : k === down ? Math.floor(value * 9 / 10) : value;
  });
}
function maxPp(id, ups) {
  const move = gen4.moves[moveNational(id)];
  return move ? Math.floor(move.pp * (5 + ups) / 5) : 0;
}

// The fields every Pokémon read here works out the same way from its species, experience, IVs, EVs and moves.
function finish(p, national) {
  const entry = gen4.species[national];
  if (entry) {
    p.level = levelOf(entry.growthRate, p.exp);
    p.stats = statsOf(national, p.level, p.ivs, p.evs, p.rnd % 25);
    p.hp = p.stats[0];
    for (const move of p.moves) move.pp = Math.min(move.pp, maxPp(move.id, move.ppUps));
  }
  p.nicknameText = String.fromCharCode(...p.nickname);
  return p;
}

// ---- a GBA save's Pokémon (80 bytes in a box, 100 in the party) ----
function fromGba(raw) {
  const personality = raw.readUInt32LE(0), otId = raw.readUInt32LE(4), key = (personality ^ otId) >>> 0;
  const order = gen3.ORDERS[personality % 24];
  const plain = Buffer.alloc(48);
  for (let i = 0; i < 48; i += 4) plain.writeUInt32LE((raw.readUInt32LE(0x20 + i) ^ key) >>> 0, i);
  const sub = letter => plain.subarray(order.indexOf(letter) * 12, order.indexOf(letter) * 12 + 12);
  const g = sub('G'), a = sub('A'), e = sub('E'), m = sub('M');
  let sum = 0;
  for (let i = 0; i < 48; i += 2) sum = (sum + plain.readUInt16LE(i)) & 0xFFFF;
  const flags = raw[0x13], language = raw[0x12];
  const origins = m.readUInt16LE(2), ivWord = m.readUInt32LE(4), ribbons = m.readUInt32LE(8);
  const [region, lang] = LANGUAGE[language] || [0, 0];
  const iv = shift => (ivWord >>> shift) & 31, rank = shift => (ribbons >>> shift) & 7;
  const species = g.readUInt16LE(0), ppBonuses = g[8];
  const p = {
    game: 'gba', species, rnd: personality, attest: [VERSION[(origins >> 7) & 15] || 0, 3, region, lang],
    metLocation: m[1], metLevel: origins & 0x7F, ball: (origins >> 11) & 15, otGender: origins >> 15, otId,
    otName: gbaText.fromGba(raw.subarray(0x14, 0x1B), 7, lang), nickname: gbaText.fromGba(raw.subarray(8, 18), 10, lang),
    exp: g.readUInt32LE(4), level: raw.length >= 100 ? raw[0x54] : 0,
    conditionAmari: raw.length >= 100 ? (raw.readUInt32LE(0x50) & 0xFFFFF000) >>> 0 : 0,
    moves: [0, 1, 2, 3].map(i => ({ id: a.readUInt16LE(2 * i), pp: a[8 + i], ppUps: (ppBonuses >> (2 * i)) & 3, shadow: false })).filter(move => move.id),
    item: g.readUInt16LE(2), hp: 0, stats: [0, 0, 0, 0, 0, 0],
    evs: [e[0], e[1], e[2], e[4], e[5], e[3]], ivs: [iv(0), iv(5), iv(10), iv(20), iv(25), iv(15)],
    friendship: g[9], contest: [e[6], e[7], e[8], e[9], e[10]], ranks: [rank(0), rank(3), rank(6), rank(9), rank(12)], sheen: e[11],
    ribbons: Array.from({ length: 12 }, (_, i) => Boolean(ribbons & (1 << (15 + i)))), ribbonSpare: (ribbons >>> 27) & 15,
    pokerus: m[0], egg: Boolean(ivWord & (1 << 30)) || Boolean(flags & 4), abilitySlot: ivWord >>> 31,
    invalid: Boolean(flags & 1) || sum !== raw.readUInt16LE(0x1C), flagAmari: flags >> 3, markings: raw[0x1B],
    para1Amari: g.readUInt16LE(10), amari: raw.readUInt16LE(0x1E), event: Boolean(ribbons >>> 31), shadowId: 0, shadowNow: false
  };
  p.nicknameOrg = p.nickname;
  if (species === EGG) p.egg = true;
  if (!(species >= 1 && species <= 251) && !(species >= FIRST_HOENN && species <= LAST_HOENN) && species !== EGG) p.invalid = true;
  return { pokemon: finish(p, nationalOf(species)), form: 0 };
}

// ---- a DS save's Pokémon (136 bytes deciphered, 236 in the party) ----
// a DS name's codes as the games' characters: what neither game's font has becomes "?"
function dsText(codes, count) {
  return codes.slice(0, count).map(code => {
    if (code === 0) return 0x20;   // (a GBA space Pal Park kept as 0: the DS shows it blank)
    const char = transfer.text[code];
    if (!char) return 0x3F;
    const unit = char.charCodeAt(0);
    if (/\s/u.test(char)) return 0x20;   // (the DS's spaces, wide and narrow)
    return gbaText.KNOWN.has(unit) || (unit >= 0x20 && unit < 0x7F) ? unit : 0x3F;
  });
}
function abilitySlot(national, ability) {
  const names = gen4.species[national]?.abilities || [], name = gen4.abilities[ability]?.name;
  return Math.max(0, names.indexOf(name));
}
function fromDs({ data, whole }) {
  const b = data, national = b.readUInt16LE(0x08), species = speciesFromNational(national);
  const ivWord = b.readUInt32LE(0x38), hoenn = b.readUInt32LE(0x3C), language = b[0x17], hometown = b[0x5F];
  const [region, lang] = LANGUAGE[language] || [2, 2];
  const iv = shift => (ivWord >>> shift) & 31;
  const rank = shift => [0, 1, 2, 3].filter(i => hoenn & (1 << (shift + i))).length;
  const heldGen4 = b.readUInt16LE(0x0A), held = heldGen4 ? transfer.items[heldGen4] : 0;
  const nickname = dsText(ds.codes(b.subarray(0x48, 0x5E), 11), 10);
  const p = {
    game: 'ds', species, rnd: b.readUInt32LE(0), attest: [VERSION[hometown] || DS_GAME, 3, region, lang],
    metLocation: 0, metLevel: b[0x84] & 0x7F, ball: b[0x83], otGender: b[0x84] >> 7, otId: b.readUInt32LE(0x0C),
    otName: dsText(ds.codes(b.subarray(0x68, 0x78), 8), 7), nickname, nicknameOrg: nickname,
    exp: b.readUInt32LE(0x10), level: 0, conditionAmari: 0,
    moves: [0, 1, 2, 3].map(i => ({ id: moveFromNational(b.readUInt16LE(0x28 + 2 * i)), pp: b[0x30 + i], ppUps: Math.min(b[0x34 + i], 3), shadow: false })).filter(move => move.id),
    item: held || 0, hp: 0, stats: [0, 0, 0, 0, 0, 0],
    evs: [b[0x18], b[0x19], b[0x1A], b[0x1C], b[0x1D], b[0x1B]], ivs: [iv(0), iv(5), iv(10), iv(20), iv(25), iv(15)],
    friendship: b[0x14], contest: [b[0x1E], b[0x1F], b[0x20], b[0x21], b[0x22]], ranks: [rank(0), rank(4), rank(8), rank(12), rank(16)], sheen: b[0x23],
    ribbons: Array.from({ length: 12 }, (_, i) => Boolean(hoenn & (1 << (20 + i)))), ribbonSpare: 0,
    pokerus: b[0x82], egg: Boolean(ivWord & (1 << 30)), abilitySlot: abilitySlot(national, b[0x15]),
    invalid: !whole || !species, flagAmari: 0, markings: b[0x16] & 0x0F, para1Amari: 0, amari: 0,
    event: Boolean(b[0x40] & 1), shadowId: 0, shadowNow: false
  };
  return { pokemon: finish(p, national), form: b[0x40] >> 3, heldLost: Boolean(heldGen4 && !held) };
}

// ---- the file ----
// What a file is: { kind: 'gba'|'ds', gameName, trainer, trainerId, party: [entry], boxes: [{ name, pokemon: [entry|null] }] },
// each entry { pokemon (trade-convert form), form, heldLost }; throws with a reason for players.
function readFile(file) {
  let buffer;
  try { buffer = fs.readFileSync(file); } catch (error) { throw new Error(`Can't read ${path.basename(file)}: ${error.code || error.message}.`); }
  return parse(buffer, path.basename(file));
}
function parse(buffer, name = 'That file') {
  const safe = read => { try { return read(); } catch (_) { return { pokemon: { invalid: true, moves: [], species: 0, nickname: [], nicknameText: '' }, damaged: true }; } };
  if (buffer.length >= gen3.SAVE_SIZE && buffer.length <= gen3.SAVE_SIZE + 0x100) {
    const save = gen3.parse(buffer), { sb1, storage, game } = gen3.blocks(buffer);
    const count = Math.min(6, sb1[game.partyCount]);
    const party = [];
    for (let i = 0; i < count; i++) {
      const raw = sb1.subarray(game.party + i * 100, game.party + (i + 1) * 100);
      if (raw.readUInt32LE(0) || raw.readUInt32LE(4)) party.push(safe(() => fromGba(raw)));
    }
    return { kind: 'gba', game: save.game, gameName: save.gameName, trainer: save.trainer, trainerId: save.trainerId, party,
      boxes: gen3.boxes(storage).map(box => ({ name: box.name, pokemon: box.pokemon.map(raw => raw && safe(() => fromGba(raw))) })) };
  }
  if (buffer.length >= ds.SAVE_SIZE && buffer.length <= ds.SAVE_SIZE + 0x1000) {
    const save = ds.parse(buffer);
    const text = codes => codes.map(code => transfer.text[code] || '?').join('').trim();
    return { kind: 'ds', game: save.game, gameName: save.gameName, trainer: text(save.trainer), trainerId: save.trainerId,
      party: save.party.map(mon => safe(() => fromDs(mon))),
      boxes: save.boxes.map(box => ({ name: text(box.name), pokemon: box.pokemon.map(mon => mon && safe(() => fromDs(mon))) })) };
  }
  throw new Error(`${name} isn't a GBA save (Ruby, Sapphire, Emerald, FireRed, LeafGreen) or a DS save (Diamond, Pearl, Platinum): it's the wrong size.`);
}

// ---- what the game can take ----
const PROBLEM = {
  egg: 'Eggs can\'t come over: hatch it first.',
  invalid: 'This Pokémon\'s data is damaged.',
  'later-species': 'It\'s a Generation 4 Pokémon: turn on Generation 4 Pokémon to bring it.',
  'later-move': 'It knows a Generation 4 move: turn on Generation 4 Pokémon to bring it.',
  move: 'It knows a move the game doesn\'t have.',
  'no-moves': 'It knows no moves.',
  pack: 'This Pokémon\'s data is damaged.'
};
// An entry as `receiver.game` would take it (receiver: main.js tradeReceiver): { bytes (null if it can't come), problems,
// notes, pokemon } with each problem and note a sentence for players.
function judge(entry, receiver) {
  if (entry.damaged) return { bytes: null, problems: [PROBLEM.invalid], notes: [], pokemon: entry.pokemon };
  const p = { ...entry.pokemon, moves: entry.pokemon.moves.map(move => ({ ...move })) };
  const problems = [], notes = [];
  if (entry.form && FORM_SPECIES.has(nationalOf(p.species))) problems.push(`Only ${FORM_SPECIES.get(nationalOf(p.species))}'s usual form is in the game.`);
  if (entry.heldLost) notes.push('It comes without its held item: the game doesn\'t have it.');
  // EVs past the 510 the games allow (a cheat, or Diamond and Pearl's Pomeg glitch): lowered to 510, each in proportion
  const total = p.evs.reduce((sum, ev) => sum + ev, 0);
  if (total > 510) {
    p.evs = p.evs.map(ev => Math.floor(ev * 510 / total));
    finish(p, nationalOf(p.species));
    notes.push(`Its effort values add up to ${total}, more than the 510 the games allow: they're lowered to 510, and its stats with them.`);
  }
  // an item the game can't have comes off (the copy in the GBA or DS save keeps it)
  const itemCodes = ['item', 'key-item', 'later-item'];
  const found = convert.problems(p, receiver);
  if (found.some(each => itemCodes.includes(each.code))) {
    p.item = 0;
    notes.push(found.some(each => each.code === 'later-item')
      ? 'It comes without its held item: a Generation 4 item needs Diamond and Pearl battle rules.'
      : 'It comes without its held item: the game doesn\'t have it.');
  }
  for (const each of found) if (!itemCodes.includes(each.code)) problems.push(PROBLEM[each.code] || each.text);
  const unique = problems.filter((each, i) => problems.indexOf(each) === i);
  return { bytes: unique.length ? null : convert.write(receiver.game, p), problems: unique, notes, pokemon: p };
}

module.exports = { KINDS, readFile, parse, judge, fromGba, fromDs, speciesFromNational, nationalOf, levelOf, expAt, statsOf };
