'use strict';
// The heroes' colour regions, for the Customize page. Each hero's model has body textures (clothes, bag, hands)
// and a face texture, so a region is a set of texels: the main process sorts each texture's texels
// by colour (classify, blendEdges), and the page repaints a region with the chosen colour (recolor) every time a
// colour changes, keeping each texel as much lighter or darker than the region's typical shade as it was on the
// disc. The colour maths is the SMS launcher's Mario customizer's (mario-colors.js).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ColoHeroColors = factory();
})(typeof self !== 'undefined' ? self : this, () => {
  const rgb = value => [1, 3, 5].map(i => parseInt(value.slice(i, i + 2), 16));
  const seeds = list => list.map(value => rgb(`#${value}`));

  // Seeds are a few shades of each region as the disc has them (the lightest, typical and darkest of each colour
  // of the model's textures). A `face` region is only looked for on the face; the rest only on the body.
  // `keep` seeds catch texels no region should take: the whites of the eyes, lines, the mouth.
  // `battle` is the hero's battle model (a pkx archive), `stand` the model shown standing when it isn't the battle
  // model: `file` the archive, `entry` the model's id in it, `idle` the clip it stands in. Wes stands as his field
  // model, as on the name screen: his battle model's idle is his battle stance, and the opening's (ken_c1) has his
  // goggles down and no Snag Machine. The Game Boy Advance heroes' battle models stand at ease, with more detail
  // than their field models.
  const HEROES = [
    { id: 'wes', label: 'Wes', from: 'Pokémon Colosseum', stand: { file: 'field_common.fsys', entry: 0x00f70400, idle: 1 }, battle: { file: 'pkx_ken_a1.fsys' }, regions: [
      { id: 'coat', label: 'Coat', seeds: seeds(['0a3f5f', '0d4f78', '10537e']) },
      { id: 'suit', label: 'Suit', seeds: seeds(['151515', '2b2526', '313131', '1d202e', '292839', '363547']) },
      { id: 'trim', label: 'Trim', seeds: seeds(['731e00', '7f2200', '843000', '421000', '4f1500', '9c2c00', 'ad3800', 'ce5900']) },
      { id: 'machine', label: 'Snag Machine', seeds: seeds(['6d657b', '94869c', 'd6cfde', '29345a', '473f76', '6b558c']) },
      { id: 'hair', label: 'Hair', seeds: seeds(['786d57', '867965', '91826d']) },
      { id: 'skin', label: 'Skin', face: true, body: true, seeds: seeds(['a16d44', 'c6925a', 'c8935d', 'bd865a', 'cb9b6b', 'd0a073']) },
      { id: 'eyes', label: 'Eyes', face: true, body: false, seeds: seeds(['8c5710', 'ac7147', 'bd794a', 'b57510', 'ce8a18', 'e79e08']) },
    ], keep: seeds(['d6c7b5', 'ded3c6', 'e7dfd6', '4a1410', '652f1d', '7b5139', '6b594a', '8c6a4f']), presets: [
      { id: 'crimson', label: 'Crimson', colors: { coat: '#8c1c24', trim: '#e0a43a' } },
      { id: 'forest', label: 'Forest', colors: { coat: '#1f5a32', trim: '#d2b44a', suit: '#1c211c' } },
      { id: 'midnight', label: 'Midnight', colors: { coat: '#20223a', suit: '#0d0d12', trim: '#3fa9f5' } },
      { id: 'snow', label: 'Snow', colors: { coat: '#d6dbe3', suit: '#3a3f4a', trim: '#2a7fd4' } },
    ] },
    { id: 'brendan', label: 'Brendan', from: 'Pokémon Ruby and Sapphire', battle: { file: 'pkx_agb_m_a1.fsys' }, regions: [
      { id: 'jacket', label: 'Jacket', seeds: seeds(['9f1d21', 'a41e23', 'a51e23', '631010', '751418', '841818']) },
      { id: 'black', label: 'Shirt and shorts', seeds: seeds(['212021', '2e2d2e', '2d2e2d']) },
      { id: 'white', label: 'Hat and white', seeds: seeds(['a2a0a2', 'c3c0c0', 'ffffff']) },
      { id: 'bag', label: 'Bag', seeds: seeds(['a59652', 'ada25a', 'b5a66b', '7e713c', '908346', '9c8e52']) },
      { id: 'skin', label: 'Skin', face: true, body: true, seeds: seeds(['ce925a', 'f4c08c', 'f7c38c', 'dbaa75']) },
      { id: 'eyes', label: 'Eyes', face: true, body: false, seeds: seeds(['42414a', '524d4a', '75767b', '97989f']) },
    ], keep: seeds(['e7e7e7', 'fffbff', 'ffffff', 'efddcd', '736257', '90755e']), presets: [
      { id: 'emerald', label: 'Emerald', colors: { jacket: '#2f8a4a', bag: '#d8c060' } },
      { id: 'ocean', label: 'Ocean', colors: { jacket: '#2459b0', black: '#1a2233' } },
      { id: 'shadow', label: 'Shadow', colors: { jacket: '#2a2a33', black: '#101014', white: '#7a7a86', bag: '#5a5a66' } },
    ] },
    { id: 'may', label: 'May', from: 'Pokémon Ruby and Sapphire', battle: { file: 'pkx_agb_f_a1.fsys' }, regions: [
      { id: 'shirt', label: 'Shirt and bandana', seeds: seeds(['811002', '9c2821', 'a42c21', 'a5261b', 'a52c21', 'ad3021']) },
      { id: 'shorts', label: 'Shorts', seeds: seeds(['333233', '363536']) },
      { id: 'white', label: 'White', seeds: seeds(['bdc3ce', 'dee3e7', 'ffffff']) },
      { id: 'details', label: 'Gloves and shoes', seeds: seeds(['292c5a', '393960', '4c497b']) },
      { id: 'bag', label: 'Bag', seeds: seeds(['9c7f2d', 'ad9239', 'baa74f']) },
      { id: 'hair', label: 'Hair', seeds: seeds(['755f4c', '816d5a', '8c7563']) },
      { id: 'skin', label: 'Skin', face: true, body: true, seeds: seeds(['c8a680', 'efcb9c', 'f1cba2', 'd6aa84', 'efc9a0']) },
      { id: 'eyes', label: 'Eyes', face: true, body: false, seeds: seeds(['36436d', '4a5573', '7070a1', '7e85a1', '73a6bd', '31366a', '423c7b']) },
    ], keep: seeds(['cecbd6', 'e7e7ff', 'ffffff', 'c6554a', 'cd7c54', 'e79673']), presets: [
      { id: 'emerald', label: 'Emerald', colors: { shirt: '#2f8a4a' } },
      { id: 'sky', label: 'Sky', colors: { shirt: '#3a7ad8', shorts: '#1c2440' } },
      { id: 'sunset', label: 'Sunset', colors: { shirt: '#e07a20', shorts: '#3a2a5a', bag: '#c84a6a' } },
    ] },
    { id: 'red', label: 'Red', from: 'Pokémon FireRed and LeafGreen', battle: { file: 'pkx_akami_m_a1.fsys' }, regions: [
      { id: 'vest', label: 'Vest and cap', seeds: seeds(['993a31', 'a54539', 'aa4639', '6b2418', '782920', '833026']) },
      { id: 'jeans', label: 'Jeans', seeds: seeds(['4a697b', '5a7b8e', '5a7d8e']) },
      { id: 'shirt', label: 'Shirt', seeds: seeds(['101029', '1b1a3c', '1c1c41']) },
      { id: 'white', label: 'White', seeds: seeds(['cec7ad', 'ffffff']) },
      { id: 'bag', label: 'Bag', seeds: seeds(['b5a252', 'c6ae5a', 'c8b460', '947d39', '9c8a42', 'a79444']) },
      { id: 'black', label: 'Wristbands', seeds: seeds(['292831', '393c42', '3f3f42']) },
      { id: 'hair', label: 'Hair', seeds: seeds(['8c6139', '906b45', 'ad794a']) },
      { id: 'skin', label: 'Skin', face: true, body: true, seeds: seeds(['d6a673', 'f7c38c', 'daa46f']) },
      { id: 'eyes', label: 'Eyes', face: true, body: false, seeds: seeds(['6b594a', '6b5d52', '7b716b', '8e837b', '9c928c']) },
    ], keep: seeds(['dedbd6', 'efefef', 'ffffff', '3e3e49', '52494a']), presets: [
      { id: 'leafgreen', label: 'Green', colors: { vest: '#2f8a4a' } },
      { id: 'navy', label: 'Navy', colors: { vest: '#24346e', jeans: '#2a2a33' } },
      { id: 'gold', label: 'Gold', colors: { vest: '#d8a832', jeans: '#3a3a44', shirt: '#2a1a10' } },
    ] },
    { id: 'leaf', label: 'Leaf', from: 'Pokémon FireRed and LeafGreen', battle: { file: 'pkx_akami_f_a1.fsys' }, regions: [
      { id: 'top', label: 'Top', seeds: seeds(['6b9aad', '78a8b7']) },
      { id: 'skirt', label: 'Skirt', seeds: seeds(['843831', '9c4942', 'a95145', '8c2c21', 'a74f42']) },
      { id: 'white', label: 'Hat and socks', seeds: seeds(['ffffff', 'd0cdb7', 'e6e1d3', 'eeebde']) },
      { id: 'bag', label: 'Bag', seeds: seeds(['948344', 'b29c4a', 'c6b05a']) },
      { id: 'details', label: 'Details', seeds: seeds(['1b1a3c', '211c42', '424139', '4a4d4a']) },
      { id: 'hair', label: 'Hair', seeds: seeds(['86613c', '8e6944', '997144']) },
      { id: 'skin', label: 'Skin', face: true, body: true, seeds: seeds(['e7ba84', 'f1cba2', 'ce9e75', 'e9be99']) },
      { id: 'eyes', label: 'Eyes', face: true, body: false, seeds: seeds(['5a4942', '63554a', '685e54', '8e817b', '9c938b']) },
    ], keep: seeds(['efd7c6', 'fff7ff', 'ffffff', 'c35f4f', 'd38065']), presets: [
      { id: 'rose', label: 'Rose', colors: { top: '#d86a8a', skirt: '#5a2a4a' } },
      { id: 'mint', label: 'Mint', colors: { top: '#6ad8b0', skirt: '#2a5a6a' } },
      { id: 'night', label: 'Night', colors: { top: '#2a2f4a', skirt: '#141420', white: '#9aa0b4' } },
    ] },
  ];
  const hero = id => HEROES.find(each => each.id === id) || null;

  // What the page can play. `slot` is a trainer's battle motion slot (the game's wazaSequenceTrainerCreate
  // sequence): a hero whose model has none in that slot plays Wes's, moved onto their skeleton (hero-retarget.js).
  // Idle is the hero standing: Wes's field model, else the battle model's slot 0.
  const MOTIONS = [
    { id: 'idle', label: 'Idle' },
    { id: 'stance', label: 'Battle stance', slot: 0 },
    { id: 'throw', label: 'Poké Ball throw', slot: 1 },
    { id: 'snag', label: 'Snag Ball throw', slot: 7 },
    { id: 'snagReady', label: 'Snag Machine ready', slot: 6 },
    // The game gives the rest no names: these say how they look (slot 9 plays slot 8's clip)
    { id: 'wide', label: 'Wide stance', slot: 2 },
    { id: 'lean', label: 'Leaning stance', slot: 3 },
    { id: 'guard', label: 'Guard stance', slot: 4 },
    { id: 'tall', label: 'Standing tall', slot: 5 },
    { id: 'turn', label: 'Quick turn', slot: 8 },
    { id: 'headDown', label: 'Head down', slot: 10 },
  ];
  const motionsOf = id => MOTIONS.filter(motion => !motion.only || motion.only === id);
  // Which model a motion is played on: the battle model, but for a hero's idle when they have a model to stand as
  const modelFor = (id, motion) => (motion === 'idle' && hero(id)?.stand ? 'stand' : 'battle');

  // CIE Lab, with lightness counted at half weight so shading within a region matters less than its hue.
  const LINEAR = Float64Array.from({ length: 256 }, (_, v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
  const lin = v => LINEAR[Math.max(0, Math.min(255, Math.round(v)))];
  function lab([r, g, b]) {
    const R = lin(r), G = lin(g), B = lin(b);
    const f = t => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
    const x = f((0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047), y = f(0.2126 * R + 0.7152 * G + 0.0722 * B);
    const z = f((0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883);
    return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
  }
  // A texture's colours repeat a great deal (an HD image is a million texels of a few thousand colours)
  function labCache() {
    const cache = new Map();
    return (r, g, b) => {
      const key = (r << 16) | (g << 8) | b;
      let value = cache.get(key);
      if (!value) cache.set(key, value = lab([r, g, b]));
      return value;
    };
  }
  function distance(a, b) { return ((a[0] - b[0]) * 0.5) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2; }
  function rgbFromLab([L, a, b]) {
    const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
    const inv = t => t ** 3 > 0.008856 ? t ** 3 : (t - 16 / 116) / 7.787;
    const X = inv(fx) * 0.95047, Y = inv(fy), Z = inv(fz) * 1.08883;
    const gamma = v => 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
    return [3.2406 * X - 1.5372 * Y - 0.4986 * Z, -0.9689 * X + 1.8758 * Y + 0.0415 * Z, 0.0557 * X - 0.204 * Y + 1.057 * Z]
      .map(v => Math.max(0, Math.min(255, Math.round(gamma(Math.max(0, v))))));
  }

  // Each texel's CIE lightness (0-100), stored as 0-255.
  function lightness(rgba, labOf = labCache()) {
    const out = new Uint8Array(rgba.length / 4);
    for (let i = 0; i < out.length; i++) out[i] = Math.round(labOf(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2])[0] * 2.55);
    return out;
  }

  // Textures this small (a lens's gradient) are left as they are
  const SMALLEST = 48 * 48;
  // A texture mostly skin is the face: only face regions are looked for on it
  const FACE_SHARE = 0.6;

  // A region index per texel (into the hero's regions, or 255 to leave as is), and whether it's the face.
  function classify(heroId, rgba, width, height, labOf = labCache()) {
    const { regions, keep } = hero(heroId);
    const mask = new Uint8Array(width * height).fill(255);
    if (width * height < SMALLEST) return { mask, face: false };
    const keepSeeds = keep.map(lab), regionSeeds = regions.map(region => region.seeds.map(lab));
    const run = allowed => {
      for (let i = 0; i < width * height; i++) {
        if (rgba[i * 4 + 3] < 8) { mask[i] = 255; continue; }
        const c = labOf(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]);
        let best = 255, bestDistance = Infinity;
        for (const region of allowed) for (const seed of regionSeeds[region]) {
          const d = distance(c, seed);
          if (d < bestDistance) { bestDistance = d; best = region; }
        }
        for (const seed of keepSeeds) if (distance(c, seed) < bestDistance) { bestDistance = distance(c, seed); best = 255; }
        mask[i] = best;
      }
    };
    const all = regions.map((_, i) => i), skin = regions.findIndex(region => region.id === 'skin');
    run(all.filter(i => regions[i].body !== false));
    let opaque = 0, skinCount = 0;
    for (let i = 0; i < mask.length; i++) if (rgba[i * 4 + 3] >= 8) { opaque++; if (mask[i] === skin) skinCount++; }
    const face = opaque > 0 && skinCount / opaque >= FACE_SHARE;
    if (face) run(all.filter(i => regions[i].face));
    return { mask, face };
  }

  // Each region's typical colour on the disc: the texel of median lightness across every texture, as #rrggbb, with
  // that lightness (0-100).
  function references(heroId, textures) {
    return hero(heroId).regions.map((_, region) => {
      const samples = [];
      for (const { rgba, mask, lightness: light } of textures) for (let i = 0; i < mask.length; i++)
        if (mask[i] === region) samples.push([light[i], i, rgba]);
      if (!samples.length) return null;
      samples.sort((a, b) => a[0] - b[0]);
      const [level, i, rgba] = samples[samples.length >> 1];
      return { color: hex([rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]]), lightness: level / 2.55 };
    });
  }

  // Texels on a border between two regions are a blend of both on the disc. For each, the neighbouring region it
  // blends with (`second`) and how much (`mix`, 0-255), from where its colour lies between the two regions' typical
  // colours.
  function blendEdges(texture, refs, labOf = labCache()) {
    const { rgba, mask, width, height } = texture;
    const second = new Uint8Array(mask.length).fill(255), mix = new Uint8Array(mask.length);
    const refLab = refs.map(ref => ref && lab(rgb(ref.color)));
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const i = y * width + x, own = mask[i];
      if (own === 255 || !refLab[own]) continue;
      const c = labOf(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]), A = refLab[own];
      let best = null;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const other = mask[ny * width + nx];
        if (other === own || other === 255 || !refLab[other]) continue;
        const B = refLab[other], ab = [B[1] - A[1], B[2] - A[2]], length2 = ab[0] ** 2 + ab[1] ** 2;
        if (length2 < 100) continue;  // too alike in hue to tell apart
        const t = Math.max(0, Math.min(1, ((c[1] - A[1]) * ab[0] + (c[2] - A[2]) * ab[1]) / length2));
        const off = (c[1] - A[1] - ab[0] * t) ** 2 + (c[2] - A[2] - ab[1] * t) ** 2;
        if (!best || off < best.off) best = { other, t, off };
      }
      if (best && best.t > 0.04) { second[i] = best.other; mix[i] = Math.round(best.t * 255); }
    }
    return { second, mix };
  }

  // Everything the page needs to repaint a hero's textures: for each texture its region per texel, the region it
  // blends into and how much, and its lightness; and each region's typical colour.
  function prepare(heroId, textures) {
    const labOf = labCache();
    const sorted = textures.map(({ rgba, width, height }) => {
      const { mask, face } = classify(heroId, rgba, width, height, labOf);
      return { rgba, width, height, mask, face, lightness: lightness(rgba, labOf) };
    });
    const refs = references(heroId, sorted);
    for (const texture of sorted) Object.assign(texture, blendEdges(texture, refs, labOf));
    return { refs, textures: sorted.map(({ mask, second, mix, lightness: light, face }) => ({ mask, second, mix, lightness: light, face })) };
  }

  // A region's colour for every original lightness: darker texels keep their share of the region's typical
  // lightness, lighter ones move as far towards white as they were.
  function ramp(color, reference) {
    const [L, a, b] = lab(color), out = new Uint8Array(256 * 3);
    for (let q = 0; q < 256; q++) {
      const level = q / 2.55;
      let shade;
      if (level <= reference) {
        const k = (level + 10) / (reference + 10);
        shade = [L * k, a * k, b * k];
      } else {
        const u = Math.min(1, (level - reference) / Math.max(1, 100 - reference));
        shade = [L + (100 - L) * u, a * (1 - u), b * (1 - u)];
      }
      out.set(rgbFromLab(shade), q * 3);
    }
    return out;
  }

  const hex = values => `#${values.map(v => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
  const rgbOf = value => /^#[0-9a-f]{6}$/i.test(value || '') ? rgb(value) : null;

  // Repaints a texture (`rgba` the disc's or HD pack's, `sorted` prepare's for it) into `out` with the chosen colours
  // (region id -> #rrggbb). Regions without a choice keep their texels, except where they blend into a repainted
  // neighbour.
  function recolor(heroId, rgba, sorted, refs, colors, out = new Uint8ClampedArray(rgba.length)) {
    const { regions } = hero(heroId), { mask, second, mix, lightness: light } = sorted;
    out.set(rgba);
    const chosen = regions.map((region, i) => Boolean(refs[i] && rgbOf(colors[region.id])));
    if (!chosen.some(Boolean)) return out;
    const ramps = regions.map((region, i) => refs[i] && chosen[i] ? ramp(rgbOf(colors[region.id]), refs[i].lightness) : null);
    for (let i = 0; i < mask.length; i++) {
      const r1 = mask[i], r2 = second[i];
      if (!chosen[r1] && !chosen[r2]) continue;
      const o = i * 4, q = light[i] * 3, w = mix[i] / 255;
      for (let c = 0; c < 3; c++) {
        const one = ramps[r1] ? ramps[r1][q + c] : rgba[o + c];
        const two = r2 !== 255 && ramps[r2] ? ramps[r2][q + c] : rgba[o + c];
        out[o + c] = one + (two - one) * w;
      }
    }
    return out;
  }

  // A hero's chosen colours, kept only for real regions and as #rrggbb.
  function normalizeColors(heroId, colors) {
    const out = {}, found = hero(heroId);
    if (found && colors && typeof colors === 'object') for (const { id } of found.regions)
      if (rgbOf(colors[id])) out[id] = colors[id].toLowerCase();
    return out;
  }
  // Every hero's colours: { wes: { coat: '#…' }, … }, and the hero shown last.
  function normalizeLooks(saved) {
    const colors = {};
    for (const { id } of HEROES) colors[id] = normalizeColors(id, saved?.colors?.[id]);
    return { colors, shown: hero(saved?.shown) ? saved.shown : HEROES[0].id };
  }

  return { HEROES, MOTIONS, hero, motionsOf, modelFor, lab, classify, lightness, references, blendEdges, prepare, ramp, recolor, normalizeColors, normalizeLooks, hex };
});
