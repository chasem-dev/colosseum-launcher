'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const steam = require('../src/steam');
const { MAP, STRING, INT32 } = steam;

const field = (entries, key) => entries.find(entry => entry[1].toLowerCase() === key.toLowerCase())?.[2];
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

// A shortcuts.vdf as Steam writes it, with one game added by hand and a float
// and a 64-bit value from some other tool.
function steamFile() {
  const other = [[INT32, 'appid', -1234567], [STRING, 'appname', 'Some Game'], [STRING, 'exe', '"C:\\Games\\some.exe"'],
    [STRING, 'StartDir', '"C:\\Games\\"'], [INT32, 'LastPlayTime', 1700000000], [3, 'scale', Buffer.from([0, 0, 128, 63])],
    [7, 'big', Buffer.from([1, 2, 3, 4, 5, 6, 7, 8])], [MAP, 'tags', [[STRING, '0', 'Favorites']]]];
  return steam.serializeVdf([[MAP, 'shortcuts', [[MAP, '0', other]]]]);
}

test('shortcuts.vdf reads and writes back byte for byte', () => {
  const data = steamFile();
  assert.deepEqual(steam.serializeVdf(steam.parseVdf(data)), data);
  assert.equal(data.at(-1), 8);
  assert.equal(data.at(-2), 8);
});

test('a damaged shortcuts.vdf is refused', () => {
  const data = steamFile();
  for (const broken of [data.subarray(0, data.length - 3), Buffer.concat([data, Buffer.from([1])]), Buffer.from([9, 65, 0, 8])])
    assert.throws(() => steam.parseVdf(broken), /could not be read/);
});

test('app IDs are the CRC-32 of the quoted Exe and name, with the top bit set', () => {
  assert.equal(steam.shortcutAppId('1234', '56789'), 0xcbf43926); // CRC-32 of "123456789"
  const id = steam.shortcutAppId('"C:\\SMS Launcher\\SMS Launcher.exe"', 'Pokémon Colosseum');
  assert.ok(id >= 0x80000000 && id <= 0xffffffff);
  assert.equal(id, steam.shortcutAppId('"C:\\SMS Launcher\\SMS Launcher.exe"', 'Pokémon Colosseum'));
});

test('the launcher is added after the other shortcuts, as Steam writes them', () => {
  const root = steam.parseVdf(steamFile());
  const result = steam.upsertShortcut(root, { exe: 'C:\\Programs\\SMS Launcher\\SMS Launcher.exe', startDir: 'C:\\Programs\\SMS Launcher', platform: 'win32' });
  const list = field(root, 'shortcuts');
  assert.equal(result.added, true);
  assert.deepEqual(list.map(entry => entry[1]), ['0', '1']);
  assert.equal(field(list[0][2], 'appname'), 'Some Game');
  const fields = list[1][2];
  assert.equal(field(fields, 'appname'), 'Pokémon Colosseum');
  assert.equal(field(fields, 'exe'), '"C:\\Programs\\SMS Launcher\\SMS Launcher.exe"');
  assert.equal(field(fields, 'StartDir'), '"C:\\Programs\\SMS Launcher"');
  assert.equal(field(fields, 'appid') >>> 0, result.appId);
  assert.equal(field(fields, 'AllowOverlay'), 1);
});

test('a launcher already in Steam is updated in place, keeping its app ID and name', () => {
  const root = steam.parseVdf(steamFile());
  field(root, 'shortcuts').push([MAP, '1', [[INT32, 'appid', -42], [STRING, 'appname', 'Mario'], [STRING, 'exe', '"C:\\PROGRAMS\\SMS Launcher\\SMS Launcher.exe"'], [STRING, 'LaunchOptions', '']]]);
  const result = steam.upsertShortcut(root, { exe: 'C:\\Programs\\SMS Launcher\\SMS Launcher.exe', startDir: 'C:\\Programs\\SMS Launcher', platform: 'win32' });
  assert.equal(result.added, false);
  assert.equal(result.appId, -42 >>> 0);
  assert.equal(field(root, 'shortcuts').length, 2);
  assert.equal(field(result.fields, 'appname'), 'Mario');
  assert.equal(field(result.fields, 'StartDir'), '"C:\\Programs\\SMS Launcher"');
});

