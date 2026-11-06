'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const port = require('../src/port');
const { gcm, ciso } = require('./disc-fixture');

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'colosseum-launcher-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const disc = (root, bytes, name = 'game.iso') => { const file = path.join(root, name); fs.writeFileSync(file, bytes); return file; };
const colosseum = (id = 'GC6E01', revision = 0, title = 'Pokemon Colosseum') => gcm(id, revision, title);

test('the North American disc is accepted, and it is named by its contents, not its file name', t => {
  const root = temporary(t);
  const file = disc(root, colosseum(), 'whatever.bin');
  assert.equal(port.validateRom(file), file);
});

test('other discs say what they are and what to do', t => {
  const root = temporary(t);
  assert.throws(() => port.validateRom(disc(root, colosseum('GC6P01'))), /European release of Pokémon Colosseum \(GC6P01\)/);
  assert.throws(() => port.validateRom(disc(root, colosseum('GC6J01'))), /Japanese release/);
  assert.throws(() => port.validateRom(disc(root, gcm('GMSE01', 0, 'Super Mario Sunshine'))), /"Super Mario Sunshine" \(GMSE01\), not Pokémon Colosseum/);
  assert.throws(() => port.validateRom(disc(root, colosseum('GC6E01', 1))), /revision 1 of Pokémon Colosseum/);
  assert.throws(() => port.validateRom(disc(root, colosseum().subarray(0, 0x3900))), /incomplete/);
});

