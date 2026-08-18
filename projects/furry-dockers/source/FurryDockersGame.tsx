"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import * as CANNON from "cannon-es";
import Peer, { type DataConnection } from "peerjs";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkeleton } from "three/examples/jsm/utils/SkeletonUtils.js";
import CharacterCustomizer from "./CharacterCustomizer";
import { type Attachment, attachToSkeleton, disposePart } from "./characterParts";

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
  smoothIntent: THREE.Vector3 | null;
};
// Only these bones are ever rotated by the ragdoll, so only these are worth sending.
// Both ends share the order, which is what lets a packet drop the bone names entirely.
const SYNC_BONES = [
  "mixamorig:Hips", "mixamorig:Spine", "mixamorig:Spine1", "mixamorig:Spine2", "mixamorig:Neck",
  "mixamorig:LeftShoulder", "mixamorig:LeftArm", "mixamorig:LeftForeArm",
  "mixamorig:RightShoulder", "mixamorig:RightArm", "mixamorig:RightForeArm",
  "mixamorig:LeftUpLeg", "mixamorig:LeftLeg", "mixamorig:LeftFoot",
  "mixamorig:RightUpLeg", "mixamorig:RightLeg", "mixamorig:RightFoot",
] as const;
// type, slot, position (3 x float32), yaw (int16), quaternions (4 x int16 each)
const POSE_BYTES = 2 + 12 + 2 + SYNC_BONES.length * 8;
const POSE_MESSAGE = 1;
const POSE_SEND_HZ = 15;
// Remote avatars are drawn this far in the past, so there is always a later snapshot to
// interpolate towards. Valve's entity interpolation: it trades a little lag for motion
// that never jumps, and it is what stops low packet rates reading as teleporting.
const INTERP_DELAY_MS = 130;
const SNAPSHOT_LIMIT = 12;

type Snapshot = { time: number; x: number; y: number; z: number; yaw: number; quaternions: Float32Array };
type RemoteAvatar = {
  container: THREE.Group;
  bones: Array<THREE.Bone | undefined>;
  boneByName: Map<string, THREE.Bone>;
  parts: THREE.Group[];
  snapshots: Snapshot[];
};

function encodePose(
  view: DataView,
  slot: number,
  position: THREE.Vector3,
  yaw: number,
  bones: Array<THREE.Bone | undefined>,
) {
  view.setUint8(0, POSE_MESSAGE);
  view.setUint8(1, slot);
  view.setFloat32(2, position.x);
  view.setFloat32(6, position.y);
  view.setFloat32(10, position.z);
  view.setInt16(14, Math.max(-32767, Math.min(32767, Math.round((yaw / Math.PI) * 32767))));
  for (let index = 0; index < bones.length; index += 1) {
    const bone = bones[index];
    const offset = 16 + index * 8;
    const q = bone ? bone.quaternion : null;
    // Unit quaternion components live in [-1,1], so 16 bits each is far finer than
    // anything visible on a limb and a quarter the size of a float32.
    view.setInt16(offset, q ? Math.round(q.x * 32767) : 0);
    view.setInt16(offset + 2, q ? Math.round(q.y * 32767) : 0);
    view.setInt16(offset + 4, q ? Math.round(q.z * 32767) : 0);
    view.setInt16(offset + 6, q ? Math.round(q.w * 32767) : 32767);
  }
}

function decodePose(view: DataView, time: number): { slot: number; snapshot: Snapshot } {
  const quaternions = new Float32Array(SYNC_BONES.length * 4);
  for (let index = 0; index < SYNC_BONES.length; index += 1) {
    const offset = 16 + index * 8;
    quaternions[index * 4] = view.getInt16(offset) / 32767;
    quaternions[index * 4 + 1] = view.getInt16(offset + 2) / 32767;
    quaternions[index * 4 + 2] = view.getInt16(offset + 4) / 32767;
    quaternions[index * 4 + 3] = view.getInt16(offset + 6) / 32767;
  }
  return {
    slot: view.getUint8(1),
    snapshot: {
      time,
      x: view.getFloat32(2),
      y: view.getFloat32(6),
      z: view.getFloat32(10),
      yaw: (view.getInt16(14) / 32767) * Math.PI,
      quaternions,
    },
  };
}

function toDataView(data: unknown): DataView | null {
  if (data instanceof ArrayBuffer) return data.byteLength >= POSE_BYTES ? new DataView(data) : null;
  if (ArrayBuffer.isView(data)) {
    const view = data as ArrayBufferView;
    return view.byteLength >= POSE_BYTES ? new DataView(view.buffer, view.byteOffset, view.byteLength) : null;
  }
  return null;
}
type BodyView = "full" | "fade" | "arms" | "hidden";
type ComfortSettings = {
  fov: number;
  sensitivity: number;
  invertY: boolean;
  vignette: boolean;
  body: BodyView;
  steady: number;
};

