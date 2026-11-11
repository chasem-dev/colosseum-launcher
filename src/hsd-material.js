// A material of the game's HSD models (hsd-model.js) as a three.js shader, drawn the way the game draws it: its
// texture layers mixed in their order (src/hsd/tobj.c TObjMakeTExp in the decompilation), the material's colours and
// lighting around them (src/hsd/mobj.c MObjMakeTExp, state.c HSD_SetupChannelMode), and how it lands on the screen
// (state.c HSD_SetupPEMode). Everything is worked out in the screen's own gamma, as the GameCube does.
import * as THREE from '../node_modules/three/build/three.module.js';

// TObj colour and alpha maps (how a layer mixes into what came before)
const COLOR = { NONE: 0, ALPHA_MASK: 1, RGB_MASK: 2, BLEND: 3, MODULATE: 4, REPLACE: 5, PASS: 6, ADD: 7, SUB: 8 };
const ALPHA = { NONE: 0, ALPHA_MASK: 1, BLEND: 2, MODULATE: 3, REPLACE: 4, PASS: 5, ADD: 6, SUB: 7 };
const LIGHTMAP = { DIFFUSE: 1 << 4, SPECULAR: 1 << 5, AMBIENT: 1 << 6, EXT: 1 << 7 };
const COORD = { UV: 0, REFLECTION: 1, HILIGHT: 2 };
// A layer's own colour stage: which of its inputs are used (TOBJ_TEVREG_ACTIVE_*)
const TEV_COLOR = 1 << 30, TEV_ALPHA = 1 << 31 >>> 0;
const WRAP = [THREE.ClampToEdgeWrapping, THREE.RepeatWrapping, THREE.MirroredRepeatWrapping];
// GX blend factors, as the source's and as the destination's
const SOURCE_FACTOR = [THREE.ZeroFactor, THREE.OneFactor, THREE.DstColorFactor, THREE.OneMinusDstColorFactor, THREE.SrcAlphaFactor,
  THREE.OneMinusSrcAlphaFactor, THREE.DstAlphaFactor, THREE.OneMinusDstAlphaFactor];
const DEST_FACTOR = [THREE.ZeroFactor, THREE.OneFactor, THREE.SrcColorFactor, THREE.OneMinusSrcColorFactor, THREE.SrcAlphaFactor,
  THREE.OneMinusSrcAlphaFactor, THREE.DstAlphaFactor, THREE.OneMinusDstAlphaFactor];
const DEPTH = [THREE.NeverDepth, THREE.LessDepth, THREE.EqualDepth, THREE.LessEqualDepth, THREE.GreaterDepth, THREE.NotEqualDepth,
  THREE.GreaterEqualDepth, THREE.AlwaysDepth];
const CHANNEL = 'rgba';
export const LIGHTS = 2;

const float = value => {
  const text = String(Number(value));
  return /[.e]/.test(text) ? text : `${text}.0`;
};

// The colour a layer's own stage makes from its inputs (MakeColorGenTExp), or null when it has none.
function tevInputs(layer, i) {
  const tev = layer.tev;
  if (!tev || !(tev.active & (TEV_COLOR | TEV_ALPHA))) return null;
  const color = input => ({ 15: 'vec3(0.0)', 12: 'vec3(1.0)', 13: 'vec3(0.5)', 8: `t${i}.rgb`, 9: `vec3(t${i}.a)`,
    0x80: `k${i}.rgb`, 0x81: `vec3(k${i}.r)`, 0x82: `vec3(k${i}.g)`, 0x83: `vec3(k${i}.b)`, 0x84: `vec3(k${i}.a)`,
    0x85: `r${i}a.rgb`, 0x86: `vec3(r${i}a.a)`, 0x87: `r${i}b.rgb`, 0x88: `vec3(r${i}b.a)` })[input] || 'vec3(0.0)';
  const alpha = input => ({ 7: '0.0', 4: `t${i}.a`, 0x40: `k${i}.r`, 0x41: `k${i}.g`, 0x42: `k${i}.b`, 0x43: `k${i}.a`,
    0x44: `r${i}a.a`, 0x45: `r${i}b.a` })[input] || '0.0';
  const stage = (inputs, op, bias, scale, clamp, kind) => {
    const [a, b, c, d] = inputs, one = kind === 'vec3' ? 'vec3(1.0)' : '1.0';
    const mixed = `(${a}) * (${one} - (${c})) + (${b}) * (${c})`;
    const value = `((${d}) ${op === 1 ? '-' : '+'} ${mixed} + ${float([0, 0.5, -0.5][bias] || 0)}) * ${float([1, 2, 4, 0.5][scale] || 1)}`;
    return clamp ? `clamp(${value}, 0.0, 1.0)` : value;
  };
  return {
    color: tev.active & TEV_COLOR ? stage(tev.colorIn.map(color), tev.colorOp, tev.colorBias, tev.colorScale, tev.colorClamp, 'vec3') : null,
    alpha: tev.active & TEV_ALPHA ? stage(tev.alphaIn.map(alpha), tev.alphaOp, tev.alphaBias, tev.alphaScale, tev.alphaClamp, 'float') : null,
  };
}

