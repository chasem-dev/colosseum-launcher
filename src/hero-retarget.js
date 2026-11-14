'use strict';

// Wes's animations on another hero's skeleton, for the Customize page: the Game Boy Advance heroes' battle models
// have no Snag Machine clips (Wes's battle slots 6 and 7), so they're played from Wes's own, moved over.
//
// The skeletons are matched limb by limb, as a person's: each model at its rest pose, made the same height, gives
// its feet (the lowest joints moving vertices, one each side), its hips (where the legs meet), its head (the highest)
// and its hands (the furthest out each side, off the legs). The chains between them pair up joint for joint, each with
// the nearest of the same chain: hips to each foot, hips to head, and each shoulder to its hand. Matching by nearest
// vertex doesn't work for Wes: his coat hangs where the others' legs are. A joint of the hero's on no chain (a hat, a
// bag, fingers) keeps its rest pose on its parent; one of Wes's on no chain (his coat) isn't used.
//
// Then, frame by frame, each chain joint of the hero turns in the world as its joint of Wes's turns from Wes's rest
// pose. The rest poses aren't the same (arms out at other angles), so first each joint is turned to point along its
// joint of Wes's at rest, and the animation's turns are applied on top of that. Bones keep the hero's own lengths;
// the hips move as Wes's do, scaled by the heroes' heights.

// --- 3x3 rotations and 4x4 matrices, column-major as three.js (model-rig.js) keeps them --------------------

function jointLocal(scale, rotation, translation) {
  const [x, y, z] = rotation, sx = Math.sin(x), cx = Math.cos(x), sy = Math.sin(y), cy = Math.cos(y), sz = Math.sin(z), cz = Math.cos(z);
  const [a, b, c] = scale;
  return [cz * cy * a, sz * cy * a, -sy * a, 0,
    (cz * sx * sy - cx * sz) * b, (sz * sx * sy + cx * cz) * b, cy * sx * b, 0,
    (cz * cx * sy + sx * sz) * c, (sz * cx * sy - sx * cz) * c, cy * cx * c, 0,
    translation[0], translation[1], translation[2], 1];
}
function multiply(a, b) {
  const out = new Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++)
    out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  return out;
}
const apply = (m, [x, y, z]) => [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
// A matrix's rotation, without its scale: three columns, each of length 1 (r[c * 3 + row])
function rotationOf(m) {
  const out = new Array(9);
  for (let c = 0; c < 3; c++) {
    const length = Math.hypot(m[c * 4], m[c * 4 + 1], m[c * 4 + 2]) || 1;
    for (let r = 0; r < 3; r++) out[c * 3 + r] = m[c * 4 + r] / length;
  }
  return out;
}
function mul3(a, b) {
  const out = new Array(9);
  for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) out[c * 3 + r] = a[r] * b[c * 3] + a[3 + r] * b[c * 3 + 1] + a[6 + r] * b[c * 3 + 2];
  return out;
}
const transpose3 = m => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
const apply3 = (m, [x, y, z]) => [m[0] * x + m[3] * y + m[6] * z, m[1] * x + m[4] * y + m[7] * z, m[2] * x + m[5] * y + m[8] * z];
const IDENTITY3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
// The shortest turn taking direction `from` to direction `to` (both of length 1)
function turnBetween(from, to) {
  const [ax, ay, az] = from, [bx, by, bz] = to;
  const cross = [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx], dot = ax * bx + ay * by + az * bz;
  const s = Math.hypot(...cross);
  if (s < 1e-6) return dot > 0 ? IDENTITY3 : turnAbout(Math.abs(ax) < 0.9 ? [1, 0, 0] : [0, 1, 0], from, Math.PI);
  return turnAbout(cross.map(v => v / s), null, Math.atan2(s, dot));
}
// A turn by `angle` about an axis (perpendicular to `from`, when the axis is to be made from it)
function turnAbout(axis, from, angle) {
  let [x, y, z] = axis;
  if (from) {
    const [fx, fy, fz] = from, c = [y * fz - z * fy, z * fx - x * fz, x * fy - y * fx], l = Math.hypot(...c);
    [x, y, z] = c.map(v => v / l);
  }
  const c = Math.cos(angle), s = Math.sin(angle), t = 1 - c;
  return [t * x * x + c, t * x * y + s * z, t * x * z - s * y, t * x * y - s * z, t * y * y + c, t * y * z + s * x, t * x * z + s * y, t * y * z - s * x, t * z * z + c];
}
// The rotation as jointLocal takes it: about X, then Y, then Z
function eulerOf(r) {
  const sy = Math.max(-1, Math.min(1, -r[2]));
  if (Math.abs(sy) < 0.99999) return [Math.atan2(r[5], r[8]), Math.asin(sy), Math.atan2(r[1], r[0])];
  return [Math.atan2(-r[7], r[4]), Math.asin(sy), 0];
}
const normalize = v => { const l = Math.hypot(...v) || 1; return v.map(x => x / l); };
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

