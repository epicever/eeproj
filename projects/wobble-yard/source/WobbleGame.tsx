"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import * as CANNON from "cannon-es";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

type Crate = { mesh: THREE.Mesh; vel: THREE.Vector3; half: number };
type RagdollNode = {
  name: string;
  body: CANNON.Body;
  bindOffset: THREE.Vector3;
  muscle: number;
  damping: number;
};
type BoneLink = {
  bone: THREE.Bone;
  basePosition: THREE.Vector3;
  baseQuaternion: THREE.Quaternion;
  baseScale: THREE.Vector3;
  endNode: string;
  bindDirection: THREE.Vector3;
  bindWorldQuaternion: THREE.Quaternion;
};

function applyMuscle(node: RagdollNode, target: THREE.Vector3, strengthScale = 1) {
  const body = node.body;
  const force = new CANNON.Vec3(
    ((target.x - body.position.x) * node.muscle - body.velocity.x * node.damping) * strengthScale,
    ((target.y - body.position.y) * node.muscle - body.velocity.y * node.damping) * strengthScale,
    ((target.z - body.position.z) * node.muscle - body.velocity.z * node.damping) * strengthScale,
  );
  const magnitude = force.length();
  if (magnitude > 560) force.scale(560 / magnitude, force);
  body.applyForce(force);
}

function pointMesh(geometry: THREE.BufferGeometry, material: THREE.Material, scene: THREE.Scene) {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  scene.add(mesh);
  return mesh;
}

