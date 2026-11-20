'use strict';
// Online Trades: a traded Pokémon made the receiver's game's (shadowtrade-work/research-trade-conversion.md). Colosseum
// keeps a Pokémon in 0x138 bytes and XD in 0xC4, the same fields laid out apart (as each game's own GBA trade moves
// them). read() takes either into one form, in Colosseum's numbering; problems() says what would keep the receiver's
// game from taking it; write() lays it out as the receiver's game has it. Always written afresh from the fields, so
// what a save holds that no field is (leftover memory in Colosseum's 0xFC-0x137 and XD's spare bytes) never travels,
// and with no Shadow id: a purified Pokémon keeps its old one, which in the receiver's save would be another Pokémon's.
//
// Numbers: species, moves and held items are the same in both games for the third generation's (species 1-411, moves
// 1-354, items 1-499); the fourth generation's (only with the receiver's Generation 4 setting) and the Shadow moves are
// not (host/mechanics.c colo_xd_species, colo_xd_move, colo_xd_item); XD's own Bonsly and Munchlax (413, 414) are
// Colosseum's fourth-generation ones (464, 472). Pack Pokémon have rows each launcher numbers itself: they can't travel.
const SIZE = { colosseum: 0x138, xd: 0xc4 };
const LATER_SPECIES = [413, 519];             // Colosseum's fourth generation (national + 26)
const XD_BONSLY = 413, XD_MUNCHLAX = 414, COLO_BONSLY = 464, COLO_MUNCHLAX = 472;
const SHADOW_MOVES = { colosseum: [355, 357], xd: [355, 374] };
const LATER_MOVES = [358, 470];               // Colosseum's numbers (national + 3); XD's are 17 more
const FAIRY_MOVES = [577, 580, 586, 587, 588, 608, 611];   // the Fairy type's, in Colosseum's numbers too
const LATER_ITEMS = [0x224, 0x289];           // Colosseum's; XD's are 0x2E more
const KEY_ITEMS = { colosseum: [0x1f4, 0x223], xd: [0x1f4, 0x251] };
// the third generation's held items both games have alike (src/crossplay.js, host/crossplay.c ITEMS)
const HOLDABLE = [[1, 51], [63, 71], [73, 81], [83, 86], [93, 98], [103, 104], [106, 111], [133, 174], [179, 225], [254, 258]];
const EGG = 412;
const within = (range, n) => n >= range[0] && n <= range[1];
const holdable = item => HOLDABLE.some(range => within(range, item));

// ---- numbers, into Colosseum's and back ----
function speciesToColosseum(game, id) {
  if (game === 'colosseum') return id;
  if (id === XD_BONSLY) return COLO_BONSLY;
  if (id === XD_MUNCHLAX) return COLO_MUNCHLAX;
  return id >= 415 && id <= 521 ? id - 2 : id;
}
function speciesFromColosseum(game, id) {
  if (game === 'colosseum') return id;
  if (id === COLO_BONSLY) return XD_BONSLY;
  if (id === COLO_MUNCHLAX) return XD_MUNCHLAX;
  return within(LATER_SPECIES, id) ? id + 2 : id;
}
// a move id into Colosseum's: 0 for a Shadow move
function moveToColosseum(game, id) {
  if (within(SHADOW_MOVES[game], id)) return { id: 0, shadow: true };
  return { id: game === 'xd' && id >= 375 ? id - 17 : id, shadow: false };
}
const moveFromColosseum = (game, id) => game === 'xd' && id >= 358 ? id + 17 : id;
function itemToColosseum(game, id) {
  if (!id) return 0;
  if (within(KEY_ITEMS[game], id)) return -id;   // (a key item: none can travel)
  return game === 'xd' && id >= 0x252 ? id - 0x2e : id;
}
const itemFromColosseum = (game, id) => game === 'xd' && id >= LATER_ITEMS[0] ? id + 0x2e : id;

