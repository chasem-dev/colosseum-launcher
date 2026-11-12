'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const game = require('../src/game-version');
const port = require('../src/port');
const tools = require('../src/build-tools');
const { TOOL_FIXTURE } = require('./tool-fixture');

TOOL_FIXTURE();
const source = game.release;

function folder(t, prefix = 'colo game version-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

// A game folder at this release's commits with a built game, as Git leaves them.
function fixture(t) {
  const root = folder(t);
  const { decomp, renderer } = port.dependencyPaths(root);
  for (const [directory, commit] of [[root, source.commit], [decomp, source.decomp], ...(source.renderer ? [[renderer, source.renderer.commit]] : [])]) {
    fs.mkdirSync(path.join(directory, '.git'), { recursive: true });
    fs.writeFileSync(path.join(directory, '.git', 'HEAD'), `${commit}\n`);
  }
  const binary = port.binaryPath(root);
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, 'previous playable game');
  return { root, binary, directory: path.dirname(binary), saves: path.join(root, 'saves'), backups: path.join(root, 'backups') };
}

const build = (root, saves, compile, extra = {}) => game.buildSafely(root, saves, compile, { backups: path.join(root, 'backups'), ...extra });

test('a build is current only with the record of this release and these commits', async t => {
  const { root, binary, saves } = fixture(t);
  assert.equal(game.isCurrent(root), false, 'no record');
  await build(root, saves, async () => { fs.mkdirSync(path.dirname(binary)); fs.writeFileSync(binary, 'new game'); });
  assert.equal(game.isCurrent(root), true);
  assert.equal(game.installed(root).gameVersion, source.version);
  for (const change of [{ ...source, commit: 'a'.repeat(40) }, { ...source, decomp: 'b'.repeat(40) },
    { ...source, renderer: { ...source.renderer, commit: 'c'.repeat(40) } }])
    assert.equal(game.isCurrent(root, change), false);
});

test('a build that ends without a game restores the one before, and says so', async t => {
  const { root, binary, directory, saves } = fixture(t);
  await assert.rejects(build(root, saves, async () => {}), /without a playable game/);
  assert.equal(fs.readFileSync(binary, 'utf8'), 'previous playable game');
  await assert.rejects(build(root, saves, async () => { throw new Error('compiler failed'); }), /compiler failed/);
  assert.equal(fs.readFileSync(binary, 'utf8'), 'previous playable game');
  assert.equal(fs.existsSync(`${directory}.launcher-transaction.json`), false);
});

test('setup interrupted by closing the app recovers the earlier game on the next start', t => {
  const { root, binary, directory } = fixture(t);
  const previous = `${directory}.previous-0f8fad5b-d9cb-469f-a165-70867728950e`;
  fs.renameSync(directory, previous);
  fs.mkdirSync(directory);
  fs.writeFileSync(`${directory}.launcher-transaction.json`, JSON.stringify({ directory, previous }));
  assert.equal(game.recoverBuild(root), true);
  assert.equal(fs.readFileSync(binary, 'utf8'), 'previous playable game');
  assert.equal(game.recoverBuild(root), false);
});

test('a recovery record pointing elsewhere is refused', t => {
  const { root, directory } = fixture(t);
  fs.writeFileSync(`${directory}.launcher-transaction.json`, JSON.stringify({ directory, previous: '/somewhere/else' }));
  assert.throws(() => game.recoverBuild(root), /invalid/);
});

test('what a rebuild left beside the build is removed, unless a build is under way or it holds a kept path', async t => {
  const { root, directory } = fixture(t);
  const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
  const leftover = name => { fs.mkdirSync(path.join(root, name)); return path.join(root, name); };
  const failed = leftover(`build.failed-${id}`);
  const kept = leftover(`build.previous-${id}`);
  fs.mkdirSync(path.join(kept, 'card'));
  assert.deepEqual(await game.pruneBuildLeftovers(root, [path.join(kept, 'card')]), [failed]);
  assert.equal(fs.existsSync(kept), true);
  fs.writeFileSync(`${directory}.launcher-transaction.json`, '{}');
  assert.deepEqual(await game.pruneBuildLeftovers(root), []);
  fs.rmSync(`${directory}.launcher-transaction.json`);
  assert.deepEqual(await game.pruneBuildLeftovers(root), [kept]);
});

