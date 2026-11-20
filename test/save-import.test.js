'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const gen3 = require('../src/gen3-save');
const ds = require('../src/ds-save');
const si = require('../src/save-import');
const convert = require('../src/trade-convert');

const RECEIVER = { game: 'colosseum', laterPokemon: true, laterMoves: true, laterItems: false };
const OLD_ONLY = { game: 'colosseum', laterPokemon: false, laterMoves: false, laterItems: false };
const text = codes => String.fromCharCode(...codes);

// ---- a GBA save's Pokémon (pokeemerald's BoxPokemon) ----
const GBA = { A: 0xBB, a: 0xD5 };
const gbaName = word => [...word].map(c => (c === ' ' ? 0 : c <= '9' ? 0xA1 + Number(c) : c >= 'a' ? GBA.a + c.charCodeAt(0) - 97 : GBA.A + c.charCodeAt(0) - 65));
function pk3({ personality = 0x00000003, otId = 0x1234ABCD, species = 304, item = 0, exp = 3093, moves = [64, 45], pp = [35, 40], ppBonuses = 0,
  friendship = 70, evs = [1, 2, 3, 4, 5, 6], contest = [10, 20, 30, 40, 50, 60], ivWord = 0, ribbons = 0, origins = (16 | (3 << 7) | (4 << 11)),
  metLocation = 16, nickname = 'TAILLOW', otName = 'ASH', language = 2, flags = 0x02, party = true, badChecksum = false } = {}) {
  const mon = Buffer.alloc(party ? 100 : 80);
  mon.writeUInt32LE(personality >>> 0, 0);
  mon.writeUInt32LE(otId >>> 0, 4);
  mon.fill(0xFF, 8, 18); Buffer.from(gbaName(nickname)).copy(mon, 8);
  mon[0x12] = language; mon[0x13] = flags;
  mon.fill(0xFF, 0x14, 0x1B); Buffer.from(gbaName(otName)).copy(mon, 0x14);
  const subs = { G: Buffer.alloc(12), A: Buffer.alloc(12), E: Buffer.alloc(12), M: Buffer.alloc(12) };
  subs.G.writeUInt16LE(species, 0); subs.G.writeUInt16LE(item, 2); subs.G.writeUInt32LE(exp, 4); subs.G[8] = ppBonuses; subs.G[9] = friendship;
  moves.forEach((move, i) => { subs.A.writeUInt16LE(move, 2 * i); subs.A[8 + i] = pp[i]; });
  Buffer.from([...evs, ...contest]).copy(subs.E);
  subs.M[1] = metLocation; subs.M.writeUInt16LE(origins, 2); subs.M.writeUInt32LE(ivWord >>> 0, 4); subs.M.writeUInt32LE(ribbons >>> 0, 8);
  const plain = Buffer.concat([...gen3.ORDERS[personality % 24]].map(letter => subs[letter]));
  let sum = 0;
  for (let i = 0; i < 48; i += 2) sum = (sum + plain.readUInt16LE(i)) & 0xFFFF;
  mon.writeUInt16LE(badChecksum ? sum ^ 1 : sum, 0x1C);
  const key = (personality ^ otId) >>> 0;
  for (let i = 0; i < 48; i += 4) mon.writeUInt32LE((plain.readUInt32LE(i) ^ key) >>> 0, 0x20 + i);
  if (party) mon[0x54] = 16;
  return mon;
}

