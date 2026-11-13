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

test("main.dol is copied from the disc to where the decomp keeps the disc's files, for the Windows icon", t => {
  const root = temporary(t);
  const bytes = colosseum();
  bytes.fill(7, 0x2900, 0x2b00);   // the fixture DOL's one section
  const target = port.placeMainDol(path.join(root, 'Colosseum Game'), disc(root, bytes));
  assert.equal(target, path.join(root, 'Colosseum Game', 'deps', 'pkmn-colosseum', 'orig', 'GC6E01', 'sys', 'main.dol'));
  assert.deepEqual(fs.readFileSync(target), bytes.subarray(0x2800, 0x2b00));
  fs.writeFileSync(target, 'stale');
  port.placeMainDol(path.join(root, 'Colosseum Game'), disc(root, bytes));
  assert.deepEqual(fs.readFileSync(target), bytes.subarray(0x2800, 0x2b00));
  assert.ok(!fs.existsSync(`${target}.part`));
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
  for (const [platform, arch, renderer] of [['linux', 'x64', 'vulkan'], ['darwin', 'arm64', 'metal'], ['darwin', 'x64', 'vulkan'], ['win32', 'x64', 'vulkan']]) {
    const settings = port.normalizeSettings({}, platform, arch);
    assert.deepEqual([settings.renderer, settings.resolution, settings.frameRate, settings.widescreen, settings.anisotropic, settings.textures],
      [renderer, 4, 60, 'auto', 16, true]);
  }
});

test('a game marked for Rosetta is x86-64 on every Mac, so Apple Silicon has no Metal until the mark goes', () => {
  assert.equal(port.gameArch('arm64', { rosetta: true }), 'x64');
  assert.equal(port.gameArch('arm64', {}), 'arm64');
  assert.equal(port.gameArch('x64', {}), 'x64');
  const arch = port.gameArch('arm64', { rosetta: true });
  assert.deepEqual(port.platformInfo('darwin', arch).renderers, ['vulkan', 'opengl']);
  assert.equal(port.normalizeSettings({ renderer: 'metal' }, 'darwin', arch).renderer, 'vulkan');
  assert.equal(port.moveToMetal(port.normalizeSettings({ renderer: 'vulkan' }, 'darwin', arch), undefined, 'darwin', arch).renderer, 'vulkan');
});

test('only Apple Silicon has Metal, and the game is told the renderer chosen', () => {
  assert.deepEqual(port.platformInfo('darwin', 'arm64').renderers, ['metal', 'vulkan', 'opengl']);
  assert.deepEqual(port.platformInfo('darwin', 'x64').renderers, ['vulkan', 'opengl']);
  assert.equal(port.normalizeSettings({ renderer: 'metal' }, 'darwin', 'x64').renderer, 'vulkan');
  for (const platform of ['linux', 'win32']) assert.equal(port.normalizeSettings({ renderer: 'metal' }, platform).renderer, 'vulkan');
  for (const renderer of ['metal', 'vulkan', 'opengl']) {
    const settings = port.normalizeSettings({ renderer }, 'darwin', 'arm64');
    assert.equal(settings.renderer, renderer);
    assert.equal(port.buildEnvironment(settings, '/disc.iso', '/game').SMS_GX_BACKEND, renderer);
  }
});

test('Apple Silicon moves off the old default Vulkan once, a later choice stays, and an Intel Mac stays on Vulkan', () => {
  const vulkan = port.normalizeSettings({ renderer: 'vulkan' }, 'darwin', 'arm64');
  assert.equal(port.moveToMetal(vulkan, undefined, 'darwin', 'arm64').renderer, 'metal');
  assert.equal(port.moveToMetal(vulkan, true, 'darwin', 'arm64').renderer, 'vulkan');
  assert.equal(port.moveToMetal(vulkan, undefined, 'darwin', 'x64').renderer, 'vulkan');
  const opengl = port.normalizeSettings({ renderer: 'opengl' }, 'darwin', 'arm64');
  assert.equal(port.moveToMetal(opengl, undefined, 'darwin', 'arm64').renderer, 'opengl');
  const linux = port.normalizeSettings({ renderer: 'vulkan' }, 'linux');
  assert.equal(port.moveToMetal(linux, undefined, 'linux').renderer, 'vulkan');
});

