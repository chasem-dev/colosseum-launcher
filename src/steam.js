'use strict';

// Add to Steam: adds the launcher to the player's Steam library as a non-Steam
// game, one shortcut for each game, with the game's artwork from SteamGridDB. Steam keeps
// non-Steam games in userdata/<account>/config/shortcuts.vdf (binary VDF) and
// their artwork in that folder's grid/, named after each shortcut's app ID.
// Steam reads shortcuts.vdf only when it starts and writes its own copy when it
// closes, so the file changes only while Steam is closed (main.js closes it).
//
// No artwork is in this repository or the launcher: it is downloaded from
// SteamGridDB when the player chooses Add to Steam, and written only into
// that player's Steam artwork folder, where Steam needs it.
const fs = require('node:fs');
const path = require('node:path');

// The game a shortcut without `--game=` starts: every shortcut from before XD is Colosseum's.
const DEFAULT_GAME = 'colosseum';

// Each game's shortcut: its name in Steam, and pieces from the game's SteamGridDB page, each saved under the
// shortcut's app ID with the suffix Steam looks for: { suffix: 'p.png', url }, the 600x900 library capsule; '.png',
// the 920x430 wide capsule; '_hero.png', the 1920x620 library header; '_logo.png', the logo over it; '_icon.png', the
// 256x256 icon. Steam uses its own placeholder for any piece not listed.
const SHORTCUTS = {
  colosseum: { appName: 'Pokémon Colosseum', artwork: [
    { suffix: 'p.png', url: 'https://cdn2.steamgriddb.com/grid/8147268d4f135bde0f49115734cacc45.png' }, // library capsule, 600x900
    { suffix: '.png', url: 'https://cdn2.steamgriddb.com/grid/3b5baa4288a1ba4f0ce32ab6f6350603.png' }, // wide capsule, 460x215
    { suffix: '_hero.png', url: 'https://cdn2.steamgriddb.com/hero/191b624691ab236e4958bcac976a1de6.png' }, // library header, 1920x620
    { suffix: '_logo.png', url: 'https://cdn2.steamgriddb.com/logo/6f79287fb6ba44555025707f936f52d9.png' }, // logo over the header
    { suffix: '_icon.png', url: 'https://cdn2.steamgriddb.com/icon/972c16f442eba60469680bf869dd6a89.png' } // icon, 256x256
  ] },
  // SteamGridDB game 35162. Only its capsules for now: Steam shows its own header, logo and icon until some are chosen.
  xd: { appName: 'Pokémon XD: Gale of Darkness', artwork: [
    { suffix: 'p.png', url: 'https://cdn2.steamgriddb.com/grid/eadbbf17b9a31e7eea1b30ba163856df.png' }, // library capsule, 600x900
    { suffix: '.png', url: 'https://cdn2.steamgriddb.com/grid/1105b034d58ea8f7a4dea7d595e82607.png' } // wide capsule, 460x215
  ] }
};
const shortcutOf = game => SHORTCUTS[game] || SHORTCUTS[DEFAULT_GAME];
const APP_NAME = SHORTCUTS[DEFAULT_GAME].appName;
const ARTWORK = SHORTCUTS[DEFAULT_GAME].artwork;
const artworkFor = game => shortcutOf(game).artwork;
const appNameFor = game => shortcutOf(game).appName;

// Binary VDF. A map is a list of [type, key, value] in file order, and values
// are kept as read (floats and 64-bit numbers as their bytes), so everything
// Steam or another tool wrote comes back out unchanged.
const MAP = 0, STRING = 1, INT32 = 2, FLOAT32 = 3, UINT64 = 7, END = 8;

function parseVdf(buffer) {
  let at = 0;
  const damaged = () => new Error("Steam's shortcuts.vdf could not be read, so it was left as it is.");
  const text = () => {
    const end = buffer.indexOf(0, at);
    if (end < 0) throw damaged();
    const value = buffer.toString('utf8', at, end);
    at = end + 1;
    return value;
  };
  const bytes = count => {
    if (at + count > buffer.length) throw damaged();
    const value = Buffer.from(buffer.subarray(at, at + count));
    at += count;
    return value;
  };
  const map = () => {
    const entries = [];
    for (;;) {
      if (at >= buffer.length) throw damaged();
      const type = buffer[at++];
      if (type === END) return entries;
      const key = text();
      if (type === MAP) entries.push([type, key, map()]);
      else if (type === STRING) entries.push([type, key, text()]);
      else if (type === INT32) entries.push([type, key, bytes(4).readInt32LE(0)]);
      else if (type === FLOAT32) entries.push([type, key, bytes(4)]);
      else if (type === UINT64) entries.push([type, key, bytes(8)]);
      else throw damaged();
    }
  };
  const root = map();
  if (at !== buffer.length) throw damaged();
  return root;
}

