'use strict';

// Pokémon XD beside Colosseum: the game registry, XD's pin, disc, build and run, and each game's own preferences.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');
const games = require('../src/games');
const port = require('../src/port');
const game = require('../src/game-version');
const gameSource = require('../src/game-source');
const portable = require('../src/portable');
const { gcm } = require('./disc-fixture');
const { TOOL_FIXTURE } = require('./tool-fixture');

TOOL_FIXTURE();
const xdRelease = require('../src/xd-release.json');

function temporary(t, prefix = 'colo xd-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const disc = (root, bytes, name = 'game.iso') => { const file = path.join(root, name); fs.writeFileSync(file, bytes); return file; };
const xd = (id = 'GXXE01', revision = 0) => gcm(id, revision, 'Pokemon XD');

test('the registry has Colosseum, the default, with every feature, and XD with online battles, fast-forward and movie skipping', () => {
  assert.deepEqual(games.ids(), ['colosseum', 'xd']);
  assert.equal(games.get().id, 'colosseum');
  assert.equal(games.get('nonsense').id, 'colosseum');
  assert.equal(games.get('colosseum').release, game.release, 'Colosseum builds the pin it always has');
  assert.deepEqual(games.FEATURES.filter(feature => games.supports('colosseum', feature)), games.FEATURES);
  assert.deepEqual(games.FEATURES.filter(feature => games.supports('xd', feature)), ['online', 'widescreen', 'hdText', 'discordPresence', 'fastForward', 'skipMovies', 'teamBuilder', 'gciSaves']);
  const { name, discId, executable, decompFolder, buildEnv, needsMainDol } = games.get('xd');
  assert.deepEqual({ name, discId, executable, decompFolder, buildEnv, needsMainDol },
    { name: 'Pokémon XD: Gale of Darkness', discId: 'GXXE01', executable: 'xd', decompFolder: 'pkmn-xd', buildEnv: { COLO_GAME: 'xd' }, needsMainDol: false });
  assert.deepEqual(games.get('colosseum').buildEnv, {});
  assert.equal(games.ofSource(game.release).id, 'colosseum');
  assert.equal(games.ofSource(xdRelease).id, 'xd');
  assert.equal(games.identifyDisc('GXXP01').game.id, 'xd');
  assert.equal(games.identifyDisc('GXXP01').region, 'European');
  assert.equal(games.identifyDisc('GC6E01').region, null);
  assert.equal(games.identifyDisc('GMSE01'), null);
  const summary = games.summary('xd');
  assert.equal(summary.id, 'xd');
  assert.equal(summary.features.online, true);
  assert.equal(summary.features.pokedex, false);
  assert.equal(summary.features.fastForward, true);
  assert.deepEqual(summary.list.map(each => each.id), ['colosseum', 'xd']);
});

test("XD's pin is the port's XD branch and the XD decomp, each at a whole commit, with no launcher patch", () => {
  assert.equal(xdRelease.game, 'xd');
  assert.equal(xdRelease.repository, game.release.repository, 'one port builds both games');
  assert.equal(xdRelease.branch, 'feat/xd-bringup');
  assert.match(xdRelease.commit, /^[0-9a-f]{40}$/);
  assert.equal(xdRelease.decompRepository, 'https://github.com/chasem-dev/Pokemon-XD-Decomp.git');
  assert.match(xdRelease.decomp, /^[0-9a-f]{40}$/);
  assert.match(xdRelease.version, /^\d{4}\.\d{2}\.\d{2}\.xd\d+$/);
  assert.equal(xdRelease.portPatch, undefined);
  assert.equal(game.identity(undefined, undefined, xdRelease).portPatch, null);
});

test('an XD disc is accepted for XD, and each game names the other\'s disc so the launcher can switch', t => {
  const root = temporary(t);
  const file = disc(root, xd());
  assert.equal(port.validateRom(file, 'xd'), file);
  assert.throws(() => port.validateRom(file), error => {
    assert.match(error.message, /^This is Pokémon XD: Gale of Darkness \(GXXE01\), not Pokémon Colosseum\. Choose XD on the Play page/);
    assert.equal(error.otherGame, 'xd');
    return true;
  });
  const colosseum = disc(root, gcm(), 'colosseum.iso');
  assert.throws(() => port.validateRom(colosseum, 'xd'), error => error.otherGame === 'colosseum' && /not Pokémon XD: Gale of Darkness/.test(error.message));
  assert.throws(() => port.validateRom(disc(root, xd('GXXP01'), 'eu.iso'), 'xd'), /European release of Pokémon XD: Gale of Darkness \(GXXP01\)/);
  assert.throws(() => port.validateRom(disc(root, xd('GXXJ01'), 'jp.iso')), error => !error.otherGame && /Japanese release of Pokémon XD.*not Pokémon Colosseum/.test(error.message));
  assert.throws(() => port.validateRom(disc(root, xd('GXXE01', 1), 'rev1.iso'), 'xd'), /revision 1 of Pokémon XD: Gale of Darkness.*\(GXXE01, revision 0\)/);
  assert.throws(() => port.validateRom(disc(root, gcm('GMSE01', 0, 'Super Mario Sunshine'), 'sms.iso'), 'xd'),
    /"Super Mario Sunshine" \(GMSE01\), not Pokémon XD: Gale of Darkness\. Choose a copy of your own North American Pokémon XD: Gale of Darkness disc \(GXXE01\)/);
  assert.throws(() => port.validateRom(disc(root, Buffer.alloc(64), 'blank.iso'), 'xd'), /isn't a GameCube disc file\. .*Pokémon XD: Gale of Darkness disc/);
});

test("XD's checkout holds the port with deps/pkmn-xd, and its build gets main.dol where the XD decomp reads it", t => {
  const root = path.join(temporary(t), 'XD Game');
  assert.deepEqual(port.dependencyPaths(root, 'xd').decomp, path.join(root, 'deps', 'pkmn-xd'));
  for (const file of ['build.sh', 'run.sh', 'tools/befix.py', 'deps/pkmn-xd/configure.py']) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), '');
  }
  assert.equal(port.isPort(root, 'xd'), true);
  assert.equal(port.isPort(root), false, 'not a Colosseum checkout');
  const bytes = xd();
  bytes.fill(7, 0x2900, 0x2b00);
  const target = port.placeMainDol(root, disc(path.dirname(root), bytes), 'xd');
  assert.equal(target, path.join(root, 'deps', 'pkmn-xd', 'orig', 'GXXE01', 'sys', 'main.dol'));
  assert.deepEqual(fs.readFileSync(target), bytes.subarray(0x2800, 0x2b00));
});