test('settings outside what the game takes fall back', () => {
  const settings = port.normalizeSettings({ frameRate: 120, resolution: 9, widescreen: '5:4', renderer: 'direct3d', stickDeadzone: 99, display: 'monitor99',
    exclusiveResolution: 'big', hdText: 'maybe', padMode: 'all' });
  assert.equal(settings.frameRate, 60);
  assert.equal(settings.resolution, 4);
  assert.equal(settings.widescreen, 'auto');
  assert.equal(settings.renderer, port.platformInfo().renderers[0]);
  assert.equal(settings.stickDeadzone, 50);
  assert.equal(settings.display, 'launcher');
  assert.equal(settings.exclusiveResolution, 'desktop');
  assert.equal(settings.hdText, 'on');
  assert.equal(settings.padMode, 'players');
});

test('the game gets run.sh\'s settings by default', () => {
  const env = port.buildEnvironment(port.normalizeSettings({}), '/my/disc.iso', '/port');
  assert.equal(env.COLO_DISC, '/my/disc.iso');
  assert.equal(env.SMS_GX_BACKEND, port.platformInfo().renderers[0]);
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
  assert.equal(env.SMS_TEXTURE_PACKS, '0');
  assert.deepEqual([env.SMS_FULLSCREEN, env.SMS_FULLSCREEN_TYPE, env.SMS_FULLSCREEN_MODE, env.SMS_DISPLAY], ['exclusive', 'exclusive', '1920x1080', '1']);
  assert.equal(env.COLO_SKIP_MOVIES, '1');
  assert.deepEqual([env.COLO_PADS, env.COLO_RUMBLE, env.COLO_STICK_DEADZONE, env.COLO_TRIGGER_CLICK, env.COLO_BACKGROUND_INPUT], ['single', '0', '20', '70', '1']);
  assert.equal(env.SMS_GAMMA, '1.50');
});

test('battle speed is 1.5x unless changed, in tenths from 1x to 5x, and 1x leaves it to the game', () => {
  const env = (battleSpeed, skipBattleAnimations) =>
    port.buildEnvironment(port.normalizeSettings({ battleSpeed, skipBattleAnimations }), 'disc', '/port').COLO_BATTLE_SPEED;
  const saved = process.env.COLO_BATTLE_SPEED;
  delete process.env.COLO_BATTLE_SPEED;
  try {
    assert.equal(env(undefined), '1.5');
    assert.equal(env('fast'), '1.5');
    assert.equal(env(''), '1.5');
    assert.equal(env('1'), undefined);
    assert.equal(env('1.1'), '1.1');
    assert.equal(env('2.7'), '2.7');
    assert.equal(env(3.3000000000000003), '3.3');
    assert.equal(env('5'), '5');
    assert.equal(env('0.2'), undefined);
    assert.equal(env('9'), '5');
    assert.equal(env('2.7', true), 'skip');
    assert.equal(env('1', true), 'skip');
  } finally { if (saved !== undefined) process.env.COLO_BATTLE_SPEED = saved; }
});

test('the shiny settings are on unless turned off, and on leaves them to the game', () => {
  const env = settings => port.buildEnvironment(port.normalizeSettings(settings), 'disc', '/port');
  const saved = [process.env.COLO_SHINY_SHADOW, process.env.COLO_SHINY_STARTERS];
  delete process.env.COLO_SHINY_SHADOW;
  delete process.env.COLO_SHINY_STARTERS;
  try {
    assert.equal(port.normalizeSettings({}).shinyShadow, true);
    assert.equal(port.normalizeSettings({}).shinyStarters, true);
    assert.equal(env({}).COLO_SHINY_SHADOW, undefined);
    assert.equal(env({}).COLO_SHINY_STARTERS, undefined);
    assert.equal(env({ shinyShadow: false }).COLO_SHINY_SHADOW, '0');
    assert.equal(env({ shinyShadow: false }).COLO_SHINY_STARTERS, undefined);
    assert.equal(env({ shinyStarters: false }).COLO_SHINY_STARTERS, '0');
  } finally {
    if (saved[0] !== undefined) process.env.COLO_SHINY_SHADOW = saved[0];
    if (saved[1] !== undefined) process.env.COLO_SHINY_STARTERS = saved[1];
  }
});

test('quick moves and quick status effects are on unless turned off, and off leaves them to the game', () => {
  const env = settings => port.buildEnvironment(port.normalizeSettings(settings), 'disc', '/port');
  const saved = [process.env.COLO_QUICK_MOVES, process.env.COLO_FAST_STATUS];
  delete process.env.COLO_QUICK_MOVES;
  delete process.env.COLO_FAST_STATUS;
  try {
    assert.equal(port.normalizeSettings({}).quickMoves, true);
    assert.equal(port.normalizeSettings({}).quickStatus, true);
    assert.equal(env({}).COLO_QUICK_MOVES, '1');
    assert.equal(env({}).COLO_FAST_STATUS, '1');
    assert.equal(env({ quickMoves: false }).COLO_QUICK_MOVES, undefined);
    assert.equal(env({ quickMoves: false }).COLO_FAST_STATUS, '1');
    assert.equal(env({ quickStatus: false }).COLO_FAST_STATUS, undefined);
    assert.equal(env({ quickMoves: false, quickStatus: false }).COLO_QUICK_MOVES, undefined);
  } finally {
    if (saved[0] !== undefined) process.env.COLO_QUICK_MOVES = saved[0];
    if (saved[1] !== undefined) process.env.COLO_FAST_STATUS = saved[1];
  }
});

