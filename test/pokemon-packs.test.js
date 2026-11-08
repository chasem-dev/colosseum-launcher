'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const packs = require('../src/pokemon-packs');
const pokedex = require('../src/pokedex');

// What readGameTables reads from a disc, made up: two species, a few moves and abilities.
function tables() {
  const row = (national, cry) => {
    const data = Buffer.alloc(0x11c);
    data.writeUInt16BE(national, 0x12);
    data.writeUInt16BE(cry, 0x0e);
    data[0x30] = 17; data[0x31] = 17;   // Dark
    data.writeUInt16BE(95, 0x84);
    data[0xba] = 1; data.writeUInt16BE(33, 0xbc);   // Tackle at 1
    return data;
  };
  return {
    species: [{ id: 25, national: 25, name: 'Pikachu', row: row(25, 0x100) }, { id: 26, national: 26, name: 'Raichu', row: row(26, 0x101) },
      { id: 197, national: 197, name: 'Umbreon', row: row(197, 0x200) }],
    moves: new Map([['tackle', 33], ['bite', 44], ['shadow ball', 247], ['thunderbolt', 85]]),
    abilities: new Map([['levitate', 26], ['static', 9], ['synchronize', 28]]),
    tmMoves: new Map([[92, 5], [85, 23], [57, 50 + 2]]),   // Toxic is TM06, Thunderbolt TM24, Surf HM03
    types: pokedex.TYPES.map(type => type.toLowerCase()),
    headers: { body: Buffer.alloc(0x80, 1), face: Buffer.alloc(0x80, 2) }
  };
}

const noTarget = () => { throw new Error('no evolutions here'); };

test('a Pokémon starts as its base and changes what its pokemon.json says', () => {
  const game = tables();
  const built = packs.buildRow({ base: 'umbreon', name: 'Moonfang', types: ['Dark', 'Ghost'], abilities: ['Levitate'],
    stats: { hp: 99, speed: 144 }, moves: [[5, 'Bite'], [1, 'Shadow Ball']], tms: ['TM06', 'HM05'], gender: 12.5,
    height: 1, weight: 27, catchRate: 30, growthRate: 'slow', cry: 'Pikachu' }, game, noTarget);
  const row = built.row;
  assert.equal(built.name, 'MOONFANG');
  assert.equal(built.base.id, 197);
  assert.deepEqual([row[0x30], row[0x31], row[0x32], row[0x33]], [17, 7, 26, 0]);
  assert.equal(row.readUInt16BE(0x84), 99, 'HP');
  assert.equal(row.readUInt16BE(0x86), 0, 'attack stays the base\'s');
  assert.equal(row.readUInt16BE(0x8e), 144, 'speed');
  assert.deepEqual([row[0xba], row.readUInt16BE(0xbc), row[0xbe], row.readUInt16BE(0xc0), row[0xc2]], [1, 247, 5, 44, 0], 'moves, by level');
  assert.equal(row[0x34 + 5], 1, 'TM06');
  assert.equal(row[0x34 + 50 + 4], 1, 'HM05');
  assert.equal(row[0x02], 31, '12.5 in 100 female is the game\'s 31');
  assert.equal(row.readUInt16BE(0x0a), 303, '1 m is 3\'03"');
  assert.equal(row.readUInt16BE(0x0c), 595, '27 kg is 59.5 lbs');
  assert.deepEqual([row[0x01], row[0x00]], [30, 5]);
  assert.equal(row.readUInt16BE(0x0e), 0x100, 'Pikachu\'s cry');
  assert.equal(game.species[2].row.readUInt16BE(0x84), 95, 'the base\'s own row is left as it was');
});