const MAX_PLAYERS = 8;
const PEER_PREFIX = "furry-dockers-";
const ROOM_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const WORLD_GRAVITY = 18;
const TOP_DOWN_FOV = 47;
const MAX_PITCH = 1.45;
const EYE_FORWARD = 0.16;
const EYE_RISE = 0.26;
const EYE_DRIFT = 0.05;
// Where a raised hand should sit on screen, in normalized device coordinates
// (0,0 is the crosshair, ±1 is the screen edge). Mirrored for the left hand.
const HAND_SCREEN_X = 0.46;
const HAND_SCREEN_Y = -0.4;
const DEFAULT_COMFORT: ComfortSettings = { fov: 78, sensitivity: 1, invertY: false, vignette: true, body: "full", steady: 0 };
// Bones that make up the first-person "viewmodel": everything else can be masked
// away without taking the arms with it.
const ARM_BONES = /Shoulder|Arm|Hand|Thumb|Index|Middle|Ring|Pinky/;
const SHOULDER_BONES = /Shoulder/;
// Distances from the eye, in world units, over which a feathered body dissolves.
// Measured on this rig: neck 0.48, shoulder 0.59, chest 0.87, spine 1.24, hips 1.86,
// legs 2.1-2.9. The band is deliberately tight — reaching as far as the hips dissolves
// everything you can actually see of yourself, which just reinvents ARMS ONLY.
const BODY_FADE_NEAR = 0.3;
const BODY_FADE_FAR = 1.1;
// The eye sits inside the collar, so without this the near plane slices the mesh and
// leaves a hard cut edge across the view. Every first-person mode dissolves whatever
// comes this close, so geometry is gone before it can reach the near plane at 0.06.
// This is the camera-proximity fade true-first-person games run all the time.
const NEAR_GUARD_NEAR = 0.09;
const NEAR_GUARD_FAR = 0.42;
// The muscle targets are a spring's input, not a display pose: `acceleration` is a raw
// per-frame finite difference and the walk curves have corners in them. The ragdoll used
// to smooth all of that on the way to the screen, so blending it out has to put an
// equivalent filter back or the pose turns jerky when direction changes fast.
const INTENT_SMOOTHING = 17;
const HIP_INTENT_SMOOTHING = 13;

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

