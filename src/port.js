'use strict';

const fs = require('node:fs');
const path = require('node:path');
const bindings = require('./bindings');
const presets = require('./presets');
const randomizer = require('./randomizer');
const { normalizeChannel } = require('./update-channel');
const { prependWindowsPath } = require('./windows-path');
const { describe } = require('./disc');

const PORT_URL = 'https://git.softwareauralabs.com/chase/pokemon-colosseum.git';
// The HD texture pack: the port's own release, unpacked into mods/textures/colo-upscale-4x.
const TEXTURE_PACK = require('./texture-pack.json');
const release = require('./game-release.json');

// The processor the game is built for. A game marked "rosetta" in game-release.json predates the native
// build: it is x86-64 everywhere, and a Mac with Apple Silicon runs it through Rosetta 2. Stable keeps
// that game until its pin moves; Beta's newest game has no mark (scripts/pin-game.js).
function gameArch(cpu = process.arch, game = release) { return game.rosetta ? 'x64' : cpu; }

// The game is built on the computer that plays it, for that computer: x86-64, and on a Mac with Apple
// Silicon native arm64, drawn with Metal (the port's build.sh goes by the processor it runs on). The
// first renderer is the system's default. Metal is Apple Silicon's alone: an Intel Mac stays on Vulkan.
function platformInfo(platform = process.platform, arch = gameArch()) {
  if (platform === 'linux') return { name: 'Linux', id: 'linux', renderers: ['vulkan', 'opengl'] };
  if (platform === 'darwin') return { name: 'macOS', id: 'macos', renderers: arch === 'arm64' ? ['metal', 'vulkan', 'opengl'] : ['vulkan', 'opengl'] };
  if (platform === 'win32') return { name: 'Windows', id: 'windows', renderers: ['vulkan', 'opengl'] };
  throw new Error(`This port does not support ${platform}.`);
}

// What the game checkout holds beside the port: the decomp it compiles and, for an older port, the renderer's sources.
function dependencyPaths(root) {
  return { decomp: path.join(root, 'deps', 'pkmn-colosseum'), renderer: path.join(root, 'deps', 'sms-pc-port') };
}

function isPort(root) {
  return Boolean(root && ['build.sh', 'run.sh', path.join('tools', 'befix.py'), path.join('deps', 'pkmn-colosseum', 'configure.py')]
    .every(file => fs.existsSync(path.join(root, file))));
}

const OWN_DISC = 'Choose a copy of your own North American Pokémon Colosseum disc (GC6E01) as an ISO or GCM file.';
const CONVERT = 'In Dolphin, right-click the game, choose Convert File, set the format to ISO, and choose the .iso it makes.';
const OTHER_FORMATS = {
  ciso: `This is a CISO file, a compressed format the game can't read. ${CONVERT}`,
  'damaged-ciso': `This is a CISO file, a compressed format the game can't read. ${CONVERT}`,
  rvz: `This is an RVZ file, a compressed format the game can't read. ${CONVERT}`,
  wia: `This is a WIA file, a compressed format the game can't read. ${CONVERT}`,
  gcz: `This is a GCZ file, a compressed format the game can't read. ${CONVERT}`,
  zip: 'This is a ZIP archive. Extract the disc file inside it first, and choose that.',
  '7z': 'This is a 7-Zip archive. Extract the disc file inside it first, and choose that.',
  rar: 'This is a RAR archive. Extract the disc file inside it first, and choose that.',
  wbfs: `This is a Wii disc file, not a GameCube one. ${OWN_DISC}`,
  wii: `This is a Wii disc file, not a GameCube one. ${OWN_DISC}`,
  unknown: `This isn't a GameCube disc file. ${OWN_DISC}`
};
const REGIONS = { GC6P01: 'European', GC6J01: 'Japanese' };
const megabytes = bytes => `${Math.round(bytes / 1048576).toLocaleString('en-US')} MB`;