test('on Linux, paths match exactly and the AppImage gets its launch options', () => {
  const root = [[MAP, 'shortcuts', [[MAP, '0', [[INT32, 'appid', -7], [STRING, 'exe', '"/home/deck/Apps/sms-launcher.appimage"']]]]]];
  const result = steam.upsertShortcut(root, { exe: '/home/deck/Apps/SMS-Launcher.AppImage', startDir: '/home/deck/Apps', launchOptions: '--no-sandbox', platform: 'linux' });
  assert.equal(result.added, true);
  assert.equal(field(result.fields, 'LaunchOptions'), '--no-sandbox');
});

test('Skip Launcher adds --play to the launch options, and turning it off removes it', () => {
  const root = [[MAP, 'shortcuts', []]];
  const options = { exe: '/home/deck/Apps/SMS-Launcher.AppImage', startDir: '/home/deck/Apps', launchOptions: '--no-sandbox', platform: 'linux' };
  const added = steam.upsertShortcut(root, { ...options, play: true });
  assert.equal(field(added.fields, 'LaunchOptions'), '--no-sandbox --play');
  // the player's own options stay, and --play is never doubled
  added.fields.find(entry => entry[1] === 'LaunchOptions')[2] = '--no-sandbox --play -fullscreen';
  assert.equal(field(steam.upsertShortcut(root, { ...options, play: true }).fields, 'LaunchOptions'), '--no-sandbox -fullscreen --play');
  assert.equal(field(steam.upsertShortcut(root, { ...options, play: false }).fields, 'LaunchOptions'), '--no-sandbox -fullscreen');
  assert.equal(field(steam.upsertShortcut(root, options).fields, 'LaunchOptions'), '--no-sandbox -fullscreen');
  assert.equal(field(root, 'shortcuts').length, 1);
});

test("each game has its own shortcut: XD's opens the launcher on XD, and Colosseum's stays as it was", () => {
  const root = [[MAP, 'shortcuts', []]];
  const options = { exe: '/home/deck/Apps/SMS-Launcher.AppImage', startDir: '/home/deck/Apps', launchOptions: '--no-sandbox', platform: 'linux' };
  const colosseum = steam.upsertShortcut(root, { ...options, play: true });
  const xd = steam.upsertShortcut(root, { ...options, game: 'xd', play: true });
  assert.equal(xd.added, true);
  assert.equal(field(root, 'shortcuts').length, 2);
  assert.equal(field(colosseum.fields, 'appname'), 'Pokémon Colosseum');
  assert.equal(field(colosseum.fields, 'LaunchOptions'), '--no-sandbox --play');
  assert.equal(field(xd.fields, 'appname'), 'Pokémon XD: Gale of Darkness');
  assert.equal(field(xd.fields, 'LaunchOptions'), '--no-sandbox --game=xd --play');
  assert.notEqual(xd.appId, colosseum.appId, 'each has its own artwork');
  // Skip Launcher off keeps XD's shortcut on XD, and each is found again by its game
  assert.equal(field(steam.upsertShortcut(root, { ...options, game: 'xd', play: false }).fields, 'LaunchOptions'), '--no-sandbox --game=xd');
  assert.equal(steam.upsertShortcut(root, { ...options, play: false }).fields, colosseum.fields);
  assert.equal(field(colosseum.fields, 'LaunchOptions'), '--no-sandbox');
  assert.equal(field(root, 'shortcuts').length, 2);
  // a --play=xd typed by hand is XD's shortcut, and keeps starting XD as Skip Launcher goes on and off
  const handMade = [[MAP, 'shortcuts', [[MAP, '0', [[INT32, 'appid', -5], [STRING, 'appname', 'XD'], [STRING, 'exe', `"${options.exe}"`],
    [STRING, 'LaunchOptions', '--no-sandbox --play=xd']]]]]];
  const found = steam.upsertShortcut(handMade, { ...options, game: 'xd', play: false });
  assert.equal(found.added, false);
  assert.equal(found.appId, -5 >>> 0);
  assert.equal(field(found.fields, 'LaunchOptions'), '--game=xd --no-sandbox');
  assert.equal(steam.upsertShortcut(handMade, { ...options, play: true }).added, true, "Colosseum's is a shortcut of its own");
  assert.equal(steam.shortcutGame('--no-sandbox --play'), 'colosseum');
  assert.equal(steam.shortcutGame('--play=xd'), 'xd');
});

