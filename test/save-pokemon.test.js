'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const gciSave = require('../src/gci-save');
const pcBoxes = require('../src/pc-boxes');
const xdSave = require('../src/xd-save');
const sp = require('../src/save-pokemon');

const utf16 = (bytes, offset, value) => Buffer.from(value, 'utf16le').swap16().copy(bytes, offset);
const OT = 0xae3b618b;

function colosseumPokemon({ species, rnd = 1, trainer = OT, nickname = 'MON', level = 30, hp = 50, egg = false, shadowId = 0, heart = -100 }) {
  const p = Buffer.alloc(0x138);
  p.writeUInt16BE(species, 0); p.writeUInt32BE(rnd, 4); p.writeUInt32BE(trainer, 0x14); utf16(p, 0x2e, nickname);
  p[0x60] = level; p.writeUInt16BE(hp, 0x8a); p.writeUInt16BE(hp, 0x8c); p[0xcb] = egg ? 1 : 0;
  p.writeUInt16BE(shadowId, 0xd8); p.writeInt32BE(heart, 0xdc);
  return p;
}

// A Colosseum card: copies (newest first) of { party, boxes: { 'box:slot': pokemon }, flags, count }, each a slot.
function colosseumCard(dir, copies, extra = null) {
  const data = Buffer.alloc(gciSave.SIZE);
  for (let index = 0; index < 3; index++) {
    const copy = copies[index];
    const plain = Buffer.alloc(gciSave.SLOT_SIZE);
    plain[0] = 1; plain[1] = 1;
    if (copy) {
      plain.writeInt32BE(copy.count ?? 3 - index, 4);
      utf16(plain, 0x78, 'WES');
      plain.writeUInt32BE(OT, 0xa4);
      (copy.party || []).forEach((p, i) => p.copy(plain, 0xa8 + i * 0x138));
      for (let box = 0; box < 3; box++) utf16(plain, 0xb90 + box * 0x24a4, `BOX${box + 1}`);
      for (const [where, p] of Object.entries(copy.boxes || {})) {
        const [box, slot] = where.split(':').map(Number);
        if (box < 3) p.copy(plain, 0xb90 + box * 0x24a4 + 0x14 + slot * 0x138);
      }
      // as a new game makes the Shadow block: heart max 20 (x100), never met (order 0xFFFF)
      for (let n = 1; n <= 0x60; n++) { plain.writeUInt16BE(20, 0x1b4ac + 0x18 * n + 0x16); plain.writeUInt16BE(0xffff, 0x1b4ac + 0x18 * n + 0x14); }
      for (const [kind, ids] of Object.entries(copy.flags || {})) for (const n of ids) {
        const { at, mask } = sp.colosseumFlag(plain, kind, n);
        plain.writeUInt32BE((plain.readUInt32BE(at) | mask) >>> 0, at);
      }
      if (extra) pcBoxes.writeStamp(plain, pcBoxes.fnv64(extra));
    }
    gciSave.scramble(plain).copy(data, gciSave.SLOT_START + index * gciSave.SLOT_SIZE);
  }
  fs.writeFileSync(path.join(dir, 'pokemon_colosseum.dat'), data);
  if (extra) pcBoxes.writeEntries(dir, [{ hash: pcBoxes.fnv64(extra), data: extra }], []);
}

const folder = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'colo-savepokemon-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };

const UMBREON = colosseumPokemon({ species: 197, rnd: 0x372407cb, nickname: 'UMBREON' });
const ESPEON = colosseumPokemon({ species: 196, rnd: 0x11, nickname: 'ESPEON' });
const MAKUHITA = colosseumPokemon({ species: 296, rnd: 0x1234, nickname: 'MAKUHITA', shadowId: 1, heart: 1500 });
const BAYLEEF = colosseumPokemon({ species: 153, rnd: 0x99, nickname: 'BAYLEEF', shadowId: 2, heart: 2000, trainer: 0x5555 });