test('a new version shares the HD textures of the one before', t => {
  const home = folder(t);
  const first = path.join(home, 'first'), next = path.join(home, 'next');
  fs.mkdirSync(path.join(first, 'mods', 'textures'), { recursive: true });
  fs.writeFileSync(path.join(first, 'mods', 'textures', 'tex1_test.png'), 'texture');
  fs.mkdirSync(next);
  assert.deepEqual(game.carryUserFiles(first, next), []);
  assert.equal(fs.readFileSync(path.join(next, 'mods', 'textures', 'tex1_test.png'), 'utf8'), 'texture');
  assert.deepEqual(game.carryUserFiles(next, next), []);
});

test('on a drive without links the HD textures move to the new version, and back if the update fails', t => {
  const home = folder(t);
  const first = path.join(home, 'first'), next = path.join(home, 'next');
  fs.mkdirSync(path.join(first, 'mods', 'textures'), { recursive: true });
  fs.writeFileSync(path.join(first, 'mods', 'textures', 'tex1_test.png'), 'texture');
  fs.mkdirSync(next);
  // Windows making a junction on exFAT or FAT32: ERROR_INVALID_FUNCTION, which Node reports as EISDIR.
  t.mock.method(fs, 'symlinkSync', () => { throw Object.assign(new Error('EISDIR: illegal operation on a directory, symlink'), { code: 'EISDIR' }); });
  const moved = game.carryUserFiles(first, next);
  assert.equal(moved.length, 1);
  assert.equal(fs.readFileSync(path.join(next, 'mods', 'textures', 'tex1_test.png'), 'utf8'), 'texture');
  assert.equal(fs.existsSync(path.join(first, 'mods', 'textures')), false);
  game.restoreUserFiles(moved);
  assert.equal(fs.readFileSync(path.join(first, 'mods', 'textures', 'tex1_test.png'), 'utf8'), 'texture');
  assert.equal(fs.existsSync(path.join(next, 'mods', 'textures')), false);
});

test('a link that fails for another reason is reported, and nothing moves', t => {
  const home = folder(t);
  const first = path.join(home, 'first'), next = path.join(home, 'next');
  fs.mkdirSync(path.join(first, 'mods', 'textures'), { recursive: true });
  fs.mkdirSync(next);
  t.mock.method(fs, 'symlinkSync', () => { throw Object.assign(new Error('ENOSPC: no space left on device, symlink'), { code: 'ENOSPC' }); });
  assert.throws(() => game.carryUserFiles(first, next), { code: 'ENOSPC' });
  assert.equal(fs.existsSync(path.join(first, 'mods', 'textures')), true);
});

test('a link left pointing at a removed version is replaced, not tripped over', t => {
  const home = folder(t);
  const gone = path.join(home, 'gone'), first = path.join(home, 'first'), next = path.join(home, 'next');
  fs.mkdirSync(path.join(gone, 'mods', 'textures'), { recursive: true });
  fs.mkdirSync(path.join(first, 'mods', 'textures'), { recursive: true });
  fs.mkdirSync(path.join(next, 'mods'), { recursive: true });
  fs.symlinkSync(path.join(gone, 'mods', 'textures'), path.join(next, 'mods', 'textures'), process.platform === 'win32' ? 'junction' : 'dir');
  fs.rmSync(gone, { recursive: true });
  game.carryUserFiles(first, next);
  assert.equal(fs.realpathSync(path.join(next, 'mods', 'textures')), fs.realpathSync(path.join(first, 'mods', 'textures')));
});