// The player's disc, identified by its contents: the original North American
// release, holding everything the game reads. Other files get a reason that
// names what they are and what to do instead.
function validateRom(file) {
  if (!file || typeof file !== 'string') throw new Error('Choose your own game disc file first.');
  const absolute = path.resolve(file);
  let stat;
  try { stat = fs.statSync(absolute); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error('That game file cannot be found. Choose it again.');
    throw error;
  }
  if (!stat.isFile()) throw new Error('Choose a game disc file, not a folder.');
  const disc = describe(absolute);
  if (OTHER_FORMATS[disc.format]) throw new Error(OTHER_FORMATS[disc.format]);
  if (REGIONS[disc.gameId])
    throw new Error(`This is the ${REGIONS[disc.gameId]} release of Pokémon Colosseum (${disc.gameId}). ${OWN_DISC}`);
  if (disc.gameId !== 'GC6E01')
    throw new Error(`This is ${disc.title ? `"${disc.title}"` : 'another game'} (${disc.gameId}), not Pokémon Colosseum. ${OWN_DISC}`);
  if (disc.revision !== 0)
    throw new Error(`This is revision ${disc.revision} of Pokémon Colosseum; the game needs the original release (GC6E01, revision 0). ${OWN_DISC}`);
  const again = 'It may not have finished copying. Copy it from your disc again, and choose the new file.';
  if (disc.needed === null) throw new Error(`This game disc file is incomplete or damaged. ${again}`);
  if (disc.size < disc.needed)
    throw new Error(`This game disc file is incomplete: it's ${megabytes(disc.size)}, but the game needs ${megabytes(disc.needed)}. ${again}`);
  return absolute;
}

// A whole-number setting within lo..hi, or the fallback when unset or unreadable.
function numberSetting(value, fallback, lo, hi) {
  const number = value === null || value === '' || value === undefined ? NaN : Number(value);
  return Number.isFinite(number) ? Math.min(hi, Math.max(lo, Math.round(number))) : fallback;
}
function choiceSetting(value, choices, fallback) { return choices.includes(value) ? value : fallback; }