test('reads a Colosseum save: party, boxes, Shadow flags and gauges', t => {
  const dir = folder(t);
  colosseumCard(dir, [{ party: [UMBREON, MAKUHITA], boxes: { '1:4': ESPEON }, flags: { met: [1, 5], snagged: [1], purified: [5] } }]);
  const save = sp.readCard(dir, 'colosseum');
  assert.equal(save.trainer, 'WES');
  assert.equal(save.trainerId, OT);
  assert.deepEqual(save.party.filter(Boolean).map(p => p.nickname), ['UMBREON', 'MAKUHITA']);
  assert.equal(save.boxes.length, 3);
  assert.equal(save.boxes[1].name, 'BOX2');
  assert.equal(save.boxes[1].pokemon[4].nickname, 'ESPEON');
  const makuhita = save.party[1];
  assert.equal(makuhita.shadow, true);
  assert.equal(makuhita.shadowId, 1);
  assert.equal(makuhita.heartPercent, 75);
  assert.deepEqual(save.shadows[1], { met: true, snagged: true, purified: false, heartMax: 20 });
  assert.equal(save.shadows[5].purified, true);
  assert.equal(save.shadows[2].met, false);
});

test('only a Shadow Pokémon can go, never an egg, and never the last one that can battle', () => {
  const save = { game: 'colosseum', party: [], boxes: [], shadows: {} };
  const p = (over) => ({ key: Math.random(), area: 'party', egg: false, hp: 10, shadow: true, shadowId: 1, species: 296, ...over });
  save.party = [p({ shadow: false, key: 'u' }), p({ key: 's' })];
  assert.equal(sp.offerProblem(save, save.party[0]), 'Only Shadow Pokémon can go to Shadowtrade.');
  assert.equal(sp.offerProblem(save, save.party[1]), null);
  save.party = [p({ key: 'a' })];
  assert.match(sp.offerProblem(save, save.party[0]), /last Pokémon/);
  save.party = [p({ key: 'a' }), p({ key: 'b', hp: 0, shadow: false }), p({ key: 'c', egg: true })];
  assert.match(sp.offerProblem(save, save.party[0]), /last Pokémon/, 'a fainted one or an egg doesn\'t count');
  assert.equal(sp.offerProblem(save, { ...save.party[0], area: 'box' }), null, 'from a box it can go');
  assert.match(sp.offerProblem(save, p({ shadowId: 0x30 })), /story/);
  assert.match(sp.offerProblem(save, p({ egg: true })), /Eggs/);
  assert.match(sp.offerProblem(save, p({ species: 485 })), /Gen 4/, 'a randomizer\'s Gen 4 Shadow stays');
  assert.match(sp.offerProblem(save, p({ species: 260 })), /pack/);
});

test('Colosseum: taking from the party closes the gap in every copy of the save', t => {
  const dir = folder(t);
  colosseumCard(dir, [{ party: [UMBREON, MAKUHITA, ESPEON] }, { party: [UMBREON, MAKUHITA] }]);
  const identity = { species: 296, rnd: 0x1234, trainer: OT };
  const done = sp.editCard(dir, 'colosseum', ctx => sp.takeFrom(ctx, identity, { area: 'party', box: 0, slot: 1 }));
  assert.equal(done.area, 'party');
  assert.equal(done.slot, 1);
  assert.equal(done.bytes.readUInt16BE(0), 296);
  const { copies } = sp.cardCopies(dir, 'colosseum');
  assert.equal(copies.length, 2);
  for (const copy of copies) assert.deepEqual(sp.model(copy.ctx).party.map(p => p?.nickname ?? null).filter(Boolean), copy.count === 3 ? ['UMBREON', 'ESPEON'] : ['UMBREON']);
  // the card still opens as the game opens it
  assert.equal(gciSave.newestPlain(fs.readFileSync(path.join(dir, 'pokemon_colosseum.dat'))).count, 3);
});