test('old game versions are removed, keeping the current and previous ones and the textures they link to', async t => {
  const home = folder(t, 'colo prune-');
  const base = path.join(home, 'game');
  const version = name => {
    const root = path.join(`${base}.releases`, name);
    fs.mkdirSync(path.join(root, 'mods'), { recursive: true });
    return root;
  };
  fs.mkdirSync(path.join(base, 'mods'), { recursive: true });
  const oldest = version('a-oldest');
  fs.mkdirSync(path.join(oldest, 'mods', 'textures'));
  fs.writeFileSync(path.join(oldest, 'mods', 'textures', 'tex1_test.png'), 'textures');
  const previous = version('b-previous');
  game.carryUserFiles(oldest, previous);
  const current = version('c-current');
  game.carryUserFiles(previous, current);
  const withSaves = version('d-saves');
  fs.mkdirSync(path.join(withSaves, 'card'));
  const errors = [];
  const removed = await game.pruneSnapshots(base, [current, previous], [path.join(withSaves, 'card'), null], error => errors.push(error));
  assert.deepEqual(errors, []);
  assert.deepEqual(removed, [oldest]);
  for (const root of [previous, current])
    assert.equal(fs.readFileSync(path.join(root, 'mods', 'textures', 'tex1_test.png'), 'utf8'), 'textures');
  assert.deepEqual(await game.pruneSnapshots(path.join(home, 'missing'), [current]), []);
});

test('the first install goes once updates replaced it, only if the launcher downloaded it', async t => {
  const home = folder(t);
  const base = path.join(home, 'game');
  const kept = path.join(`${base}.releases`, 'current');
  fs.mkdirSync(kept, { recursive: true });
  fs.mkdirSync(base);
  assert.deepEqual(await game.pruneSnapshots(base, [kept]), [], "a folder the player chose stays");
  fs.writeFileSync(path.join(base, 'launcher-source.json'), '{}');
  assert.deepEqual(await game.pruneSnapshots(base, [kept]), [path.resolve(base)]);
});

test('game folders are named by a short commit and a hash of the rest, to keep Windows paths short', () => {
  const name = path.basename(game.snapshotPath('/game'));
  assert.match(name, new RegExp(`^${source.commit.slice(0, 7)}-[a-f0-9]{4}$`));
  assert.equal(path.dirname(game.snapshotPath('/game')), path.normalize('/game.releases'));
  assert.notEqual(game.snapshotPath('/game'), game.snapshotPath('/game', { ...source, decomp: 'b'.repeat(40) }));
});

test('each OS and Mac architecture has its tool version in a game\'s identity', () => {
  for (const [platform, arch] of [['linux', 'x64'], ['win32', 'x64'], ['darwin', 'x64'], ['darwin', 'arm64']]) {
    const identity = game.identity(platform, arch);
    assert.equal(identity.platform, platform);
    assert.equal(identity.toolVersion, tools.toolsetFor(platform, arch));
    assert.equal(identity.toolSha256, tools.assetFor(platform, arch).sha256);
    assert.equal(identity.renderer, source.renderer?.commit ?? null);
  }
});