// --- A model at a pose --------------------------------------------------------------------------------------

// Each joint's matrix in the model's space, from nine values a joint (model-rig.js's order: scale, rotation,
// translation). Parents come before their children (hsd-model.js).
function worlds(model, values) {
  const out = [];
  model.joints.forEach((joint, j) => {
    const o = j * 9, local = jointLocal(values.slice(o, o + 3), values.slice(o + 3, o + 6), values.slice(o + 6, o + 9));
    out.push(joint.parent >= 0 ? multiply(out[joint.parent], local) : local);
  });
  return out;
}
const restValues = model => model.joints.flatMap(joint => [...joint.scale, ...joint.rotation, ...joint.translation]);

// Every vertex at the rest pose, with the joint that moves it most (model-rig.js's draw matrices).
function restVertices(model) {
  const world = worlds(model, restValues(model)), inverse = model.inverseBind.map(m => m && Array.from(m));
  const draw = model.draw.map(({ parts }) => {
    const m = new Array(16).fill(0);
    for (const { joint, weight, inverse: undo } of parts) {
      const part = undo && inverse[joint] ? multiply(world[joint], inverse[joint]) : world[joint];
      for (let e = 0; e < 16; e++) m[e] += part[e] * weight;
    }
    const main = parts.reduce((best, part) => (part.weight > best.weight ? part : best), parts[0]);
    return { m, joint: main ? main.joint : -1 };
  });
  const vertices = [];
  for (const shape of model.shapes) for (let i = 0; i < shape.drawIndex.length; i++) {
    const d = draw[shape.drawIndex[i]];
    if (!d || d.joint < 0) continue;
    vertices.push({ at: apply(d.m, [shape.position[i * 3], shape.position[i * 3 + 1], shape.position[i * 3 + 2]]), joint: d.joint });
  }
  return { vertices, world };
}

// Positions made the same size for both models: feet at 0, a height of 1, centred.
function framer(vertices) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const { at } of vertices) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], at[k]); hi[k] = Math.max(hi[k], at[k]); }
  const height = hi[1] - lo[1] || 1, centre = [(lo[0] + hi[0]) / 2, lo[1], (lo[2] + hi[2]) / 2];
  return { height, place: at => [(at[0] - centre[0]) / height, (at[1] - centre[1]) / height, (at[2] - centre[2]) / height] };
}

// --- Matching the joints ------------------------------------------------------------------------------------

// A model at rest, as the matching sees it: each joint's place and the middle of the vertices it moves, made the
// same size as any other model's, and its parent and children.
function skeletonOf(model) {
  const { vertices, world } = restVertices(model), frame = framer(vertices);
  const sums = model.joints.map(() => [0, 0, 0, 0]);
  for (const { at, joint } of vertices) {
    const p = frame.place(at), sum = sums[joint];
    sum[0] += p[0]; sum[1] += p[1]; sum[2] += p[2]; sum[3]++;
  }
  const children = model.joints.map(() => []);
  model.joints.forEach((joint, j) => { if (joint.parent >= 0) children[joint.parent].push(j); });
  return {
    world, height: frame.height, children, parent: model.joints.map(joint => joint.parent),
    at: world.map(m => frame.place([m[12], m[13], m[14]])),
    middle: sums.map(([x, y, z, n]) => (n ? [x / n, y / n, z / n] : null)),
  };
}

const ancestry = (sk, j) => { const out = []; for (let k = j; k >= 0; k = sk.parent[k]) out.push(k); return out; };
// The joints from `from` (not included) down to `to`
function pathDown(sk, from, to) {
  const up = ancestry(sk, to), i = up.indexOf(from);
  return i < 0 ? [to] : up.slice(0, i).reverse();
}
function commonAncestor(sk, a, b) {
  const up = new Set(ancestry(sk, a));
  for (const k of ancestry(sk, b)) if (up.has(k)) return k;
  return 0;
}