test("each game's artwork comes from SteamGridDB as PNGs, with the suffixes Steam looks for", () => {
  assert.equal(steam.artworkFor('colosseum'), steam.ARTWORK);
  for (const id of ['colosseum', 'xd']) {
    const pieces = steam.artworkFor(id);
    assert.ok(pieces.some(piece => piece.suffix === 'p.png'), `${id} has a library capsule`);
    for (const piece of pieces) {
      assert.match(piece.url, /^https:\/\/cdn2\.steamgriddb\.com\/[a-z]+\/[0-9a-f]{32}\.png$/);
      assert.ok(['p.png', '.png', '_hero.png', '_logo.png', '_icon.png'].includes(piece.suffix));
    }
  }
  assert.equal(steam.appNameFor('xd'), 'Pokémon XD: Gale of Darkness');
  assert.equal(steam.appNameFor('nothing'), steam.APP_NAME);
});

test('Steam is looked for where each system installs it', () => {
  const linux = steam.steamRoots({ platform: 'linux', home: '/home/deck' });
  assert.ok(linux.includes('/home/deck/.local/share/Steam'));
  assert.ok(linux.includes('/home/deck/.var/app/com.valvesoftware.Steam/.local/share/Steam'));
  const windows = steam.steamRoots({ platform: 'win32', env: {}, registryPath: 'D:\\Steam' });
  assert.equal(windows[0], 'D:\\Steam');
  assert.equal(steam.registrySteamPath('\r\nHKEY_CURRENT_USER\\Software\\Valve\\Steam\r\n    SteamPath    REG_SZ    c:/program files (x86)/steam\r\n'),
    'c:\\program files (x86)\\steam');
  assert.equal(steam.registrySteamPath('ERROR: The system was unable to find the specified registry key'), null);
});