// Real repositories, and the real Git commands a player's launcher runs.
function repository(home, name, files) {
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
  const first = git('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(directory, 'newer.txt'), 'a later commit');
  git('add', '-A');
  git('commit', '-q', '-m', 'second');
  return { url: `file://${directory}`, first };
}

function sourceFrom(home, portFiles = {}) {
  const port_ = repository(home, 'port', { 'build.sh': '', 'run.sh': '', 'tools/befix.py': '', 'tools/link.py': '# the link\n', ...portFiles });
  const decomp = repository(home, 'decomp', { 'configure.py': '' });
  const renderer = repository(home, 'renderer', { 'src/port.h': '' });
  const headers = repository(home, 'headers', { 'include/dolphin.h': '' });
  return { version: 'test', repository: port_.url, branch: 'main', commit: port_.first, decompRepository: decomp.url, decomp: decomp.first,
    renderer: { repository: renderer.url, commit: renderer.first, decompRepository: headers.url, decomp: headers.first } };
}

const runner = cwdEnv => ({
  run: async (command, args, options = {}) => { execFileSync(command, args, { cwd: options.cwd, env: options.env, stdio: 'ignore' }); },
  capture: async (command, args, cwd) => execFileSync(command, args, { cwd, encoding: 'utf8' }).trim(), env: cwdEnv });

test('the game folder is the port with the decomp and renderer inside it, each at its exact commit', { skip: process.platform === 'win32' }, async t => {
  const home = folder(t, 'colo checkout-');
  const pinned = sourceFrom(home);
  const root = path.join(home, 'Game Files');
  await game.checkout(root, { ...runner(process.env), source: pinned });
  assert.equal(port.isPort(root), true);
  assert.equal(game.matchesSource(root, pinned), true);
  assert.equal(fs.existsSync(path.join(root, 'newer.txt')), false, 'the pinned commit, not the newest');
  assert.equal(fs.existsSync(path.join(root, 'deps', 'sms-pc-port', 'decomp', 'include', 'dolphin.h')), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'launcher-source.json'), 'utf8')), pinned);
  // deps/ stays out of the port's own Git status
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(), '');
  assert.deepEqual(fs.readdirSync(home).filter(name => name.includes('.download-')), []);
});

test('a port that names no renderer is built from itself and the decomp, and nothing else is fetched', { skip: process.platform === 'win32' }, async t => {
  const home = folder(t, 'colo checkout-');
  const { renderer, ...pinned } = sourceFrom(home);
  const root = path.join(home, 'Game Files');
  await game.checkout(root, { ...runner(process.env), source: pinned });
  assert.equal(port.isPort(root), true);
  assert.equal(game.matchesSource(root, pinned), true);
  assert.equal(fs.existsSync(path.join(root, 'deps', 'sms-pc-port')), false);
  assert.equal(game.identity(undefined, undefined, pinned).renderer, null, 'stored as JSON, so it reads back the same');
  assert.notEqual(game.snapshotPath(path.join(home, 'game'), pinned), game.snapshotPath(path.join(home, 'game'), { ...pinned, renderer }));
});

test('the launcher\'s patch is applied to the port it pins, and a changed patch means another build', { skip: process.platform === 'win32' }, async t => {
  const home = folder(t, 'colo checkout-');
  const pinned = sourceFrom(home);
  const patch = path.join(home, 'test.patch');
  fs.writeFileSync(patch, ['--- a/build.sh', '+++ b/build.sh', '@@ -0,0 +1 @@', '+patched', ''].join('\n'));
  port.useLauncherScripts(home);
  t.after(() => port.useLauncherScripts(null));
  const root = path.join(home, 'game');
  await game.checkout(root, { ...runner(process.env), source: { ...pinned, portPatch: 'test.patch' } });
  assert.equal(fs.readFileSync(path.join(root, 'build.sh'), 'utf8'), 'patched\n');
  assert.equal(game.matchesSource(root, pinned), true, 'the commit stays the pinned one');
  const before = game.identity(undefined, undefined, { ...pinned, portPatch: 'test.patch' }).portPatch;
  fs.appendFileSync(patch, '+more\n');
  assert.notEqual(game.identity(undefined, undefined, { ...pinned, portPatch: 'test.patch' }).portPatch, before);
});

test('a port that already has the launcher\'s changes keeps them, and is not patched again', { skip: process.platform === 'win32' }, async t => {
  const home = folder(t, 'colo checkout-');
  const pinned = sourceFrom(home, { 'tools/unit_cache.py': '' });
  fs.writeFileSync(path.join(home, 'test.patch'), 'this would not apply\n');
  port.useLauncherScripts(home);
  t.after(() => port.useLauncherScripts(null));
  const root = path.join(home, 'game');
  await game.checkout(root, { ...runner(process.env), source: { ...pinned, portPatch: 'test.patch' } });
  assert.equal(port.isPort(root), true);
});