// The chains of a skeleton: { hips, root (hips' ancestors, hips first), legs, arms, spine }, each limb a list of
// joints from the body outwards.
function limbs(sk) {
  const skinned = sk.middle.map((m, j) => (m ? j : -1)).filter(j => j >= 0);
  const pick = (list, score) => list.reduce((best, j) => (best < 0 || score(j) > score(best) ? j : best), -1);
  const side = sign => skinned.filter(j => Math.sign(sk.middle[j][0]) === sign);
  const feet = [-1, 1].map(sign => pick(side(sign), j => -sk.middle[j][1]));
  if (feet.some(j => j < 0)) throw new Error('This model doesn\'t stand on two feet.');
  const hips = commonAncestor(sk, feet[0], feet[1]), legs = feet.map(foot => pathDown(sk, hips, foot));
  const onLegs = new Set(legs.flat());
  const head = pick(skinned.filter(j => !onLegs.has(j)), j => sk.middle[j][1]);
  const spine = pathDown(sk, hips, head), onSpine = new Set([hips, ...spine]);
  const arms = [-1, 1].map(sign => {
    const hand = pick(side(sign).filter(j => !onLegs.has(j) && !onSpine.has(j)), j => Math.abs(sk.middle[j][0]));
    if (hand < 0) return [];
    const shoulder = ancestry(sk, hand).find(k => onSpine.has(k));
    return shoulder === undefined ? [hand] : pathDown(sk, shoulder, hand);
  });
  return { hips, root: ancestry(sk, hips), legs, arms, spine };
}

function matchJoints(source, target) {
  const ss = skeletonOf(source), ts = skeletonOf(target), sl = limbs(ss), tl = limbs(ts);
  const map = target.joints.map(() => -1), next = target.joints.map(() => -1), sourceNext = new Map();
  // Each joint of a chain of the hero's goes to the nearest joint of Wes's chain (the skeletons are made the same
  // height): a chain that runs on past Wes's (a spine into a hat) leaves its last joints on his last.
  const pair = (tChain, sChain) => {
    if (!tChain.length || !sChain.length) return;
    tChain.forEach((j, i) => {
      let best = sChain[0];
      for (const k of sChain) if (Math.hypot(...sub(ss.at[k], ts.at[j])) < Math.hypot(...sub(ss.at[best], ts.at[j]))) best = k;
      map[j] = best;
      if (i + 1 < tChain.length) next[j] = tChain[i + 1];
    });
    sChain.forEach((j, i) => { if (i + 1 < sChain.length) sourceNext.set(j, sChain[i + 1]); });
  };
  // The hips and what's above them, from the hips up; then the limbs
  tl.root.forEach((j, i) => { map[j] = sl.root[Math.min(i, sl.root.length - 1)]; });
  pair([tl.hips, ...tl.spine], [sl.hips, ...sl.spine]);
  tl.legs.forEach((chain, i) => pair([tl.hips, ...chain], [sl.hips, ...sl.legs[i]]));
  tl.arms.forEach((chain, i) => pair(chain, sl.arms[i]));
  next[tl.hips] = tl.spine[0] ?? -1;
  return { map, next, sourceNext, hips: tl.hips, scale: ts.height / ss.height, sourceRest: ss.world, targetRest: ts.world, sourceAt: ss.at, targetAt: ts.at };
}

// --- The animation ------------------------------------------------------------------------------------------

