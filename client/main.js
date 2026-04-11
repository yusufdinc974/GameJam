import * as THREE from 'three';
import { io } from 'socket.io-client';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { OutlinePass } from 'three/examples/jsm/postprocessing/OutlinePass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { GammaCorrectionShader } from 'three/examples/jsm/shaders/GammaCorrectionShader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';

// ── Animated Model State ───────────────────────────────────────────────────
let loadedCharacterGLTF = null;
let modelLoadPromise = null;
const MODEL_SCALE = 1.0;
const MODEL_Y_OFFSET = 0.0;
const ATTACK_ANIM_DURATION = 0.6;

const ANIM_NAME_MAP = {
  'Idle': ['Idle', 'idle', 'IDLE', 'Rest', 'Standing'],
  'Run':  ['Run', 'run', 'Walk', 'walk', 'Locomotion'],
  'Attack': ['Attack', 'attack', 'Hit', 'Slash', 'Strike'],
};

function resolveClipName(clips, desiredName) {
  const candidates = ANIM_NAME_MAP[desiredName] || [desiredName];
  for (const name of candidates) {
    if (clips.find(c => c.name === name)) return name;
  }
  return null;
}

function preloadCharacterModel() {
  const loader = new GLTFLoader();
  modelLoadPromise = new Promise((resolve) => {
    loader.load(
      'assets/models/character.glb',
      (gltf) => {
        gltf.scene.traverse((child) => {
          if (child.isMesh) {
            child.castShadow = true;
            child.receiveShadow = true;
          }
        });
        loadedCharacterGLTF = gltf;
        console.log('[MODEL] character.glb loaded successfully, animations:', gltf.animations.map(a => a.name));
        resolve(true);
      },
      undefined,
      (err) => {
        console.warn('[MODEL] character.glb not found, using procedural fallback:', err.message || err);
        loadedCharacterGLTF = null;
        resolve(false);
      }
    );
  });
  return modelLoadPromise;
}

// ── Config ──────────────────────────────────────────────────────────────────
const SERVER_URL = 'http://localhost:3000';
const LERP_FACTOR = 0.15;
const FLOOR_SIZE = 400;
const GRID_DIVISIONS = 80;
const WORLD_BOUNDARY = FLOOR_SIZE / 2;

// ── Game State ──────────────────────────────────────────────────────────────
let myId = null;
let inGame = false;
let inLobby = true;
let isGameOver = false;
let gameOverData = null;
let selectedCharacter = null;

// ── Socket.io ───────────────────────────────────────────────────────────────
const socket = io(SERVER_URL);
socket.on('assignId', (id) => { myId = id; });

// ── Three.js Scene ──────────────────────────────────────────────────────────
const scene    = new THREE.Scene();
scene.background = new THREE.Color(0x87ceeb);
scene.fog      = new THREE.FogExp2(0x87ceeb, 0.0035);

const camera   = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 500);
const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 1));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
document.body.appendChild(renderer.domElement);

// ── Lighting ────────────────────────────────────────────────────────────────
scene.add(new THREE.AmbientLight(0xffffff, 0.58));

const dirLight = new THREE.DirectionalLight(0xffffff, 2.25);
dirLight.position.set(38, 64, 28);
dirLight.castShadow = true;
dirLight.shadow.mapSize.width = 1024;
dirLight.shadow.mapSize.height = 1024;
dirLight.shadow.camera.near = 0.5;
dirLight.shadow.camera.far = 260;
dirLight.shadow.camera.left = -180;
dirLight.shadow.camera.right = 180;
dirLight.shadow.camera.top = 180;
dirLight.shadow.camera.bottom = -180;
scene.add(dirLight);
const composer = new EffectComposer(renderer);
composer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
const renderPass = new RenderPass(scene, camera);
composer.addPass(renderPass);

const outlineObjects = [];
const outlinePass = new OutlinePass(new THREE.Vector2(innerWidth, innerHeight), scene, camera);
outlinePass.edgeStrength = 2.5;
outlinePass.edgeGlow = 0.0;
outlinePass.edgeThickness = 1.2;
outlinePass.visibleEdgeColor.set('#000000');
outlinePass.hiddenEdgeColor.set('#000000');
outlinePass.pulsePeriod = 0;
outlinePass.usePatternTexture = false;
outlinePass.selectedObjects = outlineObjects;
composer.addPass(outlinePass);

const gammaPass = new ShaderPass(GammaCorrectionShader);
composer.addPass(gammaPass);

function registerOutlineObject(mesh) {
  if (!mesh || outlineObjects.includes(mesh)) return;
  outlineObjects.push(mesh);
  outlinePass.selectedObjects = outlineObjects;
}

function unregisterOutlineObject(mesh) {
  if (!mesh) return;
  const idx = outlineObjects.indexOf(mesh);
  if (idx === -1) return;
  outlineObjects.splice(idx, 1);
  outlinePass.selectedObjects = outlineObjects;
}

// ── Floor ───────────────────────────────────────────────────────────────────
const floorGeo = new THREE.PlaneGeometry(FLOOR_SIZE, FLOOR_SIZE);
const floorMat = new THREE.MeshToonMaterial({ color: 0x4c7f2e });
const floor = new THREE.Mesh(floorGeo, floorMat);
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);

const gridHelper = new THREE.GridHelper(FLOOR_SIZE, GRID_DIVISIONS, 0x000000, 0x000000);
gridHelper.position.y = 0.01;
gridHelper.material.opacity = 0.65;
gridHelper.material.transparent = true;
scene.add(gridHelper);

const dustCount = 200;
const dustGeo = new THREE.BoxGeometry(0.08, 0.08, 0.08);
const dustMat = new THREE.MeshBasicMaterial({ color: 0x000000 });
const dustMesh = new THREE.InstancedMesh(dustGeo, dustMat, dustCount);
dustMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
const dustPositions = [];
const dummy = new THREE.Object3D();
for (let i = 0; i < dustCount; i++) {
  const x = (Math.random() * 2 - 1) * WORLD_BOUNDARY;
  const z = (Math.random() * 2 - 1) * WORLD_BOUNDARY;
  const y = Math.random() * 20 + 0.2;
  dustPositions.push({ x, y, z });
  dummy.position.set(x, y, z);
  dummy.updateMatrix();
  dustMesh.setMatrixAt(i, dummy.matrix);
}
scene.add(dustMesh);

// ── Geometries ──────────────────────────────────────────────────────────────
const geoCache = {
  cube:        new THREE.BoxGeometry(1, 1, 1),
  pyramid:     new THREE.ConeGeometry(0.6, 1, 4),
  icosahedron: new THREE.IcosahedronGeometry(0.7, 0),
  torus:       new THREE.TorusGeometry(0.5, 0.25, 8, 16),
  octahedron:  new THREE.OctahedronGeometry(0.72, 0),
  hexagon:     new THREE.CylinderGeometry(0.62, 0.62, 1, 6),
  dodecahedron:new THREE.DodecahedronGeometry(0.68, 0),
  cylinder:    new THREE.CylinderGeometry(0.58, 0.58, 1, 14),
  torusknot:   new THREE.TorusKnotGeometry(0.45, 0.18, 64, 8),
  capsule:     new THREE.CapsuleGeometry(0.4, 0.5, 8, 12),
};

const TEAM_COLORS = {
  red:  new THREE.Color(0xff2d3d),
  blue: new THREE.Color(0x1f66ff),
};
const BOT_COLOR = new THREE.Color(0xff9f1a);

const mapState = { walls: [], stealthZones: [] };
const wallMeshes = [];
const stealthZoneMeshes = [];
const wallMaterial = new THREE.MeshToonMaterial({
  color: 0x2f3b4f,
});
const stealthZoneMaterial = new THREE.MeshToonMaterial({
  color: 0x113311,
  transparent: true,
  opacity: 0.3,
  side: THREE.DoubleSide,
  depthWrite: false,
});

function clearEnvironmentMeshes() {
  while (wallMeshes.length > 0) {
    const mesh = wallMeshes.pop();
    scene.remove(mesh);
    mesh.geometry.dispose();
    if (mesh.material) mesh.material.dispose();
  }
  while (stealthZoneMeshes.length > 0) {
    const group = stealthZoneMeshes.pop();
    scene.remove(group);
    group.traverse((obj) => {
      if (obj.isMesh) {
        obj.geometry.dispose();
        if (obj.material) obj.material.dispose();
      }
    });
  }
}

function buildEnvironmentGeometry(walls, stealthZones) {
  mapState.walls = Array.isArray(walls) ? walls : [];
  mapState.stealthZones = Array.isArray(stealthZones) ? stealthZones : [];
  clearEnvironmentMeshes();

  for (const wall of mapState.walls) {
    const width = Number(wall.width) || 1;
    const depth = Number(wall.depth) || 1;
    const geo = new THREE.BoxGeometry(width, 4, depth);
    const mesh = new THREE.Mesh(geo, wallMaterial);
    mesh.position.set(Number(wall.x) || 0, 2, Number(wall.z) || 0);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    wallMeshes.push(mesh);
  }

  for (const zone of mapState.stealthZones) {
    const radius = Number(zone.radius) || 1;
    const group = new THREE.Group();
    const discGeo = new THREE.CylinderGeometry(radius, radius, 0.08, 48);
    const discMat = new THREE.MeshToonMaterial({ color: 0x09120f, transparent: true, opacity: 0.2, side: THREE.DoubleSide });
    const disc = new THREE.Mesh(discGeo, discMat);
    disc.rotation.x = -Math.PI / 2;
    disc.position.y = 0.06;
    group.add(disc);

    const ringPoints = [];
    const segments = 64;
    for (let i = 0; i <= segments; i++) {
      const angle = (i / segments) * Math.PI * 2;
      ringPoints.push(new THREE.Vector3(Math.cos(angle) * radius * 1.08, 0.3, Math.sin(angle) * radius * 1.08));
    }
    const ringGeo = new THREE.BufferGeometry().setFromPoints(ringPoints);
    const ringMat = new THREE.LineDashedMaterial({ color: 0x8e44ad, dashSize: 0.4, gapSize: 0.3, linewidth: 1, transparent: true, opacity: 0.8 });
    const ring = new THREE.Line(ringGeo, ringMat);
    ring.computeLineDistances();
    ring.position.y = 0.3;
    ring.userData.rotateSpeed = 0.003 + Math.random() * 0.002;
    group.add(ring);

    group.position.set(Number(zone.x) || 0, 0, Number(zone.z) || 0);
    scene.add(group);
    stealthZoneMeshes.push(group);
  }
}

// ── Player Entity Management ────────────────────────────────────────────────
const playerMeshes = {};
const nametagsContainer = document.getElementById('nametags-container');
const nametags = {};
const skillSpikeGeometry = new THREE.TetrahedronGeometry(0.12, 0);
const skillSpikeMaterial = new THREE.MeshToonMaterial({
  color: 0xc9d4de,
  emissive: new THREE.Color(0x7f8c99),
  emissiveIntensity: 0.3,
});

function ensureSkillSpikes(mesh) {
  if (mesh.userData.skillSpikes) return mesh.userData.skillSpikes;
  const spikes = [];
  const count = 10;
  for (let i = 0; i < count; i++) {
    const spike = new THREE.Mesh(skillSpikeGeometry, skillSpikeMaterial);
    const phi = Math.acos(1 - 2 * ((i + 0.5) / count));
    const theta = Math.PI * (1 + Math.sqrt(5)) * i;
    const dir = new THREE.Vector3(
      Math.cos(theta) * Math.sin(phi),
      Math.cos(phi),
      Math.sin(theta) * Math.sin(phi),
    );
    spike.position.copy(dir.multiplyScalar(0.95));
    spike.lookAt(spike.position.clone().multiplyScalar(1.6));
    spike.visible = false;
    mesh.add(spike);
    spikes.push(spike);
  }
  mesh.userData.skillSpikes = spikes;
  return spikes;
}