function normalizeSettings(input = {}, platform = process.platform, arch = gameArch()) {
  const info = platformInfo(platform, arch);
  const settings = {
    // How wide the 3D view is: as wide as the window, a fixed shape, or the original 4:3. Menus and movies keep their shape.
    widescreen: choiceSetting(input.widescreen, ['auto', '16:9', '16:10', '21:9', '4:3'], 'auto'),
    // Battle status panels and title portraits at the screen's edges, or in the 4:3 middle.
    hudEdges: input.hudEdges !== false,
    resolution: [1, 2, 3, 4].includes(Number(input.resolution)) ? Number(input.resolution) : 4,
    frameRate: [30, 60].includes(Number(input.frameRate)) ? Number(input.frameRate) : 60,
    fullscreen: Boolean(input.fullscreen),
    // Borderless (desktop) fullscreen, or exclusive, which switches the display to exclusiveResolution.
    fullscreenMode: choiceSetting(input.fullscreenMode, ['desktop', 'exclusive'], 'desktop'),
    exclusiveResolution: /^\d{3,5}x\d{3,5}$/.test(String(input.exclusiveResolution)) ? String(input.exclusiveResolution) : 'desktop',
    // The monitor under the mouse (usually the launcher's), the primary one, or another.
    display: /^monitor([2-9]|1[0-6])$/.test(String(input.display)) ? String(input.display)
      : choiceSetting(input.display, ['launcher', 'primary'], 'launcher'),
    vsync: choiceSetting(input.vsync, ['off', 'on', 'adaptive'], 'off'),
    skipMovies: Boolean(input.skipMovies),
    // How a battle's animations play: as on the disc, 2 or 4 times faster, or skipped.
    // Beta launchers offered 8 times faster: those players keep the fastest speed left.
    battleSpeed: choiceSetting(input.battleSpeed === '8' ? '4' : input.battleSpeed, ['normal', '2', '4', 'skip'], '2'),
    // The frame-time overlay at start.
    overlay: Boolean(input.overlay),
    // The fonts drawn sharp from the Inter typeface (on), the game's own upscaled, or as on the disc.
    hdText: choiceSetting(input.hdText, ['on', 'upscaled', 'off'], 'on'),
    // Controllers keep playing while another window has focus; off unless chosen.
    backgroundInput: Boolean(input.backgroundInput),
    // Each controller its own player (Battle Mode), or every controller player 1.
    padMode: choiceSetting(input.padMode, ['players', 'single'], 'players'),
    // Picture: anti-aliasing, texture filtering, sharpening, brightness (percent; 100 unchanged), fit and scaler.
    msaa: [0, 2, 4, 8].includes(Number(input.msaa)) ? Number(input.msaa) : 0,
    fxaa: Boolean(input.fxaa),
    anisotropic: [0, 2, 4, 8, 16].includes(Number(input.anisotropic)) ? Number(input.anisotropic) : 16,
    sharpen: numberSetting(input.sharpen, 0, 0, 100),
    brightness: numberSetting(input.brightness, 100, 50, 200),
    aspect: choiceSetting(input.aspect, ['keep', 'stretch', 'integer'], 'keep'),
    presentFilter: choiceSetting(input.presentFilter, ['bilinear', 'sharp', 'nearest', 'fsr', 'nis'], 'bilinear'),
    fsrMode: choiceSetting(input.fsrMode, ['native', 'quality', 'balanced', 'performance', 'ultraperformance'], 'quality'),
    textures: input.textures !== false,
    // People in the field drawn with their detailed models, made from the disc.
    hdModels: input.hdModels !== false,
    // When HD textures load: while each area loads (stage), the whole pack and kept (all), or each when first drawn (play).
    textureLoading: choiceSetting(input.textureLoading, ['stage', 'all', 'play'], 'stage'),
    shaderWarmup: input.shaderWarmup !== false,
    renderer: choiceSetting(input.renderer, info.renderers, info.renderers[0]),
    autoUpdate: input.autoUpdate !== false,
    updateChannel: normalizeChannel(input.updateChannel),
    // Save backups the launcher makes by itself (before and after play, before updates and cleanup).
    autoBackups: input.autoBackups !== false,
    // Anonymous usage heartbeats (src/telemetry.js). The online count shows either way.
    shareUsage: input.shareUsage !== false,
    darkMode: Boolean(input.darkMode),
    // Keys and controller buttons the player changed in Settings → Controls; the rest stay the game's defaults.
    keyBindings: bindings.normalize(input.keyBindings),
    padBindings: bindings.normalizePads(input.padBindings),
    // How far a controller's sticks move before the game sees them, in percent (10 is the game's own).
    stickDeadzone: numberSetting(input.stickDeadzone, 10, 0, 50),
    // How far an analog trigger goes before it counts as L or R pressed, in percent.
    triggerClick: numberSetting(input.triggerClick, 85, 10, 100),
    // Controller rumble in percent: 0 turns it off.
    rumbleStrength: numberSetting(input.rumbleStrength, 100, 0, 100),
    // What a new save randomizes (randomizer.js): a save keeps the seed it starts with.
    ...randomizer.normalize(input)
  };
  // The graphics preset chosen (src/presets.js), while the picture settings still match it; else Custom.
  settings.graphicsPreset = presets.reconcile({ ...settings, graphicsPreset: input.graphicsPreset });
  return settings;
}

// Metal became Apple Silicon's renderer after Vulkan: a Vulkan saved before that was the default, not a
// choice, so it moves over once. `moved` is the config's own flag, as the settings hold only what
// Settings shows: a player who goes back to Vulkan afterwards stays there.
function moveToMetal(settings, moved, platform = process.platform, arch = gameArch()) {
  return platformInfo(platform, arch).renderers[0] === 'metal' && !moved && settings.renderer === 'vulkan' ? { ...settings, renderer: 'metal' } : settings;
}

function texturePackDirectory(root) { return path.join(root, 'mods', 'textures'); }

