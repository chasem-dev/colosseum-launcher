'use strict';

// Maintainer command: select a complete port revision, then bump the launcher so its release gate verifies
// exactly the source players will receive. The port names the decomp and renderer commits it builds with in
// tools/ci/linux-build.sh, so they follow it here. Pokémon XD (src/xd-release.json) moves to the same commit, with
// the XD decomp it names there: rooms for both games pair only builds of one port commit. scripts/port-launcher.patch must still apply to the new commit:
// the launcher's checkout fails if it does not, and Game build shows that before any release.
//   npm run update:game            the newest commit of the port's branch (game-release.json's)
//   npm run update:game -- <ref>   that commit, tag or branch; Colosseum's own pinned commit moves only XD to it
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const current = require('../src/game-release.json');
const currentXd = require('../src/xd-release.json');
const { pinned, rendererHeaders, xdReleaseFor } = require('./game-pins');
const { OLDER_RENDERER, rendererPin } = require('../src/game-source');
const ref = process.argv[2] || `origin/${current.branch}`;
const launcherRoot = path.join(__dirname, '..');
const previousLauncher = require('../package.json').version;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'colo-game-release-'));
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

// Commit subjects are a draft: the maintainer rewrites them for players.
function subjects(args, cwd) {
  try {
    return execFileSync('git', ['log', '--no-merges', '--format=%s', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n').map(line => line.trim()).filter(Boolean);
  } catch (_) { return []; }
}

// The launcher release that ships a game pin lists the game's changes too.
function addChangelogEntry(version, game, previousCommit) {
  const file = path.join(launcherRoot, 'changelog.json');
  const changelog = JSON.parse(fs.readFileSync(file, 'utf8'));
  const launcher = subjects([`v${previousLauncher}..HEAD`], launcherRoot).filter(line => !/^(Select game|Bump launcher)/.test(line));
  const entry = { version, date: new Date().toISOString().slice(0, 10), launcher,
    game: { version: game.version, commit: game.commit, changes: subjects([`${previousCommit}..${game.commit}`], root) } };
  changelog.releases = [entry, ...changelog.releases.filter(release => release.version !== version)];
  fs.writeFileSync(file, `${JSON.stringify(changelog, null, 2)}\n`);
}

try {
  git(['clone', '--filter=blob:none', '--no-checkout', '--branch', current.branch, current.repository, '.']);
  const commit = git(['rev-parse', '--verify', `${ref}^{commit}`]);
  const script = git(['show', `${commit}:tools/ci/linux-build.sh`]);
  const decomp = pinned(script, 'DECOMP_REF');
  let xdDecomp = '';
  try { xdDecomp = pinned(script, 'XD_DECOMP_REF'); } catch { /* xdReleaseFor says the commit doesn't build XD */ }
  const renderer = rendererPin(script);
  if (commit === current.commit && decomp === current.decomp && renderer === current.renderer?.commit) {
    if (currentXd.commit === commit && currentXd.decomp === xdDecomp)
      console.log('This game revision is already selected. No release bump needed.');
    else {
      // Colosseum's pin stays: only XD comes to its commit, as a launcher-only release needs (AGENTS.md)
      const nextXd = xdReleaseFor(currentXd, current, xdDecomp);
      fs.writeFileSync(path.join(launcherRoot, 'src', 'xd-release.json'), `${JSON.stringify(nextXd, null, 2)}\n`);
      console.log(`Colosseum's game is already selected. Moved XD to the same commit: XD ${nextXd.version}, ${commit} (XD decomp ${xdDecomp}).`);
    }
  } else {
    const headers = renderer ? rendererHeaders(OLDER_RENDERER.repository, renderer) : null;
    const date = new Date().toISOString().slice(0, 10).replaceAll('-', '.');
    const number = current.version.startsWith(`${date}.`) ? Number(current.version.split('.').at(-1)) + 1 : 1;
    const { renderer: _, rosetta: __, ...rest } = current;
    // A game from before the native Apple Silicon build keeps Rosetta (src/port.js, gameArch).
    const rosetta = !git(['ls-tree', commit, 'ext/sms_gx/src/mtl']);
    const next = { ...rest, version: `${date}.${number}`, commit, decomp, ...(rosetta && { rosetta }), ...(renderer && {
      renderer: { ...OLDER_RENDERER, commit: renderer, decomp: headers.decomp, decompRepository: headers.decompRepository || OLDER_RENDERER.decompRepository } }) };
    const nextXd = xdReleaseFor(currentXd, next, xdDecomp);
    fs.writeFileSync(path.join(launcherRoot, 'src', 'game-release.json'), `${JSON.stringify(next, null, 2)}\n`);
    fs.writeFileSync(path.join(launcherRoot, 'src', 'xd-release.json'), `${JSON.stringify(nextXd, null, 2)}\n`);
    execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['version', 'patch', '--no-git-tag-version'],
      { cwd: launcherRoot, stdio: 'inherit', shell: process.platform === 'win32' });
    const version = JSON.parse(fs.readFileSync(path.join(launcherRoot, 'package.json'), 'utf8')).version;
    addChangelogEntry(version, next, current.commit);
    console.log(`Selected game ${next.version}: ${commit} (decomp ${decomp}${renderer ? `, renderer ${renderer}` : ''}).`);
    console.log(`Selected XD ${nextXd.version} at the same commit (XD decomp ${xdDecomp}).`);
    console.log(`Drafted changelog.json notes for v${version} from commit subjects. Edit them for players, then commit and push to main.`);
  }
} finally { fs.rmSync(root, { recursive: true, force: true }); }
