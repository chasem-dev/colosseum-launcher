'use strict';

const $ = id => document.getElementById(id);
let current;
let changing = false;
let wizardStep = null;
// The failure of a game `--play` started, shown once when the launcher opens instead.
let directPlayShown = null;
let setupPending = false;
// The activity while a game runs: "Play Pokémon Colosseum", or "Play" and the other game's name (main.js playLabel).
const isGameLabel = label => typeof label === 'string' && label.startsWith('Play Pokémon ');
// The game chosen on the Play page (games.js summary), and whether it has one of the launcher's features. A state
// without one is Colosseum's, with everything.
const COLOSSEUM = { id: 'colosseum', name: 'Pokémon Colosseum', shortName: 'Colosseum', discId: 'GC6E01', features: null };
const chosenGame = data => data?.currentGame || COLOSSEUM;
const gameHas = (data, feature) => !chosenGame(data).features || chosenGame(data).features[feature] !== false;
const activityLog = window.coloActivityLog.createActivityLog();
let logRenderPending = false;
let consoleOpen = false, consoleExpanded = false, consoleFollowing = true;
let consoleWasActive = false, consoleFailed = false;

function closeModal() {
  for (const dialog of document.querySelectorAll('.launcher-modal'))
    if (dialog.open) dialog.close();
}

// --- Pages: the tabs along the top pick one; Play is the home page. Each page can run code as it shows and hides.
const pages = {
  play: { section: 'page-home', nav: 'nav-play' }, saves: { section: 'page-saves', nav: 'nav-saves' }, online: { section: 'page-online', nav: 'nav-online' }, pokedex: { section: 'page-pokedex', nav: 'nav-pokedex' }, jukebox: { section: 'page-jukebox', nav: 'nav-jukebox' },
  changelog: { section: 'changelog', nav: 'open-changelog' }, settings: { section: 'page-settings', nav: 'settings-cog' }
};
const pageOrder = Object.keys(pages);
let page = 'play';
const pageHooks = {};
function onPage(name, hooks) { pageHooks[name] = { ...pageHooks[name], ...hooks }; }
function showPage(name) {
  if (!pages[name]) return;
  if (name !== page && pageHooks[name]?.open?.() === false) return;
  const previous = page;
  if (name !== previous) {
    page = name;
    pageHooks[previous]?.hide?.();
  }
  for (const [key, item] of Object.entries(pages)) {
    $(item.section).hidden = key !== name;
    if (item.sub) continue;  // its tab is its parent page's
    const current = item.nav === pages[name].nav;
    $(item.nav).classList.toggle('active', current);
    if (current) $(item.nav).setAttribute('aria-current', 'page');
    else $(item.nav).removeAttribute('aria-current');
  }
  if (name !== previous) pageHooks[name]?.show?.();
  // An expanded log covers the page: picking one shrinks it back to the drawer.
  if (consoleExpanded) { consoleExpanded = false; setConsoleOpen(true); }
}
for (const [name, item] of Object.entries(pages)) if (!item.sub) $(item.nav).addEventListener('click', () => showPage(name));
// The Pokédex (pokedex-page.js) keeps nothing on the GPU while it isn't showing.
onPage('pokedex', { show: () => window.coloPokedex?.show(), hide: () => window.coloPokedex?.hide() });
// The Jukebox (jukebox-page.js) renders a song from the disc when it is played; its player stays under every page after that.
onPage('jukebox', { show: () => window.coloJukebox?.show(), hide: () => window.coloJukebox?.hide() });
// Online (online-page.js) asks for the room list only while it's showing.
onPage('online', { show: () => window.coloOnline?.show(), hide: () => window.coloOnline?.hide() });

// Settings is one page with a tab per section; it reopens on the last one shown.
const settingsTabs = ['gameplay', 'display', 'graphics', 'controls', 'gba', 'manage', 'launcher'];
let settingsTab = 'gameplay';
function showSettingsTab(name) {
  if (settingsTab === 'controls' && name !== 'controls') stopCapture();
  settingsTab = name;
  for (const tab of settingsTabs) {
    $(`pane-${tab}`).hidden = tab !== name;
    $(`tab-${tab}`).setAttribute('aria-selected', String(tab === name));
    $(`tab-${tab}`).classList.toggle('active', tab === name);
  }
  $('settings-panes').scrollTop = 0;
  if (name === 'controls') { renderBindings(); loadGcAdapter(); }
  if (name === 'launcher') loadUpdateChannels();
}
for (const tab of settingsTabs) $(`tab-${tab}`).addEventListener('click', () => showSettingsTab(tab));
onPage('settings', {
  show() {
    showSettingsTab(settingsTab);
    $(`tab-${settingsTab}`).focus();
  },
  hide: () => stopCapture()
});

// --- Controls: key and controller bindings (src/bindings.js). keyBindings and padBindings hold only the
// controls the player changed.
let keyBindings = {};
let padBindings = {};
let bindingMode = 'keyboard';  // which kind the Controls page shows: 'keyboard' or 'controller'
let capture = null;  // { id, add } while waiting for a key or a controller button
let padPoll = 0;

function renderRange(key, off) {
  const value = Number($(key).value);
  $(`${key}-value`).textContent = off && !value ? off : `${value}%`;
}
for (const key of ['stickDeadzone', 'triggerClick']) {
  $(key).addEventListener('input', () => renderRange(key));
  $(key).addEventListener('change', () => saveSettings());
}
$('rumbleStrength').addEventListener('input', () => renderRange('rumbleStrength', 'Off'));
$('rumbleStrength').addEventListener('change', () => saveSettings());
$('gbaVolume').addEventListener('input', () => renderRange('gbaVolume', 'Off'));
$('gbaVolume').addEventListener('change', () => saveSettings());

// Settings → Game Boy Advance: each socket's Gen 3 save (src/gen3-save.js reads it), and, under Advanced,
// the Game Pak it belongs to and a BIOS, for running the GBA itself (src/gba.js checks them).
const GBA_SOCKETS = ['2', '3', '4'];
let gbaFound = null, gbaLooking = false, gbaBusy = false;
async function gbaAction(call) {
  setMessage('');
  try {
    const result = await call();
    if (result && result.config) refresh(result);
  } catch (error) { showError(error); }
}
function gbaNote(id, item) {
  const text = item?.error || item?.warning || '';
  $(id).textContent = text;
  $(id).hidden = !text;
  $(id).classList.toggle('rom-error', Boolean(item?.error));
}
function gbaElement(tag, className, text) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text !== undefined) item.textContent = text;
  return item;
}
function gbaButton(actions, label, call) {
  const item = gbaElement('button', 'subtle', label);
  item.disabled = gbaBusy;
  item.addEventListener('click', () => gbaAction(call));
  actions.append(item);
}
// "ASH's Emerald: 6 Pokémon, 12:34 played"
function gbaSaveName(save) {
  const party = save.party.length === 1 ? '1 Pokémon' : `${save.party.length} Pokémon`;
  return `${save.trainer || 'Trainer'}'s ${save.gameName}: ${party}, ${save.playTime} played`;
}
function gbaSaveRow(socket, entry) {
  const row = gbaElement('div', 'path-row gba-socket');
  const text = gbaElement('div');
  const save = entry?.save;
  const label = socket === '2' ? 'Your save' : `Save on socket ${socket}`;
  text.append(gbaElement('strong', '', save && !save.error ? `${label}: ${gbaSaveName(save)}` : label));
  const file = gbaElement('span', 'small-path', save ? save.path : 'None chosen');
  file.title = save?.path || '';
  text.append(file);
  const problem = save?.error || save?.problem || '';
  if (problem) text.append(gbaElement('span', `small-path gba-note${save.error ? ' rom-error' : ''}`, problem));
  const actions = gbaElement('div', 'actions');
  if (save) gbaButton(actions, 'Remove', () => window.colo.clearGbaFile('save', socket));
  gbaButton(actions, save ? 'Change save' : 'Choose save', () => window.colo.chooseGbaFile('save', socket));
  row.append(text, actions);
  return row;
}
function gbaPakRow(socket, entry) {
  const row = gbaElement('div', 'path-row gba-socket');
  const text = gbaElement('div');
  const rom = entry?.rom;
  text.append(gbaElement('strong', '', `Socket ${socket} Game Pak${rom ? `: ${rom.name || 'Not usable'}` : ''}`));
  text.append(gbaElement('span', 'small-path', rom ? rom.path : entry ? 'None: the game answers from the save' : socket === '2' ? 'Choose your save above first' : 'Choose a save for this socket first'));
  if (rom && (rom.error || rom.warning)) text.append(gbaElement('span', `small-path gba-note${rom.error ? ' rom-error' : ''}`, rom.error || rom.warning));
  const actions = gbaElement('div', 'actions');
  if (rom) gbaButton(actions, 'Remove', () => window.colo.clearGbaFile('rom', socket));
  if (entry) gbaButton(actions, rom ? 'Change Game Pak' : 'Choose Game Pak', () => window.colo.chooseGbaFile('rom', socket));
  else if (socket !== '2') gbaButton(actions, 'Choose save', () => window.colo.chooseGbaFile('save', socket));
  row.append(text, actions);
  return row;
}
// Saves found where emulators keep them, offered while socket 2 has none.
function renderGbaFound(gba) {
  const box = $('gba-found');
  const chosen = new Set(Object.values(gba.sockets).map(entry => entry.save?.path));
  const found = (gbaFound || []).filter(item => !chosen.has(item.path)).slice(0, 5);
  box.hidden = Boolean(gba.sockets['2']) || (!gbaLooking && !found.length);
  if (box.hidden) return;
  const rows = [gbaElement('p', 'helper', gbaLooking ? 'Looking for saves on this computer…' : 'Found on this computer:')];
  for (const item of found) {
    const row = gbaElement('div', 'path-row');
    const text = gbaElement('div');
    text.append(gbaElement('strong', '', `${item.trainer || 'Trainer'}'s ${item.gameName}: ${item.party === 1 ? '1 Pokémon' : `${item.party} Pokémon`}, ${item.playTime} played`));
    const file = gbaElement('span', 'small-path', item.path);
    file.title = item.path;
    text.append(file);
    if (item.problem) text.append(gbaElement('span', 'small-path gba-note', item.problem));
    const actions = gbaElement('div', 'actions');
    gbaButton(actions, 'Use this save', () => window.colo.useGbaSave('2', item.path));
    row.append(text, actions);
    rows.push(row);
  }
  box.replaceChildren(...rows);
}
async function lookForGbaSaves(gba) {
  if (gbaFound || gbaLooking || !window.colo.gbaSuggestions) return;
  gbaLooking = true;
  renderGbaFound(gba);
  try { gbaFound = await window.colo.gbaSuggestions(); } catch (_) { gbaFound = []; }
  gbaLooking = false;
  renderGbaFound(lastGba);
}
let lastGba = { bios: null, sockets: {}, ready: false };
function renderGba(data) {
  const gba = data.gba || { bios: null, sockets: {}, ready: false };
  lastGba = gba;
  gbaBusy = Boolean(data.active);
  $('gba-bios-path').textContent = gba.bios ? `${gba.bios.name || 'Not usable'}: ${gba.bios.path}` : "None: mGBA's own BIOS starts the GBA.";
  $('gba-bios-path').title = gba.bios?.path || '';
  gbaNote('gba-bios-note', gba.bios);
  $('gba-bios-choose').textContent = gba.bios ? 'Change file' : 'Choose file';
  $('gba-bios-clear').hidden = !gba.bios;
  for (const id of ['gba-bios-choose', 'gba-bios-clear']) $(id).disabled = gbaBusy;
  $('gba-backups-path').textContent = gba.backupFolder || '';
  $('gba-backups-path').title = gba.backupFolder || '';
  // socket 2 always; 3 and 4 once they have a save, or under Advanced to add one
  const extra = GBA_SOCKETS.slice(1).filter(socket => gba.sockets[socket]);
  $('gba-save').replaceChildren(gbaSaveRow('2', gba.sockets['2']), ...extra.map(socket => gbaSaveRow(socket, gba.sockets[socket])));
  $('gba-paks').replaceChildren(...GBA_SOCKETS.map(socket => gbaPakRow(socket, gba.sockets[socket])));
  renderGbaFound(gba);
  if (!gba.sockets['2']) lookForGbaSaves(gba);
  const usable = Object.entries(gba.sockets).filter(([, entry]) => !entry.save.error && !entry.rom?.error);
  const problem = usable.map(([, entry]) => entry.save.problem).find(Boolean);
  $('gba-status').textContent = !gba.ready
    ? (Object.keys(gba.sockets).length ? 'This save can\'t be used: choose another.' : 'Choose your save to link a GBA. Until then the game sees no GBA, as with no cable.')
    : problem ? `The game will see your GBA, but won't link yet. ${problem}`
      : usable.some(([, entry]) => entry.rom) ? 'Ready: when the game asks for a Game Boy Advance, it starts with your Game Pak and save.'
        : 'Ready: when the game asks for a Game Boy Advance, it links with your save.';
}
$('gba-bios-choose').addEventListener('click', () => gbaAction(() => window.colo.chooseGbaFile('bios')));
$('gba-bios-clear').addEventListener('click', () => gbaAction(() => window.colo.clearGbaFile('bios')));
$('gba-backups-open').addEventListener('click', () => gbaAction(() => window.colo.openGbaBackups()));

function bindingNote() {
  return bindingMode === 'controller'
    ? 'Choose Change, then press a button on your controller, or hold two together, or pick the button from the list. Esc cancels. The sticks always move the sticks.'
    : 'Choose Change, then press a key. Esc cancels.';
}

// Whether the launcher sees a controller. Chromium shows one only after a button is pressed on it, and some
// it never shows (a Switch Pro Controller can be one), though the game reads them.
function padsSeen() { return [...(navigator.getGamepads ? navigator.getGamepads() : [])].some(Boolean); }

function stopCapture() {
  if (!capture) return;
  capture = null;
  window.removeEventListener('keydown', captureKey, true);
  cancelAnimationFrame(padPoll);
  $('binding-note').textContent = bindingNote();
  renderBindings();
}

// The buttons held right now on every connected controller (standard mapping), as "pad:index".
function heldPadButtons() {
  const held = new Set();
  for (const pad of (navigator.getGamepads ? navigator.getGamepads() : []))
    if (pad) pad.buttons.forEach((button, index) => {
      if (button.pressed || button.value > 0.6) held.add(`${pad.index}:${index}`);
    });
  return held;
}

// Waits for newly pressed controller buttons (ones already held when capture began do not count): two held
// together make a two-button binding (LB + LT), and one let go on its own is a binding by itself.
function watchPad(baseline, chord = []) {
  if (!capture) return;
  const held = heldPadButtons();
  for (const entry of held) {
    if (baseline.has(entry) || chord.some(item => item.entry === entry)) continue;
    const pad = ColoBindings.padFromIndex(Number(entry.split(':')[1]));
    if (pad) chord.push({ entry, pad });
  }
  const done = chord.length >= 2 || (chord.length === 1 && !held.has(chord[0].entry));
  if (done) {
    bindPad(chord.length >= 2 ? ColoBindings.padCombo(chord[0].pad, chord[1].pad) : chord[0].pad);
    return;
  }
  if (chord.length && capture) $('binding-note').textContent = `${ColoBindings.padLabel(chord[0].pad)}: let go, or press another button with it.`;
  for (const entry of [...baseline]) if (!held.has(entry)) baseline.delete(entry);  // released: may count when pressed again
  padPoll = requestAnimationFrame(() => watchPad(baseline, chord));
}

