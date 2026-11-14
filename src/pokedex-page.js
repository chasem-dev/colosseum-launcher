// The Pokédex: every Pokémon on the player's disc, to browse and turn around in 3D. Nothing
// of it stays on the GPU while the page is hidden, and it holds still when left alone.
import { createViewer } from './model-viewer.js';
import { createCry } from './pokedex-cry.js';

const $ = id => document.getElementById(id);
const STATS = ['HP', 'Attack', 'Defense', 'Sp. Atk', 'Sp. Def', 'Speed'];
const MAX_STAT = 255;
// What the filters offer. Each Pokémon's status (pokedex.js) says where it belongs.
const FILTERS = [
  { id: 'all', label: 'All', matches: () => true },
  { id: 'available', label: 'Obtainable', matches: entry => !entry.status.locked },
  { id: 'battle', label: 'Battle only', matches: entry => entry.status.kind === 'battle' },
  { id: 'hidden', label: 'Hidden on disc', matches: entry => entry.status.kind === 'hidden' },
  { id: 'packs', label: 'Packs', matches: entry => entry.status.kind === 'pack', onlyWhenAny: true },
  { id: 'generations', label: 'Later generations', matches: entry => entry.status.kind === 'generation', onlyWhenAny: true },
];
// Clips this short are held poses the game blends into, not motions to watch (for a model whose header lists none).
const SHORTEST_MOTION = 20;
// What each kind of battle motion (hsd-model.js readHeader) is called here.
const MOTION_LABEL = { idle: 'Idle', physical: 'Physical move', special: 'Special move', hit: 'Hit', faint: 'Faint', extra: 'Extra' };

let species = null, packProblems = [], loading = null, visible = false, filter = 'all', selected = null, form = null, viewer = null;
// The newest choice: a slower answer to an older one is dropped.
let request = 0;
// Each entry's button, by its key: a disc Pokémon's National Pokédex number, or a pack Pokémon's "pack:<pack>/<folder>".
const entries = new Map();