test('Colosseum: a received Shadow gets an entry of its own, in the party, then the boxes', t => {
  const dir = folder(t);
  colosseumCard(dir, [{ party: [UMBREON], flags: { met: [2] } }]);
  const big = Buffer.from(BAYLEEF); big.writeInt32BE(9000, 0xdc);
  const done = sp.editCard(dir, 'colosseum', ctx => sp.giveTo(ctx, big));
  assert.deepEqual([done.area, done.slot, done.entry], ['party', 1, 0x2d], 'the first spare id');
  let save = sp.readCard(dir, 'colosseum');
  const bayleef = save.party[1];
  assert.deepEqual([bayleef.nickname, bayleef.shadowId, bayleef.traded, bayleef.storyId], ['BAYLEEF', 0x2d, true, 2]);
  assert.equal(bayleef.trainer, 0x5555, 'the original trainer stays');
  assert.equal(bayleef.heart, 2000, 'within this save\'s gauge size for its story id');
  assert.equal(bayleef.heartPercent, 100);
  const { plain } = sp.cardCopies(dir, 'colosseum').copies[0].ctx;
  const record = 0x1b4ac + 0x18 * 0x2d;
  assert.deepEqual([plain.readUInt16BE(record + 0x10), plain[record + 0x12], plain.readUInt16BE(record + 0x16)], [153, 2, 20]);
  assert.deepEqual(['met', 'snagged', 'purified', 'isNew'].map(kind => sp.colosseumFlag(plain, kind, 0x2d).set), [true, true, false, true]);
  assert.deepEqual([save.shadows[2].met, save.shadows[2].snagged], [true, false], 'the story id\'s own flags untouched');
  assert.equal(sp.editCard(dir, 'colosseum', ctx => sp.giveTo(ctx, big)).already, true, 'a repeat changes nothing');
  const another = Buffer.from(BAYLEEF); another.writeUInt32BE(0x77, 4);
  assert.equal(sp.editCard(dir, 'colosseum', ctx => sp.giveTo(ctx, another)).entry, 0x2e, 'two of one story id: two entries');
  colosseumCard(dir, [{ party: [UMBREON, ESPEON, UMBREON, ESPEON, UMBREON, ESPEON].map((p, i) => { const c = Buffer.from(p); c.writeUInt32BE(i + 100, 4); return c; }) }]);
  assert.deepEqual(['box', 0, 0], Object.values(sp.editCard(dir, 'colosseum', ctx => sp.giveTo(ctx, BAYLEEF))).slice(0, 3));
  save = sp.readCard(dir, 'colosseum');
  assert.equal(save.boxes[0].pokemon[0].nickname, 'BAYLEEF');
});

test('Colosseum: a traded-in Shadow goes out as its story id, and its entry is free again; a purified one gives its entry up', t => {
  const dir = folder(t);
  colosseumCard(dir, [{ party: [UMBREON] }]);
  sp.editCard(dir, 'colosseum', ctx => sp.giveTo(ctx, BAYLEEF));
  const save = sp.readCard(dir, 'colosseum');
  const out = sp.editCard(dir, 'colosseum', ctx => sp.takeFrom(ctx, save.party[1], save.party[1]));
  assert.equal(out.entry, 0x2d);
  assert.equal(out.bytes.readUInt16BE(0xd8), 2, 'sent as story id 2');
  let { plain } = sp.cardCopies(dir, 'colosseum').copies[0].ctx;
  assert.equal(plain[0x1b4ac + 0x18 * 0x2d + 0x12], 0);
  assert.equal(sp.colosseumFlag(plain, 'snagged', 0x2d).set, false);
  // give one, purify it (gauge -100, as the game does), give another: same entry, the purified one is a normal Pokémon
  sp.editCard(dir, 'colosseum', ctx => sp.giveTo(ctx, BAYLEEF));
  sp.editCard(dir, 'colosseum', ctx => { const at = 0xa8 + 0x138; ctx.plain.writeInt32BE(-100, at + 0xdc); return { changed: true }; });
  const second = Buffer.from(MAKUHITA); second.writeUInt32BE(0x5555, 0x14);
  assert.equal(sp.editCard(dir, 'colosseum', ctx => sp.giveTo(ctx, second)).entry, 0x2d);
  const after = sp.readCard(dir, 'colosseum');
  assert.deepEqual(after.party.filter(Boolean).map(p => [p.nickname, p.shadowId, p.shadow]), [['UMBREON', 0, false], ['BAYLEEF', 0, false], ['MAKUHITA', 0x2d, true]]);
});