function captureKey(event) {
  // The controller button list takes its own keys (arrows, Enter); Esc still cancels.
  if (event.target?.classList?.contains('pad-choice') && event.code !== 'Escape') return;
  event.preventDefault();
  event.stopPropagation();
  if (event.repeat) return;
  if (event.code === 'Escape' && !event.shiftKey) { stopCapture(); return; }
  if (bindingMode === 'controller') return;  // waiting for a controller button
  const key = ColoBindings.keyFromCode(event.code);
  if (!key) { $('binding-note').textContent = 'The game cannot read that key. Try another, or Esc to cancel.'; return; }
  bindKey(key);
}

function bindKey(key) {
  const { id, add } = capture;
  const keys = add ? [...ColoBindings.keysFor(keyBindings, id).filter(item => item !== key), key] : [key];
  keyBindings = ColoBindings.normalize({ ...keyBindings, [id]: keys });
  stopCapture();
  saveSettings();
}

function bindPad(pad) {
  const { id, add } = capture;
  const pads = add ? [...ColoBindings.padsFor(padBindings, id).filter(item => item !== pad), pad] : [pad];
  padBindings = ColoBindings.normalizePads({ ...padBindings, [id]: pads });
  stopCapture();
  saveSettings();
}

// The controller's buttons to pick from while waiting for one, for a controller the launcher can't see.
function padChoice() {
  const list = document.createElement('select');
  list.className = 'pad-choice';
  list.setAttribute('aria-label', 'Controller button');
  const option = (value, text) => {
    const item = document.createElement('option'); item.value = value; item.textContent = text; return item;
  };
  list.append(option('', 'or choose…'), ...ColoBindings.PAD_BUTTONS.map(button => option(button.id, button.label)));
  list.addEventListener('change', () => { if (list.value) bindPad(list.value); });
  return list;
}

function startCapture(id, add) {
  stopCapture();
  capture = { id, add };
  window.addEventListener('keydown', captureKey, true);
  if (bindingMode === 'controller') {
    if (!padsSeen())
      $('binding-note').textContent = 'No controller found yet. Press any button on it, or pick the button from the list. Esc cancels.';
    watchPad(heldPadButtons());
  }
  renderBindings();
}

// --- Button prompts (src/prompts.js): the buttons Quick moves shows beside each move, drawn from the bindings
// above. The strips go to the launcher's prompts folder whenever what they show changes.
function promptOptions(styles) {
  return styles.map(({ id, label }) => {
    const option = document.createElement('option'); option.value = id; option.textContent = label; return option;
  });
}
if (globalThis.ColoPrompts) {
  $('buttonPrompts').replaceChildren(...promptOptions(ColoPrompts.STYLES));
  $('promptPad').replaceChildren(...promptOptions(ColoPrompts.PAD_STYLES));
}
let sentPrompts = '';
function renderPrompts() {
  if (!globalThis.ColoPrompts) return;
  const style = $('buttonPrompts').value;
  const strips = Object.fromEntries(ColoPrompts.DRAWN.map(id => [id, ColoPrompts.drawStrip(document, id, keyBindings, padBindings, {}, 4)]));
  const pad = $('promptPad').value;
  // Automatic shows the keyboard and every controller style it can switch to.
  const label = id => ColoPrompts.STYLES.find(item => item.id === id).label;
  const padRows = pad === 'match' ? ['xbox', 'playstation', 'steamdeck', 'nintendo'] : [pad];
  const shown = style === 'auto'
    ? [['keyboard', 'Keyboard'], ...padRows.map(id => [id, pad === 'match' ? `${label(id)} controller` : 'Any controller'])]
    : [[style, label(style)]];
  $('prompt-preview').replaceChildren(...shown.map(([id, text]) => {
    const row = document.createElement('div'); row.className = 'prompt-row';
    const name = document.createElement('span'); name.textContent = text;
    const image = document.createElement('img'); image.src = strips[id].toDataURL('image/png'); image.alt = '';
    row.append(name, image);
    return row;
  }));
  const images = Object.fromEntries(ColoPrompts.DRAWN.map(id => [id, ColoPrompts.drawStrip(document, id, keyBindings, padBindings).toDataURL('image/png')]));
  const signature = JSON.stringify(images);
  if (signature === sentPrompts) return;
  sentPrompts = signature;
  window.colo.savePrompts(images).catch(error => { sentPrompts = ''; showError(error); });
}

function renderBindings() {
  renderPrompts();
  if (!globalThis.ColoBindings || $('pane-controls').hidden) return;
  const controller = bindingMode === 'controller';
  for (const button of document.querySelectorAll('[data-binding-mode]'))
    button.setAttribute('aria-pressed', String(button.dataset.bindingMode === bindingMode));
  const changed = controller ? padBindings : keyBindings;
  $('binding-list').replaceChildren(...ColoBindings.CONTROLS.map(({ id, label }) => {
    const row = document.createElement('div');
    row.className = `binding-row${changed[id] ? ' changed' : ''}${capture?.id === id ? ' capturing' : ''}`;
    const name = document.createElement('span'); name.textContent = label;
    const keys = document.createElement('span'); keys.className = 'binding-keys';
    const what = controller ? 'button' : 'key';
    const items = controller ? ColoBindings.padsFor(padBindings, id).map(ColoBindings.padLabel)
      : ColoBindings.keysFor(keyBindings, id).map(ColoBindings.keyLabel);
    const press = controller ? 'a button' : 'a key';
    if (capture?.id === id) {
      keys.textContent = controller && !padsSeen() ? 'No controller seen yet: press a button on it…'
        : capture.add ? `Press ${press} to add…` : controller ? 'Press a button, or two together…' : `Press ${press}…`;
      if (controller) keys.append(padChoice());
    } else if (!items.length) { keys.textContent = 'None'; keys.classList.add('binding-none'); }
    else keys.replaceChildren(...items.map(text => {
      const item = document.createElement('kbd'); item.textContent = text; return item;
    }));
    const actions = document.createElement('span'); actions.className = 'binding-actions';
    const button = (text, onClick, title) => {
      const item = document.createElement('button'); item.className = 'subtle'; item.textContent = text; item.title = title;
      item.disabled = Boolean(current?.active); item.addEventListener('click', onClick); return item;
    };
    actions.append(button('Change', () => startCapture(id, false), `Use one ${what} instead`),
      button('Add', () => startCapture(id, true), `Add another ${what}`));
    if (changed[id]) actions.append(button('Reset', () => {
      if (controller) { const { [id]: _removed, ...rest } = padBindings; padBindings = rest; }
      else { const { [id]: _removed, ...rest } = keyBindings; keyBindings = rest; }
      renderBindings(); saveSettings();
    }, `Back to the default ${what}s`));
    row.append(name, keys, actions);
    return row;
  }));
  // The button list takes focus, so the keyboard can pick from it too.
  if (capture && controller) $('binding-list').querySelector('.pad-choice')?.focus();
}

// GameCube adapter in Wii U mode (src/gc-adapter.js): shown while one is
// plugged in. The game reads it directly, so the controller bindings above and
// the launcher's own menus don't see it. On Linux the game needs a udev rule to
// open it; Allow access installs one.
function renderGcAdapter(status, message = '') {
  $('gc-adapter-note').hidden = !status?.present;
  if (!status?.present) return;
  const ready = 'The game reads it directly: plug the controller into any port (the first plugged port is player 1). It plays as on a GameCube, so the controller buttons set here and the launcher\'s menus don\'t apply to it.';
  $('gc-adapter-text').textContent = status.readable ? `Plugged in and ready. ${ready}`
    : status.fix === 'udev' ? 'Plugged in, but Linux doesn\'t let the game open it yet. Allow access adds a udev rule for it (as Dolphin needs), which asks for your password.'
    : status.fix === 'driver' ? 'Plugged in, but Windows has no working driver for it. Unplug it and plug it in again; if that doesn\'t help, choose USB Input Device for WUP-028 in Device Manager.'
    : 'Plugged in, but the game needs libusb to read it on a Mac. Install it with Homebrew: brew install libusb.';
  $('gc-adapter-actions').hidden = status.readable;
  $('gc-adapter-allow').hidden = status.fix !== 'udev';
  $('gc-adapter-copy').hidden = status.fix !== 'udev';
  $('gc-adapter-helper').textContent = message;
}
async function loadGcAdapter(message) {
  try { renderGcAdapter(await window.colo.gcAdapterStatus(), message); }
  catch (error) { renderGcAdapter({ present: true, readable: false }, error.message || String(error)); }
}
$('gc-adapter-check').addEventListener('click', () => loadGcAdapter());
$('gc-adapter-allow').addEventListener('click', async () => {
  $('gc-adapter-allow').disabled = true;
  try {
    const result = await window.colo.allowGcAdapter();
    renderGcAdapter(result.status, result.ok
      ? (result.status.readable ? 'Access allowed.' : 'The rule is installed. Unplug the adapter and plug it in again, then choose Check again.')
      : `Not changed: ${result.reason}. Copy the terminal command and run it in a terminal instead.`);
  } catch (error) { $('gc-adapter-helper').textContent = error.message || String(error); }
  finally { $('gc-adapter-allow').disabled = false; }
});
$('gc-adapter-copy').addEventListener('click', async () => {
  await window.colo.copyGcAdapterCommand();
  $('gc-adapter-helper').textContent = 'Copied. Paste it into a terminal, then unplug the adapter, plug it in again and choose Check again.';
});

$('reset-bindings').addEventListener('click', () => {
  stopCapture();
  if (bindingMode === 'controller') padBindings = {}; else keyBindings = {};
  renderBindings(); saveSettings();
});
for (const button of document.querySelectorAll('[data-binding-mode]'))
  button.addEventListener('click', () => {
    stopCapture();
    bindingMode = button.dataset.bindingMode;
    $('binding-note').textContent = bindingNote();
    renderBindings();
  });
for (const button of document.querySelectorAll('[data-close-modal]'))
  button.addEventListener('click', () => button.closest('dialog').close());

function showActivityLog() {
  closeModal();
  setConsoleOpen(true);
  const log = $('log');
  log.scrollTop = log.scrollHeight;
  log.focus();
}
// The activity log is a drawer under the page, opened from the status bar on any page. It pushes the
// page up rather than covering it; expanded, it takes the page's whole height.
function setConsoleOpen(open) {
  consoleOpen = open;
  if (!open) consoleExpanded = false;
  $('activity-log').hidden = !open;
  $('activity-log').classList.toggle('is-expanded', consoleExpanded);
  $('shell').classList.toggle('log-expanded', open && consoleExpanded);
  $('toggle-activity-log').classList.toggle('is-open', open);
  $('toggle-activity-log').setAttribute('aria-expanded', String(open));
  $('toggle-activity-log').title = open ? 'Hide activity log' : 'Show activity log';
  $('expand-activity-log').setAttribute('aria-pressed', String(consoleExpanded));
  $('expand-activity-log').setAttribute('aria-label', consoleExpanded ? 'Restore activity log' : 'Expand activity log');
  $('expand-activity-log').title = consoleExpanded ? 'Restore activity log' : 'Expand activity log';
  if (open && consoleFollowing) $('log').scrollTop = $('log').scrollHeight;
}
function setConsoleFollowing(follow) {
  consoleFollowing = follow;
  $('follow-activity-log').setAttribute('aria-pressed', String(follow));
  $('follow-activity-log').textContent = follow ? 'Following output' : 'Follow output';
  if (follow) $('log').scrollTop = $('log').scrollHeight;
}
$('toggle-activity-log').addEventListener('click', () => setConsoleOpen(!consoleOpen));
$('close-activity-log').addEventListener('click', () => setConsoleOpen(false));
$('expand-activity-log').addEventListener('click', () => {
  consoleExpanded = !consoleExpanded;
  setConsoleOpen(true);
});
$('follow-activity-log').addEventListener('click', () => setConsoleFollowing(!consoleFollowing));
$('log').addEventListener('scroll', () => {
  if (consoleOpen && consoleFollowing && $('log').scrollHeight - $('log').scrollTop - $('log').clientHeight > 24)
    setConsoleFollowing(false);
});
for (const id of ['view-build-log', 'view-activity-log', 'message-view-log'])
  $(id).addEventListener('click', showActivityLog);
$('message-close').addEventListener('click', () => setMessage(''));
$('save-activity-log').addEventListener('click', () => window.colo.saveActivityLog().catch(showError));
$('copy-activity-log').addEventListener('click', async () => {
  const button = $('copy-activity-log'), result = $('copy-log-result');
  button.disabled = true;
  button.textContent = 'Copy log';
  result.textContent = '';
  try {
    await window.colo.copyActivityLog();
    result.textContent = 'Full session copied.';
    button.textContent = 'Copied';
  } catch (error) {
    setConsoleOpen(true);
    result.textContent = `Could not copy log: ${errorText(error)}`;
  } finally {
    button.disabled = false;
  }
});

function setMessage(text, error = false) {
  const box = $('message');
  $('message-text').textContent = text || '';
  $('message-view-log').hidden = !error || !text;
  box.hidden = !text;
  box.classList.toggle('error', error);
  if (text && error) {
    consoleFailed = true;
    renderConsoleState(current?.active);
    setConsoleOpen(true);
  }
}

function badge(id, label, good = false, warn = false) {
  const element = $(id);
  element.textContent = label;
  element.className = `badge${good ? ' good' : warn ? ' warn' : ''}`;
}

function taskName(label) {
  if (!label) return 'Nothing running';
  if (isGameLabel(label)) return 'Game running';
  if (label.startsWith('Build ')) return 'Setting up your game';
  if (label.startsWith('Download port') || label.startsWith('Download decomp') || label.startsWith('Download renderer')) return 'Downloading setup files';
  if (label.startsWith('Download build') || label.startsWith('Prepare build') ||
      label.startsWith('Unpack build') || label.startsWith('Update private')) return 'Preparing build tools';
  if (label === 'Install HD textures') return 'Downloading HD textures';
  if (label === 'Preview cleanup') return 'Checking removable files';
  if (label === 'Clean build output') return 'Freeing up space';
  return label;
}

function backupReason(reason) {
  return ({ manual: 'Manual backup', 'before-play': 'Before playing', 'after-play': 'After playing',
    'before-restore': 'Before restoring', 'before-dolphin-import': 'Before importing', 'before-cleanup': 'Before cleanup',
    'before-port-update': 'Before update', 'before-tools-change': 'Before changing build tools',
    'before-moving-xd-save': 'Before moving the XD save' })[reason] || 'Backup';
}

function needsTextureDownload(data) {
  return data.repoReady && !data.hdVisualsReady;
}

function requiredStep(data) {
  if (data.repoReady && data.romReady && (data.config.completedSetup || data.binaryReady)) return 0;
  if (!data.repoReady || !data.tools.ready) return 1;
  if (!data.romReady) return 2;
  if (!data.binaryReady || needsTextureDownload(data)) return 3;
  return 0;
}

