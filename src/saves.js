'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const portable = require('./portable');

// Where the game keeps its memory card (host/card.c): $XDG_DATA_HOME/colo-port/card-a, by default
// ~/.local/share/colo-port/card-a, or on Windows %APPDATA%\\colo-port\\card-a. The portable launcher points
// APPDATA at its own folder (gameDataEnvironment).
function saveDirectory(env = process.env, platform = process.platform) {
  const portableRoot = portable.root(env, platform);
  if (portableRoot) return path.join(portableRoot, 'saves', 'colo-port', 'card-a');
  if (platform === 'win32') return path.resolve(env.APPDATA || path.join(env.USERPROFILE || os.homedir(), 'AppData', 'Roaming'), 'colo-port', 'card-a');
  if (env.XDG_DATA_HOME) return path.resolve(env.XDG_DATA_HOME, 'colo-port', 'card-a');
  return path.resolve(env.HOME || os.homedir(), '.local', 'share', 'colo-port', 'card-a');
}

// What the portable launcher's game needs to keep its memory card and caches in the portable folder.
function gameDataEnvironment(env = process.env, platform = process.platform) {
  const portableRoot = portable.root(env, platform);
  return portableRoot ? { APPDATA: path.join(portableRoot, 'saves'), LOCALAPPDATA: path.join(portableRoot, 'cache') } : {};
}

function backupRoot(env = process.env, platform = process.platform) {
  const portableRoot = portable.root(env, platform);
  return portableRoot ? path.join(portableRoot, 'Save Backups') : path.join(os.homedir(), 'Colosseum Launcher Backups');
}

// What sync tools and file browsers leave in a folder they look after (Syncthing's marker, ignore list, old versions
// and partial downloads; Resilio Sync; macOS and Windows Explorer metadata): kept where it is, never a save.
function isSyncMetadata(name) {
  return ['.stfolder', '.stignore', '.stversions', '.sync', '.DS_Store', 'desktop.ini', 'Thumbs.db'].includes(name) ||
    /^\.syncthing\..*\.tmp$/.test(name) || /^~syncthing~.*\.tmp$/.test(name) || name.startsWith('._');
}

// .boxes: boxes 4 to 10 of the PC, beside the save (host/pcboxes.c)
function isCardFile(name) { return name === 'index.txt' || /\.(dat|stat|boxes)$/.test(name); }

function cleanupWouldRemoveSaves(root, saveDir) {
  return ['build', 'build-64', 'build-mac', 'build32'].some(name => {
    const relative = path.relative(path.join(root, name), saveDir);
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  });
}

function saveFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  if (!fs.statSync(dir).isDirectory()) throw new Error(`Memory card path is not a folder: ${dir}`);
  return fs.readdirSync(dir, { withFileTypes: true }).filter(entry => {
    if (isSyncMetadata(entry.name)) return false;
    if (entry.isSymbolicLink()) throw new Error(`Memory card contains a symbolic link: ${entry.name}`);
    if (!entry.isFile()) throw new Error(`Memory card contains an unexpected folder: ${entry.name}`);
    return isCardFile(entry.name);
  }).map(entry => entry.name);
}

function digest(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function backupSaves(saveDir, destination = backupRoot(), reason = 'manual') {
  const files = saveFiles(saveDir);
  if (!files.length) return { empty: true, message: 'No memory card files to back up yet.' };
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`;
  // Written in place, manifest last: a folder without a manifest isn't a backup (listBackups skips it).
  // Renaming a finished folder into place failed on Windows (EPERM) while something still had a new file open.
  const complete = path.join(destination, id);
  fs.mkdirSync(path.join(complete, 'files'), { recursive: true, mode: 0o700 });
  try {
    const records = files.map(name => {
      const source = path.join(saveDir, name);
      const target = path.join(complete, 'files', name);
      fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
      const hash = digest(source);
      if (digest(target) !== hash) throw new Error(`Backup verification failed for ${name}`);
      return { name, hash };
    });
    fs.writeFileSync(path.join(complete, 'manifest.json'), JSON.stringify({ version: 1, reason,
      createdAt: new Date().toISOString(), source: saveDir, files: records }, null, 2), { flag: 'wx' });
    return { id, directory: complete, count: files.length };
  } catch (error) {
    try { fs.rmSync(complete, { recursive: true, force: true, maxRetries: 5 }); } catch (_) { /* the backup error matters more */ }
    throw error;
  }
}

function listBackups(destination = backupRoot()) {
  if (!fs.existsSync(destination)) return [];
  return fs.readdirSync(destination, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
    .map(entry => {
      try {
        const manifest = JSON.parse(fs.readFileSync(path.join(destination, entry.name, 'manifest.json'), 'utf8'));
        return manifest.version === 1 ? { id: entry.name, reason: manifest.reason,
          createdAt: manifest.createdAt, count: manifest.files.length, source: manifest.source } : null;
      } catch (_) { return null; }
    }).filter(Boolean).sort((a, b) => b.id.localeCompare(a.id));
}

// A backup's folder, from its id as listBackups gives it.
function backupFolder(id, destination = backupRoot()) {
  if (typeof id !== 'string' || !/^[0-9TZ-]+-[a-f0-9]{6}$/.test(id)) throw new Error('Invalid backup selection.');
  return path.join(destination, id);
}

function restoreBackup(id, saveDir, destination = backupRoot()) {
  const folder = backupFolder(id, destination);
  const manifest = JSON.parse(fs.readFileSync(path.join(folder, 'manifest.json'), 'utf8'));
  if (manifest.version !== 1 || !Array.isArray(manifest.files) || !manifest.files.length)
    throw new Error('Backup manifest is invalid.');
  for (const file of manifest.files) {
    if (typeof file.name !== 'string' || file.name !== path.basename(file.name) || !isCardFile(file.name) ||
      !/^[a-f0-9]{64}$/.test(file.hash) || digest(path.join(folder, 'files', file.name)) !== file.hash)
      throw new Error(`Backup verification failed for ${file.name}.`);
  }
  const current = backupSaves(saveDir, destination, 'before-restore');
  fs.mkdirSync(saveDir, { recursive: true });
  for (const file of manifest.files) {
    const temporary = path.join(saveDir, `.${file.name}.restore-${process.pid}`);
    try {
      fs.copyFileSync(path.join(folder, 'files', file.name), temporary);
      fs.renameSync(temporary, path.join(saveDir, file.name));
    } finally { fs.rmSync(temporary, { force: true }); }
  }
  return { restored: manifest.files.length, previous: current.directory || null };
}

function moveBuildKeepingSaves(buildDirectory, destination, saveDir, backups = backupRoot()) {
  const relative = path.relative(path.resolve(buildDirectory), path.resolve(saveDir));
  const inside = relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
  const backup = inside ? backupSaves(saveDir, backups, 'before-tools-change') : null;
  fs.renameSync(buildDirectory, destination);
  try {
    if (backup && !backup.empty) restoreBackup(backup.id, saveDir, backups);
  } catch (error) {
    // Preserve any partly restored files as well as the untouched previous build.
    if (fs.existsSync(buildDirectory)) fs.renameSync(buildDirectory, `${buildDirectory}.restore-failed-${crypto.randomUUID()}`);
    fs.renameSync(destination, buildDirectory);
    throw error;
  }
  return backup;
}

module.exports = { saveDirectory, gameDataEnvironment, backupRoot, cleanupWouldRemoveSaves, cardFiles: saveFiles, backupSaves, listBackups, backupFolder,
  restoreBackup, moveBuildKeepingSaves };