test('Colosseum: past the save\'s 48 entries they go to the file beside it, which the save names', t => {
  const dir = folder(t);
  colosseumCard(dir, [{ party: [UMBREON] }]);
  // every spare id taken by someone else (an e-Reader card's): not usable
  sp.editCard(dir, 'colosseum', ctx => { for (let id = 1; id <= 0x60; id++) ctx.plain.writeUInt16BE(5, 0x1b4ac + 0x18 * id + 0x10); return { changed: true }; });
  const done = sp.editCard(dir, 'colosseum', ctx => sp.giveTo(ctx, BAYLEEF));
  assert.equal(done.entry, 0x100);
  assert.ok(fs.existsSync(path.join(dir, 'pokemon_colosseum.shadows')));
  const copy = sp.cardCopies(dir, 'colosseum').copies[0].ctx;
  assert.equal(copy.sideMissing, false);
  assert.equal(copy.side.length, 0x10);
  assert.deepEqual([copy.side[0], copy.side[1], copy.side.readUInt16BE(4), copy.side.readUInt16BE(6)], [0x0b, 2, 153, 20]);
  const save = sp.readCard(dir, 'colosseum');
  assert.deepEqual([save.party[1].shadowId, save.party[1].traded, save.party[1].storyId], [0x100, true, 2]);
  const out = sp.editCard(dir, 'colosseum', ctx => sp.takeFrom(ctx, save.party[1], save.party[1]));
  assert.equal(out.bytes.readUInt16BE(0xd8), 2);
  assert.equal(sp.cardCopies(dir, 'colosseum').copies[0].ctx.side.length, 0, 'none in use: the save names none');
});

test('Colosseum: boxes 4 to 10 are edited in the .boxes file, named by a new stamp', t => {
  const dir = folder(t);
  const extra = Buffer.alloc(7 * 0x24a4);
  MAKUHITA.copy(extra, 2 * 0x24a4 + 0x14 + 7 * 0x138);   // box 6, slot 8
  colosseumCard(dir, [{ party: [UMBREON] }], extra);
  let save = sp.readCard(dir, 'colosseum');
  assert.equal(save.boxes.length, 10);
  assert.equal(save.boxes[5].pokemon[7].nickname, 'MAKUHITA');
  const done = sp.editCard(dir, 'colosseum', ctx => sp.takeFrom(ctx, { species: 296, rnd: 0x1234, trainer: OT }, { area: 'box', box: 5, slot: 7 }));
  assert.deepEqual([done.area, done.box, done.slot], ['box', 5, 7]);
  save = sp.readCard(dir, 'colosseum');
  assert.equal(save.boxes.length, 10, 'the new stamp names boxes the file has');
  assert.equal(save.boxes[5].pokemon[7], null);
  assert.equal(pcBoxes.extraBoxPokemon(dir, gciSave.newestPlain(fs.readFileSync(path.join(dir, 'pokemon_colosseum.dat'))).plain), 0);
});

test('a save takes every story id while it has an entry free', t => {
  const dir = folder(t);
  colosseumCard(dir, [{ party: [UMBREON, MAKUHITA], flags: { purified: [3] } }]);
  const { ctx } = sp.cardCopies(dir, 'colosseum').copies[0];
  const accepts = sp.shadowAccepts(sp.model(ctx), ctx);
  assert.equal(accepts.length, 48);
  assert.ok(accepts.includes(1) && accepts.includes(3), 'held or purified: a received one has its own entry');
  assert.ok(!accepts.includes(0x30), 'only story ids travel');
});

// ---- XD ----