function showWizardStep(data) {
  const required = requiredStep(data);
  if (required === 0) wizardStep = 0;
  else if (wizardStep === null || wizardStep === 0 || wizardStep > required) wizardStep = required;
  const ready = wizardStep === 0;
  const downloadTextures = ready && data.binaryReady && needsTextureDownload(data);
  const home = $('page-home');
  const show = () => {
    home.classList.toggle('ready-mode', ready);
    // a panel over the art (the setup steps): the chosen game's logo goes small to the top for it (layoutPlayStage)
    home.classList.toggle('has-panel', !ready);
    $('setup-flow').hidden = ready;
    $('home-title').textContent = ready ? chosenGame(data).name : 'Set up your game';
    // ready, the game's logo or name above says which game it is; the heading stays for screen readers
    $('home-title').classList.toggle('visually-hidden', ready);
    $('home-description').textContent = ready
      ? downloadTextures ? 'Set up HD visuals to finish setup.'
        : !data.binaryReady ? `This version of the game is not set up yet. Prepare & play gets it ready and starts it, or ▾ Prepare only gets it ready for later.`
        : data.game.needsUpdate ? `Game update${data.game.availableVersion ? ` ${data.game.availableVersion}` : ''} is ready. Your saves carry over.` : 'Ready when you are.'
      : "Three steps, then you're ready to play.";
  };
  if (home.classList.contains('has-panel') === ready) tweenPlayStage(show, { carry: true }); else show();
  $('setup-install-description').textContent = data.config.settings.textures && !data.texturesInstalled
    ? "We'll download HD textures, then build a playable copy of the game on your computer. This can take a while."
    : "We'll build a playable copy of the game on your computer. This can take a while.";
  $('setup-download-title').textContent = data.repoReady ? 'Download build tools' : 'Download setup files';
  $('setup-download-description').textContent = data.repoReady
    ? 'The setup files are ready. Download the tools needed to prepare your game.'
    : "We'll get the files and tools needed to prepare your own disc. The game is not included.";
  const needsMacTools = data.platform.id === 'macos' && !data.tools.appleReady;
  $('mac-setup-help').hidden = !needsMacTools;
  $('mac-tools-settings').hidden = data.platform.id !== 'macos';
  // The build tools go to the launcher's data folder, not the install location: say where.
  $('tool-location-note').textContent = data.portable
    ? 'Setup files and tools download to the Colosseum-Launcher-Portable folder beside the launcher.'
    : needsMacTools ? 'This Mac needs Apple’s tools first. Open Mac setup help to get started.'
      : `Build tools (a few GB) download to ${data.toolsFolder || "the launcher's own folder"}${data.repoReady ? '' : ', not to the install location'}.`;
  if (needsMacTools) {
    $('setup-download-title').textContent = 'Prepare this Mac';
    $('setup-download-description').textContent = 'Check the tools needed before downloading and preparing your game.';
  }
  $('repo-location').hidden = data.repoReady;
  // The portable launcher keeps everything in its own folder, so there is no location to choose.
  $('choose-location').hidden = data.repoReady || data.portable;
  $('choose-repo-settings').hidden = data.portable;
  for (let step = 1; step <= 3; step++)
    $(`setup-step-${step}`).hidden = ready || step !== wizardStep;
  if (ready) $('play').textContent = downloadTextures
    ? setupPending || data.active?.label === 'Install HD textures' ? 'Setting up…' : 'Finish HD setup'
    : !data.binaryReady ? '▶  Prepare & play'
      : data.game.needsUpdate && data.config.settings.autoUpdate ? '↻  Update & play' : '▶  Play';
  else {
    $('step-count').textContent = `Step ${wizardStep} of 3`;
    document.querySelectorAll('.setup-progress-track i').forEach((segment, index) => {
      segment.classList.toggle('complete', index + 1 < wizardStep);
      segment.classList.toggle('current', index + 1 === wizardStep);
    });
    $('play').textContent = setupPending
      ? wizardStep === 1 ? 'Downloading…' : wizardStep === 2 ? 'Choosing…' : 'Setting up…'
      : wizardStep === 1 ? needsMacTools ? 'Set up Mac tools' : data.repoReady && data.tools.ready ? 'Continue'
        : data.repoReady ? 'Download build tools' : 'Download setup files'
        : wizardStep === 2 ? data.romReady ? 'Continue' : 'Choose disc image' : 'Begin setup';
  }
}

let playMenuOpen = false;
function renderPlayMenu(data) {
  const prepare = !data.binaryReady, update = data.game.needsUpdate && !prepare, hd = needsTextureDownload(data) && !prepare;
  const auto = data.config.settings.autoUpdate, next = data.game.availableVersion ? ` ${data.game.availableVersion}` : '';
  const name = 'the game';
  const [kind, label, detail] = prepare ? ['update', 'Prepare & play', `Set up ${name}, then start`]
    : hd ? ['hd', 'Finish HD setup', update && auto ? `Update to${next} and set up HD, then start` : 'Set up HD visuals, then start']
    : update && auto ? ['update', 'Update & play', `Install${next}, then start`]
      : ['play', 'Play', update ? 'Start without updating' : 'Start the game'];
  $('menu-default').dataset.kind = kind;
  $('menu-default-label').textContent = label;
  $('menu-default-detail').textContent = detail;
  $('menu-update-play').hidden = !update || auto;
  $('menu-update-play-detail').textContent = `Install${next}, then start`;
  $('menu-update-only').hidden = !update && !prepare;
  $('menu-update-only-label').textContent = prepare ? 'Prepare only' : 'Update only';
  $('menu-update-only-detail').textContent = prepare ? `Set up ${name}, play later` : `Install${next}, play later`;
  $('menu-play-now').hidden = !(update && auto) && !hd;
  const later = [update ? 'update' : '', hd ? 'HD visuals' : ''].filter(Boolean).join(' and ');
  $('menu-play-now-detail').textContent = `${later.charAt(0).toUpperCase()}${later.slice(1)} later`;
  $('play-menu-note').hidden = !update;
  const others = Object.entries({ 'menu-update-play': 'Update & play', 'menu-update-only': $('menu-update-only-label').textContent, 'menu-play-now': 'Play now' })
    .filter(([id]) => !$(id).hidden).map(([, item]) => item);
  // ▾ only when the menu has more than Play itself
  const offered = data.romReady && wizardStep === 0 && others.length > 0;
  $('play-more').hidden = !offered;
  $('play').classList.toggle('has-more', offered);
  $('play-more').disabled = Boolean(data.active) || setupPending;
  if (playMenuOpen && (!offered || $('play-more').disabled)) $('play-menu').hidePopover();
  $('play-more-hint').hidden = !offered || Boolean(data.active);
  $('play-more-hint').textContent = `▾ for ${others.join(' or ')}`;
}

// A task shows its progress under Play and in the status bar; the activity log opens by itself only
// when something fails (setMessage, appendLog).
function renderActivity(active) {
  if (active && !consoleWasActive) consoleFailed = false;
  consoleWasActive = Boolean(active);
  renderConsoleState(active);
  const working = Boolean(active) && !isGameLabel(active.label);
  $('task-progress').hidden = !working;
  $('status-progress').hidden = !working || !Number.isFinite(active.percent);
  if (!$('status-progress').hidden) $('status-progress-fill').style.width = `${active.percent}%`;
  $('activity-label').textContent = taskName(active?.label);
  $('stop').hidden = !active?.canStop;
  $('stop').textContent = isGameLabel(active?.label) ? 'Stop game'
    : active?.label.startsWith('Build ') ? 'Stop build' : 'Stop task';
  $('view-build-log').textContent = active?.label.startsWith('Build ') ? 'View build log' : 'View activity';
  const pbrNote = pbrProgress(active);
  if (pbrNote) $('pbr-note').textContent = pbrNote;
  if (current) renderPbrBanner({ ...current, active });
  $('task-status').textContent = active ? taskName(active.label)
    : current?.binaryReady && needsTextureDownload(current) ? 'HD setup needed'
    : current?.game.needsUpdate && current.config.completedSetup ? 'Update ready'
    : $('page-home').classList.contains('ready-mode') ? 'Ready to play' : 'Finish setup to play';
  if (!working) return;
  $('progress-title').textContent = taskName(active.label);
  $('progress-detail').textContent = active.detail || 'Working…';
  const seconds = Math.max(0, Math.floor((Date.now() - active.startedAt) / 1000));
  $('progress-time').textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  const known = Number.isFinite(active.percent);
  $('progress-percent').textContent = known ? `${active.percent}%` : '';
  $('progress-track').classList.toggle('indeterminate', !known);
  $('progress-fill').style.width = known ? `${active.percent}%` : '';
  if (known) $('progress-track').setAttribute('aria-valuenow', String(active.percent));
  else $('progress-track').removeAttribute('aria-valuenow');
}

function renderConsoleState(active) {
  const badge = $('console-state');
  badge.textContent = consoleFailed ? 'Error' : active ? 'Live' : 'Idle';
  for (const element of [badge, $('toggle-activity-log')]) {
    element.classList.toggle('is-live', Boolean(active) && !consoleFailed);
    element.classList.toggle('is-error', consoleFailed);
  }
}

// The two games of the Play page: a side of the art each, split by a diagonal that gives the chosen one most of the
// window (style.css #game-art), and a button each over its side: its logo from the disc, or its name (layoutPlayStage).
const GAME_IDS = ['colosseum', 'xd'];
function showChosenGame(id) {
  const show = () => {
    $('game-art').dataset.active = id;
    for (const each of GAME_IDS) $(`game-${each}`).setAttribute('aria-pressed', String(each === id));
  };
  // the logos move with the line (tweenPlayStage)
  if ($('game-art').dataset.active !== id) tweenPlayStage(show); else show();
}

// The game picker, and what the chosen game has: its disc, and the tabs and settings of features it doesn't have hidden.
// The Pokédex and the Jukebox read the chosen game's disc, so they start again when another game is chosen.
let renderedGame = null;
function renderGame(data) {
  const chosen = chosenGame(data), locked = Boolean(data.active) || setupPending;
  if (renderedGame && renderedGame !== chosen.id) { window.coloPokedex?.reset?.(); window.coloJukebox?.reset?.(); }
  renderedGame = chosen.id;
  showChosenGame(choosingGame || chosen.id);
  for (const id of GAME_IDS) $(`game-${id}`).disabled = locked;
  // the art can't be clicked to choose either while a task runs
  $('game-art').classList.toggle('locked', locked);
  $('setup-disc-description').textContent = `Select a file from your own North American ${chosen.name} disc (${chosen.discId}). Use an .iso or .gcm file.`;
  // Dolphin's name for the game's save (gci-save.js exportName)
  const gciName = chosen.id === 'xd' ? '01-GXXE-PokemonXD.gci' : '01-GC6E-pokemon_colosseum.gci';
  $('dolphin-import-help').textContent = `Drop your North American ${chosen.name} .gci save here, or the folder it is in, or choose it. Dolphin names it ${gciName}. Your current saves are backed up before importing.`;
  renderGenerationsText(data, chosen);
  renderPokemonText(chosen);
  renderGbaText(chosen);
  for (const node of document.querySelectorAll('[data-feature]')) node.classList.toggle('feature-off', !gameHas(data, node.dataset.feature));
  if (!gameHas(data, 'gbaLink') && settingsTab === 'gba') settingsTab = 'gameplay';
  if (pages[page] && !gameHas(data, { pokedex: 'pokedex', jukebox: 'jukebox', online: 'online' }[page] || '')) showPage('play');
}

// Later generations, as each game has them: Colosseum's own, with packs and Battle Revolution assets; another game's are
// made from Colosseum's disc (main.js prepareGenerations), and its Pokémon look as the ones standing in for them.
const GENERATION_RULES = 'Generation 4: each move is physical or special by itself, not by its type; a sandstorm raises Rock types\' Sp. Def; and moves Diamond and Pearl changed play as they did there.';
function renderGenerationsText(data, chosen) {
  // Colosseum's own (with the Pokédex and the randomizer), or another game's, made from Colosseum's disc
  const own = chosen.id === 'colosseum';
  $('battle-rules-gen3').textContent = `${chosen.shortName} (Gen 3)`;
  $('battle-rules-note').textContent = own
    ? `${GENERATION_RULES} An online battle plays by its room's rules, chosen under Rules on the Online page.`
    : `${GENERATION_RULES} It applies to Colosseum too, and ${chosen.shortName}'s online battles play by Gen 3 rules for now.`;
  // another game's story gives none yet, but its randomizer can choose them
  const story = gameHas(data, 'randomizer') ? `Nothing in ${chosen.shortName}'s story gives you one, but the randomizer can choose them, with Gen 4 under its Generations.`
    : `Nothing in ${chosen.shortName}'s story gives you one yet.`;
  $('generation4-note').textContent = own
    ? 'Adds the 107 Pokémon from Turtwig to Arceus, and the new moves of Diamond and Pearl that Colosseum can play, to your game and the Pokédex. The randomizer can choose them, with Gen 4 under its Generations. Their models and cries come from your own Pokémon Battle Revolution disc, asked for when you turn this on; without it, a Colosseum Pokémon stands in for each one\'s looks and cry.'
    : gameHas(data, 'pbrAssets')
      ? `Adds the 107 Pokémon from Turtwig to Arceus, and the new moves of Diamond and Pearl, to ${chosen.shortName}, and the game's own Pokémon learn moves and evolve as in Platinum. Their models and cries come from your own Pokémon Battle Revolution disc; without it, a Pokémon of the game stands in for each one's looks and cry. ${story} It applies to Colosseum too.`
      : `Adds the 107 Pokémon from Turtwig to Arceus, and the new moves of Diamond and Pearl, to ${chosen.shortName}. Each one looks and sounds like a Pokémon of the game standing in for it. ${story} It applies to Colosseum too.`;
  // made from Colosseum's disc, which has to be set up first
  $('generations-disc-note').hidden = own || data.teamDiscReady !== false;
  $('generations-disc-note').textContent = `Generation 4 in ${chosen.shortName} is made from your Pokémon Colosseum disc. Choose Colosseum on the Play page and set up its disc first; until then ${chosen.shortName} plays by Gen 3 rules.`;
}

// The GBA link, as each game has it: Colosseum registers a team and gives Poké Coupons; XD only trades, at the Trade
// Center (host/xd/gbalink.c)
let gbaIntro = null;
function renderGbaText(chosen) {
  gbaIntro ??= $('gba-intro').textContent;
  $('gba-intro').textContent = chosen.id === 'xd'
    ? 'Link your Pokémon Ruby, Sapphire, Emerald, FireRed or LeafGreen save to XD, as the GCN-GBA cable did, and trade at the Trade Center in a Pokémon Center\'s basement. Use socket 2. Choose the save your emulator keeps: the game reads it, and writes trades back into it, with a backup first. Save in a Pokémon Center on the GBA first.'
    : gbaIntro;
}

// Shiny Shadow Pokémon, choosing starters and the randomizer, as each game has them: XD's Shadow Pokémon could never be
// shiny, its starter is one Eevee, and its gifts are trades and Mt. Battle's Johto starters (host/shiny.c,
// host/starters.c, host/randomizer.c).
const POKEMON_TEXT = {};
const XD_RANDOMIZER_TEXT = {
  'randomizer-starters-title': 'Starter',
  'randomizer-starters-note': 'Your first Pokémon, instead of Eevee.',
  'randomizer-shadow-note': 'Every Shadow Pokémon you can snag. Each is a different species. Lugia and the Shadow Togepi you\'re given stay as they are.',
  'randomizer-trainers-note': 'Everything else trainers send out, in the story, on Mt. Battle and in the Orre Colosseum. Quick Battle and the battle CDs stay as they are.',
  'randomizer-gifts-note': 'The Pokémon traded to you in the story, and Mt. Battle\'s Chikorita, Cyndaquil and Totodile. Poké Spot Pokémon stay as they are.'
};
function renderPokemonText(chosen) {
  for (const id of ['shiny-shadow-note', 'choose-starters-title', 'choose-starters-note', ...Object.keys(XD_RANDOMIZER_TEXT)]) POKEMON_TEXT[id] ??= $(id).textContent;
  const xd = chosen.id === 'xd';
  for (const [id, text] of Object.entries(XD_RANDOMIZER_TEXT)) $(id).textContent = xd ? text : POKEMON_TEXT[id];
  // XD's game has no Pokémon packs' own Pokémon to choose (host/randomizer.c ignores the option there)
  $('randomizer-packs-row').hidden = xd;
  $('shiny-shadow-note').textContent = xd
    ? 'A Shadow Pokémon can be shiny, at 1 in 8192 as other Pokémon are, and looks it in battle before you snag it. The original XD never makes them shiny. Each one\'s chance is decided when you first meet it in battle.'
    : POKEMON_TEXT['shiny-shadow-note'];
  $('choose-starters-title').textContent = xd ? 'Choose starter' : POKEMON_TEXT['choose-starters-title'];
  $('choose-starters-note').textContent = xd
    ? 'After you enter your name for a New Game, the game asks whether to begin with Eevee. Say No to pick any Pokémon instead, at level 10. A randomized game that randomizes the starter doesn\'t ask.'
    : POKEMON_TEXT['choose-starters-note'];
}