// One layer mixed into the colour `c` and alpha `a` so far (TObjMakeTExp). `repeat`: a layer seen in an earlier
// pass leaves the alpha alone.
function mixLayer(layer, i, repeat) {
  const own = tevInputs(layer, i), tc = own?.color || `t${i}.rgb`, ta = own?.alpha || `t${i}.a`, k = `blend${i}`;
  const lines = [];
  switch (layer.colorOp) {
    case COLOR.ALPHA_MASK: lines.push(`c = mix(c, ${tc}, ${ta});`); break;
    case COLOR.RGB_MASK: lines.push(`c = mix(c, ${tc}, ${tc});`); break;
    case COLOR.BLEND: lines.push(`c = mix(c, ${tc}, ${k});`); break;
    case COLOR.MODULATE: lines.push(`c = c * ${tc};`); break;
    case COLOR.REPLACE: lines.push(`c = ${tc};`); break;
    case COLOR.ADD: lines.push(`c = clamp(c + ${tc}, 0.0, 1.0);`); break;
    case COLOR.SUB: lines.push(`c = clamp(c - ${tc}, 0.0, 1.0);`); break;
    default: break;
  }
  if (!repeat) {
    switch (layer.alphaOp) {
      case ALPHA.ALPHA_MASK: lines.push(`a = mix(a, ${ta}, ${ta});`); break;
      case ALPHA.BLEND: lines.push(`a = mix(a, ${ta}, ${k});`); break;
      case ALPHA.MODULATE: lines.push(`a = a * ${ta};`); break;
      case ALPHA.REPLACE: lines.push(`a = ${ta};`); break;
      case ALPHA.ADD: lines.push(`a = clamp(a + ${ta}, 0.0, 1.0);`); break;
      case ALPHA.SUB: lines.push(`a = clamp(a - ${ta}, 0.0, 1.0);`); break;
      default: break;
    }
  }
  return lines.join('\n  ');
}

// The alpha test a material draws with, as GLSL, or ''.
function alphaTest(material) {
  const pe = material.pe;
  const compare = (kind, ref) => {
    const value = float(ref / 255);
    return ['false', `alpha < ${value}`, `abs(alpha - ${value}) < 0.002`, `alpha <= ${value}`, `alpha > ${value}`, `abs(alpha - ${value}) >= 0.002`,
      `alpha >= ${value}`, 'true'][kind] || 'true';
  };
  let test;
  if (pe) {
    const a = compare(pe.alphaCompare0, pe.ref0), b = compare(pe.alphaCompare1, pe.ref1);
    test = [`(${a}) && (${b})`, `(${a}) || (${b})`, `(${a}) != (${b})`, `(${a}) == (${b})`][pe.alphaOp] || `(${a}) && (${b})`;
    if (test === '(true) && (true)') return '';
  } else if (material.xlu && material.zUpdate) test = 'alpha > 0.0';
  else return '';
  return `float alpha = floor(gl_FragColor.a * 255.0 + 0.5) / 255.0;\n  if (!(${test})) discard;`;
}