// Wes's clip (hsd-model.js parseClip, on `source`) for `target`'s skeleton.
function retarget(source, clip, target, match = matchJoints(source, target)) {
  const { map, next, sourceNext, hips, scale, sourceRest, targetRest, sourceAt, targetAt } = match;
  // At rest, each chain joint of the hero turned to point along its joint of Wes's: the hero in Wes's rest pose. A
  // joint points at the next of its chain that sits somewhere else (a thigh is two joints in one place); a chain's
  // last joint turns as the one before it.
  const apart = (at, a, b) => Math.hypot(...sub(at[b], at[a])) > 1e-4;
  const onward = (from, step, at) => { let k = step(from); while (k !== undefined && k >= 0 && !apart(at, from, k)) k = step(k); return k; };
  const restTurn = target.joints.map(() => IDENTITY3);
  for (let j = 0; j < target.joints.length; j++) {
    if (map[j] < 0) continue;
    const s = map[j], n = onward(j, k => next[k], targetAt);
    let to = null;
    if (n !== undefined && n >= 0) {
      // Wes's joint for the hero's next one, or along Wes's own chain when both are on the same joint of his
      const sn = map[n] !== s && apart(sourceAt, s, map[n]) ? map[n] : onward(s, k => sourceNext.get(k), sourceAt);
      if (sn !== undefined && sn >= 0) to = normalize(sub(sourceAt[sn], sourceAt[s]));
    }
    if (to) restTurn[j] = turnBetween(normalize(sub(targetAt[n], targetAt[j])), to);
    else if (target.joints[j].parent >= 0 && map[target.joints[j].parent] >= 0) restTurn[j] = restTurn[target.joints[j].parent];
  }
  const sourceRestRot = sourceRest.map(rotationOf), targetRestRot = targetRest.map(rotationOf);
  const jointCount = target.joints.length, sourceCount = source.joints.length, values = new Float32Array(clip.frames * jointCount * 9);
  const rest = restValues(target);
  for (let frame = 0; frame < clip.frames; frame++) {
    const sourceWorld = worlds(source, Array.from(clip.values.subarray(frame * sourceCount * 9, (frame + 1) * sourceCount * 9)));
    const turned = new Array(jointCount), placed = new Array(jointCount), o = frame * jointCount * 9;
    for (let j = 0; j < jointCount; j++) {
      const joint = target.joints[j], s = map[j], parent = joint.parent;
      const parentRot = parent >= 0 ? turned[parent] : IDENTITY3, parentAt = parent >= 0 ? placed[parent] : [0, 0, 0];
      const restLocal = rest.slice(j * 9 + 3, j * 9 + 6);
      let translation = rest.slice(j * 9 + 6, j * 9 + 9), local, world;
      if (s < 0) {
        // On no chain: as at rest, on its parent
        local = rotationOf(jointLocal([1, 1, 1], restLocal, [0, 0, 0]));
        world = mul3(parentRot, local);
      } else {
        // How Wes's joint turned from rest, in the world, applied to the hero's joint as it would stand in Wes's rest
        const delta = mul3(rotationOf(sourceWorld[s]), transpose3(sourceRestRot[s]));
        world = mul3(delta, mul3(restTurn[j], targetRestRot[j]));
        local = mul3(transpose3(parentRot), world);
      }
      const parentScale = parent >= 0 ? target.joints[parent].scale : [1, 1, 1];
      let at;
      if (j === hips && s >= 0) {
        const moved = sub([sourceWorld[s][12], sourceWorld[s][13], sourceWorld[s][14]], [sourceRest[s][12], sourceRest[s][13], sourceRest[s][14]]);
        at = [targetRest[j][12] + moved[0] * scale, targetRest[j][13] + moved[1] * scale, targetRest[j][14] + moved[2] * scale];
        translation = apply3(transpose3(parentRot), sub(at, parentAt)).map((v, k) => v / (parentScale[k] || 1));
      } else {
        const offset = apply3(parentRot, translation.map((t, k) => t * parentScale[k]));
        at = [parentAt[0] + offset[0], parentAt[1] + offset[1], parentAt[2] + offset[2]];
      }
      turned[j] = world;
      placed[j] = at;
      // A joint whose turn can't be worked out (it never should) stays as at rest, rather than vanishing
      const rotation = s < 0 ? restLocal : eulerOf(local), ok = rotation.every(Number.isFinite) && translation.every(Number.isFinite);
      values.set([...rest.slice(j * 9, j * 9 + 3), ...(ok ? rotation : restLocal), ...(ok ? translation : rest.slice(j * 9 + 6, j * 9 + 9))], o + j * 9);
      if (!ok) { turned[j] = mul3(parentRot, rotationOf(jointLocal([1, 1, 1], restLocal, [0, 0, 0]))); placed[j] = parentAt; }
    }
  }
  return { frames: clip.frames, fps: clip.fps, values, materials: [], alphas: [] };
}


module.exports = { matchJoints, retarget, limbs, skeletonOf, eulerOf, jointLocal };
