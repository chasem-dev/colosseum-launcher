'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const gba = require('../src/gba');
const gen3 = require('../src/gen3-save');
const port = require('../src/port');
const portable = require('../src/portable');

// A file shaped like a GBA BIOS: 16 KB, opening with seven ARM branches (the exception vectors).
function biosBytes() {
  const data = Buffer.alloc(gba.BIOS_SIZE, 0x11);
  for (let i = 0; i < 7; i++) data.writeUInt32LE((0xEA000000 | (i + 4)) >>> 0, i * 4);
  return data;
}
// A Game Pak's header: its title, game code and the fixed 0x96.
function gamePak(code, title = 'POKEMON TEST') {
  const data = Buffer.alloc(0x200);
  data.write(title, 0xA0, 'latin1');
  data.write(code, 0xAC, 'latin1');
  data[0xB2] = 0x96;
  return data;
}
function folder() { return fs.mkdtempSync(path.join(os.tmpdir(), 'colo-gba-')); }

test('a GBA BIOS is 16 KB and opens with its exception vectors', t => {
  const dir = folder();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'bios.bin'), biosBytes());
  const check = gba.checkBios(path.join(dir, 'bios.bin'));
  assert.equal(check.error, undefined);
  assert.match(check.warning, /isn't the BIOS dump we know/);
  fs.writeFileSync(path.join(dir, 'short.bin'), biosBytes().subarray(0, 8192));
  assert.match(gba.checkBios(path.join(dir, 'short.bin')).error, /16 KB/);
  const notBios = biosBytes();
  notBios[3] = 0;
  fs.writeFileSync(path.join(dir, 'game.bin'), notBios);
  assert.match(gba.checkBios(path.join(dir, 'game.bin')).error, /isn't a GBA BIOS/);
  assert.match(gba.checkBios(path.join(dir, 'missing.bin')).error, /Can't read/);
});

test('a Game Pak says which game it is, and whether it links with this Colosseum', t => {
  const dir = folder();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (name, data) => { fs.writeFileSync(path.join(dir, name), data); return path.join(dir, name); };
  const emerald = gba.checkGamePak(write('emerald.gba', gamePak('BPEE', 'POKEMON EMER')));
  assert.deepEqual([emerald.name, emerald.code, emerald.warning], ['Pokémon Emerald (English)', 'BPEE', undefined]);
  assert.match(gba.checkGamePak(write('rubyde.gba', gamePak('AXVD'))).warning, /English/);
  assert.match(gba.checkGamePak(write('other.gba', gamePak('AGBE', 'SOME GAME'))).warning, /isn't a Pokémon game/);
  assert.equal(gba.checkGamePak(write('reader.gba', gamePak('PSAE', 'CARDE READER'))).ereader, true);
  const broken = gamePak('BPEE');
  broken[0xB2] = 0;
  assert.match(gba.checkGamePak(write('broken.gba', broken)).error, /isn't a GBA game/);
  assert.equal(gba.defaultSave(path.join(dir, 'emerald.gba')), path.join(dir, 'emerald.sav'));
});

// A Gen 3 save: slot 0 written `counter` times, with the trainer, a party of `party` species, and the
// two things Colosseum checks (saved in a Pokémon Center, link flags).
const SIZES = [3884, 3968, 3968, 3968, 3848, 3968, 3968, 3968, 3968, 3968, 3968, 3968, 3968, 2000];
function gen3Bytes({ game = 'e', name = [0xBB, 0xCD, 0xC2], party = [304], center = true, linked = true, counter = 5, size = gen3.SAVE_SIZE } = {}) {
  const data = Buffer.alloc(size, 0);
  const sections = SIZES.map(() => Buffer.alloc(0x1000));
  const sb2 = sections[0], sb1 = Buffer.alloc(0xF80 * 4);
  Buffer.from([...name, 0xFF]).copy(sb2, 0);
  sb2[0x09] = center ? 0x02 : 0;
  sb2.writeUInt32LE(0x1234ABCD, 0x0A);
  sb2.writeUInt16LE(12, 0x0E); sb2[0x10] = 34;
  sb2.writeUInt32LE(game === 'rs' ? 0 : game === 'frlg' ? 1 : 0x5EED, 0xAC);
  if (game !== 'rs') sb2.writeUInt32LE(linked ? 0x803F : 0, 0xA8);
  else if (linked) sb1[0x1220 + (0x801 >> 3)] |= 1 << (0x801 & 7);   // the Pokédex
  const [countAt, partyAt] = game === 'frlg' ? [0x34, 0x38] : [0x234, 0x238];
  sb1[countAt] = party.length;
  party.forEach((species, i) => {
    const mon = sb1.subarray(partyAt + i * 100, partyAt + (i + 1) * 100);
    mon.writeUInt32LE(0, 0);                 // personality 0: growth comes first
    mon.writeUInt32LE(0x1234ABCD, 4);
    mon[0x12] = 2;                           // English
    mon.writeUInt32LE((species ^ 0x1234ABCD) >>> 0, 0x20);
    mon[0x54] = 50;
  });
  for (let id = 1; id <= 4; id++) sb1.copy(sections[id], 0, (id - 1) * 0xF80, id * 0xF80);
  sections.forEach((section, id) => {
    let sum = 0;
    for (let i = 0; i < SIZES[id]; i += 4) sum = (sum + section.readUInt32LE(i)) >>> 0;
    section.writeUInt16LE(id, 0xFF4);
    section.writeUInt16LE(((sum >>> 16) + sum) & 0xFFFF, 0xFF6);
    section.writeUInt32LE(0x08012025, 0xFF8);
    section.writeUInt32LE(counter, 0xFFC);
    section.copy(data, ((id + 3) % 14) * 0x1000);   // sections rotate around the slot as the game saves
  });
  return data;
}

test('a Gen 3 save says whose it is, what game, and whether Colosseum links with it', t => {
  const dir = folder();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const info = gen3.parse(gen3Bytes({ party: [304, 284] }));
  assert.deepEqual([info.game, info.gameName, info.trainer, info.playTime, info.saves], ['e', 'Emerald', 'ASH', '12:34', 5]);
  assert.deepEqual(info.party.map(mon => [mon.species, mon.level]), [[304, 50], [284, 50]]);
  assert.equal(gen3.linkProblem(info), '');
  // emulators add a few bytes of clock after the save
  assert.equal(gen3.parse(gen3Bytes({ size: gen3.SAVE_SIZE + 16 })).trainer, 'ASH');
  assert.equal(gen3.parse(gen3Bytes({ game: 'frlg', party: [6] })).party[0].species, 6);
  assert.match(gen3.linkProblem(gen3.parse(gen3Bytes({ center: false }))), /Pokémon Center/);
  assert.match(gen3.linkProblem(gen3.parse(gen3Bytes({ linked: false }))), /once you have the Pokédex/);
  assert.match(gen3.linkProblem(gen3.parse(gen3Bytes({ game: 'frlg', linked: false }))), /National Pokédex/);
  assert.match(gen3.linkProblem(gen3.parse(gen3Bytes({ game: 'rs', linked: false }))), /once you have the Pokédex/);
  assert.equal(gen3.linkProblem(gen3.parse(gen3Bytes({ game: 'rs' }))), '');
  const damaged = gen3Bytes();
  damaged[0x3000 + 5] ^= 1;
  assert.throws(() => gen3.parse(damaged), /damaged/);
  assert.throws(() => gen3.parse(Buffer.alloc(0x8000)), /too small/);
  fs.mkdirSync(path.join(dir, 'retroarch', 'saves', 'mGBA'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'retroarch', 'saves', 'mGBA', 'Pokemon Emerald.srm'), gen3Bytes());
  fs.writeFileSync(path.join(dir, 'retroarch', 'saves', 'other.sav'), Buffer.alloc(gen3.SAVE_SIZE));
  fs.writeFileSync(path.join(dir, 'retroarch', 'notes.txt'), 'hi');
  const found = gen3.findSaves([path.join(dir, 'retroarch')]);
  assert.deepEqual(found.map(item => path.basename(item.path)), ['Pokemon Emerald.srm']);
  assert.ok(gen3.searchFolders('win32', { APPDATA: 'C:\\Users\\a\\AppData\\Roaming' }, 'C:\\Users\\a').some(folder => /RetroArch/.test(folder)));
});

test('the game gets a GBA for each usable save, and the Game Pak and BIOS only if chosen', t => {
  const dir = folder();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bios = path.join(dir, 'bios.bin'), rom = path.join(dir, 'Pokemon Emerald.gba'), save = path.join(dir, 'my.sav');
  fs.writeFileSync(bios, biosBytes());
  fs.writeFileSync(rom, gamePak('BPEE'));
  fs.writeFileSync(save, gen3Bytes());
  const settings = port.normalizeSettings({}, 'linux');
  assert.equal(settings.gbaAutoPower, true);
  assert.equal(settings.gbaVolume, 100);
  assert.deepEqual(gba.environment({ bios, sockets: {} }, settings), {});
  assert.deepEqual(gba.environment({ bios: '', sockets: { 2: { save: path.join(dir, 'gone.sav') } } }, settings), {});
  assert.deepEqual(gba.environment({ bios: '', sockets: { 2: { save } } }, settings, '/backups'), {
    COLO_GBA2_SAVE: save, COLO_GBA_POWER: 'auto', COLO_GBA_VOLUME: '100', COLO_GBA_BACKUPS: '/backups'
  });
  const manual = port.normalizeSettings({ gbaAutoPower: false, gbaVolume: 35 }, 'linux');
  const env = gba.environment({ bios, sockets: { 3: { rom, save } } }, manual);
  assert.deepEqual([env.COLO_GBA3, env.COLO_GBA3_SAVE, env.COLO_GBA_BIOS, env.COLO_GBA_POWER, env.COLO_GBA_VOLUME], [rom, save, bios, 'manual', '35']);
  const status = gba.status({ bios: '', sockets: { 2: { save } } });
  assert.equal(status.ready, true);
  assert.equal(status.bios, null);
  assert.equal(status.sockets[2].save.trainer, 'ASH');
  assert.equal(status.sockets[2].rom, null);
  assert.match(gba.status({ sockets: { 2: { save: path.join(dir, 'gone.sav') } } }).sockets[2].save.error, /isn't there any more/);
  assert.equal(gba.status({ sockets: { 2: { save: path.join(dir, 'gone.sav') } } }).ready, false);
});

test('with the GB-Link switch on, socket 2 is the player\'s own GBA, and the other sockets keep their saves', t => {
  const dir = folder();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const save = path.join(dir, 'my.sav'), other = path.join(dir, 'other.sav');
  fs.writeFileSync(save, gen3Bytes());
  fs.writeFileSync(other, gen3Bytes());
  assert.equal(port.normalizeSettings({}, 'linux').gbaGbLink, false);
  const settings = port.normalizeSettings({ gbaGbLink: true }, 'linux');
  assert.equal(settings.gbaGbLink, true);
  assert.deepEqual(gba.environment({ bios: '', sockets: {} }, settings), { COLO_GBA2_GBLINK: 'auto', COLO_GBA_POWER: 'auto', COLO_GBA_VOLUME: '100' });
  const env = gba.environment({ bios: '', sockets: { 2: { save }, 3: { save: other } } }, settings);
  assert.equal(env.COLO_GBA2_GBLINK, 'auto');
  assert.equal(env.COLO_GBA2_SAVE, undefined);
  assert.equal(env.COLO_GBA3_SAVE, other);
  assert.equal(port.normalizeSettings({ gbaGbLink: 'yes' }, 'linux').gbaGbLink, false);
});

test('saved GBA settings keep sockets 2 to 4 with a save, and older ones get the save beside their Game Pak', () => {
  assert.deepEqual(gba.normalize({ bios: '/b.bin', sockets: { 1: { save: '/a.sav' }, 2: { rom: '/r.gba', save: 3 }, 3: { save: '/s.sav' }, 5: { save: '/x.sav' }, 4: { rom: '' } } }),
    { bios: '/b.bin', sockets: { 2: { save: path.join('/', 'r.sav'), rom: '/r.gba' }, 3: { save: '/s.sav', rom: '' } } });
  assert.deepEqual(gba.normalize(null), { bios: '', sockets: {} });
});

test('a portable launcher keeps its GBA files relative to its folder', () => {
  const base = path.resolve('/usb/games/Colosseum-Launcher-Portable');
  const inside = path.join(base, 'gba', 'bios.bin'), rom = path.join(base, 'gba', 'emerald.gba'), outside = path.resolve('/elsewhere/save.sav');
  const stored = portable.storedPaths({ gba: { bios: inside, sockets: { 2: { rom, save: outside } } } }, base);
  assert.deepEqual(stored.gba, { bios: path.join('gba', 'bios.bin'), sockets: { 2: { rom: path.join('gba', 'emerald.gba'), save: outside } } });
  const moved = path.resolve('/media/stick/Colosseum-Launcher-Portable');
  assert.equal(portable.resolvedPaths(stored, moved).gba.bios, path.join(moved, 'gba', 'bios.bin'));
});