const VERTEX = ({ sources, vertexColors, bump }) => `
${sources.map(s => `attribute vec2 hsdUv${s};\nvarying vec2 vUv${s};`).join('\n')}
${vertexColors ? 'attribute vec4 hsdColor;\nvarying vec4 vColor;' : ''}
${bump ? 'attribute vec3 hsdBinormal;\nattribute vec3 hsdTangent;\nvarying vec3 vBinormal;\nvarying vec3 vTangent;' : ''}
varying vec3 vNormal;
void main() {
  ${sources.map(s => `vUv${s} = hsdUv${s};`).join('\n  ')}
  ${vertexColors ? 'vColor = hsdColor;' : ''}
  ${bump ? 'vBinormal = normalMatrix * hsdBinormal;\n  vTangent = normalMatrix * hsdTangent;' : ''}
  vNormal = normalize(normalMatrix * normal);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

function fragmentShader(material, layers, { vertexColors, shiny }) {
  const swap = shiny ? shiny.route.map(channel => CHANNEL[channel]).join('') : 'rgba';
  const swapped = value => (swap === 'rgba' ? value : `(${value}).${swap}`);
  const vtx = vertexColors ? 'vColor' : 'vec4(1.0)';
  const diffuseVertex = material.diffuseSource & 2, alphaVertex = material.alphaSource & 2;
  const used = layers.map((layer, i) => ({ layer, i })).filter(({ layer }) => layer.map);
  const pass = (bits, done) => used.filter(({ layer }) => layer.lightmap & bits)
    .map(({ layer, i }) => mixLayer(layer, i, Boolean(layer.lightmap & done))).join('\n  ');
  const coord = ({ layer, i }) => {
    if (layer.coord === COORD.REFLECTION) return `vec2(0.5 + 0.5 * N.x, 0.5 - 0.5 * N.y) * xform${i}.xy + xform${i}.zw`;
    if (layer.coord === COORD.HILIGHT) return `vec2(xform${i}.x * (0.5 + 0.5 * dot(normalize(lightDir[0] + vec3(0.0, 0.0, 1.0)), N)) + xform${i}.z, xform${i}.w)`;
    return `vUv${layer.source} * xform${i}.xy + xform${i}.zw`;
  };
  const bumps = used.filter(({ layer }) => layer.bump && layer.coord === COORD.UV);
  const lines = [];
  lines.push('vec3 N = normalize(vNormal) * (gl_FrontFacing ? 1.0 : -1.0);');
  lines.push(`vec4 vtx = ${vtx};`);
  // The lighting channels: ambient plus each light's diffuse, on the vertex colour or white; and the specular
  lines.push('vec3 light = ambient * ambientLight;\n  vec3 shine = vec3(0.0);');
  lines.push(`for (int l = 0; l < ${LIGHTS}; l++) {
    float d = max(dot(N, lightDir[l]), 0.0);
    light += lightColor[l] * d;
    if (d > 0.0) shine += lightColor[l] * pow(max(dot(N, normalize(lightDir[l] + vec3(0.0, 0.0, 1.0))), 0.0), max(shininess, 1.0));
  }`);
  lines.push(material.lit
    ? `vec3 ras = ${swapped(`vec4(clamp(${diffuseVertex ? 'vtx.rgb' : 'vec3(1.0)'} * clamp(light, 0.0, 1.0), 0.0, 1.0), 1.0)`)}.rgb;`
    : `vec3 ras = ${swapped(diffuseVertex ? 'vtx' : 'vec4(1.0)')}.rgb;`);
  for (const { i } of used) {
    lines.push(`vec2 uv${i} = ${coord(used.find(each => each.i === i))};`);
    lines.push(`vec4 t${i} = ${swapped(`texture2D(map${i}, uv${i})`)};`);
  }
  // Where the colour starts: the material's diffuse, the vertex colour or both; and its alpha
  if (material.lit) {
    lines.push(`vec3 c = ${material.diffuseSource === 2 ? 'vec3(1.0)' : 'diffuse'};`);
    lines.push(`float a = ${material.alphaSource === 2 ? '1.0' : 'alpha'};`);
  } else {
    lines.push(`vec3 c = ${material.diffuseSource === 1 ? 'diffuse' : material.diffuseSource === 2 ? 'ras' : 'diffuse * ras'};`);
    lines.push(`float a = ${material.alphaSource === 1 ? 'alpha' : material.alphaSource === 2 ? 'vtx.a' : 'alpha * vtx.a'};`);
  }
  lines.push(pass(LIGHTMAP.DIFFUSE | LIGHTMAP.AMBIENT, 0));
  if (material.lit) {
    if (alphaVertex) lines.push('a *= vtx.a;');
    lines.push('c = c * ras;');
  }
  if (material.specular) {
    lines.push('vec3 c0 = c;\n  c = specular;');
    lines.push(pass(LIGHTMAP.SPECULAR, LIGHTMAP.DIFFUSE | LIGHTMAP.AMBIENT));
    lines.push(`c = clamp(c0 + c * ${swapped('vec4(clamp(shine, 0.0, 1.0), 1.0)')}.rgb, 0.0, 1.0);`);
  }
  lines.push(pass(LIGHTMAP.EXT, LIGHTMAP.DIFFUSE | LIGHTMAP.AMBIENT | LIGHTMAP.SPECULAR));
  // The shiny filter's brightness, a stage after the material's own (GSmaterial's modulation)
  if (shiny) lines.push('c = clamp(c * shinyScale, 0.0, 1.0);');
  // Emboss bump maps (SetupEmbossBumpTev): the bump texture, less itself shifted toward the light, on the lighting
  for (const { i } of bumps) {
    lines.push(`{ vec2 shifted = uv${i} + vec2(dot(lightDir[0], vTangent), dot(lightDir[0], vBinormal));
    vec3 lit = clamp(light, 0.0, 1.0);
    c = clamp(c + texture2D(map${i}, uv${i}).rgb * lit - texture2D(map${i}, shifted).rgb * lit, 0.0, 1.0); }`);
  }
  lines.push('gl_FragColor = vec4(clamp(c, 0.0, 1.0), clamp(a, 0.0, 1.0));');
  lines.push(alphaTest(material));

  const uniforms = ['uniform vec3 diffuse;', 'uniform vec3 ambient;', 'uniform vec3 specular;', 'uniform float alpha;', 'uniform float shininess;',
    'uniform vec3 ambientLight;', `uniform vec3 lightDir[${LIGHTS}];`, `uniform vec3 lightColor[${LIGHTS}];`, 'uniform vec3 shinyScale;'];
  for (const { i, layer } of used) {
    uniforms.push(`uniform sampler2D map${i};`, `uniform vec4 xform${i};`, `uniform float blend${i};`);
    if (layer.tev) uniforms.push(`uniform vec4 k${i};`, `uniform vec4 r${i}a;`, `uniform vec4 r${i}b;`);
  }
  const sources = [...new Set(used.filter(({ layer }) => layer.coord === COORD.UV).map(({ layer }) => layer.source))];
  return `${uniforms.join('\n')}
