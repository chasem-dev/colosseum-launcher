// Posing the game's HSD models in three.js, as hsd-model.js reads them.
import * as THREE from '../node_modules/three/build/three.module.js';

// A joint's local matrix (HSD_MtxSRT): scale, then rotation about X, Y and Z, then
// translation. `parentScale` undoes a parent's uneven scale, as the game does.
export function jointMatrix(scale, rotation, translation, parentScale, out) {
  const sinX = Math.sin(rotation[0]), cosX = Math.cos(rotation[0]), sinY = Math.sin(rotation[1]), cosY = Math.cos(rotation[1]);
  const sinZ = Math.sin(rotation[2]), cosZ = Math.cos(rotation[2]);
  let sx0 = scale[0], sy0 = scale[1], sz0 = scale[2], sx1 = sx0, sy1 = sy0, sz1 = sz0, sx2 = sx0, sy2 = sy0, sz2 = sz0;
  if (parentScale) {
    const [px, py, pz] = parentScale, ix = 1 / px, iy = 1 / py, iz = 1 / pz;
    sy2 *= py * ix;
    sz2 *= pz * ix;
    sx1 *= px * iy;
    sz1 *= pz * iy;
    sx0 *= px * iz;
    sy0 *= py * iz;
  }
  const e = out.elements;
  e[0] = cosZ * sx2 * cosY;
  e[1] = sinZ * sx1 * cosY;
  e[2] = -sx0 * sinY;
  e[3] = 0;
  e[4] = sy2 * (cosZ * sinX * sinY - cosX * sinZ);
  e[5] = sy1 * (sinZ * sinX * sinY + cosX * cosZ);
  e[6] = cosY * sy0 * sinX;
  e[7] = 0;
  e[8] = sz2 * (cosZ * cosX * sinY + sinX * sinZ);
  e[9] = sz1 * (sinZ * cosX * sinY - sinX * cosZ);
  e[10] = cosY * sz0 * cosX;
  e[11] = 0;
  e[12] = translation[0];
  e[13] = translation[1];
  e[14] = translation[2];
  e[15] = 1;
  return out;
}

// Where a texture layer sits (the game's MakeTextureMtx, for a layer that doesn't turn), from its translation and
// scale: `out` gets the scale and offset that take the mesh's coordinates to the texture's.
export function placeTexture(out, layer, translateU, translateV, scaleU, scaleV) {
  const s = Math.abs(scaleU) < Number.EPSILON ? 0 : layer.repeat[0] / scaleU, t = Math.abs(scaleV) < Number.EPSILON ? 0 : layer.repeat[1] / scaleV;
  out.set(s, t, -translateU * s, -(translateV + (layer.mirrorT && t ? 1 / t : 0)) * t);
  return out;
}