// ---- reading ----
const units = (b, at, count) => Array.from({ length: count }, (_, i) => b.readUInt16BE(at + 2 * i));
const text = codes => { const end = codes.indexOf(0); return String.fromCharCode(...(end < 0 ? codes : codes.slice(0, end))); };

function read(game, bytes) {
  if (!SIZE[game] || !Buffer.isBuffer(bytes) || bytes.length !== SIZE[game]) throw new Error('That isn\'t a Pokémon of this game.');
  const b = bytes, x = game === 'xd';
  const moveAt = x ? 0x80 : 0x78;
  const moves = [0, 1, 2, 3].map(i => {
    const id = b.readUInt16BE(moveAt + 4 * i);
    return id ? { ...moveToColosseum(game, id), pp: b[moveAt + 4 * i + 2], ppUps: b[moveAt + 4 * i + 3] } : null;
  }).filter(Boolean);
  const ribbonsWord = x ? b.readUInt32BE(0x7c) : 0;
  const p = {
    game, species: speciesToColosseum(game, b.readUInt16BE(0)), rnd: b.readUInt32BE(x ? 0x28 : 0x04),
    attest: [...b.subarray(x ? 0x34 : 0x08, (x ? 0x34 : 0x08) + 4)], metLocation: b.readUInt16BE(x ? 0x08 : 0x0c),
    metLevel: b[0x0e], ball: b[0x0f], otGender: b[0x10], otId: b.readUInt32BE(x ? 0x24 : 0x14),
    otName: units(b, x ? 0x38 : 0x18, 11), nickname: units(b, x ? 0x4e : 0x2e, 11), nicknameOrg: units(b, x ? 0x64 : 0x44, 11),
    exp: b.readUInt32BE(x ? 0x20 : 0x5c), level: b[x ? 0x11 : 0x60], conditionAmari: b.readUInt32BE(x ? 0x2c : 0x74),
    moves, item: itemToColosseum(game, b.readUInt16BE(x ? 0x02 : 0x88)), hp: b.readUInt16BE(x ? 0x04 : 0x8a),
    stats: [0, 1, 2, 3, 4, 5].map(i => b.readUInt16BE((x ? 0x90 : 0x8c) + 2 * i)),
    evs: [0, 1, 2, 3, 4, 5].map(i => b.readUInt16BE((x ? 0x9c : 0x98) + 2 * i)),
    ivs: [0, 1, 2, 3, 4, 5].map(i => x ? b[0xa8 + i] : b.readUInt16BE(0xa4 + 2 * i)),
    friendship: b.readUInt16BE(x ? 0x06 : 0xb0),
    contest: [...b.subarray(x ? 0xae : 0xb2, (x ? 0xae : 0xb2) + 5)], ranks: [...b.subarray(x ? 0xb3 : 0xb7, (x ? 0xb3 : 0xb7) + 5)],
    sheen: b[x ? 0x12 : 0xbc],
    ribbons: [...Array(12).keys()].map(i => x ? Boolean(ribbonsWord & (1 << (31 - i))) : b[0xbd + i] !== 0),
    ribbonSpare: x ? (ribbonsWord >>> 12) & 0xff : b[0xc9],
    pokerus: b[x ? 0x13 : 0xca],
    egg: x ? Boolean(b[0x1d] & 0x80) : b[0xcb] !== 0,
    abilitySlot: x ? (b[0x1d] >> 6) & 1 : b[0xcc] & 1,
    invalid: x ? Boolean(b[0x1d] & 0x20) : b[0xcd] === 1,
    flagAmari: b[x ? 0x1a : 0xce], markings: b[x ? 0x14 : 0xcf],
    para1Amari: b.readUInt16BE(x ? 0x0c : 0xd2), amari: b.readUInt16BE(x ? 0x0a : 0xd4),
    // the "fateful encounter" flag, as each game reads it: XD the whole word, Colosseum its last byte
    event: x ? b.readUInt32BE(0x30) !== 0 : b[0xfb] !== 0,
    shadowId: b.readUInt16BE(x ? 0xba : 0xd8),
    // a Shadow now, as far as the bytes say (Colosseum: its heart gauge; XD's is in the save's record: save-pokemon.js)
    shadowNow: !x && b.readUInt16BE(0xd8) !== 0 && b.readInt32BE(0xdc) >= 0
  };
  p.nicknameText = text(p.nickname);
  return p;
}