// The line moves across as the game is chosen, before the launcher has switched to it; a failure puts it back.
let choosingGame = null;
async function chooseGame(id) {
  if (chosenGame(current).id === id || choosingGame || $(`game-${id}`).disabled) return;
  setMessage('');
  choosingGame = id;
  showChosenGame(id);
  try {
    const result = await window.colo.selectGame(id);
    wizardStep = null;
    if (result?.config) refresh(result);
    await sync();
  } catch (error) { showError(error); }
  finally {
    choosingGame = null;
    if (current) renderGame(current);
  }
}
// The other game: what a controller's X (or Square) does on the Play page.
function switchGame() { chooseGame(GAME_IDS.find(id => id !== chosenGame(current).id)); }
for (const id of GAME_IDS) {
  $(`game-${id}`).addEventListener('click', () => chooseGame(id));
  // the side of the art not chosen is the other game's, to click (the chosen side's clicks do nothing)
  $(`game-art-${id}`).addEventListener('click', () => { if (page === 'play' && !consoleExpanded) chooseGame(id); });
}

// Each game's logo, read from its own disc by the launcher (main.js gameLogos), in place of its name:
// asked for again when a disc, the language or the HD textures change. A game without a disc, or whose logo couldn't
// be read, keeps its name.
let logoKey = null;
function logoState(config = {}) {
  const chosen = config.game || GAME_IDS[0];
  return JSON.stringify([GAME_IDS.map(id => (id === chosen ? config.rom : config.games?.[id]?.rom) || ''),
    config.settings?.language || 'en', Boolean(config.settings?.textures)]);
}
function showLogos(logos) {
  for (const id of GAME_IDS) {
    const url = typeof logos?.[id] === 'string' && logos[id].startsWith('data:image/') ? logos[id] : null, logo = $(`game-logo-${id}`);
    if (url) logo.src = url; else logo.removeAttribute('src');
    logo.hidden = !url;
    $(`game-${id}`).classList.toggle('has-logo', Boolean(url));
  }
}
async function syncLogos(config) {
  const key = logoState(config);
  if (key === logoKey || !window.colo.gameLogos) return;
  logoKey = key;
  let logos = null;
  try { logos = await window.colo.gameLogos(); } catch (_) { /* the names stay */ }
  if (key === logoKey) showLogos(logos);
}

// Where the logos and the headline go on the Play page (play-stage.js has the rules): measured from the window, the
// page, Play and any banner, and set as --x, --y and --w on each game's button, and --x, --top and --max on the
// headline. Asked again when the window or Play changes size, a logo loads, or the page is refreshed.
function stageGeometry() {
  const home = $('page-home'), viewport = home.parentElement;
  if (home.hidden || !viewport || typeof window.getComputedStyle !== 'function') return null;
  const shell = $('shell').getBoundingClientRect(), page = home.getBoundingClientRect();
  if (!shell.width || !shell.height || !page.width) return null;
  // the page's own heights are from its top, and the window's across from its left; the page as it is when it isn't
  // scrolled (setting up, it can be)
  const scroll = viewport.scrollTop || 0, pageTop = page.top + scroll - shell.top;
  const across = box => ({ left: box.left - shell.left, right: box.right - shell.left });
  const play = $('launch-panel').getBoundingClientRect(), banner = $('add-to-steam'), bannerBox = banner.getBoundingClientRect();
  const aspect = {};
  for (const id of GAME_IDS) {
    const logo = $(`game-logo-${id}`);
    aspect[id] = !logo.hidden && logo.naturalWidth > 0 && logo.naturalHeight > 0 ? logo.naturalWidth / logo.naturalHeight : 0;
  }
  return {
    W: shell.width, H: shell.height, pageTop, active: $('game-art').dataset.active, panel: home.classList.contains('has-panel'), aspect,
    play: { ...across(play), top: play.top - page.top },
    // the window's foot
    visibleBottom: viewport.getBoundingClientRect().bottom - page.top - scroll - 8,
    banner: !banner.hidden && bannerBox.height ? { ...across(bannerBox), bottom: bannerBox.bottom - page.top } : null,
    band: parseFloat(window.getComputedStyle(home).paddingTop) || 0,
    headlineHeight: $('home-headline').offsetHeight || 0,
    origin: { x: $('game-picker').getBoundingClientRect().left - shell.left, page: page.left - shell.left }
  };
}
function layoutPlayStage() {
  const geometry = stageGeometry();
  if (!geometry || !window.ColoPlayStage) return false;
  let places = window.ColoPlayStage.layout(geometry);
  const headline = $('home-headline'), px = value => `${Math.round(value * 10) / 10}px`;
  const placeHeadline = () => {
    const at = places.headline || { cx: places[geometry.active].cx };
    headline.style.setProperty('--x', px(at.cx - geometry.origin.page));
    if (places.headline) { headline.style.setProperty('--top', px(at.top)); headline.style.setProperty('--max', px(at.maxWidth)); }
  };
  placeHeadline();
  // the headline wraps to the width it is given, which moves the logo above it: once more with its new height
  if (places.headline && Math.abs((headline.offsetHeight || 0) - geometry.headlineHeight) > 1) {
    places = window.ColoPlayStage.layout({ ...geometry, headlineHeight: headline.offsetHeight || 0 });
    placeHeadline();
  }
  for (const id of GAME_IDS) {
    const place = places[id], tab = $(`game-${id}`);
    tab.style.setProperty('--x', px(place.cx - geometry.origin.x));
    tab.style.setProperty('--y', px(place.cy - place.h / 2));
    tab.style.setProperty('--w', px(place.w));
  }
  $('page-home').classList.add('stage-placed');
  return true;
}

// Moving between places (another game chosen, or a panel coming or going) is a tween of the same .75 s and easing as the
// line (style.css --tween): each part is put in its new place at once, then drawn from where it was by a transform that
// eases away. Logos grow or shrink as they go; the rest slides. Reduced motion: no tween.
const STAGE_TWEEN = { duration: 750, easing: 'cubic-bezier(.7, 0, .25, 1)' };
let stageAnimations = [];
const stageParts = () => [...GAME_IDS.flatMap(id => [$(`game-mark-${id}`), $(`game-state-${id}`)]), $('home-headline'), $('setup-flow'), $('launch-panel')];
function reducedMotion() { return Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches); }
// carry: a change during a tween (a panel coming as the other game is chosen) keeps to that tween's time, as the line does
function tweenPlayStage(change, { carry = false } = {}) {
  const parts = stageParts();
  const tween = page === 'play' && $('page-home').classList.contains('stage-placed') && !reducedMotion() && typeof parts[0].animate === 'function';
  const from = tween ? parts.map(part => part.getBoundingClientRect()) : [];
  const running = carry ? stageAnimations.find(animation => animation.playState === 'running') : null;
  const elapsed = running ? Number(running.currentTime) || 0 : 0, done = running ? running.effect.getComputedTiming().progress || 0 : 0;
  for (const animation of stageAnimations) animation.cancel();
  stageAnimations = [];
  change();
  if (!layoutPlayStage() || !tween) return;
  // keeping to a running tween, each part starts far enough back that it is where it was at the time already gone
  const keep = elapsed > 0 && done < 0.9 ? 1 / (1 - done) : 0;
  parts.forEach((part, index) => {
    const was = from[index], now = part.getBoundingClientRect();
    if (!was.width || !now.width) return;
    let dx = was.left + was.width / 2 - now.left - now.width / 2, dy = was.top + was.height / 2 - now.top - now.height / 2;
    let scale = part.classList.contains('game-tab-art') ? was.width / now.width : 1;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 && Math.abs(scale - 1) < 0.002) return;
    if (keep) { dx *= keep; dy *= keep; scale = 1 + (scale - 1) * keep; }
    const round = (value, places = 100) => Math.round(value * places) / places;
    const animation = part.animate([{ transform: `translate(${round(dx)}px, ${round(dy)}px) scale(${round(scale, 1e4)})` }, { transform: 'none' }], STAGE_TWEEN);
    if (keep) animation.currentTime = elapsed;
    stageAnimations.push(animation);
  });
}
if (typeof ResizeObserver === 'function') {
  const observer = new ResizeObserver(() => layoutPlayStage());
  for (const id of ['page-home', 'launch-panel']) observer.observe($(id));
}
for (const id of GAME_IDS) $(`game-logo-${id}`).addEventListener('load', () => layoutPlayStage());

function refresh(data) {
  if (Number.isFinite(data.logResetSequence)) resetLog(data.logResetSequence);
  current = data;
  const { config, platform } = data;
  renderGame(data);
  syncLogos(config);
  $('platform').textContent = platform.name;
  $('repo-path').textContent = config.repo;
  $('repo-path').title = config.repo;
  $('settings-repo-path').textContent = config.repo;
  $('settings-repo-path').title = config.repo;
  $('choose-location').disabled = Boolean(data.active);
  $('update-port').disabled = !data.repoReady || Boolean(data.active);
  $('rom-path').textContent = data.romError || config.rom || 'No file selected';
  $('rom-path').title = data.romError || config.rom;
  $('rom-path').classList.toggle('rom-error', Boolean(data.romError));
  $('settings-rom-path').textContent = data.romError || config.rom || 'No disc file selected';
  $('settings-rom-path').title = data.romError || config.rom;
  $('choose-rom').hidden = !data.romReady;
  showWizardStep(data);
  renderMacTools(data.tools);
  $('play').disabled = Boolean(data.active) || setupPending;
  renderPlayMenu(data);
  // the headline's words may have changed, and with them its height under the logo
  layoutPlayStage();
  for (const button of document.querySelectorAll('[data-setup-back]')) button.disabled = Boolean(data.active) || setupPending;
  $('build').hidden = !data.binaryReady || !data.romReady;
  $('rebuild-note').hidden = $('build').hidden;
  $('build').disabled = Boolean(data.active);
  const gb = bytes => (Math.ceil(bytes / 1e8) / 10).toFixed(1);
  const finish = data.binaryReady ? 'Close Settings and choose Finish HD setup.' : '';
  badge('textures-badge', data.texturesInstalled ? 'Installed' : 'Not installed', data.texturesInstalled,
    config.settings.textures && !data.texturesInstalled);
  $('texture-info').textContent = data.texturesInstalled
    ? config.settings.textures ? 'HD textures are ready.' : 'Already downloaded. Turn on to use them.'
    : `${config.settings.textures ? `${finish || 'HD textures will download during setup.'} ` : ''}About ${gb(data.texturePack.size)} GB to download; allow ${gb(data.texturePack.size + data.texturePack.unpacked)} GB of free space for setup.`;
  $('clean').disabled = !data.repoReady || Boolean(data.active);
  $('clean-preview').disabled = !data.repoReady || Boolean(data.active);
  // Windows only: elsewhere the game runs with libraries from the build tools. Your own MSYS2 is never removed.
  $('build-tools-row').hidden = platform.id !== 'windows' || data.tools.mode === 'own';
  $('build-tools-note').textContent = data.tools.ready
    ? 'Only needed to build the game, which plays without them. Removing them frees a few GB; the launcher downloads them again the next time it builds or sets up the game.'
    : 'Not downloaded. The launcher downloads them the next time it builds or sets up the game.';
  $('remove-build-tools').disabled = !data.tools.ready || !data.binaryReady || Boolean(data.active);
  $('choose-rom').disabled = Boolean(data.active);
  $('choose-rom-settings').disabled = Boolean(data.active);
  $('choose-repo-settings').disabled = Boolean(data.active);
  renderActivity(data.active);
  renderAppUpdate(data.appUpdate);
  const installedVersion = data.binaryReady ? data.game.installedVersion : null;
  const gameVersion = installedVersion || (data.binaryReady ? 'Version unavailable' : 'Not installed');
  $('version-summary').textContent = `Launcher v${data.game.launcherVersion} · Game ${installedVersion || (data.binaryReady ? 'version unavailable' : 'not installed')}`;
  $('launcher-version').textContent = `v${data.game.launcherVersion}`;
  $('installed-game-version').textContent = gameVersion;
  $('available-game-version-row').hidden = installedVersion === data.game.availableVersion;
  $('available-game-version').textContent = data.game.availableVersion;
  $('tool-version').textContent = data.game.toolVersion;
  $('tool-version-note').textContent = [data.tools.mode === 'own' ? 'Your MSYS2' : data.tools.ready || data.tools.privateInstalled ? 'Downloaded' : 'Not downloaded',
    data.game.installedToolVersion && data.game.installedToolVersion !== data.game.toolVersion
      ? `Game built with ${data.game.installedToolVersion}` : ''].filter(Boolean).join(' · ');
  $('game-update-note').textContent = !data.binaryReady
    ? `Game ${data.game.availableVersion} will be installed during setup.` : data.game.needsUpdate
    ? `Game ${data.game.availableVersion} is ready to set up. Your current version stays available until setup succeeds.`
    : 'Your game is up to date.';
  $('play-installed').hidden = !data.binaryReady || (!data.game.needsUpdate && !needsTextureDownload(data));
  $('play-installed').disabled = Boolean(data.active) || !data.romReady || setupPending;
  $('play-previous').hidden = !data.game.previousReady;
  $('play-previous').disabled = Boolean(data.active);
  $('save-path').textContent = `Saved games: ${data.saveDirectory}\nBackups: ${data.backupDirectory}`;
  $('backup-saves').disabled = Boolean(data.active);
  $('restore-saves').disabled = Boolean(data.active) || !data.backups.length;
  $('import-dolphin-save').disabled = Boolean(data.active);
  $('export-gci-save').disabled = Boolean(data.active);
  $('dolphin-save-drop').setAttribute('aria-disabled', String(Boolean(data.active)));
  const selectedBackup = $('backup-list').value;
  $('backup-list').replaceChildren(...data.backups.map(backup => {
    const option = document.createElement('option');
    option.value = backup.id;
    option.textContent = `${new Date(backup.createdAt).toLocaleString()} · ${backupReason(backup.reason)} · ${backup.count} files`;
    return option;
  }));
  if (data.backups.some(backup => backup.id === selectedBackup)) $('backup-list').value = selectedBackup;
  $('backup-list').disabled = Boolean(data.active) || !data.backups.length;

  changing = true;
  const renderers = platform.renderers || [];
  $('renderer-field').hidden = !renderers.includes('vulkan');
  $('metal-renderer').hidden = !renderers.includes('metal');
  $('renderer-note').textContent = renderers.includes('metal')
    ? "Metal is this Mac's own graphics, and the fastest here. Choose Vulkan or OpenGL if the game has trouble drawing."
    : "Vulkan is the port's main renderer. Choose OpenGL if the game has trouble drawing on this computer.";
  renderExclusiveResolutions(config.settings.exclusiveResolution);
  renderDisplays(config.settings.display);
  renderUpdateChannels(config.settings.updateChannel);
  // Portable launchers update by downloading a new .exe, so channels do not apply.
  $('update-channel-field').hidden = data.portable;
  $('update-channel-note').hidden = data.portable;
  renderGameSource(data);
  renderLanguages(data.languages, config.settings.language);
  $('language-note').hidden = data.languagesReady !== false || config.settings.language === 'en';
  $('language-note').textContent = 'Update your game to play in this language. This version of the game plays in English.';
  for (const key of SELECTS) $(key).value = String(config.settings[key]);
  renderRanges();
  for (const key of SWITCHES) $(key).checked = config.settings[key];
  $('graphicsPreset').value = config.settings.graphicsPreset || 'custom';
  renderPreset();
  renderCrashReports(data.crashReports);
  if (data.directPlayFailure && data.directPlayFailure !== directPlayShown) setMessage(directPlayShown = data.directPlayFailure, true);
  renderTheme();
  keyBindings = config.settings.keyBindings || {};
  padBindings = config.settings.padBindings || {};
  $('stickDeadzone').value = String(config.settings.stickDeadzone ?? 10);
  $('triggerClick').value = String(config.settings.triggerClick ?? 85);
  $('rumbleStrength').value = String(config.settings.rumbleStrength ?? 100);
  renderRange('stickDeadzone');
  renderRange('triggerClick');
  renderRange('rumbleStrength', 'Off');
  for (const key of ['stickDeadzone', 'triggerClick', 'rumbleStrength']) $(key).disabled = Boolean(data.active);
  $('gbaVolume').value = String(config.settings.gbaVolume ?? 100);
  renderRange('gbaVolume', 'Off');
  $('gbaVolume').disabled = Boolean(data.active);
  renderGba(data);
  if (!capture) renderBindings();
  $('reset-bindings').disabled = Boolean(data.active);
  for (const key of [...SELECTS, ...SWITCHES, 'graphicsPreset']) $(key).disabled = Boolean(data.active);
  renderRandomizer(data);
  renderPbr(data);
  renderDependents(Boolean(data.active));
  changing = false;
}

