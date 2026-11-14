'use strict';

// What a commit of the port builds with: it names the decomp in tools/ci/linux-build.sh (Colosseum's DECOMP_REF, and
// XD's XD_DECOMP_REF since the port builds XD). An older commit names the renderer there too, and the renderer names
// its headers' repository as a submodule. Used by npm run update:game and, for Beta, by CI: both games build from one
// commit, Beta's newest and a Stable release's pin alike, so a room for both games pairs them (rooms pair only builds
// of the same port commit).
//   node scripts/game-pins.js   the newest commit of game-release.json's branch, as GitHub Actions outputs
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { OLDER_RENDERER, rendererPin } = require('../src/game-source');

function inTemporaryRepository(callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'colo-pins-'));
  const git = args => execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try { git(['init', '-q']); return callback(git); }
  finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

// A value the port's CI script pins: NAME=value at the start of a line.
function pinned(script, name) {
  const value = script.match(new RegExp(`^${name}=(\\S+)`, 'm'))?.[1];
  if (!/^[a-f0-9]{40}$/.test(value || '')) throw new Error(`The port's tools/ci/linux-build.sh does not pin ${name}.`);
  return value;
}

function pinsAt(repository, commit) {
  return inTemporaryRepository(git => {
    git(['fetch', '-q', '--depth', '1', repository, commit]);
    const script = git(['show', `${commit}:tools/ci/linux-build.sh`]);
    let xdDecomp = '';
    try { xdDecomp = pinned(script, 'XD_DECOMP_REF'); } catch { /* a port from before it built XD */ }
    return { decomp: pinned(script, 'DECOMP_REF'), xdDecomp, renderer: rendererPin(script) };
  });
}

function rendererHeaders(repository, commit) {
  return inTemporaryRepository(git => {
    git(['fetch', '-q', '--depth', '1', '--filter=blob:none', repository, commit]);
    const decomp = git(['ls-tree', commit, 'decomp']).match(/^160000 commit ([a-f0-9]{40})\tdecomp$/)?.[1];
    if (!decomp) throw new Error('The renderer revision does not pin its decomp submodule.');
    return { decomp, decompRepository: git(['show', `${commit}:.gitmodules`]).match(/path = decomp\s+url = (\S+)/)?.[1] };
  });
}

// XD's pin (src/xd-release.json) for Colosseum's (src/game-release.json): the same port commit, with the XD decomp
// that commit names in its CI script, and Colosseum's version with "xd" before its number (2026.11.12.1 ->
// 2026.11.12.xd1). A Stable release ships both games from one commit, which test/changelog.test.js checks.
function xdReleaseFor(xd, game, xdDecomp) {
  if (xd.repository !== game.repository || xd.branch !== game.branch)
    throw new Error("src/xd-release.json must name game-release.json's repository and branch: both games build from one commit.");
  if (!/^[a-f0-9]{40}$/.test(xdDecomp || ''))
    throw new Error(`The port at ${game.commit} doesn't build XD: its tools/ci/linux-build.sh pins no XD_DECOMP_REF.`);
  const version = String(game.version).match(/^(\d{4}\.\d{2}\.\d{2})\.(\d+)$/);
  if (!version) throw new Error(`Colosseum's game version "${game.version}" is not YYYY.MM.DD.N.`);
  return { ...xd, version: `${version[1]}.xd${version[2]}`, commit: game.commit, decomp: xdDecomp };
}

function newestCommit(repository, branch) {
  const commit = execFileSync('git', ['ls-remote', repository, `refs/heads/${branch}`], { encoding: 'utf8' }).split(/\s/)[0];
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error(`Could not find ${branch} in ${repository}.`);
  return commit;
}

if (require.main === module) {
  const release = require('../src/game-release.json');
  const commit = newestCommit(release.repository, release.branch);
  const xd = require('../src/xd-release.json');
  if (xd.repository !== release.repository || xd.branch !== release.branch)
    throw new Error("src/xd-release.json must name game-release.json's repository and branch: Beta builds both games from one commit.");
  const { decomp, xdDecomp, renderer } = pinsAt(release.repository, commit);
  const headers = renderer ? rendererHeaders(OLDER_RENDERER.repository, renderer) : {};
  const lines = [`commit=${commit}`, `decomp=${decomp}`, `xd_decomp=${xdDecomp}`, `renderer=${renderer || ''}`, `renderer_decomp=${headers.decomp || ''}`];
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
  process.stdout.write(`${lines.join('\n')}\n`);
}

module.exports = { pinned, pinsAt, rendererHeaders, xdReleaseFor, newestCommit };