function serializeVdf(root) {
  const parts = [];
  const write = entries => {
    for (const [type, key, value] of entries) {
      parts.push(Buffer.from([type]), Buffer.from(`${key}\0`, 'utf8'));
      if (type === MAP) write(value);
      else if (type === STRING) parts.push(Buffer.from(`${value}\0`, 'utf8'));
      else if (type === INT32) { const b = Buffer.alloc(4); b.writeInt32LE(value | 0, 0); parts.push(b); }
      else parts.push(value);
    }
    parts.push(Buffer.from([END]));
  };
  write(root);
  return Buffer.concat(parts);
}

// Steam's keys vary in case between versions (Exe, exe), so look them up without it.
const field = (entries, key) => entries.find(entry => entry[1].toLowerCase() === key.toLowerCase());
function setField(entries, type, key, value) {
  const existing = field(entries, key);
  if (existing) { existing[0] = type; existing[2] = value; }
  else entries.push([type, key, value]);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(text) {
  let crc = 0xffffffff;
  for (const byte of Buffer.from(text, 'utf8')) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// The app ID Steam and other tools give a non-Steam game: the CRC-32 of its
// quoted Exe and name, with the top bit set (no Steam app has it). Artwork is
// named after it unsigned; shortcuts.vdf stores it as a signed 32-bit number.
function shortcutAppId(quotedExe, appName) {
  return (crc32(quotedExe + appName) | 0x80000000) >>> 0;
}

const unquote = value => String(value || '').replace(/^"(.*)"$/, '$1');
function samePath(a, b, platform) {
  const normal = value => {
    const resolved = (platform === 'win32' ? path.win32 : path.posix).resolve(value);
    return platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normal(a) === normal(b);
}

const words = options => String(options || '').split(/\s+/).filter(Boolean);

// What the launcher's arguments (or a shortcut's launch options) ask for: `--play` starts the game without the
// launcher's window (Skip Launcher), and `--game=<id>` (or `--play=<id>`) is the game, which the launcher opens on and
// `--play` starts. A bare `--play` is Colosseum's, as every shortcut's was before XD; without either the launcher
// opens on the game chosen last.
function startOptions(args) {
  const list = Array.isArray(args) ? args : words(args);
  const play = list.some(option => option === '--play' || option.startsWith('--play='));
  const named = list.map(option => /^--(?:game|play)=(.+)$/.exec(option)?.[1]).find(Boolean) || null;
  return { play, game: named || (play ? DEFAULT_GAME : null) };
}
// The game a shortcut starts, from its launch options: one without a game is Colosseum's.
const shortcutGame = options => startOptions(options).game || DEFAULT_GAME;
// What a shortcut for a game other than Colosseum adds to its launch options so it opens on that game.
const gameOption = game => (game && game !== DEFAULT_GAME ? `--game=${game}` : '');

// The game's shortcut in a shortcuts.vdf list: the one that starts exe (added by this or by hand) for that game.
const findShortcut = (list, exe, platform, game = DEFAULT_GAME) =>
  list.find(entry => entry[0] === MAP && field(entry[2], 'exe') && samePath(unquote(field(entry[2], 'exe')[2]), exe, platform)
    && shortcutGame(field(entry[2], 'launchoptions')?.[2]) === game);

// Launch options with `--play` (Skip Launcher: Steam starts the game without
// the launcher's window) added or removed, keeping the player's other options.
// A `--play=<id>` typed by hand goes too: the shortcut's `--game=` names the game.
function withPlay(options, play) {
  const rest = words(options).filter(option => option !== '--play' && !option.startsWith('--play='));
  return [...rest, ...(play ? ['--play'] : [])].join(' ');
}

// Launch options with each of `needed` (the AppImage's `--no-sandbox`, and a
// game's `--game=`) that is missing put first, keeping the player's own. Without
// --no-sandbox a shortcut added by hand opens the launcher in Desktop Mode but
// not in Game Mode.
const withOptions = (options, needed) => [...words(needed).filter(option => !words(options).includes(option)), ...words(options)].join(' ');
const missingOptions = (options, needed) => words(needed).some(option => !words(options).includes(option));

// Adds the game's shortcut to a parsed shortcuts.vdf, or finds it by its Exe and
// game when it is already there (added before, or by hand) and fixes it in place, keeping
// that entry's app ID so its play time, collections, controller layout and the
// player's name for it stay, as removing it and adding it again would not.
// `play` turns Skip Launcher on or off; left out, the options stay as they are.
function upsertShortcut(root, { exe, startDir, game = DEFAULT_GAME, appName = appNameFor(game), launchOptions: own = '', play,
  platform = process.platform }) {
  let shortcuts = field(root, 'shortcuts');
  if (!shortcuts) { shortcuts = [MAP, 'shortcuts', []]; root.push(shortcuts); }
  const list = shortcuts[2];
  const quotedExe = `"${exe}"`;
  const launchOptions = [own, gameOption(game)].filter(Boolean).join(' ');
  const existing = findShortcut(list, exe, platform, game);
  if (existing) {
    const fields = existing[2];
    const name = field(fields, 'appname')?.[2] || appName;
    if (!field(fields, 'appid')) setField(fields, INT32, 'appid', shortcutAppId(quotedExe, name) | 0);
    if (!unquote(field(fields, 'startdir')?.[2])) setField(fields, STRING, 'StartDir', `"${startDir}"`);
    if (launchOptions) setField(fields, STRING, 'LaunchOptions', withOptions(field(fields, 'launchoptions')?.[2], launchOptions));
    // Steam names a game added by hand after its file: it becomes the game's
    // name, to go with its artwork. A name the player chose stays.
    const file = (platform === 'win32' ? path.win32 : path.posix).parse(exe);
    if ([file.base, file.name].includes(field(fields, 'appname')?.[2])) setField(fields, STRING, 'appname', appName);
    if (play !== undefined) setField(fields, STRING, 'LaunchOptions', withPlay(field(fields, 'launchoptions')?.[2] || '', play));
    return { appId: field(fields, 'appid')[2] >>> 0, fields, added: false };
  }
  const appId = shortcutAppId(quotedExe, appName);
  // The fields, names and order Steam itself writes
  const fields = [
    [INT32, 'appid', appId | 0], [STRING, 'appname', appName], [STRING, 'exe', quotedExe], [STRING, 'StartDir', `"${startDir}"`],
    [STRING, 'icon', ''], [STRING, 'ShortcutPath', ''], [STRING, 'LaunchOptions', withPlay(launchOptions, play)], [INT32, 'IsHidden', 0],
    [INT32, 'AllowDesktopConfig', 1], [INT32, 'AllowOverlay', 1], [INT32, 'OpenVR', 0], [INT32, 'Devkit', 0],
    [STRING, 'DevkitGameID', ''], [INT32, 'DevkitOverrideAppID', 0], [INT32, 'LastPlayTime', 0], [STRING, 'FlatpakAppID', ''],
    [STRING, 'sortas', ''], [MAP, 'tags', []]
  ];
  const next = list.reduce((n, entry) => (/^\d+$/.test(entry[1]) ? Math.max(n, Number(entry[1]) + 1) : n), 0);
  list.push([MAP, String(next), fields]);
  return { appId, fields, added: true };
}

// Where Steam may be installed, most likely first.
function steamRoots({ platform = process.platform, home = require('node:os').homedir(), env = process.env, registryPath } = {}) {
  if (platform === 'win32')
    return [registryPath, env['ProgramFiles(x86)'] && path.win32.join(env['ProgramFiles(x86)'], 'Steam'), 'C:\\Program Files (x86)\\Steam'].filter(Boolean);
  if (platform === 'darwin') return [path.posix.join(home, 'Library/Application Support/Steam')];
  return ['.steam/steam', '.local/share/Steam', '.var/app/com.valvesoftware.Steam/.local/share/Steam', 'snap/steam/common/.local/share/Steam']
    .map(dir => path.posix.join(home, dir));
}

// Steam's install folder from `reg query HKCU\Software\Valve\Steam /v SteamPath` output.
function registrySteamPath(output) {
  const match = /SteamPath\s+REG_\w+\s+(.+)/i.exec(String(output || ''));
  return match ? path.win32.normalize(match[1].trim()) : null;
}

function findSteam(roots, files = fs) {
  return roots.find(root => { try { return files.statSync(path.join(root, 'userdata')).isDirectory(); } catch { return false; } }) || null;
}

// The Steam account to add the launcher for: the one signed in most recently,
// from config/loginusers.vdf (the latest Timestamp, or else marked MostRecent),
// or every account on this computer when that file lists none of them. Steam
// no longer writes MostRecent, so one left over from an old account would
// otherwise win over the account signed in now.
function steamAccounts(root, files = fs) {
  let ids = [];
  try { ids = files.readdirSync(path.join(root, 'userdata')).filter(name => /^\d+$/.test(name) && name !== '0'); } catch { return []; }
  let login = '';
  try { login = files.readFileSync(path.join(root, 'config', 'loginusers.vdf'), 'utf8'); } catch { /* not signed in yet */ }
  const listed = [];
  for (const [, steamId, body] of login.matchAll(/"(\d{17})"\s*\{([^}]*)\}/g)) {
    const account = String(BigInt(steamId) - 76561197960265728n);
    if (ids.includes(account))
      listed.push({ account, recent: /"MostRecent"\s*"1"/i.test(body), time: Number(/"Timestamp"\s*"(\d+)"/i.exec(body)?.[1] || 0) });
  }
  const latest = listed.sort((a, b) => b.time - a.time || b.recent - a.recent)[0];
  return latest ? [latest.account] : ids;
}

// PNG files only: an error page saved as artwork would show as a broken image.
const isPng = data => Buffer.isBuffer(data) && data.length > 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

// Downloads the artwork, before Steam closes. A piece that fails is left out.
async function downloadArtwork(download, pieces = ARTWORK) {
  const results = await Promise.allSettled(pieces.map(async piece => ({ ...piece, data: await download(piece.url) })));
  return results.map((result, index) => (result.status === 'fulfilled' && isPng(result.value.data) ? result.value : { ...pieces[index], data: null }));
}

// Whether every account already has the launcher in its library. A file that
// cannot be read counts as not there, so Add to Steam is still offered.
function hasShortcut({ root, accounts, exe, game = DEFAULT_GAME, platform = process.platform, files = fs }) {
  return accounts.length > 0 && accounts.every(account => {
    try {
      const shortcuts = field(parseVdf(files.readFileSync(path.join(root, 'userdata', account, 'config', 'shortcuts.vdf'))), 'shortcuts');
      return Boolean(shortcuts && findShortcut(shortcuts[2], exe, platform, game));
    } catch { return false; }
  });
}

// The launcher's launch options in Steam, from the first account that has it,
// or null when none does. The banner shows Skip Launcher as it is set there.
function shortcutLaunchOptions({ root, accounts, exe, game = DEFAULT_GAME, platform = process.platform, files = fs }) {
  for (const account of accounts) {
    try {
      const shortcuts = field(parseVdf(files.readFileSync(path.join(root, 'userdata', account, 'config', 'shortcuts.vdf'))), 'shortcuts');
      const entry = shortcuts && findShortcut(shortcuts[2], exe, platform, game);
      if (entry) return String(field(entry[2], 'launchoptions')?.[2] || '');
    } catch { /* not readable: try the next account */ }
  }
  return null;
}
const skipsLauncher = options => startOptions(options).play;

// SteamOS, as on the Steam Deck: its os-release names it (or a system based on
// it), or the firmware names Valve as the maker, as a Deck's does under any system.
// LCD (Jupiter) and OLED (Galileo) Decks are told apart nowhere: both count.
function isSteamOS({ osRelease = '', vendor = '' } = {}) {
  const value = key => (new RegExp(`^${key}=["']?([^"'\\n]*)`, 'm').exec(osRelease)?.[1] || '').toLowerCase();
  return value('ID') === 'steamos' || value('ID_LIKE').split(/\s+/).includes('steamos') || /^valve\b/i.test(vendor.trim());
}

// File permissions to keep: the file's own, or else `mode`.
function modeOf(file, files, mode = null) {
  try { return files.statSync(file).mode & 0o7777; } catch { return mode; }
}

// Writes through a new file renamed into place, keeping the old file's
// permissions (or `mode` for a new one). NonSteamLaunchers marks
// shortcuts.vdf executable and, finding it not executable, writes an empty
// list over it, so a new file without that would cost the player their games.
function writeAtomically(file, data, files, mode = null) {
  const temporary = `${file}.colosseum-launcher-new`;
  const keep = modeOf(file, files, mode);
  files.writeFileSync(temporary, data);
  if (keep !== null) files.chmodSync(temporary, keep);
  files.renameSync(temporary, file);
}

// Each shortcut in a shortcuts.vdf list as bytes, to compare before and after.
const shortcutBytes = list => list.map(entry => serializeVdf([entry]).toString('hex'));

// shortcuts.vdf as it will be written, checked first: it must read back, and
// every other non-Steam game must still be in it exactly as it was, so a
// mistake here can never cost the player their library.
function checkedVdf(parsed, others, count) {
  const data = serializeVdf(parsed);
  let list = [];
  try { list = field(parseVdf(data), 'shortcuts')?.[2] || []; } catch { /* counted as missing below */ }
  const written = new Set(shortcutBytes(list));
  if (list.length !== count || !others.every(bytes => written.has(bytes)))
    throw new Error("Add to Steam stopped before changing Steam's list of non-Steam games, because the new list would not have kept all of them. Nothing was changed.");
  return data;
}

// The copy of shortcuts.vdf made before a change. The first is
// shortcuts.vdf.colosseum-launcher-backup and is never replaced; later ones are named
// after the time, so choosing Add to Steam again keeps the copy from before.
// A list that already has a copy isn't saved again. Copies keep the list's
// permissions, so one put back by renaming it works as the list did.
function backUp(vdf, data, files, now = new Date()) {
  const first = `${vdf}.colosseum-launcher-backup`;
  const mode = modeOf(vdf, files);
  const save = (file, flag = 'w') => { files.writeFileSync(file, data, { flag }); if (mode !== null) files.chmodSync(file, mode); return file; };
  try { return save(first, 'wx'); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  let dated = [];
  try { dated = files.readdirSync(path.dirname(vdf)).filter(name => name.startsWith(`${path.basename(first)}-`)).sort(); } catch { /* none yet */ }
  for (const copy of [first, ...dated.map(name => path.join(path.dirname(vdf), name))]) {
    try { if (files.readFileSync(copy).equals(data)) return copy; } catch { /* compared with the next */ }
  }
  return save(`${first}-${now.toISOString().replace(/[:.]/g, '-')}`);
}

// How many non-Steam games a shortcuts.vdf lists, or null when it can't be read.
function shortcutCount(data) {
  try { return (field(parseVdf(data), 'shortcuts')?.[2] || []).length; } catch { return null; }
}

// Every Steam folder's shortcuts.vdf as it is now, taken before Steam closes:
// Steam writes its own list over the file as it exits, and has been seen to
// write it short (on the Steam Deck it can load an empty or another folder's
// list, such as userdata/0's). Each is backed up, so the list from before Steam
// closed is kept whatever Steam writes, and addShortcut compares against it.
// `backUp: false` only reads them, for the log.
function snapshotShortcuts({ root, backUp: save = true, files = fs }) {
  let folders = [];
  try { folders = files.readdirSync(path.join(root, 'userdata')).filter(name => /^\d+$/.test(name)).sort(); } catch { return []; }
  return folders.flatMap(account => {
    const vdf = path.join(root, 'userdata', account, 'config', 'shortcuts.vdf');
    let data;
    try { data = files.readFileSync(vdf); } catch { return []; }
    let backup = null;
    try { if (save) backup = backUp(vdf, data, files); } catch { /* the snapshot in memory still guards the write */ }
    return [{ account, data, count: shortcutCount(data), mode: modeOf(vdf, files), backup }];
  });
}

// The snapshot for the log: each folder with how many non-Steam games it lists.
const describeShortcuts = snapshot => snapshot.length
  ? snapshot.map(({ account, count }) => `${account === '0' ? 'folder 0' : `account ${account}`}: ${count === null ? "couldn't be read" : `${count} non-Steam game${count === 1 ? '' : 's'}`}`).join('; ')
  : 'no shortcuts.vdf in any Steam folder';

// Steam wrote fewer non-Steam games as it closed than an account had before
// (in `snapshot`, from snapshotShortcuts). Steam's short list is kept as a
// backup, the list from before Steam closed goes back, and nothing is added.
function stopIfSteamLostGames({ snapshot, account, vdf, data, files }) {
  const earlier = snapshot?.find(item => item.account === account);
  if (!earlier?.count) return;
  const now = data ? shortcutCount(data) : 0;
  if (now !== null && now >= earlier.count) return;
  if (data) backUp(vdf, data, files);
  writeAtomically(vdf, earlier.data, files, earlier.mode);
  const error = new Error(`Steam lost ${now === null ? 'its list of' : `${earlier.count - now} of the ${earlier.count}`} non-Steam games as it closed, so Add to Steam stopped and put back the list from before Steam closed. Open Steam and check your non-Steam games are there, then choose Add to Steam again.`);
  error.restored = { account, before: earlier.count, after: now };
  throw error;
}

// Adds the game's shortcut to each account's shortcuts.vdf (backing up the old
// file first) and saves its artwork. Steam must be closed. `snapshot` is each
// folder's list from before Steam closed: when Steam wrote an account's list
// short, it is put back as it was and nothing is added to any account.
function addShortcut({ root, accounts, exe, startDir, game = DEFAULT_GAME, appName = appNameFor(game), launchOptions = '', play, artwork = [], snapshot,
  platform = process.platform, files = fs }) {
  const lists = accounts.map(account => {
    const config = path.join(root, 'userdata', account, 'config');
    const vdf = path.join(config, 'shortcuts.vdf');
    let data = null;
    try { data = files.readFileSync(vdf); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return { account, config, vdf, data };
  });
  for (const list of lists) stopIfSteamLostGames({ snapshot, ...list, files });
  return lists.map(({ account, config, vdf, data }) => {
    files.mkdirSync(path.join(config, 'grid'), { recursive: true });
    const parsed = data ? parseVdf(data) : [[MAP, 'shortcuts', []]];
    const before = field(parsed, 'shortcuts')?.[2] || [];
    const count = before.length, bytes = shortcutBytes(before);
    const shortcut = upsertShortcut(parsed, { exe, startDir, game, appName, launchOptions, play, platform });
    const others = bytes.filter((_, index) => before[index][2] !== shortcut.fields);
    const pieces = artwork.filter(piece => piece.data);
    const image = piece => path.join(config, 'grid', `${shortcut.appId}${piece.suffix}`);
    const icon = pieces.find(piece => piece.suffix === '_icon.png');
    if (icon) setField(shortcut.fields, STRING, 'icon', image(icon));
    const output = checkedVdf(parsed, others, count + (shortcut.added ? 1 : 0));
    for (const piece of pieces) writeAtomically(image(piece), piece.data, files);
    const backup = data ? backUp(vdf, data, files) : null;
    writeAtomically(vdf, output, files);
    return { account, appId: shortcut.appId, added: shortcut.added, artwork: pieces.length, kept: others.length, backup };
  });
}

// Stop in Steam sends SIGTERM to everything it started at once, and on Linux that
// includes the process serving the AppImage's mount, so the launcher's code goes
// away under it. Electron answers SIGTERM with a normal quit, which runs code that
// hasn't been read yet, and reading it then fails with a SIGBUS crash report.
// Dropping the last Node listener for a signal puts back its default action, so
// the system ends the launcher without running any of it. Only for a launcher Steam
// started: a SIGTERM for the launcher alone needs the normal quit, which closes
// Electron's helper processes before the mount goes.
function endOnSigterm(target = process) {
  const listener = () => {};
  target.on('SIGTERM', listener);
  target.removeListener('SIGTERM', listener);
}

module.exports = {
  APP_NAME, ARTWORK, SHORTCUTS, DEFAULT_GAME, artworkFor, appNameFor, startOptions, shortcutGame, MAP, STRING, INT32, parseVdf, serializeVdf,
  shortcutAppId, upsertShortcut,
  steamRoots, registrySteamPath, findSteam, steamAccounts, downloadArtwork, hasShortcut, shortcutLaunchOptions, skipsLauncher, missingOptions,
  isSteamOS, checkedVdf, snapshotShortcuts, describeShortcuts, addShortcut, endOnSigterm
};