test('a CISO is refused, as the port reads raw disc images only, and other formats get their reason', t => {
  const root = temporary(t);
  assert.throws(() => port.validateRom(disc(root, ciso(colosseum()), 'game.ciso')), /CISO file.*Convert File/);
  assert.throws(() => port.validateRom(disc(root, Buffer.from('RVZ\x01padding', 'latin1'))), /RVZ file/);
  assert.throws(() => port.validateRom(disc(root, Buffer.from('PK\x03\x04padding', 'latin1'))), /ZIP archive/);
  assert.throws(() => port.validateRom(disc(root, Buffer.alloc(64))), /isn't a GameCube disc file/);
  assert.throws(() => port.validateRom(path.join(root, 'missing.iso')), /cannot be found/);
  assert.throws(() => port.validateRom(root), /not a folder/);
  assert.throws(() => port.validateRom(''), /Choose your own game disc file/);
});

test('defaults are the port\'s HD settings on every system', () => {
  for (const platform of ['linux', 'darwin', 'win32']) {
    const settings = port.normalizeSettings({}, platform);
    assert.deepEqual([settings.renderer, settings.resolution, settings.frameRate, settings.widescreen, settings.anisotropic, settings.textures],
      ['vulkan', 4, 60, 'auto', 16, true]);
  }
});

test('settings outside what the game takes fall back', () => {
  const settings = port.normalizeSettings({ frameRate: 90, resolution: 9, widescreen: '5:4', renderer: 'metal', stickDeadzone: 99, display: 'monitor99',
    exclusiveResolution: 'big', hdText: 'maybe', padMode: 'all' });
  assert.equal(settings.frameRate, 60);
  assert.equal(settings.resolution, 4);
  assert.equal(settings.widescreen, 'auto');
  assert.equal(settings.renderer, 'vulkan');
  assert.equal(settings.stickDeadzone, 50);
  assert.equal(settings.display, 'launcher');
  assert.equal(settings.exclusiveResolution, 'desktop');
  assert.equal(settings.hdText, 'on');
  assert.equal(settings.padMode, 'players');
});

test('the game gets run.sh\'s settings by default', () => {
  const env = port.buildEnvironment(port.normalizeSettings({}), '/my/disc.iso', '/port');
  assert.equal(env.COLO_DISC, '/my/disc.iso');
  assert.equal(env.SMS_GX_BACKEND, 'vulkan');
  assert.equal(env.SMS_GX_SCALE, '4');
  assert.equal(env.COLO_FPS, '60');
  assert.equal(env.COLO_WIDESCREEN, 'auto');
  assert.equal(env.SMS_ANISO, '16');
  assert.equal(env.SMS_TEXTURE_PACK_MB, '3000');
  assert.equal(env.SMS_TEXTURE_PACKS, path.join('/port', 'mods', 'textures'));
  assert.equal(env.COLO_WIDESCREEN_HUD, 'edges');
});

test('settings reach the variables the game reads', () => {
  const env = port.buildEnvironment(port.normalizeSettings({ renderer: 'opengl', resolution: 2, frameRate: 30, widescreen: '4:3', hudEdges: false,
    textures: false, fullscreen: true, fullscreenMode: 'exclusive', exclusiveResolution: '1920x1080', display: 'monitor2', skipMovies: true, padMode: 'single',
    rumbleStrength: 0, stickDeadzone: 20, triggerClick: 70, backgroundInput: true, brightness: 150 }), 'disc', '/port');
  assert.deepEqual([env.SMS_GX_BACKEND, env.SMS_GX_SCALE, env.COLO_FPS, env.COLO_WIDESCREEN, env.COLO_WIDESCREEN_HUD], ['opengl', '2', '30', '4:3', 'center']);
  assert.equal(port.buildEnvironment(port.normalizeSettings({ frameRate: 120 }), '/disc.iso', '/port').COLO_FPS, '120');
  assert.equal(env.SMS_TEXTURE_PACKS, '0');
  assert.deepEqual([env.SMS_FULLSCREEN, env.SMS_FULLSCREEN_TYPE, env.SMS_FULLSCREEN_MODE, env.SMS_DISPLAY], ['exclusive', 'exclusive', '1920x1080', '1']);
  assert.equal(env.COLO_SKIP_MOVIES, '1');
  assert.deepEqual([env.COLO_PADS, env.COLO_RUMBLE, env.COLO_STICK_DEADZONE, env.COLO_TRIGGER_CLICK, env.COLO_BACKGROUND_INPUT], ['single', '0', '20', '70', '1']);
  assert.equal(env.SMS_GAMMA, '1.50');
});

test('battle speed is 2x unless changed, and Normal leaves it to the game', () => {
  const env = battleSpeed => port.buildEnvironment(port.normalizeSettings({ battleSpeed }), 'disc', '/port').COLO_BATTLE_SPEED;
  const saved = process.env.COLO_BATTLE_SPEED;
  delete process.env.COLO_BATTLE_SPEED;
  try {
    assert.equal(env(undefined), '2');
    assert.equal(env('normal'), undefined);
    assert.equal(env('fast'), '2');
    assert.equal(env('2'), '2');
    assert.equal(env('4'), '4');
    assert.equal(env('skip'), 'skip');
  } finally { if (saved !== undefined) process.env.COLO_BATTLE_SPEED = saved; }
});

test('a saved 8x battle speed, which Beta launchers offered, becomes 4x', () => {
  assert.equal(port.normalizeSettings({ battleSpeed: '8' }).battleSpeed, '4');
});

test('HD text stays unset by default: any other value names a glyph file', () => {
  const env = hdText => port.buildEnvironment(port.normalizeSettings({ hdText }), 'disc', '/port').COLO_HD_TEXT;
  const saved = process.env.COLO_HD_TEXT;
  delete process.env.COLO_HD_TEXT;
  try {
    assert.equal(env('on'), undefined);
    assert.equal(env('upscaled'), 'upscaled');
    assert.equal(env('off'), '0');
  } finally { if (saved !== undefined) process.env.COLO_HD_TEXT = saved; }
});

test('custom textures win over the HD textures, and work without them', t => {
  const root = temporary(t);
  const custom = path.join(root, 'custom');
  const settings = port.normalizeSettings({});
  assert.deepEqual(port.texturePackFolders(settings, '/port', custom), [path.join('/port', 'mods', 'textures')]);
  fs.mkdirSync(path.join(custom, 'pack'), { recursive: true });
  fs.writeFileSync(path.join(custom, 'pack', 'tex1_64x64_abc_6.png'), 'png');
  assert.deepEqual(port.texturePackFolders(settings, '/port', custom), [custom, path.join('/port', 'mods', 'textures')]);
  assert.deepEqual(port.texturePackFolders({ ...settings, textures: false }, '/port', custom), [custom]);
});

test('the HD pack counts once its marker names the pinned pack', t => {
  const root = temporary(t);
  const folder = path.join(port.texturePackDirectory(root), port.TEXTURE_PACK.folder);
  fs.mkdirSync(folder, { recursive: true });
  assert.equal(port.texturePackInstalled(root), false);
  fs.writeFileSync(path.join(folder, '.release'), JSON.stringify({ sha256: 'another pack' }));
  assert.equal(port.texturePackInstalled(root), false);
  assert.equal(port.hdVisualsInstalled(root, { textures: true }), false);
  assert.equal(port.hdVisualsInstalled(root, { textures: false }), true);
  fs.writeFileSync(path.join(folder, '.release'), JSON.stringify({ sha256: port.TEXTURE_PACK.sha256 }));
  assert.equal(port.texturePackInstalled(root), true);
});

test('a game folder holds the port and the decomp it builds from', t => {
  const root = temporary(t);
  assert.equal(port.isPort(root), false);
  for (const file of ['build.sh', 'run.sh', path.join('tools', 'befix.py')]) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), '');
  }
  assert.equal(port.isPort(root), false);
  fs.mkdirSync(path.join(root, 'deps', 'pkmn-colosseum'), { recursive: true });
  fs.writeFileSync(path.join(root, 'deps', 'pkmn-colosseum', 'configure.py'), '');
  assert.equal(port.isPort(root), true);
});

