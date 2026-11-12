'use strict';

// Builds the game as the launcher does for a player, with only the private tools: the same checkout,
// build script and environment, from folders with spaces in their names. No disc image or game data is
// used, and no compiled game is uploaded: the game is started far enough to ask for its disc.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const buildTools = require('../src/build-tools');
const port = require('../src/port');
const game = require('../src/game-version');
const compilerCache = require('../src/compiler-cache');
const windowsDlls = require('../src/windows-dlls');
const games = require('../src/games');
// COLO_SMOKE_GAME=xd builds Pokémon XD from its pin (src/xd-release.json) instead of Colosseum's
const gameId = games.normalizeId(process.env.COLO_SMOKE_GAME || games.DEFAULT);
const pin = games.get(gameId).release;
const { execFileSync, spawnSync } = require('node:child_process');
const capture = async (command, args, cwd, env) => execFileSync(command, args, { cwd, env, encoding: 'utf8' }).trim();
const { run, runMain } = require('./tool-run');

const platform = process.platform;

// What the file's first bytes say it is.
function executableType(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const header = Buffer.alloc(64);
    fs.readSync(fd, header, 0, header.length, 0);
    if (header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])))
      return header[4] === 2 && header.readUInt16LE(18) === 62 ? 'ELF x86-64' : 'other ELF';
    if (header.readUInt32LE(0) === 0xfeedfacf)
      return { 0x01000007: 'Mach-O x86-64', 0x0100000c: 'Mach-O arm64' }[header.readUInt32LE(4)] || 'other Mach-O';
    if (header.readUInt16LE(0) === 0x5a4d) {
      const pe = Buffer.alloc(32);
      fs.readSync(fd, pe, 0, pe.length, header.readUInt32LE(0x3c));
      if (pe.readUInt32LE(0) === 0x4550) return pe.readUInt16LE(4) === 0x8664 ? 'PE x86-64' : 'other PE';
    }
    return 'unknown';
  } finally { fs.closeSync(fd); }
}
// (a Mac's game goes by the processor it runs on, unless it is a game for Rosetta: port.js, gameArch)
const EXPECTED = { linux: 'ELF x86-64', win32: 'PE x86-64', darwin: port.gameArch(process.arch, pin) === 'arm64' ? 'Mach-O arm64' : 'Mach-O x86-64' };

// Some players' System32 holds older DLLs named like the build tools' own (libwinpthread-1.dll, zlib1.dll...),
// which Windows loads before the PATH's: GCC then fails without a message. A real system DLL under those names
// stands in for them, so the build must get past them as the launcher's does.
const DECOYS = ['libwinpthread-1.dll', 'libgcc_s_seh-1.dll', 'zlib1.dll', 'libzstd.dll', 'libstdc++-6.dll'];

function plantSystemDecoys() {
  const planted = [];
  process.on('exit', () => { for (const file of planted) fs.rmSync(file, { force: true }); });
  const directory = path.join(process.env.SystemRoot, 'System32');
  for (const name of DECOYS.filter(name => !fs.existsSync(path.join(directory, name)))) {
    fs.copyFileSync(path.join(directory, 'version.dll'), path.join(directory, name));
    planted.push(path.join(directory, name));
  }
  process.stdout.write(`Planted stand-in system DLLs: ${planted.join(', ')}\n`);
}

function shieldBuildTools(toolRoot) {
  const result = windowsDlls.shieldToolchain(path.join(toolRoot, 'msys64'));
  if (result.errors.length) throw new Error(`Could not shield the build tools: ${result.errors.join('; ')}`);
  process.stdout.write(`Build tools' own DLLs placed beside their programs: ${result.placed.join(', ') || 'none needed'}\n`);
}