function setSkillSpikeVisibility(mesh, enabled, level) {
  if (!enabled && !mesh.userData.skillSpikes) return;
  const spikes = ensureSkillSpikes(mesh);
  const scale = 0.35 + Math.min(5, Math.max(0, level)) * 0.06;
  for (const spike of spikes) {
    spike.visible = enabled;
    if (enabled) spike.scale.setScalar(scale);
  }
}

function applySkillVFX(mesh, playerState) {
  const skills = (playerState && playerState.skills) || {};
  const juggernautLevel = Number(skills.juggernaut || skills.reinforcedPlating || skills.sacredBloom || 0);
  const spikeLevel = Number(skills.spikyArmor || 0);
  const arcaneLevel = Number(skills.arcaneOverflow || skills.warpedMind || 0);
  const isStealthed = !!(playerState && playerState.isStealthed);

  let scaleMultiplier = 1 + Math.min(5, Math.max(0, juggernautLevel)) * 0.08;
  if (!Number.isFinite(scaleMultiplier) || scaleMultiplier < 1) scaleMultiplier = 1;

  setSkillSpikeVisibility(mesh, spikeLevel > 0 && !isStealthed, spikeLevel);

  if (arcaneLevel > 0 && mesh.material) {
    mesh.material.emissiveIntensity = Math.min(1.0, (mesh.material.emissiveIntensity || 0) + arcaneLevel * 0.05);
  }

  return scaleMultiplier;
}

function createCharacterGroup(type, teamColor) {
  const group = new THREE.Group();
  let bodyMesh;
  const bodyMat = new THREE.MeshToonMaterial({
    color: teamColor,
    emissive: teamColor,
    emissiveIntensity: 0.2,
  });
  const darkMat = new THREE.MeshToonMaterial({
    color: new THREE.Color(0x1a1a1a),
    emissive: new THREE.Color(0x000000),
    emissiveIntensity: 0.1,
  });
  const glowMat = new THREE.MeshToonMaterial({
    color: new THREE.Color(0xffff8f),
    emissive: new THREE.Color(0xffff8f),
    emissiveIntensity: 0.85,
  });

  switch (type) {
    case 'cube': {
      bodyMesh = new THREE.Mesh(geoCache.cube, bodyMat);
      const padGeo = new THREE.BoxGeometry(0.35, 0.15, 0.35);
      for (const offset of [[0.5, 0.35, 0.5], [-0.5, 0.35, 0.5], [0.5, 0.35, -0.5], [-0.5, 0.35, -0.5]]) {
        const pad = new THREE.Mesh(padGeo, darkMat);
        pad.position.set(...offset);
        group.add(pad);
      }
      break;
    }
    case 'pyramid': {
      bodyMesh = new THREE.Mesh(new THREE.TetrahedronGeometry(0.7, 0), bodyMat);
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.18, 10, 10), glowMat);
      eye.position.set(0, 0, 0.55);
      group.add(eye);
      break;
    }
    case 'icosahedron': {
      bodyMesh = new THREE.Mesh(geoCache.icosahedron, bodyMat);
      const ringA = new THREE.Mesh(new THREE.RingGeometry(0.9, 1.05, 32), new THREE.MeshToonMaterial({ color: 0x9b59b6, emissive: 0x9b59b6, emissiveIntensity: 0.4, side: THREE.DoubleSide }));
      ringA.rotation.x = Math.PI / 2;
      ringA.position.y = 0.1;
      const ringB = new THREE.Mesh(new THREE.RingGeometry(1.25, 1.4, 32), new THREE.MeshToonMaterial({ color: 0xa29bfe, emissive: 0xa29bfe, emissiveIntensity: 0.35, side: THREE.DoubleSide }));
      ringB.rotation.y = Math.PI / 2;
      ringB.position.y = 0.05;
      group.add(ringA, ringB);
      bodyMesh.userData.magicRings = [ringA, ringB];
      break;
    }
    case 'torus': {
      bodyMesh = new THREE.Mesh(geoCache.torus, bodyMat);
      const orb = new THREE.Mesh(new THREE.SphereGeometry(0.18, 12, 12), glowMat);
      orb.position.set(0, 0, 0);
      group.add(orb);
      bodyMesh.userData.pulseOrb = orb;
      break;
    }
    case 'octahedron': {
      bodyMesh = new THREE.Mesh(geoCache.octahedron, bodyMat);
      const bladeGeo = new THREE.BoxGeometry(0.1, 0.35, 0.05);
      for (const angle of [0, Math.PI / 2, Math.PI, Math.PI * 1.5]) {
        const blade = new THREE.Mesh(bladeGeo, darkMat);
        blade.position.set(Math.cos(angle) * 0.5, 0, Math.sin(angle) * 0.5);
        blade.rotation.y = angle;
        group.add(blade);
      }
      break;
    }
    case 'hexagon': {
      bodyMesh = new THREE.Mesh(geoCache.hexagon, bodyMat);
      for (let i = 0; i < 3; i++) {
        const orb = new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 8), glowMat);
        const angle = (Math.PI * 2 * i) / 3;
        orb.position.set(Math.cos(angle) * 0.55, 0.12, Math.sin(angle) * 0.55);
        group.add(orb);
      }
      break;
    }
    case 'dodecahedron': {
      bodyMesh = new THREE.Mesh(geoCache.dodecahedron, bodyMat);
      const spikeGeo = new THREE.ConeGeometry(0.08, 0.3, 6);
      for (const angle of [0, Math.PI / 2, Math.PI, Math.PI * 1.5]) {
        const spike = new THREE.Mesh(spikeGeo, glowMat);
        spike.position.set(Math.cos(angle) * 0.55, 0, Math.sin(angle) * 0.55);
        spike.rotation.x = Math.PI / 2;
        spike.rotation.z = angle;
        group.add(spike);
      }
      break;
    }
    case 'cylinder': {
      bodyMesh = new THREE.Mesh(geoCache.cylinder, bodyMat);
      const boxGeo = new THREE.BoxGeometry(0.2, 0.2, 0.2);
      for (const offset of [[0.45, 0.15, 0], [-0.45, 0.15, 0], [0, 0.15, 0.45], [0, 0.15, -0.45]]) {
        const box = new THREE.Mesh(boxGeo, darkMat);
        box.position.set(...offset);
        group.add(box);
      }
      const core = new THREE.Mesh(new THREE.SphereGeometry(0.15, 10, 10), glowMat);
      core.position.set(0, 0.15, 0);
      group.add(core);
      break;
    }
    case 'torusknot': {
      bodyMesh = new THREE.Mesh(geoCache.torusknot, bodyMat);
      const halo = new THREE.Mesh(new THREE.RingGeometry(0.55, 0.7, 32), new THREE.MeshToonMaterial({ color: 0x1abc9c, emissive: 0x1abc9c, emissiveIntensity: 0.6, side: THREE.DoubleSide }));
      halo.rotation.x = Math.PI / 2;
      halo.position.y = 0.75;
      group.add(halo);
      break;
    }
    case 'capsule': {
      bodyMesh = new THREE.Mesh(geoCache.capsule, bodyMat);
      const skullMat = new THREE.MeshToonMaterial({ color: 0x2d2d2d, emissive: 0x27ae60, emissiveIntensity: 0.3 });
      for (let i = 0; i < 2; i++) {
        const skull = new THREE.Mesh(new THREE.SphereGeometry(0.14, 8, 8), skullMat);
        const angle = Math.PI * i;
        skull.position.set(Math.cos(angle) * 0.6, 0.2, Math.sin(angle) * 0.6);
        group.add(skull);
      }
      break;
    }
    default: {
      bodyMesh = new THREE.Mesh(geoCache.cube, bodyMat);
      break;
    }
  }

  bodyMesh.castShadow = true;
  bodyMesh.receiveShadow = true;
  group.add(bodyMesh);
  return { group, bodyMesh };
}

function createPlayerMesh(id, data) {
  const type = data.type || 'cube';
  const teamColor = TEAM_COLORS[data.team] || new THREE.Color(0xffffff);
  const { group, bodyMesh } = createCharacterGroup(type, teamColor);

  const s = data.scale || 1;
  group.position.set(data.x, data.y, data.z);
  group.scale.set(s, s, s);
  scene.add(group);

  // ── Rigged Model Clone ───────────────────────────────────────────────────
  let mixer = null;
  let animActions = {};
  let currentAnim = 'Idle';

  if (loadedCharacterGLTF) {
    const clonedScene = SkeletonUtils.clone(loadedCharacterGLTF.scene);
    clonedScene.scale.setScalar(MODEL_SCALE);
    clonedScene.position.y = MODEL_Y_OFFSET;
    group.add(clonedScene);

    // Hide procedural body but keep it for hitbox/physics
    bodyMesh.visible = false;
    group.children.forEach(child => {
      if (child !== clonedScene && child !== bodyMesh) child.visible = false;
    });

    // Set up AnimationMixer
    mixer = new THREE.AnimationMixer(clonedScene);
    const clips = loadedCharacterGLTF.animations;
    for (const desiredName of ['Idle', 'Run', 'Attack']) {
      const clipName = resolveClipName(clips, desiredName);
      if (clipName) {
        const clip = clips.find(c => c.name === clipName);
        const action = mixer.clipAction(clip);
        if (desiredName === 'Attack') {
          action.setLoop(THREE.LoopOnce);
          action.clampWhenFinished = true;
        }
        animActions[desiredName] = action;
      }
    }

    // Start default animation
    if (animActions['Idle']) {
      animActions['Idle'].play();
      currentAnim = 'Idle';
    }
  }

  registerOutlineObject(group);

  // Add custom properties to identify this as a player mesh for raycasting/damage tracking
  group.userData.isPlayer = true;
  group.userData.playerId = id;

  const tagEl = document.createElement('div');
  tagEl.className = 'nametag visible';
  tagEl.textContent = data.username || 'Anonymous';
  nametagsContainer.appendChild(tagEl);
  nametags[id] = tagEl;

  playerMeshes[id] = {
    mesh: group,
    bodyMesh,
    targetPos: new THREE.Vector3(data.x, data.y, data.z),
    targetScale: s,
    targetRotY: data.rotY || 0,
    currentType: type,
    team: data.team,
    isStealthed: false,
    skillScaleMultiplier: 1,
    buffRing: null,
    // Animation fields
    mixer,
    animActions,
    currentAnim,
    prevPos: new THREE.Vector3(data.x, data.y, data.z),
    isAttacking: false,
    attackTimer: 0,
  };
}

function removePlayerMesh(id) {
  const entry = playerMeshes[id];
  if (entry) {
    unregisterOutlineObject(entry.mesh);
    scene.remove(entry.mesh);
    entry.mesh.traverse((obj) => {
      if (obj.isMesh) {
        obj.geometry.dispose();
        if (obj.material) obj.material.dispose();
      }
    });
    if (entry.buffRing) {
      scene.remove(entry.buffRing);
      entry.buffRing.geometry.dispose();
      entry.buffRing.material.dispose();
      entry.buffRing = null;
    }
    // Clean up animation mixer
    if (entry.mixer) {
      entry.mixer.stopAllAction();
      entry.mixer.uncacheRoot(entry.mixer.getRoot());
    }
    delete playerMeshes[id];
  }
  const tagEl = nametags[id];
  if (tagEl) {
    tagEl.remove();
    delete nametags[id];
  }
}