${sources.map(s => `varying vec2 vUv${s};`).join('\n')}
${vertexColors ? 'varying vec4 vColor;' : ''}
${bumps.length ? 'varying vec3 vBinormal;\nvarying vec3 vTangent;' : ''}
varying vec3 vNormal;
void main() {
  ${lines.filter(Boolean).join('\n  ')}
}`;
}

// The shared lighting each material reads; the page sets it once a frame.
export function createLighting() {
  return {
    ambientLight: { value: new THREE.Color(1, 1, 1) },
    lightDir: { value: Array.from({ length: LIGHTS }, () => new THREE.Vector3(0, 0, 1)) },
    lightColor: { value: Array.from({ length: LIGHTS }, () => new THREE.Color(0, 0, 0)) },
  };
}

// A texture for one of the model's images: the HD pack's (an ImageBitmap) or the disc's own RGBA.
export function createTexture(source) {
  const texture = source.bitmap ? new THREE.Texture(source.bitmap) : new THREE.DataTexture(source.rgba, source.width, source.height, THREE.RGBAFormat);
  texture.flipY = false;
  texture.colorSpace = THREE.NoColorSpace;   // the game mixes in the screen's gamma, so these are used as they are
  texture.wrapS = WRAP[source.wrapS] || THREE.ClampToEdgeWrapping;
  texture.wrapT = WRAP[source.wrapT] || THREE.ClampToEdgeWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

// The material for one of the model's materials. `textures` are createTexture's, `shiny` the model's filter when
// it's to be shown, `shape` a mesh drawn with it (whether it has vertex colours and bump vectors).
export function createMaterial(source, textures, lighting, { shape, shiny = null }) {
  // A layer whose image couldn't be read is left out
  const layers = source.layers.map(layer => ({ ...layer, map: textures[layer.texture] || null }));
  const vertexColors = Boolean(shape.color), bump = layers.some(layer => layer.map && layer.bump) && Boolean(shape.binormal);
  const sources = [...new Set(layers.filter(layer => layer.map && layer.coord === COORD.UV).map(layer => layer.source))];
  const uniforms = {
    ...lighting,
    diffuse: { value: new THREE.Vector3(...source.diffuse) }, ambient: { value: new THREE.Vector3(...source.ambient) },
    specular: { value: new THREE.Vector3(...source.specularColor) }, alpha: { value: source.alpha }, shininess: { value: source.shininess },
    shinyScale: { value: new THREE.Vector3(...(shiny?.scale || [1, 1, 1])) },
  };
  layers.forEach((layer, i) => {
    if (!layer.map) return;
    uniforms[`map${i}`] = { value: layer.map };
    uniforms[`xform${i}`] = { value: new THREE.Vector4(1, 1, 0, 0) };
    uniforms[`blend${i}`] = { value: layer.blending };
    if (layer.tev) {
      uniforms[`k${i}`] = { value: new THREE.Vector4(...layer.tev.konst) };
      uniforms[`r${i}a`] = { value: new THREE.Vector4(...layer.tev.tev0) };
      uniforms[`r${i}b`] = { value: new THREE.Vector4(...layer.tev.tev1) };
    }
  });
  const material = new THREE.ShaderMaterial({ uniforms, vertexShader: VERTEX({ sources, vertexColors, bump }),
    fragmentShader: fragmentShader({ ...source, layers: undefined }, bump ? layers : layers.map(layer => ({ ...layer, bump: false })), { vertexColors, shiny }),
    side: shape.doubleSided ? THREE.DoubleSide : THREE.FrontSide });
  // How it lands on the screen: the material's own pixel-engine settings, or the game's defaults for see-through
  // (blended, on top of the depth it doesn't write when it says) and solid materials
  const pe = source.pe;
  if (pe) {
    material.depthTest = Boolean(pe.flags & 0x10);
    material.depthWrite = Boolean(pe.flags & 0x20);
    material.depthFunc = DEPTH[pe.zCompare] ?? THREE.LessEqualDepth;
    if (pe.blendType === 1 || pe.blendType === 3) {
      Object.assign(material, { transparent: true, blending: THREE.CustomBlending, blendEquation: pe.blendType === 3 ? THREE.ReverseSubtractEquation : THREE.AddEquation,
        blendSrc: SOURCE_FACTOR[pe.srcFactor] ?? THREE.SrcAlphaFactor, blendDst: DEST_FACTOR[pe.dstFactor] ?? THREE.OneMinusSrcAlphaFactor });
      if (pe.blendType === 3) Object.assign(material, { blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor });
    } else material.blending = THREE.NoBlending;
  } else if (source.xlu) {
    Object.assign(material, { transparent: true, blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
      blendSrc: THREE.SrcAlphaFactor, blendDst: THREE.OneMinusSrcAlphaFactor, depthWrite: source.zUpdate,
      depthFunc: source.zAlways ? THREE.AlwaysDepth : THREE.LessEqualDepth });
  } else Object.assign(material, { blending: THREE.NoBlending, depthWrite: true, depthFunc: source.zAlways ? THREE.AlwaysDepth : THREE.LessEqualDepth });
  material.userData.layers = layers;
  return material;
}

