'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const port = require('../src/port');
const games = require('../src/games');

function state() {
  return {
    config: { repo: '/installed/port', settings: port.normalizeSettings({ autoUpdate: true }), completedSetup: true },
    platform: port.platformInfo(), tools: { ready: true, appleReady: true },
    repoReady: true, romReady: true, binaryReady: true, hdVisualsReady: true, texturePack: { size: 2e9, unpacked: 2e9 },
    game: { needsUpdate: true, installedVersion: 'older', availableVersion: 'newer', launcherVersion: '0.1.39' },
    appUpdate: { message: '' }, backups: [], logs: [], active: null, crashReports: { folder: '/state/crashes', count: 0, newest: null }
  };
}

// The system a state's platformInfo describes, so saving settings in a test does not depend on the computer.
function host(platform) { return { linux: 'linux', macos: 'darwin', windows: 'win32' }[platform.id]; }

async function renderer(data = state(), copyError = null, notes = { releases: [], unseen: [], current: '0.1.39' }) {
  const changelogSeen = [], calls = [], elements = new Map(), listeners = {}, gamepad = {}, featured = [];
  let logCallback, resetCallback, activityCallback;
  const text = node => typeof node === 'string' ? node : node.textContent + node.children.map(text).join(' ');
  function element(classes = '') {
    const names = new Set(classes.split(' ')), listeners = new Map();
    return { hidden: false, disabled: false, textContent: '', value: '', style: { setProperty() {} }, open: false,
      classList: { contains: name => names.has(name), add: name => names.add(name), remove: name => names.delete(name), toggle(name, enabled) {
        if (enabled) names.add(name); else names.delete(name);
      } },
      addEventListener: (event, callback) => { if (!listeners.has(event)) listeners.set(event, []); listeners.get(event).push(callback); },
      click() { if (!this.disabled) for (const callback of listeners.get('click') || []) callback(); },
      dispatch(event, value) { for (const callback of listeners.get(event) || []) callback(value); },
      setAttribute(name, value) { this[name] = value; }, removeAttribute(name) { delete this[name]; },
      replaceChildren(...children) { this.textContent = children.map(text).join(''); this.replaced = children; },
      append(...children) { this.children.push(...children); }, focus() {}, querySelector: () => null,
      children: [], appendChild(child) { this.children.push(child); return child; },
      close() { this.open = false; }, showModal() { this.open = true; },
      dataset: {}, getBoundingClientRect: () => ({ left: 0, top: 0 }), querySelectorAll: () => [],
      showPopover() { this.dispatch('beforetoggle', { newState: 'open' }); this.open = true; this.dispatch('toggle', { newState: 'open' }); },
      hidePopover() { this.open = false; this.dispatch('toggle', { newState: 'closed' }); } };
  }
  const html = fs.readFileSync(path.resolve(__dirname, '../src/index.html'), 'utf8');
  for (const match of html.matchAll(/<[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const node = element(match[0].match(/class="([^"]+)"/)?.[1]);
    node.hidden = /\bhidden\b/.test(match[0]);
    node.id = match[1];
    const feature = match[0].match(/data-feature="([^"]+)"/)?.[1];
    if (feature) { node.dataset = { feature }; featured.push(node); }
    elements.set(match[1], node);
  }
  const colo = {
    state: async () => data, windowState: async () => ({}), zoomFactor: () => 1,
    toggleMaximize: async () => { calls.push('toggleMaximize'); return { maximized: calls.filter(call => call === 'toggleMaximize').length % 2 === 1 }; },
    toggleFullScreen: async () => { calls.push('toggleFullScreen'); return { fullscreen: true }; },
    onLog(callback) { logCallback = callback; }, onActivity(callback) { activityCallback = callback; }, onAppUpdate() {}, onWindowState() {},
    onLogReset(callback) { resetCallback = callback; },
    saveActivityLog: async () => { calls.push('saveActivityLog'); },
    copyActivityLog: async () => { calls.push('copyActivityLog'); if (copyError) throw copyError; },
    saveSettings: async value => { calls.push(['saveSettings', value]); return { ...data, config: { ...data.config, settings: port.normalizeSettings(value, host(data.platform)) } }; },
    changelog: async () => notes, markChangelogSeen: async () => { changelogSeen.push(true); },
    openDiscord: async () => { calls.push('openDiscord'); },
    play: async () => { calls.push('play'); }, launchGame: async () => { calls.push('launchGame'); },
    removeBuildTools: async () => { calls.push('removeBuildTools'); },
    updateAndPlay: async () => { calls.push('updateAndPlay'); },
    updateChannels: async () => [{ id: 'stable', label: 'Stable' }, { id: 'beta', label: 'Beta' }],
    setGameSource: async value => { calls.push(['setGameSource', value]); return data; },
    selectGame: async id => { calls.push(['selectGame', id]); data.currentGame = games.summary(id); return data; },
    prepareGame: async () => {
      calls.push('prepareGame'); Object.assign(data, { binaryReady: true, hdVisualsReady: true }); data.game = { ...data.game, needsUpdate: false, installedVersion: data.game.availableVersion };
    },
    updatePort: async () => {
      calls.push('updatePort'); data.game = { ...data.game, needsUpdate: false, installedVersion: data.game.availableVersion };
    },
  };
  const context = vm.createContext({ console, setInterval() {}, clearInterval() {}, requestAnimationFrame: callback => setImmediate(callback),
    cancelAnimationFrame() {}, navigator: { getGamepads: () => [] }, ColoBindings: require('../src/bindings'), ColoPresets: require('../src/presets'),
    window: { colo, ColoPlayStage: require('../src/play-stage'), coloActivityLog: require('../src/activity-log'), coloChangelogText: require('../src/changelog-text'), coloGamepadNav: { start: options => Object.assign(gamepad, options) },
      addEventListener(event, callback) { (listeners.window ||= {})[event] = [...(listeners.window[event] || []), callback]; }, removeEventListener() {} }, document: {
    getElementById(id) { assert.ok(elements.has(id), `Missing HTML element ${id}`); return elements.get(id); },
    querySelectorAll(selector) {
      const modals = ['mac-tools-help', 'path-too-long', 'pbr-offer'].map(id => elements.get(id));
      return selector === '.launcher-modal' ? modals : selector === '.launcher-modal[open]' ? modals.filter(modal => modal.open)
        : selector === '[data-feature]' ? featured : [];
    }, createElement: () => element()
  } });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../src/renderer.js'), 'utf8'), context);
  await new Promise(setImmediate);
  return { elements, window: context.window, calls, listeners, changelogSeen, gamepad,
    async emitLog(entry) { logCallback(entry); await new Promise(setImmediate); },
    async resetLog(sequence) { resetCallback(sequence); await new Promise(setImmediate); },
    async emitActivity(active) { activityCallback(active); await new Promise(setImmediate); },
    async refresh() { vm.runInContext('refresh(current)', context); },
    run: code => vm.runInContext(code, context),
    async click(id) { elements.get(id).click(); await new Promise(setImmediate); } };
}

const offered = ui => ['menu-update-play', 'menu-update-only', 'menu-play-now'].filter(id => !ui.elements.get(id).hidden);

test('a waiting update makes Update & play the default, with Update only and Play now under ▾', async () => {
  const ui = await renderer();
  assert.equal(ui.elements.get('play-more').hidden, false);
  assert.equal(ui.elements.get('play').classList.contains('has-more'), true);
  assert.match(ui.elements.get('play').textContent, /Update & play/);
  assert.match(ui.elements.get('home-description').textContent, /Game update newer is ready/);
  assert.equal(ui.elements.get('menu-default-label').textContent, 'Update & play');
  assert.equal(ui.elements.get('menu-default-detail').textContent, 'Install newer, then start');
  assert.deepEqual(offered(ui), ['menu-update-only', 'menu-play-now']);
  assert.equal(ui.elements.get('menu-play-now-detail').textContent, 'Update later');
  assert.equal(ui.elements.get('play-more-hint').textContent, '▾ for Update only or Play now');
  assert.equal(ui.elements.get('play-menu-note').hidden, false);
  ui.elements.get('play-menu').showPopover();
  assert.equal(ui.elements.get('play-more')['aria-expanded'], 'true');
  await ui.click('menu-play-now');
  assert.equal(ui.elements.get('play-menu').open, false);
  assert.equal(ui.elements.get('play-more')['aria-expanded'], 'false');
  assert.deepEqual(ui.calls, ['play']);
  await ui.click('menu-default');
  assert.deepEqual(ui.calls, ['play', 'launchGame']);
});

test('a Windows folder with an & in its path explains itself instead of building', async () => {
  const data = { ...state(), pathProblem: port.pathCharacterProblem('E:\\A & B\\Game\\x', { platform: 'win32', folder: 'E:\\A & B\\Game' }) };
  const ui = await renderer(data);
  await ui.click('menu-update-only');
  assert.equal(ui.elements.get('path-too-long').open, true);
  assert.equal(ui.elements.get('path-too-long-title').textContent, 'Move the launcher to a folder without &');
  assert.equal(ui.elements.get('path-summary').textContent, "The folder holding the setup files's path has & in it.");
  assert.equal(ui.elements.get('path-folder').textContent, 'E:\\A & B\\Game');
  assert.equal(ui.elements.get('path-folder').replaced.filter(part => typeof part !== 'string').length, 1);
  assert.match(ui.elements.get('path-steps').textContent, /a folder without & in its path for Setup files/);
  assert.equal(ui.calls.includes('updatePort'), false);
});

test('a Windows folder too deep to build in still shows how much too long it is', async () => {
  const folder = `C:\\${'long\\'.repeat(40)}x`;
  const data = { ...state(), pathProblem: port.longPathProblem(`${folder}\\game`, { platform: 'win32', folder }) };
  const ui = await renderer(data);
  await ui.click('menu-update-only');
  assert.equal(ui.elements.get('path-too-long-title').textContent, 'Move the launcher to a shorter folder');
  assert.equal(ui.elements.get('path-summary').textContent,
    `The folder holding the setup files's path is ${folder.length} characters long, but the game can only be built in a folder of up to ${data.pathProblem.limit}.`);
  assert.match(ui.elements.get('path-over').textContent, /characters? too long/);
});

test('Update only installs the update without starting the game', async () => {
  const ui = await renderer();
  await ui.click('menu-update-only');
  assert.deepEqual(ui.calls, ['prepareGame']);
  // nothing else to offer now
  assert.equal(ui.elements.get('play-more').hidden, true);
  assert.match(ui.elements.get('play').textContent, /▶ {2}Play/);
  assert.match(ui.elements.get('message-text').textContent, /Updated to game newer/);
});

test('without automatic updates Play is the default and Update & play still updates', async () => {
  const data = state();
  data.config.settings = port.normalizeSettings({ autoUpdate: false });
  const ui = await renderer(data);
  assert.match(ui.elements.get('play').textContent, /▶ {2}Play/);
  assert.equal(ui.elements.get('menu-default-label').textContent, 'Play');
  assert.equal(ui.elements.get('task-status').textContent, 'Update ready');
  assert.deepEqual(offered(ui), ['menu-update-play', 'menu-update-only']);
  assert.equal(ui.elements.get('play-more-hint').textContent, '▾ for Update & play or Update only');
  await ui.click('menu-update-play');
  assert.deepEqual(ui.calls, ['updateAndPlay']);
});

test('controller Back closes the menu before anything else', async () => {
  const ui = await renderer();
  ui.elements.get('play-menu').showPopover();
  ui.gamepad.actions.back();
  assert.equal(ui.elements.get('play-menu').open, false);
});

test('Update & play shows the newly built game version once the game starts', async () => {
  const data = state(), ui = await renderer(data);
  assert.match(ui.elements.get('version-summary').textContent, /Game older/);
  const startedAt = Date.now();
  await ui.emitActivity({ label: 'Prepare game', startedAt });
  await ui.emitActivity({ label: 'Build Pokémon Colosseum', startedAt, canStop: true });
  data.game = { ...data.game, installedVersion: 'newer', needsUpdate: false };
  await ui.emitActivity({ label: 'Play Pokémon Colosseum', startedAt, canStop: true });
  assert.match(ui.elements.get('version-summary').textContent, /Game newer/);
  assert.equal(ui.elements.get('installed-game-version').textContent, 'newer');
});

test('skipping battle animations, or a running task, greys out their speed', async () => {
  const skipping = state();
  skipping.config.settings.skipBattleAnimations = true;
  assert.equal((await renderer(skipping)).elements.get('battleSpeed').disabled, true);
  const ui = await renderer();
  assert.equal(ui.elements.get('battleSpeed').disabled, false);
  assert.equal(ui.elements.get('battleSpeed-value').textContent, '1.5×');
  const busy = state();
  busy.active = { label: 'Building' };
  assert.equal((await renderer(busy)).elements.get('battleSpeed').disabled, true);
});

test('installed play is unavailable before setup, without a disc, or while busy', async () => {
  for (const patch of [{ binaryReady: false, config: { ...state().config, completedSetup: false } }, { romReady: false }]) {
    const ui = await renderer({ ...state(), ...patch });
    assert.equal(ui.elements.get('play-more').hidden, true);
  }
  const data = state(), ui = await renderer(data);
  ui.elements.get('play-menu').showPopover();
  data.active = { label: 'Build Pokémon Colosseum' };
  await ui.refresh();
  assert.equal(ui.elements.get('play-more').disabled, true);
  assert.equal(ui.elements.get('play-menu').open, false);
  assert.equal(ui.elements.get('play-more-hint').hidden, true);
});

test('pending HD setup offers installed play, while a current complete install is just Play', async () => {
  const data = state(); data.game.needsUpdate = false; data.game.installedVersion = null;
  const ui = await renderer(data);
  assert.equal(ui.elements.get('play-more').hidden, true);
  assert.deepEqual(offered(ui), []);
  assert.equal(ui.elements.get('menu-default-label').textContent, 'Play');
  assert.equal(ui.elements.get('menu-default-detail').textContent, 'Start the game');
  data.hdVisualsReady = false;
  await ui.refresh();
  assert.equal(ui.elements.get('play-more').hidden, false);
  assert.equal(ui.elements.get('menu-default-label').textContent, 'Finish HD setup');
  assert.equal(ui.elements.get('menu-default').dataset.kind, 'hd');
  assert.deepEqual(offered(ui), ['menu-play-now']);
  assert.equal(ui.elements.get('menu-play-now-detail').textContent, 'HD visuals later');
  assert.equal(ui.elements.get('play-menu-note').hidden, true);
  await ui.click('menu-play-now');
  assert.deepEqual(ui.calls, ['play']);
});

test('activity log renders stream labels, updates partial lines once and saves the full session', async () => {
  const data = state();
  data.logs = [{ id: 1, sequence: 1, stream: 'launcher', text: 'Started' },
    { id: 2, sequence: 2, stream: 'stderr', text: 'partial' }];
  const ui = await renderer(data);
  await ui.emitLog({ id: 2, sequence: 3, stream: 'stderr', text: 'complete diagnostic' });
  await ui.emitLog(data.logs[1]);
  assert.equal(ui.elements.get('log').textContent, '[launcher] Started\n[stderr] complete diagnostic\n');
  await ui.click('save-activity-log');
  assert.deepEqual(ui.calls, ['saveActivityLog']);
  await ui.click('copy-activity-log');
  assert.deepEqual(ui.calls, ['saveActivityLog', 'copyActivityLog']);
  assert.equal(ui.elements.get('copy-log-result').textContent, 'Full session copied.');
  assert.equal(ui.elements.get('copy-activity-log').disabled, false);
});

test('Copy log reports failures in the activity panel and allows retry', async () => {
  const ui = await renderer(state(), new Error('clipboard unavailable'));
  await ui.click('copy-activity-log');
  assert.equal(ui.elements.get('copy-log-result').textContent, 'Could not copy log: clipboard unavailable');
  assert.equal(ui.elements.get('copy-activity-log').disabled, false);
});

test('the status bar opens the log on any page, and a task shows its progress without opening it', async () => {
  const ui = await renderer();
  const log = ui.elements.get('activity-log');
  assert.equal(log.hidden, true);
  await ui.click('toggle-activity-log');
  assert.equal(log.hidden, false);
  assert.equal(ui.elements.get('toggle-activity-log')['aria-expanded'], 'true');
  await ui.click('settings-cog');
  assert.equal(log.hidden, false);
  await ui.click('close-activity-log');
  assert.equal(log.hidden, true);
  const task = { label: 'Build Pokémon Colosseum', startedAt: Date.now(), canStop: true, percent: 42 };
  await ui.emitActivity(task);
  assert.equal(log.hidden, true);
  assert.equal(ui.elements.get('console-state').textContent, 'Live');
  assert.equal(ui.elements.get('toggle-activity-log').classList.contains('is-live'), true);
  assert.equal(ui.elements.get('status-progress').hidden, false);
  assert.equal(ui.elements.get('status-progress-fill').style.width, '42%');
  assert.equal(ui.elements.get('stop').hidden, false);
  await ui.click('view-build-log');
  assert.equal(log.hidden, false);
  await ui.emitActivity(null);
  assert.equal(ui.elements.get('status-progress').hidden, true);
});

test('the log opens for reported failures and expands without treating stderr as a crash', async () => {
  const ui = await renderer();
  await ui.emitLog({ id: 1, sequence: 1, stream: 'stderr', text: 'Could not find customStages.bin' });
  assert.equal(ui.elements.get('console-state').textContent, 'Idle');
  assert.equal(ui.elements.get('activity-log').hidden, true);
  await ui.emitLog({ id: 2, sequence: 2, stream: 'launcher', text: '✕ Game exited with code 7.' });
  assert.equal(ui.elements.get('console-state').textContent, 'Error');
  assert.equal(ui.elements.get('toggle-activity-log').classList.contains('is-error'), true);
  assert.equal(ui.elements.get('activity-log').hidden, false);
  await ui.click('expand-activity-log');
  assert.equal(ui.elements.get('activity-log').classList.contains('is-expanded'), true);
  assert.equal(ui.elements.get('shell').classList.contains('log-expanded'), true);
  assert.equal(ui.elements.get('expand-activity-log')['aria-label'], 'Restore activity log');
  await ui.click('toggle-activity-log');
  assert.equal(ui.elements.get('activity-log').classList.contains('is-expanded'), false);
  assert.equal(ui.elements.get('shell').classList.contains('log-expanded'), false);
  await ui.resetLog(3);
  assert.equal(ui.elements.get('console-state').textContent, 'Idle');
});

test('a fresh Play clears rendered history and ignores delayed output from the previous run', async () => {
  const data = state();
  const old = { id: 1, sequence: 1, stream: 'stderr', text: 'old error' };
  data.logs = [old];
  const ui = await renderer(data);
  await ui.click('copy-activity-log');
  await ui.resetLog(2);
  assert.equal(ui.elements.get('log').textContent, '');
  assert.equal(ui.elements.get('copy-log-result').textContent, '');
  await ui.emitLog(old);
  await ui.emitLog({ id: 2, sequence: 3, stream: 'stdout', text: 'new run' });
  assert.equal(ui.elements.get('log').textContent, '[stdout] new run\n');
});

// Generation 4 Pokémon on: the launcher asks for the Battle Revolution disc their models come from.
function gen4State(pbr) {
  const data = state();
  data.pbr = { supported: true, wanted: 107, made: 0, outdated: 0, disc: null, discFound: false, ...pbr };
  return data;
}
async function turnOnGen4(ui) {
  ui.elements.get('generation4Pokemon').checked = true;
  ui.elements.get('generation4Pokemon').dispatch('change');
  await new Promise(setImmediate);
}

test('turning on Generation 4 Pokémon asks for the Battle Revolution disc, and choosing it makes the models', async () => {
  const data = gen4State();
  const ui = await renderer(data);
  ui.window.colo.choosePbrDisc = async () => {
    ui.calls.push('choosePbrDisc');
    data.pbr = { ...data.pbr, disc: '/games/pbr.rvz', discFound: true };
    return data;
  };
  ui.window.colo.makePbrModels = async () => { ui.calls.push('makePbrModels'); return data; };
  await turnOnGen4(ui);
  assert.equal(ui.calls.at(-1)[1].generation4Pokemon, true);
  assert.equal(ui.elements.get('pbr-offer').open, true);
  assert.equal(ui.elements.get('pbr-offer-confirm').textContent, 'Choose disc');
  assert.match(ui.elements.get('pbr-offer-lead').textContent, /your own Wii disc/);
  await ui.click('pbr-offer-confirm');
  await new Promise(setImmediate);
  assert.equal(ui.elements.get('pbr-offer').open, false);
  assert.deepEqual(ui.calls.filter(call => typeof call === 'string'), ['choosePbrDisc', 'makePbrModels']);
});

test('a disc chosen before is offered straight away, and nothing is asked once every model is made', async () => {
  const ui = await renderer(gen4State({ disc: '/games/pbr.rvz', discFound: true }));
  ui.window.colo.makePbrModels = async () => { ui.calls.push('makePbrModels'); return ui.run('current'); };
  await turnOnGen4(ui);
  assert.equal(ui.elements.get('pbr-offer-confirm').textContent, 'Make assets');
  assert.match(ui.elements.get('pbr-offer-lead').textContent, /\/games\/pbr\.rvz/);
  await ui.click('pbr-offer-confirm');
  assert.ok(ui.calls.includes('makePbrModels'));

  const done = await renderer(gen4State({ disc: '/games/pbr.rvz', discFound: true, made: 107 }));
  await turnOnGen4(done);
  assert.equal(done.elements.get('pbr-offer').open, false);
});

test('models made before the game made cries are offered their cries above Play, and in Settings', async () => {
  const ui = await renderer(gen4State({ disc: '/games/pbr.rvz', discFound: true, cries: true, made: 0, noCry: 107 }));
  assert.equal(ui.elements.get('pbr-banner').hidden, false);
  assert.equal(ui.elements.get('pbr-banner-title').textContent, 'Your Generation 4 Pokémon can have their own cries');
  assert.equal(ui.elements.get('pbr-banner-detail').textContent, '107 Generation 4 Pokémon cry with a Colosseum Pokémon\'s voice. Battle Revolution\'s own is on your disc.');
  assert.equal(ui.elements.get('pbr-banner-make').textContent, 'Make assets');
  assert.match(ui.elements.get('pbr-note').textContent, /107 Pokémon have a model but no cry of its own yet: press Make assets to add them\./);

  const done = await renderer(gen4State({ disc: '/games/pbr.rvz', discFound: true, cries: true, made: 107, noCry: 0 }));
  assert.equal(done.elements.get('pbr-banner').hidden, true);
  const older = await renderer(gen4State({ disc: null, cries: false }));
  assert.match(older.elements.get('pbr-note').textContent, /their models and icons are made from it/, 'a game that makes no cries');
  const newer = await renderer(gen4State({ disc: null, cries: true }));
  assert.match(newer.elements.get('pbr-note').textContent, /their models, icons and cries are made from it/);
});

test('cancelling the disc picker makes nothing, and the models stay stand-ins', async () => {
  const ui = await renderer(gen4State());
  ui.window.colo.choosePbrDisc = async () => { ui.calls.push('choosePbrDisc'); return ui.run('current'); };
  ui.window.colo.makePbrModels = async () => { ui.calls.push('makePbrModels'); };
  await turnOnGen4(ui);
  await ui.click('pbr-offer-confirm');
  await new Promise(setImmediate);
  assert.deepEqual(ui.calls.filter(call => typeof call === 'string'), ['choosePbrDisc']);
});

test('Back up automatically shows the setting and is saved with the others', async () => {
  const data = state(); data.config.settings = port.normalizeSettings({});
  const ui = await renderer(data);
  assert.equal(ui.elements.get('autoBackups').checked, true);
  ui.elements.get('autoBackups').checked = false;
  ui.elements.get('autoBackups').dispatch('change');
  await new Promise(setImmediate);
  assert.equal(ui.calls.at(-1)[1].autoBackups, false);
});

test('dark mode is off by default, switches the theme at once and is saved with the others', async () => {
  const ui = await renderer(state());
  const shell = ui.elements.get('shell');
  assert.equal(ui.elements.get('darkMode').checked, false);
  assert.equal(shell.classList.contains('dark'), false);
  ui.elements.get('darkMode').checked = true;
  ui.elements.get('darkMode').dispatch('input');
  assert.equal(shell.classList.contains('dark'), true);
  ui.elements.get('darkMode').dispatch('change');
  await new Promise(setImmediate);
  assert.equal(ui.calls.at(-1)[1].darkMode, true);
  assert.equal(shell.classList.contains('dark'), true);
  const saved = state(); saved.config.settings = port.normalizeSettings({ darkMode: true });
  assert.equal((await renderer(saved)).elements.get('shell').classList.contains('dark'), true);
});

const notes = {
  current: '0.1.39', unseen: ['0.1.39'],
  releases: [
    { version: '0.1.39', date: '2026-10-09', title: '', launcher: ['Launcher change'],
      game: { version: '2026.10.09.1', commit: null, changes: ['Game change'] } },
    { version: '0.1.38', date: '2026-10-08', title: '', launcher: ['Older change'], game: null }
  ]
};

const version = (ui, key) => ui.elements.get('changelog-nav').replaced.find(button => button.dataset.key === key);

test('a hotfix shows its fix in a box, with the notes of the release it fixes in full below', async () => {
  const hotfix = { current: '1.0.1', unseen: ['1.0.1'], releases: [
    { version: '1.0.1', date: '2026-11-04', title: 'Co-op hotfix', hotfixFor: '1.0.0', launcher: [],
      game: { version: '2026.11.04.2', commit: null, changes: ['The fix'] } },
    { version: '1.0.0', date: '2026-11-04', title: '', hotfixFor: null, launcher: ['Big launcher change'],
      game: { version: '2026.11.04.1', commit: null, changes: ['Big game change'] } }] };
  const ui = await renderer(state(), null, hotfix);
  const columns = ui.elements.get('changelog-columns');
  assert.deepEqual(columns.replaced.map(node => node.className),
    ['changelog-hotfix', 'changelog-base-head', 'changelog-column', 'changelog-column']);
  assert.equal(columns.classList.contains('changelog-full'), true);
  assert.equal(columns.replaced[0].children[0].textContent, 'Co-op hotfix');
  assert.equal(columns.replaced[1].children[0].textContent, 'Everything new in v1.0.0');
  // the release it fixes, on its own, goes back to its usual columns
  version(ui, '1.0.0').click();
  assert.deepEqual(columns.replaced.map(node => node.className), ['changelog-column', 'changelog-column']);
  assert.equal(columns.classList.contains('changelog-full'), false);
});

test('the changelog opens once after an update on the newest release, with the others beside it', async () => {
  const ui = await renderer(state(), null, notes);
  assert.equal(ui.elements.get('changelog').hidden, false);
  assert.equal(ui.elements.get('changelog-title').textContent, 'Updated to v0.1.39');
  assert.equal(ui.elements.get('changelog-version').textContent, 'v0.1.39');
  assert.equal(ui.elements.get('changelog-badge').textContent, 'New');
  assert.equal(ui.elements.get('changelog-meta').textContent, `${new Date('2026-10-09T12:00:00').toLocaleDateString(undefined,
    { year: 'numeric', month: 'short', day: 'numeric' })} · Game 2026.10.09.1`);
  assert.deepEqual(ui.elements.get('changelog-nav').replaced.map(button => button.dataset.key), ['0.1.39', '0.1.38']);
  assert.equal(ui.changelogSeen.length, 1);
  version(ui, '0.1.38').click();
  assert.equal(ui.elements.get('changelog-version').textContent, 'v0.1.38');
  assert.equal(ui.elements.get('changelog-badge').hidden, true);
  assert.ok(version(ui, '0.1.38').classList.contains('active'));
  assert.ok(!version(ui, '0.1.39').classList.contains('active'));
});

test('nothing new means no popup, and a running task postpones it to the next start', async () => {
  const quiet = await renderer(state(), null, { ...notes, unseen: [] });
  assert.equal(quiet.elements.get('changelog').hidden, true);
  assert.equal(quiet.changelogSeen.length, 1);
  const busy = await renderer({ ...state(), active: { label: 'Build Pokémon Colosseum', startedAt: Date.now() } }, null, notes);
  assert.equal(busy.elements.get('changelog').hidden, true);
  assert.equal(busy.changelogSeen.length, 0);
});

test('the Discord button opens the invite', async () => {
  const ui = await renderer();
  await ui.click('discord');
  assert.deepEqual(ui.calls.filter(call => call === 'openDiscord'), ['openDiscord']);
});

test("the What's new tab lists every release and opens on the newest", async () => {
  const ui = await renderer(state(), null, { ...notes, unseen: [] });
  await ui.click('open-changelog');
  assert.equal(ui.elements.get('changelog').hidden, false);
  assert.equal(ui.elements.get('changelog-title').textContent, "What's new");
  assert.equal(ui.elements.get('changelog-version').textContent, 'v0.1.39');
  assert.equal(ui.elements.get('changelog-badge').textContent, 'Installed');
  assert.equal(ui.elements.get('changelog-nav').replaced.length, 2);
  const empty = await renderer(state(), null, { releases: [], unseen: [], current: '0.1.39' });
  await empty.click('open-changelog');
  assert.equal(empty.elements.get('changelog-status').textContent, 'No changes are listed yet.');
  assert.equal(empty.elements.get('changelog-head').hidden, true);
});

test('controller buttons open settings, step through its tabs, go back and pause while the game runs', async () => {
  const view = await renderer(state());
  const { elements, gamepad } = view;
  const tabs = ['gameplay', 'display', 'graphics', 'controls', 'manage', 'launcher'];
  const shown = () => tabs.filter(name => !elements.get(`pane-${name}`).hidden);
  assert.equal(gamepad.paused(), false);
  gamepad.actions.menu();
  assert.equal(elements.get('page-settings').hidden, false);
  assert.equal(elements.get('page-home').hidden, true);
  assert.deepEqual(shown(), ['gameplay']);
  gamepad.actions.previous();
  assert.deepEqual(shown(), ['gameplay']);
  gamepad.actions.next();
  assert.deepEqual(shown(), ['display']);
  for (let i = 0; i < 10; i++) gamepad.actions.next();
  assert.deepEqual(shown(), ['launcher']);
  assert.equal(elements.get('tab-launcher')['aria-selected'], 'true');
  assert.equal(elements.get('tab-gameplay')['aria-selected'], 'false');
  gamepad.actions.previous();
  assert.deepEqual(shown(), ['manage']);
  gamepad.actions.back();
  assert.equal(elements.get('page-settings').hidden, true);
  assert.equal(elements.get('page-home').hidden, false);
  // Settings reopens on the tab it closed on.
  gamepad.actions.menu();
  assert.deepEqual(shown(), ['manage']);
  await view.click('tab-controls');
  assert.deepEqual(shown(), ['controls']);
  gamepad.actions.menu();
  assert.equal(elements.get('page-settings').hidden, true);
  // Away from Settings, LB and RB step through the launcher's tabs.
  gamepad.actions.next();
  assert.equal(elements.get('page-saves').hidden, false);
  gamepad.actions.back();
  assert.equal(elements.get('page-home').hidden, false);
  gamepad.actions.view();
  assert.equal(elements.get('activity-log').hidden, false);
  gamepad.actions.back();
  assert.equal(elements.get('activity-log').hidden, true);
  await view.emitActivity({ label: 'Play Pokémon Colosseum', startedAt: Date.now() });
  assert.equal(gamepad.paused(), true);
});

test('a controller the launcher cannot see still gets its buttons changed, from the list in the row', async () => {
  const ui = await renderer();
  await ui.click('settings-cog');
  await ui.click('tab-controls');
  const choose = async (id, add, pad) => {
    ui.run(`bindingMode = 'controller'; startCapture(${JSON.stringify(id)}, ${add})`);
    const row = ui.elements.get('binding-list').replaced[ui.run(`ColoBindings.CONTROLS.findIndex(control => control.id === ${JSON.stringify(id)})`)];
    const keys = row.children[1];
    assert.equal(keys.textContent, 'No controller seen yet: press a button on it…');
    const list = keys.children.find(child => child.className === 'pad-choice');
    assert.deepEqual(list.children.map(option => option.value), ['', ...require('../src/bindings').PAD_BUTTONS.map(button => button.id)]);
    list.value = pad;
    list.dispatch('change');
    await new Promise(setImmediate);
  };
  await choose('A', false, 'PAD_B');
  assert.match(ui.elements.get('binding-note').textContent, /pick the button from the list/);
  await choose('B', false, 'PAD_A');
  assert.equal(ui.run('capture'), null);
  assert.deepEqual({ ...ui.calls.at(-1)[1].padBindings }, { A: ['PAD_B'], B: ['PAD_A'] });
  await choose('A', true, 'PAD_LB');
  assert.deepEqual([...ui.calls.at(-1)[1].padBindings.A], ['PAD_B', 'PAD_LB']);
});

test('the tabs show one page at a time and mark it', async () => {
  const ui = await renderer();
  const sections = ['page-home', 'page-saves', 'changelog', 'page-settings'];
  const visible = () => sections.filter(id => !ui.elements.get(id).hidden);
  assert.deepEqual(visible(), ['page-home']);
  for (const [nav, section] of [['nav-saves', 'page-saves'], ['open-changelog', 'changelog'], ['settings-cog', 'page-settings'], ['nav-play', 'page-home']]) {
    await ui.click(nav);
    assert.deepEqual(visible(), [section]);
    assert.equal(ui.elements.get(nav).classList.contains('active'), true);
    assert.equal(ui.elements.get(nav)['aria-current'], 'page');
  }
  assert.equal(ui.elements.get('settings-cog').classList.contains('active'), false);
});

test('the launcher update channel is listed, saved with the others, and hidden for the portable launcher', async () => {
  const data = state(), ui = await renderer(data);
  await ui.click('settings-cog');
  await ui.click('tab-launcher');
  await new Promise(setImmediate);
  assert.equal(Boolean(ui.elements.get('update-channel-field').hidden), false);
  ui.elements.get('updateChannel').value = 'beta';
  ui.elements.get('updateChannel').dispatch('change');
  await new Promise(setImmediate);
  assert.equal(ui.calls.at(-1)[1].updateChannel, 'beta');
  const portable = state();
  portable.portable = true;
  assert.equal((await renderer(portable)).elements.get('update-channel-field').hidden, true);
});

test('a chosen game source shows under Play and on Manage game, and can be set back', async () => {
  const data = state();
  data.gameSource = { override: { port: { repository: 'https://example.invalid/fork.git', ref: 'fix' }, decomp: null }, version: 'custom abc1234' };
  const ui = await renderer(data);
  assert.equal(ui.elements.get('play-source').hidden, false);
  assert.match(ui.elements.get('play-source-detail').textContent, /fix · abc1234/);
  assert.equal(ui.elements.get('source-port-repository').value, 'https://example.invalid/fork.git');
  assert.match(ui.elements.get('game-source-note').textContent, /Building from custom abc1234/);
  await ui.click('reset-game-source');
  assert.deepEqual(ui.calls.at(-1), ['setGameSource', null]);
  assert.equal((await renderer()).elements.get('play-source').hidden, true);
});

test('the Renderer list is saved with the others, Vulkan by default', async () => {
  const data = state();
  data.platform = port.platformInfo('linux');
  data.config.settings = port.normalizeSettings({}, 'linux');
  const ui = await renderer(data);
  assert.equal(ui.elements.get('renderer-field').hidden, false);
  assert.equal(ui.elements.get('renderer').value, 'vulkan');
  ui.elements.get('renderer').value = 'opengl';
  ui.elements.get('renderer').dispatch('change');
  await new Promise(setImmediate);
  assert.equal(ui.calls.at(-1)[1].renderer, 'opengl');
});

test('Apple Silicon offers Metal, as its default, and says why; other systems do not list it', async () => {
  const mac = state();
  mac.platform = port.platformInfo('darwin', 'arm64');
  mac.config.settings = port.normalizeSettings({}, 'darwin', 'arm64');
  const ui = await renderer(mac);
  assert.equal(ui.elements.get('metal-renderer').hidden, false);
  assert.equal(ui.elements.get('renderer').value, 'metal');
  assert.match(ui.elements.get('renderer-note').textContent, /Metal/);
  const linux = state();
  linux.platform = port.platformInfo('linux');
  linux.config.settings = port.normalizeSettings({}, 'linux');
  const other = await renderer(linux);
  assert.equal(other.elements.get('metal-renderer').hidden, true);
  assert.doesNotMatch(other.elements.get('renderer-note').textContent, /Metal/);
  const intel = state();
  intel.platform = port.platformInfo('darwin', 'x64');
  intel.config.settings = port.normalizeSettings({}, 'darwin', 'x64');
  const intelUi = await renderer(intel);
  assert.equal(intelUi.elements.get('metal-renderer').hidden, true);
  assert.equal(intelUi.elements.get('renderer').value, 'vulkan');
});

test('setup says where the build tools download, which is not the install location', async () => {
  const folder = 'C:\\Users\\Player\\AppData\\Roaming\\colosseum-launcher\\build-tools';
  // Windows, as in the report: the note must not depend on the computer running the test (a Mac without Apple's tools says that instead)
  const fresh = { ...state(), platform: port.platformInfo('win32'), repoReady: false, binaryReady: false, tools: { ready: false }, toolsFolder: folder,
    config: { ...state().config, completedSetup: false } };
  const ui = await renderer(fresh);
  assert.equal(ui.elements.get('tool-location-note').textContent,
    `Build tools (a few GB) download to ${folder}, not to the install location.`);
  const portable = await renderer({ ...fresh, portable: true });
  assert.match(portable.elements.get('tool-location-note').textContent, /Colosseum-Launcher-Portable folder/);
});

test('Manage game offers Remove build tools on Windows once the game is built, and nowhere else', async () => {
  const windows = { ...state(), platform: port.platformInfo('win32') };
  const ui = await renderer(windows);
  assert.equal(ui.elements.get('build-tools-row').hidden, false);
  assert.match(ui.elements.get('build-tools-note').textContent, /plays without them/);
  await ui.click('remove-build-tools');
  assert.ok(ui.calls.includes('removeBuildTools'));
  for (const patch of [{ tools: { ready: false, mode: 'missing' } }, { binaryReady: false }, { active: { label: 'Build Pokémon Colosseum' } }]) {
    const busy = await renderer({ ...windows, ...patch });
    assert.equal(busy.elements.get('remove-build-tools').disabled, true);
  }
  const removed = await renderer({ ...windows, tools: { ready: false, mode: 'missing' } });
  assert.match(removed.elements.get('build-tools-note').textContent, /^Not downloaded/);
  const own = await renderer({ ...windows, tools: { ready: true, mode: 'own' } });
  assert.equal(own.elements.get('build-tools-row').hidden, true);
  for (const id of ['linux', 'darwin']) {
    const other = await renderer({ ...state(), platform: port.platformInfo(id) });
    assert.equal(other.elements.get('build-tools-row').hidden, true);
  }
});

test('the window button maximizes and restores the launcher, and F11 switches full screen', async () => {
  const ui = await renderer();
  const button = ui.elements.get('window-maximize');
  assert.equal(button['data-state'], 'normal');
  await ui.click('window-maximize');
  assert.deepEqual(ui.calls.filter(call => call === 'toggleMaximize'), ['toggleMaximize']);
  assert.equal(button['data-state'], 'maximized');
  assert.equal(button['aria-label'], 'Restore down');
  await ui.click('window-maximize');
  assert.equal(button['data-state'], 'normal');
  assert.equal(button['aria-label'], 'Maximize window');
  assert.ok(!ui.calls.includes('toggleFullScreen'));
  const press = key => {
    const event = { key, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    for (const callback of ui.listeners.window.keydown) callback(event);
    return event;
  };
  assert.equal(press('a').defaultPrevented, false);
  assert.equal(press('F11').defaultPrevented, true);
  await new Promise(setImmediate);
  assert.ok(ui.calls.includes('toggleFullScreen'));
  assert.equal(button['data-state'], 'fullscreen');
  assert.equal(button['aria-label'], 'Exit full screen');
});

test('choosing XD on the Play page names it, asks for its disc, and hides what only Colosseum has', async () => {
  const data = { ...state(), currentGame: games.summary('colosseum'), game: { ...state().game, needsUpdate: false } };
  const ui = await renderer(data);
  const off = id => ui.elements.get(id).classList.contains('feature-off');
  assert.equal(ui.elements.get('home-title').textContent, 'Pokémon Colosseum');
  assert.equal(ui.elements.get('game-colosseum')['aria-pressed'], 'true');
  assert.deepEqual(['nav-pokedex', 'nav-jukebox', 'nav-online', 'tab-gba', 'promptPad-field'].filter(off), []);
  await ui.click('game-xd');
  assert.deepEqual(ui.calls.filter(call => call[0] === 'selectGame'), [['selectGame', 'xd']]);
  assert.equal(ui.elements.get('game-xd')['aria-pressed'], 'true');
  assert.equal(ui.elements.get('game-colosseum')['aria-pressed'], 'false');
  assert.equal(ui.elements.get('home-title').textContent, 'Pokémon XD: Gale of Darkness');
  assert.match(ui.elements.get('setup-disc-description').textContent, /North American Pokémon XD: Gale of Darkness disc \(GXXE01\)/);
  assert.deepEqual(['tab-gba', 'texture-info'].filter(id => !off(id)), []);
  assert.deepEqual(['nav-pokedex', 'nav-jukebox'].filter(off), [], 'XD\'s Pokédex and Jukebox read its own disc');
  assert.equal(off('promptPad-field'), false, 'XD has quick moves');
  assert.equal(ui.elements.get('choose-starters-title').textContent, 'Choose starter', 'XD\'s starter is one Eevee');
  // the randomizer, as XD has it: one Eevee, its trades and Mt. Battle's gifts, and no packs' own Pokémon
  assert.equal(ui.elements.get('randomizer-starters-title').textContent, 'Starter');
  assert.match(ui.elements.get('randomizer-starters-note').textContent, /instead of Eevee/);
  assert.match(ui.elements.get('randomizer-gifts-note').textContent, /Chikorita, Cyndaquil and Totodile/);
  assert.equal(ui.elements.get('randomizer-packs-row').hidden, true);
  assert.equal(off('nav-online'), false, 'XD has online battles');
  assert.equal(off('dolphin-save-drop'), false, 'XD saves go to and from Dolphin too');
  // the renderer's, display and input settings stay
  assert.equal(off('renderer-field'), false);
  await ui.click('game-colosseum');
  assert.equal(off('nav-online'), false);
  assert.equal(ui.elements.get('randomizer-packs-row').hidden, false);
});

// The Play page's two games: the art split by a diagonal (style.css #game-art), the chosen game's side the larger.
test('the split follows the chosen game: the line moves at once, and a failure puts it back', async () => {
  const data = { ...state(), currentGame: games.summary('colosseum'), game: { ...state().game, needsUpdate: false } };
  const ui = await renderer(data);
  const art = ui.elements.get('game-art'), pressed = id => ui.elements.get(`game-${id}`)['aria-pressed'];
  assert.equal(art.dataset.active, 'colosseum');
  assert.deepEqual([pressed('colosseum'), pressed('xd')], ['true', 'false']);
  // the line moves before the launcher has switched
  let finish;
  ui.window.colo.selectGame = id => new Promise(resolve => { finish = () => { data.currentGame = games.summary(id); resolve(data); }; });
  ui.elements.get('game-xd').click();
  assert.equal(art.dataset.active, 'xd');
  assert.deepEqual([pressed('colosseum'), pressed('xd')], ['false', 'true']);
  // a refresh meanwhile doesn't move it back
  await ui.refresh();
  assert.equal(art.dataset.active, 'xd');
  finish();
  await new Promise(setImmediate); await new Promise(setImmediate);
  assert.equal(art.dataset.active, 'xd');
  assert.equal(ui.elements.get('home-title').textContent, 'Pokémon XD: Gale of Darkness');
  // a game that couldn't be chosen: the line goes back to the one that is
  ui.window.colo.selectGame = async () => { throw new Error('Wait for the current task to finish.'); };
  await ui.click('game-colosseum');
  await new Promise(setImmediate);
  assert.equal(art.dataset.active, 'xd');
  assert.deepEqual([pressed('colosseum'), pressed('xd')], ['false', 'true']);
  assert.match(ui.elements.get('message-text').textContent, /Wait for the current task/);
});

test('clicking the other game\'s side of the art chooses it, on the Play page only, and not while a task runs', async () => {
  const data = { ...state(), currentGame: games.summary('colosseum'), game: { ...state().game, needsUpdate: false } };
  const ui = await renderer(data);
  const chosen = () => ui.calls.filter(call => call[0] === 'selectGame').map(call => call[1]);
  // the chosen side does nothing
  await ui.click('game-art-colosseum');
  assert.deepEqual(chosen(), []);
  // nor the other while another page shows
  await ui.click('nav-saves');
  await ui.click('game-art-xd');
  assert.deepEqual(chosen(), []);
  await ui.click('nav-play');
  await ui.click('game-art-xd');
  assert.deepEqual(chosen(), ['xd']);
  assert.equal(ui.elements.get('game-art').dataset.active, 'xd');
  // a task running: the buttons and the art are locked
  data.active = { label: 'Update game', startedAt: Date.now() };
  await ui.refresh();
  assert.equal(ui.elements.get('game-colosseum').disabled, true);
  assert.equal(ui.elements.get('game-art').classList.contains('locked'), true);
  await ui.click('game-art-colosseum');
  assert.deepEqual(chosen(), ['xd']);
  data.active = null;
  await ui.refresh();
  assert.equal(ui.elements.get('game-art').classList.contains('locked'), false);
  await ui.click('game-art-colosseum');
  assert.deepEqual(chosen(), ['xd', 'colosseum']);
});

test('a controller\'s X switches between the games on the Play page', async () => {
  const data = { ...state(), currentGame: games.summary('colosseum'), game: { ...state().game, needsUpdate: false } };
  const ui = await renderer(data);
  const chosen = () => ui.calls.filter(call => call[0] === 'selectGame').map(call => call[1]);
  ui.gamepad.actions.alternate();
  await new Promise(setImmediate); await new Promise(setImmediate);
  assert.deepEqual(chosen(), ['xd']);
  ui.gamepad.actions.alternate();
  await new Promise(setImmediate); await new Promise(setImmediate);
  assert.deepEqual(chosen(), ['xd', 'colosseum']);
  // elsewhere it does nothing
  await ui.click('settings-cog');
  ui.gamepad.actions.alternate();
  await new Promise(setImmediate);
  assert.deepEqual(chosen(), ['xd', 'colosseum']);
});

test('XD\'s later generations explain where they come from, and need Colosseum\'s disc', async () => {
  const data = { ...state(), currentGame: games.summary('colosseum'), teamDiscReady: true, game: { ...state().game, needsUpdate: false } };
  const ui = await renderer(data);
  const text = id => ui.elements.get(id).textContent, off = id => ui.elements.get(id).classList.contains('feature-off');
  assert.equal(text('battle-rules-gen3'), 'Colosseum (Gen 3)');
  assert.match(text('battle-rules-note'), /chosen under Rules on the Online page/);
  assert.match(text('generation4-note'), /Battle Revolution disc/);
  assert.equal(ui.elements.get('generations-disc-note').hidden, true);
  assert.equal(off('pbr-row'), false);
  data.teamDiscReady = false;
  await ui.click('game-xd');
  assert.equal(off('pbr-row'), false, 'Battle Revolution assets for XD\'s Gen 4 Pokémon too');
  assert.equal(text('battle-rules-gen3'), 'XD (Gen 3)');
  assert.match(text('battle-rules-note'), /XD's online battles play by Gen 3 rules for now/);
  assert.match(text('generation4-note'), /Battle Revolution disc; without it, a Pokémon of the game stands in/);
  assert.equal(ui.elements.get('generations-disc-note').hidden, false);
  assert.match(text('generations-disc-note'), /made from your Pokémon Colosseum disc/);
  data.teamDiscReady = true;
  await ui.refresh();
  assert.equal(ui.elements.get('generations-disc-note').hidden, true);
});

// Each game's logo from its disc (main.js gameLogos) at the top of its side, in place of its name.
test('a game\'s logo shows in place of its name once read, and a game without one keeps its name', async () => {
  const data = { ...state(), currentGame: games.summary('colosseum'), game: { ...state().game, needsUpdate: false } };
  data.config = { ...data.config, game: 'colosseum', rom: '/discs/colosseum.iso', games: { xd: { rom: '' } } };
  const ui = await renderer(data);
  const asked = [];
  ui.window.colo.gameLogos = async () => { asked.push(true); return { colosseum: 'data:image/png;base64,AAAA', xd: null }; };
  const shows = id => ({ logo: ui.elements.get(`game-${id}`).classList.contains('has-logo'), hidden: ui.elements.get(`game-logo-${id}`).hidden,
    src: ui.elements.get(`game-logo-${id}`).src || null });
  // no logo until the launcher has read one
  assert.deepEqual(shows('colosseum'), { logo: false, hidden: true, src: null});
  await ui.refresh();
  await new Promise(setImmediate);
  assert.equal(asked.length, 1);
  assert.deepEqual(shows('colosseum'), { logo: true, hidden: false, src: 'data:image/png;base64,AAAA'});
  assert.deepEqual(shows('xd'), { logo: false, hidden: true, src: null});
  // the same discs: not asked again
  await ui.refresh();
  await new Promise(setImmediate);
  assert.equal(asked.length, 1);
  // XD's disc chosen: asked again, and its logo shows
  ui.window.colo.gameLogos = async () => { asked.push(true); return { colosseum: 'data:image/png;base64,AAAA', xd: 'data:image/png;base64,BBBB' }; };
  data.config = { ...data.config, games: { xd: { rom: '/discs/xd.iso' } } };
  await ui.refresh();
  await new Promise(setImmediate);
  assert.equal(asked.length, 2);
  assert.equal(shows('xd').logo, true);
  assert.equal(shows('xd').src, 'data:image/png;base64,BBBB');
  // a disc gone or unreadable: its name again
  ui.window.colo.gameLogos = async () => ({ colosseum: null, xd: 'javascript:alert(1)' });
  data.config = { ...data.config, rom: '' };
  await ui.refresh();
  await new Promise(setImmediate);
  assert.deepEqual([shows('colosseum').logo, shows('xd').logo], [false, false]);
  assert.equal(shows('xd').src, null);
  // the buttons keep their names for screen readers, and the logos add none of their own
  const html = fs.readFileSync(path.resolve(__dirname, '../src/index.html'), 'utf8');
  assert.match(html, /id="game-colosseum"[^>]*aria-label="Pokémon Colosseum"/);
  assert.match(html, /id="game-xd"[^>]*aria-label="Pokémon XD: Gale of Darkness"/);
  assert.match(html, /<img id="game-logo-xd" class="game-tab-logo" alt="" hidden>/);
});

test('ready to play, the headline\'s game name is left to the logo above, for screen readers only', async () => {
  const ready = { ...state(), currentGame: games.summary('colosseum'), game: { ...state().game, needsUpdate: false } };
  const ui = await renderer(ready);
  assert.equal(ui.elements.get('home-title').classList.contains('visually-hidden'), true);
  assert.equal(ui.elements.get('home-title').textContent, 'Pokémon Colosseum');
  const setup = await renderer({ ...state(), repoReady: false, binaryReady: false, config: { ...state().config, completedSetup: false } });
  assert.equal(setup.elements.get('home-title').classList.contains('visually-hidden'), false);
  assert.equal(setup.elements.get('home-title').textContent, 'Set up your game');
});

// The Play page's logos (play-stage.js) as laid out in a window of 1080x760: each element's box follows the places the
// renderer gives it, and its tweens are recorded.
function stageWindow(ui) {
  const animations = [], el = id => ui.elements.get(id), vars = new Map();
  const box = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height });
  const at = (id, name) => parseFloat(vars.get(id)?.[name]) || 0;
  for (const [id, node] of ui.elements) {
    node.style = { setProperty(name, value) { vars.set(id, { ...vars.get(id), [name]: value }); } };
    node.animate = (frames, timing) => { const animation = { id, frames, timing, playState: 'running', currentTime: 0,
      effect: { getComputedTiming: () => ({ progress: 0 }) }, cancel() { this.playState = 'idle'; } }; animations.push(animation); return animation; };
  }
  const chosen = () => el('game-art').dataset.active, panel = () => el('page-home').classList.contains('has-panel');
  const rects = {
    shell: () => box(0, 0, 1080, 760), 'page-home': () => box(28, 129, 1024, 600), 'game-picker': () => box(0, 129, 1080, 0),
    'launch-panel': () => panel() ? box(chosen() === 'xd' ? 418 : 42, 623, 620, 89) : box(250, 616, 580, 96),
    'setup-flow': () => panel() ? box(chosen() === 'xd' ? 418 : 28, 349, 634, 250) : box(0, 0, 0, 0),
    'home-headline': () => box(28 + at('home-headline', '--x') - 70, 129 + (panel() ? 230 : at('home-headline', '--top')), 140, 24),
    'add-to-steam': () => box(0, 0, 0, 0)
  };
  for (const id of ['colosseum', 'xd']) {
    const w = () => at(`game-${id}`, '--w'), x = () => at(`game-${id}`, '--x'), y = () => 129 + at(`game-${id}`, '--y');
    rects[`game-mark-${id}`] = () => box(x() - w() / 2, y(), w(), w() / 2.4);
    rects[`game-state-${id}`] = () => box(x() - 45, y() + w() / 2.4 + 6, 90, 24);
  }
  for (const [id, rect] of Object.entries(rects)) el(id).getBoundingClientRect = rect;
  el('page-home').parentElement = { getBoundingClientRect: () => box(0, 105, 1080, 619), scrollTop: 0 };
  el('home-headline').offsetHeight = 24;
  ui.window.getComputedStyle = () => ({ paddingTop: panel() ? '108px' : '0px' });
  return { animations, vars: id => vars.get(id) || {}, width: id => at(`game-${id}`, '--w'), top: id => at(`game-${id}`, '--y') };
}

test('the Play page knows when a panel is over the art: setting up has one, ready to play has none', async () => {
  const ready = await renderer({ ...state(), currentGame: games.summary('colosseum'), game: { ...state().game, needsUpdate: false } });
  assert.equal(ready.elements.get('page-home').classList.contains('has-panel'), false);
  assert.equal(ready.elements.get('page-home').classList.contains('ready-mode'), true);
  const setup = await renderer({ ...state(), repoReady: false, binaryReady: false, config: { ...state().config, completedSetup: false } });
  assert.equal(setup.elements.get('page-home').classList.contains('has-panel'), true);
  assert.equal(setup.elements.get('setup-flow').hidden, false);
  // the logos are placed once the page can be measured, and shown only then
  assert.equal(setup.elements.get('page-home').classList.contains('stage-placed'), false);
  stageWindow(setup);
  await setup.refresh();
  assert.equal(setup.elements.get('page-home').classList.contains('stage-placed'), true);
});

test('ready to play, both logos are large and centred; a panel puts the chosen one small at the top', async () => {
  const data = { ...state(), currentGame: games.summary('colosseum'), game: { ...state().game, needsUpdate: false } };
  const ui = await renderer(data), stage = stageWindow(ui);
  await ui.refresh();
  assert.ok(stage.width('colosseum') > 400 && stage.width('xd') > 240, `${stage.width('colosseum')} and ${stage.width('xd')} wide`);
  assert.ok(stage.top('colosseum') > 100, 'the chosen logo is down in the middle');
  assert.ok(Number.parseFloat(stage.vars('home-headline')['--top']) > stage.top('colosseum'), 'with the headline under it');
  Object.assign(data, { repoReady: false, binaryReady: false, config: { ...data.config, completedSetup: false } });
  await ui.refresh();
  assert.ok(stage.top('colosseum') < 10 && stage.width('colosseum') < 200, 'setting up, it is small at the top');
  assert.ok(stage.width('xd') > 240, 'the other game\'s stays large');
});

test('switching games tweens the logos, their Switch and the headline with the line\'s time and easing', async () => {
  const data = { ...state(), currentGame: games.summary('colosseum'), game: { ...state().game, needsUpdate: false } };
  const ui = await renderer(data), stage = stageWindow(ui);
  await ui.refresh();
  const before = { colosseum: stage.width('colosseum'), xd: stage.width('xd') };
  await ui.click('game-xd');
  const moved = new Set(stage.animations.map(animation => animation.id));
  for (const id of ['game-mark-colosseum', 'game-mark-xd', 'game-state-colosseum', 'game-state-xd', 'home-headline']) assert.ok(moved.has(id), `${id} tweens`);
  // XD's logo grows into the middle and Colosseum's shrinks into its strip: each starts at its old size
  assert.ok(stage.width('xd') > before.xd && stage.width('colosseum') < before.colosseum);
  const grow = stage.animations.find(animation => animation.id === 'game-mark-xd');
  const scale = Number(/scale\(([\d.]+)\)/.exec(grow.frames[0].transform)[1]);
  assert.ok(Math.abs(scale - before.xd / stage.width('xd')) < 0.01, `XD's logo starts at ${scale} of its new size`);
  assert.equal(grow.frames[1].transform, 'none');
  // the Switch and the headline slide without scaling
  assert.match(stage.animations.find(animation => animation.id === 'game-state-xd').frames[0].transform, /scale\(1\)$/);
  // the same time and easing as the line's transition in style.css
  const css = fs.readFileSync(path.resolve(__dirname, '../src/style.css'), 'utf8');
  const tween = /--tween: (\.\d+)s (cubic-bezier\([^)]+\))/.exec(css);
  for (const animation of stage.animations) assert.deepEqual({ ...animation.timing }, { duration: Number(tween[1]) * 1000, easing: tween[2] });
  assert.match(css, /\.shell \{[^}]*transition: --split var\(--tween\)/);
});