// ── Animation Crossfade State Machine ──────────────────────────────────────
function fadeToAction(entry, newActionName, fadeDuration = 0.3) {
  if (!entry.mixer || !entry.animActions) return;
  if (entry.currentAnim === newActionName) return;

  const prevAction = entry.animActions[entry.currentAnim];
  const nextAction = entry.animActions[newActionName];
  if (!nextAction) return;

  if (prevAction) {
    prevAction.fadeOut(fadeDuration);
  }

  nextAction
    .reset()
    .setEffectiveTimeScale(1)
    .setEffectiveWeight(1)
    .fadeIn(fadeDuration)
    .play();

  entry.currentAnim = newActionName;
}

// ── Orb && Projectile Entity Management ──────────────────────────────────────
const orbMeshes = {};
const orbGeo = new THREE.OctahedronGeometry(0.3, 0);
const orbMat = new THREE.MeshToonMaterial({ color: 0xf39c12, emissive: 0xf39c12, emissiveIntensity: 0.6 });

function createOrbMesh(id, data) {
  const mesh = new THREE.Mesh(orbGeo, orbMat);
  mesh.position.set(data.x, data.y, data.z);
  scene.add(mesh);
  orbMeshes[id] = mesh;
}
function removeOrbMesh(id) {
  const mesh = orbMeshes[id];
  if (!mesh) return; scene.remove(mesh); delete orbMeshes[id];
}

const projMeshes = {};
const projGeoDefault = new THREE.SphereGeometry(0.15, 8, 8);
const projGeoArrow = new THREE.ConeGeometry(0.08, 0.4, 6);
const projGeoBolt = new THREE.IcosahedronGeometry(0.2, 0);
const projGeoOrb = new THREE.SphereGeometry(0.22, 10, 10);
const projGeoCurse = new THREE.TetrahedronGeometry(0.18, 0);
const projGeoHex = new THREE.OctahedronGeometry(0.14, 0);

function createProjMesh(id, data) {
  if (data.visible === false || data.kind === 'mine') return;
  const kind = data.kind || 'normal';
  const color = data.ownerColor || '#74b9ff';
  const ownerClass = data.ownerClass || '';
  const emissiveBoost = kind === 'turret_shot' ? 0.65 : (kind === 'summoner_homing' ? 0.85 : 1.0);
  const mat = new THREE.MeshToonMaterial({
    color: new THREE.Color(color),
    emissive: new THREE.Color(color),
    emissiveIntensity: emissiveBoost
  });
  let geo = projGeoDefault;
  if (ownerClass === 'archer') geo = projGeoArrow;
  else if (ownerClass === 'mage') geo = projGeoBolt;
  else if (ownerClass === 'priest') geo = projGeoOrb;
  else if (ownerClass === 'necromancer') geo = projGeoCurse;
  else if (ownerClass === 'chaos') geo = projGeoHex;
  else if (kind === 'summoner_homing') geo = projGeoOrb;
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(data.x, 0.5, data.z);
  scene.add(mesh);
  projMeshes[id] = { mesh, targetX: data.x, targetZ: data.z, kind, ownerClass };
}
function removeProjMesh(id) {
  const entry = projMeshes[id];
  if (!entry) return; scene.remove(entry.mesh); entry.mesh.material.dispose(); delete projMeshes[id];
}

// ── Base Entity Management ──────────────────────────────────────────────────
const botMeshes = {};
const botGeo = new THREE.OctahedronGeometry(1, 0);
const botMatCache = {
  red: new THREE.MeshToonMaterial({ color: 0xff2d3d, emissive: 0xff2d3d, emissiveIntensity: 0.8 }),
  blue: new THREE.MeshToonMaterial({ color: 0x1f66ff, emissive: 0x1f66ff, emissiveIntensity: 0.8 }),
  neutral: new THREE.MeshToonMaterial({ color: BOT_COLOR, emissive: BOT_COLOR.clone().multiplyScalar(0.26), emissiveIntensity: 0.35 }),
};

function createBotHealthUi() {
  const root = document.createElement('div');
  root.style.position = 'absolute';
  root.style.width = '34px';
  root.style.height = '6px';
  root.style.background = 'rgba(0, 0, 0, 0.6)';
  root.style.border = '1px solid rgba(255,255,255,0.15)';
  root.style.borderRadius = '4px';
  root.style.overflow = 'hidden';
  root.style.transform = 'translate(-50%, -50%)';
  root.style.pointerEvents = 'none';
  root.style.opacity = '0';
  root.style.transition = 'opacity 0.1s linear';

  const fill = document.createElement('div');
  fill.style.width = '100%';
  fill.style.height = '100%';
  fill.style.background = 'linear-gradient(90deg, #8a1f1f, #ff4b4b)';
  fill.style.boxShadow = '0 0 4px rgba(255, 80, 80, 0.5)';
  root.appendChild(fill);

  nametagsContainer.appendChild(root);
  return { root, fill };
}

function createBotMesh(id, data) {
  const scale = Number(data.scale) || 1;
  // Use cached materials instead of creating new ones per bot
  const botMaterial = data.team === 'red' ? botMatCache.red : data.team === 'blue' ? botMatCache.blue : botMatCache.neutral;
  
  const mesh = new THREE.Mesh(botGeo, botMaterial);
  mesh.position.set(Number(data.x) || 0, 0.8 * scale, Number(data.z) || 0);
  mesh.scale.set(scale, scale, scale);
  scene.add(mesh);

  // Add custom properties for damage tracking
  mesh.userData.isBot = true;
  mesh.userData.botId = id;

  const healthUi = createBotHealthUi();
  botMeshes[id] = {
    mesh,
    targetPos: new THREE.Vector3(Number(data.x) || 0, 0.8 * scale, Number(data.z) || 0),
    targetScale: scale,
    currentHealth: Number(data.currentHealth) || 0,
    maxHealth: Number(data.maxHealth) || 1,
    healthRoot: healthUi.root,
    healthFill: healthUi.fill,
  };
}

function removeBotMesh(id) {
  const entry = botMeshes[id];
  if (!entry) return;
  scene.remove(entry.mesh);
  if (entry.healthRoot) entry.healthRoot.remove();
  delete botMeshes[id];
}

const turretMeshes = {};
const turretGeo = new THREE.CylinderGeometry(0.5, 0.85, 1.2, 12);
function createTurretMesh(id, data) {
  const mat = new THREE.MeshToonMaterial({
    color: new THREE.Color(data.color || '#f39c12'),
    emissive: new THREE.Color(data.color || '#f39c12'),
    emissiveIntensity: 0.35,
  });
  const mesh = new THREE.Mesh(turretGeo, mat);
  const scale = Number(data.scale) || 1;
  mesh.scale.set(scale, scale, scale);
  mesh.position.set(Number(data.x) || 0, 0.8 * scale, Number(data.z) || 0);
  scene.add(mesh);
  turretMeshes[id] = {
    mesh,
    targetPos: new THREE.Vector3(Number(data.x) || 0, 0.8 * scale, Number(data.z) || 0),
    targetScale: scale,
  };
}

function removeTurretMesh(id) {
  const entry = turretMeshes[id];
  if (!entry) return;
  scene.remove(entry.mesh);
  entry.mesh.material.dispose();
  delete turretMeshes[id];
}

// ── Boss Mesh Management ────────────────────────────────────
const bossMeshData = { mesh: null, ring: null };
function createBossMesh(data) {
  if (!data || !data.id) return;
  
  // Remove old boss mesh if exists
  if (bossMeshData.mesh) {
    unregisterOutlineObject(bossMeshData.mesh);
    scene.remove(bossMeshData.mesh);
    bossMeshData.mesh.geometry.dispose();
    bossMeshData.mesh.material.dispose();
    bossMeshData.mesh = null;
  }
  if (bossMeshData.ring) {
    scene.remove(bossMeshData.ring);
    bossMeshData.ring.geometry.dispose();
    bossMeshData.ring.material.dispose();
    bossMeshData.ring = null;
  }

  // Create main boss icosahedron (scale 8)
  const bossMaterial = new THREE.MeshToonMaterial({
    color: new THREE.Color(0x330066),
    emissive: new THREE.Color(0x1a0033),
    emissiveIntensity: 0.5,
  });
  const bossGeo = new THREE.IcosahedronGeometry(1, 2);
  const bossMesh = new THREE.Mesh(bossGeo, bossMaterial);
  bossMesh.scale.set(8, 8, 8);
  bossMesh.position.set(data.x, 4, data.z);
  bossMesh.castShadow = true;
  bossMesh.receiveShadow = true;
  scene.add(bossMesh);
  registerOutlineObject(bossMesh);
  bossMeshData.mesh = bossMesh;

  // Create rotating ring around boss
  const ringGeo = new THREE.TorusGeometry(12, 0.5, 8, 32);
  const ringMat = new THREE.MeshToonMaterial({
    color: new THREE.Color(0x6600cc),
    emissive: new THREE.Color(0x6600cc),
    emissiveIntensity: 0.6,
  });
  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.rotation.x = Math.PI * 0.3;
  ring.position.set(data.x, 4, data.z);
  scene.add(ring);
  registerOutlineObject(ring);
  bossMeshData.ring = ring;
}

function removeBossMesh() {
  if (bossMeshData.mesh) {
    unregisterOutlineObject(bossMeshData.mesh);
    scene.remove(bossMeshData.mesh);
    bossMeshData.mesh.geometry.dispose();
    bossMeshData.mesh.material.dispose();
    bossMeshData.mesh = null;
  }
  if (bossMeshData.ring) {
    scene.remove(bossMeshData.ring);
    bossMeshData.ring.geometry.dispose();
    bossMeshData.ring.material.dispose();
    bossMeshData.ring = null;
  }
}

