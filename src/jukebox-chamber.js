// The Jukebox's Purification Chamber: XD's round hall of teal-lit pedestals, with Ludicolo from the player's own disc dancing round it to
// the music. The Ludicolo are the Pokédex's models (the same reading, rigs and materials), posed in their own battle motions and bounced
// to the beat jukebox-beat.js finds in the player's sound. Nothing is drawn while the page is hidden, the tab is in the background, or
// the music has been stopped for a few seconds, and the GPU's resources are let go when the chamber is closed.
import * as THREE from '../node_modules/three/build/three.module.js';
import { createRig, placeTexture } from './model-rig.js';
import { createLighting, createMaterial, createTexture } from './hsd-material.js';
import { createPost, GLOW_LAYER } from './jukebox-post.js';

const $ = id => document.getElementById(id);
const beatOf = () => window.coloJukeboxBeat;
const tempoOf = () => window.coloJukeboxTempo;

const NATIONAL_LUDICOLO = 272;
const DANCERS = 6;               // round the middle, as the game's chamber has pedestals: turned half a step so none is dead ahead of the camera or behind Miror B.
const RING = 3.6, HEIGHT = 1.9, STAR_HEIGHT = 2.5, DAIS = 0.75;   // DAIS: how high the middle platform stands, for Miror B.  // the ring's radius, and how tall each Ludicolo stands, in the scene's units
const FOV = 38;
const FACING = 7;                // the point on the floor, toward the camera, that the ring's dancers look at
const GROOVE_MIN = 2.6;          // seconds the dancers take over the groove into the next song, at the least
const LAND_FRAMES = 10, LAST_FRAMES = 8;        // the hop: frames to settle after landing (it turns and winds up for a beat each, and takes off on the song's drop or break)
const NOMINAL = 0.5;           // the beat (seconds) a motion is sized for: it takes as many beats as it would at 120 BPM, so a faster song plays it faster and a slower one slower
const SLIGHT = 30;             // (and what Miror B. does with them: from INTENSE up he strikes, from EASY up he makes slight movements)
const INTENSE = 0.6, EASY = 0.3;
const BLEND = 0.16;                  // seconds a dancer takes to settle from one motion into the next   // how intense a song is (0 to 1) at which he strikes, and at which he moves a little             // a motion that turns the joints less than this much in all is a slight one
const DETECT_DELAY = 0.03;     // seconds a beat is heard late by the analyser's window, which the dancers make up
const SETTLE_MS = 3000;          // how long after the music stops the dancers go on before holding still
const TEAL = 0x2ee6c8, DEEP = 0x07262c;
// How light or dark the music sounds sets the visualizer's colours. Dark tones are deep indigo and violet, with magenta in the ribbons; light ones are
// bright aqua and pale, with gold in them. The key tints it a little: each key has its place on the circle of fifths, and the hue turns a few degrees
// with it, so that songs of the same tone in different keys are not quite the same colour. `tint` makes the palette for a tone (0 dark to 1 light), which
// draw() lays over the room and the visualizer.
const clamp01 = x => Math.max(0, Math.min(1, x));
const palette = { tone: 0.35, hue: 0.5, lightness: 0.5, glow: new THREE.Color(TEAL), warm: new THREE.Color(0xffd45a), bg: new THREE.Color(DEEP),
  floor: new THREE.Color(0x0a2a30), dais: new THREE.Color(0x0f3d44), base: new THREE.Color(0x0d3840) };
// Which hall: XD's round teal one, or Colosseum's, where Miror B. dances on an eight-sided gold platform on a star-patterned earth floor, in amber light.
// It sets the colours (the tone still runs dark to light, from a deep wine through to a bright gold, with the key tinting it) and the room's shapes.
let hall = 'xd';
function tint(tone, keyShift = 0) {
  if (hall === 'colosseum') return tintColosseum(tone, keyShift);
  // (songs sit in the middle of what the analysis gives, minor ones a little under 0.45 and major ones a little over, so the middle is steepened: songs of
  // different keys look different, and a swing within one song still goes the whole way)
  const t = palette.tone = clamp01(0.5 + (tone - 0.45) * 1.9), hue = palette.hue = (258 - 86 * t + keyShift) / 360;
  palette.lightness = 0.36 + 0.36 * t;
  palette.glow.setHSL(hue, 0.78 - 0.28 * clamp01((t - 0.4) / 0.6), 0.38 + 0.4 * t);
  palette.warm.setHSL(((300 + 108 * t) % 360) / 360, 0.85, 0.46 + 0.3 * t);
  palette.bg.setHSL(hue, 0.62, 0.035 + 0.15 * t);
  palette.floor.setHSL(hue, 0.62, 0.06 + 0.17 * t);
  palette.dais.setHSL(hue, 0.62, 0.09 + 0.18 * t);
  palette.base.setHSL(hue, 0.62, 0.085 + 0.18 * t);
}
function tintColosseum(tone, keyShift) {
  const t = palette.tone = clamp01(0.5 + (tone - 0.45) * 1.9), hue = palette.hue = (((338 + 78 * t + keyShift) % 360) + 360) % 360 / 360;
  const earth = ((26 + 10 * t) % 360) / 360;   // the floor and platforms stay earth and gold, and only lean toward the light
  palette.lightness = 0.38 + 0.34 * t;
  palette.glow.setHSL(hue, 0.9 - 0.3 * clamp01((t - 0.4) / 0.6), 0.44 + 0.34 * t);
  palette.warm.setHSL(((18 + 40 * t) % 360) / 360, 0.95, 0.5 + 0.26 * t);
  palette.bg.setHSL(earth, 0.5, 0.03 + 0.1 * t);
  palette.floor.setHSL(earth, 0.5, 0.07 + 0.14 * t);
  palette.dais.setHSL(((40 + 6 * t) % 360) / 360, 0.5, 0.1 + 0.15 * t);
  palette.base.setHSL(((96 - 20 * t) % 360) / 360, 0.4, 0.07 + 0.12 * t);   // the platforms are green-sided in the game, and gold on top
}
const AMBIENT = [0.75, 0.8, 0.82];
const LIGHTS = [{ direction: [-0.5, 1.2, 1.4], color: [0.8, 0.78, 0.72] }, { direction: [0.7, -0.4, -1], color: [0.12, 0.3, 0.3] }];
// The battle motions a dancer takes up besides its idle and its jump (the 'special', which the ring's dancers hop platforms with), in the
// order they're tried (hsd-model.js readHeader names each kind).
const MOVES = ['physical', 'extra'];
const MAX_NOTES = 18, MAX_FIREFLIES = 70;

const hasFrames = clip => clip && clip.frames > 0 && clip.values;