// The pack this launcher pins, unpacked in full (install-textures.py writes the marker last).
function texturePackInstalled(root) {
  try {
    const marker = JSON.parse(fs.readFileSync(path.join(texturePackDirectory(root), TEXTURE_PACK.folder, '.release'), 'utf8'));
    return marker.sha256 === TEXTURE_PACK.sha256;
  } catch (_) { return false; }
}

function hdVisualsInstalled(root, settings) { return !settings.textures || texturePackInstalled(root); }

// Custom textures: texture packs the player adds, made for Dolphin's "Load Custom Textures" (tex1_*.png or .dds
// in any sub-folder), in a folder of the launcher's own, so a new game folder keeps them.
function customTextureDirectory(userData) { return path.join(userData, 'custom-textures'); }

// Whether a folder holds a texture the game would read. Folders linked in count, as the game follows them.
function customTexturesPresent(directory) {
  const pending = [directory], seen = new Set();
  while (pending.length) {
    const folder = pending.pop();
    let entries, real;
    try { real = fs.realpathSync(folder); entries = fs.readdirSync(folder, { withFileTypes: true }); } catch (_) { continue; }
    if (seen.has(real)) continue;
    seen.add(real);
    for (const entry of entries) {
      const file = path.join(folder, entry.name);
      let kind = entry;
      if (entry.isSymbolicLink()) try { kind = fs.statSync(file); } catch (_) { continue; }
      if (kind.isFile() && /^tex1_.*\.(?:dds|png)$/i.test(entry.name)) return true;
      if (kind.isDirectory()) pending.push(file);
    }
  }
  return false;
}

// The texture folders the game reads, first match wins: the player's custom textures, then the HD pack.
function texturePackFolders(settings, root, customTextures) {
  const folders = [];
  if (customTextures && customTexturesPresent(customTextures)) folders.push(customTextures);
  if (settings.textures) folders.push(texturePackDirectory(root));
  return folders;
}

// What the game reads when it starts, as run.sh and run.cmd set it up. `customTextures` is the custom
// textures folder, for playing (texturePackFolders).
function buildEnvironment(settings, disc, root, { customTextures = null } = {}) {
  if (!root) throw new Error('The port folder is required to configure texture packs.');
  const env = {
    ...process.env,
    COLO_DISC: disc,
    SMS_GX_BACKEND: settings.renderer,
    SMS_GX_SCALE: String(settings.resolution),
    COLO_FPS: String(settings.frameRate),
    COLO_WIDESCREEN: settings.widescreen,
    COLO_WIDESCREEN_HUD: settings.hudEdges === false ? 'center' : 'edges',
    SMS_FULLSCREEN: settings.fullscreen ? (settings.fullscreenMode === 'exclusive' ? 'exclusive' : '1') : '0',
    SMS_FULLSCREEN_TYPE: settings.fullscreenMode === 'exclusive' ? 'exclusive' : 'desktop',
    SMS_VSYNC: settings.vsync === 'adaptive' ? 'adaptive' : settings.vsync === 'on' ? '1' : '0',
    SMS_OVERLAY: settings.overlay ? '1' : '0',
    COLO_BACKGROUND_INPUT: settings.backgroundInput ? '1' : '0',
    COLO_PADS: settings.padMode === 'single' ? 'single' : 'players',
    COLO_STICK_DEADZONE: String(settings.stickDeadzone ?? 10),
    COLO_TRIGGER_CLICK: String(settings.triggerClick ?? 85),
    COLO_RUMBLE: settings.rumbleStrength === 0 ? '0' : '1',
    COLO_RUMBLE_STRENGTH: String(settings.rumbleStrength ?? 100),
    SMS_MSAA: String(settings.msaa ?? 0),
    SMS_FXAA: settings.fxaa ? '1' : '0',
    SMS_ANISO: String(settings.anisotropic ?? 16),
    SMS_SHARPEN: String(settings.sharpen ?? 0),
    SMS_GAMMA: ((settings.brightness ?? 100) / 100).toFixed(2),
    SMS_ASPECT: settings.aspect || 'keep',
    SMS_PRESENT_FILTER: settings.presentFilter || 'bilinear',
    SMS_FSR_MODE: settings.fsrMode || 'quality',
    // The game splits the list at ';' (and at ':' outside a drive letter) on every system.
    SMS_TEXTURE_PACKS: texturePackFolders(settings, root, customTextures).join(';') || '0',
    SMS_TEXTURE_PACK_PRELOAD: { all: 'all', play: '0' }[settings.textureLoading] || '1',
    // Video memory kept for HD textures, as run.sh has it.
    SMS_TEXTURE_PACK_MB: '3000',
    SMS_GX_SHADER_WARMUP: settings.shaderWarmup === false ? '0' : '1'
  };
  if (settings.skipMovies) env.COLO_SKIP_MOVIES = '1';
  const run = randomizer.environmentValue(settings);
  if (run) env.COLO_RANDOMIZER = run;
  if (settings.hdModels === false) env.COLO_HD_MODELS = '0';
  if (settings.battleSpeed !== 'normal') env.COLO_BATTLE_SPEED = settings.battleSpeed;
  // Unset is the default; any other value would name a glyph file.
  if (settings.hdText !== 'on') env.COLO_HD_TEXT = settings.hdText === 'off' ? '0' : 'upscaled';
  if (/^\d+x\d+$/.test(settings.exclusiveResolution || '')) env.SMS_FULLSCREEN_MODE = settings.exclusiveResolution;
  if (settings.display === 'primary') env.SMS_DISPLAY = '0';
  else if (/^monitor\d+$/.test(settings.display || '')) env.SMS_DISPLAY = String(Number(settings.display.slice(7)) - 1);
  return env;
}

