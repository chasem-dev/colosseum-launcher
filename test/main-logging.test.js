'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

function main(t, { platform = process.platform, childProcess } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sms-main-log-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filename = path.resolve(__dirname, '../src/main.js');
  const localRequire = createRequire(filename);
  const appEvents = {}, processEvents = {}, consoleEvents = {}, handlers = {}, copied = [];
  const electron = { ipcMain: { handle: (name, handler) => { handlers[name] = handler; } },
    clipboard: { writeText: text => copied.push(text) },
    protocol: { registerSchemesAsPrivileged() {}, handle() {} },
    app: { requestSingleInstanceLock: () => true, commandLine: { appendSwitch() {} }, on: (name, handler) => { appEvents[name] = handler; },
    whenReady: () => ({ then() {} }), getPath: () => root },
    screen: { getPrimaryDisplay: () => ({ scaleFactor: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } }), getDisplayMatching: () => ({ scaleFactor: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } }), on() {} } };
  electron.BrowserWindow = class {
    webContents = { send() {}, setWindowOpenHandler() {}, on: (name, handler) => { consoleEvents[name] = handler; } };
    isDestroyed() { return false; }
    getBounds() { return { x: 0, y: 0, width: 1080, height: 760 }; }
    hookWindowMessage() {}
    on() {}
    once() {}
    setMenuBarVisibility() {}
    loadFile() {}
  };
  const context = { require: id => id === 'electron' ? electron
      : id === 'node:child_process' && childProcess ? childProcess : localRequire(id),
    __dirname: path.dirname(filename),
    process: new Proxy(process, { get(target, key) {
      if (key === 'platform') return platform;
      return key === 'on' ? (name, handler) => { processEvents[name] = handler; } : target[key];
    } }),
    setTimeout, setInterval, module: { exports: {} } };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8') +
    '\nmodule.exports = { launch, capture, exclusive, createWindow, registerHandlers, log, logOutput, activityLog, makeSaveBackup, preparePlayPacks, teamDiscReady, setConfig: value => { config = value; }, saveLog: file => sessionLog.save(file, [...partialOutput.values()]) };', context, { filename });
  return { ...context.module.exports, root, appEvents, processEvents, consoleEvents, handlers, copied };
}

test('Copy log IPC copies the full session with live partial output, beyond the view limit', t => {
  const runtime = main(t);
  runtime.registerHandlers();
  runtime.log('early diagnostic');
  for (let i = 0; i < 1000; ++i) runtime.log(`entry ${i}`);
  runtime.logOutput('live stderr diagnostic', 'stderr');
  runtime.logOutput('live stdout prompt', 'stdout');
  assert.equal(runtime.activityLog.snapshot().length, 700);
  runtime.handlers['copy-activity-log']();
  assert.match(runtime.copied[0], /^\[launcher\] early diagnostic\n/);
  assert.match(runtime.copied[0], /entry 999\n\[stderr\] live stderr diagnostic\n\[stdout\] live stdout prompt\n$/);
  const destination = path.join(runtime.root, 'saved.log');
  runtime.saveLog(destination);
  assert.equal(runtime.copied[0], fs.readFileSync(destination, 'utf8'));
  runtime.handlers['copy-activity-log']();
  assert.equal(runtime.copied[1], runtime.copied[0]);
});

test('all Play actions reset stored history and partial output before reporting setup errors', async t => {
  const runtime = main(t);
  runtime.registerHandlers();
  for (const channel of ['play', 'launch-game', 'play-previous']) {
    runtime.log('previous run');
    runtime.logOutput('previous partial', 'stderr');
    // No installation is configured: even this setup failure starts a fresh log.
    await assert.rejects(runtime.handlers[channel]());
    runtime.handlers['copy-activity-log']();
    const copied = runtime.copied.at(-1);
    assert.doesNotMatch(copied, /previous run|previous partial/);
    assert.match(copied, /\[launcher\] ✕/);
    assert.ok(runtime.activityLog.snapshot().every(entry => !['previous run', 'previous partial'].includes(entry.text)));
  }
});

test('a rejected Play while busy preserves the active session log', async t => {
  const runtime = main(t);
  runtime.registerHandlers();
  let finish;
  const running = runtime.exclusive('Running task', () => new Promise(resolve => { finish = resolve; }));
  runtime.log('active run diagnostic');
  await assert.rejects(runtime.handlers.play(), /Wait for the current task/);
  runtime.handlers['copy-activity-log']();
  assert.match(runtime.copied[0], /active run diagnostic/);
  finish();
  await running;
});