test('the game is one build, and starts in its folder with the disc named', () => {
  assert.equal(port.binaryPath('/game', 'linux'), path.join('/game', 'build', 'colosseum'));
  assert.equal(port.binaryPath('/game', 'win32'), path.join('/game', 'build', 'colosseum.exe'));
  const start = port.gameRunCommand('/game', '/my/disc.iso', 'linux', { HOME: '/home/player' });
  assert.deepEqual([start.command, start.args, start.cwd], [port.binaryPath('/game', 'linux'), ['/my/disc.iso'], '/game']);
});

test('builds run the launcher\'s script, through MSYS2\'s shell on Windows', t => {
  const unix = port.buildCommand('/game', 'linux', {});
  assert.equal(unix.command, '/bin/sh');
  assert.equal(path.basename(unix.args[0]), 'build-colosseum.sh');
  assert.equal(unix.args[1], '/game');
  const root = temporary(t);
  const msys = path.join(root, 'msys64');
  fs.mkdirSync(path.join(msys, 'usr', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(msys, 'usr', 'bin', 'bash.exe'), '');
  const windows = port.buildCommand('C:\\game', 'win32', { MSYS2_ROOT: msys, Path: 'C:\\WINDOWS' });
  assert.equal(windows.command, path.join(msys, 'usr', 'bin', 'bash.exe'));
  assert.equal(windows.env.MSYSTEM, 'MINGW64');
  assert.throws(() => port.buildCommand('C:\\game', 'win32', { MSYS2_ROOT: path.join(root, 'none') }), /build tools are missing/);
});

test('the texture installer gets the pinned pack', () => {
  const { args } = port.textureCommand('/game', 'linux', {});
  assert.equal(path.basename(args[0]), 'install-textures.py');
  assert.deepEqual(args.slice(1), [path.join('/game', 'mods', 'textures'), port.TEXTURE_PACK.url, port.TEXTURE_PACK.sha256,
    String(port.TEXTURE_PACK.size), port.TEXTURE_PACK.folder]);
  assert.match(port.TEXTURE_PACK.sha256, /^[a-f0-9]{64}$/);
  assert.match(port.TEXTURE_PACK.url, /^https:\/\//);
});

test('a Windows folder too deep to build in is found before the build, with what to do', () => {
  assert.equal(port.longPathProblem('/game', { platform: 'linux' }), null);
  assert.equal(port.longPathProblem('C:\\Games\\game', { platform: 'win32' }), null);
  const folder = `C:\\${'long\\'.repeat(40)}x`;
  const problem = port.longPathProblem(`${folder}\\game`, { platform: 'win32', folder, msys: `${folder}\\msys64` });
  assert.equal(problem.folder, folder);
  assert.ok(problem.length > problem.limit);
  assert.match(problem.message, /C:\\Games/);
  const portable = port.longPathProblem(`${folder}\\game`, { platform: 'win32', folder, portable: true });
  assert.match(portable.message, /Colosseum-Launcher-Portable/);
});

test('launcher updates stay on Stable unless a known channel is chosen', () => {
  assert.equal(port.normalizeSettings({}).updateChannel, 'stable');
  assert.equal(port.normalizeSettings({ updateChannel: 'beta' }).updateChannel, 'beta');
  assert.equal(port.normalizeSettings({ updateChannel: 'pr-12' }).updateChannel, 'pr-12');
  assert.equal(port.normalizeSettings({ updateChannel: 'nightly' }).updateChannel, 'stable');
});

test('a playable install is the one with a game built', t => {
  const root = temporary(t);
  assert.equal(port.playableInstall({ repo: root, settings: {} }), null);
  fs.mkdirSync(path.dirname(port.binaryPath(root)), { recursive: true });
  fs.writeFileSync(port.binaryPath(root), 'game');
  assert.equal(port.playableInstall({ repo: root, settings: {} }).repo, root);
  assert.equal(port.playableInstall({}), null);
});