// An Emerald save: the party in SaveBlock1, boxed Pokémon in the PC (PokemonStorage), sections rotated as the game saves
const SIZES = [3884, 3968, 3968, 3968, 3848, 3968, 3968, 3968, 3968, 3968, 3968, 3968, 3968, 2000];
function gen3Save({ party = [], boxed = [] } = {}) {
  const data = Buffer.alloc(gen3.SAVE_SIZE, 0);
  const sections = SIZES.map(() => Buffer.alloc(0x1000));
  const sb2 = sections[0], sb1 = Buffer.alloc(0xF80 * 4), storage = Buffer.alloc(SIZES.slice(5).reduce((a, b) => a + b, 0));
  Buffer.from([...gbaName('ASH'), 0xFF]).copy(sb2, 0);
  sb2.writeUInt32LE(0x1234ABCD, 0x0A);
  sb2.writeUInt32LE(0x5EED, 0xAC);
  sb1[0x234] = party.length;
  party.forEach((mon, i) => mon.copy(sb1, 0x238 + i * 100));
  for (const { box, slot, mon } of boxed) mon.copy(storage, 4 + (box * 30 + slot) * 80);
  Buffer.from([...gbaName('BOX1'), 0xFF]).copy(storage, 4 + 14 * 30 * 80);
  for (let id = 1; id <= 4; id++) sb1.copy(sections[id], 0, (id - 1) * 0xF80, id * 0xF80);
  let at = 0;
  for (let id = 5; id <= 13; id++) { storage.copy(sections[id], 0, at, at + SIZES[id]); at += SIZES[id]; }
  sections.forEach((section, id) => {
    let sum = 0;
    for (let i = 0; i < SIZES[id]; i += 4) sum = (sum + section.readUInt32LE(i)) >>> 0;
    section.writeUInt16LE(id, 0xFF4);
    section.writeUInt16LE(((sum >>> 16) + sum) & 0xFFFF, 0xFF6);
    section.writeUInt32LE(0x08012025, 0xFF8);
    section.writeUInt32LE(5, 0xFFC);
    section.copy(data, ((id + 3) % 14) * 0x1000);
  });
  return data;
}

// ---- a DS save's Pokémon (pokeplatinum's BoxPokemon, blocks A-D) ----
const dsName = word => [...word].map(c => (c === ' ' ? 0x1DE : c <= '9' ? 0x121 + Number(c) : c >= 'a' ? 0x145 + c.charCodeAt(0) - 97 : 0x12B + c.charCodeAt(0) - 65));
const BLOCK_ORDERS = [[0, 1, 2, 3], [0, 1, 3, 2], [0, 2, 1, 3]];
function pk4({ personality = 0, otId = (18878 << 16) | 41907, species = 453, item = 234, exp = 16172, ability = 87, moves = [185, 358, 421], pp = [20, 10, 30],
  ppUps = [0, 0, 0], evs = [10, 20, 30, 40, 50, 60], ivWord = 0, hoenn = 0, formByte = 0, hometown = 12, language = 2,
  nickname = 'Bulf', nicknameCodes = null, otName = 'Mahin', ball = 4, metLevel = 20, otFemale = false, party = true } = {}) {
  const b = Buffer.alloc(136);
  b.writeUInt32LE(personality >>> 0, 0);
  b.writeUInt16LE(species, 0x08); b.writeUInt16LE(item, 0x0A); b.writeUInt32LE(otId >>> 0, 0x0C); b.writeUInt32LE(exp, 0x10);
  b[0x14] = 70; b[0x15] = ability; b[0x17] = language;
  Buffer.from(evs).copy(b, 0x18);
  moves.forEach((move, i) => { b.writeUInt16LE(move, 0x28 + 2 * i); b[0x30 + i] = pp[i]; b[0x34 + i] = ppUps[i]; });
  b.writeUInt32LE(ivWord >>> 0, 0x38); b.writeUInt32LE(hoenn >>> 0, 0x3C); b[0x40] = formByte;
  const name = [...(nicknameCodes || dsName(nickname)), 0xFFFF];
  name.forEach((code, i) => b.writeUInt16LE(code, 0x48 + 2 * i));
  b[0x5F] = hometown;
  [...dsName(otName), 0xFFFF].forEach((code, i) => b.writeUInt16LE(code, 0x68 + 2 * i));
  b[0x83] = ball; b[0x84] = metLevel | (otFemale ? 0x80 : 0);
  let sum = 0;
  for (let i = 8; i < 136; i += 2) sum = (sum + b.readUInt16LE(i)) & 0xFFFF;
  const order = BLOCK_ORDERS[((personality & 0x3E000) >>> 13) % 24] || [0, 1, 2, 3];
  const shuffled = Buffer.alloc(128);
  for (let id = 0; id < 4; id++) b.copy(shuffled, order[id] * 32, 8 + id * 32, 8 + id * 32 + 32);
  const out = Buffer.alloc(party ? 236 : 136);
  b.copy(out, 0, 0, 8);
  out.writeUInt16LE(sum, 6);
  ds.cipher(shuffled, sum).copy(out, 8);
  if (party) {
    const extra = Buffer.alloc(100);
    extra[4] = 25;
    ds.cipher(extra, personality).copy(out, 136);
  }
  return out;
}