const XD_OT = 0xd183a6d5;
function xdPokemon({ species, rnd = 7, trainer = XD_OT, nickname = 'EEVEE', hp = 30, shadowId = 0 }) {
  const p = Buffer.alloc(0xc4);
  p.writeUInt16BE(species, 0); p.writeUInt16BE(hp, 4); p[0x11] = 10; p.writeUInt32BE(trainer, 0x24); p.writeUInt32BE(rnd, 0x28);
  utf16(p, 0x4e, nickname); p.writeUInt16BE(hp, 0x90); p.writeUInt16BE(shadowId, 0xba);
  return p;
}
const SECTIONS = { hero: 0x5000, pcBox: 0x6000, darkPokemon: 0x100, dayCare: 0x12000, chamber: 0x13000 };
function xdCard(dir, { party = [], boxes = {}, records = {} }) {
  const plain = Buffer.alloc(xdSave.PACK_SIZE);
  [0x1234, 0xbeef, 0x42, 0xf00d].forEach((key, i) => plain.writeUInt16BE(key, i * 2));
  const place = (table, at) => { plain.writeUInt16BE(at & 0xffff, table); plain.writeUInt16BE(at >>> 16, table + 2); };
  place(0x3c, SECTIONS.hero); place(0x40, SECTIONS.pcBox); place(0x54, SECTIONS.darkPokemon); place(0x48, SECTIONS.dayCare); place(0x70, SECTIONS.chamber);
  const at = s => xdSave.BODY + SECTIONS[s];
  utf16(plain, at('hero'), 'MICHAEL');
  plain.writeUInt32BE(XD_OT, at('hero') + 0x2c);
  plain.writeUInt32BE(5, at('hero') + 0x938);
  party.forEach((p, i) => p.copy(plain, at('hero') + 0x30 + i * 0xc4));
  for (let box = 0; box < 8; box++) utf16(plain, at('pcBox') + box * 0x170c, `BOX ${box + 1}`);
  for (const [where, p] of Object.entries(boxes)) { const [box, slot] = where.split(':').map(Number); p.copy(plain, at('pcBox') + box * 0x170c + 0x14 + slot * 0xc4); }
  for (const [n, r] of Object.entries(records)) {
    const rec = at('darkPokemon') + Number(n) * 0x48;
    plain.writeUInt32BE(((r.status << 29) | ((r.where || 0) << 15)) >>> 0, rec);
    plain.writeInt32BE(r.heart ?? 0, rec + 0x24);
    plain.writeUInt16BE(r.species ?? 0, rec + 0x1a);
    plain.writeUInt16BE(Number(n), rec + 0x3e);
    plain[rec + 0x13] = r.index ?? 0;
  }
  const card = Buffer.alloc(43 * 0x2000);
  for (const [i, start] of xdSave.SLOTS.entries()) {
    card[start] = 1; card[start + 1] = 1; card[start + 2] = 1;
    card.writeInt32BE(10 - i, start + 4);
    xdSave.encipher(plain).copy(card, start + xdSave.PACK);
  }
  fs.writeFileSync(path.join(dir, 'PokemonXD.dat'), card);
}

const EEVEE = xdPokemon({ species: 133 });
const TEDDIURSA = xdPokemon({ species: 216, rnd: 0x77, nickname: 'TEDDIURSA', shadowId: 1 });

test('reads an XD save, its Shadow records and the rule for what it takes', t => {
  const dir = folder(t);
  xdCard(dir, { party: [EEVEE, TEDDIURSA], boxes: { '2:3': xdPokemon({ species: 25, rnd: 3, nickname: 'PIKACHU' }) },
    records: { 1: { status: 3, where: 1, heart: 1200, species: 216 }, 2: { status: 2, species: 217 }, 3: { status: 3, where: 5 }, 4: { status: 4 }, 5: { status: 1 } } });
  const save = sp.readCard(dir, 'xd');
  assert.equal(save.trainer, 'MICHAEL');
  assert.equal(save.boxes.length, 8);
  assert.equal(save.boxes[2].pokemon[3].nickname, 'PIKACHU');
  assert.equal(save.party[1].shadow, true);
  assert.equal(save.party[1].heart, 1200);
  assert.equal(sp.offerProblem(save, save.party[1]), null);
  assert.equal(sp.shadowAccepts(save).length, 82, 'every story id but XD-001');
  assert.ok(!sp.shadowAccepts(save).includes(73));
});