// A glyph on a transparent canvas, for a note's sprite.
function glyphTexture(glyph, color) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const g = canvas.getContext('2d');
  g.font = 'bold 52px serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.shadowColor = color;
  g.shadowBlur = 8;
  g.fillStyle = color;
  g.fillText(glyph, 32, 34);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function glow(radius, color, opacity, sides = 96) {
  const mesh = new THREE.Mesh(new THREE.RingGeometry(radius * 0.94, radius, sides, 1, sides === 8 ? Math.PI / 8 : 0), new THREE.MeshBasicMaterial({
    color, transparent: true, opacity, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  mesh.rotation.x = -Math.PI / 2;
  return mesh;
}

// The chamber's room, with no dancers in it yet.
function buildRoom(scene) {
  const room = { pulse: [], edges: [], notes: [], dispose: [], baseMats: [] };
  const own = thing => { room.dispose.push(thing); return thing; };

  scene.fog = new THREE.FogExp2(DEEP, 0.045);
  const gold = hall === 'colosseum', sides = gold ? 8 : 96;   // (Colosseum's platforms and rings are eight-sided)
  // the floor: a dark disc with rings of teal light
  room.floorMat = own(new THREE.MeshBasicMaterial({ color: 0x0a2a30 }));
  const floor = new THREE.Mesh(own(new THREE.CircleGeometry(9, 96)), room.floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.02;
  scene.add(floor);
  if (gold) {
    // Colosseum's floor is a great star: a dim gold one laid down, and its outline in light
    const points = Array.from({ length: 16 }, (_, i) => { const a = i / 16 * Math.PI * 2 + Math.PI / 8, r = i % 2 ? 5.2 : 8.4; return new THREE.Vector2(Math.sin(a) * r, Math.cos(a) * r); });
    room.starMat = own(new THREE.MeshBasicMaterial({ color: 0x4a3414 }));
    const star = new THREE.Mesh(own(new THREE.ShapeGeometry(new THREE.Shape(points))), room.starMat);
    star.rotation.x = -Math.PI / 2;
    star.position.y = -0.005;
    scene.add(star);
    const outline = new THREE.LineLoop(own(new THREE.BufferGeometry().setFromPoints(points.map(p => new THREE.Vector3(p.x, 0.02, -p.y)))),
      own(new THREE.LineBasicMaterial({ color: TEAL, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })));
    room.pulse.push({ material: outline.material, base: 0.8 });
    scene.add(outline);
  }
  for (const [radius, opacity] of (gold ? [[8.9, 0.2], [RING + 0.9, 0.45], [1.6, 0.7]] : [[8.6, 0.25], [6.4, 0.2], [RING + 0.9, 0.5], [1.6, 0.7]])) {
    const ring = glow(radius, TEAL, opacity, gold ? 8 : 96);
    own(ring.geometry); own(ring.material);
    room.pulse.push({ material: ring.material, base: opacity });
    scene.add(ring);
  }
  // a pedestal under each dancer, and the round dais in the middle
  room.daisMat = own(new THREE.MeshBasicMaterial({ color: 0x0f3d44 }));
  const dais = new THREE.Mesh(own(new THREE.CylinderGeometry(1.5, 1.7, DAIS, gold ? 8 : 48)), room.daisMat);
  dais.position.y = DAIS / 2 - 0.02;
  scene.add(dais);
  const rim = glow(1.5, TEAL, 0.9, gold ? 8 : 96);
  rim.position.y = DAIS - 0.01;
  own(rim.geometry); own(rim.material);
  room.pulse.push({ material: rim.material, base: 0.9 });
  scene.add(rim);
  room.pedestals = beatOf().ring(DANCERS, RING, Math.PI / DANCERS).map(({ x, z }) => {
    const baseMat = own(new THREE.MeshBasicMaterial({ color: 0x0d3840 }));
    room.baseMats.push(baseMat);
    const base = new THREE.Mesh(own(new THREE.CylinderGeometry(1.15, 1.25, 0.22, gold ? 8 : 40)), baseMat);
    base.position.set(x, 0.09, z);
    scene.add(base);
    const edge = glow(1.2, TEAL, 0.85, gold ? 8 : 96);
    edge.position.set(x, 0.21, z);
    own(edge.geometry); own(edge.material);
    room.edges.push({ material: edge.material, base: 0.85, level: 1, flash: 0 });
    scene.add(edge);
    return base;
  });

  // fireflies: small teal motes that drift round the hall
  const count = MAX_FIREFLIES, positions = new Float32Array(count * 3), seeds = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2, r = 1 + Math.random() * 8;
    positions.set([Math.sin(a) * r, 0.3 + Math.random() * 4, Math.cos(a) * r - 1], i * 3);
    seeds.set([Math.random() * 6.28, 0.2 + Math.random() * 0.5, 0.3 + Math.random()], i * 3);
  }
  const motes = new THREE.BufferGeometry();
  motes.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const moteMaterial = own(new THREE.PointsMaterial({ color: TEAL, size: 0.09, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false }));
  room.moteMaterial = moteMaterial;
  const points = new THREE.Points(own(motes), moteMaterial);
  scene.add(points);
  room.drift = seconds => {
    const at = motes.attributes.position;
    for (let i = 0; i < count; i++) {
      const [phase, speed, wobble] = [seeds[i * 3], seeds[i * 3 + 1], seeds[i * 3 + 2]];
      at.array[i * 3 + 1] += speed * 0.004 * wobble;
      if (at.array[i * 3 + 1] > 4.5) at.array[i * 3 + 1] = 0.2;
      at.array[i * 3] += Math.sin(seconds * speed + phase) * 0.0025;
    }
    at.needsUpdate = true;
  };

  // music notes that rise from the dancers on a beat
  const textures = [glyphTexture('♪', '#ffd84a'), glyphTexture('♫', '#ffe98a')];
  textures.forEach(own);
  for (let i = 0; i < MAX_NOTES; i++) {
    const material = own(new THREE.SpriteMaterial({ map: textures[i % 2], transparent: true, opacity: 0, depthWrite: false }));
    const sprite = new THREE.Sprite(material);
    sprite.scale.setScalar(0.55);
    sprite.visible = false;
    scene.add(sprite);
    room.notes.push({ sprite, life: 0, vx: 0, vy: 0, spin: 0 });
  }
  let next = 0;
  room.emit = (x, y, z) => {
    const note = room.notes[next++ % room.notes.length];
    note.sprite.position.set(x + (Math.random() - 0.5) * 0.6, y, z + (Math.random() - 0.5) * 0.6);
    note.life = 1;
    note.vx = (Math.random() - 0.5) * 0.6;
    note.vy = 1.1 + Math.random() * 0.7;
    note.sprite.visible = true;
  };
  room.rise = step => {
    for (const note of room.notes) {
      if (note.life <= 0) continue;
      note.life = Math.max(0, note.life - step * 0.55);
      note.sprite.position.x += note.vx * step;
      note.sprite.position.y += note.vy * step;
      note.sprite.material.opacity = Math.min(1, note.life * 2);
      if (!note.life) note.sprite.visible = false;
    }
  };
  return room;
}

// The music made visible, after the old players' visualizers (Winamp's, Media Player's, iTunes'): ribbons of the sound's waveform that circle the
// hall and trail away upward as they age, and a starburst of its spectrum on the floor that flashes on a beat. Both are thin glowing lines,
// drawn with light that adds up where they cross.
const WAVE_POINTS = 160, TRAILS = 9, BURST_RAYS = 72;
function buildVisualizer(scene) {
  const own = [];
  const lineMaterial = (color, opacity) => { const m = new THREE.LineBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }); own.push(m); return m; };
  // ribbons: each trail is a closed line; the newest is the sound as it is now, and the others are what it was a moment ago, higher and wider
  const trails = Array.from({ length: TRAILS }, (_, i) => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(WAVE_POINTS * 3), 3).setUsage(THREE.DynamicDrawUsage));
    own.push(geometry);
    const line = new THREE.LineLoop(geometry, lineMaterial(new THREE.Color().setHSL(0.47 - i * 0.035, 0.9, 0.62), 0));
    line.frustumCulled = false;
    scene.add(line);
    return { line, base: 0.9 - i * 0.09 };
  });
  // a second ribbon, tilted the other way and in gold
  const gold = trails.map(({ line }) => { const copy = new THREE.LineLoop(line.geometry, lineMaterial(0xffd45a, 0)); copy.frustumCulled = false; copy.rotation.x = 0.35; scene.add(copy); return copy; });
  // the starburst
  const rays = new THREE.BufferGeometry(), at = new Float32Array(BURST_RAYS * 6), colors = new Float32Array(BURST_RAYS * 6);
  rays.setAttribute('position', new THREE.BufferAttribute(at, 3).setUsage(THREE.DynamicDrawUsage));
  rays.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  own.push(rays);
  const burstMaterial = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
  own.push(burstMaterial);
  const burst = new THREE.LineSegments(rays, burstMaterial);
  burst.frustumCulled = false;
  scene.add(burst);

  let tick = 0, level = 0, lastSeconds = 0, turned = 0;
  const frames = Array.from({ length: TRAILS }, () => new Float32Array(WAVE_POINTS * 3));
  return {
    // `wave` is the analyser's samples (128 is silence), `bins` its spectrum (0..255), `pulse` the beat's 0..1, `playing` whether there is sound.
    update(wave, bins, pulse, seconds, playing, energy = 0.5, colours = palette, buildup = 0) {
      level += ((playing ? 1 : 0) - level) * 0.08;
      // the more intense the song, the wilder the ribbons and the longer and hotter the rays
      const wild = 0.45 + 1.25 * energy;
      // the build-up to a drop speeds the ribbons round and draws them in
      const dt = Math.max(0, Math.min(0.1, seconds - lastSeconds));
      lastSeconds = seconds;
      turned += dt * 0.25 * (1 + 2.2 * buildup);
      const spin = turned;
      // the newest ribbon, from the waveform: round the hall's edge, swinging out and up with the samples
      if (++tick % 3 === 0) {
        frames.unshift(frames.pop());
        const now = frames[0];
        for (let i = 0; i < WAVE_POINTS; i++) {
          const angle = i / WAVE_POINTS * Math.PI * 2 + spin, sample = ((wave[Math.floor(i / WAVE_POINTS * wave.length)] ?? 128) - 128) / 128;
          const radius = (RING + 2.6) * (1 - 0.2 * buildup) + sample * (1.1 + pulse * 0.8) * level * wild;
          now[i * 3] = Math.sin(angle) * radius;
          now[i * 3 + 1] = 0.5 + Math.abs(sample) * 1.4 * level * wild;
          now[i * 3 + 2] = Math.cos(angle) * radius;
        }
      }
      trails.forEach(({ line, base }, i) => {
        const source = frames[i], target = line.geometry.attributes.position.array;
        // older ribbons have drifted up, spread out and turned a little
        const lift = i * 0.32, spread = 1 + i * 0.045, turn = i * 0.06, cos = Math.cos(turn), sin = Math.sin(turn);
        for (let k = 0; k < WAVE_POINTS; k++) {
          const x = source[k * 3] * spread, z = source[k * 3 + 2] * spread;
          target[k * 3] = x * cos - z * sin;
          target[k * 3 + 1] = source[k * 3 + 1] + lift;
          target[k * 3 + 2] = x * sin + z * cos;
        }
        line.geometry.attributes.position.needsUpdate = true;
        const fade = Math.min(1, Math.pow(1 - i / TRAILS, 1.6) * level * (0.85 + 0.15 * pulse) * (0.55 + 0.9 * energy) * (1 + 0.5 * buildup));
        line.material.opacity = fade;
        gold[i].material.opacity = fade * 0.7;
        // the ribbons take the music's tone: indigo and pink-gold for dark, bright aqua and gold for light
        line.material.color.setHSL(colours.hue - i * 0.012, 0.9, Math.min(0.88, colours.lightness + 0.1 - i * 0.015));
        gold[i].material.color.copy(colours.warm);
        gold[i].rotation.y = -spin * 0.6;
      });
      // the starburst: a ray for each slice of the spectrum, out from the middle, longer for louder; hot (gold) as it gets long
      const hue = new THREE.Color();
      for (let r = 0; r < BURST_RAYS; r++) {
        const angle = r / BURST_RAYS * Math.PI * 2 - spin * 0.5, from = bins.length * 0.02, band = Math.floor(from + (r % (BURST_RAYS / 2)) / (BURST_RAYS / 2) * bins.length * 0.5);
        const strength = Math.min(1, Math.sqrt((bins[band] ?? 0) / 255) * 1.35) * level, length = 0.15 + strength * (3.2 + pulse * 1.6) * (0.5 + 1.1 * energy);
        const inner = 1.75, outer = inner + length, o = r * 6;
        at[o] = Math.sin(angle) * inner; at[o + 1] = 0.04; at[o + 2] = Math.cos(angle) * inner;
        at[o + 3] = Math.sin(angle) * outer; at[o + 4] = 0.04; at[o + 5] = Math.cos(angle) * outer;
        hue.setHSL((((colours.hue - Math.min(1, strength * 1.2) * 0.1 - energy * 0.06) % 1) + 1) % 1, 0.95, Math.min(0.92, colours.lightness - 0.02 + strength * 0.3));
        colors[o] = hue.r * 0.5; colors[o + 1] = hue.g * 0.5; colors[o + 2] = hue.b * 0.5;
        colors[o + 3] = hue.r; colors[o + 4] = hue.g; colors[o + 5] = hue.b;
      }
      rays.attributes.position.needsUpdate = true;
      rays.attributes.color.needsUpdate = true;
      burstMaterial.opacity = (0.75 + 0.25 * pulse) * (0.15 + 0.85 * level);
    },
    dispose() { for (const thing of own) thing.dispose?.(); },
  };
}