// A Platinum save: both copies' general and storage blocks, each with its footer; `damageNewer` breaks the newer general block
function platinumSave({ party = [], boxed = [], damageNewer = false, trainer = 'Mahin' } = {}) {
  const data = Buffer.alloc(ds.SAVE_SIZE, 0xFF);
  const { general: gSize, storage: sSize, party: partyAt, trainer: trainerAt, boxes } = ds.GAMES.pt;
  const write = (at, size, fill, saveCount, blockCount) => {
    const block = Buffer.alloc(size);
    fill(block);
    block.writeUInt32LE(saveCount, size - 0x14); block.writeUInt32LE(blockCount, size - 0x10);
    block.writeUInt32LE(size, size - 0x0C); block.writeUInt32LE(0x20060623, size - 0x08);
    block.writeUInt16LE(ds.crc16(block.subarray(0, size - 0x14)), size - 0x02);
    block.copy(data, at);
  };
  for (const [copy, count] of [[0, 1], [0x40000, 2]]) {
    write(copy, gSize, block => {
      [...dsName(trainer), 0xFFFF].forEach((code, i) => block.writeUInt16LE(code, trainerAt + 2 * i));
      block.writeUInt16LE(41907, trainerAt + 0x10); block.writeUInt16LE(18878, trainerAt + 0x12);
      block.writeUInt32LE(6, partyAt - 8);
      block.writeUInt32LE(count === 2 ? party.length : 0, partyAt - 4);
      if (count === 2) party.forEach((mon, i) => mon.copy(block, partyAt + i * 236));
    }, count, count);
    write(copy + gSize, sSize, block => {
      for (const { box, slot, mon } of boxed) mon.copy(block, boxes + (box * 30 + slot) * 136);
      [...dsName('BOX 1'), 0xFFFF].forEach((code, i) => block.writeUInt16LE(code, boxes + 18 * 30 * 136 + 2 * i));
    }, count, count);
  }
  if (damageNewer) data[0x40000 + 0x200] ^= 0xFF;
  return data;
}

test('a GBA save\'s Pokémon come as Colosseum\'s own GBA trade reads them, its party and its boxes', () => {
  // Taillow, Hardy (personality 3 % 25), from Emerald (game 3), IVs 23/9/25/(spe 26)/(spa 17)/(spd 25), second ability
  const ivWord = 23 | (9 << 5) | (25 << 10) | (26 << 15) | (17 << 20) | (25 << 25) | (1 << 31);
  const ribbons = 2 | (4 << 3) | (1 << 15) | (1 << 24) | (1 << 31);   // Cool Super, Beauty Master, Champion, National, fateful
  const file = si.parse(gen3Save({ party: [pk3({ ivWord, ribbons, item: 200 })], boxed: [{ box: 0, slot: 3, mon: pk3({ species: 286, exp: 512, personality: 7, party: false, nickname: 'POOCHYENA' }) }] }));
  assert.equal(file.kind, 'gba');
  assert.equal(file.gameName, 'Emerald');
  assert.equal(file.trainer, 'ASH');
  const p = file.party[0].pokemon;
  assert.equal(p.species, 304);
  assert.equal(p.nicknameText, 'TAILLOW');
  assert.equal(text(p.otName), 'ASH');
  assert.deepEqual(p.attest, [10, 3, 2, 2]);
  assert.equal(p.level, 16);
  assert.deepEqual(p.ivs, [23, 9, 25, 17, 25, 26]);
  assert.deepEqual(p.evs, [1, 2, 3, 5, 6, 4]);
  assert.equal(p.abilitySlot, 1);
  assert.deepEqual(p.ranks, [2, 4, 0, 0, 0]);
  assert.deepEqual([p.ribbons[0], p.ribbons[9], p.event], [true, true, true]);
  assert.deepEqual([p.ball, p.metLevel, p.metLocation, p.item], [4, 16, 16, 200]);
  assert.deepEqual(p.moves.map(move => move.id), [64, 45]);
  // the box keeps no level or stats: worked out from its experience (Poochyena, medium fast: 512 = level 8)
  assert.equal(file.boxes[0].name, 'BOX1');
  const boxed = file.boxes[0].pokemon[3].pokemon;
  assert.equal(boxed.level, 8);
  assert.equal(boxed.hp, boxed.stats[0]);
  assert.equal(file.boxes[0].pokemon[2], null);
  // it goes into Colosseum and XD as itself
  const judged = si.judge(file.party[0], OLD_ONLY);
  assert.deepEqual([judged.problems, judged.notes], [[], []]);
  for (const game of ['colosseum', 'xd']) {
    const back = convert.read(game, convert.write(game, judged.pokemon));
    assert.deepEqual([back.species, back.rnd, back.otId, back.level, back.item, back.nicknameText], [304, 3, 0x1234ABCD, 16, 200, 'TAILLOW']);
  }
});

