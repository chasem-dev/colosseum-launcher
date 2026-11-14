// Customize: each hero's colours, on their model from the player's disc. A colour chosen repaints the
// model's textures at once (hero-colors.js recolor), from the regions the main process sorted them into
// (hero-look.js). A preview for now: the game doesn't use these colours yet. Nothing of it stays on the GPU while
// the page is hidden.
import { createViewer } from './model-viewer.js';

const $ = id => document.getElementById(id);
const colors = window.ColoHeroColors;
const message = error => String(error?.message || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
// The colours are saved this long after the last change, so dragging across a colour picker saves once
const SAVE_DELAY = 300;

let looks = null, visible = false, viewer = null, shown = null, request = 0, saveTimer = null, paintQueued = false, motion = 'idle';
// The motion held at a frame, and the slider being dragged (which the playing motion doesn't move then)
let paused = false, scrubbing = false;

function setStatus(text, { busy = false, retry = false } = {}) {
  $('customize-status-text').textContent = text;
  $('customize-status').classList.toggle('loading', busy);
  $('customize-retry').hidden = !retry;
  $('customize-status').hidden = !text;
}

// A fresh canvas for each view: one whose context was let go can't make another.
function startViewer() {
  if (viewer) return true;
  const canvas = $('customize-stage').cloneNode(false);
  canvas.classList.remove('ready');
  $('customize-stage').replaceWith(canvas);
  try { viewer = createViewer(canvas, { onFrame: showFrameNumber }); viewer.setPaused(paused); }
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

const heroColors = () => looks.colors[shown.id];

// Every texture of the shown hero repainted with its colours: once a frame however fast they change.
function paint() {
  if (paintQueued) return;
  paintQueued = true;
  requestAnimationFrame(() => {
    paintQueued = false;
    if (!shown || !viewer) return;
    shown.originals.forEach((rgba, i) => {
      colors.recolor(shown.id, rgba, shown.textures[i], shown.refs, heroColors(), shown.painted[i]);
      viewer.setTexels(i, shown.painted[i]);
    });
  });
}

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try { await window.colo.saveHeroLooks(looks); }
    catch (error) { setStatus(message(error)); }
  }, SAVE_DELAY);
}

function setColors(next) {
  looks.colors[shown.id] = colors.normalizeColors(shown.id, next);
  paint();
  renderRegions();
  save();
}

function renderHeroes() {
  $('customize-heroes').replaceChildren(...colors.HEROES.map(hero => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'customize-hero';
    button.setAttribute('role', 'tab');
    button.dataset.hero = hero.id;
    const label = Object.assign(document.createElement('span'), { textContent: hero.label });
    const from = Object.assign(document.createElement('small'), { textContent: hero.from });
    button.append(label, from);
    button.addEventListener('click', () => showHero(hero.id));
    return button;
  }));
}

function markHero(id) {
  for (const button of $('customize-heroes').children) {
    const current = button.dataset.hero === id;
    button.classList.toggle('selected', current);
    button.setAttribute('aria-selected', String(current));
  }
}

function renderPresets() {
  const hero = colors.hero(shown.id);
  $('customize-presets').replaceChildren(...[{ id: 'classic', label: 'Classic', colors: {} }, ...hero.presets].map(preset => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'pokedex-filter';
    button.textContent = preset.label;
    button.addEventListener('click', () => setColors({ ...preset.colors }));
    return button;
  }));
}

// A row for each region the hero's textures have: its colour, and a button back to the disc's.
function renderRegions() {
  const hero = colors.hero(shown.id), chosen = heroColors();
  $('customize-regions').replaceChildren(...hero.regions.flatMap((region, i) => {
    const ref = shown.refs[i];
    if (!ref) return [];
    const row = document.createElement('div');
    row.className = 'customize-region';
    const input = Object.assign(document.createElement('input'), { type: 'color', value: chosen[region.id] || ref.color, id: `customize-color-${region.id}` });
    input.setAttribute('aria-label', `${region.label} colour`);
    input.addEventListener('input', () => {
      looks.colors[shown.id] = { ...heroColors(), [region.id]: input.value };
      reset.hidden = false;
      paint();
      save();
    });
    const label = Object.assign(document.createElement('label'), { textContent: region.label, htmlFor: input.id });
    const reset = Object.assign(document.createElement('button'), { type: 'button', className: 'subtle customize-region-reset', textContent: 'Reset', title: `${region.label} as on the disc` });
    reset.hidden = !chosen[region.id];
    reset.addEventListener('click', () => {
      const { [region.id]: _, ...rest } = heroColors();
      setColors(rest);
    });
    row.append(input, label, reset);
    return [row];
  }));
}