// ---- what the receiver's game can take ----
// receiver: { game, laterPokemon (its Generation 4 Pokémon setting), laterMoves (that, or Generation 4 battle rules),
// laterItems (Generation 4 battle rules: the items have data only then) }. Each problem is { code, text }.
function problems(p, receiver = {}) {
  const out = [], say = (code, words) => out.push({ code, text: words });
  if (p.egg) say('egg', 'An egg can\'t be traded.');
  if (p.invalid || p.attest.some(byte => !byte)) say('invalid', 'This Pokémon\'s data is damaged.');
  if (p.shadowNow) say('shadow', 'A Shadow Pokémon can\'t be traded until it\'s purified.');
  const s = p.species;
  if (!s || s === EGG) say('invalid', 'This Pokémon\'s data is damaged.');
  else if (s >= 252 && s <= 276 || s > LATER_SPECIES[1]) say('pack', 'Pokémon from a Pokémon pack can\'t be traded: each launcher numbers them its own way.');
  else if (within(LATER_SPECIES, s) && !(receiver.game === 'xd' && (s === COLO_BONSLY || s === COLO_MUNCHLAX)) && !receiver.laterPokemon)
    say('later-species', 'The other player\'s game doesn\'t have Generation 4 Pokémon turned on.');
  const kept = p.moves.filter(m => !m.shadow);
  if (kept.some(m => within(LATER_MOVES, m.id)) && !receiver.laterMoves)
    say('later-move', 'It knows a Generation 4 move the other player\'s game doesn\'t have turned on.');
  // the Fairy type's moves (src/generations.js), which a trade doesn't carry: the other game may not have the type
  if (kept.some(m => FAIRY_MOVES.includes(m.id))) say('move', 'It knows a Fairy-type move, which trades don\'t carry: make it forget the move first.');
  else if (kept.some(m => m.id > LATER_MOVES[1] || m.id < 1)) say('move', 'It knows a move the other game doesn\'t have.');
  if (!kept.length) say('no-moves', 'It knows only Shadow moves: teach it another move first.');
  if (p.item < 0) say('key-item', 'It holds an item that can\'t be traded: take it off first.');
  else if (p.item && within(LATER_ITEMS, p.item)) { if (!receiver.laterItems) say('later-item', 'It holds a Generation 4 item the other player\'s game can\'t have: take it off first.'); }
  else if (p.item && !holdable(p.item)) say('item', 'It holds an item the other game doesn\'t have: take it off first.');
  if (p.ivs.some(v => v > 31) || p.evs.some(v => v > 255) || p.evs.reduce((a, v) => a + v, 0) > 510) say('invalid', 'This Pokémon\'s data is damaged.');
  return out.filter((each, i) => out.findIndex(other => other.code === each.code) === i);
}

// ---- writing ----
function putUnits(b, at, codes, count) {
  const end = codes.indexOf(0), kept = (end < 0 ? codes : codes.slice(0, end)).slice(0, count - 1);
  kept.forEach((code, i) => b.writeUInt16BE(code, at + 2 * i));
}

