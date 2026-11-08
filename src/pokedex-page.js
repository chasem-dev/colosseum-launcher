// The Pokédex: every Pokémon on the player's disc, to browse and turn around in 3D. Nothing
// of it stays on the GPU while the page is hidden, and it holds still when left alone.
import * as THREE from '../node_modules/three/build/three.module.js';
import { createRig, placeTexture } from './model-rig.js';

const $ = id => document.getElementById(id);
const WRAP = [THREE.ClampToEdgeWrapping, THREE.RepeatWrapping, THREE.MirroredRepeatWrapping];
const STATS = ['HP', 'Attack', 'Defense', 'Sp. Atk', 'Sp. Def', 'Speed'];
const MAX_STAT = 255;
// What the filters offer. Each Pokémon's status (pokedex.js) says where it belongs.
const FILTERS = [
  { id: 'all', label: 'All', matches: () => true },
  { id: 'available', label: 'Obtainable', matches: entry => !entry.status.locked },
  { id: 'battle', label: 'Battle only', matches: entry => entry.status.kind === 'battle' },
  { id: 'hidden', label: 'Hidden on disc', matches: entry => entry.status.kind === 'hidden' },
  { id: 'packs', label: 'Packs', matches: entry => entry.status.kind === 'pack', onlyWhenAny: true },
];
// Clips this short are held poses the game blends into, not motions to watch.
const SHORTEST_MOTION = 20;
const VIEW = { yaw: -0.45, pitch: 0.12 }, FOV = 30;
// Some drivers give out under a steady load, so the model moves for this long after the
// player last did something, then holds still until they come back to it.
const IDLE_MS = 15000;

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

// --- The 3D view ---------------------------------------------------------------------