test("XD's executable is build/xd, and build/xd.exe on Windows; Colosseum's stays build/colosseum", () => {
  assert.equal(port.binaryPath('/g', 'linux', 'xd'), path.join('/g', 'build', 'xd'));
  assert.equal(port.binaryPath('/g', 'win32', 'xd'), path.join('/g', 'build', 'xd.exe'));
  assert.equal(port.binaryPath('/g', 'linux'), path.join('/g', 'build', 'colosseum'));
  assert.equal(port.binaryPath('/g', 'darwin', 'colosseum'), path.join('/g', 'build', 'colosseum'));
  const run = port.gameRunCommand('/g', '/disc/xd.iso', 'darwin', { A: '1' }, undefined, 'xd');
  assert.deepEqual(run, { command: path.join('/g', 'build', 'xd'), args: ['/disc/xd.iso'], cwd: '/g', env: { A: '1' } });
});

test('XD builds with COLO_GAME=xd; Colosseum builds with the environment as it was, less any COLO_GAME', t => {
  const environment = { PATH: '/bin' };
  const colosseum = port.buildCommand('/game', 'linux', environment);
  assert.equal(colosseum.env, environment);
  assert.equal(port.buildCommand('/game', 'linux', { ...environment, COLO_GAME: 'xd' }).env.COLO_GAME, undefined);
  const xdBuild = port.buildCommand('/game-xd', 'linux', environment, 'xd');
  assert.deepEqual(xdBuild, { command: '/bin/sh', args: [port.launcherScript('build-colosseum.sh'), '/game-xd'], cwd: '/game-xd',
    env: { PATH: '/bin', COLO_GAME: 'xd' } });
  const msys = temporary(t);
  fs.mkdirSync(path.join(msys, 'usr', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(msys, 'usr', 'bin', 'bash.exe'), '');
  assert.equal(port.buildCommand('C:\\game-xd', 'win32', { MSYS2_ROOT: msys, Path: 'C:\\WINDOWS' }, 'xd').env.COLO_GAME, 'xd');
});

test("the build script names each game's decomp, and leaves preparing XD's to the port's build.sh", { skip: process.platform === 'win32' }, t => {
  const root = temporary(t);
  fs.writeFileSync(path.join(root, 'build.sh'), 'echo "DECOMP=$DECOMP COLO_PORT=$COLO_PORT"\n');
  // Colosseum's decomp build file is there already, so the script goes straight to build.sh
  fs.mkdirSync(path.join(root, 'deps', 'pkmn-colosseum'), { recursive: true });
  fs.writeFileSync(path.join(root, 'deps', 'pkmn-colosseum', 'build.ninja'), '');
  const run = env => execFileSync('/bin/sh', [port.launcherScript('build-colosseum.sh'), root], { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' }).trim();
  assert.equal(run({}), `DECOMP=${root}/deps/pkmn-colosseum COLO_PORT=${root}`);
  // XD has no build.ninja yet: the script must not run configure.py itself (there is none here to run)
  assert.equal(run({ COLO_GAME: 'xd' }), `DECOMP=${root}/deps/pkmn-xd COLO_PORT=${root}`);
});

test('XD plays with the renderer, display and input settings, widescreen, HD text, fast-forward and movie skipping, and none of Colosseum\'s features', t => {
  const root = temporary(t);
  const settings = port.normalizeSettings({ renderer: 'opengl', resolution: 3, fullscreen: true, vsync: 'on', padMode: 'single', fastForward: 'toggle',
    fastForwardSpeed: 6, skipMovies: true, randomizer: true, battleSpeed: 2, hdText: 'off', hdModels: false, shinyShadow: false, chooseStarters: false }, 'linux');
  const env = port.buildEnvironment(settings, '/disc/xd.iso', root, { game: 'xd' });
  assert.equal(env.COLO_DISC, '/disc/xd.iso');
  assert.equal(env.SMS_GX_BACKEND, 'opengl');
  assert.equal(env.SMS_GX_SCALE, '3');
  assert.equal(env.SMS_FULLSCREEN, '1');
  assert.equal(env.SMS_VSYNC, '1');
  assert.equal(env.COLO_PADS, 'single');
  assert.equal(env.COLO_FAST_FORWARD, 'toggle');
  assert.equal(env.COLO_FAST_FORWARD_SPEED, '6');
  assert.equal(env.COLO_SKIP_MOVIES, '1');
  assert.equal(env.SMS_TEXTURE_PACKS, '0', 'no HD pack, nor Colosseum\'s textures');
  assert.equal(env.COLO_WIDESCREEN, 'auto', 'its cameras widen with the frame');
  assert.equal(env.COLO_HD_TEXT, '0', 'HD text, here turned off');
  for (const key of ['COLO_RANDOMIZER', 'COLO_BATTLE_SPEED', 'COLO_QUICK_MOVES', 'COLO_FAST_STATUS',
    'COLO_HD_MODELS', 'COLO_SHINY_SHADOW', 'COLO_CHOOSE_STARTERS', 'SMS_BUTTON_PROMPTS', 'SMS_TEXTURE_PACK_PRELOAD'])
    if (!(key in process.env)) assert.equal(key in env, false, key);
  const colosseum = port.buildEnvironment(settings, '/disc/colosseum.iso', root);
  assert.equal(colosseum.COLO_WIDESCREEN, 'auto');
  assert.equal(colosseum.COLO_BATTLE_SPEED, '2');
  assert.equal(colosseum.COLO_HD_TEXT, '0');
  assert.match(colosseum.COLO_RANDOMIZER, /./);
  assert.deepEqual(colosseum, port.buildEnvironment(settings, '/disc/colosseum.iso', root, { game: 'colosseum' }));
});

test("an XD build's record says it is XD's and sits beside build/xd, so Colosseum's stay as they were", async t => {
  const root = temporary(t);
  const { decomp } = port.dependencyPaths(root, 'xd');
  for (const [directory, commit] of [[root, xdRelease.commit], [decomp, xdRelease.decomp]]) {
    fs.mkdirSync(path.join(directory, '.git'), { recursive: true });
    fs.writeFileSync(path.join(directory, '.git', 'HEAD'), `${commit}\n`);
  }
  assert.equal(game.matchesSource(root, xdRelease), true);
  assert.equal(game.matchesSource(root), false, "not Colosseum's commits");
  assert.equal(game.identity(undefined, undefined, xdRelease).game, 'xd');
  assert.equal('game' in game.identity(), false, "Colosseum's record has no game, so its builds stay current");
  const binary = port.binaryPath(root, process.platform, 'xd');
  await game.buildSafely(root, path.join(root, 'saves'), async () => { fs.mkdirSync(path.dirname(binary), { recursive: true }); fs.writeFileSync(binary, 'xd'); },
    { source: xdRelease, backups: path.join(root, 'backups') });
  assert.equal(game.installed(root, 'xd').game, 'xd');
  assert.equal(game.isCurrent(root, xdRelease), true);
  assert.equal(game.isCurrent(root), false);
  assert.equal(game.recoverBuild(root, 'xd'), false);
});

test("XD checks out the port's XD commit with its own decomp in deps/pkmn-xd", { skip: process.platform === 'win32' }, async t => {
  const home = temporary(t, 'colo xd checkout-');
  const repository = (name, files) => {
    const directory = path.join(home, name);
    const git = (...args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    fs.mkdirSync(directory);
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'Test');
    git('config', 'uploadpack.allowAnySHA1InWant', 'true');
    for (const [file, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
      fs.writeFileSync(path.join(directory, file), text);
    }
    git('add', '-A');
    git('commit', '-q', '-m', 'first');
    return { url: `file://${directory}`, commit: git('rev-parse', 'HEAD') };
  };
  const portRepo = repository('port', { 'build.sh': '', 'run.sh': '', 'tools/befix.py': '' });
  const decompRepo = repository('decomp', { 'configure.py': '' });
  const pinned = { game: 'xd', version: 'test', repository: portRepo.url, branch: 'main', commit: portRepo.commit, decompRepository: decompRepo.url, decomp: decompRepo.commit };
  const root = games.checkoutPath(home, 'xd');
  await game.checkout(root, { run: async (command, args, options = {}) => { execFileSync(command, args, { cwd: options.cwd, env: options.env, stdio: 'ignore' }); },
    capture: async (command, args, cwd) => execFileSync(command, args, { cwd, encoding: 'utf8' }).trim(), env: process.env, source: pinned });
  assert.equal(root, path.join(home, 'game-xd'));
  assert.equal(port.isPort(root, 'xd'), true);
  assert.equal(fs.existsSync(path.join(root, 'deps', 'pkmn-colosseum')), false);
  assert.equal(game.matchesSource(root, pinned), true);
  // each game's versions go beside its own folder
  assert.equal(path.dirname(game.snapshotPath(root, pinned)), path.join(home, 'game-xd.releases'));
  assert.notEqual(path.dirname(game.snapshotPath(games.checkoutPath(home, 'colosseum'))), path.dirname(game.snapshotPath(root, pinned)));
});

test("a custom source for XD takes XD's decomp from the port's CI script, or keeps its pin's, and says it is XD's", async () => {
  const override = gameSource.normalizeOverride({ port: { ref: 'a'.repeat(40) } }, xdRelease);
  assert.equal(override.port.repository, xdRelease.repository);
  assert.equal(gameSource.normalizeOverride({ decomp: { ref: 'main' } }, xdRelease).decomp.repository, xdRelease.decompRepository);
  // the port commit's tools/ci/linux-build.sh, as git show gives it
  const askedFor = script => async (_git, args) => args.includes('show') ? script : '';
  const pinned = 'c'.repeat(40);
  const resolved = await gameSource.resolve(override, { capture: askedFor(`DECOMP_REF=${'b'.repeat(40)}\nXD_DECOMP_REF=${pinned}\n`), release: xdRelease });
  assert.equal(resolved.game, 'xd');
  assert.equal(resolved.commit, 'a'.repeat(40));
  assert.equal(resolved.decomp, pinned, "XD's own pin, not Colosseum's");
  assert.equal(resolved.decompRepository, xdRelease.decompRepository);
  assert.equal(resolved.portPatch, undefined);
  const older = await gameSource.resolve(override, { capture: askedFor(`DECOMP_REF=${'b'.repeat(40)}\n`), release: xdRelease });
  assert.equal(older.decomp, xdRelease.decomp, 'a port from before XD was in CI: the pin\'s decomp');
});

const defaultRepo = id => games.checkoutPath('/data', id);

test('preferences from before XD stay Colosseum\'s, and XD gets its own folder', () => {
  const old = { repo: '/games/Colosseum Game.releases/abc', rom: '/discs/colosseum.iso', installRoot: '/games/Colosseum Game', completedSetup: true,
    previousInstall: { repo: '/games/Colosseum Game', rom: '/discs/colosseum.iso' }, settings: { fullscreen: true } };
  const loaded = games.loadGames(old, { defaultRepo });
  assert.equal(loaded.game, 'colosseum');
  assert.deepEqual(games.pickFields(loaded), { repo: old.repo, rom: old.rom, installRoot: old.installRoot, previousInstall: old.previousInstall,
    completedSetup: true, gameSource: null });
  assert.deepEqual(loaded.games.xd, { repo: path.join('/data', 'game-xd'), rom: '', installRoot: null, previousInstall: null, completedSetup: false, gameSource: null });
  // A fresh launcher's Colosseum is where it always was
  assert.equal(games.loadGames({}, { defaultRepo }).repo, path.join('/data', 'game'));
});

test('choosing XD brings up its fields and keeps Colosseum\'s at the top level of what is saved', () => {
  const config = { ...games.loadGames({ repo: '/c', rom: '/c.iso', completedSetup: true }, { defaultRepo }), settings: { fullscreen: true } };
  const chosen = games.switchGame(config, 'xd', { defaultRepo });
  assert.equal(chosen.game, 'xd');
  assert.equal(chosen.repo, path.join('/data', 'game-xd'));
  assert.equal(chosen.rom, '');
  assert.deepEqual(chosen.settings, { fullscreen: true }, 'settings are shared');
  chosen.rom = '/xd.iso';
  const stored = games.storedGames(chosen);
  assert.equal(stored.game, 'xd');
  assert.equal(stored.repo, '/c');
  assert.equal(stored.rom, '/c.iso');
  assert.equal(stored.completedSetup, true);
  assert.equal(stored.games.xd.rom, '/xd.iso');
  assert.equal(stored.games.colosseum, undefined);
  // read back: XD chosen, with its disc; back to Colosseum, with its own
  const again = games.loadGames(JSON.parse(JSON.stringify(stored)), { defaultRepo });
  assert.equal(again.game, 'xd');
  assert.equal(again.rom, '/xd.iso');
  const back = games.switchGame(again, 'colosseum', { defaultRepo });
  assert.deepEqual([back.repo, back.rom, back.games.xd.rom], ['/c', '/c.iso', '/xd.iso']);
  assert.deepEqual(Object.keys(games.allFields(back)).sort(), ['colosseum', 'xd']);
});

test("a portable folder keeps XD's paths relative too", () => {
  const base = path.resolve('/portable');
  const stored = portable.storedPaths({ repo: path.join(base, 'game'), games: { xd: { repo: path.join(base, 'game-xd'), rom: path.join(base, 'xd.iso'),
    previousInstall: { repo: path.join(base, 'old') } } } }, base);
  assert.deepEqual(stored.games.xd, { repo: 'game-xd', rom: 'xd.iso', previousInstall: { repo: 'old' } });
  assert.equal(portable.resolvedPaths(stored, base).games.xd.repo, path.join(base, 'game-xd'));
});

// main.js with Electron stubbed, as the launcher loads and saves its preferences.
function launcher(t, saved) {
  const root = temporary(t, 'colo xd main-');
  if (saved) fs.writeFileSync(path.join(root, 'preferences.json'), JSON.stringify(saved));
  const filename = path.resolve(__dirname, '../src/main.js');
  const localRequire = createRequire(filename);
  const electron = { ipcMain: { handle() {} }, app: { requestSingleInstanceLock: () => true, commandLine: { appendSwitch() {} }, on() {},
    whenReady: () => ({ then() {} }), getPath: () => root, getVersion: () => '0.1.3', isPackaged: false },
  BrowserWindow: class {}, dialog: {}, shell: {}, clipboard: {}, net: {}, screen: {}, protocol: { registerSchemesAsPrivileged() {}, handle() {} } };
  const context = { require: id => id === 'electron' ? electron : localRequire(id), __dirname: path.dirname(filename), process, setTimeout, setInterval,
    module: { exports: {} } };
  vm.runInNewContext(`${fs.readFileSync(filename, 'utf8')}
    module.exports = { loadConfig, saveConfig, currentSource, config: () => config, choose: id => { config = games.switchGame(config, id, gameFieldOptions); saveConfig(); } };`,
  context, { filename });
  const main = context.module.exports;
  main.loadConfig();
  return { main, root, saved: () => JSON.parse(fs.readFileSync(path.join(root, 'preferences.json'), 'utf8')) };
}

test('the launcher loads an existing Colosseum setup unchanged, and saves XD beside it', t => {
  const { main, root, saved } = launcher(t, { repo: '/games/Colosseum Game', rom: '/discs/colosseum.iso', completedSetup: true, installId: '11111111-1111-4111-8111-111111111111' });
  assert.equal(main.config().game, 'colosseum');
  assert.equal(main.config().repo, '/games/Colosseum Game');
  assert.equal(main.currentSource(), game.release);
  main.choose('xd');
  assert.equal(main.config().repo, path.join(root, 'game-xd'));
  assert.equal(main.currentSource(), xdRelease);
  const file = saved();
  assert.equal(file.game, 'xd');
  assert.equal(file.repo, '/games/Colosseum Game', 'an older launcher still finds Colosseum where it was');
  assert.equal(file.rom, '/discs/colosseum.iso');
  assert.equal(file.games.xd.repo, path.join(root, 'game-xd'));
  main.choose('colosseum');
  assert.equal(main.config().rom, '/discs/colosseum.iso');
  assert.equal(main.currentSource(), game.release);
});

test('each game has its own HD texture pack: Colosseum its pinned one, XD none until its pack is published', t => {
  assert.equal(port.texturePack('colosseum'), require('../src/texture-pack.json'));
  assert.equal(port.texturePack('xd'), null);
  assert.equal(games.supports('xd', 'hdTextures'), false, 'not offered before its pack exists');
  const root = temporary(t);
  assert.equal(port.texturePackInstalled(root, 'xd'), false);
  assert.throws(() => port.textureCommand(root, 'linux', {}, 'xd'), /no HD texture pack yet/);
  assert.equal(port.textureCommand(root, 'linux', {}).args[2], require('../src/texture-pack.json').url);
});