function write(game, p) {
  if (!SIZE[game]) throw new Error('No such game.');
  const b = Buffer.alloc(SIZE[game]), x = game === 'xd';
  const moves = p.moves.filter(m => !m.shadow).slice(0, 4);
  b.writeUInt16BE(speciesFromColosseum(game, p.species), 0);
  b.writeUInt32BE(p.rnd >>> 0, x ? 0x28 : 0x04);
  Buffer.from(p.attest).copy(b, x ? 0x34 : 0x08);
  b.writeUInt16BE(p.metLocation, x ? 0x08 : 0x0c);
  b[0x0e] = p.metLevel; b[0x0f] = p.ball >= 1 && p.ball <= 12 ? p.ball : 4;   // (a ball neither game has: a Poké Ball)
  b[0x10] = p.otGender;
  b.writeUInt32BE(p.otId >>> 0, x ? 0x24 : 0x14);
  putUnits(b, x ? 0x38 : 0x18, p.otName, 11);
  putUnits(b, x ? 0x4e : 0x2e, p.nickname, 11);
  putUnits(b, x ? 0x64 : 0x44, p.nicknameOrg, 11);
  b.writeUInt32BE(p.exp >>> 0, x ? 0x20 : 0x5c);
  b[x ? 0x11 : 0x60] = Math.min(p.level, 100);
  b.writeUInt32BE(p.conditionAmari >>> 0, x ? 0x2c : 0x74);   // (the GBA status word's high bits; the status itself heals)
  moves.forEach((m, i) => {
    const at = (x ? 0x80 : 0x78) + 4 * i;
    b.writeUInt16BE(moveFromColosseum(game, m.id), at); b[at + 2] = m.pp; b[at + 3] = Math.min(m.ppUps, 3);
  });
  b.writeUInt16BE(itemFromColosseum(game, Math.max(p.item, 0)), x ? 0x02 : 0x88);
  b.writeUInt16BE(Math.min(p.hp, p.stats[0]), x ? 0x04 : 0x8a);
  p.stats.forEach((v, i) => b.writeUInt16BE(v, (x ? 0x90 : 0x8c) + 2 * i));
  p.evs.forEach((v, i) => b.writeUInt16BE(v, (x ? 0x9c : 0x98) + 2 * i));
  p.ivs.forEach((v, i) => { if (x) b[0xa8 + i] = v & 0x1f; else b.writeUInt16BE(v & 0x1f, 0xa4 + 2 * i); });
  b.writeUInt16BE(Math.min(p.friendship, 255), x ? 0x06 : 0xb0);
  Buffer.from(p.contest).copy(b, x ? 0xae : 0xb2);
  Buffer.from(p.ranks).copy(b, x ? 0xb3 : 0xb7);
  b[x ? 0x12 : 0xbc] = p.sheen;
  if (x) {
    let word = (p.ribbonSpare & 0xff) << 12;
    p.ribbons.forEach((on, i) => { if (on) word |= 1 << (31 - i); });
    b.writeUInt32BE(word >>> 0, 0x7c);
  } else {
    p.ribbons.forEach((on, i) => { b[0xbd + i] = on ? 1 : 0; });
    b[0xc9] = p.ribbonSpare;
  }
  b[x ? 0x13 : 0xca] = p.pokerus;
  if (x) b[0x1d] = (p.abilitySlot ? 0x40 : 0);
  else b[0xcc] = p.abilitySlot ? 1 : 0;
  b[x ? 0x1a : 0xce] = p.flagAmari;
  b[x ? 0x14 : 0xcf] = p.markings;
  b[x ? 0x15 : 0xd0] = 0xff;   // no mail: it's the save's, and stays
  b.writeUInt16BE(p.para1Amari, x ? 0x0c : 0xd2);
  b.writeUInt16BE(p.amari, x ? 0x0a : 0xd4);
  // the trainer's data row 0 and the Shadow id 0 (Buffer.alloc); Colosseum's heart gauge as a Pokémon never a Shadow has it
  if (!x) b.writeInt32BE(-100, 0xdc);
  b.writeUInt32BE(p.event ? 1 : 0, x ? 0x30 : 0xf8);
  return b;
}

// The Pokémon `bytes` of `fromGame`, made `receiver.game`'s: { bytes, pokemon, problems }, bytes null with problems.
function convert(fromGame, bytes, receiver) {
  const pokemon = read(fromGame, bytes);
  const found = problems(pokemon, receiver);
  return { pokemon, problems: found, bytes: found.length ? null : write(receiver.game, pokemon) };
}

module.exports = { read, write, problems, convert, speciesToColosseum, speciesFromColosseum, moveToColosseum, moveFromColosseum, itemToColosseum, itemFromColosseum, SIZE };
