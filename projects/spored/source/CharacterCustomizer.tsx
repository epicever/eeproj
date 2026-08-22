"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { type Attachment, type PartId, PART_COLORS, PART_LIBRARY, attachToSkeleton, disposePart } from "./characterParts";

const UP = new THREE.Vector3(0, 1, 0);

// Which bone owns the spot under the cursor: sum the skin weights of the triangle that
// was hit and take the loudest. That is the bone whose motion the surface follows, so it
// is the one a piece stuck there should ride.
function dominantBone(mesh: THREE.SkinnedMesh, face: THREE.Face) {
  const skinIndex = mesh.geometry.getAttribute("skinIndex");
  const skinWeight = mesh.geometry.getAttribute("skinWeight");
  if (!skinIndex || !skinWeight) return mesh.skeleton.bones[0];
  const totals = new Map<number, number>();
  [face.a, face.b, face.c].forEach((vertex) => {
    for (let slot = 0; slot < 4; slot += 1) {
      const index = skinIndex.getComponent(vertex, slot);
      const weight = skinWeight.getComponent(vertex, slot);
      if (weight > 0) totals.set(index, (totals.get(index) ?? 0) + weight);
    }
  });
  let best = -1;
  let bestWeight = -1;
  totals.forEach((weight, index) => {
    if (weight > bestWeight) {
      bestWeight = weight;
      best = index;
    }
  });
  return mesh.skeleton.bones[best] ?? mesh.skeleton.bones[0];
}