const message = error => String(error?.message || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const number = national => `#${String(national).padStart(3, '0')}`;

function setStatus(text, { busy = false, retry = false } = {}) {
  $('pokedex-status-text').textContent = text;
  $('pokedex-status').classList.toggle('loading', busy);
  $('pokedex-retry').hidden = !retry;
  $('pokedex-status').hidden = !text;
}

// A fresh canvas for each view: one whose context was let go can't make another.
function startViewer() {
  if (viewer) return true;
  const canvas = $('pokedex-stage').cloneNode(false);
  canvas.classList.remove('ready');
  $('pokedex-stage').replaceWith(canvas);
  try { viewer = createViewer(canvas); }
  catch (_) {
    setStatus('The 3D view couldn\'t start. Try again, or restart the launcher to reset its graphics.', { retry: true });
    return false;
  }
  return true;
}

function stopViewer() {
  viewer?.dispose();
  viewer = null;
}

// --- The list ------------------------------------------------------------------------

function matches(entry, search) {
  if (!FILTERS.find(item => item.id === filter).matches(entry)) return false;
  if (!search) return true;
  return entry.name.toLowerCase().includes(search) || String(entry.national).padStart(3, '0').includes(search.replace(/^#/, ''));
}

function applyFilter() {
  const search = $('pokedex-search').value.trim().toLowerCase();
  let shown = 0;
  for (const entry of species) {
    const show = matches(entry, search);
    entries.get(entry.key).hidden = !show;
    if (show) shown++;
  }
  $('pokedex-empty').hidden = shown > 0;
}

function renderFilters() {
  $('pokedex-filters').replaceChildren(...FILTERS.filter(item => !item.onlyWhenAny || species.some(item.matches)).map(item => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'pokedex-filter';
    button.dataset.filter = item.id;
    button.setAttribute('aria-pressed', String(item.id === filter));
    const count = document.createElement('span');
    count.textContent = species.filter(item.matches).length;
    button.append(`${item.label} `, count);
    button.addEventListener('click', () => {
      filter = item.id;
      for (const other of $('pokedex-filters').children) other.setAttribute('aria-pressed', String(other === button));
      applyFilter();
    });
    return button;
  }));
}

function renderEntry(entry) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'pokedex-entry';
  button.dataset.kind = entry.status.kind;
  button.title = `${entry.name}: ${entry.status.label}`;
  if (entry.sprite) {
    const image = document.createElement('img');
    image.src = entry.sprite;
    image.alt = '';
    image.loading = 'lazy';
    image.width = image.height = 48;
    button.append(image);
  } else button.append(Object.assign(document.createElement('span'), { className: 'pokedex-no-sprite', textContent: '?' }));
  const label = document.createElement('span');
  label.className = 'pokedex-entry-label';
  const small = document.createElement('small');
  small.textContent = entry.pack && entry.status.kind === 'pack' ? `${number(entry.national)} · ${entry.pack.name}` : number(entry.national);
  const name = document.createElement('span');
  name.textContent = entry.name;
  label.append(small, name);
  button.append(label);
  if (entry.status.locked) {
    const lock = $('pokedex-availability').querySelector('.pokedex-lock').cloneNode(true);
    lock.classList.add('pokedex-entry-lock');
    button.append(lock);
  }
  button.addEventListener('click', () => select(entry));
  entries.set(entry.key, button);
  return button;
}

function renderList() {
  const disc = species.filter(entry => !entry.pack), available = disc.filter(entry => !entry.status.locked).length;
  const packs = species.filter(entry => entry.status.kind === 'pack').length, later = species.filter(entry => entry.status.kind === 'generation').length;
  $('pokedex-summary').textContent = `${disc.length} Pokémon on your disc. ${available} can be obtained in the game; the rest are locked away.` +
    (later ? ` ${later} more from later generations.` : '') +
    (packs ? ` ${packs} from your Pokémon packs.` : '');
  $('pokedex-pack-problems').hidden = !packProblems.length;
  $('pokedex-pack-problem-list').replaceChildren(...packProblems.map(text => Object.assign(document.createElement('li'), { textContent: text })));
  renderFilters();
  $('pokedex-list').replaceChildren(...species.map(renderEntry));
  applyFilter();
}

// --- The chosen Pokémon --------------------------------------------------------------

function renderInfo(entry) {
  $('pokedex-info').hidden = false;
  $('pokedex-number').textContent = number(entry.national);
  $('pokedex-name').textContent = entry.name;
  $('pokedex-types').replaceChildren(...entry.types.map(type => {
    const pill = document.createElement('span');
    pill.className = 'pokedex-type';
    pill.dataset.type = type.toLowerCase();
    pill.textContent = type;
    return pill;
  }));
  $('pokedex-availability').dataset.kind = entry.status.kind;
  $('pokedex-availability').classList.toggle('locked', entry.status.locked);
  $('pokedex-availability-label').textContent = entry.status.label;
  $('pokedex-availability-note').textContent = entry.status.note;
  $('pokedex-stats').replaceChildren(...entry.stats.flatMap((value, index) => {
    const label = document.createElement('dt'), row = document.createElement('dd'), bar = document.createElement('i'), text = document.createElement('span');
    label.textContent = STATS[index];
    text.textContent = value;
    bar.style.setProperty('--stat', `${Math.round(value / MAX_STAT * 100)}%`);
    row.append(text, bar);
    return [label, row];
  }));
  $('pokedex-height').textContent = entry.height;
  $('pokedex-weight').textContent = entry.weight;
  $('pokedex-abilities').textContent = entry.abilities.join(', ') || '—';
  const link = target => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'pokedex-evolution';
    button.textContent = target.name;
    button.addEventListener('click', () => { select(target); entries.get(target.key).scrollIntoView({ block: 'nearest' }); });
    return button;
  };
  const next = entry.evolutions.map(key => entries.has(key) ? species.find(item => item.key === key) : null).filter(Boolean);
  const previous = species.filter(item => item.key !== entry.key && item.evolutions.includes(entry.key));
  $('pokedex-evolves-label').hidden = $('pokedex-evolves').hidden = !next.length;
  $('pokedex-evolves').replaceChildren(...next.map(link));
  $('pokedex-evolves-from-label').hidden = $('pokedex-evolves-from').hidden = !previous.length;
  $('pokedex-evolves-from').replaceChildren(...previous.map(link));
}

function renderForms(entry) {
  $('pokedex-form-field').hidden = entry.forms.length < 2;
  $('pokedex-form').replaceChildren(...entry.forms.map(item => new Option(item.label, item.id)));
  $('pokedex-form').value = form;
}

// A model's motions to choose from: its battle motions, named by what the game plays them for, from its header; or, for
// a model whose header lists none, each animation long enough to be one.
function motionsOf(model) {
  if (model.motions?.length) {
    const counts = {}, totals = {};
    for (const { kind } of model.motions) totals[kind] = (totals[kind] || 0) + 1;
    return model.motions.map(({ index, kind }) => {
      counts[kind] = (counts[kind] || 0) + 1;
      return { index, kind, label: totals[kind] > 1 ? `${MOTION_LABEL[kind]} ${counts[kind]}` : MOTION_LABEL[kind] };
    });
  }
  return model.animations.map((frames, index) => ({ frames, index })).filter(({ frames }) => frames >= SHORTEST_MOTION)
    .map(({ index }, position) => ({ index, kind: position ? 'extra' : 'idle', label: `Motion ${position + 1}` }));
}

let motions = [];
function renderMotions(model, chosen) {
  motions = motionsOf(model);
  $('pokedex-motion-field').hidden = motions.length < 2;
  $('pokedex-motion').replaceChildren(...motions.map(motion => new Option(motion.label, motion.index)));
  $('pokedex-motion').value = chosen;
}

// The motion a model opens on: its idle. Its first pose is also how it stands, since some models' joints only make
// sense animated.
const openingMotion = model => motionsOf(model)[0]?.index ?? (model.animations.length ? 0 : -1);
const blinksIn = index => motions.find(motion => motion.index === index)?.kind === 'idle';

