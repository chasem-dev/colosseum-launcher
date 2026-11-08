'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crashReports = require('../src/crash-reports');
const saves = require('../src/saves');

function folder(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'colosseum crash reports-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function report(root, name, time, text = 'report') {
  const file = path.join(root, name);
  fs.writeFileSync(file, text);
  fs.utimesSync(file, new Date(time), new Date(time));
  return file;
}

test('reports are looked for where the game writes them', () => {
  assert.equal(crashReports.directory({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\Ash\\AppData\\Local' } }),
    'C:\\Users\\Ash\\AppData\\Local\\colo-port\\crashes');
  assert.equal(crashReports.directory({ platform: 'linux', env: { XDG_STATE_HOME: '/state' }, home: '/home/ash' }), '/state/colo-port/crashes');
  assert.equal(crashReports.directory({ platform: 'linux', env: {}, home: '/home/ash' }), '/home/ash/.local/state/colo-port/crashes');
  assert.equal(crashReports.directory({ platform: 'darwin', env: {}, home: '/Users/ash' }), '/Users/ash/.local/state/colo-port/crashes');
});

test('the portable launcher looks in its own folder, where its game writes them', () => {
  const env = { LOCALAPPDATA: 'C:\\Users\\Ash\\AppData\\Local', PORTABLE_EXECUTABLE_DIR: 'D:\\Games' };
  assert.equal(crashReports.directory({ platform: 'win32', env }),
    'D:\\Games\\Colosseum-Launcher-Portable\\cache\\colo-port\\crashes');
  // The same folder the game is told about, whatever it is.
  const game = { ...env, ...saves.gameDataEnvironment(env, 'win32') };
  assert.equal(crashReports.directory({ platform: 'win32', env }), path.win32.join(game.LOCALAPPDATA, 'colo-port', 'crashes'));
});

test('a folder that is not there yet has no reports', t => {
  const missing = path.join(folder(t), 'not yet');
  assert.deepEqual(crashReports.list(missing), []);
  assert.equal(crashReports.newestSince(missing, 0), null);
  assert.deepEqual(crashReports.summary(missing), { folder: missing, count: 0, newest: null });
});

test('reports come newest first, and other files in the folder are left out', t => {
  const root = folder(t);
  report(root, 'crash-1.log', 1000000);
  report(root, 'crash-2.log', 3000000);
  report(root, 'notes.txt', 4000000);
  assert.deepEqual(crashReports.list(root).map(item => item.name), ['crash-2.log', 'crash-1.log']);
  assert.deepEqual(crashReports.summary(root), { folder: root, count: 2, newest: 3000000 });
});

test('only a report from the game that just closed counts as its crash', t => {
  const root = folder(t);
  report(root, 'crash-old.log', 1000000);
  assert.equal(crashReports.newestSince(root, 5000000), null);
  const file = report(root, 'crash-new.log', 5000000);
  assert.equal(crashReports.newestSince(root, 5000000).file, file);
  assert.equal(crashReports.newestSince(root, 5001000).file, file, 'the disk and the clock can differ a little');
});

test('a report is read as it is, and a huge file is cut short', t => {
  const root = folder(t);
  assert.equal(crashReports.read(report(root, 'crash-1.log', 1000, 'floor 12\n')), 'floor 12\n');
  assert.match(crashReports.read(report(root, 'crash-2.log', 2000, 'x'.repeat(2 * 1024 * 1024))), /\[cut short\]\n$/);
});
