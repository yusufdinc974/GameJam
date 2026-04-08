import * as THREE from 'three';
import { io } from 'socket.io-client';

// ── Config ──────────────────────────────────────────────────────────────────
const SERVER_URL = 'http://localhost:3000';
const LERP_FACTOR = 0.15;
const FLOOR_SIZE = 400;
const GRID_DIVISIONS = 200;
const WORLD_BOUNDARY = FLOOR_SIZE / 2;

// ── Game State ──────────────────────────────────────────────────────────────
let myId = null;
let inGame = false;

// ── Socket.io ───────────────────────────────────────────────────────────────
const socket = io(SERVER_URL);
socket.on('assignId', (id) => { myId = id; });

// ── Three.js Scene ──────────────────────────────────────────────────────────
const scene    = new THREE.Scene();
scene.background = new THREE.Color(0x0a0a0f);
scene.fog      = new THREE.FogExp2(0x0a0a0f, 0.012);

const camera   = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 500);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

// ── Lighting ────────────────────────────────────────────────────────────────
scene.add(new THREE.AmbientLight(0x8899bb, 0.5));

const dirLight = new THREE.DirectionalLight(0xffeedd, 1.2);
dirLight.position.set(10, 20, 10);
dirLight.castShadow = true;
dirLight.shadow.mapSize.width = 2048;
dirLight.shadow.mapSize.height = 2048;
dirLight.shadow.camera.near = 0.5;
dirLight.shadow.camera.far = 80;
dirLight.shadow.camera.left = -50;
dirLight.shadow.camera.right = 50;
dirLight.shadow.camera.top = 50;
dirLight.shadow.camera.bottom = -50;
scene.add(dirLight);

scene.add(new THREE.HemisphereLight(0x4488cc, 0x223344, 0.3));

// ── Floor ───────────────────────────────────────────────────────────────────
const floorGeo = new THREE.PlaneGeometry(FLOOR_SIZE, FLOOR_SIZE);
const floorMat = new THREE.MeshStandardMaterial({ color: 0x111118, roughness: 0.85, metalness: 0.15 });
const floor = new THREE.Mesh(floorGeo, floorMat);
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);

const gridHelper = new THREE.GridHelper(FLOOR_SIZE, GRID_DIVISIONS, 0x222233, 0x191925);
gridHelper.position.y = 0.01;
scene.add(gridHelper);

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
};

const TEAM_COLORS = {
  red:  new THREE.Color(0xff4444),
  blue: new THREE.Color(0x4488ff),
};

const mapState = { walls: [], stealthZones: [] };
const wallMeshes = [];
const stealthZoneMeshes = [];
const wallMaterial = new THREE.MeshStandardMaterial({
  color: 0x2a2f36,
  roughness: 0.35,
  metalness: 0.85,
});
const stealthZoneMaterial = new THREE.MeshStandardMaterial({
  color: 0x113311,
  roughness: 1.0,
  metalness: 0.05,
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
  }
  while (stealthZoneMeshes.length > 0) {
    const mesh = stealthZoneMeshes.pop();
    scene.remove(mesh);
    mesh.geometry.dispose();
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
    const geo = new THREE.CylinderGeometry(radius, radius, 0.12, 36);
    const mesh = new THREE.Mesh(geo, stealthZoneMaterial);
    mesh.position.set(Number(zone.x) || 0, 0.06, Number(zone.z) || 0);
    mesh.receiveShadow = false;
    scene.add(mesh);
    stealthZoneMeshes.push(mesh);
  }
}

// ── Player Entity Management ────────────────────────────────────────────────
const playerMeshes = {};
const nametagsContainer = document.getElementById('nametags-container');
const nametags = {};