export default function WobbleGame() {
  const mountRef = useRef<HTMLDivElement>(null);
  const touchKeys = useRef<Record<string, boolean>>({});

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x151915);
    scene.fog = new THREE.Fog(0x151915, 26, 45);

    const camera = new THREE.PerspectiveCamera(47, mount.clientWidth / mount.clientHeight, 0.1, 100);
    camera.position.set(0, 15, 10.5);

    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.8));
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    mount.appendChild(renderer.domElement);

    scene.add(new THREE.HemisphereLight(0xdff8e7, 0x293023, 2.3));
    const sun = new THREE.DirectionalLight(0xfff1bf, 3.7);
    sun.position.set(-8, 17, 10);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -22;
    sun.shadow.camera.right = 22;
    sun.shadow.camera.top = 20;
    sun.shadow.camera.bottom = -20;
    scene.add(sun);

    const physicsWorld = new CANNON.World({ gravity: new CANNON.Vec3(0, -18, 0) });
    physicsWorld.broadphase = new CANNON.SAPBroadphase(physicsWorld);
    physicsWorld.solver.iterations = 18;
    physicsWorld.allowSleep = false;
    const physicsMaterial = new CANNON.Material("yard");
    physicsWorld.defaultContactMaterial.friction = 0.72;
    physicsWorld.defaultContactMaterial.restitution = 0.04;
    const addStaticBox = (x: number, y: number, z: number, w: number, h: number, d: number) => {
      const body = new CANNON.Body({ mass: 0, material: physicsMaterial, collisionFilterGroup: 1, collisionFilterMask: 2 });
      body.addShape(new CANNON.Box(new CANNON.Vec3(w / 2, h / 2, d / 2)));
      body.position.set(x, y, z);
      physicsWorld.addBody(body);
    };
    addStaticBox(0, -0.28, 0, 34, 0.56, 26);

    const floorMat = new THREE.MeshStandardMaterial({ color: 0x647060, roughness: 0.92, metalness: 0.02 });
    const floor = pointMesh(new THREE.BoxGeometry(34, 0.35, 26), floorMat, scene);
    floor.position.y = -0.2;

    const grid = new THREE.GridHelper(34, 34, 0x8b987f, 0x707b69);
    grid.position.y = 0.001;
    grid.scale.z = 26 / 34;
    (grid.material as THREE.Material).opacity = 0.28;
    (grid.material as THREE.Material).transparent = true;
    scene.add(grid);

    const wallMat = new THREE.MeshStandardMaterial({ color: 0x242b25, roughness: 0.7 });
    const wallSpecs: [number, number, number, number, number][] = [
      [0, 0.7, -13, 34.8, 1.4], [0, 0.7, 13, 34.8, 1.4],
      [-17, 0.7, 0, 1.4, 26], [17, 0.7, 0, 1.4, 26],
    ];
    wallSpecs.forEach(([x, y, z, w, d]) => {
      const wall = pointMesh(new THREE.BoxGeometry(w, 1.4, d), wallMat, scene);
      wall.position.set(x, y, z);
      addStaticBox(x, y, z, w, 1.4, d);
    });

    const stripeMat = new THREE.MeshStandardMaterial({ color: 0xf1d64b, roughness: 0.55 });
    for (let x = -14; x <= 14; x += 4) {
      const stripe = pointMesh(new THREE.BoxGeometry(1.9, 0.025, 0.55), stripeMat, scene);
      stripe.position.set(x, 0.02, -10.4);
      stripe.rotation.y = -0.38;
    }

    const obstacles: { x: number; z: number; hx: number; hz: number }[] = [];
    const obstacleMat = new THREE.MeshStandardMaterial({ color: 0x354038, roughness: 0.65 });
    const addObstacle = (x: number, z: number, w: number, d: number, h: number) => {
      const block = pointMesh(new THREE.BoxGeometry(w, h, d), obstacleMat, scene);
      block.position.set(x, h / 2, z);
      obstacles.push({ x, z, hx: w / 2, hz: d / 2 });
      addStaticBox(x, h / 2, z, w, h, d);
    };
    addObstacle(-8.2, -3.5, 3.4, 1.8, 1.15);
    addObstacle(8.3, 2.2, 2.2, 4.2, 1.15);
    addObstacle(-3.6, 7.4, 5, 1.5, 0.8);

    const coneMat = new THREE.MeshStandardMaterial({ color: 0xff7a3c, roughness: 0.55 });
    [[-12, 7], [12, -7], [3, -7.5], [5, 7]].forEach(([x, z]) => {
      const cone = pointMesh(new THREE.ConeGeometry(0.38, 1.25, 14), coneMat, scene);
      cone.position.set(x, 0.62, z);
    });

    const crates: Crate[] = [];
    const crateMat = new THREE.MeshStandardMaterial({ color: 0xd89a51, roughness: 0.78 });
    [[5.2, 2.4], [-7, 6], [9, -6]].forEach(([x, z]) => {
      const mesh = pointMesh(new THREE.BoxGeometry(1.35, 1.35, 1.35), crateMat, scene);
      mesh.position.set(x, 0.68, z);
      crates.push({ mesh, vel: new THREE.Vector3(), half: 0.675 });
    });

    const rigContainer = new THREE.Group();
    scene.add(rigContainer);
    const ragdollNodes = new Map<string, RagdollNode>();
    const boneLinks: BoneLink[] = [];
    const bindHipsWorld = new THREE.Vector3(0, 1.8, 0);
    let rigScene: THREE.Group | null = null;
    let disposed = false;
    new GLTFLoader().load(
      "./models/gang-beast-rigged.glb",
      (gltf) => {
        if (disposed) return;
        rigScene = gltf.scene;
        rigContainer.add(rigScene);
        rigScene.updateMatrixWorld(true);
        const initialBox = new THREE.Box3().setFromObject(rigScene);
        const initialSize = initialBox.getSize(new THREE.Vector3());
        const normalizedScale = 3.65 / Math.max(initialSize.y, 0.001);
        rigScene.scale.multiplyScalar(normalizedScale);
        rigScene.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(rigScene);
        const center = box.getCenter(new THREE.Vector3());
        rigScene.position.x -= center.x;
        rigScene.position.y -= box.min.y;
        rigScene.position.z -= center.z;
        rigScene.updateMatrixWorld(true);
        const bones = new Map<string, THREE.Bone>();
        rigScene.traverse((object) => {
          if (object instanceof THREE.SkinnedMesh) {
            object.castShadow = true;
            object.receiveShadow = true;
            object.frustumCulled = false;
          }
          if (object instanceof THREE.Bone) {
            const canonicalName = object.name.startsWith("mixamorig") && !object.name.startsWith("mixamorig:")
              ? object.name.replace(/^mixamorig/, "mixamorig:")
              : object.name;
            object.name = canonicalName;
            bones.set(canonicalName, object);
          }
        });

        const profiles: Array<[string, number, number, number, number]> = [
          ["mixamorig:Hips", 6, 0.34, 620, 42],
          ["mixamorig:Spine", 3.5, 0.27, 390, 30],
          ["mixamorig:Spine1", 3, 0.27, 330, 27],
          ["mixamorig:Spine2", 3, 0.3, 280, 24],
          ["mixamorig:Neck", 1.2, 0.2, 175, 16],
          ["mixamorig:Head", 2, 0.32, 145, 15],
          ["mixamorig:LeftShoulder", 1, 0.18, 175, 15],
          ["mixamorig:LeftArm", 1.2, 0.2, 130, 12],
          ["mixamorig:LeftForeArm", 1, 0.18, 95, 9],
          ["mixamorig:LeftHand", 0.7, 0.2, 72, 7],
          ["mixamorig:RightShoulder", 1, 0.18, 175, 15],
          ["mixamorig:RightArm", 1.2, 0.2, 130, 12],
          ["mixamorig:RightForeArm", 1, 0.18, 95, 9],
          ["mixamorig:RightHand", 0.7, 0.2, 72, 7],
          ["mixamorig:LeftUpLeg", 2.8, 0.25, 440, 31],
          ["mixamorig:LeftLeg", 2.3, 0.23, 510, 34],
          ["mixamorig:LeftFoot", 1.5, 0.24, 680, 40],
          ["mixamorig:LeftToeBase", 0.6, 0.17, 560, 30],
          ["mixamorig:RightUpLeg", 2.8, 0.25, 440, 31],
          ["mixamorig:RightLeg", 2.3, 0.23, 510, 34],
          ["mixamorig:RightFoot", 1.5, 0.24, 680, 40],
          ["mixamorig:RightToeBase", 0.6, 0.17, 560, 30],
        ];
        const hipsBone = bones.get("mixamorig:Hips");
        if (!hipsBone) throw new Error("The attached rig has no hips bone");
        hipsBone.getWorldPosition(bindHipsWorld);
        const initialYaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(facing.x, facing.z));
        for (const [name, mass, radius, muscle, damping] of profiles) {
          const bone = bones.get(name);
          if (!bone) continue;
          const bindPosition = bone.getWorldPosition(new THREE.Vector3());
          const bindOffset = bindPosition.sub(bindHipsWorld);
          const startPosition = bindOffset.clone().applyQuaternion(initialYaw).add(new THREE.Vector3(root.x, bindHipsWorld.y, root.z));
          const body = new CANNON.Body({
            mass,
            material: physicsMaterial,
            linearDamping: 0.12,
            angularDamping: 0.95,
            collisionFilterGroup: 2,
            collisionFilterMask: 1,
          });
          body.addShape(new CANNON.Sphere(radius));
          body.position.set(startPosition.x, startPosition.y, startPosition.z);
          physicsWorld.addBody(body);
          ragdollNodes.set(name, { name, body, bindOffset, muscle, damping });
        }

        const connections: Array<[string, string]> = [
          ["mixamorig:Hips", "mixamorig:Spine"], ["mixamorig:Spine", "mixamorig:Spine1"],
          ["mixamorig:Spine1", "mixamorig:Spine2"], ["mixamorig:Spine2", "mixamorig:Neck"],
          ["mixamorig:Neck", "mixamorig:Head"],
          ["mixamorig:Spine2", "mixamorig:LeftShoulder"], ["mixamorig:LeftShoulder", "mixamorig:LeftArm"],
          ["mixamorig:LeftArm", "mixamorig:LeftForeArm"], ["mixamorig:LeftForeArm", "mixamorig:LeftHand"],
          ["mixamorig:Spine2", "mixamorig:RightShoulder"], ["mixamorig:RightShoulder", "mixamorig:RightArm"],
          ["mixamorig:RightArm", "mixamorig:RightForeArm"], ["mixamorig:RightForeArm", "mixamorig:RightHand"],
          ["mixamorig:Hips", "mixamorig:LeftUpLeg"], ["mixamorig:LeftUpLeg", "mixamorig:LeftLeg"],
          ["mixamorig:LeftLeg", "mixamorig:LeftFoot"], ["mixamorig:LeftFoot", "mixamorig:LeftToeBase"],
          ["mixamorig:Hips", "mixamorig:RightUpLeg"], ["mixamorig:RightUpLeg", "mixamorig:RightLeg"],
          ["mixamorig:RightLeg", "mixamorig:RightFoot"], ["mixamorig:RightFoot", "mixamorig:RightToeBase"],
        ];
        for (const [startName, endName] of connections) {
          const startNode = ragdollNodes.get(startName);
          const endNode = ragdollNodes.get(endName);
          const bone = bones.get(startName);
          if (!startNode || !endNode || !bone) continue;
          const distance = startNode.body.position.distanceTo(endNode.body.position);
          const constraint = new CANNON.DistanceConstraint(startNode.body, endNode.body, distance, 100000);
          constraint.collideConnected = false;
          physicsWorld.addConstraint(constraint);
          const startBind = bone.getWorldPosition(new THREE.Vector3());
          const endBind = bones.get(endName)?.getWorldPosition(new THREE.Vector3());
          if (!endBind) continue;
          if (!boneLinks.some((link) => link.bone === bone)) {
            boneLinks.push({
              bone,
              basePosition: bone.position.clone(),
              baseQuaternion: bone.quaternion.clone(),
              baseScale: bone.scale.clone(),
              endNode: endName,
              bindDirection: endBind.sub(startBind).normalize(),
              bindWorldQuaternion: bone.getWorldQuaternion(new THREE.Quaternion()),
            });
          }
        }
      },
      undefined,
      (error) => console.error("Could not load the character rig", error),
    );

    const root = new THREE.Vector3(0, 0, 0);
    const velocity = new THREE.Vector3();
    const previousVelocity = new THREE.Vector3();
    const facing = new THREE.Vector3(0, 0, -1);
    const keys = new Set<string>();
    const mouseButtons = new Set<number>();
    let walkPhase = 0;
    let previous = performance.now();
    let animation = 0;

    const reset = () => {
      root.set(0, 0, 0);
      velocity.set(0, 0, 0);
      previousVelocity.set(0, 0, 0);
      facing.set(0, 0, -1);
      const yaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
      ragdollNodes.forEach((node) => {
        const position = node.bindOffset.clone().applyQuaternion(yaw).add(new THREE.Vector3(0, bindHipsWorld.y, 0));
        node.body.position.set(position.x, position.y, position.z);
        node.body.velocity.setZero();
        node.body.angularVelocity.setZero();
        node.body.force.setZero();
        node.body.wakeUp();
      });
      boneLinks.forEach((link) => {
        link.bone.position.copy(link.basePosition);
        link.bone.quaternion.copy(link.baseQuaternion);
        link.bone.scale.copy(link.baseScale);
      });
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "ShiftLeft"].includes(event.code)) {
        event.preventDefault();
        keys.add(event.code);
      }
      if (event.code === "KeyR") reset();
    };
    const onKeyUp = (event: KeyboardEvent) => keys.delete(event.code);
    const onMouseDown = (event: MouseEvent) => {
      if (event.button === 0 || event.button === 2) mouseButtons.add(event.button);
    };
    const onMouseUp = (event: MouseEvent) => mouseButtons.delete(event.button);
    const onWindowBlur = () => mouseButtons.clear();
    const onContextMenu = (event: MouseEvent) => event.preventDefault();
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    renderer.domElement.addEventListener("mousedown", onMouseDown);
    renderer.domElement.addEventListener("contextmenu", onContextMenu);
    window.addEventListener("mouseup", onMouseUp);
    window.addEventListener("blur", onWindowBlur);

    const resolveObstacle = (position: THREE.Vector3, radius: number) => {
      for (const box of obstacles) {
        const nearestX = THREE.MathUtils.clamp(position.x, box.x - box.hx, box.x + box.hx);
        const nearestZ = THREE.MathUtils.clamp(position.z, box.z - box.hz, box.z + box.hz);
        const dx = position.x - nearestX;
        const dz = position.z - nearestZ;
        const distSq = dx * dx + dz * dz;
        if (distSq < radius * radius) {
          if (distSq > 0.0001) {
            const push = (radius - Math.sqrt(distSq)) / Math.sqrt(distSq);
            position.x += dx * push;
            position.z += dz * push;
          } else {
            position.x += position.x < box.x ? -radius : radius;
          }
          velocity.multiplyScalar(0.72);
        }
      }
    };

    const animate = (now: number) => {
      const dt = Math.min((now - previous) / 1000, 0.033);
      previous = now;
      const touch = touchKeys.current;
      const input = new THREE.Vector3(
        (keys.has("KeyD") || keys.has("ArrowRight") || touch.right ? 1 : 0) - (keys.has("KeyA") || keys.has("ArrowLeft") || touch.left ? 1 : 0),
        0,
        (keys.has("KeyS") || keys.has("ArrowDown") || touch.down ? 1 : 0) - (keys.has("KeyW") || keys.has("ArrowUp") || touch.up ? 1 : 0),
      );
      if (input.lengthSq() > 1) input.normalize();
      const isMoving = input.lengthSq() > 0.01;
      const sprint = keys.has("ShiftLeft") ? 1.35 : 1;
      if (isMoving) {
        velocity.addScaledVector(input, 24 * sprint * dt);
        facing.lerp(input.clone().normalize(), 1 - Math.exp(-8 * dt)).normalize();
      }
      velocity.multiplyScalar(Math.exp(-(isMoving ? 3.8 : 9.5) * dt));
      const maxSpeed = 6.1 * sprint;
      if (velocity.length() > maxSpeed) velocity.setLength(maxSpeed);
      root.addScaledVector(velocity, dt);
      root.x = THREE.MathUtils.clamp(root.x, -15.7, 15.7);
      root.z = THREE.MathUtils.clamp(root.z, -11.7, 11.7);
      resolveObstacle(root, 0.82);

      for (const crate of crates) {
        const delta = crate.mesh.position.clone().sub(root); delta.y = 0;
        const minDist = 0.84 + crate.half;
        if (delta.lengthSq() < minDist * minDist) {
          if (delta.lengthSq() < 0.001) delta.set(1, 0, 0);
          delta.normalize();
          crate.vel.addScaledVector(delta, velocity.length() * 0.65 + 2.2);
          root.addScaledVector(delta, -0.06);
        }
        crate.vel.multiplyScalar(Math.exp(-4.5 * dt));
        crate.mesh.position.addScaledVector(crate.vel, dt);
        crate.mesh.position.x = THREE.MathUtils.clamp(crate.mesh.position.x, -15.4, 15.4);
        crate.mesh.position.z = THREE.MathUtils.clamp(crate.mesh.position.z, -11.4, 11.4);
        crate.mesh.rotation.x += crate.vel.z * dt * 0.18;
        crate.mesh.rotation.z -= crate.vel.x * dt * 0.18;
      }

      const currentSpeed = velocity.length();
      walkPhase += currentSpeed * dt * 2.15;
      const right = new THREE.Vector3(-facing.z, 0, facing.x);
      const speedRatio = THREE.MathUtils.clamp(currentSpeed / maxSpeed, 0, 1);
      const acceleration = velocity.clone().sub(previousVelocity).divideScalar(Math.max(dt, 0.001));
      previousVelocity.copy(velocity);
      const step = Math.sin(walkPhase);
      const oppositeStep = Math.sin(walkPhase + Math.PI);
      const leftLift = Math.max(0, Math.cos(walkPhase));
      const rightLift = Math.max(0, Math.cos(walkPhase + Math.PI));
      const bob = Math.abs(step) * speedRatio * 0.13;
      const yawAngle = Math.atan2(facing.x, facing.z);
      const yaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yawAngle);
      const hipTarget = new THREE.Vector3(root.x, bindHipsWorld.y + bob, root.z);
      const armInertia = acceleration.clone().multiplyScalar(-0.008);

      ragdollNodes.forEach((node) => {
        const target = node.bindOffset.clone().applyQuaternion(yaw).add(hipTarget);
        const leftSide = node.name.includes("Left");
        const rightSide = node.name.includes("Right");
        const isArm = /Shoulder|Arm|ForeArm|Hand/.test(node.name);
        let muscleScale = 1;
        if (isArm) {
          const sideName = leftSide ? "Left" : "Right";
          const armNode = ragdollNodes.get(`mixamorig:${sideName}Arm`);
          const forearmNode = ragdollNodes.get(`mixamorig:${sideName}ForeArm`);
          const handNode = ragdollNodes.get(`mixamorig:${sideName}Hand`);
          const reaching = (leftSide && mouseButtons.has(0)) || (rightSide && mouseButtons.has(2));
          if (armNode && forearmNode && /ForeArm|Hand/.test(node.name)) {
            const armTarget = armNode.bindOffset.clone().applyQuaternion(yaw).add(hipTarget);
            const upperArmLength = armNode.bindOffset.distanceTo(forearmNode.bindOffset);
            if (reaching) {
              const lowerArmLength = handNode ? forearmNode.bindOffset.distanceTo(handNode.bindOffset) : 0;
              const reachLength = /Hand/.test(node.name) ? upperArmLength + lowerArmLength : upperArmLength;
              target.copy(armTarget).addScaledVector(facing, reachLength * 0.92);
              target.y -= 0.12 + reachLength * 0.08;
              muscleScale = /Hand/.test(node.name) ? 0.48 : 0.58;
            } else {
              target.copy(armTarget).add(new THREE.Vector3(0, -upperArmLength, 0));
              if (/Hand/.test(node.name)) target.y -= forearmNode.bindOffset.distanceTo(node.bindOffset);
            }
            target.addScaledVector(right, (leftSide ? -1 : 1) * 0.08);
          }
          target.addScaledVector(facing, (leftSide ? oppositeStep : step) * (reaching ? 0.05 : 0.14) * speedRatio);
          target.addScaledVector(armInertia, /Hand/.test(node.name) ? 1.35 : /ForeArm/.test(node.name) ? 1 : 0.55);
        }
        if (leftSide && /Leg|Foot|Toe/.test(node.name) && !/UpLeg/.test(node.name)) {
          target.addScaledVector(facing, step * 0.58 * speedRatio);
          target.y += leftLift * 0.42 * speedRatio * (/Foot|Toe/.test(node.name) ? 1 : 0.55);
        }
        if (rightSide && /Leg|Foot|Toe/.test(node.name) && !/UpLeg/.test(node.name)) {
          target.addScaledVector(facing, oppositeStep * 0.58 * speedRatio);
          target.y += rightLift * 0.42 * speedRatio * (/Foot|Toe/.test(node.name) ? 1 : 0.55);
        }
        if (/Spine2|Neck|Head/.test(node.name)) target.addScaledVector(acceleration, -0.0035);
        applyMuscle(node, target, muscleScale);
      });

      physicsWorld.step(1 / 60, dt, 4);

      const hipsNode = ragdollNodes.get("mixamorig:Hips");
      if (hipsNode && rigScene) {
        const rotatedBindHips = bindHipsWorld.clone().applyQuaternion(yaw);
        rigContainer.rotation.y = yawAngle;
        rigContainer.position.set(
          hipsNode.body.position.x - rotatedBindHips.x,
          hipsNode.body.position.y - rotatedBindHips.y,
          hipsNode.body.position.z - rotatedBindHips.z,
        );
        rigContainer.updateMatrixWorld(true);

        for (const link of boneLinks) {
          const startNode = ragdollNodes.get(link.bone.name);
          const endNode = ragdollNodes.get(link.endNode);
          if (!startNode || !endNode || !link.bone.parent) continue;
          const physicalDirection = new THREE.Vector3(
            endNode.body.position.x - startNode.body.position.x,
            endNode.body.position.y - startNode.body.position.y,
            endNode.body.position.z - startNode.body.position.z,
          ).normalize();
          const referenceDirection = link.bindDirection.clone().applyQuaternion(yaw);
          const worldDelta = new THREE.Quaternion().setFromUnitVectors(referenceDirection, physicalDirection);
          const referenceWorld = yaw.clone().multiply(link.bindWorldQuaternion);
          const desiredWorld = worldDelta.multiply(referenceWorld);
          const parentWorld = link.bone.parent.getWorldQuaternion(new THREE.Quaternion());
          const desiredLocal = parentWorld.invert().multiply(desiredWorld);
          link.bone.position.copy(link.basePosition);
          link.bone.scale.copy(link.baseScale);
          link.bone.quaternion.copy(desiredLocal);
          link.bone.updateMatrixWorld(true);
        }
      }

      const cameraTarget = root.clone().add(new THREE.Vector3(0, 1.15, 0));
      const cameraPosition = cameraTarget.clone().add(new THREE.Vector3(0, 14.5, 9.8));
      camera.position.lerp(cameraPosition, 1 - Math.exp(-3.2 * dt));
      camera.lookAt(cameraTarget);

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

    return () => {
      disposed = true;
      cancelAnimationFrame(animation);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      renderer.domElement.removeEventListener("mousedown", onMouseDown);
      renderer.domElement.removeEventListener("contextmenu", onContextMenu);
      window.removeEventListener("mouseup", onMouseUp);
      window.removeEventListener("blur", onWindowBlur);
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, []);

  const bindTouch = (key: string) => ({
    onPointerDown: (event: React.PointerEvent<HTMLButtonElement>) => {
      event.currentTarget.setPointerCapture(event.pointerId);
      touchKeys.current[key] = true;
    },
    onPointerUp: () => { touchKeys.current[key] = false; },
    onPointerCancel: () => { touchKeys.current[key] = false; },
  });

  return (
    <main className="game-shell">
      <div ref={mountRef} className="game-stage" aria-label="Playable 3D wobble arena" />

      <section className="controls-panel" aria-label="Game controls">
        <div className="key-grid" aria-hidden="true">
          <span></span><kbd>W</kbd><span></span>
          <kbd>A</kbd><kbd>S</kbd><kbd>D</kbd>
        </div>
        <div className="control-copy">
          <p><strong>MOVE</strong> WASD / ARROWS</p>
          <p><strong>SPRINT</strong> HOLD SHIFT</p>
          <p><strong>L ARM</strong> HOLD LEFT CLICK</p>
          <p><strong>R ARM</strong> HOLD RIGHT CLICK</p>
          <p><strong>RESET</strong> PRESS R</p>
        </div>
      </section>

      <div className="touch-pad" aria-label="Touch movement controls">
        <button className="touch-up" aria-label="Move up" {...bindTouch("up")}>▲</button>
        <button className="touch-left" aria-label="Move left" {...bindTouch("left")}>◀</button>
        <button className="touch-down" aria-label="Move down" {...bindTouch("down")}>▼</button>
        <button className="touch-right" aria-label="Move right" {...bindTouch("right")}>▶</button>
      </div>

    </main>
  );
}