// A billboard joint's matrix in view space (displayfunc.c): its own position and scale, its axes turned to the
// camera. `view` is the joint's matrix times the view's.
const EPSILON = 1.1920929e-7;
const column = (m, i) => new THREE.Vector3(m.elements[i * 4], m.elements[i * 4 + 1], m.elements[i * 4 + 2]);
function setColumns(out, ax, ay, az, pos) {
  out.set(ax.x, ay.x, az.x, pos.x, ax.y, ay.y, az.y, pos.y, ax.z, ay.z, az.z, pos.z, 0, 0, 0, 1);
}
export function billboardMatrix(kind, perspective, rotateZ, view, out) {
  const pos = column(view, 3), x = column(view, 0), y = column(view, 1), z = column(view, 2);
  if (kind === 1) {   // mkBillBoardMtx: all round
    let sx = x.length(), sy = y.length();
    const sz = z.length(), az = perspective ? pos.clone().multiplyScalar(-1 / (EPSILON + pos.length())) : new THREE.Vector3(0, 0, 1);
    const ay = y.multiplyScalar(1 / (sy + EPSILON)), ax = new THREE.Vector3().crossVectors(ay, az);
    const mag = ax.length();
    if (mag >= EPSILON) {
      sx /= mag;
      ay.crossVectors(az, ax);
      sy /= EPSILON + ay.length();
    } else {
      ay.y = EPSILON + Math.hypot(az.x, az.z);
      ay.x = az.x * (-az.y / ay.y);
      ay.z = az.z * (-az.y / ay.y);
      ax.crossVectors(ay, az);
      sx /= EPSILON + ax.length();
    }
    setColumns(out, ax.multiplyScalar(sx), ay.multiplyScalar(sy), az.multiplyScalar(sz), pos);
  } else if (kind === 2) {   // mkVBillBoardMtx: upright
    const uy = y.clone().multiplyScalar(1 / (EPSILON + y.length()));
    let sx = x.length(), sz = z.length();
    const az = perspective ? pos.clone().multiplyScalar(-1 / (EPSILON + pos.length())) : new THREE.Vector3(0, 0, 1);
    const ax = new THREE.Vector3().crossVectors(uy, perspective ? az : new THREE.Vector3(0, 0, 1)), mag = ax.length();
    if (mag < EPSILON) return out.copy(view);
    sx /= mag;
    const bz = new THREE.Vector3().crossVectors(ax, uy);
    sz /= EPSILON + bz.length();
    setColumns(out, ax.multiplyScalar(sx), y, bz.multiplyScalar(sz), pos);
  } else if (kind === 3) {   // mkHBillBoardMtx: level
    const ux = x.clone().multiplyScalar(1 / (EPSILON + x.length()));
    let sy = y.length(), sz = z.length();
    const ay = new THREE.Vector3(0, 1, 0);
    if (perspective) {
      ay.y = EPSILON + Math.hypot(pos.x, pos.z);
      ay.x = pos.x * (-pos.y / ay.y);
      ay.z = pos.z * (-pos.y / ay.y);
      ay.normalize();
    }
    const az = new THREE.Vector3().crossVectors(ux, ay), mag = az.length();
    if (mag < EPSILON) return out.copy(view);
    sz /= mag;
    ay.crossVectors(az, ux);
    sy /= EPSILON + ay.length();
    setColumns(out, x, ay.multiplyScalar(sy), az.multiplyScalar(sz), pos);
  } else if (kind === 4) {   // mkRBillBoardMtx: facing the view, turned only by its own Z rotation
    out.makeRotationZ(rotateZ).scale(new THREE.Vector3(x.length(), y.length(), z.length())).setPosition(pos);
  } else out.copy(view);
  return out;
}