test('XD: a trade out marks the record traded away; one in gets an entry with a merged record', t => {
  const dir = folder(t);
  xdCard(dir, { party: [EEVEE, TEDDIURSA], records: { 1: { status: 3, where: 1, heart: 1200, species: 216 }, 2: { status: 2, species: 217, index: 9 } } });
  const out = sp.editCard(dir, 'xd', ctx => sp.takeFrom(ctx, { species: 216, rnd: 0x77, trainer: XD_OT }, { area: 'party', box: 0, slot: 1 }));
  assert.equal(out.record.readInt32BE(0x24), 1200);
  assert.equal(out.entry, null, 'a story Shadow: sent as it is');
  let save = sp.readCard(dir, 'xd');
  assert.deepEqual(save.party.filter(Boolean).map(p => p.nickname), ['EEVEE']);
  assert.deepEqual(save.shadows[1], { status: 3, where: 5, species: 216 });
  // another player's Ursaring (story id 2) arrives, with their record
  const theirs = xdPokemon({ species: 217, rnd: 0x88, trainer: 0x4444, nickname: 'URSARING', shadowId: 2 });
  const record = Buffer.alloc(0x48); record.writeUInt32BE((3 << 29 | 1 << 22 | 4 << 15) >>> 0, 0); record.writeInt32BE(777, 0x24); record[0x40] = 3; record.writeUInt16BE(2, 0x3e);
  const into = sp.editCard(dir, 'xd', ctx => sp.giveTo(ctx, theirs, record));
  assert.deepEqual([into.area, into.slot, into.entry], ['party', 1, 0x54]);
  save = sp.readCard(dir, 'xd');
  assert.deepEqual([save.party[1].nickname, save.party[1].shadowId, save.party[1].shadow, save.party[1].storyId], ['URSARING', 0x54, true, 2]);
  assert.equal(save.party[1].heart, 777, 'their heart gauge');
  assert.deepEqual(save.shadows[2], { status: 2, where: 0, species: 217 }, 'the story id\'s own record untouched');
  const { copies } = sp.cardCopies(dir, 'xd');
  const rec = copies[0].ctx.plain.subarray(xdSave.BODY + SECTIONS.darkPokemon + 0x54 * 0x48);
  assert.equal(rec[0] >> 5, 3, 'snagged');
  assert.equal((rec.readUInt32BE(0) >>> 15) & 7, 1, 'in the party');
  assert.deepEqual([rec.readUInt16BE(0x3e), rec.readUInt16BE(0x1a), rec[0x43]], [0x54, 217, 2]);
  assert.equal(rec[0x40], 3, 'Hyper chance pattern');
  assert.ok(rec.readUInt32BE(0) & (1 << 22), 'Hyper Mode kept');
  assert.equal(copies.length, 2, 'both copies changed and valid');
  // and out again: as story id 2, its record traded away; the entry is clear
  const back = sp.editCard(dir, 'xd', ctx => sp.takeFrom(ctx, save.party[1], save.party[1]));
  assert.deepEqual([back.entry, back.bytes.readUInt16BE(0xba), back.record.readUInt16BE(0x3e), back.record[0x43], (back.record.readUInt32BE(0) >>> 15) & 7], [0x54, 2, 2, 0, 5]);
  const cleared = sp.cardCopies(dir, 'xd').copies[0].ctx.plain.subarray(xdSave.BODY + SECTIONS.darkPokemon + 0x54 * 0x48);
  assert.deepEqual([cleared[0], cleared.readUInt16BE(0x1a), cleared.readUInt16BE(0x3e)], [0, 0x118, 0x54]);
});

