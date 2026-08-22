import * as THREE from "three";

export type PartId = "horn" | "tail" | "wing" | "ear" | "spike" | "antenna" | "fin";

// A stuck-on piece. The transform is stored in the bone's own space, which is what makes
// it ride the ragdoll for free: the bone is already being driven every frame, so anything
// parented to it inherits the motion without a line of per-frame code.
// `size` is a world-space multiplier, divided by the bone's world scale at attach time,
// so a piece keeps its real size whatever units the rig happens to be authored in.
export type Attachment = {
  id: string;
  part: PartId;
  bone: string;
  position: [number, number, number];
  quaternion: [number, number, number, number];
  size: number;
  color: string;
};

export const PART_LIBRARY: Array<{ id: PartId; label: string; size: number; color: string }> = [
  { id: "horn", label: "HORN", size: 1, color: "#e8d9b0" },
  { id: "ear", label: "EAR", size: 1, color: "#8d6b4f" },
  { id: "tail", label: "TAIL", size: 1, color: "#8d6b4f" },
  { id: "wing", label: "WING", size: 1, color: "#5a7f8c" },
  { id: "fin", label: "FIN", size: 1, color: "#5a7f8c" },
  { id: "spike", label: "SPIKE", size: 1, color: "#cf5a3c" },
  { id: "antenna", label: "ANTENNA", size: 1, color: "#f1d64b" },
];

export const PART_COLORS = ["#e8d9b0", "#8d6b4f", "#5a7f8c", "#cf5a3c", "#f1d64b", "#6f8f5a", "#2b2b30", "#d8d8dc"];

// Sweeps a ring along a curve with a varying radius. Horns, tails, spikes, antennae and
// fin spines are all this one operation with different curves and radius falloffs.
function sweep(
  curve: THREE.Curve<THREE.Vector3>,
  radiusAt: (t: number) => number,
  segments = 20,
  radial = 10,
) {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const frames = curve.computeFrenetFrames(segments, false);
  for (let i = 0; i <= segments; i += 1) {
    const t = i / segments;
    const point = curve.getPointAt(t);
    const normal = frames.normals[i];
    const binormal = frames.binormals[i];
    const radius = radiusAt(t);
    for (let j = 0; j <= radial; j += 1) {
      const angle = (j / radial) * Math.PI * 2;
      const sin = Math.sin(angle);
      const cos = Math.cos(angle);
      const nx = cos * normal.x + sin * binormal.x;
      const ny = cos * normal.y + sin * binormal.y;
      const nz = cos * normal.z + sin * binormal.z;
      positions.push(point.x + radius * nx, point.y + radius * ny, point.z + radius * nz);
      normals.push(nx, ny, nz);
    }
  }
  for (let i = 0; i < segments; i += 1) {
    for (let j = 0; j < radial; j += 1) {
      const a = i * (radial + 1) + j;
      const b = a + radial + 1;
      indices.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geometry.setIndex(indices);
  return geometry;
}

const curveThrough = (points: number[][]) =>
  new THREE.CatmullRomCurve3(points.map(([x, y, z]) => new THREE.Vector3(x, y, z)));

function wingGeometry() {
  // Membrane outline, drawn in XY and extruded a little so it catches the light.
  const shape = new THREE.Shape();
  shape.moveTo(0, 0);
  shape.quadraticCurveTo(0.15, 0.62, 0.62, 0.86);
  shape.quadraticCurveTo(0.5, 0.6, 0.56, 0.52);
  shape.quadraticCurveTo(0.72, 0.58, 0.86, 0.52);
  shape.quadraticCurveTo(0.66, 0.34, 0.6, 0.22);
  shape.quadraticCurveTo(0.5, 0.3, 0.42, 0.24);
  shape.quadraticCurveTo(0.34, 0.1, 0, 0);
  return new THREE.ExtrudeGeometry(shape, { depth: 0.035, bevelEnabled: false });
}

// Every piece is authored with its base at the origin and growing along +Y, so placing
// one is just "line +Y up with the surface normal under the cursor".
function buildGeometry(part: PartId): THREE.BufferGeometry[] {
  switch (part) {
    case "horn":
      return [sweep(curveThrough([[0, 0, 0], [0.02, 0.16, 0.03], [0.05, 0.3, 0.02], [0.06, 0.42, -0.04]]),
        (t) => 0.075 * (1 - t) ** 0.85)];
    case "ear": {
      const geometry = sweep(curveThrough([[0, 0, 0], [0.01, 0.12, 0.01], [0.02, 0.26, 0], [0.02, 0.36, -0.02]]),
        (t) => 0.1 * (1 - t) ** 0.7);
      geometry.scale(1, 1, 0.42);
      return [geometry];
    }
    case "tail":
      return [sweep(curveThrough([[0, 0, 0], [0, 0.22, -0.12], [0.02, 0.4, -0.34], [0.02, 0.5, -0.62], [0, 0.46, -0.86]]),
        (t) => 0.085 * (1 - t) ** 0.6 + 0.012)];
    case "spike":
      return [sweep(curveThrough([[0, 0, 0], [0, 0.07, 0], [0, 0.14, 0], [0, 0.2, 0]]), (t) => 0.05 * (1 - t) ** 1.2)];
    case "antenna":
      return [
        sweep(curveThrough([[0, 0, 0], [0.01, 0.14, 0.01], [0.02, 0.28, 0], [0.03, 0.4, -0.02]]), (t) => 0.016 * (1 - t * 0.4)),
        new THREE.SphereGeometry(0.045, 12, 10).translate(0.03, 0.42, -0.02),
      ];
    case "fin":
      return [0, 1, 2].map((index) => {
        const height = 0.3 - index * 0.07;
        const geometry = sweep(
          curveThrough([[0, 0, index * -0.16], [0, height * 0.6, index * -0.16], [0, height, index * -0.16 - 0.03]]),
          (t) => 0.05 * (1 - t) ** 1.1,
        );
        geometry.scale(0.45, 1, 1);
        return geometry;
      });
    case "wing":
    default:
      return [wingGeometry()];
  }
}

export function buildPart(part: PartId, color: string) {
  const group = new THREE.Group();
  const material = new THREE.MeshStandardMaterial({
    color: new THREE.Color(color),
    roughness: 0.62,
    metalness: 0.05,
    side: part === "wing" ? THREE.DoubleSide : THREE.FrontSide,
  });
  buildGeometry(part).forEach((geometry) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  });
  // The wing is drawn flat in XY; stand it up so its span runs along +Y like the rest.
  if (part === "wing") group.rotation.set(0, -Math.PI / 2, 0);
  return group;
}

export function disposePart(group: THREE.Object3D) {
  group.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    object.geometry.dispose();
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    materials.forEach((material) => material.dispose());
  });
}

// Parents a piece to its bone. Called once when a rig is built, for the local player and
// for every remote avatar, after which the ragdoll carries it.
export function attachToSkeleton(
  attachment: Attachment,
  boneByName: (name: string) => THREE.Bone | undefined,
) {
  const bone = boneByName(attachment.bone);
  if (!bone) return null;
  const group = buildPart(attachment.part, attachment.color);
  group.position.fromArray(attachment.position);
  group.quaternion.fromArray(attachment.quaternion);
  bone.updateWorldMatrix(true, false);
  const boneScale = new THREE.Vector3().setFromMatrixScale(bone.matrixWorld);
  const unit = Math.max((boneScale.x + boneScale.y + boneScale.z) / 3, 1e-6);
  group.scale.setScalar(attachment.size / unit);
  bone.add(group);
  return group;
}