test('moves and abilities can be given by number, and TM moves by the moves they teach', () => {
  const game = tables();
  const { row } = packs.buildRow({ base: 'Umbreon', name: 'X', abilities: [26], moves: [[1, 33], [7, 'Bite']],
    tmMoves: [92, 'Thunderbolt', 57, 437, 'Hyper Beam'] }, game, noTarget);
  assert.equal(row[0x32], 26);
  assert.deepEqual([row.readUInt16BE(0xbc), row.readUInt16BE(0xc0)], [33, 44]);
  assert.deepEqual([...row.subarray(0x34, 0x34 + 58)].flatMap((on, i) => on ? [i] : []), [5, 23, 52],
    'Toxic, Thunderbolt and Surf: the moves no TM of this game teaches are let go');
  assert.throws(() => packs.buildRow({ base: 'Umbreon', name: 'X', moves: [[1, 437]] }, game, noTarget), /move 437 isn't one the game has/);
  assert.throws(() => packs.buildRow({ base: 'Umbreon', name: 'X', abilities: [123] }, game, noTarget), /ability 123 isn't one/);
});

test('a form keeps its base\'s name and can be named by its form', () => {
  const built = packs.buildRow({ base: 25, form: 'Storm' }, tables(), noTarget);
  assert.equal(built.name, 'PIKACHU');
  assert.equal(built.form, 'Storm');
});

test('what a pokemon.json gets wrong is said plainly', () => {
  const game = tables();
  const wrong = (spec, pattern) => assert.throws(() => packs.buildRow(spec, game, noTarget), pattern);
  wrong({ name: 'X' }, /"base" is missing/);
  wrong({ base: 'Mewthree', name: 'X' }, /base "Mewthree" isn't a Pokémon/);
  wrong({ base: 'Umbreon' }, /"name" is missing/);
  wrong({ base: 'Umbreon', name: 'Elevenletter' }, /1 to 10 letters/);
  wrong({ base: 'Umbreon', name: 'Moon<b>' }, /letters, numbers/);
  wrong({ base: 'Umbreon', name: 'X', types: ['Sound'] }, /type "Sound"/);
  wrong({ base: 'Umbreon', name: 'X', types: ['???'] }, /type "\?\?\?"/);
  wrong({ base: 'Umbreon', name: 'X', stats: { hp: 0 } }, /stats.hp must be a whole number from 1 to 255/);
  wrong({ base: 'Umbreon', name: 'X', stats: { power: 9 } }, /"stats" has "power"/);
  wrong({ base: 'Umbreon', name: 'X', moves: [[1, 'Hyper Beam']] }, /move "Hyper Beam" isn't one the game has/);
  wrong({ base: 'Umbreon', name: 'X', moves: Array(21).fill([1, 'Bite']) }, /1 to 20/);
  wrong({ base: 'Umbreon', name: 'X', tms: ['TM51'] }, /"TM51" isn't a TM/);
  wrong({ base: 'Umbreon', name: 'X', evolutions: [{ into: 'Raichu' }] }, /one of "level", "item", "friendship" or "trade"/);
  wrong({ base: 'Umbreon', name: 'X', evolutions: [{ into: 'Raichu', item: 'Rare Candy' }] }, /isn't an evolution item/);
  wrong({ base: 'Umbreon', name: 'X', gender: 'sometimes' }, /"gender"/);
});

test('evolutions name the game\'s Pokémon or a pack\'s, by what the method needs', () => {
  const game = tables();
  const target = value => value === 'sparkmouse' ? 253 : game.species.find(each => each.name === value).id;
  const { row } = packs.buildRow({ base: 'Umbreon', name: 'X', evolutions: [{ into: 'sparkmouse', level: 30 }, { into: 'Raichu', item: 'Thunder Stone' },
    { into: 'Raichu', friendship: 'night' }, { into: 'Raichu', trade: 'Metal Coat' }] }, game, target);
  const evolution = i => [row[0x9c + i * 6], row.readUInt16BE(0x9e + i * 6), row.readUInt16BE(0xa0 + i * 6)];
  assert.deepEqual(evolution(0), [4, 30, 253]);
  assert.deepEqual(evolution(1), [7, 96, 26]);
  assert.deepEqual(evolution(2), [3, 0, 26]);
  assert.deepEqual(evolution(3), [6, 199, 26]);
  assert.deepEqual(evolution(4), [0, 0, 0]);
});

test('a Pokémon keeps its row, and new ones take the first that none has had', () => {
  const first = packs.assignIds(['a/one', 'a/two'], { ids: {} });
  assert.deepEqual([...first.ids], [['a/one', 252], ['a/two', 253]]);
  assert.equal(first.changed, true);
  // a/one's pack is gone: its row stays its own, for the saves that hold it
  const second = packs.assignIds(['a/two', 'b/three'], first.registry);
  assert.deepEqual([...second.ids], [['a/two', 253], ['b/three', 254]]);
  assert.equal(second.registry.ids['a/one'], 252);
  const again = packs.assignIds(['a/two', 'b/three'], second.registry);
  assert.equal(again.changed, false);
  const many = packs.assignIds(Array.from({ length: 27 }, (_, i) => `p/${i}`), { ids: {} });
  assert.deepEqual(many.full, ['p/25', 'p/26']);
});

test('the rows are kept beside the saves, and a damaged file is reported', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'packs-registry-'));
  try {
    assert.deepEqual(packs.readRegistry(dir), { ids: {} });
    packs.writeRegistry(dir, { ids: { 'a/one': 252, 'a/bad': 999 } });
    assert.deepEqual(packs.readRegistry(dir), { ids: { 'a/one': 252 } }, 'a row the game hasn\'t room for is dropped');
    fs.writeFileSync(path.join(dir, packs.REGISTRY_FILE), '{');
    assert.throws(() => packs.readRegistry(dir), /can't be read/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('PNGs of every common kind are read, and resized to the game\'s size', () => {
  const rgba = Buffer.from([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0, 255, 255, 255, 255]);
  const image = packs.decodePng(pokedex.png(2, 2, rgba));
  assert.deepEqual([image.width, image.height], [2, 2]);
  assert.deepEqual(image.rgba, rgba);
  const small = packs.resize(image, 1, 1);
  assert.equal(small.rgba[3], Math.round((255 + 128 + 0 + 255) / 4));
  assert.throws(() => packs.decodePng(Buffer.from('not a png')), /isn't a PNG/);
});

test('a sprite is the disc\'s header and an RGBA8 image; a face holds the shiny one below', () => {
  const game = tables();
  const png = pokedex.png(4, 4, Buffer.alloc(64, 200));
  const body = packs.spriteFile('body', game.headers.body, png);
  assert.equal(body.length, 0x80 + 64 * 64 * 4);
  assert.deepEqual(body.subarray(0, 0x80), game.headers.body);
  const face = packs.spriteFile('face', game.headers.face, png, pokedex.png(1, 1, Buffer.from([1, 2, 3, 4])));
  assert.equal(face.length, 0x80 + 44 * 84 * 4, '42x84, in 4x4 tiles');
  // The first tile is the normal face's top left: alpha, red; then green, blue
  assert.deepEqual([...face.subarray(0x80, 0x82)], [200, 200]);
  const encoded = packs.encodeRgba8({ width: 4, height: 4, rgba: Buffer.from(Array.from({ length: 64 }, (_, i) => i)) });
  assert.deepEqual([...encoded.subarray(0, 4)], [3, 0, 7, 4]);
  assert.deepEqual([...encoded.subarray(32, 36)], [1, 2, 5, 6]);
});

function writePack(root, pack, entries, about) {
  fs.mkdirSync(path.join(root, pack), { recursive: true });
  if (about) fs.writeFileSync(path.join(root, pack, 'pack.json'), about);
  for (const [folder, spec, files = {}] of entries) {
    fs.mkdirSync(path.join(root, pack, folder), { recursive: true });
    fs.writeFileSync(path.join(root, pack, folder, 'pokemon.json'), typeof spec === 'string' ? spec : JSON.stringify(spec));
    for (const [name, data] of Object.entries(files)) fs.writeFileSync(path.join(root, pack, folder, name), data);
  }
}

test('packs are read from their folders; what is wrong is left out and said', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'packs-'));
  try {
    const png = pokedex.png(2, 2, Buffer.alloc(16, 90)), model = Buffer.alloc(0x400, 7);
    writePack(root, 'moon', [
      ['moonfang', { base: 'Umbreon', name: 'Moonfang', evolutions: [{ into: 'eclipse', level: 40 }, { into: 'broken', level: 50 }] }, { 'model.pkx': model, 'body.png': png, 'face.png': png }],
      ['eclipse', { base: 'Umbreon', name: 'Eclipse' }],
      ['broken', '{ not json'],
      ['shinyonly', { base: 'Umbreon', name: 'Shiny' }, { 'model-shiny.pkx': model }]
    ], JSON.stringify({ name: 'Moon Pack', author: 'Someone' }));
    writePack(root, 'empty', []);
    fs.mkdirSync(path.join(root, '..bad'), { recursive: true });
    const loaded = packs.loadPacks(root, tables(), { ids: { 'gone/old': 252 } });
    assert.deepEqual(loaded.pokemon.map(each => [each.key, each.id, each.name]), [['moon/eclipse', 254, 'ECLIPSE'], ['moon/moonfang', 255, 'MOONFANG']]);
    const moonfang = loaded.pokemon[1];
    assert.equal(moonfang.packName, 'Moon Pack');
    assert.deepEqual(moonfang.assets.model, model);
    assert.ok(moonfang.assets.body && moonfang.assets.face && !moonfang.assets.modelShiny);
    assert.deepEqual([moonfang.row[0x9c], moonfang.row.readUInt16BE(0xa0)], [4, 254], 'evolves into Eclipse');
    assert.equal(moonfang.row[0x9c + 6], 0, 'the evolution into a Pokémon that was left out is gone');
    const problems = loaded.problems.map(problem => `${problem.pack}/${problem.entry || ''}: ${problem.message}`);
    assert.ok(problems.some(text => text.startsWith('moon/broken: pokemon.json isn\'t valid JSON')), problems.join('\n'));
    assert.ok(problems.some(text => text.startsWith('moon/shinyonly: model-shiny.pkx needs a model.pkx')), problems.join('\n'));
    assert.ok(problems.some(text => text.startsWith('moon/moonfang: evolves into a Pokémon that couldn\'t be loaded')), problems.join('\n'));
    assert.ok(problems.some(text => text.startsWith('empty/: has no Pokémon')), problems.join('\n'));
    assert.deepEqual(loaded.missing, ['gone/old']);
    assert.equal(loaded.registry.ids['moon/broken'], 253, 'a Pokémon with a problem keeps its row for when it\'s fixed');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the game\'s file holds each Pokémon\'s row, name and files in order', () => {
  const game = tables();
  const built = packs.buildRow({ base: 'Umbreon', name: 'Moonfang' }, game, noTarget);
  const file = packs.compile([{ id: 253, ...built, assets: { model: Buffer.from([1, 2, 3]), face: Buffer.from([9, 9, 9, 9]) } }]);
  assert.equal(file.toString('latin1', 0, 4), 'CPKM');
  assert.deepEqual([file.readUInt32BE(4), file.readUInt32BE(8)], [1, 1]);
  let at = 16;
  assert.deepEqual([file.readUInt16BE(at), file.readUInt16BE(at + 2), file.readUInt16BE(at + 4)], [253, 197, 8]);
  at += 8;
  assert.deepEqual(file.subarray(at, at + 0x11c), built.row);
  at += 0x11c;
  assert.equal(file.toString('utf16le', at, at + 16).length, 8);
  assert.equal(file.readUInt16BE(at), 'M'.charCodeAt(0));
  at += 16;
  const sizes = [];
  for (let i = 0; i < 6; i++) { const size = file.readUInt32BE(at); sizes.push(size); at += 4 + Math.ceil(size / 4) * 4; }
  assert.deepEqual(sizes, [3, 0, 0, 0, 4, 0]);
  assert.equal(at, file.length);
});

test('the Pokédex shows a pack Pokémon as it shows the game\'s, with where it is from', () => {
  const game = tables();
  const built = packs.buildRow({ base: 'Pikachu', form: 'Storm', abilities: ['Static'], evolutions: [{ into: 'Raichu', level: 30 }], description: 'Crackles.' }, game,
    value => game.species.find(each => each.name === value).id);
  const [entry] = packs.pokedexEntries([{ id: 252, key: 'p/storm', pack: 'p', folder: 'storm', packName: 'Weather', author: 'Me', credits: 'Them, for the model.', ...built, assets: {} }], game);
  assert.equal(entry.name, 'Pikachu (Storm)');
  assert.equal(entry.national, 25);
  assert.deepEqual(entry.abilities, ['Static']);
  assert.deepEqual(entry.evolutions, [26]);
  assert.equal(entry.status.kind, 'pack');
  assert.match(entry.status.note, /^Weather, by Me\. Based on Pikachu\. Crackles\. Credits: Them, for the model\.$/);
});
