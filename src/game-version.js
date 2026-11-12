'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const port = require('./port');
const tools = require('./build-tools');
const saves = require('./saves');
const portable = require('./portable');
const windowsDlls = require('./windows-dlls');
const release = require('./game-release.json');
const { GIT_PERMANENT } = require('./retry');

// A checkout's Git folder, following a submodule's `gitdir:` file.
function gitDirectory(root) {
  const directory = path.join(root, '.git');
  if (!fs.statSync(directory).isFile()) return directory;
  const match = fs.readFileSync(directory, 'utf8').match(/^gitdir: (.+)\s*$/);
  if (!match) return null;
  let location = match[1];
  // MSYS Git can write absolute /c/... paths, while Electron uses native
  // Windows paths. Relative and native Git paths work without conversion.
  if (process.platform === 'win32') location = location.replace(/^\/([a-zA-Z])\//, '$1:/');
  return path.resolve(root, location);
}

function gitRevision(root) {
  try {
    const directory = gitDirectory(root);
    if (!directory) return null;
    const head = fs.readFileSync(path.join(directory, 'HEAD'), 'utf8').trim();
    if (/^[a-f0-9]{40}$/.test(head)) return head;
    const ref = head.match(/^ref: (refs\/.+)$/)?.[1];
    if (!ref || ref.includes('..')) return null;
    try { return fs.readFileSync(path.join(directory, ref), 'utf8').trim(); }
    catch (_) {
      return fs.readFileSync(path.join(directory, 'packed-refs'), 'utf8').split('\n')
        .find(line => line.endsWith(` ${ref}`))?.split(' ')[0] || null;
    }
  } catch (_) { return null; }
}

// The launcher's own changes to the port, kept in this repository and applied to the checkout: the port's
// repository is only read. Its hash is part of what a build is made from, so a changed patch builds again.
function portPatchFile(source = release) { return source.portPatch ? port.launcherScript(source.portPatch) : null; }

// Beta builds the port's newest commit with the same patch as the pinned one, so what they disagree on is kept
// apart: older ports read the C library from Debian's directory and need this too, newer ones find it themselves.
// Remove it once the pinned commit no longer has DEBIAN_LIBC.
const LIBC_PATCH = 'port-launcher-libc.patch';
const DEBIAN_LIBC = "'/lib/x86_64-linux-gnu/libc.so.6'";

function patchHash(source = release) {
  const file = portPatchFile(source);
  if (!file) return null;
  const hash = crypto.createHash('sha256').update(fs.readFileSync(file));
  return hash.update(fs.readFileSync(port.launcherScript(LIBC_PATCH))).digest('hex');
}

async function patchPort(directory, source, { git, run, env }) {
  const apply = file => run(git, ['apply', '--whitespace=nowarn', file], { cwd: directory, env }, 'Prepare port source');
  await apply(portPatchFile(source));
  const link = path.join(directory, 'tools', 'link.py');
  if (fs.existsSync(link) && fs.readFileSync(link, 'utf8').includes(DEBIAN_LIBC)) await apply(port.launcherScript(LIBC_PATCH));
}

// What a game version is made from: the port, the decomp it compiles and, for an older port, the renderer's sources
// (with the Super Mario Sunshine decomp whose headers those use), each at one commit (game-release.json), and the tools.
function identity(platform = process.platform, arch = process.arch, source = release) {
  const asset = tools.assetFor(platform, arch);
  return { schema: 1, gameVersion: source.version, commit: source.commit, decomp: source.decomp, renderer: source.renderer?.commit ?? null,
    portPatch: patchHash(source),
    platform, hostArch: arch, toolVersion: tools.toolsetFor(platform, arch), toolSha256: asset.sha256 };
}

function metadataPath(root) { return path.join(path.dirname(port.binaryPath(root)), 'launcher-build.json'); }

function installed(root) {
  try { return JSON.parse(fs.readFileSync(metadataPath(root), 'utf8')); }
  catch (_) { return null; }
}

// The tools a build was made with, whose runtime libraries the game loads. A portable
// folder that moved to another drive or computer took them along.
function toolRoot(root, base = portable.root()) {
  const recorded = installed(root)?.toolRoot;
  return recorded ? portable.relocated(recorded, base) : null;
}

// A Windows game links its libraries in, so it plays without its build tools once nothing it imports is
// missing. Elsewhere it loads libraries from the tools themselves (Linux's RUNPATH), so it never does.
function playsWithoutTools(root, platform = process.platform, environment = process.env) {
  if (platform !== 'win32') return false;
  const binary = port.binaryPath(root, platform);
  return windowsDlls.unresolved(binary, [path.dirname(binary)], { environment })?.length === 0;
}

function matchesSource(root, source = release) {
  const { decomp, renderer } = port.dependencyPaths(root);
  return gitRevision(root) === source.commit && gitRevision(decomp) === source.decomp &&
    (!source.renderer || gitRevision(renderer) === source.renderer.commit);
}

function isCurrent(root, source = release, base = portable.root()) {
  if (!fs.existsSync(port.binaryPath(root))) return false;
  const record = installed(root);
  const expected = identity(undefined, undefined, source);
  return Boolean(record && Object.keys(expected).every(key => record[key] === expected[key]) &&
    (!record.toolRoot || fs.existsSync(portable.relocated(record.toolRoot, base)) || playsWithoutTools(root)) &&
    matchesSource(root, source));
}

// Short, since Windows builds can't use paths of 260 characters or more
// (port.longPathProblem): the game's commit, then a hash of what else
// tells versions apart (the computer's system, the tools).
function snapshotPath(base, source = release) {
  const expected = identity(undefined, undefined, source);
  const hash = crypto.createHash('sha256').update([source.decomp, source.renderer?.commit, expected.portPatch, tools.platformId(), expected.toolSha256].join('|')).digest('hex').slice(0, 4);
  return path.join(`${base}.releases`, `${source.commit.slice(0, 7)}-${hash}`);
}

// GitHub sometimes drops a long download partway ("RPC failed; curl 92 HTTP/2
// stream 11 reset by server", "early EOF"). A download that fails is tried
// again over HTTP/1.1, which those stream resets don't happen on, unless the
// player stopped it or what it asked for isn't there.
// A full drive, or Git unable to fork() its HTTPS helper on Windows (Mandatory
// ASLR), fails the same way every time, so it isn't tried again.
const DOWNLOAD_TRIES = 3;

async function download(git, args, options, label, { run, stopped = () => false, wait } = {}) {
  for (let attempt = 1; ; attempt++) {
    const startedAt = Date.now();
    try {
      return await run(git, attempt === 1 ? args : ['-c', 'http.version=HTTP/1.1', ...args], options,
        attempt === 1 ? label : `${label} (try ${attempt} of ${DOWNLOAD_TRIES})`);
    } catch (error) {
      if (attempt >= DOWNLOAD_TRIES || stopped(startedAt) || GIT_PERMANENT.test(error.message) ||
        tools.outOfSpace(error) || tools.forkFailed(error)) throw error;
      await wait(attempt * 3000);
    }
  }
}

// One repository at one commit, shallow: `git init` and a fetch of exactly that commit (GitHub and GitLab both
// serve one by its hash), so a download is the size of that commit, however long the repository's history.
async function shallowCheckout(directory, repository, commit, label, { git, fetch, run, capture, env }) {
  fs.mkdirSync(directory, { recursive: true });
  await run(git, ['init', '-q', directory], { env }, `Prepare ${label}`);
  await run(git, ['config', 'core.longpaths', 'true'], { cwd: directory, env }, `Prepare ${label}`);
  await run(git, ['remote', 'add', 'origin', repository], { cwd: directory, env }, `Prepare ${label}`);
  await fetch(['fetch', '--depth', '1', '--progress', 'origin', commit], { cwd: directory, env }, `Download ${label}`);
  await run(git, ['checkout', '-q', '--detach', 'FETCH_HEAD'], { cwd: directory, env }, `Select ${label}`);
  if (await capture(git, ['rev-parse', 'HEAD'], directory, env) !== commit)
    throw new Error('The downloaded game files did not match this release. Please retry.');
}

// The game folder: the port, with deps/pkmn-colosseum (the decomp) inside it and, for an older port, deps/sms-pc-port
// (the renderer's sources and headers, its decomp submodule at deps/sms-pc-port/decomp). Built in a temporary folder
// and moved into place whole, so a game folder is complete or not there.
async function checkout(root, { git = 'git', run, capture, env, source = release,
  stopped, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const fetch = (args, options, label) => download(git, args, options, label, { run, stopped, wait });
  const tools = { git, fetch, run, capture, env };
  const parent = path.dirname(root);
  if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
  const temporary = `${root}.download-${crypto.randomUUID()}`;
  try {
    await shallowCheckout(temporary, source.repository, source.commit, 'port source', tools);
    // A chosen source, or a newer port, may have these changes already.
    if (source.portPatch && !fs.existsSync(path.join(temporary, 'tools', 'unit_cache.py')))
      await patchPort(temporary, source, tools);
    const { decomp, renderer } = port.dependencyPaths(temporary);
    await shallowCheckout(decomp, source.decompRepository, source.decomp, 'decomp source', tools);
    if (source.renderer) {
      await shallowCheckout(renderer, source.renderer.repository, source.renderer.commit, 'renderer source', tools);
      await shallowCheckout(path.join(renderer, 'decomp'), source.renderer.decompRepository, source.renderer.decomp, 'renderer headers', tools);
    }
    // deps/ is no part of the port's history
    fs.appendFileSync(path.join(temporary, '.git', 'info', 'exclude'), '/deps/\n/launcher-source.json\n');
    fs.writeFileSync(path.join(temporary, 'launcher-source.json'), JSON.stringify(source, null, 2));
    fs.renameSync(temporary, root);
  } finally {
    // Not rmSync, which cannot remove Git's read-only object files on Windows,
    // and never in place of the error that brought us here.
    await fs.promises.rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  }
}

// mods/ folders every version shares: the HD textures.
const USER_FOLDERS = ['textures'];

// Linking a folder fails this way on a drive without links: Windows reports
// ERROR_INVALID_FUNCTION making a junction on exFAT or FAT32, which Node calls
// EISDIR; Linux and macOS say EPERM or ENOTSUP on such a drive.
const NO_LINKS = new Set(['EISDIR', 'EPERM', 'ENOTSUP', 'EOPNOTSUPP']);

// The new version links to the previous version's HD textures. On a drive that
// can't make links (an exFAT or FAT32 SD card or USB drive) the folder moves into
// the new version instead. Returns the folders moved, as { from, to }, so a
// failed update can put them back (restoreUserFiles).
function carryUserFiles(previous, next) {
  const moved = [];
  if (previous === next) return moved;
  for (const folder of USER_FOLDERS) {
    const origin = path.join(previous, 'mods', folder);
    const target = path.join(next, 'mods', folder);
    if (!fs.existsSync(origin)) continue;
    const existing = fs.lstatSync(target, { throwIfNoEntry: false });
    if (existing) {
      // A link from an older update can point at a version that has since been
      // removed. existsSync follows it and says there is nothing there, but
      // creating the new link over it fails (EISDIR on Windows), so replace it.
      if (!existing.isSymbolicLink() || fs.existsSync(target)) continue;
      fs.unlinkSync(target);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const real = fs.realpathSync(origin);
    // A Windows directory junction requires no administrator/developer mode.
    try { fs.symlinkSync(real, target, process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) {
      if (!NO_LINKS.has(error.code) || fs.lstatSync(target, { throwIfNoEntry: false })) throw error;
      fs.renameSync(real, target);
      moved.push({ from: real, to: target });
    }
  }
  return moved;
}

// Put back the folders carryUserFiles moved, so the version still in use keeps them.
function restoreUserFiles(moved) {
  for (const { from, to } of [...moved].reverse())
    if (fs.existsSync(to) && !fs.existsSync(from)) fs.renameSync(to, from);
}

// Links to an earlier version's packs keep its absolute path (Windows junctions
// must), so after a portable folder moves they point where it used to be.
// Point them at the same folders in its new place.
function relinkUserFolders(root, relocate) {
  const relinked = [];
  for (const folder of USER_FOLDERS) {
    const link = path.join(root, 'mods', folder);
    if (!fs.lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink() || fs.existsSync(link)) continue;
    const target = relocate(path.resolve(path.dirname(link), fs.readlinkSync(link)));
    if (!fs.existsSync(target)) continue;
    fs.unlinkSync(link);
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    relinked.push(folder);
  }
  return relinked;
}

function contains(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

// Remove a folder an entry at a time, so `shouldStop` can end it partway: a game
// version holds tens of thousands of files, which Windows can take minutes to
// delete. Links are removed, never followed (lstat sees a Windows junction as
// one). A file another program has open stays; the rest is still removed and
// the first such error is thrown at the end, with the folder left for next time.
async function removeTree(folder, shouldStop) {
  let failure = null, stopped = false;
  // Whether `item` is gone. A folder whose files weren't all removed stays.
  const remove = async item => {
    if (stopped || (stopped = shouldStop())) return false;
    const stats = fs.lstatSync(item, { throwIfNoEntry: false });
    let empty = true;
    if (stats?.isDirectory() && !stats.isSymbolicLink())
      for (const name of fs.readdirSync(item)) empty = await remove(path.join(item, name)) && empty;
    if (!empty) return false;
    try { await fs.promises.rm(item, { recursive: true, force: true, maxRetries: 3 }); return true; }
    catch (error) { failure ||= error; return false; }
  };
  const gone = await remove(folder);
  if (failure) throw failure;
  return gone;
}

// The first install, <base> itself, once the versions `kept` are all updates
// in <base>.releases: it is then no longer the current or previous version.
// Only a folder the launcher downloaded (launcher-source.json), never one the
// player chose as their own setup folder.
function supersededBase(base, kept) {
  const releases = `${path.resolve(base)}.releases`;
  return kept.length > 0 && kept.every(root => root !== path.resolve(base) && contains(releases, root)) &&
    fs.existsSync(path.join(base, 'launcher-source.json')) && fs.lstatSync(base).isDirectory();
}

// Each update checks the new game out beside the last one in <base>.releases.
// Remove the versions `keep` doesn't name, and the first install once updates
// replaced it (supersededBase), unless one holds a `protect` path (a memory
// card or disc file). A kept version's HD packs may be linked from an old one
// (carryUserFiles), so move those into the kept version first.
// `shouldStop` ends it early, leaving the rest for next time.
async function pruneSnapshots(base, keep, protect = [], onError = () => {}, shouldStop = () => false) {
  const releases = `${base}.releases`;
  let names;
  try { names = fs.readdirSync(releases); } catch (_) { return []; }
  const kept = keep.filter(Boolean).map(root => path.resolve(root));
  const guarded = [...kept, ...protect.filter(Boolean).map(item => path.resolve(item))];
  const moved = new Map();
  const removed = [];
  const candidates = names.map(name => path.join(releases, name));
  try { if (supersededBase(base, kept)) candidates.push(path.resolve(base)); } catch (_) { /* gone, or unreadable: leave it */ }
  for (const candidate of candidates) {
    if (shouldStop()) break;
    try {
      if (!fs.lstatSync(candidate).isDirectory()) continue;
      const real = fs.realpathSync(candidate);
      const within = item => contains(candidate, item) || contains(real, item);
      if (guarded.some(item => within(item) || (fs.existsSync(item) && within(fs.realpathSync(item))))) continue;
      for (const root of kept) for (const folder of USER_FOLDERS) {
        const link = path.join(root, 'mods', folder);
        if (!fs.lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink()) continue;
        const target = path.resolve(path.dirname(link), fs.readlinkSync(link));
        if (!within(target)) continue;
        const type = process.platform === 'win32' ? 'junction' : 'dir';
        fs.unlinkSync(link);
        if (moved.has(target)) fs.symlinkSync(moved.get(target), link, type);
        else if (fs.existsSync(target)) {
          try { fs.renameSync(target, link); } catch (error) { fs.symlinkSync(target, link, type); throw error; }
          moved.set(target, link);
        }
      }
      // Unlink this version's own links so removing it can't reach through them.
      for (const folder of USER_FOLDERS) {
        const link = path.join(candidate, 'mods', folder);
        if (fs.lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink()) fs.unlinkSync(link);
      }
      if (await removeTree(candidate, shouldStop)) removed.push(candidate);
    } catch (error) { onError(error, candidate); }
  }
  return removed;
}

// What buildSafely leaves beside <root>/build: the build an in-place rebuild
// replaced (.previous-, once it succeeded) and the output of a failed or
// interrupted one (.failed-, .interrupted-). Removed, unless a build of that
// folder is under way (its journal is there) or one holds a `protect` path.
// Returns the folders removed.
const BUILD_LEFTOVER = /^(.+)\.(?:previous|failed|interrupted)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
async function pruneBuildLeftovers(root, protect = [], onError = () => {}, shouldStop = () => false) {
  let names;
  try { names = fs.readdirSync(root); } catch (_) { return []; }
  const guarded = protect.filter(Boolean).map(item => path.resolve(item));
  const removed = [];
  for (const name of names) {
    if (shouldStop()) break;
    const match = name.match(BUILD_LEFTOVER);
    if (!match) continue;
    const candidate = path.join(root, name);
    try {
      if (fs.existsSync(path.join(root, `${match[1]}.launcher-transaction.json`))) continue;
      const stats = fs.lstatSync(candidate);
      if (!stats.isDirectory() || stats.isSymbolicLink() || guarded.some(item => contains(candidate, item))) continue;
      if (await removeTree(candidate, shouldStop)) removed.push(candidate);
    } catch (error) { onError(error, candidate); }
  }
  return removed;
}

// `toolFolder` is the build tools this build runs with, recorded for playing it later (toolRoot).
async function buildSafely(root, saveDir, compile, { backups = saves.backupRoot(), source = release, toolFolder = null } = {}) {
  const directory = path.dirname(port.binaryPath(root));
  const previous = `${directory}.previous-${crypto.randomUUID()}`;
  const hadBuild = fs.existsSync(directory);
  const journal = `${directory}.launcher-transaction.json`;
  if (hadBuild) fs.writeFileSync(journal, JSON.stringify({ directory, previous }), { flag: 'wx' });
  try {
    if (hadBuild) saves.moveBuildKeepingSaves(directory, previous, saveDir, backups);
    const result = await compile();
    if (!fs.existsSync(port.binaryPath(root))) throw new Error('Setup finished without a playable game. Please retry.');
    if (!matchesSource(root, source))
      throw new Error('Game files changed during setup. Please retry.');
    const record = { ...identity(undefined, undefined, source), toolRoot: toolFolder, builtAt: new Date().toISOString() };
    const file = metadataPath(root);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(record, null, 2));
    fs.renameSync(`${file}.tmp`, file);
    fs.rmSync(journal, { force: true });
    return result;
  } catch (error) {
    // Keep partial output for diagnosis; never delete a custom memory card.
    if (hadBuild && fs.existsSync(previous)) {
      if (fs.existsSync(directory)) fs.renameSync(directory, `${directory}.failed-${crypto.randomUUID()}`);
      fs.renameSync(previous, directory);
    }
    fs.rmSync(journal, { force: true });
    throw error;
  }
}

function recoverBuild(root) {
  const directory = path.dirname(port.binaryPath(root));
  const journal = `${directory}.launcher-transaction.json`;
  if (!fs.existsSync(journal)) return false;
  const record = JSON.parse(fs.readFileSync(journal, 'utf8'));
  if (record.directory !== directory || !record.previous?.startsWith(`${directory}.previous-`) ||
      path.dirname(record.previous) !== path.dirname(directory)) throw new Error('The recovery record is invalid.');
  if (fs.existsSync(record.previous)) {
    if (fs.existsSync(directory)) fs.renameSync(directory, `${directory}.interrupted-${crypto.randomUUID()}`);
    fs.renameSync(record.previous, directory);
  }
  fs.rmSync(journal, { force: true });
  return true;
}

module.exports = { release, gitRevision, matchesSource, identity, installed, toolRoot, playsWithoutTools, isCurrent, snapshotPath,
  checkout, carryUserFiles, restoreUserFiles, relinkUserFolders, pruneSnapshots, pruneBuildLeftovers, buildSafely, recoverBuild };
