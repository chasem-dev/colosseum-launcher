'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const saves = require('../src/saves');

test('switching build tools preserves custom saves in place and keeps the old build', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sms-save-tool-switch-'));
  const build = path.join(root, 'build');
  const previous = path.join(root, 'build.previous');
  const card = path.join(build, 'card-a');
  try {
    fs.mkdirSync(card, { recursive: true });
    fs.writeFileSync(path.join(build, 'CMakeCache.txt'), 'old compiler');
    fs.writeFileSync(path.join(card, 'pokemon_colosseum.dat'), 'existing progress');
    fs.writeFileSync(path.join(card, 'index.txt'), 'memory card index');
    const backup = saves.moveBuildKeepingSaves(build, previous, card, path.join(root, 'backups'));
    assert.equal(backup.count, 2);
    assert.equal(fs.readFileSync(path.join(card, 'pokemon_colosseum.dat'), 'utf8'), 'existing progress');
    assert.equal(fs.readFileSync(path.join(card, 'index.txt'), 'utf8'), 'memory card index');
    assert.equal(fs.readFileSync(path.join(previous, 'CMakeCache.txt'), 'utf8'), 'old compiler');
    assert.equal(fs.existsSync(path.join(build, 'CMakeCache.txt')), false);
    assert.equal(fs.readFileSync(path.join(previous, 'card-a', 'pokemon_colosseum.dat'), 'utf8'), 'existing progress');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a failed save restore puts the original build and progress back', context => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sms-save-tool-rollback-'));
  const build = path.join(root, 'build');
  const previous = path.join(root, 'build.previous');
  const originalCopy = fs.copyFileSync;
  try {
    fs.mkdirSync(build);
    fs.writeFileSync(path.join(build, 'CMakeCache.txt'), 'old compiler');
    fs.writeFileSync(path.join(build, 'pokemon_colosseum.dat'), 'existing progress');
    context.mock.method(fs, 'copyFileSync', (source, destination, ...args) => {
      if (String(destination).includes('.restore-')) throw new Error('Restore could not write the file');
      return originalCopy(source, destination, ...args);
    });
    assert.throws(() => saves.moveBuildKeepingSaves(build, previous, build, path.join(root, 'backups')), /could not write/);
    assert.equal(fs.readFileSync(path.join(build, 'CMakeCache.txt'), 'utf8'), 'old compiler');
    assert.equal(fs.readFileSync(path.join(build, 'pokemon_colosseum.dat'), 'utf8'), 'existing progress');
    assert.equal(fs.existsSync(previous), false);
  } finally { context.mock.restoreAll(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('the save path is where the game keeps its memory card', () => {
  assert.equal(saves.saveDirectory({ HOME: '/home/player' }, 'linux'), path.resolve('/home/player', '.local', 'share', 'colo-port', 'card-a'));
  assert.equal(saves.saveDirectory({ HOME: '/Users/player' }, 'darwin'), path.resolve('/Users/player', '.local', 'share', 'colo-port', 'card-a'));
  assert.equal(saves.saveDirectory({ HOME: '/home/player', XDG_DATA_HOME: '/data' }, 'linux'), path.resolve('/data', 'colo-port', 'card-a'));
  assert.equal(saves.saveDirectory({ APPDATA: 'C:\\Users\\Player\\AppData\\Roaming' }, 'win32'),
    path.resolve('C:\\Users\\Player\\AppData\\Roaming', 'colo-port', 'card-a'));
});

test('XD has a memory card of its own, beside Colosseum\'s', () => {
  assert.equal(saves.saveDirectory({ HOME: '/home/player' }, 'linux', 'xd'), path.resolve('/home/player', '.local', 'share', 'colo-port', 'xd', 'card-a'));
  assert.equal(saves.saveDirectory({ HOME: '/home/player', XDG_DATA_HOME: '/data' }, 'linux', 'xd'), path.resolve('/data', 'colo-port', 'xd', 'card-a'));
  assert.equal(saves.saveDirectory({ APPDATA: 'C:\\Users\\Player\\AppData\\Roaming' }, 'win32', 'xd'),
    path.resolve('C:\\Users\\Player\\AppData\\Roaming', 'colo-port', 'xd', 'card-a'));
  assert.equal(saves.saveDirectory({ HOME: '/home/player' }, 'linux', 'colosseum'), saves.saveDirectory({ HOME: '/home/player' }, 'linux'));
});

test('an XD save on the shared card moves to XD\'s card, after a backup', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sms-save-xd-move-'));
  const env = { HOME: root, XDG_DATA_HOME: path.join(root, 'data') };
  const shared = saves.saveDirectory(env, 'linux'), own = saves.saveDirectory(env, 'linux', 'xd');
  const backups = path.join(root, 'backups');
  try {
    fs.mkdirSync(shared, { recursive: true });
    fs.writeFileSync(path.join(shared, 'pokemon_colosseum.dat'), 'colosseum progress');
    fs.writeFileSync(path.join(shared, 'PokemonXD.dat'), 'xd progress');
    fs.writeFileSync(path.join(shared, 'PokemonXD.stat'), 'xd stat');
    fs.writeFileSync(path.join(shared, 'pokemon-packs.json'), '{"rows":{}}');
    const moved = saves.moveSharedXdSave(env, 'linux', backups);
    assert.equal(moved.to, own);
    assert.equal(fs.readFileSync(path.join(own, 'PokemonXD.dat'), 'utf8'), 'xd progress');
    assert.equal(fs.readFileSync(path.join(own, 'PokemonXD.stat'), 'utf8'), 'xd stat');
    assert.equal(fs.existsSync(path.join(shared, 'PokemonXD.dat')), false);
    assert.equal(fs.existsSync(path.join(shared, 'PokemonXD.stat')), false);
    // Colosseum's save stays; the Pokémon packs' rows are on both cards
    assert.equal(fs.readFileSync(path.join(shared, 'pokemon_colosseum.dat'), 'utf8'), 'colosseum progress');
    assert.equal(fs.readFileSync(path.join(shared, 'pokemon-packs.json'), 'utf8'), '{"rows":{}}');
    assert.equal(fs.readFileSync(path.join(own, 'pokemon-packs.json'), 'utf8'), '{"rows":{}}');
    const [backup] = saves.listBackups(backups);
    assert.equal(backup.reason, 'before-moving-xd-save');
    assert.equal(backup.source, shared);
    assert.equal(fs.readFileSync(path.join(backups, backup.id, 'files', 'PokemonXD.dat'), 'utf8'), 'xd progress');
    // once moved, nothing more to do
    assert.equal(saves.moveSharedXdSave(env, 'linux', backups), null);
    // a save on XD's own card is never replaced by one left on the shared card
    fs.writeFileSync(path.join(shared, 'PokemonXD.dat'), 'older xd progress');
    assert.equal(saves.moveSharedXdSave(env, 'linux', backups), null);
    assert.equal(fs.readFileSync(path.join(own, 'PokemonXD.dat'), 'utf8'), 'xd progress');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('cleanup refuses a custom memory card inside a removable build folder', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sms-save-clean-'));
  try {
    assert.equal(saves.cleanupWouldRemoveSaves(root, path.join(root, 'build', 'linux-64', 'card-a')), true);
    assert.equal(saves.cleanupWouldRemoveSaves(root, path.join(root, 'build32', 'card-a')), true);
    assert.equal(saves.cleanupWouldRemoveSaves(root, path.join(root, 'rom', 'card-a')), false);
    assert.equal(saves.cleanupWouldRemoveSaves(root, path.join(root, 'builds', 'card-a')), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('verified backup restores old progress and preserves current files first', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sms-save-backup-'));
  const card = path.join(root, 'card-a');
  const backups = path.join(root, 'backups');
  try {
    fs.mkdirSync(card);
    fs.writeFileSync(path.join(card, 'pokemon_colosseum.dat'), Buffer.from('first progress'));
    fs.writeFileSync(path.join(card, 'pokemon_colosseum.stat'), Buffer.from('metadata'));
    fs.writeFileSync(path.join(card, 'disc.iso'), Buffer.from('not a save'));
    const first = saves.backupSaves(card, backups, 'before-play');
    assert.equal(first.count, 2);
    assert.equal(fs.existsSync(path.join(first.directory, 'files', 'disc.iso')), false);
    fs.writeFileSync(path.join(card, 'pokemon_colosseum.dat'), Buffer.from('later progress'));
    const result = saves.restoreBackup(first.id, card, backups);
    assert.equal(fs.readFileSync(path.join(card, 'pokemon_colosseum.dat'), 'utf8'), 'first progress');
    assert.equal(result.restored, 2);
    assert.equal(fs.readFileSync(path.join(result.previous, 'files', 'pokemon_colosseum.dat'), 'utf8'), 'later progress');
    assert.equal(saves.listBackups(backups).length, 2);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('corrupted backup does not replace current progress', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sms-save-corrupt-'));
  const card = path.join(root, 'card-a');
  const backups = path.join(root, 'backups');
  try {
    fs.mkdirSync(card);
    fs.writeFileSync(path.join(card, 'pokemon_colosseum.dat'), 'safe');
    const snapshot = saves.backupSaves(card, backups);
    fs.writeFileSync(path.join(snapshot.directory, 'files', 'pokemon_colosseum.dat'), 'tampered');
    assert.throws(() => saves.restoreBackup(snapshot.id, card, backups), /verification failed/i);
    assert.equal(fs.readFileSync(path.join(card, 'pokemon_colosseum.dat'), 'utf8'), 'safe');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a card folder synced with Syncthing backs up and restores, leaving the sync files where they are', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sms-save-sync-'));
  const card = path.join(root, 'card-a');
  const backups = path.join(root, 'backups');
  try {
    fs.mkdirSync(path.join(card, '.stfolder'), { recursive: true });
    fs.writeFileSync(path.join(card, '.stfolder', 'syncthing-folder-1a2b3c.txt'), 'marker');
    fs.mkdirSync(path.join(card, '.stversions'));
    fs.writeFileSync(path.join(card, '.stversions', 'pokemon_colosseum~20261020-101010.dat'), 'old version');
    fs.writeFileSync(path.join(card, '.stignore'), '// nothing');
    fs.writeFileSync(path.join(card, '.syncthing.pokemon_colosseum.dat.tmp'), 'half synced');
    fs.writeFileSync(path.join(card, '._pokemon_colosseum.dat'), 'AppleDouble');
    fs.writeFileSync(path.join(card, '.DS_Store'), 'finder');
    fs.writeFileSync(path.join(card, 'desktop.ini'), 'explorer');
    fs.writeFileSync(path.join(card, 'pokemon_colosseum.dat'), 'first');
    fs.writeFileSync(path.join(card, 'index.txt'), 'index');

    const first = saves.backupSaves(card, backups);
    assert.equal(first.count, 2, 'only the card files');
    assert.deepEqual(fs.readdirSync(path.join(first.directory, 'files')).sort(), ['index.txt', 'pokemon_colosseum.dat']);

    fs.writeFileSync(path.join(card, 'pokemon_colosseum.dat'), 'second');
    saves.restoreBackup(first.id, card, backups);
    assert.equal(fs.readFileSync(path.join(card, 'pokemon_colosseum.dat'), 'utf8'), 'first');
    assert.equal(fs.readFileSync(path.join(card, '.stfolder', 'syncthing-folder-1a2b3c.txt'), 'utf8'), 'marker');
    assert.equal(fs.readFileSync(path.join(card, '.stversions', 'pokemon_colosseum~20261020-101010.dat'), 'utf8'), 'old version');
    assert.equal(fs.readFileSync(path.join(card, '.stignore'), 'utf8'), '// nothing');

    // other folders are still refused: the card folder may be pointing somewhere it shouldn't
    fs.mkdirSync(path.join(card, 'Documents'));
    assert.throws(() => saves.backupSaves(card, backups), /unexpected folder: Documents/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a backup is written in place, so Windows holding a new file open cannot fail it on a rename', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sms-save-backup-in-place-'));
  const card = path.join(root, 'card-a');
  const backups = path.join(root, 'backups');
  const rename = fs.renameSync;
  try {
    fs.mkdirSync(card);
    fs.writeFileSync(path.join(card, 'pokemon_colosseum.dat'), 'progress');
    fs.renameSync = (from, to) => {
      throw Object.assign(new Error(`EPERM: operation not permitted, rename '${from}' -> '${to}'`), { code: 'EPERM' });
    };
    const backup = saves.backupSaves(card, backups, 'before-update');
    fs.renameSync = rename;
    assert.equal(backup.count, 1);
    assert.deepEqual(fs.readdirSync(backups), [backup.id]);
    // An unfinished one (no manifest yet, or the launcher stopped mid-copy) isn't offered for restoring.
    fs.mkdirSync(path.join(backups, '2026-01-01T00-00-00-000Z-abcdef', 'files'), { recursive: true });
    assert.deepEqual(saves.listBackups(backups).map(entry => entry.id), [backup.id]);
  } finally {
    fs.renameSync = rename;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a failed backup leaves no folder behind', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sms-save-backup-failed-'));
  const card = path.join(root, 'card-a');
  const backups = path.join(root, 'backups');
  const copy = fs.copyFileSync;
  try {
    fs.mkdirSync(card);
    fs.writeFileSync(path.join(card, 'pokemon_colosseum.dat'), 'progress');
    fs.copyFileSync = () => { throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }); };
    assert.throws(() => saves.backupSaves(card, backups), /ENOSPC/);
    fs.copyFileSync = copy;
    assert.deepEqual(fs.readdirSync(backups), []);
  } finally {
    fs.copyFileSync = copy;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