function createPlayerMesh(id, data) {
  const type = data.type || 'cube';
  const geo = geoCache[type] || geoCache.cube;
  const teamColor = TEAM_COLORS[data.team] || new THREE.Color(0xffffff);

  const mat = new THREE.MeshStandardMaterial({
    color: teamColor, roughness: 0.4, metalness: 0.3,
    emissive: teamColor, emissiveIntensity: 0.2,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = true; mesh.receiveShadow = true;
  mesh.position.set(data.x, data.y, data.z);

  const s = data.scale || 1;
  mesh.scale.set(s, s, s);
  scene.add(mesh);

  // Nametag HTML
  const tagEl = document.createElement('div');
  tagEl.className = 'nametag visible';
  tagEl.textContent = data.username || 'Anonymous';
  nametagsContainer.appendChild(tagEl);
  nametags[id] = tagEl;

  playerMeshes[id] = {
    mesh, targetPos: new THREE.Vector3(data.x, data.y, data.z),
    targetScale: s, targetRotY: data.rotY || 0,
    currentType: type, team: data.team, isStealthed: false,
  };
}

function removePlayerMesh(id) {
  const entry = playerMeshes[id];
  if (entry) {
    scene.remove(entry.mesh);
    entry.mesh.material.dispose();
    delete playerMeshes[id];
  }
  const tagEl = nametags[id];
  if (tagEl) {
    tagEl.remove();
    delete nametags[id];
  }
}

// ── Orb && Projectile Entity Management ──────────────────────────────────────
const orbMeshes = {};
const orbGeo = new THREE.OctahedronGeometry(0.3, 0);
const orbMat = new THREE.MeshStandardMaterial({ color: 0xf39c12, emissive: 0xf39c12, emissiveIntensity: 0.6, roughness: 0.2, metalness: 0.8 });

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
const projGeo = new THREE.SphereGeometry(0.15, 8, 8);
function createProjMesh(id, data) {
  if (data.visible === false || data.kind === 'mine') return;
  const kind = data.kind || 'normal';
  const color = data.ownerColor || '#74b9ff';
  const emissiveBoost = kind === 'turret_shot' ? 0.65 : (kind === 'summoner_homing' ? 0.85 : 1.0);
  const mat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(color),
    emissive: new THREE.Color(color),
    emissiveIntensity: emissiveBoost,
    roughness: 0.1,
    metalness: 0.9
  });
  const mesh = new THREE.Mesh(projGeo, mat);
  mesh.position.set(data.x, 0.5, data.z);
  scene.add(mesh);
  projMeshes[id] = { mesh, targetX: data.x, targetZ: data.z, kind };
}
function removeProjMesh(id) {
  const entry = projMeshes[id];
  if (!entry) return; scene.remove(entry.mesh); entry.mesh.material.dispose(); delete projMeshes[id];
}

// ── Base Entity Management ──────────────────────────────────────────────────
const botMeshes = {};
const botGeo = new THREE.OctahedronGeometry(1, 0);

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
  const mat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0x8b8b8b),
    roughness: 0.55,
    metalness: 0.2,
    emissive: new THREE.Color(0x3a3a3a),
    emissiveIntensity: 0.25,
  });
  const mesh = new THREE.Mesh(botGeo, mat);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.position.set(Number(data.x) || 0, 0.8 * scale, Number(data.z) || 0);
  mesh.scale.set(scale, scale, scale);
  scene.add(mesh);

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
  entry.mesh.material.dispose();
  if (entry.healthRoot) entry.healthRoot.remove();
  delete botMeshes[id];
}

const turretMeshes = {};
const turretGeo = new THREE.CylinderGeometry(0.5, 0.85, 1.2, 12);
function createTurretMesh(id, data) {
  const mat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(data.color || '#f39c12'),
    emissive: new THREE.Color(data.color || '#f39c12'),
    emissiveIntensity: 0.35,
    roughness: 0.35,
    metalness: 0.65,
  });
  const mesh = new THREE.Mesh(turretGeo, mat);
  const scale = Number(data.scale) || 1;
  mesh.scale.set(scale, scale, scale);
  mesh.position.set(Number(data.x) || 0, 0.8 * scale, Number(data.z) || 0);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
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