test('a config saved while quick moves were off by default turns them on once, then keeps the choice', () => {
  const off = port.normalizeSettings({ quickMoves: false, quickStatus: false });
  const on = port.turnOnQuickBattles(off, undefined);
  assert.equal(on.quickMoves, true);
  assert.equal(on.quickStatus, true);
  assert.equal(port.turnOnQuickBattles(off, true).quickMoves, false);
  assert.equal(port.turnOnQuickBattles(off, true).quickStatus, false);
});

test('fast-forward is held at 4x unless chosen, and the default leaves it to the game', () => {
  const env = settings => port.buildEnvironment(port.normalizeSettings(settings), 'disc', '/port');
  const saved = [process.env.COLO_FAST_FORWARD, process.env.COLO_FAST_FORWARD_SPEED];
  delete process.env.COLO_FAST_FORWARD;
  delete process.env.COLO_FAST_FORWARD_SPEED;
  try {
    assert.equal(port.normalizeSettings({}).fastForward, 'hold');
    assert.equal(port.normalizeSettings({}).fastForwardSpeed, 4);
    assert.equal(env({}).COLO_FAST_FORWARD, undefined);
    assert.equal(env({}).COLO_FAST_FORWARD_SPEED, undefined);
    assert.equal(env({ fastForward: 'toggle' }).COLO_FAST_FORWARD, 'toggle');
    assert.equal(env({ fastForward: 'sideways' }).COLO_FAST_FORWARD, undefined);
    // the Settings list saves its value as text
    assert.equal(env({ fastForwardSpeed: '3' }).COLO_FAST_FORWARD_SPEED, '3');
    assert.equal(env({ fastForwardSpeed: '8' }).COLO_FAST_FORWARD_SPEED, '8');
    assert.equal(env({ fastForwardSpeed: '4' }).COLO_FAST_FORWARD_SPEED, undefined);
    assert.equal(port.normalizeSettings({ fastForwardSpeed: '5' }).fastForwardSpeed, 4);
  } finally {
    if (saved[0] !== undefined) process.env.COLO_FAST_FORWARD = saved[0];
    if (saved[1] !== undefined) process.env.COLO_FAST_FORWARD_SPEED = saved[1];
  }
});

test('choosing starters is on unless turned off, and on leaves it to the game', () => {
  const env = settings => port.buildEnvironment(port.normalizeSettings(settings), 'disc', '/port');
  const saved = process.env.COLO_CHOOSE_STARTERS;
  delete process.env.COLO_CHOOSE_STARTERS;
  try {
    assert.equal(port.normalizeSettings({}).chooseStarters, true);
    assert.equal(env({}).COLO_CHOOSE_STARTERS, undefined);
    assert.equal(env({ chooseStarters: true }).COLO_CHOOSE_STARTERS, undefined);
    assert.equal(env({ chooseStarters: false }).COLO_CHOOSE_STARTERS, '0');
  } finally {
    if (saved !== undefined) process.env.COLO_CHOOSE_STARTERS = saved;
  }
});

test('TMs by move name are on unless turned off, and on leaves it to the game', () => {
  const env = settings => port.buildEnvironment(port.normalizeSettings(settings), 'disc', '/port');
  const saved = process.env.COLO_TM_NAMES;
  delete process.env.COLO_TM_NAMES;
  try {
    assert.equal(port.normalizeSettings({}).tmNames, true);
    assert.equal(env({}).COLO_TM_NAMES, undefined);
    assert.equal(env({ tmNames: true }).COLO_TM_NAMES, undefined);
    assert.equal(env({ tmNames: false }).COLO_TM_NAMES, '0');
    assert.equal(port.buildEnvironment(port.normalizeSettings({ tmNames: false }), 'disc', '/port', { game: 'xd' }).COLO_TM_NAMES, '0', 'XD has them too');
  } finally {
    if (saved !== undefined) process.env.COLO_TM_NAMES = saved;
  }
});

