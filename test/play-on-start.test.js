'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const realPort = require('../src/port');

// main.js with the game's state chosen by the test, as `--play` finds it.
function launcher(t, { portReady = true, binary = true, rom = true, current = true, hd = true, autoUpdate = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'colosseum play-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filename = path.resolve(__dirname, '../src/main.js');
  const localRequire = createRequire(filename);
  const executable = path.join(root, 'colosseum');
  if (binary) fs.writeFileSync(executable, 'game');
  const electron = { ipcMain: { handle() {} }, app: { requestSingleInstanceLock: () => true, commandLine: { appendSwitch() {} }, on() {},
    whenReady: () => ({ then() {} }), getPath: () => root, getVersion: () => '0.1.3', isPackaged: false },
  BrowserWindow: class {}, dialog: {}, shell: {}, clipboard: {}, net: {}, screen: {},
  protocol: { registerSchemesAsPrivileged() {}, handle() {} } };
  const port = { ...realPort, isPort: () => portReady, binaryPath: () => executable, hdVisualsInstalled: () => hd,
    validateRom() { if (!rom) throw new Error('Choose your disc image.'); return 'disc.iso'; } };
  const context = { require: id => id === 'electron' ? electron : id === './port' ? port
    : id === './game-version' ? { ...localRequire(id), isCurrent: () => current, recoverBuild: () => false } : localRequire(id),
  __dirname: path.dirname(filename), process, setTimeout, setInterval, module: { exports: {} } };
  vm.runInNewContext(`${fs.readFileSync(filename, 'utf8')}
    module.exports = { loadConfig, directPlayBlocker, playDirectly, chooseStartGame, activityLog, config: () => config,
      failure: () => directPlayFailure, setPlay: replacement => { play = replacement; } };`, context, { filename });
  const main = context.module.exports;
  main.loadConfig();
  main.config().settings.autoUpdate = autoUpdate;
  return main;
}

test('--play starts a game that is ready', t => {
  assert.equal(launcher(t).directPlayBlocker(), null);
});

test('--play opens the launcher while the game needs setup, a disc, an update or its HD visuals', t => {
  assert.equal(launcher(t, { portReady: false }).directPlayBlocker(), 'the game is not set up yet.');
  assert.equal(launcher(t, { binary: false }).directPlayBlocker(), 'the game is not set up yet.');
  assert.equal(launcher(t, { rom: false }).directPlayBlocker(), 'Choose your disc image.');
  assert.equal(launcher(t, { current: false }).directPlayBlocker(), 'a game update is ready.');
  assert.equal(launcher(t, { hd: false }).directPlayBlocker(), 'HD visuals need to be set up.');
});

test('with automatic updates off, --play starts the game that is there', t => {
  assert.equal(launcher(t, { current: false, autoUpdate: false }).directPlayBlocker(), null);
});

test('--play never builds: blocked, it says why and hands over to the launcher', async t => {
  const main = launcher(t, { current: false });
  let played = false;
  main.setPlay(async () => { played = true; });
  assert.equal(await main.playDirectly(), false);
  assert.equal(played, false);
  assert.ok(main.activityLog.snapshot().some(entry => entry.text.includes('Opened the launcher instead of the game: a game update is ready.')));
});

test('a game --play started and that closed cleanly quits the launcher', async t => {
  const main = launcher(t);
  main.setPlay(async () => ({ ok: true }));
  assert.equal(await main.playDirectly(), true);
});

test('a game --play started that fails opens the launcher, which says why', async t => {
  const main = launcher(t);
  main.setPlay(async () => { throw new Error('The game crashed.'); });
  assert.equal(await main.playDirectly(), false);
  assert.equal(main.failure(), 'The game crashed.');
});

test("a Steam shortcut's game is chosen before it plays: --play=xd or --game=xd is XD, a bare --play Colosseum", t => {
  const steam = require('../src/steam');
  assert.deepEqual(steam.startOptions(['--no-sandbox', '--play']), { play: true, game: 'colosseum' });
  assert.deepEqual(steam.startOptions(['--play=xd']), { play: true, game: 'xd' });
  assert.deepEqual(steam.startOptions(['--game=xd', '--play']), { play: true, game: 'xd' });
  assert.deepEqual(steam.startOptions(['--game=xd']), { play: false, game: 'xd' });
  assert.deepEqual(steam.startOptions(['--no-sandbox']), { play: false, game: null });
  const main = launcher(t);
  assert.equal(main.config().game, 'colosseum');
  main.chooseStartGame(steam.startOptions(['--play=xd']));
  assert.equal(main.config().game, 'xd');
  // a bare --play, as every shortcut from before XD has, goes back to Colosseum
  main.chooseStartGame(steam.startOptions(['--play']));
  assert.equal(main.config().game, 'colosseum');
  // without --play or --game the launcher opens on the game chosen last
  main.chooseStartGame(steam.startOptions(['--play=xd']));
  main.chooseStartGame(steam.startOptions([]));
  assert.equal(main.config().game, 'xd');
  // a game the launcher doesn't have leaves the choice alone, and says so
  main.chooseStartGame(steam.startOptions(['--game=emerald']));
  assert.equal(main.config().game, 'xd');
  assert.ok(main.activityLog.snapshot().some(entry => entry.text.includes('the launcher has no game "emerald"')));
});