test('setup finishing tweens the chosen logo down to the middle; reduced motion puts everything in place at once', async () => {
  const data = { ...state(), repoReady: false, binaryReady: false, config: { ...state().config, completedSetup: false } };
  const ui = await renderer(data), stage = stageWindow(ui);
  await ui.refresh();
  const top = stage.top('colosseum');
  Object.assign(data, { repoReady: true, binaryReady: true, config: { ...data.config, completedSetup: true }, game: { ...data.game, needsUpdate: false } });
  await ui.refresh();
  assert.equal(ui.elements.get('page-home').classList.contains('has-panel'), false);
  assert.ok(stage.top('colosseum') > top);
  assert.ok(stage.animations.some(animation => animation.id === 'game-mark-colosseum' && /translate\(-?[\d.]+px, -\d/.test(animation.frames[0].transform)),
    'Colosseum\'s logo starts from up at the top');
  // reduced motion: switching moves nothing by tween
  ui.window.matchMedia = query => ({ matches: /prefers-reduced-motion: reduce/.test(query) });
  const count = stage.animations.length;
  await ui.click('game-xd');
  assert.equal(stage.animations.length, count);
  assert.ok(stage.width('xd') > stage.width('colosseum'), 'XD\'s logo is large at once');
});

test('a panel coming in the middle of a switch keeps to the switch\'s time, as the line does', async () => {
  const data = { ...state(), currentGame: games.summary('colosseum'), game: { ...state().game, needsUpdate: false } };
  const ui = await renderer(data), stage = stageWindow(ui);
  await ui.refresh();
  // XD isn't set up: the launcher answers the switch with its setup steps, 300 ms into the tween
  ui.window.colo.selectGame = async id => { data.currentGame = games.summary(id); Object.assign(data, { repoReady: false, binaryReady: false });
    for (const animation of stage.animations) { animation.currentTime = 300; animation.effect.getComputedTiming = () => ({ progress: 0.4 }); } return data; };
  await ui.click('game-xd');
  await new Promise(setImmediate);
  assert.equal(ui.elements.get('page-home').classList.contains('has-panel'), true);
  const carried = stage.animations.filter(animation => animation.playState === 'running');
  assert.ok(carried.some(animation => animation.id === 'game-mark-xd'));
  for (const animation of carried) assert.equal(animation.currentTime, 300, `${animation.id} carries on from 300 ms`);
});