test('real launcher game failures preserve status without quoting warnings and can launch again', async t => {
  const runtime = main(t);
  await assert.rejects(runtime.launch(process.execPath, ['-e',
    "process.stderr.write('Could not find customStages.bin\\nDelay Context: 5');process.exitCode=7"], {}, 'Game', true),
    /^Error: Game exited with code 7\. See the activity log\.$/);
  assert.equal((await runtime.launch(process.execPath, ['-e', "process.stdout.write('ok')"], {}, 'Next')).ok, true);
  const entries = runtime.activityLog.snapshot();
  assert.ok(entries.some(entry => entry.stream === 'stderr' && entry.text === 'Delay Context: 5'));
  assert.ok(entries.some(entry => entry.stream === 'launcher' && entry.text === '✕ Game exited with code 7. See the activity log.'));
  const destination = path.join(runtime.root, 'saved.log');
  runtime.saveLog(destination);
  const saved = fs.readFileSync(destination, 'utf8');
  assert.match(saved, /\[stderr\] Could not find customStages.bin\n\[stderr\] Delay Context: 5\n/);
  assert.match(saved, /\[stdout\] ok\n\[launcher\] ✓ Next finished/);
});

test('the launcher logs captured commands and errors while preserving their returned stdout', async t => {
  const runtime = main(t);
  assert.equal(await runtime.capture(process.execPath, ['-e',
    "process.stdout.write('Café 🌞\\n');process.stderr.write('warning\\n')"]), 'Café 🌞');
  await assert.rejects(runtime.capture(process.execPath, ['-e',
    "process.stderr.write('fatal: real failure');process.exitCode=9"]), /code 9: fatal: real failure/);
  await assert.rejects(runtime.launch('/colosseum-launcher-missing-command', [], {}, 'Missing'), /ENOENT/);
  assert.equal((await runtime.launch(process.execPath, ['-e', ''], {}, 'Recovered')).ok, true);
  const entries = runtime.activityLog.snapshot();
  assert.ok(entries.some(entry => entry.stream === 'stdout' && entry.text === 'Café 🌞'));
  assert.ok(entries.some(entry => entry.stream === 'stderr' && entry.text === 'fatal: real failure'));
  assert.ok(entries.some(entry => entry.stream === 'launcher' && entry.text.includes('ENOENT')));
});

test('launcher exceptions, renderer errors and Electron process crashes are kept in the session log', t => {
  const runtime = main(t);
  runtime.createWindow();
  runtime.processEvents.uncaughtExceptionMonitor(new Error('launcher failed'));
  runtime.processEvents.warning(new Error('launcher warning'));
  runtime.consoleEvents['console-message']({ level: 'error', message: 'renderer failed', sourceId: 'renderer.js', lineNumber: 42 });
  runtime.appEvents['render-process-gone']({}, {}, { reason: 'crashed', exitCode: 9 });
  runtime.appEvents['child-process-gone']({}, { type: 'GPU', reason: 'oom', exitCode: 1 });
  const destination = path.join(runtime.root, 'saved.log');
  runtime.saveLog(destination);
  const saved = fs.readFileSync(destination, 'utf8');
  for (const expected of ['launcher failed', 'launcher warning', 'renderer failed (renderer.js:42)',
    'renderer crashed: Renderer exited with code 9', 'GPU process oom: GPU exited with code 1'])
    assert.ok(saved.includes(expected), expected);
});

test('Windows starts the game detached, not hidden, so its window shows', async t => {
  const { EventEmitter } = require('node:events');
  const { PassThrough } = require('node:stream');
  const spawned = [];
  const childProcess = { spawn(command, args, options) {
    spawned.push({ command, options });
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), pid: 1 });
    setImmediate(() => { child.stdout.end(); child.stderr.end(); child.emit('close', 0, null); });
    return child;
  } };
  const runtime = main(t, { platform: 'win32', childProcess });
  await runtime.launch('sms.exe', [], {}, 'Play Super Mario Sunshine', true);
  await runtime.launch('bash.exe', [], {}, 'Build game');
  assert.equal(spawned[0].options.windowsHide, false);
  assert.equal(spawned[0].options.detached, true);
  assert.equal(spawned[1].options.windowsHide, true);
  assert.equal(spawned[1].options.detached, false);
});