const baseMeshes = {};
function createBaseMesh(teamKey, data) {
  const teamColor = TEAM_COLORS[teamKey];
  const geo = new THREE.CylinderGeometry(data.scale, data.scale, 3, 16);
  const mat = new THREE.MeshToonMaterial({ color: teamColor, emissive: teamColor, emissiveIntensity: 0.3, transparent: true, opacity: 0.7 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(data.x, 1.5, data.z); mesh.castShadow = true; scene.add(mesh);

  const ringGeo = new THREE.TorusGeometry(data.scale + 0.5, 0.15, 8, 32);
  const ringMat = new THREE.MeshToonMaterial({ color: teamColor, emissive: teamColor, emissiveIntensity: 0.5 });
  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.rotation.x = -Math.PI / 2; ring.position.set(data.x, 0.05, data.z); scene.add(ring);
  baseMeshes[teamKey] = { mesh, ring, mat, initialOpacity: 0.7 };
}

function updateBaseMesh(teamKey, data) {
  const entry = baseMeshes[teamKey];
  if (!entry) return;
  const pct = data.currentHealth / data.maxHealth;
  entry.mat.opacity = 0.3 + pct * 0.5;
  entry.mat.emissiveIntensity = 0.1 + pct * 0.4;
  if (data.currentHealth <= 0) { entry.mat.opacity = 0.1; entry.mat.emissiveIntensity = 0.02; }
}

// ── Particle System ─────────────────────────────────────────────────────────
const activeParticles = [];
const particleGeo = new THREE.TetrahedronGeometry(0.3, 0);

const MAX_PARTICLES = 80;
const particleMatCache = {};
function getParticleMat(colorStr) {
  if (particleMatCache[colorStr]) return particleMatCache[colorStr];
  const c = new THREE.Color(colorStr);
  const mat = new THREE.MeshToonMaterial({
    color: c, emissive: c, emissiveIntensity: 0.8,
    transparent: true, opacity: 1
  });
  particleMatCache[colorStr] = mat;
  return mat;
}

function spawnParticle(x, z, colorStr) {
  if (activeParticles.length >= MAX_PARTICLES) return;
  const mat = getParticleMat(colorStr);
  const mesh = new THREE.Mesh(particleGeo, mat);
  mesh.position.set(x, 0.5, z);

  const vx = (Math.random() - 0.5) * 15;
  const vy = 5 + Math.random() * 10;
  const vz = (Math.random() - 0.5) * 15;

  scene.add(mesh);
  activeParticles.push({ mesh, vx, vy, vz, life: 1.0 });
}

// ── Hit Flash Effect ────────────────────────────────────────────────────────
const _flashMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
function flashHit(targetMesh) {
  if (!targetMesh) return;

  const originalMaterials = [];
  targetMesh.traverse((obj) => {
    if (obj.isMesh && obj.material) {
      originalMaterials.push({ obj, originalMaterial: obj.material });
      obj.material = _flashMat;
    }
  });

  setTimeout(() => {
    originalMaterials.forEach(({ obj, originalMaterial }) => {
      obj.material = originalMaterial;
    });
  }, 100);
}

// ── Melee Swing Visual ─────────────────────────────────────────────────────
const MELEE_CLASSES = new Set(['cube', 'octahedron', 'torusknot']); // warrior, assassin, paladin
const swingArcs = [];
const swingGeo = new THREE.RingGeometry(0.5, 2.5, 16, 1, 0, Math.PI / 2);
const swingMatCache = {};
function getSwingMat(color) {
  if (swingMatCache[color]) return swingMatCache[color];
  const c = new THREE.Color(color);
  const mat = new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.6, side: THREE.DoubleSide });
  swingMatCache[color] = mat;
  return mat;
}
function spawnSwingArc(x, z, rotY, color) {
  const mat = getSwingMat(color);
  const mesh = new THREE.Mesh(swingGeo, mat.clone());
  mesh.position.set(x, 0.5, z);
  mesh.rotation.x = -Math.PI / 2;
  mesh.rotation.z = rotY - Math.PI / 4;
  scene.add(mesh);
  swingArcs.push({ mesh, life: 0.25 });
}

// ── DOM Elements ────────────────────────────────────────────────────────────
const minimapCanvas = document.getElementById('minimap');
const hudLeaderboard = document.getElementById('hud-leaderboard');
const leaderboardList = document.getElementById('leaderboard-list');
const damageContainer = document.getElementById('damage-container');

const chatInput = document.getElementById('chat-input');
const socialContainer = document.getElementById('social-container');
const fpsCounter = document.getElementById('fps-counter');
let fpsFrames = 0, fpsLastTime = performance.now();
const helpButton = document.getElementById('help-button');
const howToModal = document.getElementById('howto-modal');
const howToClose = document.getElementById('howto-close');
const skillCardOverlay = document.getElementById('skill-card-overlay');
const skillCardButtons = [
  document.getElementById('skill-card-0'),
  document.getElementById('skill-card-1'),
  document.getElementById('skill-card-2'),
];

const hudUltimate = document.getElementById('hud-ultimate');
const hudUltimateFill = document.getElementById('hud-ultimate-fill');

const hudBoss = document.getElementById('hud-boss');
const hudBossBar = document.getElementById('hud-boss-bar');
const hudBossText = document.getElementById('hud-boss-text');
const announcementContainer = document.getElementById('announcement-container');

// Endgame UI
const endgameScreen = document.getElementById('endgame-screen');
const victoryText = document.getElementById('victory-text');
const scoreboardBody = document.getElementById('endgame-scoreboard-body');

// Global Variables
const EMOTES = { '1': '😀', '2': '😡', '3': '🔥' };
let isTyping = false;
const activeSocials = [];
let ultCooldown = 15000;
let lastUltTime = 0;
const ultimateVFX = [];
const bhParticles = [];
let isHowToOpen = false;
let isSkillCardOpen = false;
let currentSkillOptions = [];

function setHowToOpen(open) {
  if (open && isSkillCardOpen) return;
  isHowToOpen = !!open;
  if (howToModal) howToModal.style.display = isHowToOpen ? 'block' : 'none';
  if (isHowToOpen) {
    if (isTyping) {
      isTyping = false;
      chatInput.classList.remove('active');
      chatInput.blur();
    }
    for (const k in keys) keys[k] = false;
    if (inGame) emitMoveIntent();
  }
}

function setSkillCardOpen(open) {
  isSkillCardOpen = !!open;
  if (skillCardOverlay) {
    skillCardOverlay.classList.toggle('visible', isSkillCardOpen);
  }
  if (isSkillCardOpen) {
    setHowToOpen(false);
  }
}

function renderSkillCards(choices) {
  currentSkillOptions = [null, null, null];
  if (!Array.isArray(choices)) choices = [];
  for (let i = 0; i < skillCardButtons.length; i++) {
    const btn = skillCardButtons[i];
    if (!btn) continue;
    const choice = choices[i];
    if (!choice) {
      btn.style.display = 'none';
      btn.dataset.skillId = '';
      btn.dataset.skillIndex = String(i);
      continue;
    }
    currentSkillOptions[i] = String(choice.id || '');
    btn.style.display = 'flex';
    btn.dataset.skillId = String(choice.id || '');
    btn.dataset.skillIndex = String(i);
    const emojiEl = btn.querySelector('[data-role=\"emoji\"]');
    const nameEl = btn.querySelector('[data-role=\"name\"]');
    const levelEl = btn.querySelector('[data-role=\"level\"]');
    const descEl = btn.querySelector('[data-role=\"desc\"]');
    if (emojiEl) emojiEl.textContent = choice.emoji || '✨';
    if (nameEl) nameEl.textContent = choice.name || 'Unknown Skill';
    const currentLevel = Number(choice.currentLevel) || 0;
    const maxLevel = Math.max(1, Number(choice.maxLevel) || 1);
    const nextLevel = Math.min(maxLevel, currentLevel + 1);
    if (levelEl) levelEl.textContent = `Level ${currentLevel} -> ${nextLevel}`;
    if (descEl) descEl.textContent = choice.description || '';
  }
}

function clearSkillChoicesUI() {
  currentSkillOptions = [];
  setSkillCardOpen(false);
}

function submitSkillChoiceByIndex(index) {
  if (index < 0 || index > 2) return false;
  const skillId = currentSkillOptions[index];
  if (!skillId) return false;
  socket.emit('selectSkill', skillId);
  clearSkillChoicesUI();
  return true;
}

skillCardButtons.forEach((btn, index) => {
  if (!btn) return;
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    submitSkillChoiceByIndex(index);
  });
});

if (helpButton) {
  helpButton.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (isSkillCardOpen) return;
    setHowToOpen(true);
  });
}

if (howToClose) {
  howToClose.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    setHowToOpen(false);
  });
}

const hudUsernameHeader = document.getElementById('hud-username-header');
const hudPlayers      = document.getElementById('hud-players');
const hudTeam         = document.getElementById('hud-team');
const hudClass        = document.getElementById('hud-class');
const hudLevel        = document.getElementById('hud-level');
const hudHpBar        = document.getElementById('hud-hp-bar');
const hudHpText       = document.getElementById('hud-hp-text');
const hudExpBar       = document.getElementById('hud-exp-bar');
const hudExpText      = document.getElementById('hud-exp-text');
const hudBaseRedBar   = document.getElementById('hud-base-red-bar');
const hudBaseRedText  = document.getElementById('hud-base-red-text');
const hudBaseBlueBar  = document.getElementById('hud-base-blue-bar');
const hudBaseBlueText = document.getElementById('hud-base-blue-text');

// ── Screen Shake ────────────────────────────────────────────────────────────
let shakeIntensity = 0;
const shakeDecay = 0.9;

// ── Network Events ──────────────────────────────────────────────────────────
socket.on('initMap', (mapData) => {
  if (!mapData) return;
  buildEnvironmentGeometry(mapData.walls, mapData.stealthZones);
});

socket.on('skillChoices', (choices) => {
  if (!inGame) return;
  renderSkillCards(choices);
  if (currentSkillOptions.some((id) => !!id)) {
    setSkillCardOpen(true);
  } else {
    clearSkillChoicesUI();
  }
});