// The settings that are a list or a range, and the ones that are a switch: each saves under its element's id.
const SELECTS = ['buttonPrompts', 'promptPad', 'battleRules', 'widescreen', 'resolution', 'frameRate', 'vsync', 'fullscreenMode', 'exclusiveResolution', 'display', 'msaa', 'anisotropic', 'sharpen', 'brightness', 'aspect', 'presentFilter', 'fsrMode', 'textureLoading', 'renderer', 'hdText', 'language', 'battleSpeed', 'fastForward', 'fastForwardSpeed', 'padMode', 'updateChannel', 'randomizerSeed'];
const SWITCHES = ['randomizer', 'randomizerStarters', 'randomizerShadow', 'randomizerTrainers', 'randomizerGifts', 'randomizerGen1', 'randomizerGen2', 'randomizerGen3', 'randomizerGen4', 'randomizerPacks', 'randomizerSimilar', 'randomizerNoLegendaries', 'generation4Pokemon', 'fullscreen', 'hudEdges', 'skipMovies', 'skipBattleAnimations', 'quickMoves', 'quickStatus', 'shinyShadow', 'shinyStarters', 'chooseStarters', 'overlay', 'backgroundInput', 'gbaAutoPower', 'fxaa', 'textures', 'hdModels', 'shaderWarmup', 'autoUpdate', 'autoBackups', 'shareUsage', 'discordPresence', 'darkMode'];

// The languages: English, the launcher's packs and any found in the languages folder. One chosen and then
// removed from the folder stays listed, as the game plays in English without it.
function renderLanguages(list = [{ code: 'en', name: 'English' }], chosen = 'en') {
  const items = list.some(item => item.code === chosen) ? list : list.concat({ code: chosen, name: chosen, missing: true });
  $('language').replaceChildren(...items.map(item => {
    const option = document.createElement('option');
    option.value = item.code;
    option.textContent = item.missing ? `${item.name} (not found: plays in English)` : item.local ? `${item.name} (your folder)` : item.name;
    return option;
  }));
}

let updateChannels = [{ id: 'stable', label: 'Stable' }];
function renderUpdateChannels(chosen) {
  const list = updateChannels.some(item => item.id === chosen) ? updateChannels
    : updateChannels.concat({ id: chosen, label: chosen, missing: true });
  $('updateChannel').replaceChildren(...list.map(item => {
    const option = document.createElement('option');
    option.value = item.id;
    option.textContent = item.missing ? `${item.label} (no longer available)` : item.label;
    if (item.detail) option.title = item.detail;
    return option;
  }));
  $('updateChannel').value = chosen;
}
async function loadUpdateChannels() {
  try { updateChannels = await window.colo.updateChannels(); }
  catch (_) { return; }
  if (current) { changing = true; renderUpdateChannels(current.config.settings.updateChannel); changing = false; }
}

const sourceFields = { port: ['source-port-repository', 'source-port-ref'], decomp: ['source-decomp-repository', 'source-decomp-ref'] };
let sourceShown = null;
function renderGameSource(data) {
  const chosen = data.gameSource;
  // The chosen game's release repositories, for the rows left empty.
  const release = data.currentGame?.release;
  if (release) {
    $('source-port-repository').placeholder = release.repository;
    $('source-port-ref').placeholder = release.branch || 'master';
    $('source-decomp-repository').placeholder = release.decompRepository;
  }
  // Fill the fields from the saved choice once for each game, so typing is never overwritten.
  if (sourceShown !== chosenGame(data).id) {
    sourceShown = chosenGame(data).id;
    for (const [part, [repository, ref]] of Object.entries(sourceFields)) {
      $(repository).value = chosen?.override[part]?.repository || '';
      $(ref).value = chosen?.override[part]?.ref || '';
    }
    $('game-source').open = Boolean(chosen);
  }
  $('game-source-note').textContent = chosen
    ? `Building from ${chosen.version}. Update game to build it, or to follow a branch's newest commit.`
    : `Using this launcher's release (game ${data.game.availableVersion}).`;
  for (const id of ['apply-game-source', 'reset-game-source', ...Object.values(sourceFields).flat()])
    $(id).disabled = Boolean(data.active);
  $('reset-game-source').hidden = !chosen;
  // Under Play, so nobody plays a chosen source thinking it is this launcher's release.
  const ref = chosen?.override?.port?.ref || chosen?.override?.decomp?.ref || '';
  const commit = String(chosen?.version || '').replace(/^custom /, '');
  $('play-source').hidden = !chosen;
  $('play-source-detail').textContent = [ref, commit !== ref && commit].filter(Boolean).join(' · ');
}

function gameSourceValue() {
  const value = {};
  for (const [part, [repository, ref]] of Object.entries(sourceFields))
    value[part] = { repository: $(repository).value, ref: $(ref).value };
  return value;
}
async function setGameSource(value) {
  setMessage('');
  try { refresh(await window.colo.setGameSource(value)); }
  catch (error) { showError(error); }
}
$('apply-game-source').addEventListener('click', () => setGameSource(gameSourceValue()));
$('play-source').addEventListener('click', () => {
  showPage('settings');
  showSettingsTab('manage');
  $('game-source').open = true;
  $('game-source').scrollIntoView({ block: 'center' });
});
$('reset-game-source').addEventListener('click', () => {
  for (const id of Object.values(sourceFields).flat()) $(id).value = '';
  setGameSource(null);
});

async function sync() { refresh(await window.colo.state()); }

function renderMacTools(tools) {
  const requirements = (tools.requirements || []).filter(item => !tools.managed || !item.package);
  if (tools.managed) requirements.push({ label: 'Launcher build tools', ready: tools.privateInstalled, automatic: true });
  $('mac-requirements').replaceChildren(...requirements.map(item => {
    const row = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = item.label;
    const status = document.createElement('span');
    status.className = `badge${item.ready ? ' good' : item.optional ? '' : ' warn'}`;
    status.textContent = item.ready ? 'Ready' : item.automatic ? 'Download in Step 1' : item.optional ? 'Optional' : 'Needed';
    row.append(name, status);
    return row;
  }));
  const commands = (tools.commands || '').split('\n').filter(Boolean);
  $('mac-apple-command').replaceChildren();
  $('mac-extra-commands').replaceChildren();
  commands.forEach((command, index) => {
    const row = document.createElement('div');
    row.className = 'mac-command';
    const code = document.createElement('code');
    code.textContent = command;
    const copy = document.createElement('button');
    copy.className = 'subtle'; copy.textContent = 'Copy';
    copy.addEventListener('click', async () => {
      try { await window.colo.copyMacCommand(index); copy.textContent = 'Copied'; }
      catch (error) { showError(error); }
    });
    row.append(code, copy);
    (command.startsWith('xcode-select') ? $('mac-apple-command') : $('mac-extra-commands')).append(row);
  });
  $('mac-apple-note').hidden = !commands.some(command => command.startsWith('xcode-select'));
  $('mac-extra-note').hidden = !commands.some(command => !command.startsWith('xcode-select'));
  $('mac-check-result').textContent = tools.appleReady || tools.ready ? 'Ready. Close this help and continue setup.'
    : tools.checked ? 'Some tools still need to be installed.' : 'Checking tools…';
}

// A Windows folder the game can't be built in: too deep, with the part of its
// path over the limit marked so players see how much shorter it must be, or
// with an & in its path, marked where it is.
function showPathProblem() {
  const problem = current?.pathProblem;
  if (!problem) return false;
  const folderName = problem.portable ? 'The Colosseum-Launcher-Portable folder' : 'The folder holding the setup files';
  const characters = problem.kind === 'characters';
  const listed = characters ? problem.characters.join(' or ') : '';
  $('path-too-long-title').textContent = characters ? `Move the launcher to a folder without ${listed}` : 'Move the launcher to a shorter folder';
  $('path-too-long-lead').textContent = characters ? `Windows can't build the game in a folder with ${listed} in its path.`
    : "Windows can't build the game this deep in your folders.";
  if (characters) {
    const strong = document.createElement('strong');
    strong.textContent = listed;
    $('path-summary').replaceChildren(`${problem.name}'s path has `, strong, ' in it.');
    $('path-folder').replaceChildren(...problem.folder.split(/([&^])/).filter(Boolean).map(part => {
      if (!problem.characters.includes(part)) return part;
      const mark = document.createElement('mark');
      mark.textContent = part;
      return mark;
    }));
    $('path-over').textContent = `Can't be in the path`;
  } else {
    const over = problem.length - problem.limit;
    const length = document.createElement('strong'), limit = document.createElement('strong');
    length.textContent = problem.length;
    limit.textContent = problem.limit;
    $('path-summary').replaceChildren(`${folderName}'s path is `, length,
      ' characters long, but the game can only be built in a folder of up to ', limit, '.');
    const mark = document.createElement('mark');
    mark.textContent = problem.folder.slice(problem.limit);
    $('path-folder').replaceChildren(problem.folder.slice(0, problem.limit), mark);
    $('path-over').textContent = `${over} character${over === 1 ? '' : 's'} too long`;
  }
  const place = characters ? `a folder without ${listed} in its path` : 'a shorter folder';
  $('path-steps').replaceChildren(...(problem.portable ? [
    'Close the launcher.',
    `Move the launcher and its Colosseum-Launcher-Portable folder together to ${characters ? place : 'a short folder'}, such as C:\\Games.`,
    'Open the launcher from there. Your saves, settings and downloads come with it.'
  ] : [`Open Settings and choose ${place} for Setup files, such as C:\\Games.`]).map(text => {
    const item = document.createElement('li');
    item.textContent = text;
    return item;
  }));
  $('path-why').textContent = characters
    ? `Windows' command prompt runs some of the build's steps and reads ${listed} as part of a command, so the build would stop partway.`
    : `Windows' compiler can't open files whose paths are 260 characters or more, and the build ` +
      `reaches ${problem.deepest} characters deeper than this folder.`;
  closeModal();
  $('path-too-long').showModal();
  return true;
}
$('path-show-folder').addEventListener('click', () => window.colo.showPathFolder().catch(showError));

function showMacHelp() {
  closeModal();
  $('mac-tools-help').showModal();
}

for (const id of ['mac-setup-help', 'mac-tools-settings']) $(id).addEventListener('click', showMacHelp);
$('check-mac-tools').addEventListener('click', async () => {
  $('check-mac-tools').disabled = true;
  $('mac-check-result').textContent = 'Checking tools…';
  try { refresh(await window.colo.checkTools()); }
  catch (error) { showError(error); }
  finally { $('check-mac-tools').disabled = false; }
});

// Electron prefixes errors thrown in the main process with the IPC channel:
// "Error invoking remote method 'import-dolphin-save': Error: <message>".
function errorText(error) {
  return String(error?.message || error).replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, '');
}
function showError(error) { closeModal(); setMessage(errorText(error), true); }

// Actions that build the game or need its build tools. Play only builds when
// the game isn't set up, needs HD visuals, or updates automatically.
function needsBuild(method) {
  if (method === 'launchGame') return !current.binaryReady || !current.hdVisualsReady ||
    Boolean(current.config.settings.autoUpdate && current.game.needsUpdate);
  return ['installPort', 'installTextures', 'makePbrModels', 'build', 'setupGame', 'prepareGame', 'updateAndPlay', 'updatePort'].includes(method);
}

async function action(method) {
  setMessage('');
  // In a folder too deep for Windows, explain instead of starting a build that would fail.
  if (current?.pathProblem && needsBuild(method)) { showPathProblem(); return; }
  try {
    if (['installPort', 'installTextures', 'makePbrModels', 'build', 'setupGame', 'prepareGame', 'launchGame', 'updateAndPlay', 'updatePort', 'play', 'playPrevious'].includes(method))
      setConsoleFollowing(true);
    const result = await window.colo[method]();
    if (result && result.config) refresh(result);
    await sync();
    if (['installPort', 'chooseRepo'].includes(method) && current.repoReady && current.tools.ready && wizardStep === 1) wizardStep = 2;
    if (method === 'chooseRom' && current.romReady && wizardStep === 2) wizardStep = 3;
    refresh(current);
  } catch (error) {
    showError(error);
    await sync();
    if (errorText(error) === current.pathProblem?.message) showPathProblem();
  }
}

function runWizardAction(method) {
  setupPending = true;
  refresh(current);
  action(method).finally(() => { setupPending = false; if (current) refresh(current); });
}

function renderTheme() { $('shell').classList.toggle('dark', $('darkMode').checked); }
$('darkMode').addEventListener('input', renderTheme);

function renderRanges() {
  $('brightness-value').textContent = `${$('brightness').value}%`;
  $('sharpen-value').textContent = Number($('sharpen').value) ? `${$('sharpen').value}%` : 'Off';
  $('battleSpeed-value').textContent = `${Number($('battleSpeed').value).toFixed(1)}×`;
}

// Same as the launcher and Primary, and a monitor chosen in the game's own settings menu (monitor2, ...).
function renderDisplays(chosen) {
  const option = (value, label) => { const item = document.createElement('option'); item.value = value; item.textContent = label; return item; };
  const match = /^monitor(\d+)$/.exec(chosen || '');
  $('display').replaceChildren(option('launcher', 'Same as the launcher'), option('primary', 'Primary monitor'),
    ...match ? [option(chosen, `Monitor ${match[1]} (chosen in the game)`)] : []);
}

// Exclusive fullscreen sizes up to this screen's own (the game picks the closest mode the display has).
function renderExclusiveResolutions(chosen) {
  // screen sizes ignore page zoom, but devicePixelRatio includes it.
  const display = globalThis.screen || { width: 1920, height: 1080 }, scale = (globalThis.devicePixelRatio || 1) / window.colo.zoomFactor();
  const nativeWidth = Math.round(display.width * scale), nativeHeight = Math.round(display.height * scale);
  const sizes = ['1280x720', '1600x900', '1920x1080', '2560x1080', '2560x1440', '3440x1440', '3840x2160']
    .filter(size => { const [w, h] = size.split('x').map(Number); return w <= nativeWidth && h <= nativeHeight; });
  if (chosen && chosen !== 'desktop' && !sizes.includes(chosen)) sizes.push(chosen);
  const option = (value, label) => { const item = document.createElement('option'); item.value = value; item.textContent = label; return item; };
  $('exclusiveResolution').replaceChildren(option('desktop', `Desktop (${nativeWidth}×${nativeHeight})`),
    ...sizes.map(size => option(size, size.replace('x', '×'))));
}