test('Steam\'s overlay in LD_PRELOAD reaches the game but not the launcher\'s tasks', async t => {
  const { EventEmitter } = require('node:events');
  const { PassThrough } = require('node:stream');
  const spawned = [];
  const childProcess = { spawn(command, args, options) {
    spawned.push(options.env);
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), pid: 1 });
    setImmediate(() => { child.stdout.end(); child.stderr.end(); child.emit('close', 0, null); });
    return child;
  } };
  const runtime = main(t, { platform: 'linux', childProcess });
  const env = { LD_PRELOAD: 'ubuntu12_32/gameoverlayrenderer.so:ubuntu12_64/gameoverlayrenderer.so', PATH: 'tools' };
  await runtime.launch('colosseum', [], { env }, 'Play Pokémon Colosseum', true);
  await runtime.launch('/bin/sh', [], { env }, 'Build Pokémon Colosseum');
  await runtime.capture('git', ['rev-parse', 'HEAD'], '.', env);
  assert.equal(spawned[0].LD_PRELOAD, env.LD_PRELOAD);
  for (const task of spawned.slice(1)) {
    assert.equal('LD_PRELOAD' in task, false);
    assert.equal(task.PATH, 'tools');
  }
});

test('Back up automatically off skips the launcher\'s own backups, with a log line, but not Back up saves', t => {
  const runtime = main(t);
  // Backups go to ~/Colosseum Launcher Backups: os.homedir() is HOME, or USERPROFILE on Windows.
  const home = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  for (const key of Object.keys(home)) process.env[key] = runtime.root;
  t.after(() => { for (const [key, value] of Object.entries(home)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  assert.equal(os.homedir(), runtime.root);
  const card = path.join(runtime.root, 'card-a');
  const backups = path.join(runtime.root, 'Colosseum Launcher Backups');
  fs.mkdirSync(card);
  fs.writeFileSync(path.join(card, 'GMSE01.dat'), 'progress');
  const made = () => fs.existsSync(backups) ? fs.readdirSync(backups).length : 0;
  // the game's card folder, as it finds it: <XDG_DATA_HOME>/colo-port/card-a
  fs.mkdirSync(path.join(runtime.root, 'data', 'colo-port'), { recursive: true });
  fs.renameSync(card, path.join(runtime.root, 'data', 'colo-port', 'card-a'));
  const dataHome = process.env.XDG_DATA_HOME, appData = process.env.APPDATA;
  process.env.XDG_DATA_HOME = process.env.APPDATA = path.join(runtime.root, 'data');
  t.after(() => {
    for (const [key, value] of [['XDG_DATA_HOME', dataHome], ['APPDATA', appData]])
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
  });
  runtime.setConfig({ repo: runtime.root, settings: { autoBackups: false } });
  for (const reason of ['before-play', 'after-play', 'before-port-update', 'before-cleanup'])
    assert.deepEqual({ ...runtime.makeSaveBackup(reason) }, { skipped: true });
  assert.equal(made(), 0);
  const lines = runtime.activityLog.snapshot().map(entry => entry.text);
  assert.ok(lines.includes('Saves not backed up before playing: automatic backups are off under Saves.'), lines.join('\n'));
  assert.ok(lines.includes('Saves not backed up before the update: automatic backups are off under Saves.'));
  assert.equal(runtime.makeSaveBackup('manual').count, 1);
  assert.equal(made(), 1);
  runtime.setConfig({ repo: runtime.root, saveDirectory: card, settings: { autoBackups: true } });
  assert.equal(runtime.makeSaveBackup('before-play').count, 1);
  assert.equal(made(), 2);
});

test('a task that runs out of disk space says the drive is full, in the alert and the log', async t => {
  const runtime = main(t);
  runtime.registerHandlers();
  const full = () => { throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' }); };
  await assert.rejects(runtime.exclusive('Download port source', full),
    // Windows names the drive letter first ("Your C: drive (the launcher's data folder, …)")
    error => error.buildHint === 'disk-full' && error.message.includes(runtime.root) && /launcher's data folder/.test(error.message));
  runtime.handlers['copy-activity-log']();
  assert.match(runtime.copied.at(-1), /\[launcher\] ✕ Download port source: .*launcher's data folder.+ is full \(ENOSPC/);
  // Anything else is shown as it was.
  await assert.rejects(runtime.exclusive('Download port source', () => { throw new Error('fatal: early EOF'); }), /^Error: fatal: early EOF$/);
});

test('the game\'s Discord presence lines stay out of the activity log, and other programs\' lines don\'t', async t => {
  const runtime = main(t);
  const presenceLine = '[presence] {"mode":"field","story":1,"floor":1,"area":1,"place":"OUTSKIRT STAND","opponent":"","lead":"","level":0}';
  const print = text => ['-e', `process.stdout.write(${JSON.stringify(text)})`];
  await runtime.launch(process.execPath, print(`${presenceLine}\nfloor loaded\n${presenceLine}`), {}, 'Play Pokémon Colosseum', true);
  await runtime.launch(process.execPath, print(`${presenceLine}\n`), {}, 'Build game');
  const stdout = runtime.activityLog.snapshot().filter(entry => entry.stream === 'stdout').map(entry => entry.text);
  assert.deepEqual(stdout, ['floor loaded', presenceLine]);
});

// XD reads Colosseum's file of later generations (host/xd/packs.c): made from Colosseum's disc, whichever disc XD's is.
test('XD gets the later generations the settings ask for, and its packs, made from Colosseum\'s disc', t => {
  const runtime = main(t);
  const { gcm } = require('./disc-fixture');
  const pokemonPacks = require('../src/pokemon-packs'), generations = require('../src/generations');
  const colosseum = path.join(runtime.root, 'colosseum.iso'), xd = path.join(runtime.root, 'xd.iso');
  fs.writeFileSync(colosseum, gcm()); fs.writeFileSync(xd, gcm('GXXE01', 0, 'Pokemon XD'));
  const read = [], built = [], originals = { readGameTables: pokemonPacks.readGameTables, generationPokemon: pokemonPacks.generationPokemon, ownRows: pokemonPacks.ownRows, build: generations.build };
  t.after(() => { Object.assign(pokemonPacks, { readGameTables: originals.readGameTables, generationPokemon: originals.generationPokemon, ownRows: originals.ownRows }); generations.build = originals.build; });
  pokemonPacks.readGameTables = rom => { read.push(rom); return { rom }; };
  pokemonPacks.generationPokemon = (_tables, _built, options) => { assert.ok(options?.modelsDirectory, 'with the Battle Revolution models, as Colosseum\'s'); return { pokemon: [], problems: [] }; };
  // the game's own Pokémon as Platinum has them (Yanma: its evolutions and level-up moves), which XD takes too (host/evolutions.c)
  pokemonPacks.ownRows = (_tables, built) => ({ rows: built.rules ? [{ id: 193, evolutions: Buffer.alloc(30), moves: Buffer.alloc(40) }] : [], problems: [] });
  generations.build = (tables, settings) => {
    built.push(settings);
    return { moves: [], species: [], abilities: [], rules: settings.battleRules > 3 ? { generation: settings.battleRules, features: 3, categories: Buffer.alloc(4), changed: [], species: [] } : null };
  };
  const folder = path.join(runtime.root, 'cache');
  fs.mkdirSync(folder);
  const settings = { battleRules: 4, generationPokemon: [4] };
  runtime.setConfig({ game: 'xd', rom: xd, settings, games: { colosseum: { rom: colosseum } } });
  const played = runtime.preparePlayPacks(xd, folder);
  assert.equal(played.own, 0);
  assert.equal(played.file, path.join(folder, 'pokemon-packs.bin'), 'the same file as Colosseum\'s');
  assert.deepEqual(read, [colosseum], 'Colosseum\'s disc, not XD\'s');
  assert.deepEqual(built, [{ battleRules: 4, generationPokemon: [4] }]);
  const bytes = fs.readFileSync(played.file);
  assert.equal(bytes.subarray(0, 4).toString('latin1'), 'CPKM');
  assert.ok(bytes.includes(Buffer.from('MECH')), 'the rules go in');
  assert.ok(bytes.includes(Buffer.from('ROWS')), 'and the game\'s own Pokémon\'s rows, for their evolutions and moves');
  assert.equal(runtime.teamDiscReady(), true);
  // Colosseum's rules and no later Pokémon: nothing to read
  runtime.setConfig({ game: 'xd', rom: xd, settings: { battleRules: 3, generationPokemon: [] }, games: { colosseum: { rom: colosseum } } });
  assert.deepEqual({ ...runtime.preparePlayPacks(xd, folder) }, { file: null, own: 0 });
  assert.equal(read.length, 1);
  // An online battle in XD has no settings' generations: its room's Gen 3 rules make nothing
  runtime.setConfig({ game: 'xd', rom: xd, settings, games: { colosseum: { rom: colosseum } } });
  assert.deepEqual({ ...runtime.preparePlayPacks(xd, folder, { rules: { battleRules: 3 } }) }, { file: null, own: 0 });
  // Without Colosseum's disc XD plays by Gen 3, and the activity log says why
  runtime.setConfig({ game: 'xd', rom: xd, settings, games: {} });
  assert.deepEqual({ ...runtime.preparePlayPacks(xd, folder) }, { file: null, own: 0 });
  assert.match(runtime.activityLog.snapshot().map(entry => entry.text).join('\n'),
    /Pokémon packs weren't loaded: XD's Pokémon packs and later generations are made from Pokémon Colosseum's disc\. Choose Colosseum on the Play page/);
  assert.equal(runtime.teamDiscReady(), false);
});