function applyMuscle(node: RagdollNode, target: THREE.Vector3, strengthScale = 1, gravityAssist = 0) {
  const body = node.body;
  const force = new CANNON.Vec3(
    ((target.x - body.position.x) * node.muscle - body.velocity.x * node.damping) * strengthScale,
    ((target.y - body.position.y) * node.muscle - body.velocity.y * node.damping) * strengthScale,
    ((target.z - body.position.z) * node.muscle - body.velocity.z * node.damping) * strengthScale,
  );
  // Feeding weight forward cancels the steady-state droop without stiffening the
  // spring, so a held pose sits on its mark and still wobbles when knocked.
  force.y += body.mass * WORLD_GRAVITY * gravityAssist;
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
  const receivePoseRef = useRef<(slot: number, snapshot: Snapshot) => void>(() => undefined);
  const removeRemoteRef = useRef<(slot: number) => void>(() => undefined);
  const keepRemotesRef = useRef<(slots: Set<number>) => void>(() => undefined);
  const clearRemotesRef = useRef<() => void>(() => undefined);
  const peerRef = useRef<Peer | null>(null);
  const hostConnectionRef = useRef<DataConnection | null>(null);
  const guestConnectionsRef = useRef(new Map<string, DataConnection>());
  const guestSlotsRef = useRef(new Map<string, number>());
  const localSlotRef = useRef(0);
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
  const [phase, setPhase] = useState<"customise" | "play">("customise");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const attachmentsRef = useRef<Attachment[]>([]);
  const remoteLooksRef = useRef(new Map<number, Attachment[]>());
  const sendLookRef = useRef<() => void>(() => undefined);
  const applyLookRef = useRef<(slot: number, list: Attachment[]) => void>(() => undefined);
  const comfortRef = useRef(comfort);

  useEffect(() => {
    comfortRef.current = comfort;
  }, [comfort]);

  const stopPoseTimer = () => {
    if (networkTimerRef.current !== null) window.clearInterval(networkTimerRef.current);
    networkTimerRef.current = null;
  };

  // The roster doubles as the player count and as each guest's slot assignment. It is
  // resent on a timer because the pose channel is unreliable by design, so a dropped
  // roster has to heal itself rather than stranding a guest without a slot.
  const broadcastRoster = () => {
    const players: Record<string, number> = {};
    guestConnectionsRef.current.forEach((_, peerId) => {
      const slot = guestSlotsRef.current.get(peerId);
      if (slot !== undefined) players[peerId] = slot;
    });
    setPlayerCount(1 + guestConnectionsRef.current.size);
    const message = JSON.stringify({ type: "roster", players });
    guestConnectionsRef.current.forEach((connection) => {
      if (connection.open) connection.send(message);
    });
    sendLook();
  };

  const startPoseTimer = () => {
    stopPoseTimer();
    if (roleRef.current === "host") networkTimerRef.current = window.setInterval(broadcastRoster, 1000);
  };

  // Appearance is low frequency and small, so it rides the same channel as JSON text
  // rather than the binary pose stream. It is resent with every roster tick because the
  // channel is unreliable, which also covers a guest that joined after someone else.
  const sendLook = () => {
    const message = JSON.stringify({ type: "look", slot: localSlotRef.current, attachments: attachmentsRef.current });
    if (roleRef.current === "host") {
      guestConnectionsRef.current.forEach((connection) => {
        if (connection.open) connection.send(message);
      });
    } else if (hostConnectionRef.current?.open) {
      hostConnectionRef.current.send(message);
    }
  };
  sendLookRef.current = sendLook;

  const claimSlot = () => {
    const taken = new Set(guestSlotsRef.current.values());
    for (let slot = 1; slot < MAX_PLAYERS; slot += 1) if (!taken.has(slot)) return slot;
    return -1;
  };

  const leaveRoom = () => {
    stopPoseTimer();
    hostConnectionRef.current?.close();
    hostConnectionRef.current = null;
    guestConnectionsRef.current.forEach((connection) => connection.close());
    guestConnectionsRef.current.clear();
    guestSlotsRef.current.clear();
    localSlotRef.current = 0;
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
        const slot = claimSlot();
        if (slot < 0) {
          connection.send(JSON.stringify({ type: "full" }));
          window.setTimeout(() => connection.close(), 300);
          return;
        }
        guestConnectionsRef.current.set(connection.peer, connection);
        guestSlotsRef.current.set(connection.peer, slot);
        broadcastRoster();
      });
      connection.on("data", (value) => {
        const slot = guestSlotsRef.current.get(connection.peer);
        if (typeof value === "string" && slot !== undefined) {
          try {
            const packet = JSON.parse(value);
            if (packet?.type !== "look") return;
            const stamped = JSON.stringify({ type: "look", slot, attachments: packet.attachments ?? [] });
            applyLookRef.current(slot, packet.attachments ?? []);
            guestConnectionsRef.current.forEach((other, peerId) => {
              if (peerId !== connection.peer && other.open) other.send(stamped);
            });
          } catch {
            /* a malformed control message is simply ignored */
          }
          return;
        }
        const view = toDataView(value);
        if (!view || slot === undefined || view.getUint8(0) !== POSE_MESSAGE) return;
        // Stamp the sender's slot so the relay cannot be spoofed by a guest, then pass
        // the same buffer straight on: no re-encoding, no re-serialising.
        view.setUint8(1, slot);
        receivePoseRef.current(slot, decodePose(view, performance.now()).snapshot);
        guestConnectionsRef.current.forEach((other, peerId) => {
          if (peerId !== connection.peer && other.open) other.send(view.buffer);
        });
      });
      connection.on("close", () => {
        if (!guestConnectionsRef.current.delete(connection.peer)) return;
        const slot = guestSlotsRef.current.get(connection.peer);
        guestSlotsRef.current.delete(connection.peer);
        if (slot !== undefined) removeRemoteRef.current(slot);
        broadcastRoster();
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
      // Unreliable and unordered: a stale pose is worthless, so retransmitting one only
      // delays the next. "raw" is PeerJS's pass-through serializer — it hands the
      // ArrayBuffer to the data channel untouched. Note the option key is "raw" even
      // though the enum member is SerializationType.None; "none" is not registered, and
      // passing it throws inside connect() before a connection object ever exists.
      let connection: DataConnection;
      try {
        connection = peer.connect(`${PEER_PREFIX}${code.toLowerCase()}`, { reliable: false, serialization: "raw" });
      } catch {
        setNetworkStatus("COULD NOT START CONNECTION");
        return;
      }
      hostConnectionRef.current = connection;
      // Without this a failed handshake leaves the panel reading JOINING for ever.
      const joinTimeout = window.setTimeout(() => {
        if (!connection.open) {
          setNetworkStatus("NO ANSWER — CHECK THE CODE");
          connection.close();
        }
      }, 12000);
      connection.on("open", () => {
        window.clearTimeout(joinTimeout);
        setNetworkStatus("CONNECTED");
        startPoseTimer();
        sendLookRef.current();
      });
      connection.on("data", (value) => {
        const view = toDataView(value);
        if (view && view.getUint8(0) === POSE_MESSAGE) {
          const { slot, snapshot } = decodePose(view, performance.now());
          if (slot !== localSlotRef.current) receivePoseRef.current(slot, snapshot);
          return;
        }
        if (typeof value !== "string") return;
        let packet: { type?: string; players?: Record<string, number>; slot?: number; attachments?: Attachment[] };
        try {
          packet = JSON.parse(value);
        } catch {
          return;
        }
        if (packet.type === "roster" && packet.players) {
          const players = packet.players;
          const mine = players[peer.id];
          if (mine !== undefined) localSlotRef.current = mine;
          setPlayerCount(1 + Object.keys(players).length);
          // Slot 0 is the host, who is always present.
          const live = new Set<number>([0, ...Object.values(players)]);
          live.delete(localSlotRef.current);
          keepRemotesRef.current(live);
        } else if (packet.type === "look" && typeof packet.slot === "number") {
          applyLookRef.current(packet.slot, packet.attachments ?? []);
        } else if (packet.type === "full") {
          roomFullRef.current = true;
          setNetworkStatus("ROOM IS FULL");
          stopPoseTimer();
          connection.close();
        }
      });
      connection.on("close", () => {
        window.clearTimeout(joinTimeout);
        if (!roomFullRef.current) setNetworkStatus(connection.open ? "HOST DISCONNECTED" : "COULD NOT REACH THE HOST");
        stopPoseTimer();
      });
      connection.on("error", () => {
        window.clearTimeout(joinTimeout);
        setNetworkStatus("COULD NOT JOIN ROOM");
      });
    });
    peer.on("error", () => {
      setNetworkStatus("ROOM NOT FOUND");
      stopPoseTimer();
    });
  };

  useEffect(() => () => leaveRoom(), []);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount || phase !== "play") return;

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

    const physicsWorld = new CANNON.World({ gravity: new CANNON.Vec3(0, -WORLD_GRAVITY, 0) });
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
    const nodeTargets = new Map<string, THREE.Vector3>();
    const boneLinks: BoneLink[] = [];
    const localBones = new Map<string, THREE.Bone>();
    const remoteAvatars = new Map<number, RemoteAvatar>();
    const syncBones: Array<THREE.Bone | undefined> = [];
    const poseBuffer = new ArrayBuffer(POSE_BYTES);
    const poseView = new DataView(poseBuffer);
    const scratchQuaternion = new Float32Array(4);
    let poseClock = 0;
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
    let smoothHipIntent: THREE.Vector3 | null = null;

    // A per-bone visibility mask, the usual way to carve a first-person viewmodel out
    // of a character that shares one skinned mesh: the skinning shader sums the mask
    // over each vertex's bone influences and the fragment stage discards whatever is
    // mostly hidden. Bone scaling cannot do this job, because the arms hang off the
    // spine and would collapse with it. The shadow pass is deliberately left unpatched,
    // so a hidden body still casts its full silhouette on the ground.
    // Two mask channels per bone. "Hard" hides outright; "feather" hides only where the
    // body comes near the eye, dissolving away over BODY_FADE_NEAR..FAR. A vertex sitting
    // on a seam picks up a mix of both through its skin weights, which is what softens the
    // edge instead of cutting it. The dissolve itself is a dithered discard driven by
    // interleaved gradient noise — the standard way to fade a character without paying for
    // transparency sorting, and what third-person games use to fade a body near the camera.
    let boneHardValues: Float32Array<ArrayBuffer> | null = null;
    let boneFeatherValues: Float32Array<ArrayBuffer> | null = null;
    let armBoneFlags: boolean[] = [];
    let shoulderBoneFlags: boolean[] = [];
    const boneHardUniform = { value: new Float32Array(1) };
    const boneFeatherUniform = { value: new Float32Array(1) };
    const bodyFadeUniform = { value: new THREE.Vector2(BODY_FADE_NEAR, BODY_FADE_FAR) };
    // Negative bounds park the guard off: smoothstep then returns 1 for any real
    // distance, so nothing is dissolved while the top-down camera is active.
    const nearGuardUniform = { value: new THREE.Vector2(-2, -1) };

    const installBoneMask = (meshes: THREE.SkinnedMesh[]) => {
      const skeletonBones = meshes[0]?.skeleton.bones ?? [];
      if (!skeletonBones.length) return;
      boneHardValues = new Float32Array(skeletonBones.length);
      boneFeatherValues = new Float32Array(skeletonBones.length);
      boneHardUniform.value = boneHardValues;
      boneFeatherUniform.value = boneFeatherValues;
      armBoneFlags = skeletonBones.map((bone) => ARM_BONES.test(bone.name) && !SHOULDER_BONES.test(bone.name));
      shoulderBoneFlags = skeletonBones.map((bone) => SHOULDER_BONES.test(bone.name));
      const size = skeletonBones.length;
      const patch = (material: THREE.Material) => {
        material.onBeforeCompile = (shader) => {
          shader.uniforms.boneHard = boneHardUniform;
          shader.uniforms.boneFeather = boneFeatherUniform;
          shader.uniforms.bodyFade = bodyFadeUniform;
          shader.uniforms.nearGuard = nearGuardUniform;
          shader.vertexShader = `uniform float boneHard[${size}];
uniform float boneFeather[${size}];
varying float vHardHide;
varying float vFeatherHide;
varying float vEyeDistance;
${shader.vertexShader}`
            .replace(
              "#include <skinning_vertex>",
              `#include <skinning_vertex>
               vHardHide = boneHard[int(skinIndex.x)] * skinWeight.x + boneHard[int(skinIndex.y)] * skinWeight.y
                         + boneHard[int(skinIndex.z)] * skinWeight.z + boneHard[int(skinIndex.w)] * skinWeight.w;
               vFeatherHide = boneFeather[int(skinIndex.x)] * skinWeight.x + boneFeather[int(skinIndex.y)] * skinWeight.y
                            + boneFeather[int(skinIndex.z)] * skinWeight.z + boneFeather[int(skinIndex.w)] * skinWeight.w;`,
            )
            .replace(
              "#include <project_vertex>",
              `#include <project_vertex>
               vEyeDistance = length(mvPosition.xyz);`,
            );
          shader.fragmentShader = `uniform vec2 bodyFade;
uniform vec2 nearGuard;
varying float vHardHide;
varying float vFeatherHide;
varying float vEyeDistance;
${shader.fragmentShader}`.replace(
            "#include <clipping_planes_fragment>",
            `#include <clipping_planes_fragment>
             float nearness = 1.0 - smoothstep(bodyFade.x, bodyFade.y, vEyeDistance);
             // Applies to every bone, so nothing can survive close enough to be
             // sliced by the near plane, whichever body mode is selected.
             float guard = 1.0 - smoothstep(nearGuard.x, nearGuard.y, vEyeDistance);
             float hide = clamp(vHardHide + vFeatherHide * nearness + guard, 0.0, 1.0);
             if (hide > 0.001) {
               float ign = fract(52.9829189 * fract(0.06711056 * gl_FragCoord.x + 0.00583715 * gl_FragCoord.y));
               if (ign < hide) discard;
             }`,
          );
        };
        material.customProgramCacheKey = () => "furry-dockers-bone-mask";
        material.needsUpdate = true;
      };
      meshes.forEach((mesh) => {
        if (Array.isArray(mesh.material)) mesh.material.forEach(patch);
        else patch(mesh.material);
      });
    };

    const applyBodyMask = (mode: BodyView) => {
      if (!boneHardValues || !boneFeatherValues) return;
      const active = firstPersonMode ? mode : "full";
      if (firstPersonMode) nearGuardUniform.value.set(NEAR_GUARD_NEAR, NEAR_GUARD_FAR);
      else nearGuardUniform.value.set(-2, -1);
      for (let index = 0; index < boneHardValues.length; index += 1) {
        const isArm = armBoneFlags[index];
        const isShoulder = shoulderBoneFlags[index];
        let hard = 0;
        let feather = 0;
        if (active === "hidden") hard = 1;
        else if (active === "fade") feather = isArm ? 0 : 1;
        else if (active === "arms") {
          // Arms stay solid; the shoulders they grow out of dissolve near the eye, so the
          // viewmodel feathers away instead of ending on a cut edge.
          if (isShoulder) feather = 1;
          else if (!isArm) hard = 1;
        }
        boneHardValues[index] = hard;
        boneFeatherValues[index] = feather;
      }
    };

    // Collapsing the head bone keeps the local skull (and anything parented to it)
    // out of the near plane instead of letting it clip across the whole view.
    const applyHeadOcclusion = () => {
      const head = localBones.get("mixamorig:Head");
      if (!head) return;
      if (firstPersonMode) head.scale.setScalar(0.0001);
      else head.scale.copy(headBaseScale);
      head.updateMatrixWorld(true);
    };

    const removeRemote = (slot: number) => {
      const avatar = remoteAvatars.get(slot);
      if (!avatar) return;
      avatar.container.traverse((object) => {
        if (!(object instanceof THREE.SkinnedMesh)) return;
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        materials.forEach((material) => material.dispose());
      });
      avatar.parts.forEach(disposePart);
      scene.remove(avatar.container);
      remoteAvatars.delete(slot);
    };
    receivePoseRef.current = (slot, snapshot) => {
      const avatar = remoteAvatars.get(slot) ?? createRemoteAvatar(slot, snapshot);
      if (!avatar) return;
      // Unreliable delivery means packets can arrive out of order; a snapshot older than
      // the newest one held is simply dropped rather than rewinding the avatar.
      const newest = avatar.snapshots[avatar.snapshots.length - 1];
      if (newest && snapshot.time <= newest.time) return;
      avatar.snapshots.push(snapshot);
      if (avatar.snapshots.length > SNAPSHOT_LIMIT) avatar.snapshots.shift();
    };
    const applyLook = (slot: number, list: Attachment[]) => {
      remoteLooksRef.current.set(slot, list);
      const avatar = remoteAvatars.get(slot);
      if (!avatar) return;
      avatar.parts.forEach((group) => {
        group.removeFromParent();
        disposePart(group);
      });
      avatar.parts = list
        .map((attachment) => attachToSkeleton(attachment, (name) => avatar.boneByName.get(name)))
        .filter((group): group is THREE.Group => group !== null);
    };
    applyLookRef.current = applyLook;
    removeRemoteRef.current = removeRemote;
    keepRemotesRef.current = (slots) => {
      Array.from(remoteAvatars.keys()).forEach((slot) => {
        if (!slots.has(slot)) removeRemote(slot);
      });
    };
    clearRemotesRef.current = () => Array.from(remoteAvatars.keys()).forEach(removeRemote);

    const createRemoteAvatar = (slot: number, snapshot: Snapshot) => {
      if (!remoteTemplate) return null;
      const container = new THREE.Group();
      const clone = cloneSkeleton(remoteTemplate) as THREE.Group;
      const playerColor = new THREE.Color().setHSL(((slot * 97) % 360) / 360, 0.68, 0.56);
      const byName = new Map<string, THREE.Bone>();
      clone.traverse((object) => {
        if (object instanceof THREE.Bone) byName.set(object.name, object);
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
      container.position.set(snapshot.x, snapshot.y, snapshot.z);
      container.rotation.y = snapshot.yaw;
      scene.add(container);
      const avatar: RemoteAvatar = {
        container,
        bones: SYNC_BONES.map((name) => byName.get(name)),
        boneByName: byName,
        parts: [],
        snapshots: [],
      };
      remoteAvatars.set(slot, avatar);
      applyLook(slot, remoteLooksRef.current.get(slot) ?? []);
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
        const skinnedMeshes: THREE.SkinnedMesh[] = [];
        rigScene.traverse((object) => {
          if (object instanceof THREE.SkinnedMesh) {
            object.castShadow = true;
            object.receiveShadow = true;
            object.frustumCulled = false;
            skinnedMeshes.push(object);
          }
          if (object instanceof THREE.Bone) {
            const canonicalName = object.name.startsWith("mixamorig") && !object.name.startsWith("mixamorig:")
              ? object.name.replace(/^mixamorig/, "mixamorig:")
              : object.name;
            object.name = canonicalName;
            bones.set(canonicalName, object);
          }
        });
        // Cloned before the mask is installed, so remote avatars keep a whole body.
        remoteTemplate = cloneSkeleton(rigScene) as THREE.Group;
        installBoneMask(skinnedMeshes);

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
        // Stuck-on pieces hang off the bones, so the ragdoll carries them with no
        // per-frame work: whatever the muscles do to a limb happens to its horns too.
        attachmentsRef.current.forEach((attachment) => attachToSkeleton(attachment, (name) => bones.get(name)));
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
              smoothIntent: null,
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
        link.smoothIntent = null;
      });
      smoothHipIntent = null;
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

      // The eye is resolved before the muscles run so the hands can be aimed at a spot
      // on this frame's screen rather than at where the view was a frame ago.
      if (firstPersonView) {
        const headBodyY = ragdollNodes.get("mixamorig:Head")?.body.position.y;
        if (headBodyY !== undefined) {
          // Pinned to where the ragdoll's head actually settles, but it may only creep
          // there at EYE_DRIFT units/second — too slow to read as bob.
          const eyeTarget = headBodyY + EYE_RISE;
          if (snapEyeHeight) eyeHeight = eyeTarget;
          else eyeHeight += THREE.MathUtils.clamp(eyeTarget - eyeHeight, -EYE_DRIFT * dt, EYE_DRIFT * dt);
        }
        snapEyeHeight = false;
      }
      // The eye rides the smooth kinematic root: no walk bob, no landing dip, no roll,
      // and none of the ragdoll's jitter reaches the view.
      const eyePosition = new THREE.Vector3(root.x, eyeHeight, root.z).addScaledVector(lookForward, EYE_FORWARD);

      // A viewmodel anchor. Every point on the ray from the eye through a given screen
      // position projects to that same spot, so instead of picking one point on it and
      // clamping into the shoulder's reach — which drags the hand off the mark — this
      // intersects the ray with the sphere the arm can reach and takes the far hit. The
      // hand then holds its place in frame and only its depth gives, at any FOV, aspect
      // or pitch. When the ray passes beyond reach entirely it falls back to the closest
      // approach, putting the hand as near the mark as the arm allows.
      const viewAnchor = (screenX: number, screenY: number, shoulder: THREE.Vector3, maxReach: number) => {
        const tanHalfFov = Math.tan(THREE.MathUtils.degToRad(settings.fov) * 0.5);
        const viewUp = lookRight.clone().cross(reachDirection);
        const ray = reachDirection.clone()
          .addScaledVector(lookRight, screenX * tanHalfFov * camera.aspect)
          .addScaledVector(viewUp, screenY * tanHalfFov)
          .normalize();
        const toShoulder = shoulder.clone().sub(eyePosition);
        const along = toShoulder.dot(ray);
        const offRaySq = Math.max(toShoulder.lengthSq() - along * along, 0);
        const reachSq = maxReach * maxReach;
        const depth = offRaySq <= reachSq ? along + Math.sqrt(reachSq - offRaySq) : along;
        const fromShoulder = eyePosition.clone().addScaledVector(ray, Math.max(depth, 0.05)).sub(shoulder);
        const distance = Math.max(fromShoulder.length(), 0.0001);
        return { direction: fromShoulder.divideScalar(distance), distance: Math.min(distance, maxReach) };
      };

      ragdollNodes.forEach((node) => {
        const target = node.bindOffset.clone().applyQuaternion(yaw).add(hipTarget);
        const leftSide = node.name.includes("Left");
        const rightSide = node.name.includes("Right");
        const isArm = /Shoulder|Arm|ForeArm|Hand/.test(node.name);
        let muscleScale = 1;
        let gravityAssist = 0;
        if (isArm) {
          const sideName = leftSide ? "Left" : "Right";
          const armNode = ragdollNodes.get(`mixamorig:${sideName}Arm`);
          const forearmNode = ragdollNodes.get(`mixamorig:${sideName}ForeArm`);
          const handNode = ragdollNodes.get(`mixamorig:${sideName}Hand`);
          const reaching = (leftSide && mouseButtons.has(0)) || (rightSide && mouseButtons.has(2));
          if (armNode && forearmNode && /ForeArm|Hand/.test(node.name)) {
            const armTarget = armNode.bindOffset.clone().applyQuaternion(yaw).add(hipTarget);
            const upperArmLength = armNode.bindOffset.distanceTo(forearmNode.bindOffset);
            if (reaching && firstPersonView) {
              const lowerArmLength = handNode ? forearmNode.bindOffset.distanceTo(handNode.bindOffset) : 0;
              const fullReach = (upperArmLength + lowerArmLength) * 0.97;
              const aim = viewAnchor(leftSide ? -HAND_SCREEN_X : HAND_SCREEN_X, HAND_SCREEN_Y, armTarget, fullReach);
              // Both bones aim down the same line, so the whole arm points at the mark.
              const along = /Hand/.test(node.name) ? aim.distance : Math.min(upperArmLength, aim.distance);
              target.copy(armTarget).addScaledVector(aim.direction, along);
              muscleScale = /Hand/.test(node.name) ? 0.62 : 0.7;
              gravityAssist = 1;
            } else if (reaching) {
              const lowerArmLength = handNode ? forearmNode.bindOffset.distanceTo(handNode.bindOffset) : 0;
              const reachLength = /Hand/.test(node.name) ? upperArmLength + lowerArmLength : upperArmLength;
              target.copy(armTarget).addScaledVector(reachDirection, reachLength * 0.92);
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
        nodeTargets.set(node.name, target);
        applyMuscle(node, target, muscleScale, gravityAssist);
      });

      physicsWorld.step(1 / 60, dt, 4);

      const hipsNode = ragdollNodes.get("mixamorig:Hips");
      if (hipsNode && rigScene) {
        // Partial ragdoll blending, the engine-standard "physics blend weight": the
        // simulation runs untouched and only the pose that gets skinned is pulled back
        // toward what the muscles were asking for. At 0 the body is pure physics; at 1
        // it follows the walk intent exactly. Blending toward the muscle target rather
        // than the bind pose is what keeps the legs stepping while the slop comes out.
        const steadiness = firstPersonView ? THREE.MathUtils.clamp(settings.steady, 0, 1) : 0;
        const rotatedBindHips = bindHipsWorld.clone().applyQuaternion(yaw);
        // Kept warm every frame, so raising the slider never snaps.
        if (!smoothHipIntent) smoothHipIntent = hipTarget.clone();
        else smoothHipIntent.lerp(hipTarget, 1 - Math.exp(-HIP_INTENT_SMOOTHING * dt));
        const hipsRendered = new THREE.Vector3(
          hipsNode.body.position.x,
          hipsNode.body.position.y,
          hipsNode.body.position.z,
        );
        if (steadiness > 0.001) hipsRendered.lerp(smoothHipIntent, steadiness);
        rigContainer.rotation.y = yawAngle;
        rigContainer.position.set(
          hipsRendered.x - rotatedBindHips.x,
          hipsRendered.y - rotatedBindHips.y,
          hipsRendered.z - rotatedBindHips.z,
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
          const startTarget = nodeTargets.get(link.bone.name);
          const endTarget = nodeTargets.get(link.endNode);
          if (startTarget && endTarget) {
            const intended = endTarget.clone().sub(startTarget);
            if (intended.lengthSq() > 1e-8) {
              intended.normalize();
              // Filtered every frame, whatever the slider says, so it stays warm.
              if (!link.smoothIntent) link.smoothIntent = intended.clone();
              else {
                link.smoothIntent.lerp(intended, 1 - Math.exp(-INTENT_SMOOTHING * dt));
                if (link.smoothIntent.lengthSq() < 1e-8) link.smoothIntent.copy(intended);
                else link.smoothIntent.normalize();
              }
            }
          }
          if (steadiness > 0.001 && link.smoothIntent) {
            physicalDirection.lerp(link.smoothIntent, steadiness);
            // A near-180° disagreement can lerp to zero length; fall back to intent.
            if (physicalDirection.lengthSq() < 1e-8) physicalDirection.copy(link.smoothIntent);
            else physicalDirection.normalize();
          }
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

        if (!syncBones.length) SYNC_BONES.forEach((name) => syncBones.push(localBones.get(name)));

        // Sent from the render loop rather than a timer. setInterval is clamped to once
        // a second in a background tab, which on its own turns a 15 Hz stream into the
        // one-second teleporting the old build showed when two clients shared a window.
        poseClock += dt;
        if (poseClock >= 1 / POSE_SEND_HZ) {
          poseClock = 0;
          const role = roleRef.current;
          if (role !== "solo") {
            encodePose(poseView, localSlotRef.current, rigContainer.position, rigContainer.rotation.y, syncBones);
            if (role === "host") {
              guestConnectionsRef.current.forEach((connection) => {
                if (connection.open) connection.send(poseBuffer);
              });
            } else if (hostConnectionRef.current?.open) {
              hostConnectionRef.current.send(poseBuffer);
            }
          }
        }
      }

      // Play remote avatars back on a delay, interpolating between the two snapshots
      // that straddle the render time. Motion then comes from the buffer rather than
      // from packet arrival, so an uneven stream still reads as continuous movement.
      const renderTime = now - INTERP_DELAY_MS;
      remoteAvatars.forEach((avatar) => {
        const frames = avatar.snapshots;
        if (!frames.length) return;
        while (frames.length > 2 && frames[1].time <= renderTime) frames.shift();
        const from = frames[0];
        const to = frames.length > 1 ? frames[1] : null;
        const span = to ? to.time - from.time : 0;
        const alpha = to && span > 0 ? THREE.MathUtils.clamp((renderTime - from.time) / span, 0, 1) : 0;
        const target = to ?? from;
        avatar.container.position.set(
          THREE.MathUtils.lerp(from.x, target.x, alpha),
          THREE.MathUtils.lerp(from.y, target.y, alpha),
          THREE.MathUtils.lerp(from.z, target.z, alpha),
        );
        const yawGap = Math.atan2(Math.sin(target.yaw - from.yaw), Math.cos(target.yaw - from.yaw));
        avatar.container.rotation.y = from.yaw + yawGap * alpha;
        for (let index = 0; index < avatar.bones.length; index += 1) {
          const bone = avatar.bones[index];
          if (!bone) continue;
          // slerpFlat is typed for number[] but reads any indexable buffer.
          THREE.Quaternion.slerpFlat(
            scratchQuaternion as unknown as number[], 0,
            from.quaternions as unknown as number[], index * 4,
            target.quaternions as unknown as number[], index * 4,
            alpha,
          );
          bone.quaternion.set(scratchQuaternion[0], scratchQuaternion[1], scratchQuaternion[2], scratchQuaternion[3]);
        }
      });

      applyBodyMask(settings.body);

      const desiredFov = firstPersonView ? settings.fov : TOP_DOWN_FOV;
      if (Math.abs(camera.fov - desiredFov) > 0.001) {
        camera.fov = desiredFov;
        camera.updateProjectionMatrix();
      }

      if (firstPersonView) {
        camera.position.copy(eyePosition);
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
      receivePoseRef.current = () => undefined;
      removeRemoteRef.current = () => undefined;
      keepRemotesRef.current = () => undefined;
      applyLookRef.current = () => undefined;
      clearRemotesRef.current = () => undefined;
      Array.from(remoteAvatars.keys()).forEach(removeRemote);
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [phase]);

  const bindTouch = (key: string) => ({
    onPointerDown: (event: React.PointerEvent<HTMLButtonElement>) => {
      event.currentTarget.setPointerCapture(event.pointerId);
      touchKeys.current[key] = true;
    },
    onPointerUp: () => { touchKeys.current[key] = false; },
    onPointerCancel: () => { touchKeys.current[key] = false; },
  });

  const updateComfort = (patch: Partial<ComfortSettings>) => setComfort((current) => ({ ...current, ...patch }));

  if (phase !== "play") {
    return (
      <CharacterCustomizer
        initial={attachments}
        onPlay={(chosen) => {
          setAttachments(chosen);
          attachmentsRef.current = chosen;
          setPhase("play");
        }}
      />
    );
  }

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
            <label>
              <span>STEADY</span>
              <input
                type="range" min={0} max={1} step={0.05} value={comfort.steady}
                onChange={(event) => updateComfort({ steady: Number(event.target.value) })}
              />
              <b>{Math.round(comfort.steady * 100)}%</b>
            </label>
            <div className="body-modes" role="group" aria-label="Body visibility">
              {(["full", "fade", "arms", "hidden"] as BodyView[]).map((mode) => (
                <button
                  key={mode}
                  aria-pressed={comfort.body === mode}
                  onClick={(event) => { event.currentTarget.blur(); updateComfort({ body: mode }); }}
                >
                  {mode === "full" ? "FULL BODY" : mode === "fade" ? "SOFT FADE" : mode === "arms" ? "ARMS ONLY" : "NO BODY"}
                </button>
              ))}
            </div>
            <div className="comfort-toggles">
              <button aria-pressed={comfort.vignette} onClick={(event) => { event.currentTarget.blur(); updateComfort({ vignette: !comfort.vignette }); }}>
                TUNNEL {comfort.vignette ? "ON" : "OFF"}
              </button>
              <button aria-pressed={comfort.invertY} onClick={(event) => { event.currentTarget.blur(); updateComfort({ invertY: !comfort.invertY }); }}>
                INVERT Y {comfort.invertY ? "ON" : "OFF"}
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
          <button className="edit-look-button" onClick={() => { leaveRoom(); setPhase("customise"); }}>EDIT LOOK</button>
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
