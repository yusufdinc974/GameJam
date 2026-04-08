import * as THREE from 'three';
import { io } from 'socket.io-client';

// ── Config ──────────────────────────────────────────────────────────────────
const SERVER_URL = 'http://localhost:3000';
const LERP_FACTOR = 0.15;
const FLOOR_SIZE = 200;
const GRID_DIVISIONS = 200;

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
};

const TEAM_COLORS = {
  red:  new THREE.Color(0xff4444),
  blue: new THREE.Color(0x4488ff),
};

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
    currentType: type, team: data.team,
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
  const color = data.ownerColor || '#74b9ff';
  const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(color), emissive: new THREE.Color(color), emissiveIntensity: 1.0, roughness: 0.1, metalness: 0.9 });
  const mesh = new THREE.Mesh(projGeo, mat);
  mesh.position.set(data.x, 0.5, data.z);
  scene.add(mesh);
  projMeshes[id] = { mesh, targetX: data.x, targetZ: data.z };
}
function removeProjMesh(id) {
  const entry = projMeshes[id];
  if (!entry) return; scene.remove(entry.mesh); entry.mesh.material.dispose(); delete projMeshes[id];
}

// ── Base Entity Management ──────────────────────────────────────────────────
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
    const geo = new THREE.SphereGeometry(20, 16, 16);
    const mat = new THREE.MeshBasicMaterial({ color: 0xf1c40f, wireframe: true, transparent: true, opacity: 0.5 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(originX, 0.5, originZ);
    scene.add(mesh);
    ultimateVFX.push({ mesh, type: 'priest', life: 4.0, maxLife: 4.0, targetId: data.playerId });
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
  const { players: playerData, orbs: orbData, projectiles: projData, bases: baseData } = state;

  const activePlayerIds = new Set(Object.keys(playerData));
  for (const id in playerData) {
    const data = playerData[id];
    if (data.permaDead) { if (playerMeshes[id]) removePlayerMesh(id); continue; }
    if (!playerMeshes[id]) { createPlayerMesh(id, data); }
    else {
      const entry = playerMeshes[id];
      if (entry.currentType !== (data.type || 'cube') || entry.team !== data.team) {
        removePlayerMesh(id); createPlayerMesh(id, data);
      } else if (nametags[id]) {
        nametags[id].textContent = data.username;
      }
      
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
    }
    if (playerMeshes[id]) {
      playerMeshes[id].targetPos.set(data.x, data.y, data.z);
      playerMeshes[id].targetScale = data.scale || 1;
      playerMeshes[id].targetRotY = data.rotY || 0;
    }
  }
  for (const id in playerMeshes) { if (!activePlayerIds.has(id)) removePlayerMesh(id); }

  const activeOrbIds = new Set(Object.keys(orbData));
  for (const id in orbData) { if (!orbMeshes[id]) createOrbMesh(id, orbData[id]); }
  for (const id in orbMeshes) { if (!activeOrbIds.has(id)) removeOrbMesh(id); }

  const activeProjIds = new Set(Object.keys(projData));
  for (const id in projData) {
    if (!projMeshes[id]) createProjMesh(id, projData[id]);
    else { projMeshes[id].targetX = projData[id].x; projMeshes[id].targetZ = projData[id].z; }
  }
  for (const id in projMeshes) { if (!activeProjIds.has(id)) removeProjMesh(id); }

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
    mapCtx.clearRect(0, 0, 200, 200);

    function worldToMap(x, z) { return { cx: (x + 50) * 2, cy: (z + 50) * 2 }; }

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
          if ((p.x-me.x)**2 + (p.z-me.z)**2 > visionRangeSq) continue;
        }

        const { cx, cy } = worldToMap(p.x, p.z);
        mapCtx.beginPath(); mapCtx.arc(cx, cy, isMe ? 4 : 3, 0, Math.PI * 2);
        mapCtx.fillStyle = p.team === 'red' ? '#ff4444' : '#4488ff';
        mapCtx.fill();
        if (isMe) { mapCtx.lineWidth = 1.5; mapCtx.strokeStyle = '#fff'; mapCtx.stroke(); }
      }
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
const input = { up: false, down: false, left: false, right: false };
const KEY_MAP = { KeyW: 'up', ArrowUp: 'up', KeyS: 'down', ArrowDown: 'down', KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right' };

const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
const floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const intersection = new THREE.Vector3();

window.addEventListener('mousemove', (e) => {
  if (!inGame) return;
  mouse.x = (e.clientX / innerWidth) * 2 - 1; mouse.y = -(e.clientY / innerHeight) * 2 + 1;
  raycaster.setFromCamera(mouse, camera);
  raycaster.ray.intersectPlane(floorPlane, intersection);
});

window.addEventListener('keydown', (e) => {
  if (!inGame || e.target.id === 'lobby-username') return;

  if (e.key === 'Enter') {
    if (!isTyping) {
      isTyping = true;
      chatInput.classList.add('active');
      chatInput.focus();
      for (const k in input) input[k] = false;
      socket.emit('move', input);
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

  const dir = KEY_MAP[e.code];
  if (dir && !input[dir]) { input[dir] = true; socket.emit('move', input); }

  if (e.key === '1' && !e.shiftKey) socket.emit('upgradeSkill', 'damage');
  else if (e.key === '2' && !e.shiftKey) socket.emit('upgradeSkill', 'health');
  else if (e.key === '3' && !e.shiftKey) socket.emit('upgradeSkill', 'speed');
});

window.addEventListener('keyup', (e) => {
  if (!inGame || isTyping) return;
  const dir = KEY_MAP[e.code];
  if (dir && input[dir]) { input[dir] = false; socket.emit('move', input); }
});

window.addEventListener('click', (e) => {
  if (!inGame || isTyping || e.target.tagName === 'INPUT' || e.target.closest('#hud-skills')) return;
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
  for (const k in input) input[k] = false; // Reset bounds
}
document.getElementById('btn-warrior').addEventListener('click', () => joinGame('warrior'));
document.getElementById('btn-archer').addEventListener('click',  () => joinGame('archer'));
document.getElementById('btn-mage').addEventListener('click',  () => joinGame('mage'));
document.getElementById('btn-priest').addEventListener('click',  () => joinGame('priest'));

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
const cameraTarget = new THREE.Vector3();
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

  // Process Game Meshes
  for (const id in playerMeshes) {
    const { mesh, targetPos, targetScale } = playerMeshes[id];
    mesh.position.lerp(targetPos, LERP_FACTOR);
    mesh.scale.x += (targetScale - mesh.scale.x) * LERP_FACTOR;
    mesh.scale.y += (targetScale - mesh.scale.y) * LERP_FACTOR;
    mesh.scale.z += (targetScale - mesh.scale.z) * LERP_FACTOR;

    const tag = nametags[id];
    if (tag) {
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
    } else if (vfx.type === 'priest') {
      if (vfx.targetId && playerMeshes[vfx.targetId]) {
         const pmesh = playerMeshes[vfx.targetId].mesh;
         vfx.mesh.position.copy(pmesh.position); 
      }
      vfx.mesh.material.opacity = pct * 0.5;
      vfx.mesh.rotation.y += delta;
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

  // Camera tracking + Screen Shake
  if (myId && playerMeshes[myId]) {
    const myPos = playerMeshes[myId].mesh.position;
    const cameraOffset = new THREE.Vector3(0, 14, 14);
    cameraTarget.copy(myPos).add(cameraOffset);
    camera.position.lerp(cameraTarget, LERP_FACTOR);
    
    if (shakeIntensity > 0.01) {
      camera.position.x += (Math.random() - 0.5) * shakeIntensity;
      camera.position.y += (Math.random() - 0.5) * shakeIntensity;
      camera.position.z += (Math.random() - 0.5) * shakeIntensity;
      shakeIntensity *= shakeDecay;
    }
    
    camera.lookAt(myPos);
  }

  renderer.render(scene, camera);
}
animate();

window.addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