async function main() {
  const scratch = path.join(os.tmpdir(), 'Colosseum CI');
  const userData = path.join(scratch, 'Launcher Data');
  fs.rmSync(scratch, { recursive: true, force: true });
  fs.mkdirSync(userData, { recursive: true });
  const manifestFile = process.env.COLO_TOOL_ASSET_MANIFEST;
  const generated = manifestFile ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')) : null;
  const key = platform === 'darwin' ? process.arch : platform;
  const source = generated?.platforms[key] || null;
  if (source) {
    source.toolset ||= generated.toolset;
    require(platform === 'darwin' ? '../src/mac-tool-assets.json' : '../src/tool-assets.json').platforms[key] = source;
  }
  const archiveFile = source ? path.resolve(path.dirname(manifestFile), source.name) : null;
  await buildTools.prepare(userData, { forcePrivate: true, run, source, archiveFile,
    progress(percent, detail) {
      if (detail) process.stdout.write(`${detail}\n`);
      else if (percent !== null && percent % 10 === 0) process.stdout.write(`Download tools: ${percent}%\n`);
    } });
  const toolRoot = buildTools.rootFor(userData);
  // What a program opened from Finder or the desktop has: no development tools from the runner.
  const base = { ...process.env, PATH: platform === 'win32' ? path.join(process.env.SystemRoot, 'System32')
    : platform === 'darwin' ? '/usr/bin:/bin:/usr/sbin:/sbin' : '' };
  for (const name of ['CC', 'CXX', 'HOMEBREW_PREFIX', 'CPATH', 'LIBRARY_PATH']) delete base[name];
  if (platform === 'darwin') {
    const report = await buildTools.check(userData, { env: base, refresh: true });
    if (!report.ready || report.mode !== 'private') throw new Error(report.message);
    process.stdout.write(`Private Mac preflight passed with Finder's PATH: ${base.PATH}\n`);
  } else if (buildTools.status(userData).mode !== 'private') throw new Error('Private tools were not prepared.');
  if (platform === 'win32') {
    if (process.env.COLO_SMOKE_SYSTEM32_DECOYS === '1') plantSystemDecoys();
    shieldBuildTools(toolRoot);
  }
  const env = buildTools.environment(userData, base);
  if (platform === 'darwin') env.PATH = `${env.COLO_BUILD_TOOLS_BIN}:/usr/bin:/bin:/usr/sbin:/sbin`;
  const git = platform === 'win32' ? path.join(env.MSYS2_ROOT, 'usr', 'bin', 'git.exe') : path.join(toolRoot, 'env', 'bin', 'git');
  if (!fs.existsSync(git)) throw new Error(`Private Git is missing: ${git}`);
  if (platform === 'win32') {
    // Without CA certificates the texture download fails. Leave out the Windows store, which differs between computers.
    await run(path.join(env.MSYS2_ROOT, 'mingw64', 'bin', 'python.exe'), ['-I', '-c',
      'import ssl; c = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT); c.set_default_verify_paths(); ' +
      'n = c.cert_store_stats()["x509_ca"]; print(n, "CA certificates"); assert n > 50, "no CA certificates"'],
    { env }, 'Check the bundled Python\'s CA certificates');
  }
  const root = path.join(scratch, 'Game Files');
  await game.checkout(root, { git, run, capture, env, source: pin });
  if (!port.isPort(root, gameId)) throw new Error('The checkout is not a complete game folder.');
  if (!game.matchesSource(root, pin)) throw new Error(`The checkout does not match ${gameId}'s pin.`);
  // Through the caches, as a player's build goes: CI keeps them in COLO_COMPILER_CACHE_DIR between runs.
  const buildEnv = compilerCache.environment(env, await compilerCache.prepare(userData, { log: text => process.stdout.write(`${text}\n`) }),
    { userData, root });
  const cmd = port.buildCommand(root, platform, buildEnv, gameId);
  await game.buildSafely(root, path.join(scratch, 'Saves'), () => run(cmd.command, cmd.args, { cwd: cmd.cwd, env: cmd.env }, 'Build the game'),
    { backups: path.join(scratch, 'Backups'), toolFolder: toolRoot, source: pin });
  const { removed, bytes } = await compilerCache.trim(userData);
  process.stdout.write(`Unit cache: ${Math.round(bytes / 1048576)} MB kept, ${removed} files removed.\n`);
  const binary = port.binaryPath(root, platform, gameId);
  const type = executableType(binary);
  if (type !== EXPECTED[platform]) throw new Error(`The game is ${type}, not ${EXPECTED[platform]}.`);
  if (!game.isCurrent(root, pin)) throw new Error('The launcher does not take this build for the current game.');
  if (platform === 'win32') {
    const missing = windowsDlls.unresolved(binary, [path.dirname(binary)], { environment: base });
    if (missing === null || missing.length) throw new Error(`The game needs DLLs Windows does not have: ${missing}`);
  }
  const start = port.gameRunCommand(root, path.join(scratch, 'no disc here.iso'), platform,
    { ...base, COLO_AUDIO: '0', SMS_HEADLESS: '1' }, undefined, gameId);
  const started = spawnSync(start.command, start.args, { cwd: start.cwd, env: start.env, encoding: 'utf8', timeout: 120000 });
  process.stdout.write(`${started.stdout || ''}${started.stderr || ''}`);
  if (started.error) throw started.error;
  if (started.status !== 1 || !/disc image needed/.test(started.stderr))
    throw new Error(`The game did not reach its disc check (exit ${started.status}, signal ${started.signal}).`);
  process.stdout.write(`${games.get(gameId).name}: ${type} built and reached its disc check.\n`);
  fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 });
}

runMain(main);