// The HD pack's images a model's textures come with, decoded. One that can't be read leaves the disc's.
async function decodeHdTextures(model) {
  await Promise.all(model.textures.map(async source => {
    if (!source.image) return;
    try {
      source.bitmap = await createImageBitmap(new Blob([source.image], { type: 'image/png' }), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    } catch (_) {}
    delete source.image;
  }));
}

const closeBitmaps = model => { for (const source of model.textures) source.bitmap?.close(); };

async function showModel(entry) {
  const mine = ++request;
  $('pokedex-motion-field').hidden = true;
  setStatus(`Reading ${entry.name} from your disc…`, { busy: true });
  $('pokedex-stage').classList.remove('ready');
  try {
    const model = await window.colo.pokedexModel(entry.key, form), motion = openingMotion(model);
    const clip = motion >= 0 ? await window.colo.pokedexClip(entry.key, form, motion) : null;
    // The game's blink, played over the idle now and then
    const blink = model.blink >= 0 ? await window.colo.pokedexClip(entry.key, form, model.blink) : null;
    await decodeHdTextures(model);
    if (mine !== request || !visible || !startViewer()) return closeBitmaps(model);
    renderMotions(model, motion);
    viewer.setModel(model, clip, { blink, shiny: model.shinyFilter ? model.shiny : null });
    viewer.setClip(clip, { blinks: blinksIn(motion) });
    setStatus(model.shinyFilter && !model.shiny ? `${entry.name} looks the same when shiny.` : '');
    requestAnimationFrame(() => requestAnimationFrame(() => $('pokedex-stage').classList.add('ready')));
  } catch (error) {
    if (mine === request) setStatus(message(error), { retry: true });
  }
}

function select(entry) {
  selected = entry;
  cry.show(entry);
  form = entry.forms[0]?.id;
  for (const [key, button] of entries) button.classList.toggle('selected', key === entry.key);
  renderInfo(entry);
  renderForms(entry);
  if (form) showModel(entry);
  else setStatus(`${entry.name} has no model on this disc.`);
}

// One list: the disc's Pokémon by number, each pack Pokémon after the one it's based on, and those numbered past the
// disc's (a later generation's) after them in their order. Evolutions name entries by key.
function combine(disc, packs) {
  const list = [], numbers = new Set(disc.map(entry => entry.national));
  const pack = entry => ({ ...entry, evolutions: entry.evolutions.map(into => typeof into === 'number' ? String(into) : `pack:${into}`) });
  for (const entry of disc) {
    list.push({ ...entry, key: String(entry.national), evolutions: entry.evolutions.map(String) });
    for (const each of packs) if (each.national === entry.national) list.push(pack(each));
  }
  for (const each of packs.filter(entry => !numbers.has(entry.national)).sort((a, b) => a.national - b.national)) list.push(pack(each));
  return list;
}

// Which game's list is wanted: one read for a game since left is dropped.
let listFor = 0;
async function load() {
  const mine = listFor;
  setStatus('Reading your disc…', { busy: true });
  try {
    const list = await window.colo.pokedex();
    if (mine !== listFor) return;
    species = combine(list.species, list.packs);
    packProblems = list.problems;
    renderList();
    if (visible) select(species[0]);
  } catch (error) {
    if (mine === listFor) setStatus(message(error), { retry: true });
  } finally { if (mine === listFor) loading = null; }
}

const cry = createCry($('pokedex-cry'), { onError: setStatus });

$('pokedex-search').addEventListener('input', () => { if (species) applyFilter(); });
$('pokedex-form').addEventListener('change', event => {
  form = event.target.value;
  showModel(selected);
});
$('pokedex-motion').addEventListener('change', async event => {
  const mine = ++request;
  try {
    const index = Number(event.target.value), clip = await window.colo.pokedexClip(selected.key, form, index);
    if (mine === request) viewer?.setClip(clip, { blinks: blinksIn(index) });
  } catch (error) {
    if (mine === request) setStatus(message(error), { retry: true });
  }
});
$('pokedex-open-packs').addEventListener('click', () => window.colo.openPokemonPacks().catch(error => setStatus(message(error))));
$('pokedex-reload').addEventListener('click', () => {
  if (loading) return;
  stopViewer();
  species = null;
  selected = null;
  loading = load();
});
$('pokedex-retry').addEventListener('click', () => {
  stopViewer();
  setStatus('');
  if (!species) loading ||= load();
  else if (selected) showModel(selected);
});

window.coloPokedex = {
  show() {
    visible = true;
    if (!species) loading ||= load();
    else if (selected && form) showModel(selected);
  },
  hide() {
    visible = false;
    request++;
    cry.stop();
    stopViewer();
  },
  // Another game was chosen: its Pokédex is its own disc's, read again when the page shows.
  reset() {
    request++;
    cry.stop();
    stopViewer();
    species = null;
    selected = null;
    listFor++;
    loading = visible ? load() : null;
  },
};
