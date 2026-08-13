"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import * as CANNON from "cannon-es";
import Peer, { type DataConnection } from "peerjs";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkeleton } from "three/examples/jsm/utils/SkeletonUtils.js";

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
type PosePacket = {
  type: "pose";
  playerId?: string;
  position: [number, number, number];
  yaw: number;
  bones: Array<[string, number, number, number, number]>;
};
type NetworkPacket = PosePacket | { type: "count"; count: number } | { type: "leave"; playerId: string } | { type: "full" };
type RemoteAvatar = {
  container: THREE.Group;
  bones: Map<string, THREE.Bone>;
};
type ComfortSettings = {
  fov: number;
  sensitivity: number;
  invertY: boolean;
  vignette: boolean;
  showBody: boolean;
};

const MAX_PLAYERS = 8;
const PEER_PREFIX = "furry-dockers-";
const ROOM_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const TOP_DOWN_FOV = 47;
const MAX_PITCH = 1.45;
const EYE_FORWARD = 0.16;
const EYE_RISE = 0.26;
const EYE_DRIFT = 0.05;
const DEFAULT_COMFORT: ComfortSettings = { fov: 78, sensitivity: 1, invertY: false, vignette: true, showBody: true };

function makeRoomCode() {
  const values = crypto.getRandomValues(new Uint8Array(4));
  return Array.from(values, (value) => ROOM_LETTERS[value % ROOM_LETTERS.length]).join("");
}

// Pointer lock only makes sense for a mouse; touch devices look by dragging instead.
function supportsPointerLook() {
  if (typeof window === "undefined" || typeof document === "undefined") return false;
  if (typeof document.body?.requestPointerLock !== "function") return false;
  return !window.matchMedia?.("(pointer: coarse)").matches;
}

function isPosePacket(value: unknown): value is PosePacket {
  if (!value || typeof value !== "object") return false;
  const packet = value as Partial<PosePacket>;
  return packet.type === "pose" && Array.isArray(packet.position) && typeof packet.yaw === "number" && Array.isArray(packet.bones);
}

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