function binaryPath(root, platform = process.platform) {
  return path.join(root, 'build', platform === 'win32' ? 'colosseum.exe' : 'colosseum');
}

// MinGW's compiler can't open a path of 260 characters or more. The deepest file a Windows build writes
// is an object's dependency file below the game folder, and the mirror of the decomp's source is as deep.
const WINDOWS_GAME_PATH_LIMIT = 150;

// The compiler's own headers count too: GCC opens them through its install prefix as is
// (mingw64/bin/../lib/gcc/x86_64-w64-mingw32/16.2.0/../../../../include/c++/16.2.0/…), so a header
// that is there fails with "No such file or directory".
const WINDOWS_MSYS2_PATH_LIMIT = 136;
const WINDOWS_MAX_PATH = 259;

// When a Windows build would fail because a path is too long: the folder the
// player can move (the portable folder) or choose (the one holding the setup
// files), how long its path is and may be, and what to do; otherwise null.
function longPathProblem(root, { platform = process.platform, portable = false,
  folder = path.win32.dirname(root), msys = '' } = {}) {
  if (platform !== 'win32' || !root) return null;
  const inside = file => file.length > folder.length && file.startsWith(folder) && /[\\/]/.test(file[folder.length]);
  const limit = Math.min(...[[root, WINDOWS_GAME_PATH_LIMIT], [msys, WINDOWS_MSYS2_PATH_LIMIT]]
    .filter(([file]) => file && inside(file)).map(([file, most]) => most - (file.length - folder.length)));
  if (folder.length <= limit) return null;
  const name = portable ? 'The Colosseum-Launcher-Portable folder' : 'The folder holding the setup files';
  const fix = portable
    ? 'Move the launcher and its Colosseum-Launcher-Portable folder together to a short folder such as C:\\Games, and open it from there.'
    : 'Choose a shorter folder for Setup files in Settings, such as C:\\Games.';
  return { folder, length: folder.length, limit, deepest: WINDOWS_MAX_PATH - limit, portable,
    message: `${name}'s path is ${folder.length} characters long, more than the ${limit} Windows can build ` +
      `the game in, so the build would fail: Windows' compiler can't open paths of ` +
      `260 characters or more, and the build reaches ${WINDOWS_MAX_PATH - limit} characters deeper than this folder. ${fix}` };
}

function playableInstall(saved, platform = process.platform) {
  if (!saved.repo || !saved.settings) return null;
  const settings = normalizeSettings(saved.settings, platform);
  if (!fs.existsSync(binaryPath(saved.repo, platform))) return null;
  return { repo: saved.repo, settings, rom: saved.rom, saveDirectory: saved.saveDirectory || null };
}

