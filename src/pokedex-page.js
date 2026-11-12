// The Pokédex: every Pokémon on the player's disc, to browse and turn around in 3D. Nothing
// of it stays on the GPU while the page is hidden, and it holds still when left alone.
import * as THREE from '../node_modules/three/build/three.module.js';
import { createRig, placeTexture } from './model-rig.js';
import { createLighting, createMaterial, createTexture } from './hsd-material.js';
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
// The scene's lights, as the turntable sees them: an ambient light, the main light from above and in front, and a
// dim one from behind, below. The game's materials mix ambient and lights the way GX lighting does.
const AMBIENT_LIGHT = [0.8, 0.8, 0.82];
const SCENE_LIGHTS = [{ direction: [-0.6, 1.4, 1.6], color: [0.78, 0.78, 0.76] }, { direction: [0.7, -0.5, -1.2], color: [0.22, 0.22, 0.26] }];
// The game's blink (gs_range_801DE698.c): none for 10 frames after the last, then a chance each 60th of a second
// that grows to 1 in 60 by the first second and is certain after three; the blink plays at half speed.
const BLINK_TICK = 1000 / 60, BLINK_RATE = 0.5;
const blinkChance = ticks => (ticks < 10 ? 0 : ticks < 60 ? ((ticks - 10) / 50) * (2 - (ticks - 10) / 50) / 60 : ticks < 180 ? 1 / 60 : 1);
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
  scene.add(turntable);
  const lighting = createLighting(), sceneLights = SCENE_LIGHTS.map(({ direction }) => new THREE.Vector3(...direction).normalize());
  lighting.ambientLight.value.setRGB(...AMBIENT_LIGHT);
  SCENE_LIGHTS.forEach(({ color }, i) => lighting.lightColor.value[i].setRGB(...color));

  const view = { ...VIEW, distance: 10, min: 4, max: 30, home: 10 };
  let shown = null, disposed = false, dragging = null;
  const turn = (yaw, pitch) => {
    view.yaw += yaw;
    view.pitch = Math.max(-0.7, Math.min(1.1, view.pitch + pitch));
  };

  const toView = new THREE.Matrix4(), centered = new THREE.Matrix4();
  function place() {
    turntable.rotation.y = view.yaw;
    camera.position.set(0, Math.sin(view.pitch) * view.distance, Math.cos(view.pitch) * view.distance);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    turntable.updateMatrixWorld();
    // The lights stay put in the room while the Pokémon turns; the materials take them in the camera's space
    sceneLights.forEach((direction, i) => lighting.lightDir.value[i].copy(direction).transformDirection(camera.matrixWorldInverse));
    // Billboards face the camera wherever it is
    if (shown?.rig.billboards) {
      toView.multiplyMatrices(camera.matrixWorldInverse, turntable.matrixWorld).multiply(centered);
      shown.posed = false;
    }
  }

  // The texture tracks of a clip at a frame: each moves one layer of one material
  function placeLayers(clip, index) {
    for (const { material, layer, values } of clip.materials) {
      const source = shown.sources[material].layers[layer];
      for (const each of shown.materials[material]) {
        const xform = each.uniforms[`xform${layer}`]?.value;
        if (xform) placeTexture(xform, source, values[index * 4], values[index * 4 + 1], values[index * 4 + 2], values[index * 4 + 3]);
      }
    }
  }

  function showFrame(index) {
    if (!shown) return;
    const { rig, clip, jointCount } = shown;
    if (clip) {
      const at = index * jointCount * 9;
      shown.values = clip.values.subarray(at, at + jointCount * 9);
      placeLayers(clip, index);
      // A material's alpha track: Battle Revolution models show one mesh of two this way (Honchkrow's folded or open
      // wings), and Gastly's gas is see-through but for its texture's
      for (const { material, values } of clip.alphas || [])
        for (const each of shown.materials[material]) each.uniforms.alpha.value = values[index];
    }
    if (shown.blinking) placeLayers(shown.blink, shown.blinking.frame);
    rig.pose(shown.values, rig.billboards ? toView : null);
    shown.posed = true;
  }

  function clearModel() {
    if (!shown) return;
    for (const { mesh, geometry } of shown.rig.meshes) {
      turntable.remove(mesh);
      geometry.dispose();
    }
    for (const list of shown.materials) for (const material of list) material.dispose();
    for (const texture of shown.textures) {
      texture.dispose();
      if (texture.image instanceof ImageBitmap) texture.image.close();
    }
    shown = null;
  }

  // `data` is hsd-model.js's model, `clip` its opening motion; `blink` the eye animation the game plays over its idle,
  // and `shiny` the shiny filter to draw it with, if any.
  function setModel(data, clip, { blink = null, shiny = null } = {}) {
    clearModel();
    // An HD pack's image when it has one (decoded in showModel), else the disc's own; both top row first
    const textures = data.textures.map(createTexture);
    // A material's shader depends on its mesh too (vertex colours, bump vectors): one for each kind it's used with
    const materials = data.materials.map(() => []), variants = new Map();
    const materialFor = shape => {
      const key = `${shape.material}:${shape.color ? 1 : 0}:${shape.binormal ? 1 : 0}:${shape.doubleSided ? 1 : 0}`;
      if (!variants.has(key)) {
        const source = data.materials[shape.material], material = createMaterial(source, textures, lighting, { shape, shiny });
        source.layers.forEach((layer, i) => { if (material.uniforms[`xform${i}`]) placeTexture(material.uniforms[`xform${i}`].value, layer, layer.translate[0], layer.translate[1], layer.scale[0], layer.scale[1]); });
        materials[shape.material].push(material);
        variants.set(key, material);
      }
      return variants.get(key);
    };
    const makeMesh = shape => {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(shape.position.length), 3).setUsage(THREE.DynamicDrawUsage));
      geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(shape.normal.length), 3).setUsage(THREE.DynamicDrawUsage));
      for (const [source, uv] of Object.entries(shape.uv)) geometry.setAttribute(`hsdUv${source}`, new THREE.BufferAttribute(uv, 2));
      if (shape.color) geometry.setAttribute('hsdColor', new THREE.BufferAttribute(shape.color, 4));
      if (shape.binormal) {
        geometry.setAttribute('hsdBinormal', new THREE.BufferAttribute(new Float32Array(shape.binormal.length), 3).setUsage(THREE.DynamicDrawUsage));
        geometry.setAttribute('hsdTangent', new THREE.BufferAttribute(new Float32Array(shape.tangent.length), 3).setUsage(THREE.DynamicDrawUsage));
      }
      geometry.setIndex(new THREE.BufferAttribute(shape.index, 1));
      const mesh = new THREE.Mesh(geometry, materialFor(shape));
      mesh.frustumCulled = false;
      turntable.add(mesh);
      return { shape, mesh, geometry };
    };
    const rig = createRig(data, makeMesh);
    shown = { rig, clip, jointCount: data.joints.length, materials, sources: data.materials, textures, values: undefined, blink, blinking: null, ticks: 0, lastTick: 0 };
    place();
    showFrame(0);

    // Framed from its first pose, so the whole Pokémon is in view at any turn: what of it can be seen then (a mesh
    // whose material is clear, with no texture to give it alpha, is hidden)
    const seen = ({ shape, mesh }) => {
      const source = data.materials[shape.material];
      return mesh.material.uniforms.alpha.value > 0.01 || source.layers.some(layer => layer.alphaOp === 4 || layer.alphaOp === 6 || (layer.alphaOp === 2 && layer.blending > 0.01));
    };
    const box = new THREE.Box3();
    for (const each of rig.meshes) {
      if (!seen(each)) continue;
      each.geometry.computeBoundingBox();
      box.union(each.geometry.boundingBox);
    }
    if (box.isEmpty()) for (const { geometry } of rig.meshes) { geometry.computeBoundingBox(); box.union(geometry.boundingBox); }
    const center = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3()), radius = Math.max(size.x, size.y, size.z) / 2;
    centered.makeTranslation(-center.x, -center.y, -center.z);
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

  // `blinks`: whether the game would blink in this motion (its idle)
  function setClip(clip, { blinks = false } = {}) {
    if (!shown) return;
    shown.clip = clip;
    shown.blinks = blinks;
    shown.blinking = null;
    frame = 0;
    wake();
    redraw();
  }

  // The game's blink: the chance is rolled each 60th of a second while it isn't blinking
  function stepBlink(now) {
    if (!shown?.blink || !shown.blinks) return false;
    const { blink } = shown;
    if (shown.blinking) {
      const at = Math.floor((now - shown.blinking.start) / 1000 * blink.fps * BLINK_RATE);
      if (at >= blink.frames) { shown.blinking = null; shown.ticks = 0; return true; }
      if (at !== shown.blinking.frame) { shown.blinking.frame = at; return true; }
      return false;
    }
    if (!shown.lastTick || now - shown.lastTick > 500) shown.lastTick = now;
    for (; now - shown.lastTick >= BLINK_TICK; shown.lastTick += BLINK_TICK) {
      shown.ticks++;
      if (Math.random() < blinkChance(shown.ticks)) {
        shown.blinking = { start: now, frame: 0 };
        return true;
      }
    }
    return false;
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
    place();
    const blinked = stepBlink(now);
    if (clip) frame = Math.floor(((now - started) / 1000 * clip.fps) % clip.frames + clip.frames) % clip.frames;
    if (shown && (clip || blinked || !shown.posed)) showFrame(frame);
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
