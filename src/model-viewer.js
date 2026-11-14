// The turntable the Pokédex and the Customize page draw a model on (hsd-model.js's, with model-rig.js and
// hsd-material.js): drag or the arrow keys turn it, the wheel zooms, a double click puts it back. It draws only
// while something moves, and dispose() frees every GPU resource and the WebGL context.
import * as THREE from '../node_modules/three/build/three.module.js';
import { createRig, placeTexture } from './model-rig.js';
import { createLighting, createMaterial, createTexture } from './hsd-material.js';

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

// --- The 3D view ---------------------------------------------------------------------

export function createViewer(canvas) {
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
    // New texels for one of the shown model's textures (one made from `rgba`, at the same size), for a page that
    // repaints them; drawn at once, even while the model holds still.
    setTexels(index, rgba) {
      const texture = shown?.textures[index];
      if (!texture?.image?.data || texture.image.data.length !== rgba.length) return;
      texture.image.data.set(rgba);
      texture.needsUpdate = true;
      redraw();
    },
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