// The MSYS shell's environment: the MinGW tools ahead of the Windows path.
function msysEnvironment(msys, environment) {
  return { ...prependWindowsPath(environment, [path.join(msys, 'mingw64', 'bin'), path.join(msys, 'usr', 'bin')]),
    MSYSTEM: 'MINGW64', CHERE_INVOKING: '1' };
}

// The launcher's own scripts: in its resources once packaged. The portable launcher runs them from its
// own copy (useLauncherScripts), since its resources sit in a temporary folder that opening the .exe a
// second time deletes while this one is still running.
let launcherScripts = null;
function useLauncherScripts(directory) { launcherScripts = directory; }

function launcherScript(name) {
  if (launcherScripts && fs.existsSync(path.join(launcherScripts, name))) return path.join(launcherScripts, name);
  return __dirname.includes('app.asar') ? path.join(process.resourcesPath, 'scripts', name) : path.resolve(__dirname, '..', 'scripts', name);
}

function msysBash(environment) {
  const msys = environment.MSYS2_ROOT || 'C:\\msys64';
  const bash = path.join(msys, 'usr', 'bin', 'bash.exe');
  if (!fs.existsSync(bash)) throw new Error(`The Windows build tools are missing. Install them at ${msys} or set MSYS2_ROOT.`);
  return { msys, bash };
}

// build-colosseum.sh: the decomp's build file once, then the port's build.sh with its dependencies named.
function buildCommand(root, platform = process.platform, environment = process.env) {
  const script = launcherScript('build-colosseum.sh');
  if (platform !== 'win32') return { command: '/bin/sh', args: [script, root], cwd: root, env: environment };
  const { msys, bash } = msysBash(environment);
  return { command: bash, args: ['-c', 'exec sh "$(cygpath -u "$1")" "$(cygpath -u "$2")"', 'colosseum-launcher', script, root],
    cwd: root, env: msysEnvironment(msys, environment) };
}

// install-textures.py: downloads the pinned pack, checks it and unpacks it, reporting as it goes.
function textureCommand(root, platform = process.platform, environment = process.env) {
  const args = [launcherScript('install-textures.py'), texturePackDirectory(root), TEXTURE_PACK.url, TEXTURE_PACK.sha256,
    String(TEXTURE_PACK.size), TEXTURE_PACK.folder];
  if (platform !== 'win32') return { command: 'python3', args, cwd: root, env: environment };
  const { msys } = msysBash(environment);
  return { command: path.join(msys, 'mingw64', 'bin', 'python.exe'), args, cwd: root, env: msysEnvironment(msys, environment) };
}

// The game itself, started directly: MSYS bash translates many native exception statuses to 127, which
// hides the cause of a crash. It reads bindings.txt and mods/ from its working folder, the game folder.
function gameRunCommand(root, disc, platform = process.platform, environment = process.env) {
  const binary = binaryPath(root, platform);
  if (platform !== 'win32') return { command: binary, args: [disc], cwd: root, env: environment };
  return { command: binary, args: [disc], cwd: root, env: prependWindowsPath(environment, gameRuntimeFolders(environment)) };
}

// Where the Windows game's DLLs come from: it links them in, so only a game built without that needs these.
function gameRuntimeFolders(environment = process.env) {
  return [path.join(environment.MSYS2_ROOT || 'C:\\msys64', 'mingw64', 'bin')];
}

module.exports = { PORT_URL, TEXTURE_PACK, gameArch, platformInfo, dependencyPaths, isPort, validateRom, normalizeSettings, moveToMetal,
  texturePackDirectory, texturePackInstalled, hdVisualsInstalled, customTextureDirectory, customTexturesPresent, texturePackFolders,
  buildEnvironment, binaryPath, longPathProblem, playableInstall, useLauncherScripts, launcherScript,
  buildCommand, textureCommand, gameRunCommand, gameRuntimeFolders };