// Joints ordered parents first: hsd-model.js lists a parent before its children.
export function createRig(rig, makeMesh) {
  const count = rig.joints.length;
  const world = rig.joints.map(() => new THREE.Matrix4());
  const inverseBind = rig.inverseBind.map(m => (m ? new THREE.Matrix4().fromArray(m) : new THREE.Matrix4()));
  const drawMatrices = rig.draw.map(() => new THREE.Matrix4());
  const meshes = rig.shapes.map(makeMesh);
  const local = new THREE.Matrix4(), product = new THREE.Matrix4(), right = new THREE.Matrix4(), skeleton = new THREE.Matrix4();
  // Billboard joints: their meshes are drawn with this instead of their matrix, made again for each view
  const billboards = rig.joints.map((joint, j) => (joint.billboard ? j : -1)).filter(j => j >= 0);
  const facing = new Map(billboards.map(j => [j, new THREE.Matrix4()])), inView = new THREE.Matrix4(), unview = new THREE.Matrix4();
  const scales = rig.joints.map(() => [1, 1, 1]), hasScale = new Uint8Array(count);
  const rest = new Float32Array(count * 9);
  rig.joints.forEach((joint, j) => rest.set([...joint.scale, ...joint.rotation, ...joint.translation], j * 9));

  // The matrix that moves a mesh from its own joint to its skeleton's frame.
  function nodeMatrix({ owner, skeleton: x, kind }) {
    if (kind === 'bind') return right.copy(inverseBind[x]).invert();
    if (kind === 'root') skeleton.copy(world[x]);
    else skeleton.multiplyMatrices(world[x], inverseBind[x]);
    return right.copy(skeleton).invert().multiply(world[owner]);
  }

  return {
    meshes, world, billboards: billboards.length > 0,
    // `values` holds nine values for each joint: its scale, rotation and translation. `view` takes the rig's space to
    // the camera's, for billboards.
    pose(values = rest, view = null) {
      for (let j = 0; j < count; j++) {
        const joint = rig.joints[j], parent = joint.parent, o = j * 9, scale = scales[j];
        const parentScale = parent >= 0 && hasScale[parent] ? scales[parent] : null;
        // A joint's scale passes down to its children (JObjMakeMatrix).
        if (joint.classicalScale) {
          hasScale[j] = parentScale ? 1 : 0;
          if (parentScale) { scale[0] = parentScale[0]; scale[1] = parentScale[1]; scale[2] = parentScale[2]; }
        } else {
          hasScale[j] = 1;
          scale[0] = values[o] * (parentScale ? parentScale[0] : 1);
          scale[1] = values[o + 1] * (parentScale ? parentScale[1] : 1);
          scale[2] = values[o + 2] * (parentScale ? parentScale[2] : 1);
        }
        jointMatrix(values.subarray(o, o + 3), values.subarray(o + 3, o + 6), values.subarray(o + 6, o + 9), parentScale, local);
        if (parent >= 0) world[j].multiplyMatrices(world[parent], local);
        else world[j].copy(local);
      }
      if (view) unview.copy(view).invert();
      for (const j of billboards) {
        const joint = rig.joints[j];
        if (!view) { facing.get(j).copy(world[j]); continue; }
        billboardMatrix(joint.billboard, joint.perspective, values[j * 9 + 5], inView.multiplyMatrices(view, world[j]), product);
        facing.get(j).multiplyMatrices(unview, product);
      }
      rig.draw.forEach(({ parts, node }, d) => {
        const out = drawMatrices[d];
        if (parts.length === 1 && parts[0].weight === 1 && !parts[0].inverse && !node && facing.has(parts[0].joint)) out.copy(facing.get(parts[0].joint));
        else if (parts.length === 1 && parts[0].weight === 1) {
          if (parts[0].inverse) out.multiplyMatrices(world[parts[0].joint], inverseBind[parts[0].joint]);
          else out.copy(world[parts[0].joint]);
        } else {
          out.elements.fill(0);
          for (const { joint, weight, inverse } of parts) {
            if (inverse) product.multiplyMatrices(world[joint], inverseBind[joint]);
            else product.copy(world[joint]);
            for (let e = 0; e < 16; e++) out.elements[e] += product.elements[e] * weight;
          }
        }
        if (node) out.multiply(nodeMatrix(node));
      });
      for (const { shape, geometry } of meshes) {
        const position = geometry.attributes.position.array, normal = geometry.attributes.normal.array;
        const binormal = geometry.attributes.hsdBinormal?.array, tangent = geometry.attributes.hsdTangent?.array;
        for (let i = 0, n = shape.drawIndex.length; i < n; i++) {
          const m = drawMatrices[shape.drawIndex[i]].elements, o = i * 3;
          const x = shape.position[o], y = shape.position[o + 1], z = shape.position[o + 2];
          position[o] = m[0] * x + m[4] * y + m[8] * z + m[12];
          position[o + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
          position[o + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
          const nx = shape.normal[o], ny = shape.normal[o + 1], nz = shape.normal[o + 2];
          const tx = m[0] * nx + m[4] * ny + m[8] * nz, ty = m[1] * nx + m[5] * ny + m[9] * nz, tz = m[2] * nx + m[6] * ny + m[10] * nz;
          const length = Math.hypot(tx, ty, tz) || 1;
          normal[o] = tx / length;
          normal[o + 1] = ty / length;
          normal[o + 2] = tz / length;
          // A bump map's binormal and tangent: turned, but kept their length, which sets how far the bump reaches
          if (binormal) {
            for (const [from, to] of [[shape.binormal, binormal], [shape.tangent, tangent]]) {
              const bx = from[o], by = from[o + 1], bz = from[o + 2];
              to[o] = m[0] * bx + m[4] * by + m[8] * bz;
              to[o + 1] = m[1] * bx + m[5] * by + m[9] * bz;
              to[o + 2] = m[2] * bx + m[6] * by + m[10] * bz;
            }
          }
        }
        geometry.attributes.position.needsUpdate = true;
        geometry.attributes.normal.needsUpdate = true;
        if (binormal) { geometry.attributes.hsdBinormal.needsUpdate = true; geometry.attributes.hsdTangent.needsUpdate = true; }
      }
    },
  };
}
