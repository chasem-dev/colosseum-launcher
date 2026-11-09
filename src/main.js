'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, net, screen } = require('electron');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const port = require('./port');
const saves = require('./saves');
const gciSave = require('./gci-save');
const buildTools = require('./build-tools');
const compilerCache = require('./compiler-cache');
const windowsDlls = require('./windows-dlls');
const game = require('./game-version');
const updateChannel = require('./update-channel');
const gameSource = require('./game-source');
const gcAdapter = require('./gc-adapter');
const gbaLink = require('./gba');
const gen3Save = require('./gen3-save');
const appImageUpdate = require('./appimage-update');
const bindings = require('./bindings');
const portable = require('./portable');
const changelog = require('./changelog');
const { cleanOutputLine, createActivityReader } = require('./progress');
const { createActivityLog } = require('./activity-log');
const { observeProcess, exitDescription, failureMessage, taskEnvironment } = require('./process-output');
const { createSessionLog } = require('./session-log');
const displayScale = require('./display-scale');
const steam = require('./steam');
const crashReports = require('./crash-reports');
const telemetry = require('./telemetry');
const online = require('./online');
const discord = require('./discord');
const presence = require('./presence');
const parties = require('./parties');
const storyParty = require('./story-party');
const pokedexNames = require('./pokedex');
const pokedexData = pokedexNames.create();
const battleData = require('./battle-data').create();
const teamSets = require('./team-sets');
const pokemonPacks = require('./pokemon-packs');
const generations = require('./generations');
const hsdModel = require('./hsd-model');
const randomizer = require('./randomizer');
const languagePacks = require('./language-packs');
const { retrying, httpError } = require('./retry');

const GAME_NAME = 'Pokémon Colosseum';
const DISCORD_INVITE = 'https://discord.gg/pkVwBrSwsZ';
const PLAY_LABEL = `Play ${GAME_NAME}`;

let window;
let config;
const saveRun = randomizer.createSaveReader();
const spoilerFile = () => path.join(app.getPath('userData'), randomizer.SPOILER_FILE);
let active = null;
let preparingTools = false;
let operation = null;
// When the player last stopped a task (Stop), so a stopped build isn't tried again.
let stoppedAt = 0;
const wasStopped = since => stoppedAt >= since;
let appUpdate = { state: 'idle', message: '' };
let updater = null;
// Before anything reads userData: the single-instance lock is keyed on it too,
// so each portable folder runs independently of an installed launcher.
const portableRoot = portable.root();
if (portableRoot) {
  fs.mkdirSync(portableRoot, { recursive: true });
  app.setPath('userData', portableRoot);
  app.setPath('sessionData', path.join(portableRoot, 'Electron'));
}
const activityLog = createActivityLog();
const partialOutput = new Map();
const sessionLog = createSessionLog(() => app.getPath('userData'), error =>
  logOutput(`Could not save the session log: ${error.message}`, 'launcher'));
// `--play` (for a Steam shortcut's launch options) starts the game without the
// launcher's window and quits when the game closes.
const playOnStart = process.argv.includes('--play');
const ownsInstance = app.requestSingleInstanceLock();
if (!ownsInstance) app.quit();
else if (portableRoot && app.isPackaged)
  port.useLauncherScripts(portable.copyScripts(path.join(process.resourcesPath, 'scripts'), portableRoot));
app.on('second-instance', () => showWindow());