// --- The stage: shockwave ripples that run across the floor from the dancers' feet on the beat, and spotlights that sweep and snap in time. Both take the
// visualizer's colours.
const RIPPLES = 28, BEAMS = 6;
function glowTexture(kind) {
  const canvas = document.createElement('canvas');
  canvas.width = kind === 'beam' ? 4 : 64;
  canvas.height = kind === 'beam' ? 128 : 64;
  const g = canvas.getContext('2d');
  if (kind === 'beam') {
    // brightest at the lamp (the cone's top) and gone by the floor
    const fade = g.createLinearGradient(0, 0, 0, 128);
    fade.addColorStop(0, 'rgba(255,255,255,0.95)'); fade.addColorStop(0.35, 'rgba(255,255,255,0.35)'); fade.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = fade; g.fillRect(0, 0, 4, 128);
  } else {
    const spot = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    spot.addColorStop(0, 'rgba(255,255,255,0.9)'); spot.addColorStop(0.5, 'rgba(255,255,255,0.35)'); spot.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = spot; g.fillRect(0, 0, 64, 64);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function buildStage(scene, spots) {
  const own = [], additive = options => { const m = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, ...options }); own.push(m); return m; };
  // ripples: a thin ring on the floor that grows and fades
  const ringGeometry = new THREE.RingGeometry(0.94, 1, 80);
  own.push(ringGeometry);
  const ripples = Array.from({ length: RIPPLES }, () => {
    const mesh = new THREE.Mesh(ringGeometry, additive({ color: 0xffffff, opacity: 0, side: THREE.DoubleSide }));
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = 0.06;
    mesh.visible = false;
    scene.add(mesh);
    return { mesh, age: 1, strength: 0, size: 3, warm: false };
  });
  let nextRipple = 0;

  // spotlights: a cone from a lamp above to a spot on the floor, and a soft pool of light where it lands
  const length = 13, coneGeometry = new THREE.CylinderGeometry(0.05, 0.8, length, 28, 1, true);
  coneGeometry.translate(0, -length / 2, 0);   // its top (the lamp) at the origin,
  coneGeometry.rotateX(-Math.PI / 2);           // and the cone pointing along +Z, which is where Object3D.lookAt aims
  own.push(coneGeometry);
  const beamMap = glowTexture('beam'), poolMap = glowTexture('pool'), poolGeometry = new THREE.CircleGeometry(1, 40);
  own.push(beamMap, poolMap, poolGeometry);
  const beams = Array.from({ length: BEAMS }, (_, i) => {
    const angle = (i + 0.5) / BEAMS * Math.PI * 2, lamp = new THREE.Vector3(Math.sin(angle) * 7.5, 9.5, Math.cos(angle) * 7.5);
    const cone = new THREE.Mesh(coneGeometry, additive({ map: beamMap, color: 0xffffff, opacity: 0, side: THREE.DoubleSide }));
    cone.position.copy(lamp);
    const pool = new THREE.Mesh(poolGeometry, additive({ map: poolMap, color: 0xffffff, opacity: 0 }));
    pool.rotation.x = -Math.PI / 2;
    pool.position.y = 0.07;
    scene.add(cone, pool);
    return { cone, pool, lamp, target: new THREE.Vector3(Math.sin(angle) * 3.6, 0, Math.cos(angle) * 3.6), goal: new THREE.Vector3() };
  });

  // where each lamp aims for a bar, by pattern: its own pedestal, the middle, the pedestal across, a sweep round the ring, or a fan across the floor
  const aim = (pattern, i, seconds, into) => {
    switch (pattern) {
      case 0: return into.set(spots[i].x, 0, spots[i].z);
      case 1: return into.set(0, DAIS, 0);
      case 2: return into.set(spots[(i + 3) % DANCERS].x, 0, spots[(i + 3) % DANCERS].z);
      case 3: { const a = seconds * 0.8 + i * Math.PI / 3; return into.set(Math.sin(a) * 3.8, 0, Math.cos(a) * 3.8); }
      default: return into.set((i - (BEAMS - 1) / 2) * 1.5, 0, 1.2);
    }
  };

  return {
    // a ring of light running out across the floor from (x, z): `strength` 0 to 1, `size` the radius it reaches, `warm` for the song's warm colour
    ripple(x, z, strength, size = 4, warm = false) {
      const r = ripples[nextRipple++ % RIPPLES];
      r.age = 0; r.strength = strength; r.size = size; r.warm = warm;
      r.mesh.position.set(x, 0.06, z);
      r.mesh.visible = true;
    },
    // `power` 0 to 1: how bright the lamps are (they are dim with nothing playing); `solo` 0 to 1: how much they all gather on the middle
    update(step, seconds, { energy, pulse, palette, dimmer, solo, power, bar, lamps = BEAMS }) {
      for (const r of ripples) {
        if (r.age >= 1) continue;
        r.age = Math.min(1, r.age + step / 1.0);
        const out = 1 - Math.pow(1 - r.age, 2.2);
        r.mesh.scale.setScalar(0.5 + r.size * out);
        r.mesh.material.opacity = r.strength * Math.pow(1 - r.age, 1.5) * 0.6 * (1 - 0.3 * palette.tone);
        r.mesh.material.color.copy(r.warm ? palette.warm : palette.glow);
        if (r.age >= 1) r.mesh.visible = false;
      }
      // a quiet song's lamps sweep slowly; a lively one's change what they aim at every bar, snapping there
      const hash = n => { let h = Math.imul(n + 7, 2654435761) >>> 0; h ^= h >>> 15; return h >>> 0; };
      const pattern = energy < 0.35 ? (bar % 2 ? 3 : 0) : hash(bar) % 5, speed = (6 + 9 * energy) * step;
      // (the lighter the song's colours, the less the lamps add, or the whole hall washes out to white)
      const brightness = (0.03 + 0.2 * energy) * (0.8 + 0.4 * pulse) * (1 - 0.65 * dimmer) * (1 - 0.4 * palette.tone) * power;
      beams.forEach((beam, i) => {
        beam.cone.visible = beam.pool.visible = i < lamps;
        if (i >= lamps) return;
        aim(solo > 0.5 ? 1 : pattern, i, seconds, beam.goal);
        beam.target.lerp(beam.goal, Math.min(1, speed));
        beam.cone.lookAt(beam.target);
        const colour = i % 2 ? palette.warm : palette.glow, own = brightness * (1 + 0.6 * solo);
        beam.cone.material.color.copy(colour);
        beam.cone.material.opacity = own;
        beam.pool.position.x = beam.target.x; beam.pool.position.z = beam.target.z;
        beam.pool.scale.setScalar(0.7 + 0.6 * energy);
        beam.pool.material.color.copy(colour);
        beam.pool.material.opacity = Math.min(1, own * 1.6);
      });
    },
    dispose() { for (const thing of own) thing.dispose?.(); },
  };
}

