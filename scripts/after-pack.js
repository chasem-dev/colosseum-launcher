'use strict';

// electron-builder's afterPack (package.json build.afterPack). On Linux the
// AppImage starts the launcher through a small script that always passes
// --no-sandbox. electron-builder's AppRun adds it only when user namespaces
// look unavailable, but in the Steam Deck's Game Mode they look available and
// the sandbox still fails, so a Steam shortcut added by hand without
// --no-sandbox never opened the launcher there. The script also sets
// COLO_LAUNCHER_NO_SANDBOX, so the launcher knows it no longer needs that option.
//
// The script also starts the launcher from a copy of the AppImage's files in
// the cache folder, made once per build. An AppImage runs from a mount that
// another process serves, and Stop in Steam ends that process too. Electron
// reads its code from the mount as it runs it, so code first needed after
// that, as quitting is, fails with a SIGBUS crash report. Steam signals the
// launcher too late or not at all, so ending the launcher on SIGTERM
// (steam.endOnSigterm) wasn't enough. Without the copy (a full disk, say) it
// runs from the mount as before.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// Names the copy after every file of the build, so each build gets its own and reuses it.
function buildId(appOutDir) {
  const hash = crypto.createHash('sha256');
  const add = relative => {
    const file = path.join(appOutDir, relative), stat = fs.lstatSync(file);
    if (stat.isDirectory()) return fs.readdirSync(file).sort().forEach(name => add(path.join(relative, name)));
    hash.update(`${relative}\0${stat.mode & 0o111 ? 'x' : '-'}\0`);
    hash.update(stat.isSymbolicLink() ? fs.readlinkSync(file) : fs.readFileSync(file));
    hash.update('\0');
  };
  fs.readdirSync(appOutDir).sort().forEach(add);
  return hash.digest('hex').slice(0, 16);
}

function wrapperScript(binary, id) {
  return [
    '#!/bin/sh',
    '# Starts the launcher without the Chromium sandbox, from a copy outside the AppImage: see scripts/after-pack.js.',
    'export COLO_LAUNCHER_NO_SANDBOX=1',
    'app="$(dirname "$0")"',
    'copies="${XDG_CACHE_HOME:-$HOME/.cache}/colosseum-launcher/app"',
    `copy="$copies/${id}"`,
    `if [ ! -x "$copy/${binary}" ] && mkdir -p "$copies" 2>/dev/null; then`,
    '  partial="$copy.partial-$$"',
    // Synced before the rename, so a power cut can't leave a copy whose files are empty.
    '  if cp -R "$app/." "$partial" 2>/dev/null && sync -f "$partial" && mv -T "$partial" "$copy" 2>/dev/null; then',
    '    for old in "$copies"/*; do [ "$old" = "$copy" ] || rm -rf "$old"; done',
    '  else',
    '    rm -rf "$partial"',
    '  fi',
    'fi',
    `[ -x "$copy/${binary}" ] && app="$copy"`,
    `exec "$app/${binary}" --no-sandbox "$@"`,
    ''
  ].join('\n');
}

// Moves the Electron binary aside to <name>-bin and puts the script in its place.
function wrapLinuxExecutable(appOutDir, executableName) {
  const exe = path.join(appOutDir, executableName), binary = `${executableName}-bin`;
  fs.renameSync(exe, path.join(appOutDir, binary));
  fs.writeFileSync(exe, wrapperScript(binary, buildId(appOutDir)), { mode: 0o755 });
  return path.join(appOutDir, binary);
}

async function afterPack(context) {
  if (context.electronPlatformName !== 'linux') return;
  wrapLinuxExecutable(context.appOutDir, context.packager.executableName);
}

module.exports = afterPack;
module.exports.default = afterPack;
module.exports.buildId = buildId;
module.exports.wrapperScript = wrapperScript;
module.exports.wrapLinuxExecutable = wrapLinuxExecutable;