test('only a port that reads the C library from Debian\'s directory gets the launcher\'s C library patch', { skip: process.platform === 'win32' }, async t => {
  const debian = "for lib in ['/lib/x86_64-linux-gnu/libc.so.6']:\n";
  t.after(() => port.useLauncherScripts(null));
  const checkedOut = async link => {
    const home = folder(t, 'colo checkout-');
    fs.writeFileSync(path.join(home, 'test.patch'), ['--- a/build.sh', '+++ b/build.sh', '@@ -0,0 +1 @@', '+patched', ''].join('\n'));
    fs.writeFileSync(path.join(home, 'port-launcher-libc.patch'), ['--- a/tools/link.py', '+++ b/tools/link.py', '@@ -1 +1 @@', `-${debian.trim()}`, '+found', ''].join('\n'));
    port.useLauncherScripts(home);
    const root = path.join(home, 'game');
    await game.checkout(root, { ...runner(process.env), source: { ...sourceFrom(home, { 'tools/link.py': link }), portPatch: 'test.patch' } });
    assert.equal(fs.readFileSync(path.join(root, 'build.sh'), 'utf8'), 'patched\n');
    return fs.readFileSync(path.join(root, 'tools', 'link.py'), 'utf8');
  };
  assert.equal(await checkedOut(debian), 'found\n');
  assert.equal(await checkedOut('gcc finds it\n'), 'gcc finds it\n');
});

test('the C library patch ships with the launcher', () => {
  const packaged = require('../package.json').build.extraResources[0].filter;
  assert.ok(packaged.includes('port-launcher-libc.patch'));
  assert.ok(fs.statSync(path.resolve(__dirname, '..', 'scripts', 'port-launcher-libc.patch')).size > 0);
});

test('this release\'s patch applies to the port commit it pins', () => {
  assert.equal(source.branch, 'master');
  assert.ok(fs.statSync(path.resolve(__dirname, '..', 'scripts', source.portPatch)).size > 0);
});

test('a download that fails leaves no game folder behind', { skip: process.platform === 'win32' }, async t => {
  const home = folder(t, 'colo checkout-');
  const pinned = sourceFrom(home);
  const root = path.join(home, 'game');
  await assert.rejects(game.checkout(root, { ...runner(process.env), wait: async () => {},
    source: { ...pinned, decomp: 'd'.repeat(40) } }));
  assert.equal(fs.existsSync(root), false);
  assert.deepEqual(fs.readdirSync(home).filter(name => name.includes('.download-')), []);
});

test('a download GitHub drops partway is tried again over HTTP/1.1, unless the player stopped it', { skip: process.platform === 'win32' }, async t => {
  const home = folder(t, 'colo checkout-');
  const pinned = sourceFrom(home);
  const root = path.join(home, 'game');
  const tries = [];
  let dropped = false;
  const { run: real, capture, env } = runner(process.env);
  const run = async (command, args, options, label) => {
    if (args.includes('fetch')) {
      tries.push(args);
      if (!dropped) { dropped = true; throw new Error('RPC failed; curl 92 HTTP/2 stream 11 reset by server'); }
    }
    return real(command, args, options, label);
  };
  await game.checkout(root, { run, capture, env, source: pinned, wait: async () => {} });
  assert.deepEqual(tries[1].slice(0, 2), ['-c', 'http.version=HTTP/1.1']);
  await assert.rejects(game.checkout(path.join(home, 'stopped'), { run: async () => { throw new Error('stopped'); }, capture, env, source: pinned,
    wait: async () => {}, stopped: () => true }), /stopped/);
});

test('this release pins every repository to a whole commit', () => {
  const { renderer } = source;
  for (const commit of [source.commit, source.decomp, ...(renderer ? [renderer.commit, renderer.decomp] : [])]) assert.match(commit, /^[a-f0-9]{40}$/);
  for (const url of [source.repository, source.decompRepository, ...(renderer ? [renderer.repository, renderer.decompRepository] : [])]) assert.match(url, /^https:\/\//);
});