test('a cancelled trade\'s own story Shadow goes back as it was, never onto an entry', t => {
  const dir = folder(t);
  xdCard(dir, { party: [EEVEE, TEDDIURSA], records: { 1: { status: 3, where: 1, heart: 1200, species: 216 } } });
  const out = sp.editCard(dir, 'xd', ctx => sp.takeFrom(ctx, { species: 216, rnd: 0x77, trainer: XD_OT }, { area: 'party', box: 0, slot: 1 }));
  sp.editCard(dir, 'xd', ctx => sp.restoreTo(ctx, out.bytes));
  const save = sp.readCard(dir, 'xd');
  assert.deepEqual([save.party[1].shadowId, save.party[1].traded || false, save.party[1].heart], [1, false, 1200]);
  assert.deepEqual(save.shadows[1], { status: 3, where: 1, species: 216 });
});

test('the real saves, when they are here, read and edit back cleanly', t => {
  const fixture = '/mnt/10tbhdd/colosseum-port/xd-port-work/fixtures/story-7';
  if (!fs.existsSync(path.join(fixture, 'PokemonXD.dat'))) return t.skip('no fixture');
  const dir = folder(t);
  fs.copyFileSync(path.join(fixture, 'PokemonXD.dat'), path.join(dir, 'PokemonXD.dat'));
  const before = sp.readCard(dir, 'xd');
  const teddiursa = before.party.find(p => p?.shadow);
  assert.ok(teddiursa);
  const out = sp.editCard(dir, 'xd', ctx => sp.takeFrom(ctx, teddiursa, teddiursa));
  sp.editCard(dir, 'xd', ctx => sp.giveTo(ctx, out.bytes, out.record));
  const after = sp.readCard(dir, 'xd');
  assert.deepEqual(after.party.map(p => p?.key ?? null), before.party.map(p => p?.key ?? null));
  assert.equal(after.party.find(p => p?.shadow).heart, teddiursa.heart);
});

test('the game\'s own saves with 100 traded-in Shadows, when they are here: one more goes to the next free entry', t => {
  const root = '/mnt/10tbhdd/colosseum-port/shadowtrade-work/fixtures';
  for (const [name, game, file] of [['colosseum-100', 'colosseum', 'pokemon_colosseum'], ['xd-100', 'xd', 'PokemonXD']]) {
    if (!fs.existsSync(path.join(root, name, `${file}.dat`))) { t.diagnostic(`no ${name}`); continue; }
    const dir = folder(t);
    for (const each of fs.readdirSync(path.join(root, name))) fs.copyFileSync(path.join(root, name, each), path.join(dir, each));
    const before = sp.cardCopies(dir, game).copies[0].ctx;
    assert.equal(before.sideMissing, false, `${name}: the file beside the save is the save's`);
    const traded = sp.allPokemon(sp.model(before)).filter(p => p.traded);
    assert.ok(traded.length >= 100);
    const last = Math.max(...traded.map(p => p.shadowId));
    // a copy of one of them, as another player would send it: its story id, another personality
    const sample = traded[0], found = sp.findPokemon(before, sample);
    const record = game === 'xd' ? before.plain.subarray(before.sections.darkPokemon + sample.shadowId * 0x48, before.sections.darkPokemon + sample.shadowId * 0x48 + 0x48) : null;
    const out = sp.outgoing(before, found.bytes, record);
    out.bytes.writeUInt32BE(0x0badf00d, game === 'xd' ? 0x28 : 0x04);
    // the one on the highest entry leaves (and frees its entry, and a slot)
    sp.editCard(dir, game, ctx => { const victim = sp.allPokemon(sp.model(ctx)).find(p => p.traded && p.shadowId === last); return victim ? sp.takeFrom(ctx, victim, victim) : null; });
    const done = sp.editCard(dir, game, ctx => sp.giveTo(ctx, out.bytes, out.record));
    assert.equal(done.entry, last, `${name}: the entry just freed is the lowest free one`);
    const after = sp.cardCopies(dir, game).copies[0].ctx;
    assert.equal(after.sideMissing, false);
    assert.equal(sp.allPokemon(sp.model(after)).filter(p => p.traded).length, traded.length, 'one out, one in');
  }
});