function createViewer(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor(0x000000, 0);
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 1000), turntable = new THREE.Group();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8f9fb0, 1.7), turntable);
  const sun = new THREE.DirectionalLight(0xffffff, 1.9);
  sun.position.set(-0.6, 1.4, 1.6);
  scene.add(sun);

  const view = { ...VIEW, distance: 10, min: 4, max: 30, home: 10 };
  let shown = null, disposed = false, dragging = null;
  const turn = (yaw, pitch) => {
    view.yaw += yaw;
    view.pitch = Math.max(-0.7, Math.min(1.1, view.pitch + pitch));
  };

  function place() {
    turntable.rotation.y = view.yaw;
    camera.position.set(0, Math.sin(view.pitch) * view.distance, Math.cos(view.pitch) * view.distance);
    camera.lookAt(0, 0, 0);
  }

  function showFrame(index) {
    if (!shown?.clip) return;
    const { rig, clip, jointCount, materials } = shown, at = index * jointCount * 9;
    rig.pose(clip.values.subarray(at, at + jointCount * 9));
    for (const { material, values } of clip.materials) {
      const { map, source } = materials[material];
      if (map) placeTexture(map, source, values[index * 4], values[index * 4 + 1], values[index * 4 + 2], values[index * 4 + 3]);
    }
  }

  function clearModel() {
    if (!shown) return;
    for (const { mesh, geometry } of shown.rig.meshes) {
      turntable.remove(mesh);
      geometry.dispose();
      mesh.material.dispose();
    }
    for (const { map } of shown.materials) map?.dispose();
    for (const texture of shown.textures) texture.dispose();
    shown = null;
  }

  function setModel(data, clip) {
    clearModel();
    const textures = data.textures.map(source => {
      const texture = new THREE.DataTexture(source.rgba, source.width, source.height, THREE.RGBAFormat);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.wrapS = WRAP[source.wrapS] || THREE.ClampToEdgeWrapping;
      texture.wrapT = WRAP[source.wrapT] || THREE.ClampToEdgeWrapping;
      texture.magFilter = THREE.LinearFilter;
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.generateMipmaps = true;
      texture.needsUpdate = true;
      return texture;
    });
    // Each material slides its texture on its own, so each has its own view of it.
    const materials = data.materials.map(source => {
      const map = source.texture >= 0 ? textures[source.texture].clone() : null;
      if (map) {
        map.needsUpdate = true;
        placeTexture(map, source, source.translate[0], source.translate[1], source.scale[0], source.scale[1]);
      }
      return { source, map, color: new THREE.Color().setRGB(...(map && !source.tint ? [1, 1, 1] : source.diffuse), THREE.SRGBColorSpace) };
    });
    const makeMesh = shape => {
      const geometry = new THREE.BufferGeometry(), { source, map, color } = materials[shape.material];
      geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(shape.position.length), 3).setUsage(THREE.DynamicDrawUsage));
      geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(shape.normal.length), 3).setUsage(THREE.DynamicDrawUsage));
      geometry.setAttribute('uv', new THREE.BufferAttribute(shape.uv, 2));
      if (shape.color) geometry.setAttribute('color', new THREE.BufferAttribute(shape.color, 4));
      geometry.setIndex(new THREE.BufferAttribute(shape.index, 1));
      const mesh = new THREE.Mesh(geometry, new THREE.MeshLambertMaterial({ map, color, vertexColors: Boolean(shape.color), opacity: source.alpha,
        transparent: source.translucent, depthWrite: !source.translucent, alphaTest: source.translucent ? 0 : 0.4,
        side: shape.doubleSided ? THREE.DoubleSide : THREE.FrontSide }));
      mesh.frustumCulled = false;
      turntable.add(mesh);
      return { shape, mesh, geometry };
    };
    const rig = createRig(data, makeMesh);
    shown = { rig, clip, jointCount: data.joints.length, materials, textures };
    if (clip) showFrame(0);
    else rig.pose();

    // Framed from its first pose, so the whole Pokémon is in view at any turn.
    const box = new THREE.Box3();
    for (const { geometry } of rig.meshes) { geometry.computeBoundingBox(); box.union(geometry.boundingBox); }
    const center = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3()), radius = Math.max(size.x, size.y, size.z) / 2;
    for (const { mesh } of rig.meshes) mesh.position.copy(center).negate();
    const half = THREE.MathUtils.degToRad(FOV / 2);
    view.home = view.distance = radius / Math.tan(Math.min(half, Math.atan(Math.tan(half) * camera.aspect))) * 1.3;
    view.min = view.home * 0.35;
    view.max = view.home * 2.2;
    camera.near = view.home / 50;
    camera.far = view.home * 12;
    camera.updateProjectionMatrix();
    frame = 0;
    wake();
    redraw();
  }

  function setClip(clip) {
    if (!shown) return;
    shown.clip = clip;
    frame = 0;
    wake();
    redraw();
  }

  canvas.addEventListener('pointerdown', event => {
    dragging = { x: event.clientX, y: event.clientY };
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener('pointermove', event => {
    if (!dragging) return;
    turn((event.clientX - dragging.x) * 0.01, (event.clientY - dragging.y) * 0.006);
    dragging = { x: event.clientX, y: event.clientY };
  });
  canvas.addEventListener('pointerup', () => { dragging = null; });
  canvas.addEventListener('pointercancel', () => { dragging = null; });
  canvas.addEventListener('wheel', event => {
    event.preventDefault();
    view.distance = Math.max(view.min, Math.min(view.max, view.distance * Math.exp(event.deltaY * 0.001)));
  }, { passive: false });
  canvas.addEventListener('keydown', event => {
    const step = { ArrowLeft: [-0.2, 0], ArrowRight: [0.2, 0], ArrowUp: [0, -0.1], ArrowDown: [0, 0.1] }[event.key];
    if (!step) return;
    event.preventDefault();
    turn(...step);
  });
  canvas.addEventListener('dblclick', () => Object.assign(view, VIEW, { distance: view.home }));

  function resize() {
    const { clientWidth: width, clientHeight: height } = canvas.parentElement;
    if (!width || !height) return;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    redraw();  // a new size clears the canvas, even while the model holds still
  }
  const observer = new ResizeObserver(resize);
  observer.observe(canvas.parentElement);

  let running = false, started = 0, frame = 0, lastDraw = -Infinity, lastActive = performance.now(), background = document.hidden, redrawQueued = false;
  const listening = new AbortController();
  const rate = () => shown?.clip?.fps || 30;
  const draw = now => {
    const { clip } = shown || {};
    if (clip) {
      frame = Math.floor(((now - started) / 1000 * clip.fps) % clip.frames + clip.frames) % clip.frames;
      showFrame(frame);
    }
    place();
    renderer.render(scene, camera);
    lastDraw = now;
  };
  function tick(now) {
    if (!running) return;
    if (background || now - lastActive > IDLE_MS) { running = false; return; }
    if (dragging || now - lastDraw >= 1000 / rate() - 2) draw(now);
    requestAnimationFrame(tick);
  }
  function wake() {
    lastActive = performance.now();
    if (running || background || disposed) return;
    running = true;
    started = performance.now() - frame / rate() * 1000;
    requestAnimationFrame(tick);
  }
  // One frame for a change made while the model holds still.
  function redraw() {
    wake();
    if (running || redrawQueued || disposed) return;
    redrawQueued = true;
    requestAnimationFrame(now => {
      redrawQueued = false;
      if (!disposed) { started = now - frame / rate() * 1000; draw(now); }
    });
  }
  for (const type of ['pointerdown', 'pointermove', 'wheel', 'keydown', 'dblclick']) canvas.addEventListener(type, wake, { passive: true });
  window.addEventListener('blur', () => { background = true; }, { signal: listening.signal });
  window.addEventListener('focus', () => { background = false; wake(); }, { signal: listening.signal });
  document.addEventListener('visibilitychange', () => { background = document.hidden; wake(); }, { signal: listening.signal });
  resize();

  return {
    setModel, setClip,
    // Frees every GPU resource and the WebGL context itself.
    dispose() {
      disposed = true;
      running = false;
      listening.abort();
      observer.disconnect();
      clearModel();
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
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
  small.textContent = entry.pack ? `${number(entry.national)} · ${entry.pack.name}` : number(entry.national);
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
  const disc = species.filter(entry => !entry.pack), available = disc.filter(entry => !entry.status.locked).length, packs = species.length - disc.length;
  $('pokedex-summary').textContent = `${disc.length} Pokémon on your disc. ${available} can be obtained in the game; the rest are locked away.` +
    (packs ? ` ${packs} more ${packs === 1 ? 'comes' : 'come'} from your Pokémon packs.` : '');
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
  const next = entry.evolutions.map(key => entries.has(key) ? species.find(item => item.key === key) : null).filter(Boolean);
  $('pokedex-evolves-label').hidden = $('pokedex-evolves').hidden = !next.length;
  $('pokedex-evolves').replaceChildren(...next.map(target => {
    const link = document.createElement('button');
    link.type = 'button';
    link.className = 'pokedex-evolution';
    link.textContent = target.name;
    link.addEventListener('click', () => { select(target); entries.get(target.key).scrollIntoView({ block: 'nearest' }); });
    return link;
  }));
}

function renderForms(entry) {
  $('pokedex-form-field').hidden = entry.forms.length < 2;
  $('pokedex-form').replaceChildren(...entry.forms.map(item => new Option(item.label, item.id)));
  $('pokedex-form').value = form;
}

function renderMotions(animations, chosen) {
  const motions = animations.map((frames, index) => ({ frames, index })).filter(({ frames }) => frames >= SHORTEST_MOTION);
  $('pokedex-motion-field').hidden = motions.length < 2;
  $('pokedex-motion').replaceChildren(...motions.map((motion, position) => new Option(`Motion ${position + 1}`, motion.index)));
  $('pokedex-motion').value = chosen;
}

// The motion a model opens on: its first real one. Its first pose is also how it stands,
// since some models' joints only make sense animated.
const openingMotion = animations => {
  const index = animations.findIndex(frames => frames >= SHORTEST_MOTION);
  return index >= 0 ? index : animations.length ? 0 : -1;
};

async function showModel(entry) {
  const mine = ++request;
  $('pokedex-motion-field').hidden = true;
  setStatus(`Reading ${entry.name} from your disc…`, { busy: true });
  $('pokedex-stage').classList.remove('ready');
  try {
    const model = await window.colo.pokedexModel(entry.key, form), motion = openingMotion(model.animations);
    const clip = motion >= 0 ? await window.colo.pokedexClip(entry.key, form, motion) : null;
    if (mine !== request || !visible || !startViewer()) return;
    renderMotions(model.animations, motion);
    viewer.setModel(model, clip);
    setStatus('');
    requestAnimationFrame(() => requestAnimationFrame(() => $('pokedex-stage').classList.add('ready')));
  } catch (error) {
    if (mine === request) setStatus(message(error), { retry: true });
  }
}

function select(entry) {
  selected = entry;
  form = entry.forms[0]?.id;
  for (const [key, button] of entries) button.classList.toggle('selected', key === entry.key);
  renderInfo(entry);
  renderForms(entry);
  if (form) showModel(entry);
  else setStatus(`${entry.name} has no model on this disc.`);
}

// One list: the disc's Pokémon by number, each pack Pokémon after the one it's based on. Evolutions name entries by key.
function combine(disc, packs) {
  const list = [];
  for (const entry of disc) {
    list.push({ ...entry, key: String(entry.national), evolutions: entry.evolutions.map(String) });
    for (const pack of packs) if (pack.national === entry.national) list.push({ ...pack, evolutions: pack.evolutions.map(into => typeof into === 'number' ? String(into) : `pack:${into}`) });
  }
  return list;
}

async function load() {
  setStatus('Reading your disc…', { busy: true });
  try {
    const list = await window.colo.pokedex();
    species = combine(list.species, list.packs);
    packProblems = list.problems;
    renderList();
    if (visible) select(species[0]);
  } catch (error) {
    setStatus(message(error), { retry: true });
  } finally { loading = null; }
}

$('pokedex-search').addEventListener('input', () => { if (species) applyFilter(); });
$('pokedex-form').addEventListener('change', event => {
  form = event.target.value;
  showModel(selected);
});
$('pokedex-motion').addEventListener('change', async event => {
  const mine = ++request;
  try {
    const clip = await window.colo.pokedexClip(selected.key, form, Number(event.target.value));
    if (mine === request) viewer?.setClip(clip);
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
    stopViewer();
  },
};
