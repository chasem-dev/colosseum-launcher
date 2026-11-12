'use strict';

// Points src/game-release.json at another game for a CI build: Beta's newest game (.github/workflows/build.yml).
// That game is native on Apple Silicon, so it drops the pinned game's "rosetta" mark. With XD_DECOMP, XD's pin
// (src/xd-release.json) moves to the same commit, with that decomp. Never committed.
const fs = require('node:fs');
const path = require('node:path');

const file = path.join(__dirname, '..', 'src', 'game-release.json');
const { OLDER_RENDERER } = require('../src/game-source');
const { COMMIT, DECOMP, XD_DECOMP, RENDERER, RENDERER_DECOMP, VERSION } = process.env;
for (const [name, value] of Object.entries({ COMMIT, DECOMP, ...(XD_DECOMP && { XD_DECOMP }), ...(RENDERER && { RENDERER, RENDERER_DECOMP }) }))
  if (!/^[0-9a-f]{40}$/.test(value || '')) throw new Error(`${name} must be a full commit hash, not "${value || ''}".`);
const game = JSON.parse(fs.readFileSync(file, 'utf8'));
Object.assign(game, { version: VERSION || 'ci', commit: COMMIT, decomp: DECOMP });
delete game.rosetta;
if (RENDERER) game.renderer = { ...OLDER_RENDERER, commit: RENDERER, decomp: RENDERER_DECOMP };
else delete game.renderer;
fs.writeFileSync(file, `${JSON.stringify(game, null, 2)}\n`);
process.stdout.write(`Building game ${game.version}: ${game.repository} ${COMMIT}\n`);
if (XD_DECOMP) {
  const xdFile = path.join(__dirname, '..', 'src', 'xd-release.json');
  const xd = JSON.parse(fs.readFileSync(xdFile, 'utf8'));
  Object.assign(xd, { version: VERSION ? `${VERSION}.xd` : 'ci.xd', commit: COMMIT, decomp: XD_DECOMP });
  fs.writeFileSync(xdFile, `${JSON.stringify(xd, null, 2)}\n`);
  process.stdout.write(`Building XD ${xd.version}: ${xd.repository} ${COMMIT}\n`);
}