const baseMeshes = {};
function createBaseMesh(teamKey, data) {
  const teamColor = TEAM_COLORS[teamKey];
  const geo = new THREE.CylinderGeometry(data.scale, data.scale, 3, 16);
  const mat = new THREE.MeshStandardMaterial({ color: teamColor, emissive: teamColor, emissiveIntensity: 0.3, roughness: 0.5, metalness: 0.4, transparent: true, opacity: 0.7 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(data.x, 1.5, data.z); mesh.castShadow = true; mesh.receiveShadow = true; scene.add(mesh);

  const ringGeo = new THREE.TorusGeometry(data.scale + 0.5, 0.15, 8, 32);
  const ringMat = new THREE.MeshStandardMaterial({ color: teamColor, emissive: teamColor, emissiveIntensity: 0.5, roughness: 0.2, metalness: 0.8 });
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

function spawnParticle(x, z, colorStr) {
  const c = new THREE.Color(colorStr);
  const mat = new THREE.MeshStandardMaterial({
    color: c, emissive: c, emissiveIntensity: 0.8,
    transparent: true, opacity: 1, roughness: 0.2, metalness: 0.8
  });
  const mesh = new THREE.Mesh(particleGeo, mat);
  mesh.position.set(x, 0.5, z);
  
  const vx = (Math.random() - 0.5) * 15;
  const vy = 5 + Math.random() * 10;
  const vz = (Math.random() - 0.5) * 15;
  
  scene.add(mesh);
  activeParticles.push({ mesh, vx, vy, vz, life: 1.0 });
}

// ── DOM Elements ────────────────────────────────────────────────────────────
const minimapCanvas = document.getElementById('minimap');
const hudSkills = document.getElementById('hud-skills');
const hudLeaderboard = document.getElementById('hud-leaderboard');
const leaderboardList = document.getElementById('leaderboard-list');
const damageContainer = document.getElementById('damage-container');

const chatInput = document.getElementById('chat-input');
const socialContainer = document.getElementById('social-container');
const helpButton = document.getElementById('help-button');
const howToModal = document.getElementById('howto-modal');
const howToClose = document.getElementById('howto-close');

const hudUltimate = document.getElementById('hud-ultimate');
const hudUltimateFill = document.getElementById('hud-ultimate-fill');

// Global Variables
const EMOTES = { '1': '😀', '2': '😡', '3': '🔥' };
let isTyping = false;
const activeSocials = [];
let ultCooldown = 15000;
let lastUltTime = 0;
const ultimateVFX = [];
const bhParticles = [];
let isHowToOpen = false;

function setHowToOpen(open) {
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

if (helpButton) {
  helpButton.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
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
    for (let i = 0; i < 20; i++) {
        spawnParticle(ev.x, ev.z, ev.color || '#fff');
    }
  }
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

    if (data.isInvincible) {
      entry.mesh.material.emissiveIntensity = 1.0;
      entry.mesh.material.emissive = new THREE.Color(0xf1c40f);
    } else if (data.isStunned) {
      entry.mesh.material.emissiveIntensity = 0.8;
      entry.mesh.material.emissive = new THREE.Color(0x9b59b6);
    } else {
      const tC = TEAM_COLORS[data.team] || new THREE.Color(0xffffff);
      entry.mesh.material.emissiveIntensity = 0.2;
      entry.mesh.material.emissive = tC;
    }

    const isStealthed = !!data.isStealthed;
    entry.isStealthed = isStealthed;
    entry.mesh.material.transparent = isStealthed;
    entry.mesh.material.opacity = isStealthed ? 0.15 : 1.0;
    entry.mesh.material.depthWrite = !isStealthed;

    const tagEl = nametags[id];
    if (tagEl) {
      const hideEnemyUi = Boolean(myTeam && id !== myId && data.team !== myTeam && isStealthed);
      tagEl.style.display = hideEnemyUi ? 'none' : 'block';
    }

    entry.targetPos.set(data.x, data.y, data.z);
    entry.targetScale = data.scale || 1;
    entry.targetRotY = data.rotY || 0;
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
          mapCtx.fillStyle = teamKey === 'red' ? '#ff4444' : '#4488ff';
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
        mapCtx.fillStyle = p.team === 'red' ? '#ff4444' : '#4488ff';
        mapCtx.fill();
        if (isMe) { mapCtx.lineWidth = 1.5; mapCtx.strokeStyle = '#fff'; mapCtx.stroke(); }
      }
    }

    for (const bot of botData) {
      if (!bot || typeof bot.x !== 'number' || typeof bot.z !== 'number') continue;
      const { cx, cy } = worldToMap(bot.x, bot.z);
      mapCtx.beginPath();
      mapCtx.arc(cx, cy, 2.5, 0, Math.PI * 2);
      mapCtx.fillStyle = '#9a9a9a';
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
      const xpA = (a.level * 5) + a.exp;
      const xpB = (b.level * 5) + b.exp;
      return xpB - xpA;
    });

    leaderboardList.innerHTML = '';
    playersArr.slice(0, 5).forEach(p => {
      const li = document.createElement('li');
      li.textContent = `${p.username} - Lvl ${p.level}`;
      li.style.color = p.team === 'red' ? '#ff6b6b' : '#74b9ff';
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
    hudTeam.style.color   = me.team === 'red' ? '#ff6b6b' : '#74b9ff';
    hudClass.textContent  = me.classType ? me.classType.charAt(0).toUpperCase() + me.classType.slice(1) : '—';
    hudLevel.textContent  = me.level;

    hudHpBar.style.width  = `${(me.currentHealth / me.maxHealth) * 100}%`;
    hudHpText.textContent = `${Math.round(me.currentHealth)} / ${me.maxHealth}`;
    hudExpBar.style.width = `${(me.exp / 5) * 100}%`;
    hudExpText.textContent= `${me.exp} / 5`;

    if (me.skillPoints > 0) hudSkills.style.display = 'block';
    else hudSkills.style.display = 'none';
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

  if (e.shiftKey && EMOTES[e.key]) {
      socket.emit('sendEmote', e.key);
      e.preventDefault();
      return;
  }

  const key = KEY_MAP[e.code];
  if (key && !keys[key]) { keys[key] = true; emitMoveIntent(); }

  if (e.key === '1' && !e.shiftKey) socket.emit('upgradeSkill', 'damage');
  else if (e.key === '2' && !e.shiftKey) socket.emit('upgradeSkill', 'health');
  else if (e.key === '3' && !e.shiftKey) socket.emit('upgradeSkill', 'speed');
});

window.addEventListener('keyup', (e) => {
  if (!inGame || isTyping || isHowToOpen) return;
  const key = KEY_MAP[e.code];
  if (key && keys[key]) { keys[key] = false; emitMoveIntent(); }
});

window.addEventListener('click', (e) => {
  if (
    !inGame ||
    isTyping ||
    isHowToOpen ||
    e.target.tagName === 'INPUT' ||
    e.target.closest('#hud-skills') ||
    e.target.closest('#howto-modal') ||
    e.target.closest('#help-button')
  ) return;
  updateAimIntersection();
  socket.emit('attack', { targetX: intersection.x, targetZ: intersection.z });
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
  socket.emit('joinGame', { classType, username: val });
  lobbyEl.classList.add('hidden');
  hudStats.classList.add('visible'); hudBasesEl.classList.add('visible');
  minimapCont.classList.add('visible'); crosshair.classList.add('visible');
  if (hudUltimate) hudUltimate.classList.add('visible');
  inGame = true;
  lastUltTime = Date.now();
  for (const k in keys) keys[k] = false; // Reset bounds
  emitMoveIntent();
}
document.getElementById('btn-warrior').addEventListener('click', () => joinGame('warrior'));
document.getElementById('btn-archer').addEventListener('click',  () => joinGame('archer'));
document.getElementById('btn-mage').addEventListener('click',  () => joinGame('mage'));
document.getElementById('btn-priest').addEventListener('click',  () => joinGame('priest'));
document.getElementById('btn-assassin').addEventListener('click', () => joinGame('assassin'));
document.getElementById('btn-summoner').addEventListener('click', () => joinGame('summoner'));
document.getElementById('btn-chaos').addEventListener('click', () => joinGame('chaos'));
document.getElementById('btn-engineer').addEventListener('click', () => joinGame('engineer'));

const gameOverEl = document.getElementById('game-over');
const goTitle = document.getElementById('go-title');
const goSubtitle = document.getElementById('go-subtitle');
let gameOverShown = false;
function showGameOver(winningTeam) {
  gameOverShown = true;
  goTitle.textContent = `${winningTeam.toUpperCase()} TEAM WINS!`;
  goTitle.style.color = winningTeam === 'red' ? '#ff6b6b' : '#74b9ff';
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
    const { mesh, targetPos, targetScale, targetRotY } = playerMeshes[id];
    mesh.position.lerp(targetPos, LERP_FACTOR);
    mesh.scale.x += (targetScale - mesh.scale.x) * LERP_FACTOR;
    mesh.scale.y += (targetScale - mesh.scale.y) * LERP_FACTOR;
    mesh.scale.z += (targetScale - mesh.scale.z) * LERP_FACTOR;
    mesh.rotation.y = lerpAngle(mesh.rotation.y, targetRotY || 0, LERP_FACTOR);

    const tag = nametags[id];
    if (tag) {
      if (tag.style.display === 'none') {
        tag.style.opacity = '0';
        continue;
      }
      const v = mesh.position.clone();
      v.y += (mesh.scale.y * 1.5) + 0.5;
      v.project(camera);
      if (v.z > 1) {
        tag.style.opacity = '0';
      } else {
        tag.style.opacity = '1';
        tag.style.left = `${(v.x * halfW) + halfW}px`;
        tag.style.top = `${-(v.y * halfH) + halfH}px`;
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
      const v = entry.mesh.position.clone();
      v.y += (entry.mesh.scale.y * 1.7) + 0.6;
      v.project(camera);
      if (v.z > 1 || Math.abs(v.x) > 1.2 || Math.abs(v.y) > 1.2) {
        entry.healthRoot.style.opacity = '0';
      } else {
        entry.healthRoot.style.opacity = '1';
        entry.healthRoot.style.left = `${(v.x * halfW) + halfW}px`;
        entry.healthRoot.style.top = `${-(v.y * halfH) + halfH}px`;
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
      const v = entry.mesh.position.clone();
      v.y += (entry.targetScale * 1.5) + 1.2;
      v.project(camera);
      if (v.z > 1) {
        soc.element.style.opacity = '0';
      } else {
        soc.element.style.opacity = '1';
        soc.element.style.left = `${(v.x * halfW) + halfW}px`;
        soc.element.style.top = `${-(v.y * halfH) + halfH}px`;
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
  for (const id in projMeshes) {
    const entry = projMeshes[id];
    entry.mesh.position.x += (entry.targetX - entry.mesh.position.x) * 0.5;
    entry.mesh.position.z += (entry.targetZ - entry.mesh.position.z) * 0.5;
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
      p.mesh.material.dispose();
      activeParticles.splice(i, 1);
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
  }

  emitMoveIntent();
  updateAimIntersection();

  renderer.render(scene, camera);
}
animate();

window.addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