// A Ludicolo: one of the Pokédex's models in its own group, posed by a rig of its own (a rig writes the pose into its meshes) over the textures
// the dancers share.
function buildDancer(data, textures, lighting, group) {
  const materials = data.materials.map(() => []), variants = new Map();
  const materialFor = shape => {
    const key = `${shape.material}:${shape.color ? 1 : 0}:${shape.binormal ? 1 : 0}:${shape.doubleSided ? 1 : 0}`;
    if (!variants.has(key)) {
      const source = data.materials[shape.material], material = createMaterial(source, textures, lighting, { shape, shiny: null });
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
    group.add(mesh);
    return { shape, mesh, geometry };
  };
  const rig = createRig(data, makeMesh);
  return { rig, materials, sources: data.materials, jointCount: data.joints.length };
}

// How much the chamber asks of the machine, from the most (3) down. The chamber starts as high as it was left (or at 3, a little lower with reduced motion
// asked for), watches how steadily its frames come, and steps down a tier whenever they are too slow, then keeps that for next time. It never steps back up by itself.
export const TIERS = [
  { name: 'minimal', pixels: 0.75, glow: 0, lamps: 0, fps: 30 },
  { name: 'low', pixels: 1, glow: 0, lamps: 3, fps: 0 },
  { name: 'medium', pixels: 1.5, glow: 0.35, mode: 'bloom', lamps: BEAMS, fps: 0 },
  { name: 'high', pixels: 2, glow: 0.5, mode: 'full', lamps: BEAMS, fps: 0 },
];
const QUALITY = 'colo.jukebox.chamber.quality';
const SLOW_MS = 26, JUDGE_FRAMES = 75, SETTLE_FRAMES = 45;   // frames slower than this on average (under about 38 a second) step the tier down; judged over this many frames, after the change settles
export const slower = tier => Math.max(0, tier - 1);
const savedTier = () => { try { const n = Number(localStorage.getItem(QUALITY)); return Number.isInteger(n) && n >= 0 && n < TIERS.length ? n : null; } catch (_) { return null; } };
const saveTier = tier => { try { localStorage.setItem(QUALITY, String(tier)); } catch (_) { /* private mode */ } };
const calmer = () => { try { return !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches; } catch (_) { return false; } };

export function createChamber(canvas, which = 'xd') {
  hall = which === 'colosseum' ? 'colosseum' : 'xd';
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  let tier = Math.min(savedTier() ?? TIERS.length - 1, calmer() ? 2 : TIERS.length - 1), judged = [], settling = SETTLE_FRAMES;
  const quality = () => TIERS[tier];
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, quality().pixels));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor(DEEP, 1);
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 100);
  const lighting = createLighting(), lightDirections = LIGHTS.map(({ direction }) => new THREE.Vector3(...direction).normalize());
  lighting.ambientLight.value.setRGB(...AMBIENT);
  LIGHTS.forEach(({ color }, i) => lighting.lightColor.value[i].setRGB(...color));
  const spots = beatOf().ring(DANCERS, RING, Math.PI / DANCERS);   // where each platform is
  const room = buildRoom(scene), visualizer = buildVisualizer(scene), stage = buildStage(scene, spots);
  // what gives off light (the ribbons, the rings, the ripples, the motes) is what the trails and bloom are made of; the lamps' cones and pools are left out, being soft already
  scene.traverse(object => { if (object.material?.blending === THREE.AdditiveBlending && !object.material.map) object.layers.enable(GLOW_LAYER); });
  let post = null;
  try { post = createPost(renderer); } catch (_) { post = null; }
  const fit = () => {
    if (!canvasSize) return;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, quality().pixels));
    renderer.setSize(canvasSize.width, canvasSize.height, false);
    const buffer = renderer.getDrawingBufferSize(new THREE.Vector2());
    if (post) { if (quality().glow) post.resize(buffer.x, buffer.y, quality().glow); else post.free(); }
  };
  const stepDown = () => {
    if (tier === 0) return;
    tier = slower(tier);
    saveTier(tier);
    judged = [];
    settling = SETTLE_FRAMES;
    fit();
  };

  let dancers = [], disposed = false, listening = null;
  const meter = document.getElementById('jukebox-chamber-meter'), flashEl = document.getElementById('jukebox-chamber-flash'), dimEl = document.getElementById('jukebox-chamber-dim');
  const flashColour = new THREE.Color();
  // How the hall is framed in the canvas, as a share of its width and height to move it by: toward the top right, behind the page's header with the title and
  // the tabs left clear, while the songs are in front; centred while you watch. It eases from one to the other.
  const FRAMES = { backdrop: { x: -0.13, y: 0.19 }, watch: { x: 0, y: 0.02 } };
  let framing = { ...FRAMES.backdrop }, framingGoal = FRAMES.backdrop, canvasSize = null;
  function applyFraming() {
    if (!canvasSize) return;
    const { width, height } = canvasSize;
    camera.setViewOffset(width, height, Math.round(width * framing.x), Math.round(height * framing.y), width, height);
    camera.updateProjectionMatrix();
  }
  let lastBeat = -1, kick = 0, dolly = 0, flash = 0, dimmer = 0, solo = 0, shakeNow = 0, buildupS = 0, landed = false, moment = null, power = 0.25,
    camBase = { y: 7.6, z: 12.2 }, groove = null, groovePending = 0, lastSongId = null, keyShiftS = 0, toneS = 0.4, levelS = 0.3, energyS = 0.15, frameStep = 0.016, barSeen = -1, hopState = { state: 'dance', u: 0, shift: 0, at: null, frame: 0, air: 1, jumpStart: 0 }, playing = false, latency = 0, running = false, background = document.hidden, lastSound = 0, lastFrame = 0, beats = 0, tempo = 0, pulse = 0, shake = 0;
  const tracker = beatOf().createBeatTracker(), clock = beatOf().createBeatClock();
  const bins = new Uint8Array(512), wave = new Uint8Array(1024).fill(128), toView = new THREE.Matrix4(), centered = new THREE.Matrix4(), inverse = new THREE.Matrix4();

  function resize() {
    const { clientWidth: width, clientHeight: height } = canvas.parentElement;
    if (!width || !height) return;
    canvasSize = { width, height };
    fit();
    camera.aspect = width / height;
    // a narrow chamber stands the camera further back, so the whole ring stays in view
    const distance = 12.2 * Math.max(1, 1.7 / camera.aspect);
    camBase = { y: 5.2 + distance * 0.2, z: distance };
    camera.position.set(0, camBase.y, camBase.z);
    camera.lookAt(0, 0.9, 0);
    // the chamber is the backdrop of the whole page, with the songs over its lower part
    applyFraming();
    draw(performance.now(), true);
  }
  const observer = new ResizeObserver(resize);
  observer.observe(canvas.parentElement);

  // Gives the chamber a set of dancers of one `role`: 'ring', the Ludicolo round the edge, or 'star', Miror B. in the middle. `data` is the
  // model as the Pokédex reads it, `idle` its idle motion and `moves` the other motions to dance in (any may be missing: the model then holds
  // its pose and still bounces). The dancers of the role that were there are let go.
  function fill(role, data, idle, moves, spots, height, floor, hop = null) {
    clearDancers(role);
    const kept = { textures: data.textures.map(createTexture), clips: { idle: hasFrames(idle) ? idle : null, moves: moves.filter(hasFrames), hop: hasFrames(hop) ? hop : null } };
    spots.forEach(({ x, z, yaw: inward }, i) => {
      // a ring dancer faces out toward the audience, between the middle and the camera, so that the faces are seen
      const yaw = role === 'star' ? inward : Math.atan2(-x, FACING - z);
      const group = new THREE.Group(), body = new THREE.Group();
      group.add(body);
      scene.add(group);
      const built = buildDancer(data, kept.textures, lighting, body);
      const dancer = { ...built, role, kept, clips: kept.clips, group, body, x, z, yaw, index: i, phase: 0, side: i % 2 ? -1 : 1, height, floor,
        clip: null, lastClip: null, values: undefined, frame: 0, bar: -1, move: -1, moveStart: 0, moveBeats: 4, endBar: 0, restUntil: 0, turns: 0, level: 0.5,
        // for settling from one motion into the next: the pose last shown, and the one being blended from
        mix: new Float32Array(built.jointCount * 9), last: new Float32Array(built.jointCount * 9), blend: null, posed: false, step: null, recent: [] };
      dancers.push(dancer);
      // from its idle's first pose: the middle of its body over the floor, which its moves are held to (see stay)
      dancer.clip = kept.clips.idle;
      pose(dancer, 0);
      dancer.posed = true;
      dancer.anchor = middleOf(dancer);
      if (kept.clips.hop) dancer.air = beatOf().airborne(bounceHeights(kept.clips.hop, dancer.jointCount));
      if (role === 'star' && !kept.clips.sorted) sortSteps(kept, dancer.jointCount);
      // the frames of its idle where it lands from a small hop, which the beat is kept on
      dancer.landing = kept.clips.idle ? beatOf().landings(bounceHeights(kept.clips.idle, dancer.jointCount)) : [];
      // framed by its first pose: how big the model is, and where its middle is
      const first = dancers.find(each => each.role === role);
      if (first === dancer) frame(dancer, height);
      else { dancer.scale = first.scale; dancer.offset = first.offset; }
      body.scale.setScalar(dancer.scale);
      body.children.forEach(mesh => mesh.position.copy(dancer.offset).negate());
      // body's own origin is the model's middle, so its feet are half its height below the group
      group.position.set(x, height / 2 + floor, z);
      group.rotation.y = yaw;
    });
    lastFrame = 0;
    start();
  }
  const setDancers = (data, idle, moves, hop) => { hopState = { state: 'dance', u: 0, shift: 0, at: null, frame: 0, air: 1, jumpStart: 0 }; fill('ring', data, idle, moves, spots, HEIGHT, 0.2, hop); };
  const setStar = (data, idle, moves) => fill('star', data, idle, moves, [{ x: 0, z: 0, yaw: 0 }], STAR_HEIGHT, DAIS);


  // Where the middle of a dancer's skeleton is on the floor, in the model's own units: the mean of its joints.
  function middleOf(dancer) {
    let x = 0, z = 0;
    for (const joint of dancer.rig.world) { x += joint.elements[12]; z += joint.elements[14]; }
    return [x / dancer.rig.world.length, z / dancer.rig.world.length];
  }

  // The game's motions carry the whole body with them (a lunge ends a body's length from where it began, a jump may land elsewhere).
  // A dancer stays on its platform: after it is posed, the body is moved back so the middle of its skeleton is where it began. Up and down
  // are left alone, so a jump still leaves the floor and comes down in the same place.
  function stay(dancer) {
    const [x, z] = middleOf(dancer);
    for (const { mesh } of dancer.rig.meshes) mesh.position.set(-dancer.offset.x - (x - dancer.anchor[0]), -dancer.offset.y, -dancer.offset.z - (z - dancer.anchor[1]));
  }


  // How much of a body a motion moves: the turning of all its joints added up (a held pose is a few degrees, a fling is dozens of turns).
  function swing(clip, jointCount) {
    let total = 0;
    for (let j = 0; j < jointCount; j++) {
      for (let a = 0; a < 3; a++) {
        let low = Infinity, high = -Infinity;
        for (let f = 0; f < clip.frames; f++) { const v = clip.values[f * jointCount * 9 + j * 9 + 3 + a]; if (v < low) low = v; if (v > high) high = v; }
        total += high - low;
      }
    }
    return total;
  }

  // Miror B.'s motions, sorted by what he does with them: the flip (a real leap, the one that goes up with the Ludicolo's hop), his strikes
  // (big, quick moves, for the intense parts of a song), and his slight movements (a flick of an arm, the odd step, for the calmer parts).
  function sortSteps(kept, jointCount) {
    const all = kept.clips.moves.map(clip => {
      const heights = bounceHeights(clip, jointCount), air = beatOf().airborne(heights), up = Math.max(...heights) - Math.min(...heights);
      return { clip, size: swing(clip, jointCount), air, up };
    });
    const leaps = all.filter(each => each.air && each.air.land - each.air.take >= 12 && each.up > 15).sort((a, b) => b.up - a.up);
    const flip = leaps[0] ?? null, rest = all.filter(each => each !== flip);
    kept.clips.flip = flip?.clip ?? null;
    kept.clips.flipAir = flip?.air ?? null;
    kept.clips.strikes = rest.filter(each => each.size >= SLIGHT).sort((a, b) => b.size - a.size).map(each => each.clip);
    kept.clips.slights = rest.filter(each => each.size < SLIGHT).map(each => each.clip);
    kept.clips.sorted = true;
  }

  // How high the body is at each frame of a motion: that of the joint that moves up and down the most (the game's motions have no one root).
  function bounceHeights(clip, jointCount) {
    let best = [], range = 0;
    for (let j = 0; j < jointCount; j++) {
      const heights = Array.from({ length: clip.frames }, (_, f) => clip.values[f * jointCount * 9 + j * 9 + 7]);
      const spread = Math.max(...heights) - Math.min(...heights);
      if (spread > range) { range = spread; best = heights; }
    }
    return best;
  }

  // The size and middle of what's visible of a dancer's first pose
  function frame(dancer, height) {
    const box = new THREE.Box3();
    for (const { shape, mesh, geometry } of dancer.rig.meshes) {
      const source = dancer.sources[shape.material];
      const seen = mesh.material.uniforms.alpha.value > 0.01 || source.layers.some(layer => layer.alphaOp === 4 || layer.alphaOp === 6 || (layer.alphaOp === 2 && layer.blending > 0.01));
      if (!seen) continue;
      geometry.computeBoundingBox();
      box.union(geometry.boundingBox);
    }
    if (box.isEmpty()) for (const { geometry } of dancer.rig.meshes) { geometry.computeBoundingBox(); box.union(geometry.boundingBox); }
    const size = box.getSize(new THREE.Vector3());
    dancer.offset = box.getCenter(new THREE.Vector3());
    dancer.scale = size.y > 0 ? height / size.y : 1;
  }

  function pose(dancer, index) {
    const { clip } = dancer;
    if (clip) {
      const at = index * dancer.jointCount * 9;
      dancer.values = clip.values.subarray(at, at + dancer.jointCount * 9);
      for (const { material, layer, values } of clip.materials || []) {
        const source = dancer.sources[material].layers[layer];
        for (const each of dancer.materials[material]) {
          const xform = each.uniforms[`xform${layer}`]?.value;
          if (xform) placeTexture(xform, source, values[index * 4], values[index * 4 + 1], values[index * 4 + 2], values[index * 4 + 3]);
        }
      }
    }
    let values = dancer.values;
    // a new motion starts from where the last one left the body, and settles into its own over a moment, so that nothing snaps
    if (dancer.blend && values) {
      const w = beatOf().ease(dancer.blend.t / BLEND), from = dancer.blend.from, mix = dancer.mix;
      for (let k = 0; k < mix.length; k++) {
        let d = values[k] - from[k];
        if (k % 9 >= 3 && k % 9 < 6) d = ((d + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;   // a turn goes the short way round
        mix[k] = from[k] + d * w;
      }
      values = mix;
      dancer.blend.t += frameStep;
      if (dancer.blend.t >= BLEND) dancer.blend = null;
    }
    if (values) { dancer.last.set(values); dancer.posed = true; }
    dancer.rig.pose(values, dancer.rig.billboards ? toView : null);
  }

  function clearDancers(role) {
    const gone = dancers.filter(dancer => dancer.role === role || !role), sets = new Set(gone.map(dancer => dancer.kept));
    for (const dancer of gone) {
      scene.remove(dancer.group);
      for (const { geometry } of dancer.rig.meshes) geometry.dispose();
      for (const list of dancer.materials) for (const material of list) material.dispose();
    }
    for (const { textures } of sets) for (const texture of textures) {
      texture.dispose();
      if (texture.image instanceof ImageBitmap) texture.image.close();
    }
    dancers = dancers.filter(dancer => !gone.includes(dancer));
  }

  // The sound's low end, from the player's analyser, to the beat
  function listen(now) {
    const source = listening?.();
    if (!source?.analyser || !source.playing()) { pulse = Math.max(0, pulse - 0.05); playing = false; bins.fill(0); wave.fill(128); return false; }
    const { analyser } = source;
    if (bins.length !== analyser.frequencyBinCount || wave.length !== analyser.fftSize) return false;
    analyser.getByteFrequencyData(bins);
    analyser.getByteTimeDomainData(wave);
    const songId = source.id?.() ?? null;
    if (!playing || songId !== lastSongId) {
      // one song giving way to another while the sound goes on (and not a song starting from silence)
      const crossed = playing && lastSongId !== null && songId !== null;
      lastSongId = songId;
      resetDancing();
      post?.wipe();
      groovePending = crossed ? source.fade?.() ?? 0 : 0;
      // a song has begun (or one has crossed into the next): its tempo is its own, and the hop waits for its bars
      tracker.reset(); clock.reset(); tempo = 0; beats = 0; lastRaw = 0; wraps = 0; groupChoice.clear(); groupLast.clear();
    }
    playing = true;
    latency = analyser.context.outputLatency || analyser.context.baseLatency || 0;
    const result = tracker.push(beatOf().bassEnergy(bins, analyser.context.sampleRate), now / 1000);
    pulse = result.pulse;
    if (result.tempo) { tempo = result.tempo; clock.setTempo(result.tempo, now / 1000); }
    if (result.beat) {
      clock.onset(now / 1000);
      beats++;
      shake = 1;
      const [first] = dancers;
      if (first && room.emit) {
        const who = dancers[beats % dancers.length];
        room.emit(who.x, 2.6, who.z);
      }
    }
    lastSound = now;
    return true;
  }



  // The moments of the song that change it (a drop, a break: jukebox-tempo.js found them ahead of time) at which the ring flips. The jump is timed so
  // that the takeoff is on the moment, with a beat to turn and a beat to crouch before it; with the song's beat grid the moment is put on its nearest
  // beat. Returns where, in beats, the hop is to begin, or null when none is due.
  let eventsOf = null, fired = new Set(), lastHeard = 0;
  function dueEvent(info) {
    const source = listening?.(), profile = source?.intensity?.();
    if (!profile?.events?.length) return null;
    if (profile !== eventsOf) { eventsOf = profile; fired = new Set(); }
    if (info.heard < lastHeard - 1) fired = new Set();   // the song went round again, or was taken back
    lastHeard = info.heard;
    for (let i = 0; i < profile.events.length; i++) {
      if (fired.has(i)) continue;
      const map = info.grid ? tempoOf().gridMap(info.grid) : null;
      const kb = map ? Math.round(map.beatAt(profile.events[i].time)) : null;
      const at = map ? map.timeAt(kb) : profile.events[i].time, lead = 2 * (map ? map.periodAt(at) : info.period);
      if (info.heard < at - lead) continue;
      fired.add(i);
      // only if it is not too late to take off on the moment
      if (info.heard < at - lead + 0.6) return { start: info.grid ? kb - 2 + info.wraps : Math.floor(info.b), kind: profile.events[i].kind };
    }
    return null;
  }

  // A new song has its own beat count, which starts again from nothing: whatever the dancers had planned in the old song's beats (a step 90 beats from
  // now, a hop under way) is dropped, or they would hold their first pose until the new song caught up with it.
  function resetDancing() {
    const h = hopState;
    if (h.state === 'jump') h.shift = (h.shift + 1) % DANCERS;   // a hop in the air is taken as landed
    h.state = 'dance'; h.u = 0; h.frame = 0;
    for (const dancer of dancers) { dancer.step = null; dancer.bar = -1; dancer.recent = []; }
  }

  // The ring's hop, kept to the beat: every few bars the dancers turn to the platform beside them (a beat), crouch (a beat), jump to it together
  // (the jump lasts whole beats, so that they land on one), turn back to face the audience (a beat), and go on dancing there. `state` is
  // dance, turn, jump or back; `shift` is how many platforms round they have gone; `at` the beat to begin on; `u` how far (in beats) through a
  // turn it is, and `frame` the jump's frame.
  function stepHop(b, dancing, first, info) {
    if (!first) return;
    const h = hopState, p = clock.period, { take, land } = first.air, clip = first.clips.hop;
    if (h.state === 'dance') {
      // at a drop, break or change in the song they all take off together
      const due = dancing ? dueEvent(info) : null;
      if (due) { h.state = 'turn'; h.start = due.start; h.kind = due.kind; h.fired = false; }
      return;
    }
    if (h.state === 'turn') {
      h.u = Math.min(1, b - h.start);
      if (b - h.start >= 1) { h.state = 'jump'; h.start += 1; }
      return;
    }
    if (h.state === 'jump') {
      const air = Math.max(1, Math.round((land - take) / clip.fps / p)), u = b - h.start;
      h.air = air; h.jumpStart = h.start;
      // the crouch (up to the takeoff) is a beat, the air whole beats, and the landing is at its own pace after
      h.frame = u < 1 ? take * Math.max(0, u) : u < 1 + air ? take + (land - take) * (u - 1) / air : land + (u - 1 - air) * p * clip.fps;
      // the moment itself, as they leave the floor: a drop, a break or a change of the song
      if (!h.fired && h.frame >= take) { h.fired = true; moment = { kind: h.kind || 'change' }; }
      if (h.frame > land + LAND_FRAMES) {
        landed = true;
        h.state = 'back'; h.start = b; h.u = 0;
        h.shift = (h.shift + 1) % DANCERS;
        for (const dancer of dancers) if (dancer.role === 'ring') dancer.bar = -1;
      }
      return;
    }
    h.u = Math.min(1, b - h.start);
    if (b - h.start >= 1) h.state = 'dance';
  }



  // How intense the song is where it is, 0 to 1: `level` from the song's own profile (jukebox-tempo.js), a moment ahead so a move begins as the part
  // arrives, for deciding what to do; and `energy`, which follows every beat, for what to show. With no profile, from how much louder the sound is
  // now than it has been for a while.
  let fast = 0, slow = 0;
  function intensityNow() {
    const source = listening?.(), profile = source?.intensity?.();
    if (profile) {
      const at = source.position(), T = window.coloJukeboxTempo;
      return { level: T.intensityAt(profile, at + 0.4), energy: T.intensityAt(profile, at + 0.1, true) };
    }
    let sum = 0;
    for (let i = 0; i < bins.length; i++) sum += bins[i];
    const loud = sum / bins.length / 255;
    fast += (loud - fast) * 0.05; slow += (loud - slow) * 0.004;
    const level = Math.max(0, Math.min(1, 0.5 + (fast - slow) / (slow + 0.03) * 1.5));
    return { level, energy: Math.max(0, Math.min(1, level * 0.6 + pulse * 0.4)) };
  }

  // How light or dark the song sounds where it is, 0 to 1: from the song's own profile (jukebox-tempo.js), else from where the weight of the live
  // spectrum is.
  function toneNow() {
    const source = listening?.(), profile = source?.intensity?.();
    if (profile?.tone) return window.coloJukeboxTempo.toneAt(profile, source.position() + 0.15);
    let sum = 0, weight = 0;
    for (let i = 1; i < bins.length; i++) { sum += bins[i]; weight += bins[i] * i; }
    if (sum < 20 || !source?.analyser) return 0.4;
    const hz = weight / sum * source.analyser.context.sampleRate / 2 / bins.length;
    return clamp01(Math.log2(Math.max(hz, 180) / 180) / Math.log2(1500 / 180)) * 0.8;
  }

  // The key's tint, in degrees of hue: the key's place on the circle of fifths (C, G, D, A... in turn) as -18 to +18; 0 where the key is not known.
  function keyShiftNow() {
    const source = listening?.(), profile = source?.intensity?.(), key = profile?.key ? window.coloJukeboxTempo.keyAt(profile, source.position() + 0.15) : null;
    return key ? ((key.tonic * 7) % 12 / 11 - 0.5) * 36 : 0;
  }

  // How close the song is to a drop, 0 (not near) to 1 (on it): over the six seconds before one, the build-up, which tightens the ribbons and draws the
  // camera in.
  function buildupNow() {
    const source = listening?.(), profile = source?.intensity?.();
    if (!profile?.events?.length) return 0;
    const at = source.position();
    let near = 0;
    for (const event of profile.events) if (event.kind === 'drop' && event.time > at && event.time - at < 6) near = Math.max(near, 1 - (event.time - at) / 6);
    return near * near;
  }

  // Where the music is in beats. With the song's own beat grid (jukebox-tempo.js worked it out from the sound before it played) it is the
  // playing position, less what the speakers take to sound it, so that a beat is on a whole number as it is heard. Else it is the live clock,
  // which only follows the beats as they are heard. `b` never goes back by more than a beat, though the song's position does when it loops.
  let lastRaw = 0, wraps = 0;
  function beatNow(seconds) {
    const source = listening?.(), grid = source?.grid?.();
    if (grid) {
      // (with the song's own beats the count follows their tempo changes: tempo.js's gridMap)
      const map = tempoOf().gridMap(grid), heard = source.position() - source.latency(), period = map.periodAt(heard), raw = map.beatAt(heard);
      if (raw < lastRaw - 2) wraps += Math.ceil(lastRaw - raw - 1);   // the song went round again: keep counting
      lastRaw = raw;
      // the strongest of each four beats is the first of the bar, when the beats are the song's own
      const shift = map.folded ? 0 : grid.bar;
      return { b: raw + wraps, period, inBar: (((Math.floor(raw) - shift) % 4) + 4) % 4, grid, wraps, heard: source.position() - source.latency() };
    }
    lastRaw = 0; wraps = 0;
    const b = clock.at(seconds - latency + DETECT_DELAY), heard = source?.position ? source.position() - source.latency() : 0;
    return { b, period: clock.period, inBar: ((Math.floor(b) % 4) + 4) % 4, grid: null, wraps: 0, heard };
  }


  // The frame of a dancer's idle to show at beat `b`: every landing of its small hop on a beat (one with a single landing, or none, runs round
  // in two beats, landing on the first)
  function idleFrame(dancer, b, period) {
    const clip = dancer.clips.idle;
    if (!clip) return 0;
    const marks = dancer.landing.length ? dancer.landing : [0], perHop = dancer.landing.length > 1 ? 1 : 2;
    return Math.floor(beatOf().warp(marks, clip.frames, b, perHop)) % clip.frames;
  }

  // --- Miror B.'s dance. He has few motions of his own, so he dances them in many ways: through, backwards, in double time, a half at a time,
  // with a spin or a slide across the dais, and, for the calm parts, his idle with the body swaying, twisting, stepping, dipping or turning.
  const STRIKE_HIGH = ['normal', 'double', 'spin', 'slide', 'reverse', 'first', 'second'];
  const STRIKE_MID = ['normal', 'first', 'second', 'reverse', 'slide', 'double'];
  const BODY = ['sway', 'twist', 'step', 'dip', 'turn'];
  const hashOf = (a, b) => {
    let h = (Math.imul(a + 1, 2654435761) ^ Math.imul(b + 7, 40503)) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 0x5bd1e995) >>> 0;
    return (h ^ (h >>> 15)) >>> 0;
  };

  // What Miror B. does next, from how intense the song is: a strike in its intense parts, a slight movement in the rest, and now and then (when it is
  // easy) nothing at all. `slot` counts half bars. Null for standing.
  function chooseStep(dancer, level, slot, period) {
    const { strikes, slights } = dancer.clips, seed = hashOf(slot, dancer.turns++);
    const choose = list => { const fresh = list.filter(v => !dancer.recent.includes(v)), from = fresh.length ? fresh : list; return from[seed % from.length]; };
    let kind, clip = null, variant;
    if (level >= INTENSE && strikes.length) {
      kind = 'strike';
      clip = strikes[(seed >>> 5) % strikes.length];
      variant = choose(level >= 0.75 ? STRIKE_HIGH : STRIKE_MID);
    } else if (level >= EASY) {
      if (slot % 6 === 5) return null;
      kind = 'slight';
      if (slights.length && seed % 10 < 3) { clip = slights[(seed >>> 5) % slights.length]; variant = choose(['normal', 'reverse']); }
      else variant = choose(BODY);
    } else {
      if (slot % 3 !== 0) return null;
      kind = 'slight';
      variant = choose(['sway', 'dip']);
    }
    dancer.recent.push(variant);
    if (dancer.recent.length > 2) dancer.recent.shift();
    const long = clip ? clip.frames / clip.fps / NOMINAL : 4, round2 = n => Math.max(2, Math.round(n / 2) * 2);
    let beats;
    if (kind === 'strike') {
      beats = Math.min(8, round2(long));
      if (variant === 'double') beats = Math.max(2, beats / 2);
      else if (variant === 'first' || variant === 'second') beats = Math.max(2, round2(long / 2));
      else if (variant === 'spin' || variant === 'slide') beats = Math.max(4, beats);
    } else if (clip) beats = Math.min(4, round2(long));
    else beats = variant === 'dip' ? 2 : 4;
    return { kind, clip, variant, beats, start: slot * 2, dir: seed & 1 ? 1 : -1 };
  }

  // Miror B. at beat `b`: the motion and frame he is in, and how his body is moved about the dais as he does it.
  function danceStar(dancer, b, period, dancing, level) {
    const slot = Math.floor(b / 2), extra = { x: 0, yaw: 0, roll: 0, squash: 1, up: 0 };
    if (slot !== dancer.bar) {
      dancer.bar = slot;
      if (dancer.step && slot * 2 >= dancer.step.start + dancer.step.beats) dancer.step = null;
      if (!dancer.step && dancing) dancer.step = chooseStep(dancer, level, slot, period);
      if (!dancing) dancer.step = null;
    }
    const st = dancer.step, amp = 0.55 + 0.9 * level;
    // standing: his idle, on the beat
    if (!st) { dancer.clip = dancer.clips.idle; dancer.frame = idleFrame(dancer, b, period); return extra; }
    const u = Math.max(0, Math.min(1, (b - st.start) / st.beats)), turn = Math.PI * 2;
    if (st.clip) {
      const top = st.clip.frames - 1;
      const at = st.variant === 'reverse' ? 1 - u : st.variant === 'first' ? u * 0.5 : st.variant === 'second' ? 0.5 + u * 0.5 : u;
      dancer.clip = st.clip;
      dancer.frame = Math.max(0, Math.min(top, Math.round(at * top)));
    } else { dancer.clip = dancer.clips.idle; dancer.frame = idleFrame(dancer, b, period); }
    switch (st.variant) {
      case 'spin': extra.yaw = turn * beatOf().ease(u) * st.dir; break;
      case 'slide': extra.x = st.dir * 0.8 * Math.sin(Math.PI * u); break;
      case 'sway': extra.roll = 0.17 * amp * Math.sin(turn * u * 2); extra.x = 0.3 * amp * Math.sin(turn * u * 2); break;
      case 'twist': extra.yaw = 0.7 * amp * Math.sin(turn * u * 2); break;
      case 'step': extra.x = 0.7 * amp * Math.sin(turn * u); extra.yaw = 0.25 * Math.sin(turn * u); break;
      case 'dip': extra.squash = 1 - 0.12 * amp * Math.pow(Math.abs(Math.sin(Math.PI * u * st.beats)), 2); break;
      case 'turn': extra.yaw = st.dir * 0.9 * Math.sin(Math.PI * u); break;
      default: break;
    }
    return extra;
  }


  // --- The ring's dance. All six always dance their idle hop on the beat; how intense the song is adds variety to it. A calm song has them in unison
  // with a sway now and then; as it grows intense they split into two groups and then three, each doing its own thing (twisting, dipping, turning,
  // stepping, swaying), some taking up a lunge, a staggered wave of bounce running round the ring, and, at the most, spinning.
  const RING_POOLS = [
    { below: 0.25, pool: ['idle', 'idle', 'idle', 'sway'] },
    { below: 0.5, pool: ['sway', 'twist', 'dip', 'turn', 'idle', 'sway'] },
    { below: 0.75, pool: ['sway', 'twist', 'dip', 'turn', 'step', 'wave', 'move', 'twist'] },
    { below: 1.01, pool: ['spin', 'wave', 'move', 'move', 'dip', 'turn', 'twist', 'step'] },
  ];
  // What each group chose for each half bar, so that its dancers all do the same (and a group does not repeat itself: it remembers its last)
  const groupChoice = new Map(), groupLast = new Map();
  function chooseRing(dancer, level, slot) {
    const group = level < 0.5 ? 0 : level < 0.75 ? dancer.index % 2 : dancer.index % 3, seed = hashOf(slot, group + 11);
    const band = RING_POOLS.findIndex(each => level < each.below), pool = RING_POOLS[band].pool, key = `${slot}:${group}:${band}`;
    let variant = groupChoice.get(key);
    if (variant === undefined) {
      const fresh = pool.filter(v => v !== groupLast.get(group)), from = fresh.length ? fresh : pool;
      variant = from[seed % from.length];
      groupChoice.set(key, variant);
      groupLast.set(group, variant);
      for (const old of groupChoice.keys()) if (Number(old.split(':')[0]) < slot - 8) groupChoice.delete(old);
    }
    if (variant === 'idle') return null;
    if (variant === 'move' && !dancer.clips.moves.length) variant = 'dip';
    let clip = null, beats = 4;
    if (variant === 'move') {
      clip = dancer.clips.moves[(seed >>> 5) % dancer.clips.moves.length];
      beats = Math.min(8, Math.max(4, Math.round(clip.frames / clip.fps / NOMINAL / 4) * 4));
    }
    return { variant, clip, beats, start: slot * 2, dir: (seed >>> 3) & 1 ? 1 : -1 };
  }

  // A ring dancer at beat `b`: its motion and frame, and how its body is moved on its platform as it does it.
  function danceRing(dancer, b, period, dancing, level, spot) {
    const slot = Math.floor(b / 2), extra = { x: 0, z: 0, yaw: 0, roll: 0, squash: 1 };
    if (slot !== dancer.bar) {
      dancer.bar = slot;
      if (dancer.step && slot * 2 >= dancer.step.start + dancer.step.beats) dancer.step = null;
      // a step begins on the first beat of a bar and lasts whole bars, so the dancers of a group always begin and end together
      if (!dancer.step && dancing && slot % 2 === 0) dancer.step = chooseRing(dancer, level, slot);
      if (!dancing) dancer.step = null;
    }
    const st = dancer.step, amp = 0.5 + 0.9 * level, turn = Math.PI * 2;
    dancer.phase = st?.variant === 'wave' ? dancer.index * 0.33 : 0;
    dancer.clip = dancer.clips.idle;
    dancer.frame = idleFrame(dancer, b, period);
    if (!st) return extra;
    const u = Math.max(0, Math.min(1, (b - st.start) / st.beats));
    switch (st.variant) {
      case 'move': {
        dancer.clip = st.clip;
        dancer.frame = Math.max(0, Math.min(st.clip.frames - 1, Math.round(u * (st.clip.frames - 1))));
        break;
      }
      case 'sway': extra.roll = dancer.side * 0.2 * amp * Math.sin(turn * u * 2); break;
      case 'twist': extra.yaw = 0.6 * amp * Math.sin(turn * u * 2); break;
      case 'dip': extra.squash = 1 - 0.1 * amp * Math.pow(Math.abs(Math.sin(Math.PI * u * st.beats)), 2); break;
      case 'turn': extra.yaw = st.dir * 0.8 * Math.sin(Math.PI * u); break;
      case 'step': {
        // side to side along the platform
        const length = Math.hypot(spot.x, spot.z) || 1, d = 0.3 * amp * Math.sin(turn * u);
        extra.x = spot.z / length * d; extra.z = -spot.x / length * d;
        break;
      }
      case 'spin': extra.yaw = turn * beatOf().ease(u) * st.dir; break;
      default: break;
    }
    return extra;
  }

  function draw(now, still = false) {
    const seconds = now / 1000, gap = lastFrame ? now - lastFrame : 16, step = Math.min(0.1, gap / 1000);
    lastFrame = now;
    // how steadily the frames come: too slow for a while, and the chamber asks less of the machine
    if (!still && gap < 250 && quality().fps === 0 && tier > 0) {
      if (settling > 0) settling--;
      else if (judged.push(gap) >= JUDGE_FRAMES) {
        if (judged.reduce((a, b) => a + b, 0) / judged.length > SLOW_MS) stepDown(); else judged = [];
      }
    } else if (gap >= 250) { judged = []; settling = Math.max(settling, 10); }
    frameStep = step;
    const dancing = still ? false : listen(now) || now - lastSound < SETTLE_MS;
    shake = Math.max(0, shake - step * 4);
    // how intense the song is: smoothly, for the dancers' choices, and quickly, for what is shown
    const heard = playing && !still ? intensityNow() : { level: 0.3, energy: 0.15 };
    levelS += (heard.level - levelS) * Math.min(1, step * 4);
    energyS += (heard.energy - energyS) * Math.min(1, step * 10);
    if (meter) meter.style.setProperty('--level', energyS.toFixed(3));
    // the tone of the music, which colours the visualizer: slowly, so that the colours drift rather than flicker
    toneS += ((playing && !still ? toneNow() : 0.4) - toneS) * Math.min(1, step * 2.5);
    keyShiftS += ((playing && !still ? keyShiftNow() : 0) - keyShiftS) * Math.min(1, step * 1.2);
    tint(toneS, keyShiftS);
    scene.fog.color.copy(palette.bg);
    renderer.setClearColor(palette.bg, 1);
    room.floorMat.color.copy(palette.floor);
    room.starMat?.color.copy(palette.floor).multiplyScalar(2.2);
    room.daisMat.color.copy(palette.dais);
    for (const base of room.baseMats) base.color.copy(palette.base);
    for (const ring of room.pulse) ring.material.color.copy(palette.glow);
    for (const edge of room.edges) edge.material.color.copy(palette.glow);
    room.moteMaterial.color.copy(palette.glow);
    // a song has crossed into the next: the dancers groove into it, over the crossfade, and never faster than a song's own end would have them (a song picked from the list
    // fades over well under a second, which would have them leap and spin at twice the pace)
    if (groovePending > 0) {
      if (groovePending >= 0.5 && dancers.length) {
        groove = { start: seconds, duration: Math.max(GROOVE_MIN, Math.min(3.2, groovePending)) };
        for (const dancer of dancers) room.emit?.(dancer.group.position.x, 2.4, dancer.group.position.z);
      }
      groovePending = 0;
    }
    if (groove && seconds - groove.start >= groove.duration) { groove = null; for (const dancer of dancers) { dancer.bar = -1; dancer.step = null; } }
    // the hall settles into the framing wanted
    if (Math.abs(framing.x - framingGoal.x) + Math.abs(framing.y - framingGoal.y) > 0.0005) {
      const k = Math.min(1, step * 5);
      framing = { x: framing.x + (framingGoal.x - framing.x) * k, y: framing.y + (framingGoal.y - framing.y) * k };
      applyFraming();
    }
    // the effects' envelopes die away: the beat's kick quickly, a drop's push-in and flash in a second or two, a break's dimming and solo over several
    kick = Math.max(0, kick - step * 5);
    dolly = Math.max(0, dolly - step * 0.8);
    flash = Math.max(0, flash - step * 2.6);
    dimmer = Math.max(0, dimmer - step * 0.4);
    solo = Math.max(0, solo - step / 6);
    shakeNow = Math.max(0, shakeNow - step * 2.5);
    buildupS += ((playing && !still ? buildupNow() : 0) - buildupS) * Math.min(1, step * 3);
    power += ((playing && !still ? 1 : 0.25) - power) * Math.min(1, step * 2);
    // the camera drifts slowly round the hall, kicks in a little on each beat, pushes in during a build-up and on a drop, and shakes a moment on one
    const orbit = Math.sin(seconds * 0.11) * 0.28, push = 1 - 0.028 * kick * (0.4 + energyS) - 0.12 * dolly - 0.05 * buildupS - 0.04 * solo, jolt = shakeNow * shakeNow;
    camera.position.set(Math.sin(orbit) * camBase.z * push + (Math.random() - 0.5) * 0.14 * jolt,
      camBase.y * push + Math.sin(seconds * 0.27) * 0.16 + (Math.random() - 0.5) * 0.1 * jolt, Math.cos(orbit) * camBase.z * push);
    camera.lookAt(0, 0.9, 0);
    camera.updateMatrixWorld();
    lightDirections.forEach((direction, i) => lighting.lightDir.value[i].copy(direction).transformDirection(camera.matrixWorldInverse));
    for (const light of room.pulse) light.material.opacity = Math.min(1, light.base * (0.5 + 0.7 * energyS) * (0.8 + 0.4 * pulse));
    room.drift(seconds);
    visualizer.update(wave, bins, pulse, seconds, playing, energyS, palette, buildupS);
    room.rise(step);
    // where the music is in beats, as it is being heard: the sound reaches the speakers a moment after the analyser has it
    const beatInfo = beatNow(seconds), { b, period, inBar } = beatInfo;
    const bar = Math.floor(b / 4);
    const ring = dancers.filter(each => each.role === 'ring'), first = ring[0]?.clips.hop && ring[0].air ? ring[0] : null;
    stepHop(b, dancing, first, beatInfo);
    const h = hopState;
    // The beat: the camera kicks, a ripple runs out from one pedestal (a different one each beat, round the ring) and, on the first beat of a bar, from the
    // middle. A lively song sends one from every pedestal on every second beat.
    const whole = Math.floor(b);
    if (dancing && playing && !still && whole === lastBeat + 1) {
      const strength = 0.15 + 0.45 * energyS, slot = ((whole % DANCERS) + DANCERS) % DANCERS;
      kick = 1;
      stage.ripple(spots[slot].x, spots[slot].z, Math.min(1, strength * (inBar === 0 ? 1.35 : 1)), 3.3 + 2.2 * energyS);
      room.edges[slot].flash = 1;
      if (inBar === 0) stage.ripple(0, 0, Math.min(1, strength * 1.5), 5 + 2.5 * energyS, true);
      if (energyS > 0.65 && inBar === 0) for (let k = 0; k < DANCERS; k++) if (k !== slot) { stage.ripple(spots[k].x, spots[k].z, strength * 0.55, 3, k % 2 === 0); room.edges[k].flash = 0.7; }
    }
    lastBeat = whole;
    // A moment of the song, as the dancers leave the floor: a drop flashes, pushes the camera in and sends a ring out from every pedestal; a break dims the
    // hall and gathers the lamps on Miror B.; a change is a softer flash and rings.
    if (moment) {
      const kind = moment.kind;
      moment = null;
      if (kind === 'drop') {
        flash = 1; dolly = 1; shakeNow = 1; kick = 1; solo = 0;
        for (let k = 0; k < DANCERS; k++) { stage.ripple(spots[k].x, spots[k].z, 1, 5.5, k % 2 === 0); room.edges[k].flash = 1; }
        stage.ripple(0, 0, 1, 9, true);
        stage.ripple(0, 0, 0.7, 6, false);
      } else if (kind === 'break') {
        dimmer = 1; solo = 1;
        stage.ripple(0, 0, 0.6, 7, false);
      } else {
        flash = 0.45; dolly = 0.35; shakeNow = 0.4;
        for (let k = 0; k < DANCERS; k++) stage.ripple(spots[k].x, spots[k].z, 0.7, 4.5, k % 2 === 1);
      }
    }
    // they land from the hop, together
    if (landed) {
      landed = false;
      for (let k = 0; k < DANCERS; k++) { stage.ripple(spots[k].x, spots[k].z, 0.9, 4.5, k % 2 === 0); room.edges[k].flash = 1; }
      stage.ripple(0, 0, 0.8, 8, true);
      shakeNow = Math.max(shakeNow, 0.45);
    }
    const occupied = new Array(DANCERS).fill(0);
    for (const dancer of dancers) {
      const star = dancer.role === 'star', hopping = !star && first && h.state !== 'dance';
      let x = dancer.x, z = dancer.z, yaw = dancer.yaw, here = null;
      if (!star) {
        // where it stands, which moves along the ring as the dancers hop round it
        const slot = (dancer.index + h.shift) % DANCERS, next = spots[(slot + 1) % DANCERS], before = spots[(slot + DANCERS - 1) % DANCERS];
        here = spots[slot];
        const face = Math.atan2(-here.x, FACING - here.z), toNext = Math.atan2(next.x - here.x, next.z - here.z), fromBefore = Math.atan2(here.x - before.x, here.z - before.z);
        x = here.x; z = here.z; yaw = face;
        if (h.state === 'turn') yaw = beatOf().angleLerp(face, toNext, beatOf().ease(h.u));
        else if (h.state === 'back') yaw = beatOf().angleLerp(fromBefore, face, beatOf().ease(h.u));
        else if (h.state === 'jump') {
          const { take, land } = dancer.air, p = beatOf().ease((h.frame - take) / Math.max(1, land - take));
          yaw = toNext;
          x = here.x + (next.x - here.x) * p;
          z = here.z + (next.z - here.z) * p;
          occupied[(slot + (p > 0.5 ? 1 : 0)) % DANCERS] = 1;
        }
        if (h.state !== 'jump') occupied[slot] = 1;
      }

      const flip = star ? dancer.clips.flip : null, jumpU = b - h.jumpStart;
      let extra = null, flipping = false;
      // Grooving into the next song: the ring's dancers leap and spin in place, one after another round the ring (a wave), and Miror B. spins through
      // his flip, over the whole crossfade, to land on the new song's beat as the old one is gone
      const gt = groove ? seconds - groove.start : -1, grooving = gt >= 0 && Boolean(star ? flip : dancer.clips.hop);
      if (grooving) {
        const clip = star ? flip : dancer.clips.hop, air = star ? dancer.clips.flipAir : dancer.air;
        const delay = star ? 0 : dancer.index * 0.09, span = Math.max(0.6, groove.duration - (star ? 0 : 0.09 * (DANCERS - 1)) - 0.25);
        const local = gt - delay, u = clamp01(local / span), last = Math.min(clip.frames - 1, air.land + LAST_FRAMES);
        extra = { x: 0, z: 0, yaw: local < 0 ? 0 : Math.PI * 2 * beatOf().ease(u) * (star || dancer.index % 2 ? 1 : -1), roll: 0, squash: 1 };
        if (local < 0 && !star) { dancer.clip = dancer.clips.idle; dancer.frame = idleFrame(dancer, b, period); }
        else { dancer.clip = clip; dancer.frame = Math.max(0, Math.min(last, Math.floor(u * last))); }
      } else if (!star && h.state === 'jump') {
        dancer.clip = dancer.clips.hop;
        dancer.frame = Math.max(0, Math.min(dancer.clip.frames - 1, Math.floor(h.frame)));
      } else if (flip && (h.state === 'jump' || (h.state === 'back' && jumpU < 1 + h.air + 1))) {
        // Miror B. flips as the Ludicolo leap: the same crouch, the same beats in the air, and so down on the same beat
        const { take, land } = dancer.clips.flipAir, u = jumpU;
        dancer.clip = flip;
        dancer.step = null; dancer.bar = -1; flipping = true;
        dancer.frame = Math.max(0, Math.min(flip.frames - 1, Math.floor(u < 1 ? take * Math.max(0, u) : u < 1 + h.air ? take + (land - take) * (u - 1) / h.air : land + (u - 1 - h.air) * period * flip.fps)));
      } else if (star) {
        extra = danceStar(dancer, b, period, dancing, levelS);
        dancer.level = levelS;
      } else {
        extra = danceRing(dancer, b, period, dancing, levelS, here);
        dancer.level = levelS;
      }
      // a new motion settles in from the last pose
      if (dancer.clip !== dancer.lastClip) {
        if (dancer.lastClip && dancer.posed) dancer.blend = { from: Float32Array.from(dancer.last), t: 0 };
        dancer.lastClip = dancer.clip;
      }

      const m = (dancing && !hopping && h.state === 'dance' || star && dancing && !flipping) && !grooving
        ? beatOf().move({ seconds, beat: b, pulse, tempo, dancer: dancer.phase, side: dancer.side, accent: (inBar === 0 ? 1.5 : 1) * (0.4 + levelS) * (star ? 1 : 0.6 + 0.8 * energyS) })
        : { y: 0, roll: 0, yawOffset: 0, squash: 1 };
      const grow = 1, pop = 0;
      const ex = extra || { x: 0, z: 0, yaw: 0, roll: 0, squash: 1 };
      dancer.group.position.set(x + ex.x, dancer.height / 2 + dancer.floor + m.y + pop, z + (ex.z || 0));
      dancer.group.rotation.set(0, yaw + m.yawOffset + ex.yaw, m.roll + ex.roll);
      dancer.body.scale.set(dancer.scale * grow, dancer.scale * m.squash * ex.squash * grow, dancer.scale * grow);

      if (dancer.rig.billboards) {
        dancer.group.updateMatrixWorld(true);
        inverse.copy(camera.matrixWorldInverse);
        toView.multiplyMatrices(inverse, dancer.group.matrixWorld).multiply(centered);
      }
      pose(dancer, dancer.frame);
      stay(dancer);
    }
    stage.update(step, seconds, { energy: energyS, pulse, palette, dimmer, solo, power, bar, lamps: quality().lamps });
    // the flash of a drop and the dimming of a break, over the whole hall
    if (flashEl) {
      flashColour.set(0xffffff).lerp(palette.glow, 0.35);
      flashEl.style.background = '#' + flashColour.getHexString();
      flashEl.style.opacity = (flash * 0.3).toFixed(3);
    }
    if (dimEl) dimEl.style.opacity = (dimmer * 0.5).toFixed(3);
    // a pedestal glows brightest with a dancer on it, and dimly when it is bare
    room.edges.forEach((edge, i) => {
      edge.level += ((0.3 + 0.7 * occupied[i]) - edge.level) * Math.min(1, step * 8);
      edge.flash = Math.max(0, edge.flash - step * 4);
      edge.material.opacity = Math.min(1, edge.base * edge.level * (0.6 + 0.6 * energyS) * (0.8 + 0.4 * pulse) * (1 + 1.6 * edge.flash));
    });
    // the trails and bloom: the glow is drawn again on its own, small, and added over the picture. Trails run on after what made them, drifting out and round,
    // and run on longer and faster the more intense the song, and wind up before a drop
    const glowing = post && quality().glow && !still;
    if (glowing) {
      const mode = quality().mode, flare = 1 + 0.8 * flash;
      post.prepare(scene, camera, mode, {
        occlude: true, aspect: camera.aspect, inject: 0.4,
        decay: Math.pow(Math.min(0.9, 0.7 + 0.1 * energyS + 0.05 * buildupS), step * 60),
        zoom: 1 + (0.004 + 0.007 * energyS + 0.012 * buildupS) * step * 60,
        turn: (0.0015 + 0.006 * buildupS) * step * 60,
      });
      renderer.render(scene, camera);
      post.composite((0.22 + 0.3 * buildupS) * (1 - 0.4 * palette.tone), (0.14 + 0.28 * energyS + 0.18 * pulse * energyS) * flare * (1 - 0.4 * palette.tone));
    } else {
      renderer.render(scene, camera);
    }
  }

  function tick(now) {
    if (!running) return;
    if (background || disposed) { running = false; return; }
    // a weak machine draws every other frame
    if (quality().fps && lastFrame && now - lastFrame < 1000 / quality().fps - 5) { requestAnimationFrame(tick); return; }
    draw(now);
    // holds still once the music has been quiet for a while: a last frame is already on the canvas
    if (!dancers.length || now - lastSound > SETTLE_MS * 2) {
      if (listening?.()?.playing?.()) lastSound = now;
      else { running = false; return; }
    }
    requestAnimationFrame(tick);
  }
  function start() {
    if (running || background || disposed) return;
    running = true;
    lastSound = performance.now();
    requestAnimationFrame(tick);
  }

  const abort = new AbortController();
  document.addEventListener('visibilitychange', () => { background = document.hidden; start(); }, { signal: abort.signal });
  window.addEventListener('blur', () => { background = true; }, { signal: abort.signal });
  window.addEventListener('focus', () => { background = false; start(); }, { signal: abort.signal });
  resize();
  start();

  return {
    setDancers, setStar,
    // `source()` gives { analyser, playing() } when there is sound to dance to.
    listenTo(source) { listening = source; start(); },
    wake: start,
    // 'backdrop' (the songs in front) or 'watch' (the songs cleared away)
    frame(mode) { framingGoal = FRAMES[mode] || FRAMES.backdrop; start(); },
    dispose() {
      disposed = true;
      running = false;
      abort.abort();
      observer.disconnect();
      clearDancers();
      for (const thing of room.dispose) thing.dispose?.();
      visualizer.dispose();
      stage.dispose();
      post?.dispose();
      meter?.style.setProperty('--level', '0');
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
}

// --- The page's part: the toggle, the canvas, and reading Ludicolo from the disc --------------------------------------------------

const SAVED = 'colo.jukebox.chamber';
const remembered = () => { try { return localStorage.getItem(SAVED) !== 'off'; } catch (_) { return true; } };
const remember = on => { try { localStorage.setItem(SAVED, on ? 'on' : 'off'); } catch (_) { /* private mode */ } };

let chamber = null, request = 0, wanted = remembered();
const message = error => String(error?.message || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

function setStatus(text) {
  $('jukebox-chamber-status').textContent = text;
  $('jukebox-chamber-status').hidden = !text;
}

// The motions of a model, as the Pokédex lists them: its header's, else each animation long enough to be one.
function motionsOf(model) {
  if (model.motions?.length) return model.motions;
  return model.animations.map((frames, index) => ({ index, frames })).filter(({ frames }) => frames >= 20)
    .map(({ index }, position) => ({ index, kind: position ? 'extra' : 'idle' }));
}

async function decodeHdTextures(model) {
  await Promise.all(model.textures.map(async source => {
    if (!source.image) return;
    try { source.bitmap = await createImageBitmap(new Blob([source.image], { type: 'image/png' }), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' }); } catch (_) { /* the disc's own */ }
    delete source.image;
  }));
}

async function loadDancers(mine) {
  setStatus('Calling in the Ludicolo…');
  try {
    // Ludicolo's model, read straight from the disc; if that fails, by the Pokédex's way (which first reads the whole species list)
    let model = await window.colo.jukeboxLudicoloModel().catch(() => null), clipFor = index => window.colo.jukeboxLudicoloClip(index);
    if (!model) {
      const list = await window.colo.pokedex();
      const entry = list.species.find(each => each.national === NATIONAL_LUDICOLO);
      if (!entry) throw new Error('Ludicolo isn\'t on this disc.');
      // the Pokédex page keys a disc Pokémon by its National number (pokedex-page.js combine)
      const key = String(entry.national), form = entry.forms[0].id;
      model = await window.colo.pokedexModel(key, form);
      clipFor = index => window.colo.pokedexClip(key, form, index);
    }
    const motions = motionsOf(model), idle = motions.find(each => each.kind === 'idle') ?? motions[0];
    const clipOf = each => each ? clipFor(each.index) : null;
    const moves = [];
    for (const kind of MOVES) {
      const found = motions.find(each => each.kind === kind && each !== idle);
      if (found) moves.push(found);
    }
    const jump = motions.find(each => each.kind === 'special' && each !== idle);
    const [idleClip, hopClip, ...moveClips] = await Promise.all([clipOf(idle), clipOf(jump), ...moves.map(clipOf)]);
    await decodeHdTextures(model);
    if (mine !== request || !chamber) return;
    chamber.setDancers(model, idleClip, moveClips, hopClip);
    setStatus('');
    await loadStar(mine);
  } catch (error) {
    if (mine === request) setStatus(message(error));
  }
}

// Miror B., who dances in the middle: his battle model, from XD's disc (Colosseum's has none, and then the middle stays bare). Whatever goes
// wrong with him leaves the Ludicolo dancing.
async function loadStar(mine) {
  try {
    const model = await window.colo.jukeboxMirorModel();
    if (!model || mine !== request || !chamber) return;
    const motions = motionsOf(model), idle = motions.find(each => each.kind === 'idle') ?? motions[0];
    // every other motion he has is a step to dance: his throws, his hits, the rest
    const steps = motions.filter(each => each !== idle && each.kind !== 'faint').slice(0, 5);
    const [idleClip, ...stepClips] = await Promise.all([idle, ...steps].map(each => each ? window.colo.jukeboxMirorClip(each.index) : null));
    await decodeHdTextures(model);
    if (mine !== request || !chamber) return;
    chamber.setStar(model, idleClip, stepClips);
  } catch (_) { /* no Miror B. on this disc */ }
}

// Which game's hall: the chosen game's (it is asked again when the game is changed)
let hallGame = 'xd';
let hallKnown = window.colo.jukeboxGame().then(game => { hallGame = game; }, () => {});

function open() {
  if (chamber) return chamber;
  // a new canvas each time: a context that was let go can't make another
  const canvas = $('jukebox-chamber-canvas').cloneNode(false);
  $('jukebox-chamber-canvas').replaceWith(canvas);
  try { chamber = createChamber(canvas, hallGame); }
  catch (_) { setStatus('The 3D view couldn\'t start. Restart the launcher to reset its graphics.'); return null; }
  chamber.listenTo(window.coloJukebox?.listen ?? null);
  return chamber;
}

// Watch: the songs clear away to leave the chamber, and one button brings them back.
function watch(on) {
  $('page-jukebox').toggleAttribute('data-watch', on);
  $('jukebox-chamber-back').hidden = !on;
  chamber?.frame(on ? 'watch' : 'backdrop');
}

function close() {
  request++;
  watch(false);
  chamber?.dispose();
  chamber = null;
  setStatus('');
}

function sync() { hallKnown.then(syncNow); }
function syncNow() {
  const page = $('page-jukebox');
  const show = wanted && !page.hidden;
  $('jukebox-chamber').hidden = !show;
  page.classList.toggle('has-chamber', show);
  $('jukebox-chamber-toggle').checked = wanted;
  $('jukebox-chamber-watch').hidden = !show;
  if (!show) return close();
  if (open() && !chamber.loaded) { chamber.loaded = true; loadDancers(++request); }
  else chamber?.wake();
}

$('jukebox-chamber-watch').addEventListener('click', () => watch(true));
$('jukebox-chamber-back').addEventListener('click', () => watch(false));
$('jukebox-chamber-toggle').addEventListener('change', event => {
  wanted = event.target.checked;
  remember(wanted);
  if (wanted) window.coloJukebox?.study?.();
  sync();
});
// Esc brings the song list back from Watch
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && $('page-jukebox').hasAttribute('data-watch')) { event.preventDefault(); watch(false); }
});

window.coloJukeboxChamber = {
  show() { sync(); },
  hide() { close(); },
  // another game's disc: its Ludicolo are read again
  reset() {
    close();
    hallKnown = window.colo.jukeboxGame().then(game => { hallGame = game; }, () => {});
    if (!$('page-jukebox').hidden) sync();   // (the game was changed with the Jukebox open: its hall is made again)
  },
  // music has started: the dancers wake
  wake() { chamber?.wake(); },
};