export default function FurryDockersGame() {
  const mountRef = useRef<HTMLDivElement>(null);
  const vignetteRef = useRef<HTMLDivElement>(null);
  const toggleViewRef = useRef<() => void>(() => undefined);
  const requestLookRef = useRef<() => void>(() => undefined);
  const touchKeys = useRef<Record<string, boolean>>({});
  const localPoseRef = useRef<PosePacket | null>(null);
  const receivePoseRef = useRef<(playerId: string, pose: PosePacket) => void>(() => undefined);
  const removeRemoteRef = useRef<(playerId: string) => void>(() => undefined);
  const clearRemotesRef = useRef<() => void>(() => undefined);
  const peerRef = useRef<Peer | null>(null);
  const hostConnectionRef = useRef<DataConnection | null>(null);
  const guestConnectionsRef = useRef(new Map<string, DataConnection>());
  const networkTimerRef = useRef<number | null>(null);
  const roomFullRef = useRef(false);
  const roleRef = useRef<"solo" | "host" | "guest">("solo");
  const [roomCode, setRoomCode] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [networkStatus, setNetworkStatus] = useState("PLAYING SOLO");
  const [playerCount, setPlayerCount] = useState(1);
  const [firstPerson, setFirstPerson] = useState(false);
  const [pointerLocked, setPointerLocked] = useState(false);
  const [comfort, setComfort] = useState<ComfortSettings>(DEFAULT_COMFORT);
  const [pointerLook] = useState(supportsPointerLook);
  const comfortRef = useRef(comfort);

  useEffect(() => {
    comfortRef.current = comfort;
  }, [comfort]);

  const stopPoseTimer = () => {
    if (networkTimerRef.current !== null) window.clearInterval(networkTimerRef.current);
    networkTimerRef.current = null;
  };

  const broadcastCount = () => {
    const count = 1 + guestConnectionsRef.current.size;
    setPlayerCount(count);
    guestConnectionsRef.current.forEach((connection) => {
      if (connection.open) connection.send({ type: "count", count } satisfies NetworkPacket);
    });
  };

  const startPoseTimer = () => {
    stopPoseTimer();
    networkTimerRef.current = window.setInterval(() => {
      const pose = localPoseRef.current;
      if (!pose) return;
      if (roleRef.current === "host") {
        const packet: PosePacket = { ...pose, playerId: peerRef.current?.id };
        guestConnectionsRef.current.forEach((connection) => {
          if (connection.open) connection.send(packet);
        });
      } else if (roleRef.current === "guest" && hostConnectionRef.current?.open) {
        hostConnectionRef.current.send(pose);
      }
    }, 67);
  };

  const leaveRoom = () => {
    stopPoseTimer();
    hostConnectionRef.current?.close();
    hostConnectionRef.current = null;
    guestConnectionsRef.current.forEach((connection) => connection.close());
    guestConnectionsRef.current.clear();
    peerRef.current?.destroy();
    peerRef.current = null;
    roleRef.current = "solo";
    roomFullRef.current = false;
    clearRemotesRef.current();
    setRoomCode("");
    setPlayerCount(1);
    setNetworkStatus("PLAYING SOLO");
  };

  const createRoom = () => {
    leaveRoom();
    const code = makeRoomCode();
    const peer = new Peer(`${PEER_PREFIX}${code.toLowerCase()}`);
    peerRef.current = peer;
    roleRef.current = "host";
    setRoomCode(code);
    setNetworkStatus("OPENING ROOM…");
    peer.on("open", () => {
      setNetworkStatus("ROOM OPEN");
      startPoseTimer();
    });
    peer.on("connection", (connection) => {
      connection.on("open", () => {
        if (guestConnectionsRef.current.size >= MAX_PLAYERS - 1) {
          connection.send({ type: "full" } satisfies NetworkPacket);
          window.setTimeout(() => connection.close(), 150);
          return;
        }
        guestConnectionsRef.current.set(connection.peer, connection);
        broadcastCount();
      });
      connection.on("data", (value) => {
        if (!isPosePacket(value) || !guestConnectionsRef.current.has(connection.peer)) return;
        const packet: PosePacket = { ...value, playerId: connection.peer };
        receivePoseRef.current(connection.peer, packet);
        guestConnectionsRef.current.forEach((other, playerId) => {
          if (playerId !== connection.peer && other.open) other.send(packet);
        });
      });
      connection.on("close", () => {
        if (!guestConnectionsRef.current.delete(connection.peer)) return;
        removeRemoteRef.current(connection.peer);
        guestConnectionsRef.current.forEach((other) => {
          if (other.open) other.send({ type: "leave", playerId: connection.peer } satisfies NetworkPacket);
        });
        broadcastCount();
      });
    });
    peer.on("error", (error) => {
      setNetworkStatus(error.type === "unavailable-id" ? "CODE IN USE — CREATE AGAIN" : "ROOM CONNECTION ERROR");
      stopPoseTimer();
    });
  };

  const joinRoom = () => {
    const code = joinCode.trim().toUpperCase();
    if (!/^[A-Z]{4}$/.test(code)) {
      setNetworkStatus("ENTER A 4-LETTER CODE");
      return;
    }
    leaveRoom();
    setJoinCode(code);
    setRoomCode(code);
    setNetworkStatus("JOINING…");
    roomFullRef.current = false;
    const peer = new Peer();
    peerRef.current = peer;
    roleRef.current = "guest";
    peer.on("open", () => {
      const connection = peer.connect(`${PEER_PREFIX}${code.toLowerCase()}`, { reliable: false, serialization: "json" });
      hostConnectionRef.current = connection;
      connection.on("open", () => {
        setNetworkStatus("CONNECTED");
        startPoseTimer();
      });
      connection.on("data", (value) => {
        const packet = value as NetworkPacket;
        if (isPosePacket(packet) && packet.playerId && packet.playerId !== peer.id) receivePoseRef.current(packet.playerId, packet);
        else if (packet?.type === "count") setPlayerCount(packet.count);
        else if (packet?.type === "leave") removeRemoteRef.current(packet.playerId);
        else if (packet?.type === "full") {
          roomFullRef.current = true;
          setNetworkStatus("ROOM IS FULL");
          stopPoseTimer();
          connection.close();
        }
      });
      connection.on("close", () => {
        if (!roomFullRef.current) setNetworkStatus("HOST DISCONNECTED");
        stopPoseTimer();
      });
      connection.on("error", () => setNetworkStatus("COULD NOT JOIN ROOM"));
    });
    peer.on("error", () => {
      setNetworkStatus("ROOM NOT FOUND");
      stopPoseTimer();
    });
  };

  useEffect(() => () => leaveRoom(), []);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x151915);
    scene.fog = new THREE.Fog(0x151915, 26, 45);

    const camera = new THREE.PerspectiveCamera(TOP_DOWN_FOV, mount.clientWidth / mount.clientHeight, 0.1, 100);
    camera.position.set(0, 15, 10.5);
    camera.rotation.order = "YXZ";

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
    (physicsWorld.solver as CANNON.GSSolver).iterations = 18;
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
    const localBones = new Map<string, THREE.Bone>();
    const latestRemotePoses = new Map<string, PosePacket>();
    const remoteAvatars = new Map<string, RemoteAvatar>();
    const bindHipsWorld = new THREE.Vector3(0, 1.8, 0);
    let rigScene: THREE.Group | null = null;
    let remoteTemplate: THREE.Group | null = null;
    let disposed = false;

    const headBaseScale = new THREE.Vector3(1, 1, 1);
    const look = { yaw: Math.PI, pitch: 0 };
    let firstPersonMode = false;
    let pointerIsLocked = false;
    let eyeHeight = 2.9;
    let snapEyeHeight = true;
    let turnSpeed = 0;
    let previousLookYaw = look.yaw;
    let vignetteStrength = 0;
    let snapTopDownCamera = false;

    // Collapsing the head bone keeps the local skull (and anything parented to it)
    // out of the near plane instead of letting it clip across the whole view.
    const applyHeadOcclusion = () => {
      const head = localBones.get("mixamorig:Head");
      if (!head) return;
      if (firstPersonMode) head.scale.setScalar(0.0001);
      else head.scale.copy(headBaseScale);
      head.updateMatrixWorld(true);
    };

    const removeRemote = (playerId: string) => {
      latestRemotePoses.delete(playerId);
      const avatar = remoteAvatars.get(playerId);
      if (!avatar) return;
      avatar.container.traverse((object) => {
        if (!(object instanceof THREE.SkinnedMesh)) return;
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        materials.forEach((material) => material.dispose());
      });
      scene.remove(avatar.container);
      remoteAvatars.delete(playerId);
    };
    receivePoseRef.current = (playerId, pose) => latestRemotePoses.set(playerId, pose);
    removeRemoteRef.current = removeRemote;
    clearRemotesRef.current = () => Array.from(remoteAvatars.keys()).forEach(removeRemote);

    const createRemoteAvatar = (playerId: string, pose: PosePacket) => {
      if (!remoteTemplate) return null;
      const container = new THREE.Group();
      const clone = cloneSkeleton(remoteTemplate) as THREE.Group;
      let hash = 0;
      for (const character of playerId) hash = (hash * 31 + character.charCodeAt(0)) | 0;
      const playerColor = new THREE.Color().setHSL(Math.abs(hash % 360) / 360, 0.68, 0.56);
      const bones = new Map<string, THREE.Bone>();
      clone.traverse((object) => {
        if (object instanceof THREE.Bone) bones.set(object.name, object);
        if (!(object instanceof THREE.SkinnedMesh)) return;
        object.castShadow = true;
        object.receiveShadow = true;
        object.frustumCulled = false;
        const tintMaterial = (material: THREE.Material) => {
          const tinted = material.clone();
          if ("color" in tinted && tinted.color instanceof THREE.Color) tinted.color.lerp(playerColor, 0.62);
          return tinted;
        };
        object.material = Array.isArray(object.material) ? object.material.map(tintMaterial) : tintMaterial(object.material);
      });
      container.add(clone);
      container.position.fromArray(pose.position);
      container.rotation.y = pose.yaw;
      scene.add(container);
      const avatar = { container, bones };
      remoteAvatars.set(playerId, avatar);
      return avatar;
    };

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
        const bones = localBones;
        bones.clear();
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
        remoteTemplate = cloneSkeleton(rigScene) as THREE.Group;

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
        const headBone = bones.get("mixamorig:Head");
        if (headBone) headBaseScale.copy(headBone.scale);
        applyHeadOcclusion();
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

    const pointerLookAvailable = supportsPointerLook();

    const requestLook = () => {
      if (!firstPersonMode || !pointerLookAvailable || document.pointerLockElement === renderer.domElement) return;
      const canvas = renderer.domElement;
      const attempt = (options?: PointerLockOptions) => {
        try {
          const result = canvas.requestPointerLock(options) as unknown;
          return result instanceof Promise ? result : Promise.resolve();
        } catch (error) {
          return Promise.reject(error);
        }
      };
      // Raw (unaccelerated) movement tracks the hand 1:1, which reads as far steadier
      // than OS-accelerated deltas; browsers that reject the option get a plain lock.
      // If both fail the click overlay simply stays up, so nothing needs reporting.
      attempt({ unadjustedMovement: true }).catch(() => attempt().catch(() => undefined));
    };

    const setFirstPersonMode = (next: boolean) => {
      if (next === firstPersonMode) return;
      firstPersonMode = next;
      setFirstPerson(next);
      mouseButtons.clear();
      applyHeadOcclusion();
      const fog = scene.fog as THREE.Fog;
      if (next) {
        look.yaw = Math.atan2(facing.x, facing.z);
        look.pitch = 0;
        previousLookYaw = look.yaw;
        turnSpeed = 0;
        snapEyeHeight = true;
        camera.near = 0.06;
        // The top-down fog was tuned for a 15m-high camera; at eye level it would
        // swallow the far wall, so push it back to a purely atmospheric range.
        fog.near = 42;
        fog.far = 96;
        requestLook();
      } else {
        camera.near = 0.1;
        fog.near = 26;
        fog.far = 45;
        if (rigScene) rigScene.visible = true;
        if (document.pointerLockElement === renderer.domElement) document.exitPointerLock();
        // Cut straight to the top-down framing: a swooping interpolation between
        // two very different viewpoints is exactly the motion that makes people ill.
        snapTopDownCamera = true;
      }
      camera.updateProjectionMatrix();
    };
    toggleViewRef.current = () => setFirstPersonMode(!firstPersonMode);
    requestLookRef.current = requestLook;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement) return;
      if (["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "ShiftLeft"].includes(event.code)) {
        event.preventDefault();
        keys.add(event.code);
      }
      if (event.code === "KeyR") reset();
      if (event.code === "KeyV" && !event.repeat) setFirstPersonMode(!firstPersonMode);
    };
    const onKeyUp = (event: KeyboardEvent) => keys.delete(event.code);
    const onMouseDown = (event: MouseEvent) => {
      if (firstPersonMode && pointerLookAvailable && !pointerIsLocked) {
        // The click that captures the pointer must not also throw a punch.
        requestLook();
        return;
      }
      if (event.button === 0 || event.button === 2) mouseButtons.add(event.button);
    };
    const onMouseUp = (event: MouseEvent) => mouseButtons.delete(event.button);
    const onMouseMove = (event: MouseEvent) => {
      if (!firstPersonMode || !pointerIsLocked) return;
      const settings = comfortRef.current;
      const scale = 0.0022 * settings.sensitivity;
      // Browsers can emit one huge delta on the frame the pointer is captured.
      const deltaX = THREE.MathUtils.clamp(event.movementX, -260, 260);
      const deltaY = THREE.MathUtils.clamp(event.movementY, -260, 260);
      look.yaw -= deltaX * scale;
      look.pitch += (settings.invertY ? deltaY : -deltaY) * scale;
      look.pitch = THREE.MathUtils.clamp(look.pitch, -MAX_PITCH, MAX_PITCH);
    };
    const onPointerLockChange = () => {
      pointerIsLocked = document.pointerLockElement === renderer.domElement;
      setPointerLocked(pointerIsLocked);
      if (!pointerIsLocked) mouseButtons.clear();
    };
    const onWindowBlur = () => mouseButtons.clear();
    const onContextMenu = (event: MouseEvent) => event.preventDefault();

    let lookPointerId: number | null = null;
    const lastTouch = { x: 0, y: 0 };
    const onTouchLookStart = (event: PointerEvent) => {
      if (!firstPersonMode || event.pointerType === "mouse" || lookPointerId !== null) return;
      lookPointerId = event.pointerId;
      lastTouch.x = event.clientX;
      lastTouch.y = event.clientY;
    };
    const onTouchLookMove = (event: PointerEvent) => {
      if (event.pointerId !== lookPointerId) return;
      const settings = comfortRef.current;
      const scale = 0.0042 * settings.sensitivity;
      const deltaX = event.clientX - lastTouch.x;
      const deltaY = event.clientY - lastTouch.y;
      lastTouch.x = event.clientX;
      lastTouch.y = event.clientY;
      look.yaw -= deltaX * scale;
      look.pitch += (settings.invertY ? deltaY : -deltaY) * scale;
      look.pitch = THREE.MathUtils.clamp(look.pitch, -MAX_PITCH, MAX_PITCH);
    };
    const onTouchLookEnd = (event: PointerEvent) => {
      if (event.pointerId === lookPointerId) lookPointerId = null;
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    renderer.domElement.addEventListener("mousedown", onMouseDown);
    renderer.domElement.addEventListener("contextmenu", onContextMenu);
    renderer.domElement.addEventListener("pointerdown", onTouchLookStart);
    window.addEventListener("pointermove", onTouchLookMove);
    window.addEventListener("pointerup", onTouchLookEnd);
    window.addEventListener("pointercancel", onTouchLookEnd);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    window.addEventListener("blur", onWindowBlur);
    document.addEventListener("pointerlockchange", onPointerLockChange);

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
      const settings = comfortRef.current;
      const firstPersonView = firstPersonMode;
      const lookForward = new THREE.Vector3(Math.sin(look.yaw), 0, Math.cos(look.yaw));
      const lookRight = new THREE.Vector3(-lookForward.z, 0, lookForward.x);
      // First person walks relative to the view; top-down keeps its world-axis feel.
      const moveDirection = firstPersonView
        ? lookRight.clone().multiplyScalar(input.x).addScaledVector(lookForward, -input.z)
        : input;
      if (isMoving) velocity.addScaledVector(moveDirection, 24 * sprint * dt);
      if (firstPersonView) {
        // The body chases the view instead of snapping to it, so a fast flick never
        // whips the ragdoll — and the camera itself is never dragged along by the body.
        const currentYaw = Math.atan2(facing.x, facing.z);
        const yawGap = Math.atan2(Math.sin(look.yaw - currentYaw), Math.cos(look.yaw - currentYaw));
        const blendedYaw = currentYaw + yawGap * (1 - Math.exp(-16 * dt));
        facing.set(Math.sin(blendedYaw), 0, Math.cos(blendedYaw));
      } else if (isMoving) {
        facing.lerp(moveDirection.clone().normalize(), 1 - Math.exp(-8 * dt)).normalize();
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
      // In first person the arms punch along the aim ray, pitch included, so the
      // hands land where the crosshair is instead of always swinging out flat.
      const reachDirection = firstPersonView
        ? new THREE.Vector3(
            Math.sin(look.yaw) * Math.cos(look.pitch),
            Math.sin(look.pitch),
            Math.cos(look.yaw) * Math.cos(look.pitch),
          )
        : facing;

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
              target.copy(armTarget).addScaledVector(reachDirection, reachLength * 0.92);
              target.y -= firstPersonView ? 0.06 : 0.12 + reachLength * 0.08;
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

        localPoseRef.current = {
          type: "pose",
          position: rigContainer.position.toArray() as [number, number, number],
          yaw: rigContainer.rotation.y,
          bones: Array.from(localBones, ([name, bone]) => [name, bone.quaternion.x, bone.quaternion.y, bone.quaternion.z, bone.quaternion.w]),
        };
      }

      const remoteBlend = 1 - Math.exp(-12 * dt);
      latestRemotePoses.forEach((pose, playerId) => {
        const avatar = remoteAvatars.get(playerId) ?? createRemoteAvatar(playerId, pose);
        if (!avatar) return;
        avatar.container.position.lerp(new THREE.Vector3().fromArray(pose.position), remoteBlend);
        const yawDifference = Math.atan2(Math.sin(pose.yaw - avatar.container.rotation.y), Math.cos(pose.yaw - avatar.container.rotation.y));
        avatar.container.rotation.y += yawDifference * remoteBlend;
        pose.bones.forEach(([name, x, y, z, w]) => {
          avatar.bones.get(name)?.quaternion.slerp(new THREE.Quaternion(x, y, z, w), remoteBlend);
        });
      });

      const desiredFov = firstPersonView ? settings.fov : TOP_DOWN_FOV;
      if (Math.abs(camera.fov - desiredFov) > 0.001) {
        camera.fov = desiredFov;
        camera.updateProjectionMatrix();
      }

      if (firstPersonView) {
        if (rigScene) rigScene.visible = settings.showBody;
        // The eye height is pinned to where the ragdoll's head actually settles, but it
        // may only creep there at EYE_DRIFT units/second — fast enough to survive a
        // posture change, far too slow to read as bob.
        const headBodyY = ragdollNodes.get("mixamorig:Head")?.body.position.y;
        if (headBodyY !== undefined) {
          const eyeTarget = headBodyY + EYE_RISE;
          if (snapEyeHeight) eyeHeight = eyeTarget;
          else eyeHeight += THREE.MathUtils.clamp(eyeTarget - eyeHeight, -EYE_DRIFT * dt, EYE_DRIFT * dt);
        }
        snapEyeHeight = false;
        // The eye rides the smooth kinematic root: no walk bob, no landing dip, no
        // roll, and none of the ragdoll's jitter reaches the view.
        camera.position.set(root.x, eyeHeight, root.z).addScaledVector(lookForward, EYE_FORWARD);
        camera.rotation.set(look.pitch, look.yaw + Math.PI, 0, "YXZ");
      } else {
        const cameraTarget = root.clone().add(new THREE.Vector3(0, 1.15, 0));
        const cameraPosition = cameraTarget.clone().add(new THREE.Vector3(0, 14.5, 9.8));
        if (snapTopDownCamera) {
          camera.position.copy(cameraPosition);
          snapTopDownCamera = false;
        } else {
          camera.position.lerp(cameraPosition, 1 - Math.exp(-3.2 * dt));
        }
        camera.lookAt(cameraTarget);
      }

      const yawDelta = Math.atan2(Math.sin(look.yaw - previousLookYaw), Math.cos(look.yaw - previousLookYaw));
      previousLookYaw = look.yaw;
      turnSpeed += (Math.abs(yawDelta) / Math.max(dt, 0.001) - turnSpeed) * (1 - Math.exp(-9 * dt));
      const vignetteElement = vignetteRef.current;
      if (vignetteElement) {
        // Dynamic tunnelling: narrowing peripheral vision while moving or turning is
        // the single most effective comfort trick for players prone to sim sickness.
        const wanted = firstPersonView && settings.vignette
          ? THREE.MathUtils.clamp(speedRatio * 0.6 + THREE.MathUtils.clamp(turnSpeed / 3.4, 0, 1) * 0.5, 0, 1)
          : 0;
        vignetteStrength += (wanted - vignetteStrength) * (1 - Math.exp(-6 * dt));
        vignetteElement.style.opacity = vignetteStrength.toFixed(3);
        vignetteElement.style.setProperty("--tunnel", `${(80 - vignetteStrength * 32).toFixed(1)}%`);
      }

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
      renderer.domElement.removeEventListener("pointerdown", onTouchLookStart);
      window.removeEventListener("pointermove", onTouchLookMove);
      window.removeEventListener("pointerup", onTouchLookEnd);
      window.removeEventListener("pointercancel", onTouchLookEnd);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      window.removeEventListener("blur", onWindowBlur);
      document.removeEventListener("pointerlockchange", onPointerLockChange);
      if (document.pointerLockElement === renderer.domElement) document.exitPointerLock();
      toggleViewRef.current = () => undefined;
      requestLookRef.current = () => undefined;
      localPoseRef.current = null;
      receivePoseRef.current = () => undefined;
      removeRemoteRef.current = () => undefined;
      clearRemotesRef.current = () => undefined;
      Array.from(remoteAvatars.keys()).forEach(removeRemote);
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

  const updateComfort = (patch: Partial<ComfortSettings>) => setComfort((current) => ({ ...current, ...patch }));

  return (
    <main className="game-shell">
      <div ref={mountRef} className="game-stage" aria-label="Playable 3D Furry Dockers arena" />

      <div ref={vignetteRef} className="comfort-vignette" aria-hidden="true" />

      {firstPerson && <div className="crosshair" aria-hidden="true" />}

      {firstPerson && pointerLook && !pointerLocked && (
        <button className="look-prompt" onClick={() => requestLookRef.current()}>
          CLICK TO LOOK
          <span>MOUSE AIMS · ESC RELEASES</span>
        </button>
      )}

      <section className="view-panel" aria-label="Camera view settings">
        <button
          className="view-toggle"
          aria-pressed={firstPerson}
          onClick={(event) => { event.currentTarget.blur(); toggleViewRef.current(); }}
        >
          VIEW · {firstPerson ? "FIRST PERSON" : "TOP-DOWN"} <kbd>V</kbd>
        </button>

        {firstPerson && (
          <div className="comfort-copy">
            <p className="look-hint">{pointerLook ? "CLICK STAGE TO LOOK · ESC FREES CURSOR" : "DRAG THE STAGE TO LOOK"}</p>
            <label>
              <span>FOV</span>
              <input
                type="range" min={65} max={100} step={1} value={comfort.fov}
                onChange={(event) => updateComfort({ fov: Number(event.target.value) })}
              />
              <b>{comfort.fov}</b>
            </label>
            <label>
              <span>SENS</span>
              <input
                type="range" min={0.3} max={2.5} step={0.05} value={comfort.sensitivity}
                onChange={(event) => updateComfort({ sensitivity: Number(event.target.value) })}
              />
              <b>{comfort.sensitivity.toFixed(2)}</b>
            </label>
            <div className="comfort-toggles">
              <button aria-pressed={comfort.vignette} onClick={(event) => { event.currentTarget.blur(); updateComfort({ vignette: !comfort.vignette }); }}>
                TUNNEL {comfort.vignette ? "ON" : "OFF"}
              </button>
              <button aria-pressed={comfort.invertY} onClick={(event) => { event.currentTarget.blur(); updateComfort({ invertY: !comfort.invertY }); }}>
                INVERT Y {comfort.invertY ? "ON" : "OFF"}
              </button>
              <button aria-pressed={comfort.showBody} onClick={(event) => { event.currentTarget.blur(); updateComfort({ showBody: !comfort.showBody }); }}>
                BODY {comfort.showBody ? "ON" : "OFF"}
              </button>
            </div>
          </div>
        )}
      </section>

      <section className="controls-panel" aria-label="Game controls">
        <div className="key-grid" aria-hidden="true">
          <span></span><kbd>W</kbd><span></span>
          <kbd>A</kbd><kbd>S</kbd><kbd>D</kbd>
        </div>
        <div className="control-copy">
          <p><strong>MOVE</strong> {firstPerson ? "WASD (VIEW-RELATIVE)" : "WASD / ARROWS"}</p>
          {firstPerson && <p><strong>LOOK</strong> MOUSE</p>}
          <p><strong>SPRINT</strong> HOLD SHIFT</p>
          <p><strong>L ARM</strong> HOLD LEFT CLICK</p>
          <p><strong>R ARM</strong> HOLD RIGHT CLICK</p>
          <p><strong>VIEW</strong> PRESS V</p>
          <p><strong>RESET</strong> PRESS R</p>
        </div>
      </section>

      <section className="multiplayer-panel" aria-label="Multiplayer room controls">
        {roomCode ? (
          <>
            <div className="room-line">
              <span>ROOM</span>
              <button className="room-code" onClick={() => navigator.clipboard?.writeText(roomCode)} title="Copy room code">{roomCode}</button>
              <strong>{playerCount}/{MAX_PLAYERS}</strong>
            </div>
            <p>{networkStatus}</p>
            <button className="leave-button" onClick={leaveRoom}>LEAVE</button>
          </>
        ) : (
          <>
            <div className="join-line">
              <button className="create-button" onClick={createRoom}>CREATE ROOM</button>
              <input
                aria-label="Four-letter room code"
                value={joinCode}
                maxLength={4}
                placeholder="CODE"
                onChange={(event) => setJoinCode(event.target.value.replace(/[^a-z]/gi, "").toUpperCase())}
                onKeyDown={(event) => { if (event.key === "Enter") joinRoom(); }}
              />
              <button className="join-button" onClick={joinRoom}>JOIN</button>
            </div>
            <p>{networkStatus}</p>
          </>
        )}
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