function showWindow() {
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

function broadcast(channel, data) {
  if (window && !window.isDestroyed()) window.webContents.send(channel, data);
}

function activityState() {
  const task = active || operation;
  return task ? { label: task.label, detail: task.detail, percent: task.percent,
    startedAt: task.startedAt, canStop: Boolean(active?.child) } : null;
}

function log(message) {
  const lines = String(message).replace(/\r/g, '').split('\n');
  for (const line of lines) {
    if (!line) continue;
    logOutput(cleanOutputLine(line), 'launcher');
    sessionLog.write(cleanOutputLine(line), 'launcher');
  }
}

function logOutput(text, stream, previous) {
  const entry = activityLog.write(text, stream, previous);
  if (stream !== 'launcher') partialOutput.set(entry.id, entry);
  broadcast('log', entry);
  return entry;
}

function completeOutput(text, stream, entry) {
  sessionLog.write(text, stream);
  if (entry) partialOutput.delete(entry.id);
}

function flushPartialOutput() {
  for (const entry of partialOutput.values()) sessionLog.write(entry.text, entry.stream);
  partialOutput.clear();
}

// Monitoring preserves Node's normal fatal-error behavior while retaining the
// diagnostic on disk, even when the launcher cannot keep its window alive.
process.on('uncaughtExceptionMonitor', error => {
  log(`Uncaught launcher error: ${error.stack || error.message}`);
  flushPartialOutput();
});
process.on('warning', warning => log(`Launcher warning: ${warning.stack || warning.message}`));
app.on('render-process-gone', (_event, _contents, details) => {
  log(`Launcher renderer ${details.reason}: ${exitDescription('Renderer', details.exitCode, null)}`);
});
app.on('child-process-gone', (_event, details) => {
  log(`Launcher ${details.type} process ${details.reason}: ${exitDescription(details.name || details.type, details.exitCode, null)}`);
});

// A game source chosen under Settings, with the commits it resolved to.
function savedGameSource(saved) {
  try {
    const override = gameSource.normalizeOverride(saved?.override);
    const resolved = saved?.resolved;
    if (!override || !/^[a-f0-9]{40}$/.test(resolved?.commit) || !/^[a-f0-9]{40}$/.test(resolved?.decomp) ||
      (resolved?.renderer && !/^[a-f0-9]{40}$/.test(resolved.renderer.commit))) return null;
    return { override, resolved: { ...resolved, custom: true, override } };
  } catch (_) { return null; }
}

function currentSource() { return config.gameSource?.resolved || game.release; }

async function chooseGameSource(input) {
  await ensureBuildTools();
  const override = gameSource.normalizeOverride(input);
  if (!override) {
    config.gameSource = null;
    saveConfig();
    log(`Game source: this launcher release (${game.release.version}). Update game to switch back.`);
    return state();
  }
  const resolved = await gameSource.resolve(override, { capture, env: toolEnv() });
  config.gameSource = { override, resolved };
  saveConfig();
  log(`Game source: ${resolved.repository} at ${resolved.commit.slice(0, 12)}, decomp ${resolved.decompRepository || 'pinned by it'} at ${resolved.decomp.slice(0, 12)}. Update game to build it.`);
  return state();
}

// Update game follows a chosen branch to its newest commit.
async function refreshGameSource() {
  if (!config.gameSource) return;
  try {
    const resolved = await gameSource.resolve(config.gameSource.override, { capture, env: toolEnv() });
    if (resolved.commit !== config.gameSource.resolved.commit || resolved.decomp !== config.gameSource.resolved.decomp) {
      config.gameSource = { ...config.gameSource, resolved };
      saveConfig();
      log(`Game source moved to ${resolved.version}.`);
    }
  } catch (error) { log(`Could not check the chosen game source for changes: ${error.message}`); }
}

function configFile() { return path.join(app.getPath('userData'), 'preferences.json'); }

function defaultRepo() { return path.join(app.getPath('userData'), 'game'); }

function saveConfig() {
  const file = configFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(portable.storedPaths(config, portableRoot), null, 2), { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function loadConfig() {
  let saved = {};
  try { saved = portable.resolvedPaths(JSON.parse(fs.readFileSync(configFile(), 'utf8')), portableRoot); } catch (_) { /* first run */ }
  config = {
    repo: typeof saved.repo === 'string' ? saved.repo : defaultRepo(),
    rom: typeof saved.rom === 'string' ? saved.rom : '',
    // The player's Pokémon Battle Revolution disc file, for its models (makePbrModels)
    pbrDisc: typeof saved.pbrDisc === 'string' ? saved.pbrDisc : '',
    settings: port.moveToMetal(port.normalizeSettings(saved.settings || {}), saved.movedToMetal),
    // Only once Metal is on offer: a Mac still on a Rosetta game moves when its game turns native.
    movedToMetal: Boolean(saved.movedToMetal) || port.platformInfo().renderers[0] === 'metal',
    installRoot: typeof saved.installRoot === 'string' ? saved.installRoot : null,
    previousInstall: saved.previousInstall || null,
    completedSetup: Boolean(saved.completedSetup),
    // Whether Play has offered Add to Steam on SteamOS yet (it does once).
    steamOffered: Boolean(saved.steamOffered),
    // Whether the launcher has offered to fix a Steam shortcut without --no-sandbox.
    steamFixOffered: Boolean(saved.steamFixOffered),
    gameSource: savedGameSource(saved.gameSource),
    // The newest launcher version whose changelog the player has been shown.
    changelogSeen: changelog.baseVersion(saved.changelogSeen),
    // Which wording of Beta's notes a Beta build last showed.
    changelogBetaSeen: /^[a-f0-9]{16}$/.test(saved.changelogBetaSeen) ? saved.changelogBetaSeen : null,
    // Random, made on first run, and only ever sent with usage heartbeats.
    installId: telemetry.validInstallId(saved.installId) ? saved.installId : crypto.randomUUID(),
    // The trainer name, parties and room options of the Online page.
    online: parties.normalize(saved.online),
    // The Game Boy Advance's BIOS, and each socket's Game Pak and save (Settings → Game Boy Advance).
    gba: gbaLink.normalize(saved.gba)
  };
  if (config.installId !== saved.installId) {
    try { saveConfig(); } catch (error) { log(`Could not save preferences: ${error.message}`); }
  }
  for (const root of [config.repo, config.previousInstall?.repo].filter(Boolean)) {
    try { if (game.recoverBuild(root)) log('Recovered your previous game after interrupted setup.'); }
    catch (error) { log(`Game recovery: ${error.message}`); }
  }
  config.completedSetup ||= fs.existsSync(port.binaryPath(config.repo));
  if (portableRoot) settleMovedPortableFolder();
}

// A portable folder copied to another drive or computer plays from where it is
// now: its updates' links follow it, and when the chosen disc stayed behind, a
// disc kept in the folder or beside the .exe is used.
function settleMovedPortableFolder() {
  for (const root of [config.repo, config.previousInstall?.repo].filter(Boolean)) {
    try {
      const relinked = game.relinkUserFolders(root, file => portable.relocated(file, portableRoot));
      if (relinked.length) log(`Reconnected ${relinked.join(', ')} after the portable folder moved.`);
    } catch (error) { log(`Could not reconnect the game's files after the portable folder moved: ${error.message}`); }
  }
  try { port.validateRom(config.rom); return; } catch (_) { /* missing or never chosen */ }
  const disc = portable.findDisc(portableRoot, port.validateRom);
  if (!disc) return;
  config.rom = disc;
  log(`Using the game disc at ${disc}.`);
  try { saveConfig(); } catch (error) { log(`Could not save preferences: ${error.message}`); }
}

async function exclusive(label, callback, newLog = false) {
  if (operation || active || preparingTools) throw new Error('Wait for the current task to finish, or stop it first.');
  if (newLog) {
    activityLog.reset();
    partialOutput.clear();
    broadcast('log-reset', activityLog.resetSequence());
    sessionLog.reset();
  }
  operation = { label, detail: 'Starting…', percent: null, startedAt: Date.now() };
  broadcast('activity', operation);
  try {
    if (removingOldVersions) {
      removingOldVersions.stop = true;
      await removingOldVersions.done;
    }
    return await callback();
  }
  catch (caught) {
    // A full drive, or Windows' Mandatory ASLR breaking MSYS2's fork(), says
    // what to do about it instead of the raw ENOSPC or Git's fork error.
    const error = hintedError(caught) || caught;
    if (!error.activityLogged) {
      log(`✕ ${label}: ${error.message}`);
      error.activityLogged = true;
    }
    throw error;
  }
  finally {
    operation = null;
    broadcast('activity', null);
    if (config) broadcastOnline(); // a task can install or update the game, which rooms depend on
  }
}

// Whether a command said so, for the GameCube adapter's checks: its output, or '' when it could not run.
function commandOutput(command, args) {
  return new Promise(resolve => execFile(command, args, { timeout: 8000, windowsHide: true }, (error, stdout) => resolve(error ? '' : String(stdout))));
}

let gcAdapterLogged = '';
async function gcAdapterStatus() {
  let status = { present: false };
  if (process.platform === 'linux') status = gcAdapter.linuxStatus();
  else if (process.platform === 'win32') {
    status = gcAdapter.windowsStatus(await commandOutput('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', gcAdapter.WINDOWS_QUERY]));
  } else if (process.platform === 'darwin') status = gcAdapter.macStatus(await commandOutput('ioreg', ['-p', 'IOUSB', '-l', '-w0']));
  const line = !status.present ? 'GameCube adapter: none plugged in (Wii U mode).'
    : status.readable ? `GameCube adapter: plugged in, the game can read it${status.via ? ` (${status.via})` : status.driver ? ` (${status.driver} driver)` : ''}.`
    : status.fix === 'udev' ? `GameCube adapter: plugged in, but this user can't open it (${[status.hidraw?.file, status.usb?.file].filter(Boolean).join(', ')}); it needs a udev rule.`
    : status.fix === 'driver' ? `GameCube adapter: plugged in, but Windows has no working driver for it (${status.status || 'no status'}).`
    : 'GameCube adapter: plugged in, but libusb is not installed (brew install libusb).';
  if (line !== gcAdapterLogged && (status.present || gcAdapterLogged)) log(line);
  gcAdapterLogged = line;
  return status;
}

// pkexec asks for the password, then installs the rule and applies it to the
// adapter already plugged in. Without pkexec, or with no password to give (a
// Steam Deck's user has none until one is set with passwd), the player copies
// the terminal command instead.
async function allowGcAdapter() {
  if (process.platform !== 'linux') return { ok: false, status: await gcAdapterStatus() };
  const { command, args } = gcAdapter.allowCommand();
  const error = await new Promise(resolve => execFile(command, args, { timeout: 120000 }, resolve));
  if (error) {
    const reason = error.code === 'ENOENT' ? 'pkexec is not installed'
      : error.code === 126 ? 'the password prompt was closed' : error.code === 127 ? 'the password was not accepted' : error.message.split('\n')[0];
    log(`GameCube adapter: the udev rule was not installed (${reason}).`);
    return { ok: false, reason, status: await gcAdapterStatus() };
  }
  log(`GameCube adapter: installed ${gcAdapter.RULES_FILE}.`);
  await new Promise(resolve => setTimeout(resolve, 1500)); // for udev to apply it
  return { ok: true, status: await gcAdapterStatus() };
}

// Add to Steam (steam.js). Steam reads non-Steam games only when it starts and
// writes them back when it closes, so an open Steam closes first (steam://exit).
// On Windows it opens again afterwards; on Linux the player opens it, since a
// Steam started from the AppImage runs in its environment (a Steam Deck player
// saw it open as Game Mode inside Desktop Mode).
function steamRunning() {
  const [command, args] = process.platform === 'win32' ? ['tasklist', ['/FI', 'IMAGENAME eq steam.exe', '/NH']] : ['pgrep', ['-x', 'steam']];
  return new Promise(resolve => execFile(command, args, { windowsHide: true },
    (error, stdout) => resolve(process.platform === 'win32' ? /steam\.exe/i.test(stdout || '') : !error)));
}

// Closed once it has stayed closed for several checks in a row: a Steam that
// starts again straight after exiting (as SteamOS can) would write its own copy
// of the list over the launcher's when it next closes.
async function waitForSteamToClose() {
  const deadline = Date.now() + 60000;
  for (let closed = 0; closed < 5;) {
    if (Date.now() > deadline) throw new Error("Steam didn't close. Close Steam yourself, then choose Add to Steam again.");
    closed = (await steamRunning()) ? 0 : closed + 1;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}

function windowsSteamPath() {
  return new Promise(resolve => execFile('reg', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'], { windowsHide: true },
    (error, stdout) => resolve(error ? null : steam.registrySteamPath(stdout))));
}

// Steam artwork comes straight from SteamGridDB into memory: no-store keeps it
// out of the launcher's web cache, so the only copy is the one in Steam's folder.
async function downloadImage(url) {
  return retrying(async () => {
    const response = await net.fetch(url, { cache: 'no-store' });
    if (!response.ok) throw httpError(`${url}: HTTP ${response.status}`, response.status);
    return Buffer.from(await response.arrayBuffer());
  });
}

// The file Steam starts: the installed launcher, or the AppImage on Linux.
// Not in development, and not on macOS.
function launcherExe() {
  if (!app.isPackaged || !['win32', 'linux'].includes(process.platform)) return null;
  // The portable launcher runs from a temporary copy: Steam starts the .exe the player has.
  return (process.platform === 'linux' ? process.env.APPIMAGE : process.env.PORTABLE_EXECUTABLE_FILE || process.execPath) || null;
}

const startedFromSteam = () => Boolean(process.env.SteamGameId || process.env.SteamAppId);

async function locateSteam() {
  const registryPath = process.platform === 'win32' ? await windowsSteamPath() : null;
  const root = steam.findSteam(steam.steamRoots({ registryPath }));
  return root ? { root, accounts: steam.steamAccounts(root) } : null;
}

// SteamOS, as on a Steam Deck (LCD or OLED alike): Play offers Add to Steam there once.
function onSteamOS() {
  if (process.platform !== 'linux') return false;
  const read = file => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };
  return steam.isSteamOS({ osRelease: read('/etc/os-release'), vendor: read('/sys/devices/virtual/dmi/id/sys_vendor') });
}

// The home screen's Steam banner: Add to Steam while Steam is installed and the
// launcher is not in its library yet, and a tick once it is. `reason` says why,
// and goes in the log whenever it changes, so a player's saved log shows it.
// The AppImage needs `--no-sandbox` from Steam: without it, a shortcut opens
// the launcher in Desktop Mode but not in Game Mode. AppImages built with
// scripts/after-pack.js always pass it themselves (COLO_LAUNCHER_NO_SANDBOX), so
// for them a shortcut without it needs no fix; new shortcuts still get it.
const STEAM_LAUNCH_OPTIONS = process.platform === 'linux' ? '--no-sandbox' : '';
const sandboxAlwaysOff = process.env.COLO_LAUNCHER_NO_SANDBOX === '1';
delete process.env.COLO_LAUNCHER_NO_SANDBOX; // not passed on to the game or Steam

async function readSteamStatus() {
  const exe = launcherExe();
  if (!exe) return { available: false, reason: process.platform === 'linux' && app.isPackaged
    ? "Add to Steam isn't offered: the launcher isn't running from its AppImage." : null };
  if (startedFromSteam()) {
    // Steam's shortcut started this launcher, so its options are ours.
    const needsFix = !sandboxAlwaysOff && steam.missingOptions(process.argv.slice(1).join(' '), STEAM_LAUNCH_OPTIONS);
    return { available: false, inSteam: true, needsFix, reason: needsFix
      ? `Steam: the launcher was started from a Steam shortcut without ${STEAM_LAUNCH_OPTIONS}, so it won't open in Game Mode.`
      : 'Steam: the launcher was started from Steam, so it is in your Steam library.' };
  }
  const located = await locateSteam();
  if (!located) return { available: false, reason: "Add to Steam isn't offered: no signed-in Steam was found on this computer." };
  if (!located.accounts.length)
    return { available: false, reason: `Add to Steam isn't offered: nobody has signed in to Steam at ${located.root} yet.` };
  const options = steam.shortcutLaunchOptions({ ...located, exe });
  const inSteam = steam.hasShortcut({ ...located, exe });
  const steamOS = onSteamOS();
  const needsFix = inSteam && !sandboxAlwaysOff && steam.missingOptions(options, STEAM_LAUNCH_OPTIONS);
  return { available: true, inSteam, needsFix, skipLauncher: steam.skipsLauncher(options), steamOS,
    offer: steamOS && !inSteam && !config.steamOffered,
    offerFix: needsFix && !config.steamFixOffered,
    reason: needsFix ? `Steam: the launcher's shortcut in Steam is missing ${STEAM_LAUNCH_OPTIONS}, so it won't open in Game Mode (${located.root}).`
      : inSteam ? `Steam: the launcher is in your Steam library (${located.root}).`
      : `Steam: the launcher isn't in your Steam library yet (${located.root}${steamOS ? ', SteamOS' : ''}), so Add to Steam is offered.` };
}

let steamReasonLogged = null;
async function steamStatus() {
  let status;
  try { status = await readSteamStatus(); }
  catch (error) { status = { available: false, reason: `Add to Steam isn't offered: Steam could not be checked (${error.message}).` }; }
  if (status.reason && status.reason !== steamReasonLogged) log(status.reason);
  steamReasonLogged = status.reason;
  return status;
}
// Play offers Add to Steam on SteamOS only once, and opening the launcher
// offers to fix a shortcut without --no-sandbox only once, whatever the player chooses.
function markSteamOffered(prompt) {
  config[prompt === 'fix' ? 'steamFixOffered' : 'steamOffered'] = true;
  saveConfig();
}

// `play` (Skip Launcher) adds `--play`, so Steam starts the game without the launcher's window.
async function addToSteam({ play = false } = {}) {
  const exe = launcherExe();
  if (!exe) throw new Error(process.platform === 'linux' ? 'Add to Steam works from the launcher AppImage.' : 'Add to Steam works from the installed launcher on Windows and Linux.');
  if (startedFromSteam()) throw new Error('The launcher was started from Steam, so it is already in your Steam library.');
  const located = await locateSteam();
  if (!located) throw new Error("Steam isn't installed on this computer, or nobody has signed in to it yet.");
  const { root, accounts } = located;
  if (!accounts.length) throw new Error('Sign in to Steam once, then try again.');
  log('Downloading Steam artwork from SteamGridDB…');
  const artwork = await steam.downloadArtwork(downloadImage);
  const wasRunning = await steamRunning();
  const reopen = wasRunning && process.platform === 'win32';
  if (wasRunning) {
    const answer = await dialog.showMessageBox(window, {
      type: 'question', buttons: ['Cancel', 'Close Steam and add'], defaultId: 1, cancelId: 0,
      message: 'Close Steam to add the launcher?',
      detail: `Steam picks up new non-Steam games only when it starts, so it closes for a moment${reopen ? ' and opens again afterwards' : '. Open it again once the launcher says it was added'}.`
    });
    if (answer.response !== 1) return { cancelled: true };
  }
  // Each folder's list is backed up before Steam closes, since Steam writes its
  // own over it as it exits (see steam.snapshotShortcuts).
  const snapshot = steam.snapshotShortcuts({ root });
  log(`Steam's non-Steam games before ${wasRunning ? 'closing Steam' : 'adding'} (${root}): ${steam.describeShortcuts(snapshot)}. Adding to account ${accounts.join(', ')}.`);
  if (wasRunning) {
    log('Closing Steam…');
    await shell.openExternal('steam://exit');
    await waitForSteamToClose();
    log(`Steam's non-Steam games after Steam closed: ${steam.describeShortcuts(steam.snapshotShortcuts({ root, backUp: false }))}.`);
  }
  const results = steam.addShortcut({ root, accounts, exe, startDir: path.dirname(exe), artwork, snapshot,
    launchOptions: STEAM_LAUNCH_OPTIONS, play: Boolean(play) });
  const added = results.some(result => result.added);
  const images = Math.min(...results.map(result => result.artwork));
  log(`${added ? 'Added' : 'Updated'} ${steam.APP_NAME} in Steam${play ? ' with Skip Launcher' : ''} (${images} of ${steam.ARTWORK.length} artwork images, ${root}).`);
  for (const result of results)
    log(`Steam account ${result.account}: kept its ${result.kept} other non-Steam games${result.backup ? `; the list from before is saved as ${result.backup}` : ''}.`);
  if (reopen) shell.openExternal('steam://open/games').catch(() => {});
  return { added, play: Boolean(play), name: steam.APP_NAME, artwork: images, total: steam.ARTWORK.length, reopened: reopen };
}


function requireRepo() {
  if (!port.isPort(config.repo)) throw new Error('Download the setup files or choose a folder that already has them.');
  return config.repo;
}

function currentSaveDirectory() { return saves.saveDirectory(); }

// The backups the launcher makes by itself, which Back up automatically (Saves) turns off. Back up saves, and the backups
// before a restore or before moving a build the card is in, still happen.
const AUTOMATIC_BACKUPS = { 'before-play': 'before playing', 'after-play': 'after playing',
  'before-port-update': 'before the update', 'before-cleanup': 'before cleanup' };

function makeSaveBackup(reason) {
  if (active) throw new Error('Stop the running game or task before backing up saves.');
  if (AUTOMATIC_BACKUPS[reason] && config.settings.autoBackups === false) {
    log(`Saves not backed up ${AUTOMATIC_BACKUPS[reason]}: automatic backups are off under Saves.`);
    return { skipped: true };
  }
  const result = saves.backupSaves(currentSaveDirectory(), saves.backupRoot(), reason);
  log(result.empty ? result.message : `Saved ${result.count} memory card file(s) to ${result.directory}`);
  return result;
}

async function launch(command, args, options = {}, label = 'Task', isGame = false) {
  if (active) throw new Error(`Wait for ${active.label} to finish, or stop it first.`);
  try {
    log(`▶ ${label}`);
    // Windows applies windowsHide's "start hidden" to a program's first window,
    // so the game would run with an invisible window. Detached instead, the game
    // (a console program) gets no console window and shows its own normally.
    const windowsGame = isGame && process.platform === 'win32';
    // Python writes UTF-8, as this log reads it: on Windows it otherwise uses
    // the system code page, and cp1251 can't print the "ñ" in "Español".
    const child = spawn(command, args, { ...options, detached: process.platform !== 'win32' || windowsGame,
      env: { ...(isGame ? options.env || process.env : taskEnvironment(options.env || process.env)),
        PYTHONUNBUFFERED: '1', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
      windowsHide: !windowsGame, stdio: ['ignore', 'pipe', 'pipe'] });
    active = { label, child, detail: label.includes('build tools') ? 'Downloading and preparing tools…' : 'Starting…',
      percent: null, startedAt: Date.now() };
    broadcast('activity', activityState());
    const recent = [], readActivity = createActivityReader();
    // The game's [presence] lines go to Discord, not the activity log; a
    // partial line that could become one waits for the rest.
    function output(text, stream, entry) {
      if (isGame && stream === 'stdout' && !entry && text
        && (presence.isPresenceLine(text) || presence.PREFIX.startsWith(text))) return entry;
      return logOutput(text, stream, entry);
    }
    function line(value, stream, entry) {
      if (isGame && stream === 'stdout' && presence.isPresenceLine(value)) return onPresence?.(value);
      completeOutput(value, stream, entry);
      if (!value) return;
      if (recent.push(value) > 80) recent.shift();
      const progress = isGame ? null : readActivity(value);
      if (progress && active && active.child === child) {
        Object.assign(active, progress);
        broadcast('activity', activityState());
      }
    }
    const { error, code, signal } = await observeProcess(child, { output, line });
    active = null;
    broadcast('activity', activityState());
    if (error) throw error;
    if (code !== 0 || signal) {
      throw Object.assign(new Error(failureMessage(label, { code, signal }, recent, { game: isGame })), { exitCode: code, output: recent.slice() });
    }
    log(`✓ ${label} finished`);
    return { ok: true };
  } catch (error) {
    log(`✕ ${error.message}`);
    error.activityLogged = true;
    throw error;
  }
}

async function capture(command, args, cwd, env = process.env) {
  try {
    log(`▶ ${command} ${args.join(' ')}`);
    const child = spawn(command, args, { cwd, env: taskEnvironment(env), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const { error, code, signal, stdout, stderr } = await observeProcess(child, { output: logOutput, line: completeOutput, capture: true });
    if (error) throw error;
    if (code !== 0 || signal) throw new Error(`${exitDescription(command, code, signal)}${stderr.trim() ? `: ${stderr.trim()}` : ''}`);
    return stdout.trim();
  } catch (error) {
    log(`✕ ${error.message}`);
    error.activityLogged = true;
    throw error;
  }
}

// The clearer error for a failed step that ran out of disk space or couldn't
// fork() on Windows, or null (build-tools.js hintedError). exclusive() logs it.
function hintedError(error) {
  try { return buildTools.hintedError(error, { dataFolder: app.getPath('userData'), gameFolder: config?.repo }); }
  catch (_) { return null; }
}

function toolEnv(base = process.env) {
  return buildTools.environment(app.getPath('userData'), base);
}

function toolsStatus() {
  return buildTools.status(app.getPath('userData'), process.platform, process.env);
}

async function checkTools(refresh = false) {
  return buildTools.check(app.getPath('userData'), { refresh });
}

// A Windows game folder or build tools too deep for the compiler, or a game
// folder with an & in its path, fail deep into the build with "No such file
// or directory". The launcher shows this when it opens, and stops before
// downloading the tools or building. root defaults to where the next game
// update builds.
function pathProblem(root = config.repo && game.snapshotPath(config.installRoot || config.repo, currentSource())) {
  if (process.platform !== 'win32' || !root) return null;
  const folder = portableRoot || path.dirname(config.installRoot || config.repo);
  return port.longPathProblem(root, { portable: Boolean(portableRoot), folder,
    msys: process.env.COLO_MSYS2_ROOT || path.join(buildTools.rootFor(app.getPath('userData')), 'msys64') }) ||
    port.pathCharacterProblem(root, { portable: Boolean(portableRoot), folder });
}

// The last one that stopped a build, which the launcher shows in place of the
// next update's: a fresh build's folder is longer.
let blockedPath = null;
function requireBuildablePath(root) {
  const problem = blockedPath = pathProblem(root);
  if (!problem) return;
  log(problem.message);
  throw new Error(problem.message);
}

async function ensureBuildTools() {
  await prepareBuildTools();
  shieldBuildTools();
}

// Another program's same-named DLLs in System32 stand in for the build tools'
// own (windows-dlls.js): the compiler then fails without a message, which
// CMake reports as "not able to compile a simple test program". The prepared
// tools get their DLLs beside each program that needs them; a player's own
// MSYS2 is left as it is, with the cause in the activity log.
let ownToolsWarned = false;
function shieldBuildTools() {
  if (process.platform !== 'win32') return;
  const own = toolsStatus().mode === 'own';
  if (own && ownToolsWarned) return;
  const msys = own ? process.env.COLO_MSYS2_ROOT : path.join(buildTools.rootFor(app.getPath('userData')), 'msys64');
  const result = windowsDlls.shieldToolchain(msys, { place: !own });
  for (const error of result.errors) log(`Could not give the build tools their own DLL: ${error}`);
  if (!result.conflicts.length) return;
  if (own) {
    ownToolsWarned = true;
    log(`Windows has its own copies of ${systemDllList(result.conflicts)}, which your MSYS2's compiler loads instead of MSYS2's. ` +
      'If the build says the compiler is not able to compile a simple test program, remove COLO_MSYS2_ROOT to use the prepared build tools.');
  } else if (result.placed.length) {
    log(`Windows has its own copies of ${systemDllList(result.conflicts)}. The build tools now use theirs instead.`);
  }
}

function systemDllList(files) {
  const names = [...new Set(files.map(file => path.basename(file)))];
  const folders = [...new Set(files.map(file => path.dirname(file)))];
  return `${names.join(', ')} in ${folders.join(' and ')}`;
}

async function prepareBuildTools() {
  requireBuildablePath();
  if (preparingTools) throw new Error('Wait for build tools to finish preparing.');
  if (active) throw new Error(`Wait for ${active.label} to finish, or stop it first.`);
  const userData = app.getPath('userData');
  const forcePrivate = process.env.COLO_FORCE_PRIVATE_TOOLS === '1';
  if (process.platform === 'darwin') {
    preparingTools = true;
    try {
      const found = await checkTools(true);
      if (!found.appleReady) throw new Error(found.message);
      if (found.ready && !forcePrivate) return;
    } finally { preparingTools = false; }
  }
  const found = toolsStatus();
  if (found.mode === 'private' || (!forcePrivate && found.ready)) return;
  preparingTools = true;
  const startedAt = Date.now();
  log(`Downloading build tools to ${path.dirname(buildTools.rootFor(userData))}.`);
  active = { label: 'Download build tools', child: null, detail: 'Checking download…', percent: null, startedAt };
  broadcast('activity', { label: active.label, detail: active.detail, percent: null, startedAt });
  try {
    await buildTools.prepare(userData, {
      forcePrivate,
      progress(percent, detail) {
        if (!active || active.child) return;
        if (detail && detail !== active.detail) log(detail);
        active.detail = detail || (percent === null ? 'Downloading tools…' : `Downloading tools: ${percent}%`);
        active.percent = percent;
        broadcast('activity', { label: active.label, detail: active.detail, percent, startedAt });
      },
      async run(command, args, options, label) {
        active = null;
        broadcast('activity', null);
        try { return await launch(command, args, options, label); }
        finally {
          if (preparingTools && !active) {
            active = { label: 'Download build tools', child: null, detail: 'Preparing build tools…', percent: null, startedAt };
            broadcast('activity', { label: active.label, detail: active.detail, percent: null, startedAt, canStop: false });
          }
        }
      }
    });
    log('Build tools are ready.');
  } catch (error) {
    // Rare, and the files go again on the next try unless the player acts, so
    // an alert rather than only a log line.
    if (error.missingTools && process.platform === 'win32' && window)
      void dialog.showMessageBox(window, { type: 'warning', buttons: ['OK'],
        message: 'Build tools are missing files after downloading', detail: error.message }).catch(() => {});
    throw error;
  } finally {
    preparingTools = false;
    if (active && !active.child && active.startedAt === startedAt) {
      active = null;
      broadcast('activity', null);
    }
  }
}

async function updatePort() {
  requireRepo();
  port.validateRom(config.rom);
  // Removed build tools download again only for a game that needs building.
  if (config.gameSource || !game.isCurrent(config.repo, currentSource())) {
    await ensureBuildTools();
    await refreshGameSource();
  }
  if (game.isCurrent(config.repo, currentSource())) {
    log(config.gameSource ? 'Your game is up to date with the chosen game source.' : 'Your game is up to date for this launcher release.');
    return state();
  }
  await build();
  return state();
}

async function installPort() {
  await ensureBuildTools();
  const destination = config.repo;
  if (port.isPort(destination)) return { ok: true };
  if (fs.existsSync(destination)) {
    if (!fs.statSync(destination).isDirectory() || fs.readdirSync(destination).length)
      throw new Error('That folder is not empty. Choose another download location.');
    fs.rmdirSync(destination);
  }
  await game.checkout(destination, { run: launch, capture, env: toolEnv(), source: currentSource(), stopped: wasStopped });
  return { ok: true };
}

// Manage game → Remove build tools. Only Windows: its game links its libraries in and plays without them
// (game.playsWithoutTools); on Linux and macOS the game loads libraries from the tools. The tools
// download again the next time the launcher builds or sets up the game (ensureBuildTools).
function buildToolsFolder() { return path.dirname(buildTools.rootFor(app.getPath('userData'))); }

async function removeBuildTools() {
  if (process.platform !== 'win32') throw new Error('On this computer the game runs with libraries from the build tools, so they stay.');
  if (toolsStatus().mode === 'own') throw new Error('The launcher builds with your own MSYS2 (COLO_MSYS2_ROOT) and never removes it.');
  requireRepo();
  if (!binaryReady() || !game.playsWithoutTools(config.repo))
    throw new Error('The game still needs DLLs from the build tools. Update or rebuild the game, then try again.');
  const folder = buildToolsFolder();
  if (operation) {
    Object.assign(operation, { detail: 'Removing build tools…', percent: null });
    broadcast('activity', activityState());
  }
  try { await fs.promises.rm(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
  catch (error) {
    throw new Error(`Some build tools could not be removed (${error.message}). Close programs using files in ${folder}, then try again.`);
  }
  log(`Removed the build tools from ${folder}. The game plays without them; the launcher downloads them again the next time it builds or sets up the game.`);
  return state();
}

// The HD texture pack: a release of the port's own, downloaded and unpacked by the launcher's script with the
// build tools' Python, and shared by every game version (game.carryUserFiles).
async function installTextures(root = requireRepo()) {
  await ensureBuildTools();
  if (config.settings.textures && !port.texturePackInstalled(root)) {
    const cmd = port.textureCommand(root, process.platform, toolEnv());
    await launch(cmd.command, cmd.args, { cwd: cmd.cwd, env: cmd.env }, 'Install HD textures');
    if (!port.texturePackInstalled(root)) throw new Error('Texture installer finished without a usable texture pack.');
  } else if (config.settings.textures) log('HD textures are already installed.');
  log('HD visuals are ready for the next game launch.');
  return { installed: true };
}

function binaryReady(root = config.repo) {
  return port.isPort(root) && fs.existsSync(port.binaryPath(root));
}

async function build(forceFresh = false) {
  const original = requireRepo();
  const settings = { ...config.settings };
  const rom = port.validateRom(config.rom);
  const saveDirectory = currentSaveDirectory();
  makeSaveBackup('before-port-update');
  await ensureBuildTools();
  const source = currentSource();
  let root = original;
  const sourceMarker = path.join(root, 'launcher-source.json');
  const freshPinnedSource = fs.existsSync(sourceMarker) && !binaryReady(root) && game.matchesSource(root, source);
  if (forceFresh || (!game.isCurrent(root, source) && !freshPinnedSource)) {
    root = game.snapshotPath(config.installRoot || original, source);
    if (forceFresh || (fs.existsSync(root) && !game.matchesSource(root, source))) root += `.fresh-${Date.now()}`;
    if (!fs.existsSync(root)) await game.checkout(root, { run: launch, capture, env: toolEnv(), source, stopped: wasStopped });
    if (!game.matchesSource(root, source))
      throw new Error('The update folder has changed. Choose another setup location in Settings and try again.');
    game.carryUserFiles(original, root);
  }
  // A fresh build's folder is longer than the one ensureBuildTools checked.
  requireBuildablePath(root);
  if (!port.hdVisualsInstalled(root, settings)) await installTextures(root);
  // Only the icon needs it, so a build without it goes on without one.
  if (process.platform === 'win32') {
    try { port.placeMainDol(root, rom); }
    catch (error) { log(`Could not copy main.dol from your disc for the game's icon: ${error.message}`); }
  }
  const env = await withBuildCaches(toolEnv({ ...process.env, NINJA_STATUS: '[%f/%t] ' }), root);
  const compile = buildEnv => {
    const cmd = port.buildCommand(root, process.platform, buildEnv);
    return game.buildSafely(root, saveDirectory,
      // A build that fails because antivirus deleted or blocked a tool says so instead of the compiler's error.
      () => launch(cmd.command, cmd.args, { cwd: cmd.cwd, env: cmd.env }, 'Build Pokémon Colosseum')
        .catch(error => {
          const userData = app.getPath('userData');
          throw hintedError(error) || buildTools.deletedToolsError(userData) || buildTools.blockedToolError(userData, error.output) || error;
        }),
      { source, toolFolder: toolsStatus().mode === 'own' ? null : buildTools.rootFor(app.getPath('userData')) });
  };
  const startedAt = Date.now();
  let result;
  try { result = await compile(env); }
  catch (error) {
    // A failed build through the caches is tried once more without them, unless the player stopped it, the build
    // tools lost files, or the drive is full or Windows won't let them fork (which fail the same way again).
    if (!env.COLO_UNIT_CACHE || wasStopped(startedAt) || error.blockedTool || error.buildHint || buildTools.missingTools(app.getPath('userData'))?.length) throw error;
    log('The build failed with the compiler cache. Building again without it…');
    result = await compile(compilerCache.withoutCaches(env));
  }
  // Preferences switch only after a successful build. Closing the app or a
  // failed download/build leaves the last installation selected and playable.
  const earlier = { ...config };
  config = { ...config, repo: root, installRoot: config.installRoot || original, completedSetup: true,
    previousInstall: root !== original && binaryReady(original)
      ? { repo: original, settings, rom } : config.previousInstall };
  try { saveConfig(); }
  catch (error) { config = earlier; throw error; }
  log(`Game ${source.version} is ready. Your saved games stay in the same folder.`);
  await removeOldVersions();
  await removeOldBuildTools();
  await compilerCache.trim(app.getPath('userData')).catch(error => log(`Could not trim the compiler cache: ${error.message}`));
  return result;
}

// What every game version's build shares (compiler-cache.js). A player's own COLO_UNIT_CACHE (empty for none) is used
// instead. Without ccache the renderer compiles as before; the game's own units need nothing downloaded.
async function withBuildCaches(env, root) {
  if ('COLO_UNIT_CACHE' in process.env) return env;
  const userData = app.getPath('userData');
  try { return compilerCache.environment(env, await compilerCache.prepare(userData, { log }), { userData, root }); }
  catch (error) {
    log(`Building the renderer without the compiler cache: ${error.message}.`);
    return compilerCache.environment(env, null, { userData, root });
  }
}

async function removeOldBuildTools() {
  const keep = [];
  let unknown = false;
  for (const root of [config.repo, config.previousInstall?.repo].filter(Boolean)) {
    if (!fs.existsSync(port.binaryPath(root))) continue;
    const tools = game.toolRoot(root);
    if (tools) keep.push(tools);
    else unknown = true;
  }
  const removed = await buildTools.pruneToolsets(app.getPath('userData'), keep, { leftoversOnly: unknown,
    onError: (error, item) => log(`Could not remove old build tools ${item}: ${error.message}`) });
  if (removed.length) log(`Removed ${removed.length === 1 ? 'old build tools' : `${removed.length} old build tool folders`} ` +
    'that no game version uses any more, to free up disk space.');
}

// Keep the current and previous game versions; older ones, the first install
// once two updates replaced it, and the builds a rebuild replaced or left
// unfinished only take up space.
async function removeOldVersions(shouldStop) {
  if (!config.installRoot || !binaryReady()) return;
  const protect = [currentSaveDirectory(), config.rom, config.previousInstall?.rom];
  const failed = what => (error, folder) => log(['EBUSY', 'EPERM', 'EACCES'].includes(error.code) && error.path
    ? `Could not remove all of ${what} ${folder}: another program has ` +
      `${path.basename(error.path)} open. The launcher tries again the next time it starts.`
    : `Could not remove ${what} ${folder}: ${error.message}`);
  const removed = await game.pruneSnapshots(config.installRoot, [config.repo, config.previousInstall?.repo],
    protect, failed('old game version'), shouldStop);
  if (removed.length) log(`Removed ${removed.length} old game version${removed.length === 1 ? '' : 's'} to free up disk space.`);
  let builds = 0;
  for (const root of [config.repo, config.previousInstall?.repo].filter(Boolean)) {
    if (shouldStop?.()) break;
    builds += (await game.pruneBuildLeftovers(root, protect, failed('old game build'), shouldStop)).length;
  }
  if (builds) log(`Removed ${builds} replaced or unfinished game build${builds === 1 ? '' : 's'} to free up disk space.`);
}

// At startup old game versions are removed beside the window rather than as a
// task: on Windows that can take minutes, and Play or Update & play would have
// to wait for it. A task stops it after the file it is on (exclusive); the rest
// goes after the next update or start.
let removingOldVersions = null;
function removeOldVersionsInBackground() {
  const job = { stop: false };
  job.done = removeOldVersions(() => job.stop)
    .catch(error => log(`Could not remove old game versions: ${error.message}`))
    .finally(() => { if (removingOldVersions === job) removingOldVersions = null; });
  removingOldVersions = job;
}

async function setupGame() {
  requireRepo();
  port.validateRom(config.rom);
  if (!game.isCurrent(config.repo, currentSource())) await build();
  else if (!port.hdVisualsInstalled(config.repo, config.settings)) await installTextures();
  return state();
}

// The Play menu's Update only / Prepare only: everything Play would do first, then stay in the launcher.
// A chosen game source moves to its newest commit first, as Update game does.
async function prepareGame() {
  requireRepo();
  port.validateRom(config.rom);
  if (config.gameSource) {
    await ensureBuildTools();
    await refreshGameSource();
  }
  return setupGame();
}

// Changed keys go to a file of the launcher's own, so a bindings.txt kept by hand in the game folder is left alone.
function bindingsEnvironment(settings) {
  if (!Object.keys(settings.keyBindings || {}).length && !Object.keys(settings.padBindings || {}).length) return {};
  const file = path.join(app.getPath('userData'), 'bindings.txt');
  fs.writeFileSync(file, bindings.fileText(settings.keyBindings, settings.padBindings));
  return { COLO_BINDINGS: file };
}

function customTextureDirectory() { return port.customTextureDirectory(app.getPath('userData')); }

// --- Pokémon packs (src/pokemon-packs.js): read from their folder for each play and for the Pokédex.
function pokemonPacksDirectory() { return pokemonPacks.packsDirectory(app.getPath('userData')); }

let packTables = null;   // { rom, tables }: what the disc has, read once for each disc
// The packs in their folder, and the later generations' Pokémon, moves and rules the settings ask for.
function readPokemonPacks(rom, settings = config.settings) {
  if (packTables?.rom !== rom) packTables = { rom, tables: pokemonPacks.readGameTables(rom) };
  const { tables } = packTables;
  const packs = fs.existsSync(pokemonPacksDirectory())
    ? pokemonPacks.loadPacks(pokemonPacksDirectory(), tables, pokemonPacks.readRegistry(currentSaveDirectory()))
    : { pokemon: [], problems: [], registry: { ids: {} }, registryChanged: false, missing: [] };
  const built = generations.build(tables, settings), fromGenerations = pokemonPacks.generationPokemon(tables, built, { modelsDirectory: pbrModels() });
  return { tables, ...packs, built, generationPokemon: fromGenerations.pokemon,
    problems: [...packs.problems, ...fromGenerations.problems] };
}

const packLabel = problem => `${problem.pack}${problem.entry ? `/${problem.entry}` : ''}`;

// --- Battle Revolution models (the game's tools/pbr2pkx): the player's own Battle Revolution disc, made into models and
// icons for the later generations' Pokémon, which then look as they do there instead of as a stand-in.
function pbrWork() { return path.join(app.getPath('userData'), 'battle-revolution'); }
function pbrModels() { return path.join(pbrWork(), 'models'); }
// The National Pokédex numbers a model is wanted for: the Pokémon of each generation imported
function pbrWanted(settings = config.settings) {
  const numbers = [];
  for (const generation of settings.generationPokemon || []) {
    const [first, last] = generations.load(generation).newSpecies;
    for (let n = first; n <= last; n++) numbers.push(n);
  }
  return numbers;
}
function pbrState() {
  const wanted = pbrWanted(), made = wanted.filter(n => fs.existsSync(path.join(pbrModels(), String(n), 'model.pkx'))).length;
  return { disc: config.pbrDisc || null, wanted: wanted.length, made,
    supported: Boolean(config.repo && fs.existsSync(port.pbrModelsScript(config.repo))) };
}
async function makePbrModels() {
  const root = requireRepo(), wanted = pbrWanted();
  if (!config.pbrDisc || !fs.existsSync(config.pbrDisc)) throw new Error('Choose your Pokémon Battle Revolution disc file first.');
  if (!wanted.length) throw new Error('Turn on a later generation\'s Pokémon first: their models are what this makes.');
  if (!fs.existsSync(port.pbrModelsScript(root))) throw new Error('This version of the game can\'t make Battle Revolution models yet. Update it from the Play page.');
  await ensureBuildTools();
  const cmd = port.pbrModelsCommand(root, config.pbrDisc, pbrWork(), wanted, process.platform, toolEnv());
  await launch(cmd.command, cmd.args, { cwd: cmd.cwd, env: cmd.env }, 'Make Battle Revolution models');
  const { made } = pbrState();
  log(`Battle Revolution models: ${made} of ${wanted.length} made. They show in the Pokédex, and in your next game.`);
  return state();
}

// The file of packs for the game to load, or null when there are none. Each Pokémon keeps its
// row of the species table from then on (pokemon-packs.json, beside the saves).
function preparePokemonPacks(rom, folder) {
  const loaded = readPokemonPacks(rom);
  for (const problem of loaded.problems) log(`Pokémon pack ${packLabel(problem)}: ${problem.message}`);
  for (const name of loaded.missing) log(`Pokémon pack ${name} isn't in the packs folder: Pokémon of it in your saves stay hidden until it's back.`);
  const pokemon = [...loaded.pokemon, ...loaded.generationPokemon], { moves, rules } = loaded.built;
  if (!pokemon.length && !moves.length && !rules) return null;
  if (loaded.registryChanged) pokemonPacks.writeRegistry(currentSaveDirectory(), loaded.registry);
  const file = path.join(folder, 'pokemon-packs.bin');
  fs.writeFileSync(file, pokemonPacks.compile({ pokemon, moves, rules }));
  if (loaded.pokemon.length) log(`Pokémon packs: ${loaded.pokemon.map(each => `${pokedexNames.displayName(each.name)}${each.form ? ` (${each.form})` : ''} from ${each.key}`).join(', ')}.`);
  for (const generation of config.settings.generationPokemon) log(`Generation ${generation} Pokémon: ${loaded.generationPokemon.filter(each => each.generation === generation).length} Pokémon and ${moves.length} new moves.`);
  if (rules) log(`Battle rules: generation ${rules.generation}.`);
  return file;
}

// The Pokédex's list: the disc's Pokémon, and the packs' after the ones they're based on.
let pokedexPacks = new Map();   // key -> the pack Pokémon, for its model
function pokedexList(rom) {
  const species = pokedexData.list(rom);
  let packs = [], problems = [];
  try {
    {
      const loaded = readPokemonPacks(rom);
      problems = loaded.problems.map(problem => `${packLabel(problem)}: ${problem.message}`);
      const all = [...loaded.pokemon, ...loaded.generationPokemon];
      const entries = pokemonPacks.pokedexEntries(all, loaded.tables);
      pokedexPacks = new Map();
      packs = entries.map((entry, i) => {
        const each = all[i], base = species.find(item => item.national === each.base.national);
        pokedexPacks.set(entry.pack.key, { base: each.base.national, files: { model: each.assets.model, modelShiny: each.assets.modelShiny } });
        return { ...entry, key: `pack:${entry.pack.key}`,
          sprite: each.images.body ? `data:image/png;base64,${each.images.body.toString('base64')}` : base?.sprite || null,
          forms: each.assets.model ? [{ id: 'model', label: 'Normal' }, ...(each.assets.modelShiny ? [{ id: 'modelShiny', label: 'Shiny' }] : [])] : base?.forms || [] };
      });
    }
  } catch (error) { problems = [error.message]; }
  return { species, packs, problems };
}

// Where a Pokédex entry's look is: a model file of its pack's, or a model on the disc (its base's, for a pack Pokémon
// without one). key is a pack Pokémon's "pack:<pack>/<folder>", or a disc Pokémon's National Pokédex number.
function pokedexLook(key, form) {
  const name = String(key);
  if (!name.startsWith('pack:')) return { national: Number(name) };
  const entry = pokedexPacks.get(name.slice('pack:'.length));
  if (!entry) throw new Error('That Pokémon isn\'t in your packs any more.');
  if (form !== 'model' && form !== 'modelShiny') return { national: entry.base };
  if (!entry.files[form]) throw new Error('That Pokémon has no such model.');
  return { pkx: entry.files[form] };
}

// Language packs, in the launcher's own folder: every game version uses them (language-packs.js).
function languageFolder() { return languagePacks.folder(app.getPath('userData')); }

// The chosen language's pack, downloaded first when this launcher's catalog has it and it isn't there yet.
async function ensureLanguage(settings) {
  if (!languagePacks.needsInstall(settings, languageFolder())) return;
  const pack = languagePacks.catalogPack(settings.language);
  log(`Downloading the ${pack.name} language pack (${(pack.size / 1048576).toFixed(1)} MB).`);
  try {
    await languagePacks.install(languageFolder(), pack, {
      onProgress: (have, size) => {
        if (!operation) return;
        Object.assign(operation, { detail: `Downloading ${pack.name}…`, percent: size ? Math.min(100, Math.round(have / size * 100)) : null });
        broadcast('activity', activityState());
      }
    });
  } catch (error) {
    throw new Error(`Couldn't download the ${pack.name} language pack (${error.message}). Check your connection, or choose English under Settings → Gameplay.`);
  }
  log(`The ${pack.name} language pack is ready.`);
}

// A game that closed with an error says where its crash report is, when it left one.
function noteCrashReport(error, since) {
  const report = crashReports.newestSince(crashReports.directory(), since);
  if (!report) return;
  log(`Crash report: ${report.file}`);
  error.message += ' Settings → Launcher can copy its crash report for a bug report.';
}

async function play(installation = null, battle = null) {
  const root = installation?.repo || requireRepo();
  // The player's choices, not the build's: an earlier install plays with them too.
  const settings = installation ? { ...config.settings, textures: installation.settings?.textures ?? config.settings.textures } : config.settings;
  const rom = port.validateRom(installation?.rom || config.rom);
  if (!binaryReady(root)) throw new Error('Set up this version of the game before playing.');
  if (!port.hdVisualsInstalled(root, settings))
    throw new Error('HD visuals need to be set up. Return to the main screen to finish setup, or turn them off in Settings.');
  await ensureLanguage(settings);
  // An online battle plays on no save: the memory card stays as it was.
  if (!battle) makeSaveBackup('before-play');
  const cacheFolder = path.join(app.getPath('userData'), 'game-cache');
  fs.mkdirSync(cacheFolder, { recursive: true });
  // An online battle has no packs: both players' games must have the same Pokémon.
  let packsFile = null;
  if (!battle) {
    try { packsFile = preparePokemonPacks(rom, cacheFolder); }
    catch (error) { log(`Pokémon packs weren't loaded: ${error.message}`); }
  }
  const playEnv = { ...port.buildEnvironment(settings, rom, root, { customTextures: customTextureDirectory() }),
    ...saves.gameDataEnvironment(), ...bindingsEnvironment(settings), ...languagePacks.environment(settings, languageFolder()),
    ...gbaLink.environment(config.gba, settings, gbaBackupFolder()),
    // The renderer's caches, in the launcher's own folder: its default place is shared with the Sunshine port's.
    COLO_RANDOMIZER_LOG: spoilerFile(),
    SMS_GX_SHADER_CACHE: path.join(cacheFolder, 'gx-programs.bin'), SMS_TEXTURE_PACK_CACHE: path.join(cacheFolder, 'texture-mips'),
    ...(battle ? { COLO_ONLINE: String(battle.port), COLO_SKIP_MOVIES: '1', COLO_NOCARD: '1' } : {}),
    ...(config.settings.discordPresence ? { COLO_PRESENCE: '1' } : {}),
    ...(packsFile ? { COLO_POKEMON_PACKS: packsFile } : {}) };
  const recordedTools = game.toolRoot(root);
  const env = recordedTools ? buildTools.environmentAtRoot(recordedTools, playEnv) : toolEnv(playEnv);
  const cmd = port.gameRunCommand(root, rom, process.platform, env);
  const startedAt = Date.now();
  startPresence(startedAt, Boolean(battle));
  try {
    return await launch(cmd.command, cmd.args, { cwd: cmd.cwd, env: cmd.env }, PLAY_LABEL, true);
  } catch (error) {
    // Stop game ends it on purpose: that is no failure to report.
    if (!wasStopped(startedAt)) {
      noteCrashReport(error, startedAt);
      throw error;
    }
    log('Stopped the game.');
    return { ok: true };
  } finally {
    stopPresence();
    if (!battle) {
      try { makeSaveBackup('after-play'); }
      catch (error) { log(`Save backup failed: ${error.message}`); }
    }
  }
}

// --- Discord activity (src/discord.js, src/presence.js): only while the game runs, and only with the setting on.
let discordPresence = null;
let presenceSession = null;   // { startedAt, game: the game's latest [presence], online }
let onPresence = null;        // the running game's handler for its [presence] lines

function showPresence() {
  if (!presenceSession || !discordPresence) return;
  const { startedAt, game: latest, online: isOnline } = presenceSession;
  discordPresence.set(presence.activity(latest, { startedAt, online: isOnline ? { opponent: battle?.opponent || null } : null }));
}

function startPresence(startedAt, isOnline) {
  if (!config.settings.discordPresence) return;
  discordPresence ||= discord.createPresence({ log });
  presenceSession = { startedAt, game: null, online: isOnline };
  onPresence = line => {
    const latest = presence.parseLine(line);
    if (latest && presenceSession) { presenceSession.game = latest; showPresence(); }
  };
  showPresence();
}

function stopPresence() {
  onPresence = null;
  presenceSession = null;
  discordPresence?.stop();
}

async function launchGame(update = config.settings.autoUpdate) {
  requireRepo();
  port.validateRom(config.rom);
  if (!binaryReady() || (update && !game.isCurrent(config.repo, currentSource()))) await build();
  if (!port.hdVisualsInstalled(config.repo, config.settings)) await installTextures();
  return play();
}

async function playInstalled() {
  const root = requireRepo();
  // Playing without setup uses only packs already on disk. Keep the player's
  // preferences so choosing setup later still installs the requested visuals.
  const settings = { ...config.settings, textures: config.settings.textures && port.texturePackInstalled(root) };
  if (settings.textures !== config.settings.textures)
    log('Playing the installed game without missing HD downloads. Your visual settings are saved for later setup.');
  return play({ repo: root, settings });
}

// Why `--play` opens the launcher instead of the game, or null if the game can start as it is.
function directPlayBlocker() {
  if (!port.isPort(config.repo) || !binaryReady()) return 'the game is not set up yet.';
  try { port.validateRom(config.rom); } catch (error) { return error.message; }
  if (config.settings.autoUpdate && !game.isCurrent(config.repo, currentSource())) return 'a game update is ready.';
  if (!port.hdVisualsInstalled(config.repo, config.settings)) return 'HD visuals need to be set up.';
  return null;
}

// Plays with the launcher's settings, without downloading or building anything.
// False when the launcher should open: the game needs setup or an update, or it
// failed (the activity log shows why).
let directPlayFailure = null;
async function playDirectly() {
  const blocker = directPlayBlocker();
  if (blocker) {
    log(`Opened the launcher instead of the game: ${blocker}`);
    return false;
  }
  try { await exclusive(PLAY_LABEL, () => play(), true); }
  catch (error) {
    directPlayFailure = error.message;
    return false;
  }
  return true;
}

// What the launcher can make again: the game's build output, downloaded archives and old versions.
async function clean(dryRun) {
  const root = requireRepo();
  const build = path.join(root, 'build');
  const size = folder => {
    let total = 0;
    const walk = item => {
      for (const entry of fs.readdirSync(item, { withFileTypes: true })) {
        const file = path.join(item, entry.name);
        if (entry.isDirectory()) walk(file);
        else if (entry.isFile()) total += fs.statSync(file).size;
      }
    };
    try { walk(folder); } catch (_) { /* gone */ }
    return total;
  };
  const gb = bytes => (bytes / 1e9).toFixed(1);
  if (dryRun) {
    log(`Free up space would remove the game's build (${gb(size(build))} GB). The next Play builds it again.`);
    return { ok: true };
  }
  if (saves.cleanupWouldRemoveSaves(root, currentSaveDirectory()))
    throw new Error('Your memory card is inside a build folder. Move it outside the build folders before cleanup.');
  makeSaveBackup('before-cleanup');
  await fs.promises.rm(build, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  log('Removed the game\'s build. It builds again the next time you play.');
  try {
    await compilerCache.clear(app.getPath('userData'));
    log('Removed the compiler cache.');
  } catch (error) { log(`Could not remove the compiler cache: ${error.message}`); }
  await removeOldVersions();
  await removeOldBuildTools();
  return { ok: true };
}

// --- Usage heartbeats and the online count in the top bar (src/telemetry.js).
let reporter = null;
let usageCount = null;

function heartbeatPayload() {
  const installedBuild = binaryReady() ? game.installed(config.repo) : null;
  return telemetry.payload({ installId: config.installId, launcherVersion: app.getVersion(),
    gameVersion: installedBuild?.gameVersion, availableVersion: currentSource().version,
    channel: config.settings.updateChannel, playing: active?.label === PLAY_LABEL });
}

// Packaged builds report; a development launcher only with COLO_TELEMETRY_URL.
function setupTelemetry() {
  if (!app.isPackaged && !process.env.COLO_TELEMETRY_URL) return;
  reporter = telemetry.createReporter({ url: telemetry.endpoint(), fetch: (...args) => net.fetch(...args),
    sharing: () => config.settings.shareUsage, getPayload: heartbeatPayload,
    onCount: count => { usageCount = count; broadcast('usage', count); } });
  reporter.start();
}

// --- Online battles (src/online.js): the room, the game between it and the player.
let battle = null;     // { session, status, code, role, opponent, rules }
let battleResult = null;

function onlineState() {
  return { setup: config.online, ready: onlineReadiness(), build: binaryReady() ? gameBuild().build : null, result: battleResult,
    story: storyState(),
    battle: battle && { status: battle.status, code: online.formatRoomCode(battle.code), role: battle.role, rules: battle.rules,
      opponent: battle.opponent, peerLost: Boolean(battle.peerLost) } };
}

function broadcastOnline() { broadcast('online', onlineState()); }

// The game's executable has to know about online battles, and about Story parties: builds from before them don't.
let onlineBinary = null;
function onlineFeatures(root) {
  try {
    const file = port.binaryPath(root);
    const { mtimeMs } = fs.statSync(file);
    if (onlineBinary?.file !== file || onlineBinary.mtimeMs !== mtimeMs) {
      const bytes = fs.readFileSync(file);
      onlineBinary = { file, mtimeMs, online: bytes.includes('COLO_ONLINE'), story: bytes.includes('online: story member') };
    }
    return onlineBinary;
  } catch (_) { return { online: false, story: false }; }
}
const gameHasOnline = root => onlineFeatures(root).online;

// The Story party, read again whenever the save changes. null without a save; error when it can't be read.
let storyCache = null;
function readStory() {
  const file = path.join(currentSaveDirectory(), 'pokemon_colosseum.dat');
  const mtimeMs = fs.statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? null;
  if (storyCache?.file !== file || storyCache.mtimeMs !== mtimeMs) {
    let party = null, error = null;
    try { party = storyParty.readStoryParty(currentSaveDirectory()); }
    catch (failure) { error = failure.message; }
    storyCache = { file, mtimeMs, party, error };
  }
  return storyCache;
}

// What the Online page shows of it.
function storyState() {
  const { party, error } = readStory();
  return { error, supported: binaryReady() && onlineFeatures(config.repo).story,
    trainer: party?.trainer || null, leftOut: party?.leftOut || 0, packsLeftOut: party?.packsLeftOut || 0,
    members: (party?.members || []).map(member => ({ species: member.species, nickname: member.nickname, level: member.level, shiny: member.shiny,
      // all the team builder needs to copy it into a party of the player's own
      set: { species: member.species, nickname: member.nickname, item: member.item, ability: member.ability, nature: member.rnd % 25,
        genderByte: member.rnd & 0xff, shiny: member.shiny, moves: member.moves.map(([move]) => move).filter(Boolean), evs: member.evs,
        ivs: member.ivs, friendship: member.friendship, ball: member.ball } })) };
}

// Why the Story party can't battle in a room of `size` each, or null.
function storyBlocked(size) {
  const { party, error } = readStory();
  if (!binaryReady() || !onlineFeatures(config.repo).story) return 'This version of the game can\'t battle with your Story party yet. Update it from the Play page.';
  if (error) return `Your save can't be read: ${error}`;
  if (!party) return 'Your Story party is the one in your save. Play and save the game first.';
  const count = party.members.length;
  const shadow = (party.leftOut ? ` Shadow Pokémon stay home until they're purified.` : '') +
    (party.packsLeftOut ? ' Pokémon from Pokémon packs stay home: the other player\'s game doesn\'t have them.' : '');
  if (count < size) return count < Math.min(...parties.SIZES)
    ? `Your Story party needs at least ${Math.min(...parties.SIZES)} Pokémon that can battle.${shadow}`
    : `Your Story party has ${count} Pokémon that can battle, so it can only take ${parties.SIZES.filter(each => each <= count).join(' or ')} each.${shadow}`;
  return null;
}

// The party to battle with in a room of `size` each: species, and for the Story party its Pokémon whole.
function battleParty(size) {
  if (config.online.selected === parties.STORY) {
    const blocked = storyBlocked(size);
    if (blocked) throw new Error(blocked);
    const members = readStory().party.members.slice(0, parties.PARTY_SIZE);
    return { party: members.map(member => member.species), members: members.map(storyParty.wireMember) };
  }
  // A built party's sets go to the game as a Story party's Pokémon do. A game from before those takes the species only.
  const party = parties.selectedParty(config.online);
  if (!onlineFeatures(config.repo).story) return { party: party.members };
  let species = {};
  try { species = battleData(port.validateRom(config.rom)).species; }
  catch (error) { log(`Team builder: couldn't read genders from the disc (${error.message}).`); }
  return { party: party.members, members: party.sets.map((set, slot) => teamSets.toWire(set, species[set.species]?.gender ?? teamSets.GENDER.none, slot)) };
}

// Why a room can't be made or joined now, or null.
function onlineReadiness() {
  if (!port.isPort(config.repo) || !binaryReady()) return 'Set up the game on the Play page first.';
  if (!gameHasOnline(config.repo)) return 'This version of the game has no online battles yet. Update it from the Play page.';
  if (config.online.selected === parties.STORY) return storyBlocked(Math.min(...parties.SIZES));
  if (!parties.selectedParty(config.online)) return 'Build a party of six to battle with.';
  return null;
}

// What identifies this game to another player's: both must play the very same build.
function gameBuild() {
  const installedBuild = game.installed(config.repo);
  return { build: online.buildId(installedBuild), version: installedBuild?.gameVersion || '', launcher: app.getVersion() };
}

function requireOnlineReady() {
  const blocked = onlineReadiness();
  if (blocked) throw new Error(blocked);
  if (active || battle) throw new Error('Finish what the launcher is doing first.');
}

const BATTLE_OVER = {
  left: 'The other player left the battle.', dropped: 'The connection to the room was lost.',
  desync: 'The battle stopped: the two games no longer agreed. This is a bug, please report it.'
};

function battleOutcome(result, side) {
  if (result.reason === 'over') return { won: result.winner === side, draw: result.winner === null,
    message: result.winner === null ? 'The battle ended in a draw.' : result.winner === side ? 'You won the battle!' : 'You lost the battle.' };
  return BATTLE_OVER[result.reason] ? { message: BATTLE_OVER[result.reason] } : null;
}

// The game starts and plays with a port for its turns; it ends the session as it closes.
async function playBattle(session) {
  const gamePort = await session.attachGame();
  try {
    do await exclusive(PLAY_LABEL, () => play(null, { port: gamePort }), true);
    while (session.takeRestart());
  } finally {
    session.close();
    if (battle?.session === session) battle = null;
    broadcastOnline();
    broadcast('activity', activityState());
  }
}

function watchSession(session) {
  session.on('start', message => {
    if (!battle) return;
    battle.status = 'battling';
    battle.opponent = message.players[1 - message.side].name;
    broadcastOnline();
    showPresence();
  });
  session.on('peer', peer => { if (battle) { battle.peerLost = peer === 'lost'; broadcastOnline(); } });
  session.on('end', result => {
    const outcome = battleOutcome(result, session.side);
    if (outcome) battleResult = { ...outcome, opponent: battle?.opponent || null };
    if (battle) battle.status = 'ended';
    broadcastOnline();
  });
}

async function createRoom() {
  requireOnlineReady();
  const setup = config.online;
  const chosen = battleParty(setup.size);
  const session = new online.Session();
  battleResult = null;
  battle = { session, status: 'connecting', role: 'host', rules: { level: setup.level, size: setup.size }, code: null, opponent: null };
  broadcastOnline();
  watchSession(session);
  try {
    battle.code = await session.host({ name: setup.trainer, ...gameBuild(), ...chosen,
      rules: { level: setup.level, size: setup.size }, listed: setup.listed });
  } catch (error) {
    session.close();
    battle = null;
    broadcastOnline();
    throw error;
  }
  battle.status = 'waiting';
  broadcastOnline();
  log(`Room ${online.formatRoomCode(battle.code)} is open. Waiting for a challenger.`);
  playBattle(session).catch(error => log(`✕ ${error.message}`));
  return { code: online.formatRoomCode(battle.code) };
}

async function joinRoom(input) {
  requireOnlineReady();
  const code = online.parseRoomCode(input);
  if (!code) throw new Error('A room code looks like KQ7-M2D.');
  const setup = config.online;
  const session = new online.Session();
  battleResult = null;
  const info = await online.lookup(code);
  if (info.status !== 'waiting') throw new Error('That battle has already started.');
  const chosen = battleParty(info.rules?.size || parties.PARTY_SIZE);
  battle = { session, status: 'connecting', role: 'joiner', rules: info.rules, code, opponent: info.name };
  broadcastOnline();
  watchSession(session);
  try { await session.join({ code, name: setup.trainer, ...gameBuild(), ...chosen }); }
  catch (error) {
    session.close();
    battle = null;
    broadcastOnline();
    throw error;
  }
  playBattle(session).catch(error => log(`✕ ${error.message}`));
  return { code: online.formatRoomCode(code) };
}

// Stops what the launcher is running, as Stop does.
function stopActive() {
  if (!active?.child) return false;
  stoppedAt = Date.now();
  if (process.platform === 'win32') spawn('taskkill', ['/PID', String(active.child.pid), '/T', '/F'], { windowsHide: true });
  else { try { process.kill(-active.child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
  return true;
}

// Leaving a room closes its game, and the room with it.
function leaveRoom() {
  if (!battle) return;
  if (active?.label === PLAY_LABEL) stopActive();
  else {
    battle.session.close();
    battle = null;
    broadcastOnline();
  }
}

function state() {
  const info = port.platformInfo();
  let romError = '';
  if (config.rom) { try { port.validateRom(config.rom); } catch (error) { romError = error.message; } }
  const repoReady = port.isPort(config.repo);
  const ready = repoReady && binaryReady();
  const installedBuild = ready ? game.installed(config.repo) : null;
  return {
    config, platform: info, repoReady, portable: Boolean(portableRoot), pathProblem: blockedPath || pathProblem(),
    // Where the build tools download: the launcher's data folder, wherever the game is installed.
    toolsFolder: path.dirname(buildTools.rootFor(app.getPath('userData'))),
    romReady: Boolean(config.rom) && !romError, romError,
    hdVisualsReady: repoReady && port.hdVisualsInstalled(config.repo, config.settings),
    texturesInstalled: repoReady && port.texturePackInstalled(config.repo),
    pbr: pbrState(),
    texturePack: { size: port.TEXTURE_PACK.size, unpacked: port.TEXTURE_PACK.unpacked },
    languages: languagePacks.choices(languageFolder()),
    // Whether the game on disk reads language packs.
    languagesReady: repoReady && fs.existsSync(path.join(config.repo, 'host', 'language.c')),
    binaryReady: ready,
    tools: toolsStatus(),
    gameSource: config.gameSource ? { override: config.gameSource.override, version: config.gameSource.resolved.version } : null,
    game: { launcherVersion: app.getVersion(), availableVersion: currentSource().version,
      installedVersion: installedBuild?.gameVersion || null,
      installedToolVersion: installedBuild?.toolVersion || null,
      toolVersion: buildTools.toolsetFor(), needsUpdate: repoReady && !game.isCurrent(config.repo, currentSource()),
      previousReady: Boolean(config.previousInstall && binaryReady(config.previousInstall.repo)) },
    active: activityState(), appUpdate, logs: activityLog.snapshot(), logResetSequence: activityLog.resetSequence(),
    saveDirectory: currentSaveDirectory(), backupDirectory: saves.backupRoot(),
    backups: saves.listBackups().filter(item => item.source === currentSaveDirectory()),
    crashReports: crashReports.summary(crashReports.directory()), directPlayFailure,
    // The run on the memory card, and whether the game on disk can play one.
    randomizerSave: saveRun(currentSaveDirectory()), randomizerReady: repoReady && fs.existsSync(path.join(config.repo, 'host', 'randomizer.c')),
    usage: usageCount, online: onlineState(),
    gba: { ...gbaLink.status(config.gba), backupFolder: gbaBackupFolder() }
  };
}

// Copies of GBA saves the game keeps before a GBA first starts in a session, beside the launcher's own backups.
function gbaBackupFolder() { return path.join(saves.backupRoot(), 'GBA saves'); }

// Stable never sees a pre-release. Beta and pull request previews are opt-in,
// and may be older than what is installed, so leaving one can go back down.
function applyUpdateChannel() {
  if (!updater) return;
  const channel = config.settings.updateChannel;
  const url = process.env.COLO_LAUNCHER_UPDATE_URL;
  updater.setFeedURL(url ? { provider: 'generic', url } : updateChannel.feedFor(channel));
  updater.channel = 'latest';
  updater.allowPrerelease = channel !== 'stable';
  updater.allowDowngrade = channel !== 'stable' || app.getVersion().includes('-');
}

async function checkAppUpdate() {
  if (!updater) return appUpdate;
  try { await updater.checkForUpdates(); }
  catch (error) {
    const missing = config.settings.updateChannel !== 'stable' && /\b404\b/.test(error.message);
    appUpdate = { state: 'error', message: missing
      ? `${updateChannel.channelLabel(config.settings.updateChannel)} is no longer available. Choose another update channel in Settings.`
      : `Launcher update check failed: ${error.message}` };
    broadcast('app-update', appUpdate);
    log(appUpdate.message);
  }
  return appUpdate;
}

async function updateChannels() {
  let releases = null;
  try {
    const response = await net.fetch(`https://api.github.com/repos/${updateChannel.REPOSITORY}/releases?per_page=100`,
      { headers: { Accept: 'application/vnd.github+json' } });
    if (response.ok) releases = await response.json();
  } catch (_) { /* offline: Stable, Beta and the current choice are still offered */ }
  const channels = updateChannel.channelsFromReleases(releases);
  const chosen = config.settings.updateChannel;
  if (!channels.some(item => item.id === chosen))
    channels.push({ id: chosen, label: updateChannel.channelLabel(chosen), detail: 'No longer available', missing: true });
  return channels;
}

let releaseNotes = null;
// The published changelog, or the copy bundled with this launcher when GitHub
// cannot be reached. Development runs read the local file so edits show.
async function loadChangelog() {
  if (releaseNotes) return releaseNotes;
  let bundled = changelog.normalize(null);
  try { bundled = changelog.normalize(JSON.parse(fs.readFileSync(path.join(__dirname, '..', changelog.FILE), 'utf8'))); }
  catch (error) { log(`Could not read the bundled changelog: ${error.message}`); }
  if (!app.isPackaged && !process.env.COLO_CHANGELOG_URL) return (releaseNotes = bundled);
  try {
    const response = await net.fetch(changelog.url(), { cache: 'no-cache', signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    releaseNotes = changelog.merge(changelog.normalize(await response.json()), bundled);
    return releaseNotes;
  } catch (error) {
    log(`Showing the changelog bundled with this launcher: ${error.message}`);
    return bundled;
  }
}

let betaShown = null;
async function changelogState() {
  const { releases, beta } = await loadChangelog();
  const options = { current: app.getVersion(), returning: config.completedSetup };
  betaShown = changelog.isBeta(app.getVersion()) ? beta : null;
  return { releases, current: changelog.baseVersion(app.getVersion()),
    unseen: changelog.unseen(releases, { ...options, seen: config.changelogSeen }).map(release => release.version),
    beta: betaShown && { ...betaShown, unseen: changelog.unseenBeta(betaShown, { ...options, seen: config.changelogBetaSeen }) } };
}

// The release only moves forward, so leaving a preview for an older release
// and coming back does not repeat notes already shown.
function markChangelogSeen() {
  const version = changelog.baseVersion(app.getVersion());
  const betaKey = changelog.betaKey(betaShown);
  const newer = version && (!config.changelogSeen || changelog.compareVersions(version, config.changelogSeen) > 0);
  if (!newer && (!betaKey || betaKey === config.changelogBetaSeen)) return;
  if (newer) config.changelogSeen = version;
  if (betaKey) config.changelogBetaSeen = betaKey;
  saveConfig();
}

// Development runs stay out of the numbers unless pointed at a test API.
function setupAppUpdater() {
  const url = process.env.COLO_LAUNCHER_UPDATE_URL;
  const bundledFeed = fs.existsSync(path.join(process.resourcesPath, 'app-update.yml'));
  // The updater would replace a portable launcher with the installer build.
  if (portableRoot) {
    appUpdate = portable.updateNotice(app.getVersion(), null);
    const check = async () => {
      try {
        const response = await net.fetch(`https://api.github.com/repos/${updateChannel.REPOSITORY}/releases/latest`,
          { headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(8000) });
        if (response.ok) {
          const before = appUpdate.state;
          appUpdate = portable.updateNotice(app.getVersion(), (await response.json())?.tag_name);
          broadcast('app-update', appUpdate);
          if (appUpdate.state === 'available' && before !== 'available') log(appUpdate.message);
        }
      } catch (_) { /* offline, or GitHub's hourly limit: keep the last notice */ }
      return appUpdate;
    };
    if (app.isPackaged) setTimeout(() => { if (config.settings.autoUpdate) check(); }, 10000);
    ipcMain.handle('check-app-update', check);
    return;
  }
  if (!app.isPackaged || (!url && !bundledFeed) || (process.platform === 'linux' && !process.env.APPIMAGE)) {
    appUpdate = { state: 'unconfigured', message: app.isPackaged ? 'Launcher updates are unavailable for this install.' : 'Launcher updates come with new releases.' };
    ipcMain.handle('check-app-update', () => appUpdate);
    return;
  }
  ({ autoUpdater: updater } = require('electron-updater'));
  // Updates keep the AppImage's name and folder, so shortcuts to it keep working
  if (process.platform === 'linux') appImageUpdate.keepAppImagePath(updater);
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  applyUpdateChannel();
  const set = (state, message) => {
    appUpdate = { state, message }; broadcast('app-update', appUpdate);
    if (state !== 'downloading' || !message.startsWith('Downloading launcher update:')) log(message);
  };
  updater.on('checking-for-update', () => set('checking', 'Checking launcher updates…'));
  updater.on('update-available', info => set('downloading', `Downloading launcher ${info.version}…`));
  updater.on('update-not-available', () => set('current', 'Launcher is up to date.'));
  updater.on('download-progress', progress => set('downloading', `Downloading launcher update: ${Math.round(progress.percent)}%`));
  updater.on('update-downloaded', info => set('ready', `Launcher ${info.version} downloaded; it will install when you quit.`));
  updater.on('error', error => set('error', `Launcher update check failed: ${error.message}`));
  const check = () => { if (config.settings.autoUpdate) checkAppUpdate(); };
  setTimeout(check, 10000);
  setInterval(check, 30 * 60 * 1000);
  ipcMain.handle('check-app-update', () => checkAppUpdate());
  ipcMain.handle('install-app-update', () => {
    if (appUpdate.state !== 'ready') throw new Error('No launcher update is ready to install.');
    if (operation || active) throw new Error('Finish the current task or close the game before installing the update.');
    // Install silently, then relaunch from the installer itself. Opening the
    // launcher by hand while the installer still runs gets that copy closed.
    updater.quitAndInstall(true, true);
  });
}

function registerHandlers() {
  ipcMain.handle('copy-activity-log', () => {
    clipboard.writeText(sessionLog.read([...partialOutput.values()].sort((a, b) => a.id - b.id)));
    return { copied: true };
  });
  ipcMain.handle('save-activity-log', async () => {
    const chosen = await dialog.showSaveDialog(window, { title: 'Save activity log',
      defaultPath: path.join(app.getPath('downloads'), 'Colosseum-activity.log'),
      filters: [{ name: 'Activity log', extensions: ['log'] }] });
    if (chosen.canceled || !chosen.filePath) return { cancelled: true };
    sessionLog.save(chosen.filePath, [...partialOutput.values()].sort((a, b) => a.id - b.id));
    return { saved: true };
  });
  const senderWindow = event => BrowserWindow.fromWebContents(event.sender);
  ipcMain.handle('window-state', event => windowState(senderWindow(event)));
  ipcMain.handle('window-minimize', event => {
    const target = senderWindow(event);
    target?.minimize();
    return { minimized: target?.isMinimized() || false };
  });
  // The middle window button maximizes, which leaves the taskbar or Dock showing. Full screen is F11
  // (window-toggle-full-screen), and the same button leaves it.
  ipcMain.handle('window-toggle-maximize', event => {
    const target = senderWindow(event);
    if (!target) return windowState(null);
    if (target.isFullScreen()) target.setFullScreen(false);
    else if (target.isMaximized()) target.unmaximize();
    else target.maximize();
    return windowState(target);
  });
  ipcMain.handle('window-toggle-full-screen', event => {
    const target = senderWindow(event);
    if (!target) return windowState(null);
    target.setFullScreen(!target.isFullScreen());
    return windowState(target);
  });
  ipcMain.handle('window-close', event => senderWindow(event)?.close());
  ipcMain.handle('state', async () => { await checkTools(); return state(); });
  ipcMain.handle('randomizer-new-seed', () => randomizer.newSeed());
  ipcMain.handle('randomizer-spoilers', async () => {
    const { run } = saveRun(currentSaveDirectory());
    if (!run) throw new Error('Your save isn\'t a randomized run, so there are no spoilers to show.');
    let raw = null;
    try { raw = fs.readFileSync(spoilerFile(), 'utf8'); } catch (_) { /* written when the game opens the run */ }
    if (randomizer.spoilerSeed(raw) !== run.seed) throw new Error('Open your save in the game once first: the spoiler log is written when it loads.');
    const readable = path.join(app.getPath('userData'), 'Randomizer spoilers.txt');
    fs.writeFileSync(readable, randomizer.spoilerText(raw, pokedexData.list(port.validateRom(config.rom))));
    await shell.openPath(readable);
  });
  ipcMain.handle('online-save', (_event, value) => {
    config.online = parties.normalize(value);
    saveConfig();
    return onlineState();
  });
  ipcMain.handle('online-rooms', () => online.listRooms({ fetch: (...args) => net.fetch(...args) }));
  ipcMain.handle('usage-refresh', () => reporter?.refresh());
  ipcMain.handle('online-create', () => createRoom());
  ipcMain.handle('online-join', (_event, code) => joinRoom(code));
  ipcMain.handle('online-leave', () => leaveRoom());
  ipcMain.handle('pokedex', () => pokedexList(port.validateRom(config.rom)));
  // gameTakesSets: false when the installed game is from before sets, and battles with its species only
  ipcMain.handle('battle-data', () => ({ ...battleData(port.validateRom(config.rom)), gameTakesSets: !binaryReady() || onlineFeatures(config.repo).story }));
  ipcMain.handle('pokedex-model', (_event, key, form) => {
    const look = pokedexLook(key, String(form));
    return look.pkx ? hsdModel.parseModel(look.pkx) : pokedexData.model(port.validateRom(config.rom), look.national, String(form));
  });
  ipcMain.handle('pokedex-clip', (_event, key, form, index) => {
    const look = pokedexLook(key, String(form));
    return look.pkx ? hsdModel.parseClip(look.pkx, Number(index)) : pokedexData.clip(port.validateRom(config.rom), look.national, String(form), Number(index));
  });
  ipcMain.handle('open-pokemon-packs', () => {
    fs.mkdirSync(pokemonPacksDirectory(), { recursive: true });
    return shell.openPath(pokemonPacksDirectory());
  });
  ipcMain.handle('check-tools', async () => { await checkTools(true); return state(); });
  ipcMain.handle('copy-mac-command', (_event, index) => {
    if (process.platform !== 'darwin') throw new Error('This help is for macOS.');
    const commands = toolsStatus().commands.split('\n').filter(Boolean);
    if (!Number.isInteger(index) || !commands[index]) throw new Error('Check your Mac tools again.');
    clipboard.writeText(commands[index]);
  });
  ipcMain.handle('save-settings', async (_event, input) => {
    if (operation || active) throw new Error('Finish the current task before changing settings.');
    const settings = port.normalizeSettings(input);
    const channelChanged = settings.updateChannel !== config.settings.updateChannel;
    config.settings = settings;
    saveConfig();
    if (channelChanged) {
      applyUpdateChannel();
      log(`Launcher updates now follow ${updateChannel.channelLabel(settings.updateChannel)}.`);
      checkAppUpdate();
    }
    return state();
  });
  ipcMain.handle('update-channels', () => updateChannels());
  ipcMain.handle('choose-rom', async () => {
    if (operation || active) throw new Error('Finish the current task before changing game files.');
    const chosen = await dialog.showOpenDialog(window, {
      title: `Choose a file from your own ${GAME_NAME} disc`,
      properties: ['openFile'],
      filters: [{ name: 'Game disc files', extensions: ['iso', 'gcm'] }, { name: 'All files', extensions: ['*'] }]
    });
    if (chosen.canceled) return state();
    config.rom = port.validateRom(chosen.filePaths[0]);
    saveConfig();
    return state();
  });
  ipcMain.handle('choose-pbr-disc', async () => {
    if (operation || active) throw new Error('Finish the current task before changing game files.');
    const chosen = await dialog.showOpenDialog(window, {
      title: 'Choose a file from your own Pokémon Battle Revolution disc',
      properties: ['openFile'],
      filters: [{ name: 'Wii disc files', extensions: ['rvz', 'iso', 'wbfs', 'ciso', 'gcz', 'wia'] }, { name: 'All files', extensions: ['*'] }]
    });
    if (chosen.canceled) return state();
    config.pbrDisc = chosen.filePaths[0];
    saveConfig();
    return state();
  });
  // The Game Boy Advance's files: what is chosen is checked, and kept only if the game can use it. A socket's
  // save comes first (a virtual GBA answers from it); its Game Pak and the BIOS are optional.
  const setGbaSocket = (socket, change) => {
    const sockets = { ...config.gba.sockets };
    const next = { save: '', rom: '', ...(sockets[socket] || {}), ...change };
    if (next.save) sockets[socket] = next; else delete sockets[socket];
    config.gba = gbaLink.normalize({ ...config.gba, sockets });
    saveConfig();
  };
  const useGbaSave = (socket, file) => {
    gen3Save.read(file);   // throws with the reason when it isn't a Gen 3 save
    setGbaSocket(socket, { save: file });
  };
  ipcMain.handle('choose-gba-file', async (_event, kind, socket) => {
    if (operation || active) throw new Error('Finish the current task before changing game files.');
    if (kind !== 'bios' && !gbaLink.SOCKETS.includes(String(socket))) throw new Error('No such controller socket.');
    const entry = kind === 'bios' ? null : config.gba.sockets[String(socket)];
    if (kind === 'rom' && !entry) throw new Error('Choose the save first.');
    const options = {
      bios: { title: 'Choose a dump of your Game Boy Advance\'s BIOS', filters: [{ name: 'GBA BIOS', extensions: ['bin', 'rom', 'gba'] }, { name: 'All files', extensions: ['*'] }] },
      save: { title: 'Choose your Pokémon Ruby, Sapphire, Emerald, FireRed or LeafGreen save', filters: [{ name: 'GBA saves', extensions: ['sav', 'srm'] }, { name: 'All files', extensions: ['*'] }] },
      rom: { title: 'Choose a dump of the Game Pak this save belongs to', filters: [{ name: 'GBA games', extensions: ['gba', 'agb', 'bin'] }, { name: 'All files', extensions: ['*'] }] }
    }[kind];
    if (!options) throw new Error('Unknown file.');
    const chosen = await dialog.showOpenDialog(window, { ...options, properties: ['openFile'] });
    if (chosen.canceled || !chosen.filePaths[0]) return state();
    const file = chosen.filePaths[0];
    if (kind === 'bios') {
      const check = gbaLink.checkBios(file);
      if (check.error) throw new Error(check.error);
      config.gba = gbaLink.normalize({ ...config.gba, bios: file });
      saveConfig();
    } else if (kind === 'save') {
      useGbaSave(String(socket), file);
    } else {
      const check = gbaLink.checkGamePak(file);
      if (check.error) throw new Error(check.error);
      setGbaSocket(String(socket), { rom: file });
    }
    return state();
  });
  ipcMain.handle('use-gba-save', (_event, socket, file) => {
    if (operation || active) throw new Error('Finish the current task before changing game files.');
    if (!gbaLink.SOCKETS.includes(String(socket))) throw new Error('No such controller socket.');
    useGbaSave(String(socket), String(file));
    return state();
  });
  ipcMain.handle('clear-gba-file', (_event, kind, socket) => {
    if (operation || active) throw new Error('Finish the current task before changing game files.');
    if (kind === 'bios') { config.gba = gbaLink.normalize({ ...config.gba, bios: '' }); saveConfig(); }
    else if (kind === 'rom') setGbaSocket(String(socket), { rom: '' });
    else setGbaSocket(String(socket), { save: '', rom: '' });
    return state();
  });
  // Gen 3 saves where emulators keep them (a few folders a few levels down), for Settings to offer.
  ipcMain.handle('gba-suggestions', () => gbaLink.suggestions(config.rom ? [path.dirname(config.rom)] : []));
  ipcMain.handle('open-gba-backups', () => {
    fs.mkdirSync(gbaBackupFolder(), { recursive: true });
    return shell.openPath(gbaBackupFolder());
  });
  ipcMain.handle('choose-repo', async () => {
    if (portableRoot) throw new Error('The portable launcher keeps its setup files in its own folder.');
    if (operation || active) throw new Error('Finish the current task before changing game files.');
    const chosen = await dialog.showOpenDialog(window, { title: 'Choose a folder with setup files', properties: ['openDirectory'] });
    if (chosen.canceled) return state();
    if (!port.isPort(chosen.filePaths[0])) throw new Error('That folder does not have the setup files this launcher needs.');
    config.repo = chosen.filePaths[0];
    config.installRoot = null;
    config.previousInstall = null;
    config.completedSetup = fs.existsSync(port.binaryPath(config.repo));
    saveConfig();
    broadcastOnline();
    return state();
  });
  ipcMain.handle('choose-location', async () => {
    if (portableRoot) throw new Error('The portable launcher keeps its setup files in its own folder.');
    if (operation || active) throw new Error('Finish the current task before changing game files.');
    const chosen = await dialog.showOpenDialog(window, { title: 'Choose where to download setup files', properties: ['openDirectory'] });
    if (chosen.canceled) return state();
    const destination = path.join(chosen.filePaths[0], 'Colosseum Game');
    if (fs.existsSync(destination) && (!fs.statSync(destination).isDirectory() || fs.readdirSync(destination).length))
      throw new Error('That location already has a game setup folder. Choose another location.');
    config.repo = destination;
    config.installRoot = null;
    config.previousInstall = null;
    config.completedSetup = fs.existsSync(port.binaryPath(config.repo));
    saveConfig();
    broadcastOnline();
    return state();
  });
  const actions = { 'install-port': ['Download port source', installPort],
    'update-port': ['Update game', updatePort], 'install-textures': ['Install HD textures', () => installTextures()], 'build': ['Build game', () => build(true)],
    'make-pbr-models': ['Make Battle Revolution models', makePbrModels],
    'setup-game': ['Build game', setupGame], 'prepare-game': ['Prepare game', prepareGame], 'play': [PLAY_LABEL, playInstalled],
    'launch-game': ['Prepare game', () => launchGame()], 'update-and-play': ['Prepare game', () => launchGame(true)],
    'play-previous': [PLAY_LABEL, () => {
      if (!config.previousInstall) throw new Error('There is no previous version available.');
      return play(config.previousInstall);
    }] };
  for (const [channel, [label, callback]] of Object.entries(actions))
    ipcMain.handle(channel, () => exclusive(label, callback, ['play', 'launch-game', 'update-and-play', 'play-previous'].includes(channel)));
  ipcMain.handle('set-game-source', (_event, input) => exclusive('Choose game source', () => chooseGameSource(input)));
  ipcMain.handle('clean-preview', () => exclusive('Preview cleanup', () => clean(true)));
  ipcMain.handle('backup-saves', () => exclusive('Back up saves', () => makeSaveBackup('manual')));
  ipcMain.handle('gc-adapter-status', () => gcAdapterStatus());
  ipcMain.handle('gc-adapter-allow', () => allowGcAdapter());
  ipcMain.handle('gc-adapter-copy-command', () => clipboard.writeText(gcAdapter.terminalCommand()));
  ipcMain.handle('import-dolphin-save', (_event, files) => exclusive('Import Dolphin save', async () => {
    if (files == null) {
      const chosen = await dialog.showOpenDialog(window, { title: 'Import Dolphin save',
        properties: ['openFile', 'multiSelections'], filters: [{ name: 'Dolphin save', extensions: ['gci'] }] });
      if (chosen.canceled || !chosen.filePaths.length) return { cancelled: true };
      files = chosen.filePaths;
    }
    if (!Array.isArray(files) || !files.length) throw new Error('Choose a Dolphin .gci save file.');
    const { file, converted, skipped } = gciSave.readGciFiles(files);
    const directory = currentSaveDirectory();
    const existing = fs.existsSync(path.join(directory, `${converted.name}.dat`));
    const party = converted.party.length ? `\nParty: ${converted.party.join(', ')}` : '';
    const skippedNote = skipped.length ? `\n\nSkipping ${skipped.map(save => `${save.file} (${save.reason})`).join(', ')}.` : '';
    const warning = converted.damaged ? `\n\nThe newest ${converted.damaged === 1 ? 'copy' : `${converted.damaged} copies`} of this save could not be read, so the game will load the one before. Your most recent progress may be missing.` : '';
    const answer = await dialog.showMessageBox(window, {
      type: existing || warning ? 'warning' : 'question',
      buttons: ['Cancel', 'Import save'], defaultId: 0, cancelId: 0,
      message: existing ? `Replace your ${converted.title} save with this Dolphin save?` : `Import this ${converted.title} save from Dolphin?`,
      detail: `${path.basename(file)}\nTrainer: ${converted.trainer}${party}${skippedNote}\n\nDestination: ${directory}\n\nYour current memory card will be backed up first. The original .gci file is kept.${warning}`
    });
    if (answer.response !== 1) return { cancelled: true };
    const result = gciSave.importGci(converted, directory);
    log(`Imported Dolphin ${converted.title} save into ${directory}.${result.previous ? ` Previous saves: ${result.previous}` : ''}`);
    return { ...result, trainer: converted.trainer, party: converted.party, file: path.basename(file), skipped };
  }));
  ipcMain.handle('export-gci-save', () => exclusive('Export save', async () => {
    const save = gciSave.readCardSave(currentSaveDirectory());
    const chosen = await dialog.showSaveDialog(window, { title: 'Export save',
      defaultPath: path.join(app.getPath('downloads'), gciSave.EXPORT_NAME),
      filters: [{ name: 'Dolphin save', extensions: ['gci'] }] });
    if (chosen.canceled || !chosen.filePath) return { cancelled: true };
    const file = gciSave.writeGci(save.gci, chosen.filePath);
    log(`Exported ${save.title} save to ${file}.`);
    return { file: path.basename(file), trainer: save.trainer, damaged: save.damaged, extraBoxPokemon: save.extraBoxPokemon, randomized: Boolean(saveRun(currentSaveDirectory()).run) };
  }));
  ipcMain.handle('restore-saves', async (_event, id) => {
    if (operation || active) throw new Error('Stop the running game or task before restoring saves.');
    if (!saves.listBackups().some(item => item.id === id && item.source === currentSaveDirectory()))
      throw new Error('Choose a backup for this memory card.');
    const answer = await dialog.showMessageBox(window, {
      type: 'warning', buttons: ['Cancel', 'Restore memory card'], defaultId: 0, cancelId: 0,
      message: 'Restore this backup?',
      detail: "We'll back up your current saves first, then replace matching files."
    });
    if (answer.response !== 1) return { cancelled: true };
    const result = saves.restoreBackup(id, currentSaveDirectory());
    log(`Restored ${result.restored} memory card file(s) from ${id}.`);
    return result;
  });
  ipcMain.handle('show-path-folder', () => { const problem = blockedPath || pathProblem(); if (problem) shell.showItemInFolder(problem.folder); });
  ipcMain.handle('open-backups', () => {
    fs.mkdirSync(saves.backupRoot(), { recursive: true, mode: 0o700 });
    return shell.openPath(saves.backupRoot());
  });
  ipcMain.handle('open-languages', () => {
    fs.mkdirSync(languageFolder(), { recursive: true });
    return shell.openPath(languageFolder());
  });
  ipcMain.handle('open-custom-textures', () => {
    fs.mkdirSync(customTextureDirectory(), { recursive: true });
    return shell.openPath(customTextureDirectory());
  });
  ipcMain.handle('clean', () => exclusive('Clean build output', async () => {
    const answer = await dialog.showMessageBox(window, {
      type: 'warning', buttons: ['Cancel', 'Free up space'], defaultId: 0, cancelId: 0,
      message: 'Remove files the launcher can make again?', detail: 'The next play may take longer. Your disc file and saved games will be kept.'
    });
    return answer.response === 1 ? clean(false) : { cancelled: true };
  }));
  ipcMain.handle('remove-build-tools', () => exclusive('Remove build tools', async () => {
    const answer = await dialog.showMessageBox(window, {
      type: 'warning', buttons: ['Cancel', 'Remove build tools'], defaultId: 0, cancelId: 0,
      message: 'Remove the build tools?',
      detail: `They take a few GB in ${buildToolsFolder()} and are only needed to build the game, which plays without them. ` +
        'The launcher downloads them again when it next needs them: to update or rebuild the game, or to set up HD visuals. ' +
        'Your game, disc file and saved games are kept.'
    });
    return answer.response === 1 ? removeBuildTools() : { cancelled: true };
  }));
  ipcMain.handle('stop', () => stopActive());
  ipcMain.handle('changelog', () => changelogState());
  ipcMain.handle('changelog-seen', () => markChangelogSeen());
  ipcMain.handle('open-changelog-page', () => shell.openExternal(changelog.PAGE_URL));
  // Only this fixed invite opens: the page never chooses a URL.
  ipcMain.handle('open-discord', () => shell.openExternal(DISCORD_INVITE));
  ipcMain.handle('steam-status', () => steamStatus());
  ipcMain.handle('steam-offered', (_event, prompt) => markSteamOffered(prompt));
  ipcMain.handle('add-to-steam', (_event, options) => exclusive('Add to Steam', () => addToSteam(options)));
  ipcMain.handle('copy-crash-report', () => {
    const report = crashReports.list(crashReports.directory())[0];
    if (!report) throw new Error('There are no crash reports.');
    clipboard.writeText(crashReports.read(report.file));
  });
  ipcMain.handle('open-crash-reports', () => {
    fs.mkdirSync(crashReports.directory(), { recursive: true });
    return shell.openPath(crashReports.directory());
  });
}

function windowState(target) {
  return { fullscreen: target?.isFullScreen() || false, maximized: target?.isMaximized() || false,
    minimized: target?.isMinimized() || false };
}

const WINDOW_SIZE = { width: 1080, height: 760, minWidth: 900, minHeight: 600 };

function createWindow() {
  // Only Windows display scaling is capped: a Mac's Retina 2x is its normal size.
  const windowsScaling = process.platform === 'win32';
  const zoom = windowsScaling ? displayScale.displayZoom(screen.getPrimaryDisplay()) : 1;
  window = new BrowserWindow({
    ...displayScale.scaledSize(WINDOW_SIZE, zoom),
    frame: false, backgroundColor: '#1a1420', title: 'Colosseum Launcher',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  if (windowsScaling) displayScale.followDisplayScale(window, screen, WINDOW_SIZE, zoom);
  window.setMenuBarVisibility(false);
  const sendWindowState = () => broadcast('window-state', windowState(window));
  for (const event of ['enter-full-screen', 'leave-full-screen', 'maximize', 'unmaximize', 'restore']) window.on(event, sendWindowState);
  window.loadFile(path.join(__dirname, 'index.html'));
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('console-message', details => {
    if (details.level === 'error' || details.level === 'warning')
      log(`Renderer ${details.level}: ${details.message} (${details.sourceId}:${details.lineNumber})`);
  });
}

if (ownsInstance) app.whenReady().then(async () => {
  if (process.env.APPIMAGE && startedFromSteam()) steam.endOnSigterm();
  loadConfig();
  registerHandlers();
  if (playOnStart && await playDirectly()) return app.quit();
  createWindow();
  // Only with the window: a launcher update installs on quit, which `--play` does as the game closes.
  setupAppUpdater();
  setupTelemetry();
  removeOldVersionsInBackground();
  // The bundled manifest is the update check. Source downloads and builds
  // start with Update & play, so opening the launcher never changes a game.
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

app.on('before-quit', () => {
  flushPartialOutput();
  // Stop an in-flight compiler before another launcher process can recover it.
  if (!active?.child || active.label === PLAY_LABEL) return;
  if (process.platform === 'win32') spawn('taskkill', ['/PID', String(active.child.pid), '/T', '/F'], { windowsHide: true });
  else { try { process.kill(-active.child.pid, 'SIGTERM'); } catch (_) { /* already exited */ } }
});