test('the games\' stat formula, with a nature, and each growth rate\'s level', () => {
  // Garchomp at level 78, Adamant, as Bulbapedia works it: IVs and EVs in the games' order (HP, Atk, Def, SpA, SpD, Spe)
  assert.deepEqual(si.statsOf(445, 78, [24, 12, 30, 16, 23, 5], [74, 190, 91, 48, 84, 23], 3), [289, 278, 193, 135, 171, 171]);
  assert.equal(si.statsOf(292, 50, [31, 31, 31, 31, 31, 31], [0, 0, 0, 0, 0, 0], 0)[0], 1);   // Shedinja
  for (const rate of ['fast', 'mediumFast', 'mediumSlow', 'slow', 'erratic', 'fluctuating']) {
    assert.equal(si.levelOf(rate, 0), 1);
    for (const n of [2, 15, 16, 36, 37, 50, 51, 68, 69, 98, 99, 100]) {
      assert.equal(si.levelOf(rate, si.expAt(rate, n)), n, `${rate} ${n}`);
      assert.equal(si.levelOf(rate, si.expAt(rate, n) - 1), n - 1, `${rate} ${n} - 1`);
    }
  }
  assert.equal(si.expAt('erratic', 100), 600000);
  assert.equal(si.expAt('fluctuating', 100), 1640000);
});

