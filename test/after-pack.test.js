'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const afterPack = require('../scripts/after-pack');

function packed(t, extra = 'one') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'after-pack-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const app = path.join(dir, 'app'), cache = path.join(dir, 'cache');
  fs.mkdirSync(path.join(app, 'resources'), { recursive: true });
  fs.writeFileSync(path.join(app, 'resources', 'app.asar'), extra);
  // Stands in for Electron: prints where it ran from, its arguments and environment.
  fs.writeFileSync(path.join(app, 'colosseum-launcher'),
    '#!/bin/sh\necho "from=$(dirname "$0")"\nprintf "%s\\n" "$@"\necho "env=$COLO_LAUNCHER_NO_SANDBOX"\n', { mode: 0o755 });
  return { dir, app, cache };
}

const pack = app => afterPack({ electronPlatformName: 'linux', appOutDir: app, packager: { executableName: 'colosseum-launcher' } });
const run = (app, cache, args = []) => execFileSync(path.join(app, 'colosseum-launcher'), args,
  { encoding: 'utf8', env: { ...process.env, XDG_CACHE_HOME: cache } }).trim().split('\n');
// The start script only runs in a Linux AppImage, so the copy tests need GNU cp, mv and sync.
const copies = cache => fs.readdirSync(path.join(cache, 'colosseum-launcher', 'app'));

test('the Linux launcher always starts with --no-sandbox, keeping its own arguments', { skip: process.platform === 'win32' }, async t => {
  const { app, cache } = packed(t);
  await pack(app);
  assert.equal(fs.existsSync(path.join(app, 'colosseum-launcher-bin')), true);
  assert.notEqual(fs.statSync(path.join(app, 'colosseum-launcher')).mode & 0o111, 0);
  assert.deepEqual(run(app, cache, ['--play', 'two words']).slice(1), ['--no-sandbox', '--play', 'two words', 'env=1']);
});

test('the Linux launcher runs from its copy in the cache folder, made once per build', { skip: process.platform !== 'linux' }, async t => {
  const { app, cache } = packed(t);
  await pack(app);
  assert.equal(fs.existsSync(cache), false, 'nothing is copied before the launcher starts');
  const from = run(app, cache)[0];
  assert.deepEqual(copies(cache).length, 1);
  const copy = path.join(cache, 'colosseum-launcher', 'app', copies(cache)[0]);
  assert.equal(from, `from=${copy}`);
  assert.equal(fs.readFileSync(path.join(copy, 'resources', 'app.asar'), 'utf8'), 'one');
  fs.writeFileSync(path.join(copy, 'kept'), '');
  assert.equal(run(app, cache)[0], `from=${copy}`);
  assert.equal(fs.existsSync(path.join(copy, 'kept')), true, 'a second start reuses the copy');
});

test("a new build's copy replaces the old one", { skip: process.platform !== 'linux' }, async t => {
  const old = packed(t, 'old'), current = packed(t, 'new'), again = packed(t, 'new');
  assert.notEqual(afterPack.buildId(old.app), afterPack.buildId(current.app));
  assert.equal(afterPack.buildId(again.app), afterPack.buildId(current.app));
  await pack(old.app);
  await pack(current.app);
  run(old.app, current.cache);
  const [oldId] = copies(current.cache);
  run(current.app, current.cache);
  const id = copies(current.cache).find(name => name !== oldId);
  fs.mkdirSync(path.join(current.cache, 'colosseum-launcher', 'app', oldId), { recursive: true });
  fs.rmSync(path.join(current.cache, 'colosseum-launcher', 'app', id), { recursive: true });
  fs.mkdirSync(path.join(current.cache, 'colosseum-launcher', 'app', `${id}.partial-1`));
  assert.equal(run(current.app, current.cache)[0], `from=${path.join(current.cache, 'colosseum-launcher', 'app', id)}`);
  assert.deepEqual(copies(current.cache), [id]);
});

test('without a cache folder it can write to, the launcher runs from the AppImage', { skip: process.platform === 'win32' }, async t => {
  const { dir, app } = packed(t);
  await pack(app);
  const blocked = path.join(dir, 'not-a-folder');
  fs.writeFileSync(blocked, '');
  assert.deepEqual(run(app, blocked, ['--play']), [`from=${app}`, '--no-sandbox', '--play', 'env=1']);
});

test('Windows and macOS builds are left as they are', async t => {
  const { app } = packed(t);
  for (const electronPlatformName of ['win32', 'darwin'])
    await afterPack({ electronPlatformName, appOutDir: app, packager: { executableName: 'colosseum-launcher' } });
  assert.deepEqual(fs.readdirSync(app).sort(), ['colosseum-launcher', 'resources']);
});