// The motions the hero can play, Idle first: one moved over from Wes's says so once it's chosen.
function renderMotions(id) {
  $('customize-motion').replaceChildren(...colors.motionsOf(id).map(motion => Object.assign(document.createElement('option'), { value: motion.id, textContent: motion.label })));
  $('customize-motion').value = motion;
}

// The hero playing `motionId`, on the model it's played on: Wes stands as his field model and battles as his battle
// model, so a motion can bring another model (and its textures, repainted) as well as its clip.
async function show(id, motionId) {
  const mine = ++request, hero = colors.hero(id), kind = colors.modelFor(id, motionId);
  const sameModel = shown?.id === id && shown.kind === kind && viewer;
  if (!sameModel) {
    $('customize-stage').classList.remove('ready');
    setStatus(`Reading ${hero.label} from your disc…`, { busy: true });
  }
  try {
    const wesMoves = id !== 'wes' && $('customize-wes-moves').checked;
    const [data, played] = await Promise.all([sameModel ? null : window.colo.heroModel(id, kind), window.colo.heroClip(id, motionId, wesMoves)]);
    if (mine !== request || !visible || !startViewer()) return;
    if (data) {
      // The texels as read stay put; the model's own arrays are the ones drawn, repainted from them
      shown = { id, kind, refs: data.refs, textures: data.textures, originals: data.model.textures.map(texture => texture.rgba.slice()),
        painted: data.model.textures.map(texture => new Uint8ClampedArray(texture.rgba.length)) };
      viewer.setModel(data.model, played.clip);
      renderPresets();
      renderRegions();
      paint();
      $('customize-hd').hidden = !data.hd;
    }
    viewer.setClip(played.clip);
    $('customize-frame').max = String(Math.max(0, (played.clip?.frames || 1) - 1));
    showFrameNumber(0, played.clip?.frames || 0);
    $('customize-motion-note').hidden = played.from !== 'wes';
    $('customize-motion-note').textContent = played.from !== 'wes' ? '' : wesMoves ? `Wes's moves, on ${hero.label}.`
      : `${hero.label}'s model has no motion of its own for this: these are Wes's moves, on ${hero.label}.`;
    setStatus(played.clip ? '' : `${hero.label} has no such motion.`);
    if (!sameModel) requestAnimationFrame(() => requestAnimationFrame(() => $('customize-stage').classList.add('ready')));
  } catch (error) {
    if (mine === request) setStatus(message(error), { retry: true });
  }
}

function showHero(id) {
  const hero = colors.hero(id);
  looks.shown = id;
  save();
  markHero(id);
  $('customize-name').textContent = hero.label;
  $('customize-from').textContent = hero.from;
  motion = 'idle';
  renderMotions(id);
  $('customize-wes-moves-field').hidden = id === 'wes';
  show(id, motion);
}

// Where the motion is: the slider follows it, unless it's being dragged.
function showFrameNumber(frame, frames) {
  if (!scrubbing) $('customize-frame').value = String(frame);
  $('customize-frame-text').textContent = frames ? `${frame + 1} / ${frames}` : '';
}

function setPaused(on) {
  paused = on;
  $('customize-play').textContent = paused ? 'Play' : 'Pause';
  viewer?.setPaused(paused);
}

$('customize-play').addEventListener('click', () => setPaused(!paused));
$('customize-frame').addEventListener('input', event => {
  scrubbing = true;
  if (!paused) setPaused(true);
  viewer?.setFrame(Number(event.target.value));
});
$('customize-frame').addEventListener('change', () => { scrubbing = false; });
$('customize-wes-moves').addEventListener('change', () => { if (looks) show(looks.shown, motion); });

$('customize-motion').addEventListener('change', event => {
  motion = event.target.value;
  if (looks) show(looks.shown, motion);
});
$('customize-reset').addEventListener('click', () => { if (shown) setColors({}); });
$('customize-retry').addEventListener('click', () => {
  stopViewer();
  shown = null;
  setStatus('');
  if (looks) show(looks.shown, motion);
});

window.coloCustomize = {
  async show() {
    visible = true;
    if (!$('customize-heroes').children.length) renderHeroes();
    try { looks ||= await window.colo.heroLooks(); }
    catch (error) { setStatus(message(error), { retry: true }); return; }
    if (visible) showHero(looks.shown);
  },
  hide() {
    visible = false;
    request++;
    shown = null;
    stopViewer();
    window.colo.heroClose().catch(() => {});
  },
};