export default function CharacterCustomizer({
  initial,
  onPlay,
}: {
  initial: Attachment[];
  onPlay: (attachments: Attachment[]) => void;
}) {
  const mountRef = useRef<HTMLDivElement>(null);
  const placeRef = useRef<(x: number, y: number, mirror: boolean) => Attachment[]>(() => []);
  const applyRef = useRef<(list: Attachment[]) => void>(() => undefined);
  const mirrorRef = useRef(true);
  const [attachments, setAttachments] = useState<Attachment[]>(initial);
  const [part, setPart] = useState<PartId>("horn");
  const [color, setColor] = useState(PART_LIBRARY[0].color);
  const [size, setSize] = useState(1);
  const [mirror, setMirror] = useState(true);
  const [ready, setReady] = useState(false);
  const draftRef = useRef({ part, color, size });
  draftRef.current = { part, color, size };
  mirrorRef.current = mirror;

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1b1f1c);
    const camera = new THREE.PerspectiveCamera(38, mount.clientWidth / mount.clientHeight, 0.1, 100);
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.8));
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    mount.appendChild(renderer.domElement);

    scene.add(new THREE.HemisphereLight(0xdff8e7, 0x2a3026, 2.4));
    const key = new THREE.DirectionalLight(0xfff1bf, 2.6);
    key.position.set(-4, 6, 6);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x9ecbff, 1.1);
    rim.position.set(5, 3, -6);
    scene.add(rim);
    const floor = new THREE.Mesh(
      new THREE.CylinderGeometry(2.6, 2.6, 0.12, 40),
      new THREE.MeshStandardMaterial({ color: 0x333a33, roughness: 0.95 }),
    );
    floor.position.y = -0.06;
    scene.add(floor);

    const rigContainer = new THREE.Group();
    scene.add(rigContainer);
    const skinnedMeshes: THREE.SkinnedMesh[] = [];
    const boneByName = new Map<string, THREE.Bone>();
    const placedGroups: THREE.Object3D[] = [];
    let rigScene: THREE.Group | null = null;
    let disposed = false;

    const orbit = { yaw: 0.35, pitch: 0.06, distance: 6.4, target: new THREE.Vector3(0, 1.85, 0) };
    const applyCamera = () => {
      camera.position.set(
        orbit.target.x + Math.sin(orbit.yaw) * Math.cos(orbit.pitch) * orbit.distance,
        orbit.target.y + Math.sin(orbit.pitch) * orbit.distance,
        orbit.target.z + Math.cos(orbit.yaw) * Math.cos(orbit.pitch) * orbit.distance,
      );
      camera.lookAt(orbit.target);
    };
    applyCamera();

    new GLTFLoader().load("./models/gang-beast-rigged.glb", (gltf) => {
      if (disposed) return;
      rigScene = gltf.scene;
      rigContainer.add(rigScene);
      // Normalised exactly as the arena does, so a placement made here lands in the same
      // spot there. Bone-local offsets are scale independent anyway, but keeping the two
      // in step means the preview shows the real thing.
      rigScene.updateMatrixWorld(true);
      const firstSize = new THREE.Box3().setFromObject(rigScene).getSize(new THREE.Vector3());
      rigScene.scale.multiplyScalar(3.65 / Math.max(firstSize.y, 0.001));
      rigScene.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(rigScene);
      const center = box.getCenter(new THREE.Vector3());
      rigScene.position.x -= center.x;
      rigScene.position.y -= box.min.y;
      rigScene.position.z -= center.z;
      rigScene.updateMatrixWorld(true);
      rigScene.traverse((object) => {
        if (object instanceof THREE.SkinnedMesh) skinnedMeshes.push(object);
        if (object instanceof THREE.Bone) {
          const canonical = object.name.startsWith("mixamorig") && !object.name.startsWith("mixamorig:")
            ? object.name.replace(/^mixamorig/, "mixamorig:")
            : object.name;
          object.name = canonical;
          boneByName.set(canonical, object);
        }
      });
      setReady(true);
      applyRef.current(initial);
    });

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();

    const attachmentFromHit = (hit: THREE.Intersection, draft: { part: PartId; color: string; size: number }) => {
      const mesh = hit.object as THREE.SkinnedMesh;
      if (!hit.face || !mesh.isSkinnedMesh) return null;
      const bone = dominantBone(mesh, hit.face);
      if (!bone) return null;
      const normal = hit.face.normal.clone().transformDirection(mesh.matrixWorld).normalize();
      const world = new THREE.Matrix4().compose(
        hit.point,
        new THREE.Quaternion().setFromUnitVectors(UP, normal),
        new THREE.Vector3(1, 1, 1),
      );
      bone.updateWorldMatrix(true, false);
      const local = new THREE.Matrix4().copy(bone.matrixWorld).invert().multiply(world);
      const position = new THREE.Vector3();
      const quaternion = new THREE.Quaternion();
      const scale = new THREE.Vector3();
      local.decompose(position, quaternion, scale);
      const attachment: Attachment & { worldPoint: THREE.Vector3 } = {
        worldPoint: hit.point.clone(),
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
        part: draft.part,
        bone: bone.name,
        position: position.toArray() as [number, number, number],
        quaternion: quaternion.toArray() as [number, number, number, number],
        size: draft.size,
        color: draft.color,
      };
      return attachment;
    };

    placeRef.current = (clientX, clientY, wantsMirror) => {
      if (!rigScene || !skinnedMeshes.length) return [];
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObjects(skinnedMeshes, true);
      if (!hits.length || !hits[0].face) return [];
      const draft = draftRef.current;
      const made: Array<Attachment & { worldPoint: THREE.Vector3 }> = [];
      const first = attachmentFromHit(hits[0], draft);
      if (first) made.push(first);
      if (wantsMirror && first) {
        // Mirror by casting a second ray at the reflected point rather than by flipping a
        // transform: the bind orientations of left and right bones are not guaranteed to
        // be mirror images, but a ray hitting the far side resolves its own bone itself.
        // Reflected in world space, where the rig is centred on x = 0 — rigScene's own
        // frame is not centred, since recentring is done by moving the object.
        const mesh = hits[0].object as THREE.SkinnedMesh;
        const normal = hits[0].face.normal.clone().transformDirection(mesh.matrixWorld).normalize();
        const point = hits[0].point.clone();
        point.x *= -1;
        normal.x *= -1;
        raycaster.set(point.clone().addScaledVector(normal, 3), normal.clone().multiplyScalar(-1));
        const mirrored = raycaster.intersectObjects(skinnedMeshes, true);
        const second = mirrored.length ? attachmentFromHit(mirrored[0], draft) : null;
        // Skip a mirror that lands back on the original spot, as it would along the spine.
        if (second && second.worldPoint.distanceTo(first.worldPoint) > 0.05) made.push(second);
      }
      return made.map(({ worldPoint, ...rest }) => rest as Attachment);
    };

    applyRef.current = (list) => {
      placedGroups.forEach((group) => {
        group.removeFromParent();
        disposePart(group);
      });
      placedGroups.length = 0;
      list.forEach((attachment) => {
        const group = attachToSkeleton(attachment, (name) => boneByName.get(name));
        if (group) placedGroups.push(group);
      });
    };

    let dragging = false;
    let dragged = 0;
    let lastX = 0;
    let lastY = 0;
    const canvas = renderer.domElement;
    const onPointerDown = (event: PointerEvent) => {
      dragging = true;
      dragged = 0;
      lastX = event.clientX;
      lastY = event.clientY;
      try {
        canvas.setPointerCapture(event.pointerId);
      } catch {
        /* a pointer that has already gone away cannot be captured; orbiting still works */
      }
    };
    const onPointerMove = (event: PointerEvent) => {
      if (!dragging) return;
      const dx = event.clientX - lastX;
      const dy = event.clientY - lastY;
      lastX = event.clientX;
      lastY = event.clientY;
      dragged += Math.abs(dx) + Math.abs(dy);
      orbit.yaw -= dx * 0.008;
      orbit.pitch = THREE.MathUtils.clamp(orbit.pitch + dy * 0.006, -0.75, 1.15);
      applyCamera();
    };
    const onPointerUp = (event: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      // A drag turns the model, a tap sticks a piece on.
      if (dragged > 6) return;
      const made = placeRef.current(event.clientX, event.clientY, mirrorRef.current);
      if (made.length) setAttachments((current) => [...current, ...made]);
    };
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      orbit.distance = THREE.MathUtils.clamp(orbit.distance + Math.sign(event.deltaY) * 0.45, 3, 11);
      applyCamera();
    };
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });

    let animation = 0;
    const animate = () => {
      renderer.render(scene, camera);
      animation = requestAnimationFrame(animate);
    };
    animation = requestAnimationFrame(animate);

    const onResize = () => {
      if (!mount.clientWidth || !mount.clientHeight) return;
      camera.aspect = mount.clientWidth / mount.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(mount.clientWidth, mount.clientHeight);
    };
    window.addEventListener("resize", onResize);
    const sizeObserver = new ResizeObserver(onResize);
    sizeObserver.observe(mount);

    return () => {
      disposed = true;
      sizeObserver.disconnect();
      cancelAnimationFrame(animation);
      window.removeEventListener("resize", onResize);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerUp);
      canvas.removeEventListener("wheel", onWheel);
      placedGroups.forEach(disposePart);
      placeRef.current = () => [];
      applyRef.current = () => undefined;
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [initial]);

  useEffect(() => {
    applyRef.current(attachments);
  }, [attachments]);

  return (
    <main className="customizer-shell">
      <div ref={mountRef} className="customizer-stage" aria-label="Character customisation preview" />

      <section className="customizer-panel" aria-label="Character parts">
        <h1>CUSTOMISE</h1>
        <p className="customizer-hint">
          {ready ? "DRAG TO TURN · TAP THE BODY TO STICK A PIECE ON" : "LOADING CHARACTER…"}
        </p>

        <div className="part-grid" role="group" aria-label="Piece">
          {PART_LIBRARY.map((entry) => (
            <button
              key={entry.id}
              aria-pressed={part === entry.id}
              onClick={(event) => { event.currentTarget.blur(); setPart(entry.id); setColor(entry.color); }}
            >
              {entry.label}
            </button>
          ))}
        </div>

        <div className="swatch-row" role="group" aria-label="Colour">
          {PART_COLORS.map((swatch) => (
            <button
              key={swatch}
              className="swatch"
              style={{ background: swatch }}
              aria-label={`Colour ${swatch}`}
              aria-pressed={color === swatch}
              onClick={(event) => { event.currentTarget.blur(); setColor(swatch); }}
            />
          ))}
        </div>

        <label className="customizer-slider">
          <span>SIZE</span>
          <input type="range" min={0.4} max={2.4} step={0.05} value={size} onChange={(event) => setSize(Number(event.target.value))} />
          <b>{size.toFixed(2)}</b>
        </label>

        <div className="customizer-actions">
          <button aria-pressed={mirror} onClick={(event) => { event.currentTarget.blur(); setMirror(!mirror); }}>
            MIRROR {mirror ? "ON" : "OFF"}
          </button>
          <button onClick={(event) => { event.currentTarget.blur(); setAttachments((current) => current.slice(0, -1)); }}>UNDO</button>
          <button onClick={(event) => { event.currentTarget.blur(); setAttachments([]); }}>CLEAR</button>
        </div>

        <p className="customizer-count">{attachments.length} PIECE{attachments.length === 1 ? "" : "S"} STUCK ON</p>
        <button className="play-button" onClick={() => onPlay(attachments)}>ENTER THE YARD →</button>
      </section>
    </main>
  );
}