function fakeSteam(t, { accounts = ['111', '222'], login = '' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'steam-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const account of [...accounts, '0']) fs.mkdirSync(path.join(root, 'userdata', account, 'config'), { recursive: true });
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  if (login) fs.writeFileSync(path.join(root, 'config', 'loginusers.vdf'), login);
  return root;
}

test('the launcher goes to the account signed in most recently, or to every account', t => {
  const login = '"users"\n{\n\t"76561197960265839"\n\t{\n\t\t"AccountName"\t"a"\n\t\t"MostRecent"\t\t"0"\n\t}\n' +
    '\t"76561197960265950"\n\t{\n\t\t"AccountName"\t"b"\n\t\t"MostRecent"\t\t"1"\n\t}\n}\n';
  assert.deepEqual(steam.steamAccounts(fakeSteam(t, { login })), ['222']);
  // Steam now writes no MostRecent: the latest Timestamp, and accounts it no longer lists are left alone
  const timestamps = '"users"\n{\n\t"76561197960265839"\n\t{\n\t\t"Timestamp"\t\t"1700000000"\n\t}\n' +
    '\t"76561197960265950"\n\t{\n\t\t"Timestamp"\t\t"1790000000"\n\t}\n}\n';
  assert.deepEqual(steam.steamAccounts(fakeSteam(t, { login: timestamps })), ['222']);
  // a MostRecent left on an old account loses to the account signed in since
  const stale = '"users"\n{\n\t"76561197960265839"\n\t{\n\t\t"MostRecent"\t\t"1"\n\t\t"Timestamp"\t\t"1700000000"\n\t}\n' +
    '\t"76561197960265950"\n\t{\n\t\t"timestamp"\t\t"1790000000"\n\t}\n}\n';
  assert.deepEqual(steam.steamAccounts(fakeSteam(t, { login: stale })), ['222']);
  const onlyOne = '"users"\n{\n\t"76561197960265839"\n\t{\n\t\t"AutoLogin"\t\t"1"\n\t\t"Timestamp"\t\t"1790000000"\n\t}\n}\n';
  assert.deepEqual(steam.steamAccounts(fakeSteam(t, { login: onlyOne })), ['111']);
  assert.deepEqual(steam.steamAccounts(fakeSteam(t)).sort(), ['111', '222']);
  assert.equal(steam.findSteam(['/nowhere', fakeSteam(t)]) !== null, true);
  assert.equal(steam.findSteam(['/nowhere']), null);
});

// As steam.ARTWORK lists them once the game's are chosen.
const PIECES = ['p.png', '.png', '_hero.png', '_logo.png', '_icon.png'].map(suffix => ({ suffix, url: `https://example.com/${suffix}` }));

test('adding to Steam writes the shortcut and artwork, and backs up the old file', t => {
  const root = fakeSteam(t, { accounts: ['222'] });
  const config = path.join(root, 'userdata', '222', 'config');
  const old = steamFile();
  fs.writeFileSync(path.join(config, 'shortcuts.vdf'), old);
  const artwork = PIECES.map((piece, index) => ({ ...piece, data: index === 1 ? null : PNG }));
  const options = { root, accounts: ['222'], exe: 'C:\\SMS\\SMS Launcher.exe', startDir: 'C:\\SMS', artwork, platform: 'win32' };
  const [first] = steam.addShortcut(options);
  assert.equal(first.added, true);
  assert.equal(first.artwork, 4);
  assert.equal(first.kept, 1);
  assert.equal(first.backup, path.join(config, 'shortcuts.vdf.colosseum-launcher-backup'));
  assert.deepEqual(fs.readFileSync(path.join(config, 'shortcuts.vdf.colosseum-launcher-backup')), old);
  const grid = fs.readdirSync(path.join(config, 'grid')).sort();
  assert.deepEqual(grid, [`${first.appId}_hero.png`, `${first.appId}_icon.png`, `${first.appId}_logo.png`, `${first.appId}p.png`]);
  const list = field(steam.parseVdf(fs.readFileSync(path.join(config, 'shortcuts.vdf'))), 'shortcuts');
  assert.equal(list.length, 2);
  assert.equal(field(list[1][2], 'icon'), path.join(config, 'grid', `${first.appId}_icon.png`));
  // again: the same shortcut, no copy, and the first backup stays as it was
  const added = fs.readFileSync(path.join(config, 'shortcuts.vdf'));
  const [second] = steam.addShortcut(options);
  assert.equal(second.added, false);
  assert.equal(second.appId, first.appId);
  assert.equal(second.kept, 1);
  assert.equal(field(steam.parseVdf(fs.readFileSync(path.join(config, 'shortcuts.vdf'))), 'shortcuts').length, 2);
  assert.deepEqual(fs.readFileSync(path.join(config, 'shortcuts.vdf.colosseum-launcher-backup')), old);
  assert.match(path.basename(second.backup), /^shortcuts\.vdf\.colosseum-launcher-backup-\d{4}-\d\d-\d\dT/);
  assert.deepEqual(fs.readFileSync(second.backup), added);
});

test("shortcuts.vdf is not written unless every other non-Steam game is still in it", () => {
  const root = steam.parseVdf(steamFile());
  const others = field(root, 'shortcuts').map(entry => steam.serializeVdf([entry]).toString('hex'));
  assert.ok(steam.checkedVdf(root, others, 1).equals(steamFile()));
  assert.throws(() => steam.checkedVdf([[MAP, 'shortcuts', []]], others, 0), /Nothing was changed/);
  assert.throws(() => steam.checkedVdf(root, others, 2), /Nothing was changed/);
  const changed = steam.parseVdf(steamFile());
  field(changed, 'shortcuts')[0][2].find(entry => entry[1] === 'appname')[2] = 'Renamed';
  assert.throws(() => steam.checkedVdf(changed, others, 1), /Nothing was changed/);
});

// A shortcuts.vdf listing `count` games, each a copy of steamFile()'s.
function steamFileWith(count) {
  const [game] = steam.parseVdf(steamFile())[0][2];
  return steam.serializeVdf([[MAP, 'shortcuts', Array.from({ length: count }, (_, index) => [MAP, String(index), game[2]])]]);
}

test("every Steam folder's list, folder 0 too, is counted and backed up before Steam closes", t => {
  const root = fakeSteam(t, { accounts: ['222'] });
  const vdf = account => path.join(root, 'userdata', account, 'config', 'shortcuts.vdf');
  fs.writeFileSync(vdf('0'), steamFileWith(3));
  fs.writeFileSync(vdf('222'), steamFileWith(1));
  const snapshot = steam.snapshotShortcuts({ root });
  assert.deepEqual(snapshot.map(({ account, count }) => [account, count]), [['0', 3], ['222', 1]]);
  assert.equal(steam.describeShortcuts(snapshot), 'folder 0: 3 non-Steam games; account 222: 1 non-Steam game');
  for (const account of ['0', '222']) assert.deepEqual(fs.readFileSync(`${vdf(account)}.colosseum-launcher-backup`), fs.readFileSync(vdf(account)));
  // the same list again makes no new copy; a changed one gets a dated copy
  steam.snapshotShortcuts({ root });
  fs.writeFileSync(vdf('222'), steamFileWith(2));
  assert.equal(steam.snapshotShortcuts({ root, backUp: false })[1].backup, null);
  const [, changed] = steam.snapshotShortcuts({ root });
  assert.match(path.basename(changed.backup), /^shortcuts\.vdf\.colosseum-launcher-backup-\d{4}-/);
  steam.snapshotShortcuts({ root });
  assert.equal(fs.readdirSync(path.dirname(vdf('222'))).filter(name => name.includes('backup')).length, 2);
  fs.writeFileSync(vdf('222'), 'not a vdf');
  assert.match(steam.describeShortcuts(steam.snapshotShortcuts({ root, backUp: false })), /account 222: couldn't be read/);
  assert.equal(steam.describeShortcuts([]), 'no shortcuts.vdf in any Steam folder');
});

test('when Steam writes its list short as it closes, the list from before goes back and nothing is added', t => {
  const root = fakeSteam(t, { accounts: ['111', '222'] });
  const vdf = account => path.join(root, 'userdata', account, 'config', 'shortcuts.vdf');
  fs.writeFileSync(vdf('111'), steamFileWith(2));
  fs.writeFileSync(vdf('222'), steamFileWith(5));
  const snapshot = steam.snapshotShortcuts({ root });
  const short = steamFileWith(1);
  fs.writeFileSync(vdf('222'), short); // Steam's own write as it exits
  const options = { root, accounts: ['111', '222'], exe: '/opt/SMS-Launcher.AppImage', startDir: '/opt', platform: 'linux', snapshot };
  assert.throws(() => steam.addShortcut(options), error => /Steam lost 4 of the 5 non-Steam games/.test(error.message)
    && error.restored.account === '222' && error.restored.before === 5 && error.restored.after === 1);
  assert.deepEqual(fs.readFileSync(vdf('222')), steamFileWith(5));
  assert.deepEqual(fs.readFileSync(vdf('111')), steamFileWith(2)); // no account was changed
  const kept = fs.readdirSync(path.dirname(vdf('222'))).filter(name => name.startsWith('shortcuts.vdf.colosseum-launcher-backup-'));
  assert.deepEqual(kept.map(name => fs.readFileSync(path.join(path.dirname(vdf('222')), name))), [short]);
  // a missing file counts as an empty list
  fs.rmSync(vdf('222'));
  assert.throws(() => steam.addShortcut(options), /Steam lost 5 of the 5/);
  assert.deepEqual(fs.readFileSync(vdf('222')), steamFileWith(5));
  // with every list as long as before, the launcher is added
  const results = steam.addShortcut(options);
  assert.deepEqual(results.map(result => [result.account, result.added, result.kept]), [['111', true, 2], ['222', true, 5]]);
  // the list from before Steam closed was already backed up, so no new copy
  assert.equal(results[1].backup, `${vdf('222')}.colosseum-launcher-backup`);
});

test("shortcuts.vdf keeps its permissions, as NonSteamLaunchers empties one that isn't executable", { skip: process.platform === 'win32' }, t => {
  const root = fakeSteam(t, { accounts: ['111'] });
  const vdf = path.join(root, 'userdata', '111', 'config', 'shortcuts.vdf');
  fs.writeFileSync(vdf, steamFileWith(2));
  fs.chmodSync(vdf, 0o755);
  const snapshot = steam.snapshotShortcuts({ root });
  const mode = file => fs.statSync(file).mode & 0o777;
  assert.equal(mode(snapshot[0].backup), 0o755);
  const options = { root, accounts: ['111'], exe: '/opt/SMS-Launcher.AppImage', startDir: '/opt', platform: 'linux', snapshot };
  steam.addShortcut(options);
  assert.equal(mode(vdf), 0o755);
  // a list Steam deleted as it closed comes back with them too
  fs.rmSync(vdf);
  assert.throws(() => steam.addShortcut(options), /Steam lost 2 of the 2/);
  assert.equal(mode(vdf), 0o755);
  assert.deepEqual(fs.readFileSync(vdf), steamFileWith(2));
});

test('an account without shortcuts.vdf gets a new one', t => {
  const root = fakeSteam(t, { accounts: ['111'] });
  const [result] = steam.addShortcut({ root, accounts: ['111'], exe: '/opt/SMS-Launcher.AppImage', startDir: '/opt', platform: 'linux' });
  const list = field(steam.parseVdf(fs.readFileSync(path.join(root, 'userdata', '111', 'config', 'shortcuts.vdf'))), 'shortcuts');
  assert.equal(list.length, 1);
  assert.equal(field(list[0][2], 'appid') >>> 0, result.appId);
  assert.equal(fs.existsSync(path.join(root, 'userdata', '111', 'config', 'shortcuts.vdf.colosseum-launcher-backup')), false);
});

test('the banner knows when every account already has the launcher', t => {
  const root = fakeSteam(t, { accounts: ['111', '222'] });
  const options = { root, accounts: ['111', '222'], exe: 'C:\\SMS\\SMS Launcher.exe', startDir: 'C:\\SMS', platform: 'win32' };
  assert.equal(steam.hasShortcut(options), false);
  steam.addShortcut({ ...options, accounts: ['111'] });
  assert.equal(steam.hasShortcut(options), false);
  steam.addShortcut(options);
  assert.equal(steam.hasShortcut(options), true);
  assert.equal(steam.hasShortcut({ ...options, exe: 'C:\\Other\\SMS Launcher.exe' }), false);
  // XD's shortcut is its own: Colosseum's doesn't count for it
  assert.equal(steam.hasShortcut({ ...options, game: 'xd' }), false);
  steam.addShortcut({ ...options, game: 'xd' });
  assert.deepEqual([steam.hasShortcut({ ...options, game: 'xd' }), steam.hasShortcut(options)], [true, true]);
  assert.equal(steam.shortcutLaunchOptions({ ...options, game: 'xd' }), '--game=xd');
  assert.equal(steam.shortcutLaunchOptions(options), '');
  fs.writeFileSync(path.join(root, 'userdata', '222', 'config', 'shortcuts.vdf'), 'broken');
  assert.equal(steam.hasShortcut(options), false);
  assert.equal(steam.hasShortcut({ ...options, accounts: [] }), false);
});

test('artwork that fails to download, or is not a PNG, is left out', async () => {
  const artwork = await steam.downloadArtwork(async url => {
    if (url.includes('_hero')) throw new Error('offline');
    if (url.includes('_logo')) return Buffer.from('<html>not found</html>');
    return PNG;
  }, PIECES);
  assert.deepEqual(artwork.map(piece => Boolean(piece.data)), [true, true, false, false, true]);
});

test("the banner reads Skip Launcher from the launcher's launch options in Steam", t => {
  const root = fakeSteam(t, { accounts: ['111'] });
  const options = { root, accounts: ['111'], exe: '/home/deck/Applications/SMS-Launcher.AppImage', startDir: '/home/deck/Applications', platform: 'linux' };
  assert.equal(steam.shortcutLaunchOptions(options), null);
  steam.addShortcut({ ...options, launchOptions: '--no-sandbox', play: true });
  assert.equal(steam.shortcutLaunchOptions(options), '--no-sandbox --play');
  assert.equal(steam.skipsLauncher(steam.shortcutLaunchOptions(options)), true);
  steam.addShortcut({ ...options, play: false });
  assert.equal(steam.skipsLauncher(steam.shortcutLaunchOptions(options)), false);
  assert.equal(steam.skipsLauncher('--player'), false);
});

test('SteamOS is recognised by its os-release or a Valve-made Deck, LCD or OLED', () => {
  assert.equal(steam.isSteamOS({ osRelease: 'NAME="SteamOS"\nID=steamos\nID_LIKE=arch\nVARIANT_ID=steamdeck\n' }), true);
  assert.equal(steam.isSteamOS({ osRelease: 'ID=holoiso\nID_LIKE="arch steamos"\n' }), true);
  assert.equal(steam.isSteamOS({ osRelease: 'ID=bazzite\nID_LIKE="fedora"\n', vendor: 'Valve\n' }), true);
  assert.equal(steam.isSteamOS({ osRelease: 'ID=ubuntu\nID_LIKE=debian\n', vendor: 'LENOVO\n' }), false);
  assert.equal(steam.isSteamOS({ osRelease: 'ID=steamosish\n' }), false);
  assert.equal(steam.isSteamOS(), false);
});

test('a shortcut added by hand gets --no-sandbox and the game\'s name, keeping its app ID and the player\'s options', () => {
  const exe = '/home/deck/Applications/SMS-Launcher.AppImage';
  const handMade = name => [[MAP, 'shortcuts', [[MAP, '0', [[INT32, 'appid', -99], [STRING, 'appname', name], [STRING, 'exe', `"${exe}"`],
    [STRING, 'StartDir', '"/home/deck/Applications/"'], [STRING, 'LaunchOptions', '--play'], [INT32, 'LastPlayTime', 1700000000]]]]]];
  const root = handMade('SMS-Launcher.AppImage');
  const result = steam.upsertShortcut(root, { exe, startDir: '/home/deck/Applications', launchOptions: '--no-sandbox', platform: 'linux' });
  assert.equal(result.added, false);
  assert.equal(result.appId, -99 >>> 0);
  assert.equal(field(result.fields, 'LaunchOptions'), '--no-sandbox --play');
  assert.equal(field(result.fields, 'appname'), 'Pokémon Colosseum');
  assert.equal(field(result.fields, 'LastPlayTime'), 1700000000);
  assert.equal(field(root, 'shortcuts').length, 1);
  assert.equal(field(steam.upsertShortcut(handMade('Sunshine!'), { exe, startDir: '/x', launchOptions: '--no-sandbox', platform: 'linux' }).fields, 'appname'), 'Sunshine!');
  assert.equal(field(steam.upsertShortcut(root, { exe, startDir: '/x', launchOptions: '--no-sandbox', play: false, platform: 'linux' }).fields, 'LaunchOptions'), '--no-sandbox');
});

test('a shortcut is missing launch options until it has every one of them', () => {
  assert.equal(steam.missingOptions('', '--no-sandbox'), true);
  assert.equal(steam.missingOptions('--play', '--no-sandbox'), true);
  assert.equal(steam.missingOptions('--play --no-sandbox', '--no-sandbox'), false);
  assert.equal(steam.missingOptions(null, ''), false);
});

// Electron answers SIGTERM with a quit, which a Stop in Steam must not run (endOnSigterm in steam.js).
// A shell's ignored signal stands in for that handler: only the default action ends this child.
test('endOnSigterm gives SIGTERM back to the system', { skip: process.platform === 'win32' }, async () => {
  const script = `require(${JSON.stringify(path.resolve(__dirname, '../src/steam'))}).endOnSigterm();
    process.stdout.write('ready'); setTimeout(() => process.exit(7), 30000);`;
  const child = spawn('sh', ['-c', `trap '' TERM; exec "$0" -e "$1"`, process.execPath, script], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise(resolve => child.stdout.once('data', resolve));
  child.kill('SIGTERM');
  const [code, signal] = await new Promise(resolve => child.once('exit', (...result) => resolve(result)));
  assert.deepEqual([code, signal], [null, 'SIGTERM']);
});