// Choices that only matter with another one on are dimmed until then.
function renderDependents(busy = false) {
  // which controller's prompts Automatic switches to
  $('promptPad').disabled = busy || $('buttonPrompts').value !== 'auto';
  $('battleSpeed').disabled = busy || $('skipBattleAnimations').checked;
  $('fullscreenMode').disabled = busy || !$('fullscreen').checked;
  $('exclusiveResolution').disabled = busy || !$('fullscreen').checked || $('fullscreenMode').value !== 'exclusive';
  // the game keeps its battle panels in the middle in 4:3
  $('hudEdges').disabled = busy || $('widescreen').value === '4:3';
  // FSR 1's quality sets the internal resolution, in place of Resolution
  const fsr = ['fsr', 'nis'].includes($('presentFilter').value);
  $('fsrMode').disabled = busy || !fsr;
  $('fsr-hint').hidden = !fsr;
  $('resolution').disabled = busy || fsr;
  $('textureLoading').disabled = busy || !$('textures').checked;
  $('texture-loading-hint').textContent = {
    stage: 'Before each area: an area\'s HD textures load with it, so they don\'t pop in while you play.',
    all: 'Whole pack: every HD texture loads during the first few loading screens and stays, so after that none load at all. Needs a graphics card with 6 GB of memory or more.',
    play: 'While playing: each HD texture loads when it first appears, using the least memory. The original shows until it is ready.'
  }[$('textureLoading').value];
}

function settingsValue() {
  const value = { keyBindings, padBindings, stickDeadzone: Number($('stickDeadzone').value),
    triggerClick: Number($('triggerClick').value), rumbleStrength: Number($('rumbleStrength').value), gbaVolume: Number($('gbaVolume').value),
    graphicsPreset: $('graphicsPreset').value };
  for (const key of SELECTS) value[key] = $(key).value;
  for (const key of SWITCHES) value[key] = $(key).checked;
  return value;
}

// Battle Revolution assets (each Pokémon's models, icons and cry): the disc chosen, and how many of the wanted Pokémon
// have theirs; while they're being made, how far that has got (the progress bar's detail, as the Home page shows it).
const PBR_LABEL = 'Make Battle Revolution assets';
function pbrProgress(active) {
  if (active?.label !== PBR_LABEL) return null;
  const detail = active.detail && active.detail !== 'Starting…' ? active.detail : 'Starting';
  return `${detail}${Number.isFinite(active.percent) ? ` (${active.percent}%)` : '…'}`;
}

// What the game makes from the disc: models and icons, and cries where it has them (pbr.cries)
function pbrAssets(pbr, icons = false) { return pbr.cries ? (icons ? 'models, icons and cries' : 'models and cries') : (icons ? 'models and icons' : 'models'); }

function renderPbr(data) {
  const pbr = data.pbr || {};
  $('pbr-note').textContent = pbrProgress(data.active)
    || (!pbr.supported ? 'Update your game to make models from your own Pokémon Battle Revolution disc.'
      : !pbr.wanted ? `Turn on Generation 4 Pokémon above, then make their ${pbrAssets(pbr)} from your own Pokémon Battle Revolution disc. No Blender needed.`
        : !pbr.disc ? `Choose your own Pokémon Battle Revolution disc (RVZ, ISO or WBFS) and their ${pbrAssets(pbr, true)} are made from it. Until then, each has a Colosseum Pokémon standing in. ${pbr.made} of ${pbr.wanted} made.`
          : pbr.outdated ? `${pbr.disc}: ${pbr.made} of ${pbr.wanted} made. A fix changed ${pbr.outdated === 1 ? '1 Pokémon\'s model' : `${pbr.outdated} Pokémon's models`}: press Make assets to make ${pbr.outdated === 1 ? 'it' : 'them'} again.`
            : pbr.noCry ? `${pbr.disc}: ${pbr.made} of ${pbr.wanted} made. ${pbr.noCry === 1 ? '1 Pokémon has' : `${pbr.noCry} Pokémon have`} a model but no cry of its own yet: press Make assets to add ${pbr.noCry === 1 ? 'it' : 'them'}.`
              : `${pbr.disc}: ${pbr.made} of ${pbr.wanted} made. Making them takes a few minutes, and only makes what's missing.`);
  $('make-pbr-models').disabled = Boolean(data.active) || !pbr.supported || !pbr.wanted || !pbrDiscUsable(pbr);
  $('choose-pbr-disc').disabled = Boolean(data.active);
  renderPbrCheck('pbr-check', pbr);
  renderPbrBanner(data);
}

// The disc chosen is there and is Battle Revolution
function pbrDiscUsable(pbr) { return Boolean(pbr?.discFound && !pbr.discProblem); }
function fileName(file) { return String(file || '').split(/[\\/]/).pop(); }

// What the last disc chosen was, or what is wrong with the one kept, in a banner under the Battle Revolution row (and
// in the disc offer): a wrong file was otherwise turned away, or failed minutes into making the assets, with the reason
// only in the activity log. Each can be dismissed; a new choice shows again.
let pbrCheckDismissed = null;
function pbrCheck(pbr) {
  const choice = pbr.choice;
  if (choice && !choice.ok) return { kind: 'error', key: `choice:${choice.at}`, title: `${fileName(choice.file)} can't be used`,
    detail: `${choice.message}${pbr.disc && pbrDiscUsable(pbr) ? ` Your disc stays ${fileName(pbr.disc)}.` : ''}` };
  if (pbr.disc && pbr.discProblem) return { kind: 'error', key: `problem:${pbr.disc}:${pbr.discProblem}`, title: 'Your Battle Revolution disc can\'t be used',
    detail: `${fileName(pbr.disc)}: ${pbr.discProblem}` };
  if (pbr.disc && !pbr.discFound) return { kind: 'warn', key: `missing:${pbr.disc}`, title: 'Your Battle Revolution disc isn\'t where it was',
    detail: `${pbr.disc} can't be found. Choose it again.` };
  if (choice?.ok && choice.file === pbr.disc) return { kind: choice.warning ? 'warn' : 'ok', key: `choice:${choice.at}`,
    title: choice.warning ? 'Battle Revolution disc found, but check it' : 'Battle Revolution disc found', detail: choice.message };
  return null;
}
function renderPbrCheck(id, pbr, { dismissible = true } = {}) {
  const check = pbrCheck(pbr || {});
  const show = Boolean(check && !(dismissible && pbrCheckDismissed === check.key));
  $(id).hidden = !show;
  if (!show) return;
  $(id).classList.toggle('ok', check.kind === 'ok');
  $(id).classList.toggle('warn', check.kind === 'warn');
  $(id).dataset.key = check.key;
  $(`${id}-title`).textContent = check.title;
  $(`${id}-detail`).textContent = check.detail;
}

// Above Play: models made before a converter fix that changed them, Pokémon whose models were made before the game made
// cries (or some not made yet, as when making them stopped), with a button that makes them, so a player doesn't keep the
// broken ones, or a stand-in's cry, without knowing.
function renderPbrBanner(data) {
  const pbr = data.pbr || {}, making = Boolean(pbrProgress(data.active));
  const missing = (pbr.wanted || 0) - (pbr.made || 0) - (pbr.outdated || 0) - (pbr.noCry || 0);
  // hidden while they're being made: the progress bar below shows that
  const show = Boolean(pbr.supported && pbr.wanted && pbr.disc && !making && (pbr.discProblem || pbr.outdated || pbr.noCry || (missing > 0 && pbr.made > 0)));
  $('pbr-banner').hidden = !show;
  if (!show) return;
  const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  $('pbr-banner-title').textContent = pbr.discProblem ? 'Your Battle Revolution disc can\'t be used'
    : pbr.outdated ? 'Your Battle Revolution assets need making again'
    : !missing && pbr.noCry ? 'Your Generation 4 Pokémon can have their own cries' : 'Some Battle Revolution assets aren\'t made yet';
  $('pbr-banner-detail').textContent = (pbr.discProblem && pbr.discFound
    ? `${pbr.discProblem} Choose it under Settings → Gameplay.`
    : !pbr.discFound ? `Your Battle Revolution disc isn't where it was. Choose it again under Settings → Gameplay, then make them.`
    : pbr.outdated ? `A fix changed ${count(pbr.outdated, 'Generation 4 Pokémon\'s model', 'Generation 4 Pokémon\'s models')}. Until they're made again, they look as they did before the fix.`
      : !missing && pbr.noCry ? `${count(pbr.noCry, 'Generation 4 Pokémon cries', 'Generation 4 Pokémon cry')} with a Colosseum Pokémon's voice. Battle Revolution's own is on your disc.`
        : `${count(missing, 'Generation 4 Pokémon has', 'Generation 4 Pokémon have')} no model of its own yet.`);
  $('pbr-banner-make').textContent = pbrDiscUsable(pbr) ? 'Make assets' : 'Open Settings';
  $('pbr-banner-make').disabled = Boolean(data.active);
}

// Choosing the disc starts making the assets it has for the Pokémon still without theirs, so it's one step. The
// launcher checks the file first: one that isn't Battle Revolution is turned away, and the banner says why. Returns
// the check ({ ok, file, message }), or null when the player closed the file picker.
async function choosePbrDisc() {
  const before = current?.pbr?.disc, last = current?.pbr?.choice?.at;
  pbrCheckDismissed = null;
  await action('choosePbrDisc');
  const pbr = current?.pbr || {};
  const choice = pbr.choice && pbr.choice.at !== last ? pbr.choice : null;
  if (choice?.ok && !current?.active && pbrDiscUsable(pbr) && pbr.disc !== before && pbr.supported && pbr.made < pbr.wanted) action('makePbrModels');
  return choice;
}

// Turning on Generation 4 Pokémon asks for the Battle Revolution disc their models and cries come from, and says what
// they look like without it. Not asked when they all have them already, or when this game can't make them.
function offerPbrModels() {
  const pbr = current?.pbr || {};
  if (!gameHas(current, 'pbrAssets') || current?.active || !pbr.supported || !pbr.wanted || pbr.made >= pbr.wanted) return;
  const remake = pbr.made > 0 || pbr.outdated > 0 || pbr.noCry > 0;
  $('pbr-offer-check').hidden = true;
  if (pbr.disc && !pbrDiscUsable(pbr)) renderPbrCheck('pbr-offer-check', pbr, { dismissible: false });
  $('pbr-offer-lead').textContent = pbrDiscUsable(pbr)
    ? `Your Battle Revolution disc is chosen: ${pbr.disc}. Make ${remake ? 'what\'s still missing' : `their ${pbrAssets(pbr, true)}`} from it now? It takes a few minutes.`
    : `Each one can have its own ${pbr.cries ? 'model, icons and cry' : 'model and icons'}, as in Pokémon Battle Revolution, made from a file of your own Wii disc (RVZ, ISO or WBFS). Choose it and they're made in a few minutes. No Blender needed.`;
  $('pbr-offer-confirm').textContent = pbrDiscUsable(pbr) ? 'Make assets' : pbr.disc ? 'Choose another file' : 'Choose disc';
  closeModal();
  $('pbr-offer').showModal();
}

// What the randomizer will do, and what the save on the card already is: the save wins.
function renderRandomizer(data) {
  const { run, exists } = data.randomizerSave || {}, ready = data.randomizerReady !== false;
  $('randomizer-options').hidden = !data.config.settings.randomizer;
  $('randomizer-spoilers').hidden = !run;
  $('randomizer-spoilers').disabled = Boolean(data.active);
  $('randomizer-reroll').disabled = Boolean(data.active);
  // The fourth generation's Pokémon are the randomizer's to choose only once they're added, by a game that knows them
  const settings = data.config.settings, gen4Pokemon = Boolean(settings.generation4Pokemon), gen4Game = data.randomizerGenerations !== false;
  $('randomizerGen4').disabled = !gen4Pokemon || !gen4Game;
  $('randomizer-gen4').classList.toggle('disabled', !gen4Pokemon || !gen4Game);
  $('randomizer-gen4-note').hidden = !settings.randomizerGen4 || (gen4Pokemon && gen4Game);
  $('randomizer-gen4-note').textContent = !gen4Pokemon ? 'Gen 4 counts once you turn on Generation 4 Pokémon, under Later generations.'
    : 'Update your game to have Gen 4 Pokémon in a randomized run.';
  // Pokémon packs' own Pokémon, which a run can have once the game can choose them
  const packsGame = data.randomizerPacks !== false;
  $('randomizerPacks').disabled = !packsGame;
  $('randomizer-packs-note').textContent = !packsGame ? 'Update your game to have your Pokémon packs\' Pokémon in a randomized run.'
    : 'Your Pokémon packs\' Pokémon can be chosen too, whichever generations are ticked. Keep the same packs for the whole run: adding or removing one changes what it chooses. Anyone you share the seed with needs them too.';
  $('randomizer-save-note').textContent = !ready ? 'Update your game to use the randomizer. This version of the game plays every save as normal.'
    : run && (run.options & 64) ? `A randomized run with your Pokémon packs' Pokémon, seed ${run.seed}. Keep the packs it started with to play it as it was made; a New Game uses the settings above.`
    : run && (run.generations & 8) && !gen4Pokemon ? `A randomized run with Gen 4 Pokémon, seed ${run.seed}. Turn on Generation 4 Pokémon, under Later generations, to play it as it was made.`
    : run ? `A randomized run, seed ${run.seed}. It keeps this seed whatever is set here; a New Game uses the settings above.`
      : exists ? 'The normal game. It stays that way: settings here start with your next New Game.'
        : 'No save yet. A New Game uses the settings above.';
}

async function saveSettings() {
  if (changing) return;
  try { refresh(await window.colo.saveSettings(settingsValue())); }
  // A refused change (a task started) must not stay shown as if it were saved.
  catch (error) { if (current) refresh(current); showError(error); }
}

function appendLog(entry) {
  if (entry.sequence <= activityLog.resetSequence()) return;
  activityLog.merge(entry);
  if (entry.stream === 'launcher' && /^(✕|Uncaught launcher error:)/.test(entry.text)) {
    consoleFailed = true;
    renderConsoleState(current?.active);
    setConsoleOpen(true);
  }
  scheduleLogRender();
}

function scheduleLogRender() {
  if (logRenderPending) return;
  logRenderPending = true;
  requestAnimationFrame(() => {
    logRenderPending = false;
    const log = $('log');
    const entries = activityLog.snapshot();
    log.replaceChildren(...entries.map(entry => {
      const line = document.createElement('span');
      line.className = `log-line log-${entry.stream}${entry.stream === 'launcher' && entry.text.startsWith('✕') ? ' log-error' : ''}`;
      line.textContent = window.coloActivityLog.formatEntry(entry) + '\n';
      return line;
    }));
    $('console-empty').hidden = Boolean(entries.length);
    $('console-entry-count').textContent = `${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}`;
    if (consoleFollowing) log.scrollTop = log.scrollHeight;
  });
}

function resetLog(sequence) {
  if (sequence <= activityLog.resetSequence()) return;
  activityLog.reset(sequence);
  $('log').textContent = '';
  $('copy-log-result').textContent = '';
  $('copy-activity-log').textContent = 'Copy log';
  consoleFailed = false;
  setConsoleFollowing(true);
  renderConsoleState(current?.active);
  scheduleLogRender();
}

