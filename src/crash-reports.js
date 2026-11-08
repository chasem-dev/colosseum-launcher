'use strict';

// The game's crash reports. A crash writes one report to stderr, which the activity log shows, and to a file
// (host/crash.c in the game): %LOCALAPPDATA%\colo-port\crashes on Windows, else $XDG_STATE_HOME/colo-port/crashes,
// by default ~/.local/state/colo-port/crashes. Settings → Launcher copies the newest, so a player can add it to a
// bug report. Nothing here sends a report anywhere. The portable launcher gives the game its own %LOCALAPPDATA%
// (saves.gameDataEnvironment), so its game's reports are in the portable folder.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { gameDataEnvironment } = require('./saves');

// A report is a few KB: more than this isn't one.
const MAX_BYTES = 1024 * 1024;
// The file's time comes from the disk and `since` from this computer's clock.
const CLOCK_SLACK = 2000;

function directory({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  env = { ...env, ...gameDataEnvironment(env, platform) }; // what the game is started with
  if (platform === 'win32') return path.win32.join(env.LOCALAPPDATA || '.', 'colo-port', 'crashes');
  return path.posix.join(env.XDG_STATE_HOME || path.posix.join(home, '.local', 'state'), 'colo-port', 'crashes');
}

// The reports in a folder, newest first. None yet is no error.
function list(folder, files = fs) {
  let names;
  try { names = files.readdirSync(folder); } catch { return []; }
  return names.filter(name => /^crash-.*\.log$/.test(name)).flatMap(name => {
    const file = path.join(folder, name);
    try { return [{ file, name, time: files.statSync(file).mtimeMs }]; } catch { return []; }
  }).sort((a, b) => b.time - a.time);
}

// The newest report written since a time, or null: the crash of the game that just closed, not an older one.
function newestSince(folder, since, files = fs) {
  const report = list(folder, files)[0];
  return report && report.time >= since - CLOCK_SLACK ? report : null;
}

function read(file, files = fs) {
  const text = files.readFileSync(file, 'utf8');
  return text.length > MAX_BYTES ? `${text.slice(0, MAX_BYTES)}\n[cut short]\n` : text;
}

// What Settings shows.
function summary(folder, files = fs) {
  const reports = list(folder, files);
  return { folder, count: reports.length, newest: reports[0]?.time ?? null };
}

module.exports = { directory, list, newestSince, read, summary };