test('what can\'t come from a GBA save says so: eggs, damaged data, and an item the game hasn\'t got comes off', () => {
  const file = si.parse(gen3Save({ party: [pk3({ ivWord: 1 << 30 }), pk3({ badChecksum: true }), pk3({ item: 121 }), pk3({ evs: [255, 255, 255, 0, 0, 0] })] }));
  assert.match(si.judge(file.party[0], RECEIVER).problems[0], /Eggs can't come/);
  assert.match(si.judge(file.party[1], RECEIVER).problems[0], /damaged/);
  const mail = si.judge(file.party[2], RECEIVER);
  assert.deepEqual(mail.problems, []);
  assert.equal(mail.pokemon.item, 0);
  assert.match(mail.notes[0], /without its held item/);
  // more effort values than the games allow: lowered to 510 in proportion, and its stats with them
  const ev = si.judge(file.party[3], RECEIVER);
  assert.deepEqual(ev.pokemon.evs, [170, 170, 170, 0, 0, 0]);
  assert.match(ev.notes[0], /765/);
  assert.ok(ev.bytes);
  assert.throws(() => si.parse(Buffer.alloc(1000), 'x.sav'), /wrong size/);
});

test('a DS save\'s Pokémon: Generation 4 numbers made the games\', Pal Park\'s way round', () => {
  const hoenn = 0b0011 | (0b1111 << 4) | (1 << 20) | (1 << 29);   // Cool to Super, Beauty to Master, Champion, National
  const file = si.parse(platinumSave({
    party: [pk4({ hoenn }), pk4({ species: 260, nickname: 'SWAMPERT', item: 135, moves: [57, 89], hometown: 3, personality: 0x2000 })],
    boxed: [{ box: 0, slot: 0, mon: pk4({ species: 479, formByte: 1 << 3, party: false }) }, { box: 0, slot: 1, mon: pk4({ species: 445, item: 94, party: false, personality: 0x4000 }) }]
  }));
  assert.equal(file.kind, 'ds');
  assert.equal(file.gameName, 'Platinum');
  assert.equal(file.trainer, 'Mahin');
  assert.equal(file.boxes[0].name, 'BOX 1');
  // Croagunk: national 453 is the game's 479; Wake-Up Slap (358) the game's 361, Shadow Claw (421) 424; Leftovers (234) the GBA's 200; Dry Skin, its second
  const p = file.party[0].pokemon;
  assert.equal(p.species, 479);
  assert.equal(p.nicknameText, 'Bulf');
  assert.equal(text(p.otName), 'Mahin');
  assert.equal(p.otId, ((18878 << 16) | 41907) >>> 0);
  assert.deepEqual(p.moves.map(move => move.id), [185, 361, 424]);
  assert.equal(p.item, 200);
  assert.equal(p.abilitySlot, 1);
  assert.deepEqual(p.attest, [12, 3, 2, 2]);
  assert.deepEqual(p.ranks, [2, 4, 0, 0, 0]);
  assert.deepEqual([p.ribbons[0], p.ribbons[9], p.ribbons[1]], [true, true, false]);
  assert.equal(p.level, 25);
  assert.deepEqual(si.judge(file.party[0], RECEIVER).problems, []);
  // with Generation 4 Pokémon off, it can't come
  assert.match(si.judge(file.party[0], OLD_ONLY).problems[0], /Generation 4 Pokémon/);
  // Swampert from Emerald (Pal Park): the Hoenn number, its game kept; the Adamant Orb needs Platinum's rules: it comes off
  const swampert = si.judge(file.party[1], RECEIVER);
  assert.equal(swampert.pokemon.species, si.speciesFromNational(260));
  assert.equal(swampert.pokemon.species, 285);
  assert.equal(swampert.pokemon.attest[0], 10);
  assert.equal(swampert.pokemon.item, 0);
  assert.match(swampert.notes[0], /Diamond and Pearl battle rules/);
  assert.equal(si.judge(file.party[1], { ...RECEIVER, laterItems: true }).pokemon.item, 548);
  // Rotom's other forms aren't in the game; Garchomp's Honey is (a Generation 4 item)
  assert.match(si.judge(file.boxes[0].pokemon[0], RECEIVER).problems[0], /Rotom's usual form/);
  assert.ok(si.judge(file.boxes[0].pokemon[1], { ...RECEIVER, laterItems: true }).pokemon.item >= 0x224);
  // names: a DS space, and a GBA space Pal Park kept as 0, are spaces; a character neither game has is "?"
  const named = si.parse(platinumSave({ party: [pk4({ nicknameCodes: [...dsName('TIME'), 0, ...dsName('ONION')] }), pk4({ nicknameCodes: [...dsName('MR'), 0x1DE, ...dsName('X'), 0x400] })] }));
  assert.deepEqual(named.party.map(entry => entry.pokemon.nicknameText), ['TIME ONION', 'MR X?']);
  // into XD too, in XD's numbers
  const xd = si.judge(file.party[0], { ...RECEIVER, game: 'xd' });
  assert.equal(convert.read('xd', xd.bytes).species, 479);
  assert.equal(xd.bytes.readUInt16BE(0), 481);
});

test('a DS save\'s newer copy is read unless it\'s damaged, and other files are refused', t => {
  const mon = pk4({});
  assert.equal(si.parse(platinumSave({ party: [mon] })).party.length, 1);
  // the newer general block damaged: the older copy (its party empty here) is the save
  assert.equal(si.parse(platinumSave({ party: [mon], damageNewer: true })).party.length, 0);
  assert.throws(() => ds.parse(Buffer.alloc(ds.SAVE_SIZE)), /isn't a Pokémon Diamond, Pearl or Platinum save/);
  // a DeSmuME save has its own footer after the 512 KB
  assert.equal(si.parse(Buffer.concat([platinumSave({ party: [mon] }), Buffer.from('|<--Snip above here to create a raw sav by excluding this DeSmuME savedata footer:')])).party.length, 1);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'save-import-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'Pokemon Platinum.srm'), platinumSave({ party: [mon] }));
  assert.equal(si.readFile(path.join(dir, 'Pokemon Platinum.srm')).party[0].pokemon.species, 479);
  assert.throws(() => si.readFile(path.join(dir, 'missing.sav')), /Can't read missing.sav/);
});