for (const [id, method] of Object.entries({
  'choose-rom': 'chooseRom', 'choose-rom-settings': 'chooseRom',
  'choose-repo-settings': 'chooseRepo', 'choose-location': 'chooseLocation',
  'play-installed': 'play', 'play-previous': 'playPrevious', 'build': 'build',
  'clean-preview': 'cleanPreview', clean: 'clean', 'remove-build-tools': 'removeBuildTools', 'backup-saves': 'backupSaves',
  'open-backups': 'openBackups', stop: 'stop'
})) $(id).addEventListener('click', () => action(method));
// Update game (Settings) builds the new game and stays in the launcher.
async function updateOnly() {
  await action('updatePort');
  if (current.binaryReady && !current.game.needsUpdate && !current.active)
    setMessage(`Updated to game ${current.game.installedVersion || current.game.availableVersion}. Play whenever you're ready.`);
}
$('update-port').addEventListener('click', updateOnly);
// The Play menu's Update only / Prepare only gets everything Play would first, so Play later starts straight away.
async function prepareOnly() {
  const update = current.binaryReady;
  setupPending = true;
  refresh(current);
  try { await action('prepareGame'); } finally { setupPending = false; if (current) refresh(current); }
  if (current.binaryReady && !current.game.needsUpdate && !current.active)
    setMessage(update ? `Updated to game ${current.game.installedVersion || current.game.availableVersion}. Play whenever you're ready.`
      : 'The game is ready. Play whenever you\'re ready.');
}
// The menu sits in the top layer, above the panel that would clip it, and closes on a click outside or Escape.
$('play-menu').addEventListener('beforetoggle', event => {
  if (event.newState !== 'open') return;
  const anchor = $('play').getBoundingClientRect();
  $('play-menu').style.left = `${anchor.left}px`;
  $('play-menu').style.bottom = `${window.innerHeight - anchor.top + 10}px`;
});
$('play-menu').addEventListener('toggle', event => {
  playMenuOpen = event.newState === 'open';
  $('play-more').setAttribute('aria-expanded', String(playMenuOpen));
  if (playMenuOpen) playMenuItems()[0]?.focus();
});
const playMenuItems = () => [...$('play-menu').querySelectorAll('.play-menu-item')].filter(item => !item.hidden);
$('play-menu').addEventListener('keydown', event => {
  const items = playMenuItems(), step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
  if (!step) return;
  event.preventDefault();
  items[(items.indexOf(document.activeElement) + step + items.length) % items.length]?.focus();
});
function closePlayMenu() {
  if (!playMenuOpen) return false;
  $('play-menu').hidePopover();
  $('play-more').focus();
  return true;
}
for (const [id, run] of Object.entries({
  'menu-default': () => $('play').click(),
  'menu-update-play': () => runWizardAction('updateAndPlay'),
  'menu-update-only': prepareOnly,
  'menu-play-now': () => action('play')
})) $(id).addEventListener('click', () => { $('play-menu').hidePopover(); run(); });

// --- Changelog: changelog.json in the launcher repository (src/changelog.js). Each release lists its
// launcher changes and the game it pins. After an update it opens once on the newest release since the last.
// Beta builds also get Beta's hand-written notes, shown again whenever they change.
// Beta and the releases are listed down the left; the chosen one shows its launcher and game changes side
// by side, each as a bold headline over its details (src/changelog-text.js), with its fixes as a checklist.
function changelogDate(date) {
  return date ? new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '';
}
function changelogNode(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}
// Long details are cut to a few lines; those changes open in full on a click, or A on a controller.
function changelogToggle(change) {
  if (!change.classList.contains('can-open')) return;
  const open = !change.classList.contains('open');
  change.classList.toggle('open', open);
  change.setAttribute('aria-expanded', String(open));
}
function changelogClamps() {
  for (const change of $('changelog-columns').querySelectorAll('.changelog-change')) {
    const open = change.classList.contains('open');
    const more = open || [...change.querySelectorAll('.changelog-clamp')].some(node => node.scrollHeight > node.clientHeight + 1);
    change.classList.toggle('can-open', more);
    if (more) { change.tabIndex = 0; change.setAttribute('role', 'button'); change.setAttribute('aria-expanded', String(open)); }
    else for (const name of ['tabindex', 'role', 'aria-expanded']) change.removeAttribute(name);
  }
}
window.addEventListener('resize', () => { if (page === 'changelog') changelogClamps(); });
function changelogChange(text, withTag) {
  const { tag, headline, runOn, body } = window.coloChangelogText.splitChange(text);
  const change = changelogNode('div', 'changelog-change');
  const head = changelogNode('p', 'changelog-headline');
  if (withTag && tag) head.append(changelogNode('span', `changelog-tag${tag === 'Multiplayer' ? ' multiplayer' : ''}`, tag));
  head.append(changelogNode('strong', null, headline));
  if (runOn) { head.append(runOn); head.classList.add('changelog-clamp'); }
  change.append(head);
  if (body) change.append(changelogNode('p', 'changelog-details changelog-clamp', body));
  change.addEventListener('click', () => changelogToggle(change));
  change.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); changelogToggle(change); }
  });
  return change;
}
function changelogColumn(heading, lines) {
  const column = changelogNode('section', 'changelog-column');
  const title = changelogNode('h3', null, heading);
  title.append(changelogNode('span', 'changelog-count', String(lines.length)));
  const fixed = line => window.coloChangelogText.splitChange(line).fix;
  column.append(title, ...lines.filter(line => !fixed(line)).map(line => changelogChange(line, true)));
  const fixes = lines.filter(fixed);
  if (fixes.length) {
    const list = changelogNode('ul', 'changelog-fixes');
    list.append(...fixes.map(line => { const item = changelogNode('li'); item.append(changelogChange(line, false)); return item; }));
    column.append(changelogNode('h4', null, `Fixes · ${fixes.length}`), list);
  }
  return column;
}
// Beta first when this build has its notes, then every release, newest first.
function changelogEntries(data) {
  const entries = data.releases.map(release => ({ key: release.version, release,
    hotfixOf: data.releases.find(other => other.version === release.hotfixFor) || null,
    badge: data.unseen.includes(release.version) ? ['New', 'badge good'] : release.version === data.current ? ['Installed', 'badge'] : null }));
  if (data.beta) entries.unshift({ key: 'beta', beta: data.beta, badge: data.beta.unseen ? ['New', 'badge good'] : ['Not released yet', 'badge warn'] });
  return entries;
}
let changelogButtons = [];
function changelogStatus(text) {
  $('changelog-status').textContent = text;
  $('changelog-status').hidden = false;
  $('changelog-head').hidden = true;
  $('changelog-columns').replaceChildren();
}
function changelogShow(entry) {
  for (const button of changelogButtons) {
    const active = button.dataset.key === entry.key;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'true'); else button.removeAttribute('aria-current');
  }
  const release = entry.release;
  $('changelog-status').hidden = true;
  $('changelog-head').hidden = false;
  $('changelog-version').textContent = entry.beta ? 'Beta' : `v${release.version}`;
  $('changelog-badge').hidden = !entry.badge;
  if (entry.badge) [$('changelog-badge').textContent, $('changelog-badge').className] = entry.badge;
  $('changelog-meta').textContent = entry.beta ? 'In this Beta build, not in a release yet. Beta uses the newest game from its main branch.'
    : [changelogDate(release.date), release.game?.version && `Game ${release.game.version}`, release.title].filter(Boolean).join(' · ');
  const launcher = entry.beta ? entry.beta.launcher : release.launcher, game = entry.beta ? entry.beta.game : release.game?.changes || [];
  const columns = (launcherLines, gameLines) => [['Launcher', launcherLines], ['Game', gameLines]]
    .filter(([, lines]) => lines.length).map(([heading, lines]) => changelogColumn(heading, lines));
  // A hotfix: the fix in its own box, then the release it fixes in full, so its notes stay in view.
  const base = entry.hotfixOf;
  $('changelog-columns').classList.toggle('changelog-full', Boolean(base));
  if (base) {
    const fix = changelogNode('div', 'changelog-hotfix');
    fix.append(changelogNode('p', 'changelog-hotfix-label', release.title || 'Hotfix'),
      ...[...game, ...launcher].map(line => changelogChange(line, false)));
    const heading = changelogNode('div', 'changelog-base-head');
    heading.append(changelogNode('h3', null, `Everything new in v${base.version}`),
      changelogNode('p', null, [changelogDate(base.date), base.game?.version && `Game ${base.game.version}`].filter(Boolean).join(' · ')));
    $('changelog-columns').replaceChildren(fix, heading, ...columns(base.launcher, base.game?.changes || []));
  } else {
    $('changelog-columns').replaceChildren(...columns(launcher, game));
  }
  $('changelog-detail').scrollTop = 0;
  requestAnimationFrame(changelogClamps);
}
function renderChangelog(data, onlyUnseen) {
  const entries = changelogEntries(data);
  const unseen = entries.filter(entry => entry.badge?.[0] === 'New'), releases = unseen.filter(entry => entry.release);
  $('changelog-title').textContent = !onlyUnseen ? "What's new" : releases.length ? `Updated to v${data.current}` : "What's new in Beta";
  $('changelog-subtitle').textContent = !onlyUnseen ? 'Launcher and game updates'
    : releases.length ? `What's new in the launcher and game since you last opened it.` : "Changes in this Beta that aren't in a release yet.";
  changelogButtons = entries.map(entry => {
    const button = changelogNode('button', `changelog-version${entry.beta ? ' beta' : ''}`);
    button.dataset.key = entry.key;
    const name = changelogNode('span', 'changelog-version-name');
    name.append(changelogNode('strong', null, entry.beta ? 'Beta' : `v${entry.release.version}`));
    if (entry.release && entry.badge) {
      const dot = changelogNode('i', `changelog-dot${entry.badge[0] === 'New' ? ' new' : ''}`);
      dot.title = entry.badge[0];
      name.append(dot);
    }
    button.append(name, changelogNode('small', null, entry.beta ? (entry.beta.unseen ? 'New notes' : 'Not released yet') : changelogDate(entry.release.date)));
    button.addEventListener('click', () => changelogShow(entry));
    return button;
  });
  $('changelog-nav').replaceChildren(...changelogButtons);
  if (!entries.length) return changelogStatus('No changes are listed yet.');
  // After an update, the newest release since the last (or Beta's new notes); otherwise the top of the list.
  changelogShow(onlyUnseen ? releases[0] || unseen[0] || entries[0] : entries[0]);
}
// The What's new tab shows every release; after an update it opens on the newest one.
let changelogUnseen = false;
async function showChangelog() {
  if (changelogUnseen) { changelogUnseen = false; return; }
  $('changelog-title').textContent = "What's new";
  $('changelog-subtitle').textContent = 'Launcher and game updates';
  $('changelog-nav').replaceChildren();
  changelogStatus('Loading…');
  try { renderChangelog(await window.colo.changelog(), false); }
  catch (_) { changelogStatus("The changelog couldn't be loaded. Try again later."); }
}
onPage('changelog', { show() { $('changelog-new').hidden = true; showChangelog(); } });
// Opens once per update. Away from Play, over another window or during a running task it waits for the next start.
async function showWhatsNew() {
  try {
    const data = await window.colo.changelog();
    if (data.unseen.length || data.beta?.unseen) {
      // Not opened now: the What's new button keeps a dot until it is.
      $('changelog-new').hidden = page === 'changelog';
      if (current?.active || page !== 'play' || [...document.querySelectorAll('.launcher-modal')].some(dialog => dialog.open)) return;
      renderChangelog(data, true);
      changelogUnseen = true;
      showPage('changelog');
    }
    await window.colo.markChangelogSeen();
  } catch (_) { /* the changelog button still works */ }
}
$('changelog-page').addEventListener('click', () => window.colo.openChangelogPage().catch(error => setMessage(errorText(error))));
// The invite opens in the browser, even while the game builds or runs.
$('discord').addEventListener('click', () => window.colo.openDiscord().catch(error => setMessage(errorText(error))));
// --- Graphics presets (src/presets.js). Choosing one sets its picture settings; the settings
// file keeps the choice only while they still match it (port.js), so a change by hand shows Custom.
if (globalThis.ColoPresets) $('graphicsPreset').replaceChildren(...ColoPresets.CHOICES.map(({ id, label }) => {
  const option = document.createElement('option'); option.value = id; option.textContent = label; return option;
}));
function renderPreset() {
  if (!globalThis.ColoPresets) return;
  $('graphicsPreset-detail').textContent = ColoPresets.CHOICES.find(choice => choice.id === $('graphicsPreset').value)?.detail || '';
}
$('graphicsPreset').addEventListener('change', () => {
  const preset = globalThis.ColoPresets && ColoPresets.find($('graphicsPreset').value);
  if (preset) for (const [key, value] of Object.entries(preset.values)) {
    if (typeof value === 'boolean') $(key).checked = value;
    else $(key).value = String(value);
  }
  renderRanges();
  renderDependents();
  renderPreset();
  saveSettings();
});

function renderCrashReports({ count, newest, folder }) {
  $('crash-reports-note').textContent = count
    ? `${count === 1 ? 'One report' : `${count} reports`} from the game, the newest from ${new Date(newest).toLocaleString()}. They stay on this computer until you share one.`
    : `None so far. If the game crashes, its report is saved in ${folder}.`;
  $('copy-crash-report').disabled = !count;
}
$('copy-crash-report').addEventListener('click', async () => {
  try { await window.colo.copyCrashReport(); $('crash-report-result').textContent = 'Copied.'; }
  catch (error) { showError(error); }
});
$('open-crash-reports').addEventListener('click', () => window.colo.openCrashReports().catch(showError));