test('HD models are on unless turned off, and on leaves it to the game', () => {
  const env = hdModels => port.buildEnvironment(port.normalizeSettings({ hdModels }), 'disc', '/port').COLO_HD_MODELS;
  const saved = process.env.COLO_HD_MODELS;
  delete process.env.COLO_HD_MODELS;
  try {
    assert.equal(port.normalizeSettings({}).hdModels, true);
    assert.equal(env(undefined), undefined);
    assert.equal(env(true), undefined);
    assert.equal(env(false), '0');
  } finally { if (saved !== undefined) process.env.COLO_HD_MODELS = saved; }
});

test('battle speeds saved before the slider keep their speed, and Skip becomes the switch', () => {
  const saved = battleSpeed => {
    const { battleSpeed: speed, skipBattleAnimations: skip } = port.normalizeSettings({ battleSpeed });
    return [speed, skip];
  };
  assert.deepEqual(saved('normal'), [1, false]);
  assert.deepEqual(saved('2'), [2, false]);
  assert.deepEqual(saved('4'), [4, false]);
  assert.deepEqual(saved('8'), [5, false]);
  assert.deepEqual(saved('skip'), [1.5, true]);
  // Read again after saving, so Skip does not undo itself.
  const once = port.normalizeSettings({ battleSpeed: 'skip' });
  assert.deepEqual(port.normalizeSettings(once).skipBattleAnimations, true);
  assert.equal(port.normalizeSettings({ ...once, skipBattleAnimations: false }).skipBattleAnimations, false);
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

test('on Linux the game starts with the system\'s libdrm_amdgpu preloaded, after what LD_PRELOAD holds', () => {
  const lib = '/usr/lib/libdrm_amdgpu.so.1';
  assert.equal(port.gameRunCommand('/game', 'd.iso', 'linux', { HOME: '/h' }, lib).env.LD_PRELOAD, lib);
  const steam = 'ubuntu12_32/gameoverlayrenderer.so:ubuntu12_64/gameoverlayrenderer.so';
  assert.equal(port.gameRunCommand('/game', 'd.iso', 'linux', { LD_PRELOAD: steam }, lib).env.LD_PRELOAD, `${steam}:${lib}`);
  // A player's own preload of it stands, and no system copy leaves the environment as it is.
  const own = { LD_PRELOAD: '/usr/lib64/libdrm_amdgpu.so.1' };
  assert.equal(port.gameRunCommand('/game', 'd.iso', 'linux', own, lib).env, own);
  const none = { HOME: '/h' };
  assert.equal(port.gameRunCommand('/game', 'd.iso', 'linux', none, null).env, none);
  assert.equal('LD_PRELOAD' in port.gameRunCommand('/game', 'd.iso', 'darwin', { HOME: '/h' }, lib).env, false);
});

test('the system\'s libdrm_amdgpu is one for this processor, or none', () => {
  const found = port.systemLibdrmAmdgpu('x64');
  if (found) {
    const header = fs.readFileSync(found).subarray(0, 20);
    assert.equal(header[4], 2);
    assert.equal(header.readUInt16LE(18), 0x3e);
  }
  assert.equal(port.systemLibdrmAmdgpu('ia32'), null);
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

test('a Windows folder with an & in its path is found before the build, with what to do', () => {
  assert.equal(port.pathCharacterProblem('/Games & Stuff/game', { platform: 'linux' }), null);
  assert.equal(port.pathCharacterProblem('C:\\Games\\Colosseum Game', { platform: 'win32' }), null);
  const folder = 'E:\\Recomp & Decomp Games\\Colosseum Launcher\\Game';
  const problem = port.pathCharacterProblem(`${folder}\\Colosseum Game.releases\\1988204-abcd`, { platform: 'win32', folder });
  assert.equal(problem.kind, 'characters');
  assert.equal(problem.folder, folder);
  assert.deepEqual(problem.characters, ['&']);
  assert.match(problem.message, /folder holding the setup files's path has & in it/);
  assert.match(problem.message, /C:\\Games/);
  const caret = port.pathCharacterProblem('C:\\a^b\\x & y\\game', { platform: 'win32', folder: 'C:\\a^b\\x & y' });
  assert.deepEqual(caret.characters, ['^', '&']);
  // Only the game folder below the chosen one has it: that folder is the one shown.
  const below = port.pathCharacterProblem('C:\\Games\\Me & You\\game', { platform: 'win32', folder: 'C:\\Games' });
  assert.equal(below.folder, 'C:\\Games\\Me & You\\game');
  assert.match(below.message, /^The game folder's path/);
  const portable = port.pathCharacterProblem('D:\\A&B\\Colosseum-Launcher-Portable\\game',
    { platform: 'win32', folder: 'D:\\A&B\\Colosseum-Launcher-Portable', portable: true });
  assert.match(portable.message, /^The Colosseum-Launcher-Portable folder's path/);
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