socket.on('ultimateCast', (data) => {
  if (!inGame) return;
  shakeIntensity = Math.max(shakeIntensity, 1.0); // Heavy screen shake

  const originX = data.x; const originZ = data.z;
  const tX = data.targetX; const tZ = data.targetZ;

  if (data.classType === 'warrior') {
    const geo = new THREE.RingGeometry(0.1, 15, 32);
    const mat = new THREE.MeshBasicMaterial({ color: 0xff6b6b, side: THREE.DoubleSide, transparent: true, opacity: 0.8 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(originX, 0.2, originZ);
    mesh.scale.set(0.1, 0.1, 0.1);
    scene.add(mesh);
    ultimateVFX.push({ mesh, type: 'warrior', life: 0.5, maxLife: 0.5 });
  } 
  else if (data.classType === 'archer') {
    const dx = tX - originX; const dz = tZ - originZ;
    const dist = Math.sqrt(dx*dx + dz*dz) || 1;
    const geo = new THREE.CylinderGeometry(1.5, 1.5, dist, 16);
    const mat = new THREE.MeshBasicMaterial({ color: 0x74b9ff, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending });
    const mesh = new THREE.Mesh(geo, mat);
    
    mesh.position.set(originX + dx/2, 1.0, originZ + dz/2);
    mesh.rotation.x = -Math.PI / 2;
    mesh.rotation.z = Math.atan2(dx, dz);
    scene.add(mesh);
    ultimateVFX.push({ mesh, type: 'archer', life: 0.5, maxLife: 0.5 });
  }
  else if (data.classType === 'mage') {
    const geo = new THREE.SphereGeometry(2, 32, 32);
    const mat = new THREE.MeshBasicMaterial({ color: 0x9b59b6, transparent: true, opacity: 0.9 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(tX, 1.0, tZ);
    scene.add(mesh);
    ultimateVFX.push({ mesh, type: 'mage', life: 3.0, maxLife: 3.0, tx: tX, tz: tZ });
  }
  else if (data.classType === 'priest') {
    const geo = new THREE.RingGeometry(0.5, 2.0, 48);
    const mat = new THREE.MeshBasicMaterial({ color: 0x00ff00, side: THREE.DoubleSide, transparent: true, opacity: 0.9 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(originX, 0.12, originZ);
    mesh.scale.set(0.3, 0.3, 0.3);
    scene.add(mesh);
    ultimateVFX.push({ mesh, type: 'priestHealPulse', life: 1.0, maxLife: 1.0 });
  } else if (data.classType === 'assassin') {
    const smokeGeo = new THREE.SphereGeometry(1.8, 14, 14);
    const smokeMat = new THREE.MeshBasicMaterial({ color: 0x111111, transparent: true, opacity: 0.65 });
    const smoke = new THREE.Mesh(smokeGeo, smokeMat);
    smoke.position.set(originX, 0.7, originZ);
    scene.add(smoke);
    ultimateVFX.push({ mesh: smoke, type: 'assassinSmoke', life: 0.45, maxLife: 0.45 });

    const flashGeo = new THREE.SphereGeometry(0.9, 14, 14);
    const flashMat = new THREE.MeshBasicMaterial({ color: 0xf5f5ff, transparent: true, opacity: 1.0, blending: THREE.AdditiveBlending });
    const flash = new THREE.Mesh(flashGeo, flashMat);
    flash.position.set(tX, 0.9, tZ);
    scene.add(flash);
    ultimateVFX.push({ mesh: flash, type: 'assassinFlash', life: 0.22, maxLife: 0.22 });
  } else if (data.classType === 'chaos') {
    const geo = new THREE.SphereGeometry(1.2, 24, 24);
    const mat = new THREE.MeshBasicMaterial({ color: 0xb56cff, wireframe: true, transparent: true, opacity: 0.85 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(originX, 1.2, originZ);
    scene.add(mesh);
    ultimateVFX.push({ mesh, type: 'chaosWarp', life: 0.28, maxLife: 0.28 });
  } else if (data.classType === 'summoner' || data.classType === 'engineer') {
    const geo = new THREE.SphereGeometry(1.1, 16, 16);
    const mat = new THREE.MeshBasicMaterial({
      color: data.classType === 'summoner' ? 0x63e286 : 0xf5b041,
      transparent: true,
      opacity: 0.8,
      wireframe: true,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(originX, 1.1, originZ);
    scene.add(mesh);
    ultimateVFX.push({ mesh, type: 'casterGlow', life: 0.55, maxLife: 0.55, targetId: data.playerId });
  }
});

socket.on('announcement', (text) => {
  if (!inGame) return;
  const el = document.createElement('div');
  el.className = 'announcement';
  el.textContent = text;
  announcementContainer.appendChild(el);
  setTimeout(() => {
    el.remove();
  }, 4000);
});

socket.on('socialEvent', (payload) => {
  if (!inGame) return;
  const el = document.createElement('div');
  el.className = 'social-bubble';
  if (payload.type === 'chat') {
    el.classList.add('social-chat');
    el.textContent = payload.text;
  } else if (payload.type === 'emote') {
    el.classList.add('social-emote');
    el.textContent = EMOTES[payload.emoteId] || '💬';
  }
  socialContainer.appendChild(el);
  const entry = { element: el, playerId: payload.playerId, createdAt: Date.now() };
  activeSocials.push(entry);
  
  setTimeout(() => {
    el.style.opacity = '0';
    setTimeout(() => {
        el.remove();
        const idx = activeSocials.indexOf(entry);
        if (idx !== -1) activeSocials.splice(idx, 1);
    }, 300);
  }, 3700);
});

socket.on('combatEvent', (ev) => {
  if (!inGame) return;

  if (ev.type === 'damage') {
    // Trigger hit flash on the damaged entity
    if (ev.targetId) {
      if (playerMeshes[ev.targetId]) {
        flashHit(playerMeshes[ev.targetId].mesh);
      } else if (botMeshes[ev.targetId]) {
        flashHit(botMeshes[ev.targetId].mesh);
      }
    }
    
    const el = document.createElement('span');
    el.className = 'dmg-text';
    el.textContent = `-${ev.amount}`;
    el.style.color = ev.color || '#fff';
    damageContainer.appendChild(el);

    const v = new THREE.Vector3(ev.x, 1.5, ev.z);
    v.project(camera);
    
    if (v.z > 1) {
      el.remove();
    } else {
      const halfW = innerWidth / 2;
      const halfH = innerHeight / 2;
      const left = (v.x * halfW) + halfW;
      const top = -(v.y * halfH) + halfH;
      
      const rX = left + (Math.random() - 0.5) * 40;
      const rY = top + (Math.random() - 0.5) * 20;
      
      el.style.left = `${rX}px`;
      el.style.top = `${rY}px`;
      
      void el.offsetWidth;
      
      el.style.top = `${rY - 80}px`;
      el.style.opacity = '0';
      
      setTimeout(() => el.remove(), 800);
    }

    if (myId && playerMeshes[myId]) {
      const me = playerMeshes[myId];
      const dx = me.targetPos.x - ev.x;
      const dz = me.targetPos.z - ev.z;
      if (dx * dx + dz * dz < 2.0) {
        shakeIntensity = Math.max(shakeIntensity, 0.5);
      } else {
        for (const teamKey in baseMeshes) {
          const entry = baseMeshes[teamKey];
          const bx = entry.mesh.position.x;
          const bz = entry.mesh.position.z;
          if ((bx - ev.x)**2 + (bz - ev.z)**2 < 25.0) { shakeIntensity = Math.max(shakeIntensity, 0.2); }
        }
      }
    }
  } else if (ev.type === 'death') {
    for (let i = 0; i < 8; i++) {
        spawnParticle(ev.x, ev.z, ev.color || '#fff');
    }
  }
});

socket.on('gameOver', (data) => {
  if (!inGame) return;
  isGameOver = true;
  gameOverData = data;
  shakeIntensity = 3.0; // Massive screen shake on base destruction
  
  // Show the endgame screen after 3 seconds (letting players watch the destruction)
  setTimeout(() => {
    const endgameScreen = document.getElementById('endgame-screen');
    const victoryText = document.getElementById('victory-text');
    const scoreboardBody = document.getElementById('endgame-scoreboard-body');
    
    const isVictory = (myId && gameOverData.scoreboardData.find(p => p.id === myId)?.team === gameOverData.winningTeam);
    victoryText.className = isVictory ? 'victory' : 'defeat';
    victoryText.textContent = isVictory ? 'VICTORY!' : 'DEFEAT!';
    
    // Populate scoreboard
    scoreboardBody.innerHTML = '';
    gameOverData.scoreboardData.forEach(p => {
      const row = document.createElement('div');
      row.className = 'scoreboard-row';
      row.innerHTML = `
        <div class="sb-col sb-name" style="color: ${p.team === 'red' ? '#ff2d3d' : '#1f66ff'}">${p.username}</div>
        <div class="sb-col sb-class">${p.classType}</div>
        <div class="sb-col sb-kills">${p.kills}</div>
        <div class="sb-col sb-deaths">${p.deaths}</div>
        <div class="sb-col sb-botkills">${p.botKills}</div>
        <div class="sb-col sb-damage">${Math.round(p.damageDealt)}</div>
      `;
      scoreboardBody.appendChild(row);
    });
    
    endgameScreen.classList.add('visible');
    
    // Countdown timer
    let secondsLeft = 15;
    const timerInterval = setInterval(() => {
      secondsLeft--;
      const timerEl = document.getElementById('countdown-timer');
      if (timerEl) timerEl.textContent = secondsLeft;
      if (secondsLeft <= 0) clearInterval(timerInterval);
    }, 1000);
  }, 3000);
});

socket.on('gameReset', () => {
  isGameOver = false;
  gameOverData = null;
  
  const endgameScreen = document.getElementById('endgame-screen');
  if (endgameScreen) endgameScreen.classList.remove('visible');
  
  // Clear particles and reset state
  while (activeParticles.length > 0) activeParticles.pop();
  while (ultimateVFX.length > 0) ultimateVFX.pop();
  while (bhParticles.length > 0) bhParticles.pop();

  // Clean up animation mixers
  for (const id in playerMeshes) {
    if (playerMeshes[id].mixer) {
      playerMeshes[id].mixer.stopAllAction();
    }
  }

  console.log('[CLIENT] Game reset - new match starting');
});

socket.on('stateUpdate', (state) => {
  const { players: playerData, orbs: orbData, projectiles: projData, bots: botData = [], turrets: turretData = [], bases: baseData } = state;

  const myTeam = myId && playerData[myId] ? playerData[myId].team : null;
  const activePlayerIds = new Set(Object.keys(playerData));
  for (const id in playerData) {
    const data = playerData[id];
    if (data.permaDead) {
      if (playerMeshes[id]) removePlayerMesh(id);
      continue;
    }

    if (!playerMeshes[id]) {
      createPlayerMesh(id, data);
    } else {
      const existing = playerMeshes[id];
      if (existing.currentType !== (data.type || 'cube') || existing.team !== data.team) {
        removePlayerMesh(id);
        createPlayerMesh(id, data);
      }
    }

    const entry = playerMeshes[id];
    if (!entry) continue;

    if (nametags[id]) nametags[id].textContent = data.username;

    const body = entry.bodyMesh;
    if (data.isInvincible) {
      body.material.emissiveIntensity = 1.0;
      body.material.emissive = new THREE.Color(0xf1c40f);
    } else if (data.isStunned) {
      body.material.emissiveIntensity = 0.8;
      body.material.emissive = new THREE.Color(0x9b59b6);
    } else {
      const tC = TEAM_COLORS[data.team] || new THREE.Color(0xffffff);
      body.material.emissiveIntensity = 0.2;
      body.material.emissive = tC;
    }

    const isStealthed = !!data.isStealthed;
    entry.isStealthed = isStealthed;
    body.material.transparent = isStealthed;
    body.material.opacity = isStealthed ? 0.15 : 1.0;
    body.material.depthWrite = !isStealthed;

    const tagEl = nametags[id];
    if (tagEl) {
      const hideEnemyUi = Boolean(myTeam && id !== myId && data.team !== myTeam && isStealthed);
      tagEl.style.display = hideEnemyUi ? 'none' : 'block';
    }

    const skillScaleMultiplier = applySkillVFX(body, data);
    entry.skillScaleMultiplier = skillScaleMultiplier;
    entry.targetPos.set(data.x, data.y, data.z);
    entry.targetScale = (data.scale || 1) * skillScaleMultiplier;
    entry.targetRotY = data.rotY || 0;

    // Handle Boss Buff VFX - Golden ring underneath
    if (data.hasBossBuff && !entry.buffRing) {
      const ringGeo = new THREE.RingGeometry(1.5, 1.8, 32);
      const ringMat = new THREE.MeshToonMaterial({
        color: new THREE.Color(0xffd700),
        emissive: new THREE.Color(0xffd700),
        emissiveIntensity: 0.9,
        side: THREE.DoubleSide,
      });
      const ring = new THREE.Mesh(ringGeo, ringMat);
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(data.x, 0.05, data.z);
      ring.userData.playerId = id;
      scene.add(ring);
      entry.buffRing = ring;
    } else if (!data.hasBossBuff && entry.buffRing) {
      scene.remove(entry.buffRing);
      entry.buffRing.geometry.dispose();
      entry.buffRing.material.dispose();
      entry.buffRing = null;
    } else if (data.hasBossBuff && entry.buffRing) {
      // Update ring position
      entry.buffRing.position.set(data.x, 0.05, data.z);
      // Rotate the ring
      entry.buffRing.rotation.z += 0.02;
    }
  }
  for (const id in playerMeshes) { if (!activePlayerIds.has(id)) removePlayerMesh(id); }

  const activeOrbIds = new Set(Object.keys(orbData));
  for (const id in orbData) { if (!orbMeshes[id]) createOrbMesh(id, orbData[id]); }
  for (const id in orbMeshes) { if (!activeOrbIds.has(id)) removeOrbMesh(id); }

  const activeProjIds = new Set();
  for (const id in projData) {
    const proj = projData[id];
    if (!proj || proj.visible === false || proj.kind === 'mine') {
      if (projMeshes[id]) removeProjMesh(id);
      continue;
    }
    activeProjIds.add(id);
    if (!projMeshes[id]) createProjMesh(id, proj);
    else {
      if (projMeshes[id].kind !== (proj.kind || 'normal')) {
        removeProjMesh(id);
        createProjMesh(id, proj);
      } else {
        projMeshes[id].targetX = proj.x;
        projMeshes[id].targetZ = proj.z;
      }
    }
  }
  for (const id in projMeshes) { if (!activeProjIds.has(id)) removeProjMesh(id); }

  const activeBotIds = new Set();
  for (const bot of botData) {
    if (!bot || !bot.id) continue;
    activeBotIds.add(bot.id);
    if (!botMeshes[bot.id]) {
      createBotMesh(bot.id, bot);
    }
    const entry = botMeshes[bot.id];
    if (!entry) continue;
    const scale = Number(bot.scale) || 1;
    entry.targetPos.set(Number(bot.x) || 0, 0.8 * scale, Number(bot.z) || 0);
    entry.targetScale = scale;
    entry.currentHealth = Number(bot.currentHealth) || 0;
    entry.maxHealth = Math.max(1, Number(bot.maxHealth) || 1);
    entry.healthFill.style.width = `${Math.max(0, Math.min(1, entry.currentHealth / entry.maxHealth)) * 100}%`;
  }
  for (const id in botMeshes) {
    if (!activeBotIds.has(id)) removeBotMesh(id);
  }

  const activeTurretIds = new Set();
  for (const turret of turretData) {
    if (!turret || !turret.id) continue;
    activeTurretIds.add(turret.id);
    if (!turretMeshes[turret.id]) createTurretMesh(turret.id, turret);
    const entry = turretMeshes[turret.id];
    if (!entry) continue;
    const scale = Number(turret.scale) || 1;
    entry.targetPos.set(Number(turret.x) || 0, 0.8 * scale, Number(turret.z) || 0);
    entry.targetScale = scale;
  }
  for (const id in turretMeshes) {
    if (!activeTurretIds.has(id)) removeTurretMesh(id);
  }

  if (baseData) {
    for (const teamKey of ['red', 'blue']) {
      if (!baseMeshes[teamKey] && baseData[teamKey]) createBaseMesh(teamKey, baseData[teamKey]);
      if (baseData[teamKey]) updateBaseMesh(teamKey, baseData[teamKey]);
    }
    const red = baseData.red, blue = baseData.blue;
    hudBaseRedBar.style.width   = `${(red.currentHealth / red.maxHealth) * 100}%`;
    hudBaseRedText.textContent  = Math.max(0, Math.round(red.currentHealth));
    hudBaseBlueBar.style.width  = `${(blue.currentHealth / blue.maxHealth) * 100}%`;
    hudBaseBlueText.textContent = Math.max(0, Math.round(blue.currentHealth));

    if (red.currentHealth <= 0 && !gameOverShown) showGameOver('blue');
    else if (blue.currentHealth <= 0 && !gameOverShown) showGameOver('red');
  }

  // ── Boss Handling ──
  const boss = state.boss;
  if (boss && boss.id) {
    if (!bossMeshData.mesh) {
      createBossMesh(boss);
    }
    // Update boss mesh position
    if (bossMeshData.mesh) {
      bossMeshData.mesh.position.set(boss.x, 4, boss.z);
      bossMeshData.mesh.rotation.x += 0.005;
      bossMeshData.mesh.rotation.y += 0.008;
    }
    if (bossMeshData.ring) {
      bossMeshData.ring.position.set(boss.x, 4, boss.z);
      bossMeshData.ring.rotation.z += 0.03;
    }
    // Update boss UI
    hudBoss.classList.add('visible');
    const bossHealthPct = Math.max(0, Math.min(1, boss.currentHealth / boss.maxHealth));
    hudBossBar.style.width = `${bossHealthPct * 100}%`;
    hudBossText.textContent = `${Math.max(0, Math.round(boss.currentHealth))} / ${boss.maxHealth}`;
  } else {
    if (bossMeshData.mesh) removeBossMesh();
    hudBoss.classList.remove('visible');
  }

  if (minimapCanvas) {
    const mapCtx = minimapCanvas.getContext('2d');
    const mapW = minimapCanvas.width;
    const mapH = minimapCanvas.height;
    mapCtx.clearRect(0, 0, mapW, mapH);

    function worldToMap(x, z) {
      const cx = ((x + WORLD_BOUNDARY) / (WORLD_BOUNDARY * 2)) * mapW;
      const cy = ((z + WORLD_BOUNDARY) / (WORLD_BOUNDARY * 2)) * mapH;
      return {
        cx: Math.max(0, Math.min(mapW, cx)),
        cy: Math.max(0, Math.min(mapH, cy)),
      };
    }

    if (baseData) {
      for (const teamKey of ['red', 'blue']) {
        const b = baseData[teamKey];
        if (b && b.currentHealth > 0) {
          const { cx, cy } = worldToMap(b.x, b.z);
          mapCtx.beginPath(); mapCtx.arc(cx, cy, 8, 0, Math.PI * 2);
          mapCtx.fillStyle = teamKey === 'red' ? '#ff2d3d' : '#1f66ff';
          mapCtx.fill();
        }
      }
    }

    const visionRangeSq = 30 * 30;
    if (myId && playerData[myId]) {
      const me = playerData[myId];
      for (const id in playerData) {
        const p = playerData[id];
        if (p.permaDead) continue;
        const isMe = (id === myId);
        const isAlly = (p.team === me.team);

        if (!isAlly && !isMe) {
          if (p.isStealthed) continue;
          if ((p.x-me.x)**2 + (p.z-me.z)**2 > visionRangeSq) continue;
        }

        const { cx, cy } = worldToMap(p.x, p.z);
        mapCtx.beginPath(); mapCtx.arc(cx, cy, isMe ? 4 : 3, 0, Math.PI * 2);
        mapCtx.fillStyle = p.team === 'red' ? '#ff2d3d' : '#1f66ff';
        mapCtx.fill();
        if (isMe) { mapCtx.lineWidth = 1.5; mapCtx.strokeStyle = '#fff'; mapCtx.stroke(); }
      }
    }

    for (const bot of botData) {
      if (!bot || typeof bot.x !== 'number' || typeof bot.z !== 'number') continue;
      const { cx, cy } = worldToMap(bot.x, bot.z);
      mapCtx.beginPath();
      mapCtx.arc(cx, cy, 2.5, 0, Math.PI * 2);
      mapCtx.fillStyle = '#ff9f1a';
      mapCtx.fill();
    }

    for (const turret of turretData) {
      if (!turret || typeof turret.x !== 'number' || typeof turret.z !== 'number') continue;
      const { cx, cy } = worldToMap(turret.x, turret.z);
      mapCtx.beginPath();
      mapCtx.rect(cx - 2, cy - 2, 4, 4);
      mapCtx.fillStyle = '#f39c12';
      mapCtx.fill();
    }
  }

  if (inGame && Object.keys(playerData).length > 0) {
    hudLeaderboard.classList.add('visible');
    const playersArr = Object.values(playerData).filter(p => !p.permaDead);
    playersArr.sort((a, b) => {
      const progressA = (Number(a.level) || 0) + (Number(a.exp) || 0) / Math.max(1, Number(a.maxExp) || 1);
      const progressB = (Number(b.level) || 0) + (Number(b.exp) || 0) / Math.max(1, Number(b.maxExp) || 1);
      return progressB - progressA;
    });

    leaderboardList.innerHTML = '';
    playersArr.slice(0, 5).forEach(p => {
      const li = document.createElement('li');
      li.textContent = `${p.username} - Lvl ${p.level}`;
      li.style.color = p.team === 'red' ? '#ff2d3d' : '#1f66ff';
      if (p.id === myId) li.style.fontWeight = '700';
      leaderboardList.appendChild(li);
    });
  } else {
    hudLeaderboard.classList.remove('visible');
  }

  hudPlayers.textContent = activePlayerIds.size;

  if (myId && playerData[myId]) {
    const me = playerData[myId];
    hudUsernameHeader.textContent = me.username.toUpperCase();
    hudTeam.textContent   = me.team ? me.team.toUpperCase() : '—';
    hudTeam.style.color   = me.team === 'red' ? '#ff2d3d' : '#1f66ff';
    hudClass.textContent  = me.classType ? me.classType.charAt(0).toUpperCase() + me.classType.slice(1) : '—';
    hudLevel.textContent  = me.level;

    hudHpBar.style.width  = `${(me.currentHealth / me.maxHealth) * 100}%`;
    hudHpText.textContent = `${Math.round(me.currentHealth)} / ${me.maxHealth}`;
    const expNow = Math.max(0, Math.floor(Number(me.exp) || 0));
    const expReq = Math.max(1, Math.floor(Number(me.maxExp) || 100));
    hudExpBar.style.width = `${Math.max(0, Math.min(1, expNow / expReq)) * 100}%`;
    hudExpText.textContent = `${expNow} / ${expReq}`;

    if (!me.isChoosingSkill && isSkillCardOpen) clearSkillChoicesUI();
  } else if (isSkillCardOpen) {
    clearSkillChoicesUI();
  }
});

// ── Input Handling ──────────────────────────────────────────────────────────
const keys = { w: false, a: false, s: false, d: false };
const KEY_MAP = { KeyW: 'w', ArrowUp: 'w', KeyS: 's', ArrowDown: 's', KeyA: 'a', ArrowLeft: 'a', KeyD: 'd', ArrowRight: 'd' };

const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
const floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const intersection = new THREE.Vector3();
const worldUp = new THREE.Vector3(0, 1, 0);

function updateAimIntersection() {
  raycaster.setFromCamera(mouse, camera);
  return raycaster.ray.intersectPlane(floorPlane, intersection);
}

function lerpAngle(current, target, alpha) {
  let delta = target - current;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  return current + delta * alpha;
}

function emitMoveIntent() {
  if (!inGame) return;

  // 1. Get the camera's actual looking direction
  const forward = new THREE.Vector3();
  camera.getWorldDirection(forward);
  forward.y = 0;
  forward.normalize();

  // 2. Calculate the perpendicular Right vector
  const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();

  // 3. Determine raw input (-1, 0, or 1)
  let moveForward = 0;
  let moveRight = 0;
  if (keys.w) moveForward += 1;
  if (keys.s) moveForward -= 1;
  if (keys.d) moveRight += 1;
  if (keys.a) moveRight -= 1;

  // 4. Combine vectors based on input
  const inputVec = new THREE.Vector3();
  inputVec.addScaledVector(forward, moveForward);
  inputVec.addScaledVector(right, moveRight);

  if (inputVec.lengthSq() > 0) {
    inputVec.normalize();
  }

  // 5. Send to server
  socket.emit('moveIntent', { dirX: inputVec.x, dirZ: inputVec.z });
}

window.addEventListener('mousemove', (e) => {
  if (!inGame || isHowToOpen) return;
  mouse.x = (e.clientX / innerWidth) * 2 - 1; mouse.y = -(e.clientY / innerHeight) * 2 + 1;
  updateAimIntersection();
});

window.addEventListener('keydown', (e) => {
  if (isHowToOpen && e.key === 'Escape') {
    setHowToOpen(false);
    e.preventDefault();
    return;
  }
  if (!inGame || e.target.id === 'lobby-username' || isHowToOpen) return;

  if (e.key === 'Enter') {
    if (!isTyping) {
      isTyping = true;
      chatInput.classList.add('active');
      chatInput.focus();
      for (const k in keys) keys[k] = false;
      emitMoveIntent();
    } else {
      isTyping = false;
      const text = chatInput.value.trim();
      if (text) socket.emit('sendChat', text);
      chatInput.value = '';
      chatInput.classList.remove('active');
      chatInput.blur();
    }
    e.preventDefault();
    return;
  }

  if (isTyping) return;

  if (e.shiftKey && EMOTES[e.key]) {
      socket.emit('sendEmote', e.key);
      e.preventDefault();
      return;
  }

  if (!e.shiftKey && currentSkillOptions.length > 0 && (e.key === '1' || e.key === '2' || e.key === '3')) {
    const selectedIndex = Number(e.key) - 1;
    if (submitSkillChoiceByIndex(selectedIndex)) {
      e.preventDefault();
      return;
    }
  }

  if (e.code === 'Space') {
    e.preventDefault();
    const now = Date.now();
    if (now - lastUltTime >= ultCooldown) {
      lastUltTime = now;
      updateAimIntersection();
      socket.emit('ultimate', { targetX: intersection.x, targetZ: intersection.z });
      if (hudUltimate) hudUltimate.classList.remove('ready');
    }
    return;
  }

  const key = KEY_MAP[e.code];
  if (key && !keys[key]) { keys[key] = true; emitMoveIntent(); }
});

window.addEventListener('keyup', (e) => {
  if (!inGame || isTyping || isHowToOpen) return;
  const key = KEY_MAP[e.code];
  if (key && keys[key]) { keys[key] = false; emitMoveIntent(); }
});

let isMouseHeld = false;
let attackInterval = null;

function doAttack() {
  if (!inGame || isTyping || isHowToOpen) return;
  updateAimIntersection();
  socket.emit('attack', { targetX: intersection.x, targetZ: intersection.z });
  if (myId && playerMeshes[myId]) {
    const entry = playerMeshes[myId];
    if (entry.mixer) {
      entry.isAttacking = true;
      entry.attackTimer = ATTACK_ANIM_DURATION;
      fadeToAction(entry, 'Attack', 0.1);
    }
    // Melee swing visual for close-range classes
    if (MELEE_CLASSES.has(entry.currentType)) {
      const m = entry.mesh;
      const color = entry.team === 'red' ? '#ff4444' : '#4488ff';
      spawnSwingArc(m.position.x, m.position.z, m.rotation.y, color);
    }
  }
}

window.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  if (
    !inGame ||
    isTyping ||
    isHowToOpen ||
    e.target.tagName === 'INPUT' ||
    e.target.closest('#howto-modal') ||
    e.target.closest('#help-button')
  ) return;
  isMouseHeld = true;
  doAttack();
  if (attackInterval) clearInterval(attackInterval);
  attackInterval = setInterval(() => {
    if (!isMouseHeld) { clearInterval(attackInterval); attackInterval = null; return; }
    doAttack();
  }, 50);
});

window.addEventListener('mouseup', (e) => {
  if (e.button !== 0) return;
  isMouseHeld = false;
  if (attackInterval) { clearInterval(attackInterval); attackInterval = null; }
});

// ── Lobby / Game Over ───────────────────────────────────────────────────────
const lobbyEl = document.getElementById('lobby');
const lobbyInput = document.getElementById('lobby-username');
const hudStats = document.getElementById('hud-stats');
const hudBasesEl = document.getElementById('hud-bases');
const minimapCont = document.getElementById('minimap-container');
const crosshair = document.getElementById('crosshair');

function joinGame(classType) {
  const val = lobbyInput.value.trim();
  if (!val) {
    lobbyInput.style.borderColor = '#e74c3c';
    lobbyInput.focus(); return;
  }
  clearSkillChoicesUI();
  localStorage.setItem('arena_username', val);
  socket.emit('joinGame', { classType, username: val });
  lobbyEl.classList.add('hidden');
  hudStats.classList.add('visible'); hudBasesEl.classList.add('visible');
  minimapCont.classList.add('visible'); crosshair.classList.add('visible');
  if (hudUltimate) hudUltimate.classList.add('visible');
  fpsCounter.classList.add('visible');
  inGame = true;
  inLobby = false;
  lastUltTime = Date.now();
  for (const k in keys) keys[k] = false;
  emitMoveIntent();
}

// ── 2-Step Character Selection ─────────────────────────────────────────────
const enterArenaBtn = document.getElementById('enter-arena-btn');
const allClassCards = document.querySelectorAll('.class-card');

function selectCharacter(classType, cardEl) {
  selectedCharacter = classType;
  localStorage.setItem('arena_character', classType);
  allClassCards.forEach(c => c.classList.remove('selected'));
  cardEl.classList.add('selected');
  enterArenaBtn.disabled = false;
  enterArenaBtn.textContent = 'ENTER ARENA';
}

document.getElementById('btn-warrior').addEventListener('click', function() { selectCharacter('warrior', this); });
document.getElementById('btn-archer').addEventListener('click', function() { selectCharacter('archer', this); });
document.getElementById('btn-mage').addEventListener('click', function() { selectCharacter('mage', this); });
document.getElementById('btn-priest').addEventListener('click', function() { selectCharacter('priest', this); });
document.getElementById('btn-assassin').addEventListener('click', function() { selectCharacter('assassin', this); });
document.getElementById('btn-summoner').addEventListener('click', function() { selectCharacter('summoner', this); });
document.getElementById('btn-chaos').addEventListener('click', function() { selectCharacter('chaos', this); });
document.getElementById('btn-engineer').addEventListener('click', function() { selectCharacter('engineer', this); });

enterArenaBtn.addEventListener('click', () => {
  if (selectedCharacter) joinGame(selectedCharacter);
});

// Save username on input
lobbyInput.addEventListener('input', () => {
  localStorage.setItem('arena_username', lobbyInput.value);
});

// ── Load localStorage Preferences ──────────────────────────────────────────
(function loadSavedPreferences() {
  const savedUsername = localStorage.getItem('arena_username');
  if (savedUsername) lobbyInput.value = savedUsername;

  const savedCharacter = localStorage.getItem('arena_character');
  if (savedCharacter) {
    const cardEl = document.getElementById('btn-' + savedCharacter);
    if (cardEl) selectCharacter(savedCharacter, cardEl);
  }
})();

const gameOverEl = document.getElementById('game-over');
const goTitle = document.getElementById('go-title');
const goSubtitle = document.getElementById('go-subtitle');
let gameOverShown = false;
function showGameOver(winningTeam) {
  gameOverShown = true;
  goTitle.textContent = `${winningTeam.toUpperCase()} TEAM WINS!`;
  goTitle.style.color = winningTeam === 'red' ? '#ff2d3d' : '#1f66ff';
  goSubtitle.textContent = 'The enemy base has been destroyed!';
  gameOverEl.classList.add('visible');
}

// ── Camera & Render Loop ────────────────────────────────────────────────────
const cameraOffset = new THREE.Vector3(0, 10, 15);
const cameraLookTarget = new THREE.Vector3();
const cameraLerpSpeed = 0.05;
const cameraTarget = new THREE.Vector3();
const rotatedCameraOffset = new THREE.Vector3();
const cameraHeadOffset = new THREE.Vector3(0, 2, 0);
const idealLookPoint = new THREE.Vector3();
const vfxGlowOffset = new THREE.Vector3(0, 0.8, 0);
let isCameraInitialized = false;
let cameraYaw = 0;
const clock = new THREE.Clock();
const _projVec = new THREE.Vector3(); // reusable vector for screen projection

function spawnMageParticle(tx, tz) {
  const geo = new THREE.BoxGeometry(0.5, 0.5, 0.5);
  const mat = new THREE.MeshBasicMaterial({ color: 0x9b59b6, transparent: true, opacity: 0.8 });
  const mesh = new THREE.Mesh(geo, mat);
  const angle = Math.random() * Math.PI * 2;
  const dist = 10 + Math.random() * 15;
  const sx = tx + Math.cos(angle)*dist;
  const sz = tz + Math.sin(angle)*dist;
  mesh.position.set(sx, Math.random()*5, sz);
  scene.add(mesh);
  bhParticles.push({ mesh, tx, tz, life: 1.0 });
}

function animate() {
  requestAnimationFrame(animate);
  const delta = clock.getDelta();
  const elapsed = clock.getElapsedTime();

  const halfW = innerWidth / 2;
  const halfH = innerHeight / 2;
  const localPlayerEntry = myId ? playerMeshes[myId] : null;

  updateAimIntersection();
  if (localPlayerEntry) {
    const aimDx = intersection.x - localPlayerEntry.mesh.position.x;
    const aimDz = intersection.z - localPlayerEntry.mesh.position.z;
    if (aimDx * aimDx + aimDz * aimDz > 0.0001) {
      localPlayerEntry.targetRotY = Math.atan2(aimDx, aimDz) + Math.PI;
    }
  }

  // Process Game Meshes
  for (const id in playerMeshes) {
    const entry = playerMeshes[id];
    const { mesh, targetPos, targetScale, targetRotY } = entry;
    mesh.position.lerp(targetPos, LERP_FACTOR);
    mesh.scale.x += (targetScale - mesh.scale.x) * LERP_FACTOR;
    mesh.scale.y += (targetScale - mesh.scale.y) * LERP_FACTOR;
    mesh.scale.z += (targetScale - mesh.scale.z) * LERP_FACTOR;
    mesh.rotation.y = lerpAngle(mesh.rotation.y, targetRotY || 0, LERP_FACTOR);

    // ── Animation State Machine ──────────────────────────────────────────
    if (entry.mixer) {
      const dx = entry.targetPos.x - entry.prevPos.x;
      const dz = entry.targetPos.z - entry.prevPos.z;
      const speed = Math.sqrt(dx * dx + dz * dz);
      entry.prevPos.copy(entry.targetPos);

      // Handle attack timer countdown
      if (entry.isAttacking) {
        entry.attackTimer -= delta;
        if (entry.attackTimer <= 0) {
          entry.isAttacking = false;
        }
      }

      // Priority: Attack > Run > Idle
      if (entry.isAttacking) {
        fadeToAction(entry, 'Attack', 0.15);
      } else if (speed > 0.05) {
        fadeToAction(entry, 'Run', 0.2);
      } else {
        fadeToAction(entry, 'Idle', 0.3);
      }

      entry.mixer.update(delta);
    }

    const tag = nametags[id];
    if (tag) {
      if (tag.style.display === 'none') {
        tag.style.opacity = '0';
        continue;
      }
      _projVec.copy(mesh.position);
      _projVec.y += (mesh.scale.y * 1.5) + 0.5;
      _projVec.project(camera);
      if (_projVec.z > 1) {
        tag.style.opacity = '0';
      } else {
        tag.style.opacity = '1';
        tag.style.left = `${(_projVec.x * halfW) + halfW}px`;
        tag.style.top = `${-(_projVec.y * halfH) + halfH}px`;
      }
    }
  }

  for (const id in botMeshes) {
    const entry = botMeshes[id];
    entry.mesh.position.lerp(entry.targetPos, LERP_FACTOR);
    entry.mesh.scale.x += (entry.targetScale - entry.mesh.scale.x) * LERP_FACTOR;
    entry.mesh.scale.y += (entry.targetScale - entry.mesh.scale.y) * LERP_FACTOR;
    entry.mesh.scale.z += (entry.targetScale - entry.mesh.scale.z) * LERP_FACTOR;

    if (entry.healthFill) {
      const hpPct = Math.max(0, Math.min(1, entry.currentHealth / Math.max(1, entry.maxHealth)));
      entry.healthFill.style.width = `${hpPct * 100}%`;
    }

    if (entry.healthRoot) {
      _projVec.copy(entry.mesh.position);
      _projVec.y += (entry.mesh.scale.y * 1.7) + 0.6;
      _projVec.project(camera);
      if (_projVec.z > 1 || Math.abs(_projVec.x) > 1.2 || Math.abs(_projVec.y) > 1.2) {
        entry.healthRoot.style.opacity = '0';
      } else {
        entry.healthRoot.style.opacity = '1';
        entry.healthRoot.style.left = `${(_projVec.x * halfW) + halfW}px`;
        entry.healthRoot.style.top = `${-(_projVec.y * halfH) + halfH}px`;
      }
    }
  }

  for (const id in turretMeshes) {
    const entry = turretMeshes[id];
    entry.mesh.position.lerp(entry.targetPos, LERP_FACTOR);
    entry.mesh.scale.x += (entry.targetScale - entry.mesh.scale.x) * LERP_FACTOR;
    entry.mesh.scale.y += (entry.targetScale - entry.mesh.scale.y) * LERP_FACTOR;
    entry.mesh.scale.z += (entry.targetScale - entry.mesh.scale.z) * LERP_FACTOR;
    entry.mesh.rotation.y += delta * 1.8;
  }

  for (const soc of activeSocials) {
    const entry = playerMeshes[soc.playerId];
    if (entry) {
      _projVec.copy(entry.mesh.position);
      _projVec.y += (entry.targetScale * 1.5) + 1.2;
      _projVec.project(camera);
      if (_projVec.z > 1) {
        soc.element.style.opacity = '0';
      } else {
        soc.element.style.opacity = '1';
        soc.element.style.left = `${(_projVec.x * halfW) + halfW}px`;
        soc.element.style.top = `${-(_projVec.y * halfH) + halfH}px`;
      }
    } else {
      soc.element.style.opacity = '0';
    }
  }

  for (const id in orbMeshes) {
    const mesh = orbMeshes[id];
    mesh.rotation.y = elapsed * 2; mesh.rotation.x = elapsed * 0.5;
    mesh.position.y = 0.5 + Math.sin(elapsed * 3 + mesh.position.x) * 0.15;
  }
  for (const group of stealthZoneMeshes) {
    group.children.forEach((child) => {
      if (child.isLine) {
        child.rotation.y += child.userData.rotateSpeed || 0.003;
      }
    });
  }
  for (let i = 0; i < dustCount; i++) {
    const entry = dustPositions[i];
    entry.y += 0.02;
    if (entry.y > 20) entry.y = 0.2;
    dummy.position.set(entry.x, entry.y, entry.z);
    dummy.updateMatrix();
    dustMesh.setMatrixAt(i, dummy.matrix);
  }
  dustMesh.instanceMatrix.needsUpdate = true;
  for (const id in projMeshes) {
    const entry = projMeshes[id];
    entry.mesh.position.x += (entry.targetX - entry.mesh.position.x) * 0.5;
    entry.mesh.position.z += (entry.targetZ - entry.mesh.position.z) * 0.5;
    // Rotate projectiles for visual flair
    if (entry.ownerClass === 'archer') {
      // Arrow points in direction of travel
      const dx = entry.targetX - entry.mesh.position.x;
      const dz = entry.targetZ - entry.mesh.position.z;
      if (dx * dx + dz * dz > 0.001) {
        entry.mesh.rotation.x = Math.PI / 2;
        entry.mesh.rotation.z = Math.atan2(dx, dz);
      }
    } else if (entry.ownerClass === 'mage' || entry.ownerClass === 'chaos' || entry.ownerClass === 'necromancer') {
      entry.mesh.rotation.x += delta * 6;
      entry.mesh.rotation.y += delta * 8;
    } else if (entry.kind === 'summoner_homing') {
      entry.mesh.rotation.y += delta * 10;
    }
  }
  for (const teamKey in baseMeshes) {
    const entry = baseMeshes[teamKey];
    if (entry && entry.ring) entry.ring.rotation.z = elapsed * 0.3;
  }

  for (let i = ultimateVFX.length - 1; i >= 0; i--) {
    const vfx = ultimateVFX[i];
    vfx.life -= delta;
    if (vfx.life <= 0) {
      scene.remove(vfx.mesh);
      vfx.mesh.material.dispose();
      ultimateVFX.splice(i, 1);
      continue;
    }
    
    const pct = vfx.life / vfx.maxLife;
    if (vfx.type === 'warrior') {
      const invPct = 1 - pct;
      const s = 0.1 + invPct * 0.9;
      vfx.mesh.scale.set(s, s, s);
      vfx.mesh.material.opacity = pct;
    } else if (vfx.type === 'archer') {
      vfx.mesh.material.opacity = pct;
      vfx.mesh.scale.x = pct; 
      vfx.mesh.scale.z = pct;
    } else if (vfx.type === 'mage') {
      vfx.mesh.rotation.y += delta * 5;
      vfx.mesh.rotation.x += delta * 2;
      if (Math.random() > 0.5) spawnMageParticle(vfx.tx, vfx.tz);
    } else if (vfx.type === 'priestHealPulse') {
      const invPct = 1 - pct;
      const s = 0.3 + invPct * 6.2;
      vfx.mesh.scale.set(s, s, s);
      vfx.mesh.material.opacity = pct * 0.95;
    } else if (vfx.type === 'assassinSmoke') {
      const invPct = 1 - pct;
      const s = 1.0 + invPct * 2.4;
      vfx.mesh.scale.set(s, s * 0.7, s);
      vfx.mesh.material.opacity = pct * 0.55;
    } else if (vfx.type === 'assassinFlash') {
      const invPct = 1 - pct;
      const s = 0.8 + invPct * 2.5;
      vfx.mesh.scale.setScalar(s);
      vfx.mesh.material.opacity = pct;
    } else if (vfx.type === 'chaosWarp') {
      const invPct = 1 - pct;
      const s = 1.0 + invPct * 20;
      vfx.mesh.scale.set(s, s, s);
      vfx.mesh.material.opacity = pct * 0.85;
      vfx.mesh.rotation.y += delta * 6;
      vfx.mesh.rotation.x += delta * 3;
    } else if (vfx.type === 'casterGlow') {
      if (vfx.targetId && playerMeshes[vfx.targetId]) {
        const pmesh = playerMeshes[vfx.targetId].mesh;
        vfx.mesh.position.copy(pmesh.position).add(vfxGlowOffset);
      }
      const invPct = 1 - pct;
      const s = 1.0 + invPct * 1.4;
      vfx.mesh.scale.set(s, s, s);
      vfx.mesh.material.opacity = pct * 0.8;
      vfx.mesh.rotation.y += delta * 4;
    }
  }

  for (let i = bhParticles.length - 1; i >= 0; i--) {
    const bp = bhParticles[i];
    bp.life -= delta;
    if (bp.life <= 0) { scene.remove(bp.mesh); bp.mesh.material.dispose(); bhParticles.splice(i, 1); continue; }
    
    const dx = bp.tx - bp.mesh.position.x;
    const dz = bp.tz - bp.mesh.position.z;
    bp.mesh.position.x += dx * 2 * delta;
    bp.mesh.position.z += dz * 2 * delta;
    bp.mesh.position.y += (1.0 - bp.mesh.position.y) * 2 * delta;
    bp.mesh.scale.setScalar(bp.life);
  }

  for (let i = activeParticles.length - 1; i >= 0; i--) {
    const p = activeParticles[i];
    p.life -= delta;
    p.vy -= 20 * delta; 
    p.mesh.position.x += p.vx * delta;
    p.mesh.position.y += p.vy * delta;
    p.mesh.position.z += p.vz * delta;
    p.mesh.rotation.x += p.vx * delta;
    p.mesh.rotation.y += p.vy * delta;
    
    p.mesh.material.opacity = Math.max(0, p.life);
    const s = Math.max(0, p.life);
    p.mesh.scale.set(s, s, s);
    
    if (p.life <= 0 || p.mesh.position.y < 0) {
      scene.remove(p.mesh);
      activeParticles.splice(i, 1);
    }
  }

  // Update melee swing arcs
  for (let i = swingArcs.length - 1; i >= 0; i--) {
    const arc = swingArcs[i];
    arc.life -= delta;
    arc.mesh.material.opacity = Math.max(0, arc.life * 2.4);
    const s = 1 + (0.25 - arc.life) * 2;
    arc.mesh.scale.set(s, s, s);
    if (arc.life <= 0) {
      scene.remove(arc.mesh);
      arc.mesh.material.dispose();
      swingArcs.splice(i, 1);
    }
  }

  if (inGame && hudUltimate) {
     const now = Date.now();
     if (now - lastUltTime >= ultCooldown) {
        if (!hudUltimate.classList.contains('ready')) {
           hudUltimate.classList.add('ready');
           hudUltimateFill.style.transform = 'scaleX(1)';
        }
     } else {
        const pct = (now - lastUltTime) / ultCooldown;
        hudUltimateFill.style.transform = `scaleX(${pct})`;
     }
  }

  // Dynamic chase camera + Screen Shake
  if (localPlayerEntry) {
    const localMesh = localPlayerEntry.mesh;
    const justInitialized = !isCameraInitialized;
    if (!isCameraInitialized && localMesh) {
      cameraYaw = localMesh.rotation.y;
      isCameraInitialized = true;
    }

    // ── CINEMATIC CAMERA ON GAME OVER ──
    if (isGameOver && gameOverData) {
      // Fly camera up and pan to destroyed base
      const destroyedPos = gameOverData.destroyedBasePos;
      const targetCamPos = new THREE.Vector3(destroyedPos.x, 100, destroyedPos.z + 50);
      const targetLookPos = new THREE.Vector3(destroyedPos.x, 5, destroyedPos.z);
      
      camera.position.lerp(targetCamPos, 0.02);
      cameraLookTarget.lerp(targetLookPos, 0.02);
    } else {
      // Normal chase camera
      let angleDifference = localMesh.rotation.y - cameraYaw;
      angleDifference = (angleDifference + Math.PI * 3) % (Math.PI * 2) - Math.PI;
      cameraYaw += angleDifference * 0.05;

      rotatedCameraOffset.copy(cameraOffset).applyAxisAngle(worldUp, cameraYaw);
      cameraTarget.copy(localMesh.position).add(rotatedCameraOffset);
      idealLookPoint.copy(localMesh.position).add(cameraHeadOffset);

      if (justInitialized) {
        camera.position.copy(cameraTarget);
        cameraLookTarget.copy(idealLookPoint);
      } else {
        camera.position.lerp(cameraTarget, cameraLerpSpeed);
        cameraLookTarget.lerp(idealLookPoint, cameraLerpSpeed);
      }
    }

    if (shakeIntensity > 0.01) {
      camera.position.x += (Math.random() - 0.5) * shakeIntensity;
      camera.position.y += (Math.random() - 0.5) * shakeIntensity;
      camera.position.z += (Math.random() - 0.5) * shakeIntensity;
      shakeIntensity *= shakeDecay;
    }

    camera.lookAt(cameraLookTarget);
  } else {
    isCameraInitialized = false;
    cameraYaw = 0;

    // ── Lobby Cinematic Camera Pan ──
    if (inLobby) {
      const time = Date.now() * 0.0003;
      camera.position.x = Math.cos(time) * 120;
      camera.position.y = 60;
      camera.position.z = Math.sin(time) * 120;
      camera.lookAt(0, 0, 0);
    }
  }

  emitMoveIntent();
  updateAimIntersection();

  // ── FPS Counter ──
  fpsFrames++;
  const fpsNow = performance.now();
  if (fpsNow - fpsLastTime >= 1000) {
    fpsCounter.textContent = fpsFrames + ' FPS';
    fpsFrames = 0;
    fpsLastTime = fpsNow;
  }

  composer.render();
}
preloadCharacterModel().then(() => { animate(); });

window.addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  const pixelRatio = Math.min(devicePixelRatio, 1);
  renderer.setPixelRatio(pixelRatio);
  composer.setPixelRatio(pixelRatio);
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
  outlinePass.setSize(innerWidth, innerHeight);
});