// Steam, the banner on Play: Add to Steam while the launcher can add
// itself and is not in the library yet, then a tick once it is there. Selecting
// the tick updates the shortcut's artwork and Skip Launcher. A shortcut made by
// hand without --no-sandbox, which won't open in Game Mode, shows a fix instead.
const STEAM_DETAIL = $('steam-banner-detail').textContent;
let steam = {};
function steamBannerText() {
  if (steam.needsFix) return { title: 'Fix for Game Mode', mark: '!', detail: steam.available
    ? "Steam's shortcut is missing --no-sandbox. Select to fix it" : 'In Steam, add --no-sandbox to its launch options' };
  if (steam.inSteam) return { title: 'In your Steam library', mark: '✓', detail: steam.available
    ? 'Select to update its artwork or Skip Launcher' : 'Play from Steam, Big Picture or Game Mode' };
  return { title: 'Add to Steam', mark: '+', detail: STEAM_DETAIL };
}
function renderSteamBanner() {
  const banner = $('add-to-steam'), text = steamBannerText();
  banner.hidden = !steam.available && !steam.inSteam;
  banner.classList.toggle('in-steam', Boolean(steam.inSteam) && !steam.needsFix);
  banner.classList.toggle('needs-fix', Boolean(steam.needsFix));
  banner.disabled = !steam.available;
  $('steam-banner-title').textContent = text.title;
  $('steam-banner-detail').textContent = text.detail;
  $('steam-banner-mark').textContent = text.mark;
  banner.setAttribute('aria-label', `${text.title}. ${text.detail}`);
}
async function refreshSteamBanner() {
  try { steam = await window.colo.steamStatus() || {}; } catch { steam = {}; }
  renderSteamBanner();
}
// One Steam dialog: from the banner (add, or update once in Steam), or offered
// once by Play on SteamOS, which then plays whatever the player chooses.
const STEAM_MODES = {
  add: { kicker: 'Add to Steam', intro: 'Adds Pokémon Colosseum to your Steam library, with artwork.', cancel: 'Cancel', confirm: 'Add to Steam' },
  update: { kicker: 'In your Steam library', intro: "It's already in Steam. Update it to refresh its artwork, or to turn Skip Launcher on or off.",
    cancel: 'Cancel', confirm: 'Update in Steam' },
  offer: { kicker: 'Play from Steam?', intro: "Add Pokémon Colosseum to your Steam library and start it from Game Mode like your other games. We'll only ask once: the Add to Steam banner on the home screen does it any time.",
    cancel: 'Not now', confirm: 'Add to Steam & play' },
  fix: { kicker: 'Fix for Game Mode', intro: "Pokémon Colosseum is in your Steam library, but its shortcut is missing the --no-sandbox launch option, so it won't open in Game Mode. Let the launcher fix it: it keeps the shortcut's play time, collections and controller layout, and adds the artwork.",
    cancel: 'Not now', confirm: 'Fix shortcut' }
};
let playAfterSteam = false;
function openSteamDialog(mode) {
  const text = STEAM_MODES[mode];
  $('steam-add-kicker').textContent = text.kicker;
  $('steam-add-intro').textContent = text.intro;
  $('steam-add-cancel').textContent = text.cancel;
  $('steam-add-confirm').textContent = text.confirm;
  $('steam-skip-launcher').checked = ['update', 'fix'].includes(mode) && Boolean(steam.skipLauncher);
  playAfterSteam = mode === 'offer';
  $('steam-add').showModal();
}
// Not now, Esc or × after Play's offer: play as the player asked.
$('steam-add').addEventListener('close', () => {
  if (!playAfterSteam) return;
  playAfterSteam = false;
  runWizardAction('launchGame');
});
// Play's offer, on SteamOS while the launcher isn't in Steam yet. True when shown.
function offerSteam() {
  if (!steam.offer || current?.active) return false;
  steam.offer = false;
  window.colo.steamOffered('play').catch(() => {});
  openSteamDialog('offer');
  return true;
}
// Opening the launcher offers once to fix a shortcut without --no-sandbox.
function offerSteamFix() {
  if (!steam.offerFix || current?.active || page !== 'play' || [...document.querySelectorAll('.launcher-modal')].some(dialog => dialog.open)) return;
  steam.offerFix = false;
  window.colo.steamOffered('fix').catch(() => {});
  openSteamDialog('fix');
}
$('add-to-steam').addEventListener('click', () => openSteamDialog(steam.needsFix ? 'fix' : steam.inSteam ? 'update' : 'add'));
$('steam-add-confirm').addEventListener('click', async () => {
  const play = playAfterSteam, fixing = Boolean(steam.needsFix);
  playAfterSteam = false;
  $('steam-add').close();
  $('add-to-steam').disabled = true;
  $('steam-banner-detail').textContent = steam.needsFix ? 'Fixing in Steam…' : steam.inSteam ? 'Updating in Steam…' : 'Adding to Steam…';
  let failed = false;
  try {
    const done = await window.colo.addToSteam({ play: $('steam-skip-launcher').checked });
    if (done.cancelled) setMessage('Not added. Steam needs to close for a moment to add the launcher.');
    else {
      const art = done.artwork === done.total ? ' with its artwork'
        : done.artwork ? ` with ${done.artwork} of ${done.total} artwork images (SteamGridDB didn't send the rest)` : " without artwork (SteamGridDB couldn't be reached)";
      const skip = done.play ? ' It starts the game straight away; open the launcher itself now and then for launcher updates.' : '';
      setMessage(fixing ? `Fixed "${done.name}" in Steam${art}: it opens in Game Mode now. ${done.reopened ? 'Steam is opening again.' : 'Open Steam to find it.'}${skip}`
        : `${done.added ? 'Added' : 'Updated'} "${done.name}" in your Steam library${art}. ${done.reopened ? 'Steam is opening again.' : 'Open Steam to find it.'}${skip}`);
    }
  } catch (error) { failed = true; showError(error); }
  finally {
    await refreshSteamBanner();
    await sync();
  }
  // Play's offer plays afterwards, keeping the Steam message in view; an error stays to be read.
  if (play && !failed) {
    const shown = $('message-text').textContent;
    runWizardAction('launchGame');
    if (shown) setMessage(shown);
  }
});
refreshSteamBanner().then(offerSteamFix);

$('play').addEventListener('click', () => {
  if (wizardStep === 0) { if (!offerSteam()) runWizardAction('launchGame'); }
  else if (wizardStep === 1) {
    if (current.platform.id === 'macos' && !current.tools.appleReady) { showMacHelp(); return; }
    if (current.repoReady && current.tools.ready) { wizardStep = 2; refresh(current); }
    else runWizardAction('installPort');
  } else if (wizardStep === 2) {
    if (current.romReady) { wizardStep = 3; refresh(current); }
    else runWizardAction('chooseRom');
  } else runWizardAction('setupGame');
});
for (const button of document.querySelectorAll('[data-setup-back]')) button.addEventListener('click', () => {
  if (wizardStep > 1) { wizardStep -= 1; refresh(current); }
});
$('restore-saves').addEventListener('click', async () => {
  setMessage('');
  try { await window.colo.restoreSaves($('backup-list').value); await sync(); }
  catch (error) { showError(error); await sync(); }
});
async function importDolphinSave(files) {
  if (current?.active) return;
  const resultText = $('dolphin-import-result');
  resultText.textContent = '';
  try {
    const result = await window.colo.importDolphinSave(files);
    if (result.cancelled) resultText.textContent = 'Import cancelled.';
    else {
      const skipped = result.skipped.length ? ` Skipped ${result.skipped.map(save => `${save.file} (${save.reason})`).join(', ')}.` : '';
      resultText.textContent = `Imported ${result.trainer ? `${result.trainer}'s save` : 'the save'} from ${result.file}. Start the game to play it.${skipped}`;
    }
  } catch (error) { resultText.textContent = errorText(error); }
  await sync();
}
$('import-dolphin-save').addEventListener('click', () => importDolphinSave());
$('export-gci-save').addEventListener('click', async () => {
  const resultText = $('gci-export-result');
  resultText.textContent = '';
  try {
    const result = await window.colo.exportGciSave();
    if (result.cancelled) resultText.textContent = 'Export cancelled.';
    else {
      const warning = result.damaged ? ' Its newest progress could not be read, so the game will load the copy before it.' : '';
      const randomized = result.randomized ? ' This is a randomizer run: your team comes with it, but Dolphin plays the rest as the normal game.' : '';
      const n = result.extraBoxPokemon;
      const boxes = n ? ` Dolphin's game has 3 PC boxes, so ${n === 1 ? 'the Pokémon' : `the ${n} Pokémon`} in boxes 4 to 10 ${n === 1 ? 'is' : 'are'} not in this file.` : '';
      resultText.textContent = `Exported ${result.trainer ? `${result.trainer}'s save` : 'the save'} to ${result.file}.${warning}${randomized}${boxes}`;
    }
  } catch (error) { resultText.textContent = errorText(error); }
  await sync();
});
const dolphinDrop = $('dolphin-save-drop');
for (const type of ['dragenter', 'dragover']) dolphinDrop.addEventListener(type, event => {
  event.preventDefault();
  if (!current?.active) dolphinDrop.classList.add('drag-over');
});
for (const type of ['dragleave', 'drop']) dolphinDrop.addEventListener(type, event => {
  event.preventDefault();
  dolphinDrop.classList.remove('drag-over');
});
dolphinDrop.addEventListener('drop', event => {
  if (current?.active || !event.dataTransfer.files.length) return;
  importDolphinSave([...event.dataTransfer.files]);
});
// Prevent dropped files from navigating away from the launcher.
for (const type of ['dragover', 'drop']) window.addEventListener(type, event => event.preventDefault());
$('open-custom-textures').addEventListener('click', () => window.colo.openCustomTextures().catch(showError));
$('choose-pbr-disc').addEventListener('click', choosePbrDisc);
$('make-pbr-models').addEventListener('click', () => action('makePbrModels'));
$('pbr-check-close').addEventListener('click', () => { pbrCheckDismissed = $('pbr-check').dataset.key; $('pbr-check').hidden = true; });
$('pbr-banner-make').addEventListener('click', () => {
  if (pbrDiscUsable(current?.pbr)) action('makePbrModels');
  else { showPage('settings'); showSettingsTab('gameplay'); }
});
$('open-languages').addEventListener('click', () => window.colo.openLanguages().catch(showError));
for (const key of [...SELECTS, ...SWITCHES]) if (key !== 'generation4Pokemon') $(key).addEventListener('change', saveSettings);
$('generation4Pokemon').addEventListener('change', async () => {
  await saveSettings();
  if (current?.config.settings.generation4Pokemon) offerPbrModels();
});
// The offer stays open until a disc passes the check, showing why a file was turned away, so the player can choose
// another without finding the setting
$('pbr-offer-confirm').addEventListener('click', async () => {
  if (pbrDiscUsable(current?.pbr)) { $('pbr-offer').close(); action('makePbrModels'); return; }
  $('pbr-offer-confirm').disabled = true;
  try {
    const choice = await choosePbrDisc();
    if (choice?.ok) { $('pbr-offer').close(); return; }
    if (!choice) return;
    renderPbrCheck('pbr-offer-check', current?.pbr, { dismissible: false });
    $('pbr-offer-confirm').textContent = 'Choose another file';
    if (!$('pbr-offer').open) $('pbr-offer').showModal();
  } finally { $('pbr-offer-confirm').disabled = false; }
});
$('randomizer-reroll').addEventListener('click', async () => {
  try {
    $('randomizerSeed').value = await window.colo.randomizerNewSeed();
    await saveSettings();
  } catch (error) { showError(error); }
});
$('randomizer-spoilers').addEventListener('click', () => window.colo.randomizerSpoilers().catch(showError));
for (const key of ['sharpen', 'brightness', 'battleSpeed']) $(key).addEventListener('input', renderRanges);
for (const key of ['buttonPrompts', 'promptPad']) $(key).addEventListener('input', () => { renderPrompts(); renderDependents(); });
for (const key of ['skipBattleAnimations', 'fullscreen', 'fullscreenMode', 'widescreen', 'presentFilter', 'textures', 'textureLoading'])
  $(key).addEventListener('input', () => renderDependents());
window.colo.onLog(appendLog);
window.colo.onLogReset(resetLog);
window.colo.onActivity(value => {
  const changed = Boolean(value) !== Boolean(current?.active);
  // Update & play builds and then starts the game in one task: reread the versions once the new game boots.
  const gameStarted = isGameLabel(value?.label) && current?.active?.label !== value.label;
  if (current) current.active = value;
  renderActivity(value);
  // Lock the settings now: the next state (sync) can take a while to arrive.
  if (changed && current) refresh(current);
  if (changed || gameStarted) sync().catch(showError);
});
let checkingUpdates = false;
function renderAppUpdate(value) {
  $('app-update').textContent = value.message;
  $('install-app-update').hidden = value.state !== 'ready';
  $('check-updates').disabled = checkingUpdates || value.state === 'checking' || value.state === 'downloading';
}
// Check the launcher's update channel now, then reread the game's versions and the channel list.
async function checkForUpdates() {
  if (checkingUpdates) return;
  checkingUpdates = true;
  $('check-updates').disabled = true;
  $('check-updates').classList.add('checking');
  try {
    await window.colo.checkAppUpdate();
    await Promise.all([sync(), loadUpdateChannels()]);
  } catch (error) { showError(error); }
  finally {
    checkingUpdates = false;
    $('check-updates').classList.remove('checking');
    $('check-updates').disabled = false;
  }
}
window.colo.onAppUpdate(renderAppUpdate);
$('install-app-update').addEventListener('click', () => window.colo.installAppUpdate().catch(showError));
$('check-updates').addEventListener('click', checkForUpdates);
// The middle window button maximizes (the taskbar stays in view) or restores the window, and leaves full screen,
// which F11 switches.
const WINDOW_BUTTON = { normal: 'Maximize', maximized: 'Restore down', fullscreen: 'Exit full screen' };
function renderWindowState(value) {
  const state = value?.fullscreen ? 'fullscreen' : value?.maximized ? 'maximized' : 'normal';
  $('window-maximize').setAttribute('data-state', state);
  $('window-maximize').setAttribute('aria-label', state === 'normal' ? 'Maximize window' : WINDOW_BUTTON[state]);
  $('window-maximize').title = state === 'fullscreen' ? WINDOW_BUTTON[state] : `${WINDOW_BUTTON[state]} (F11: full screen)`;
}
$('window-minimize').addEventListener('click', () => window.colo.minimizeWindow());
$('window-maximize').addEventListener('click', () => window.colo.toggleMaximize().then(renderWindowState).catch(showError));
$('window-close').addEventListener('click', () => window.colo.closeWindow());
window.colo.onWindowState(renderWindowState);

// --- Controller navigation (src/gamepad-nav.js).
const openDialog = () => [...document.querySelectorAll('.launcher-modal[open]')].pop();
// LB / RB step through the Settings tabs on Settings, and through the launcher's tabs elsewhere.
function stepPage(step) {
  if (openDialog()) return;
  if (page === 'settings') {
    const target = settingsTabs[settingsTabs.indexOf(settingsTab) + step];
    if (!target) return;
    showSettingsTab(target);
    $(`tab-${target}`).focus();
    return;
  }
  const shown = pageOrder.filter(name => !$(pages[name].nav).hidden);
  const target = shown[shown.indexOf(page) + step];
  if (!target) return;
  showPage(target);
  $(pages[target].nav).focus();
}
function gamepadBack() {
  const dialog = openDialog();
  if (closePlayMenu()) return;
  if (dialog) dialog.close();
  else if (consoleOpen) setConsoleOpen(false);
  else if (page !== 'play') { showPage('play'); $('nav-play').focus(); }
  else [...document.querySelectorAll('[data-setup-back]')].find(button => !button.disabled && button.offsetParent)?.click();
}
// Escape goes back to Play, as it closed these pages when they were dialogs. Controls' key capture
// takes Escape first, and an open dialog closes itself.
window.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || event.defaultPrevented || capture || openDialog() || page === 'play') return;
  showPage('play');
});
// F11 (and Ctrl+Cmd+F on a Mac) switches the launcher's full screen, unless Controls is waiting for a key.
window.addEventListener('keydown', event => {
  const macFullScreen = event.metaKey && event.ctrlKey && event.key?.toLowerCase() === 'f';
  if ((event.key !== 'F11' && !macFullScreen) || event.defaultPrevented || capture || event.repeat) return;
  event.preventDefault();
  window.colo.toggleFullScreen().then(renderWindowState).catch(showError);
});
window.coloGamepadNav.start({
  document, window,
  regions: '.switch, .field',
  defaultFocus: () => [page === 'settings' ? $(`tab-${settingsTab}`) : page === 'play' ? $('play') : $(pages[page].nav), $('play'), $('settings-cog')],
  // The game reads the same controller, and Controls waits for a button to bind.
  paused: () => isGameLabel(current?.active?.label) || Boolean(capture),
  actions: {
    back: gamepadBack,
    menu: () => openDialog() ? closeModal() : showPage(page === 'settings' ? 'play' : 'settings'),
    view: () => consoleOpen ? setConsoleOpen(false) : showActivityLog(),
    previous: () => stepPage(-1),
    next: () => stepPage(1),
    alternate: () => { if (page === 'play' && !openDialog()) switchGame(); }
  }
});
window.colo.windowState().then(renderWindowState).catch(showError);
setInterval(() => { if (current?.active) renderActivity(current.active); }, 1000);
sync().then(() => { for (const line of current.logs) appendLog(line); if (!showPathProblem()) return showWhatsNew(); }).catch(showError);
