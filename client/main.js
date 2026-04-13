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
const EMOTE_ANIM_DURATION_MS = 1000;

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
// Auto-detect server URL based on current location
const SERVER_URL = window.location.origin;
const LERP_FACTOR = 0.25;              // Increased for smoother interpolation at 20 TPS network rate
const PROJ_LERP = 0.4;                 // Faster lerp for projectiles
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

// ── Client-Side Class Data (mirrors server CLASS_DEFS + CLASS_SKILLS) ──────
const CLIENT_CLASS_DATA = {
  warrior: {
    name: 'Warrior', emoji: '⚔️', role: 'Melee Tank', color: '#e74c3c', shape: 'cube',
    stats: { hp: 160, damage: 22, speed: 0.85, cooldown: 550, attackType: 'melee', damageMultiplier: 1.0 },
    ultimate: { name: 'Earthquake', emoji: '🌋', description: 'Slams the ground, stunning all enemies in a massive area.' },
    skills: [
      { name: 'Fortified Body', emoji: '🛡️', description: 'Reinforced constitution increases max HP.', stat: '+15 HP' },
      { name: 'Widening Cleave', emoji: '🪓', description: 'Broadens melee arc for wider strikes.', stat: '+15° Arc' },
      { name: 'Ground Slam', emoji: '💥', description: 'Attacks briefly stun nearby enemies.', stat: '+0.1s Stun' },
      { name: 'War Cry', emoji: '📣', description: 'Battle fury amplifies all damage dealt.', stat: '+8% Dmg' },
      { name: 'Berserker Rage', emoji: '🔥', description: 'Below 40% HP, gain bonus attack speed.', stat: '+15% AS' },
      { name: 'Titan Grip', emoji: '✊', description: 'Extends weapon reach for longer strikes.', stat: '+0.5 Range' },
      { name: 'Shield Wall', emoji: '🏰', description: 'Hardened armor reduces incoming damage.', stat: '-5% Dmg Taken' },
    ],
  },
  archer: {
    name: 'Archer', emoji: '🏹', role: 'Fast Ranged', color: '#3498db', shape: 'pyramid',
    stats: { hp: 85, damage: 12, speed: 1.2, cooldown: 280, attackType: 'ranged', damageMultiplier: 1.0 },
    ultimate: { name: 'Piercing Laser', emoji: '⚡', description: 'Fires a devastating laser that pierces through all enemies in a line.' },
    skills: [
      { name: 'Multi Shot', emoji: '🏹', description: 'Fire additional arrows in a spread pattern.', stat: '+1 Arrow' },
      { name: 'Rapid Fire', emoji: '⚡', description: 'Decreases delay between arrow volleys.', stat: '-25ms CD' },
      { name: 'Long Range', emoji: '🎯', description: 'Arrows travel further before fading.', stat: '+20% Range' },
      { name: 'Poison Arrow', emoji: '☠️', description: 'Arrows apply damage over time on hit.', stat: '+2 DPS' },
      { name: 'Evasion', emoji: '💨', description: 'Nimble footwork grants movement speed.', stat: '+4% Speed' },
      { name: 'Headshot', emoji: '🦅', description: 'Precise aim increases base arrow damage.', stat: '+3 Dmg' },
      { name: 'Piercing Arrow', emoji: '🔱', description: 'Arrows pass through enemies on hit.', stat: '+1 Pierce' },
    ],
  },
  mage: {
    name: 'Mage', emoji: '🔮', role: 'Heavy Ranged', color: '#9b59b6', shape: 'icosahedron',
    stats: { hp: 90, damage: 18, speed: 0.9, cooldown: 750, attackType: 'ranged', damageMultiplier: 1.4 },
    ultimate: { name: 'Black Hole', emoji: '🕳️', description: 'Creates a singularity that pulls all nearby enemies inward.' },
    skills: [
      { name: 'Arcane Blast', emoji: '✨', description: 'Amplified arcane energy increases damage.', stat: '+3 Dmg' },
      { name: 'Spell Speed', emoji: '⚡', description: 'Faster incantations reduce cast delay.', stat: '-30ms CD' },
      { name: 'Singularity', emoji: '🕳️', description: 'Black hole ultimate grows in radius.', stat: '+10% Radius' },
      { name: 'Chain Lightning', emoji: '⛓️', description: 'Spells damage nearby enemies on impact.', stat: '+0.5 Splash' },
      { name: 'Mana Shield', emoji: '🔮', description: 'Arcane barrier increases max health.', stat: '+12 HP' },
      { name: 'Spell Penetration', emoji: '🌌', description: 'Spells bypass enemy resistances.', stat: '+8% Dmg' },
      { name: 'Comet Trail', emoji: '☄️', description: 'Projectiles leave damaging zones behind.', stat: '+0.2s Trail' },
    ],
  },
  priest: {
    name: 'Priest', emoji: '✨', role: 'Ranged Support', color: '#f1c40f', shape: 'torus',
    stats: { hp: 110, damage: 10, speed: 1.05, cooldown: 400, attackType: 'ranged', damageMultiplier: 0.6 },
    ultimate: { name: 'AoE Burst Heal', emoji: '🙏', description: 'Releases a massive wave of healing energy to all nearby allies.' },
    skills: [
      { name: 'Healing Aura', emoji: '💚', description: 'Passively heal nearby allies over time.', stat: '+2 HP/s' },
      { name: 'Blessed Speed', emoji: '🕊️', description: 'Divine wind quickens your movement.', stat: '+4% Speed' },
      { name: 'Holy Shield', emoji: '🛡️', description: 'Sacred protection raises max health.', stat: '+15 HP' },
      { name: 'Divine Smite', emoji: '⚔️', description: 'Holy wrath increases base damage.', stat: '+2 Dmg' },
      { name: 'Purify', emoji: '✝️', description: 'Reduces duration of debuffs on self.', stat: '-15% Debuff' },
      { name: 'Renewing Orbs', emoji: '🌟', description: 'Healing orbs restore ally health on pass.', stat: '+3 Heal' },
      { name: 'Sanctified Ground', emoji: '🙏', description: 'Ultimate burst heal is more powerful.', stat: '+10 Heal' },
    ],
  },
  assassin: {
    name: 'Assassin', emoji: '🗡️', role: 'Melee Flanker', color: '#bdc3c7', shape: 'octahedron',
    stats: { hp: 75, damage: 20, speed: 1.35, cooldown: 300, attackType: 'melee', damageMultiplier: 1.3 },
    ultimate: { name: 'Shadow Strike', emoji: '🌑', description: 'Teleports behind the nearest enemy with a burst of speed.' },
    skills: [
      { name: 'Shadow Blade', emoji: '🗡️', description: 'Shadow-forged steel hits harder.', stat: '+3 Dmg' },
      { name: 'Swift Strike', emoji: '⚡', description: 'Faster blade work reduces attack delay.', stat: '-20ms CD' },
      { name: 'Cloak Mastery', emoji: '🌑', description: 'Stealth lasts longer after activation.', stat: '+1s Stealth' },
      { name: 'Backstab', emoji: '🔪', description: 'Attacks from behind deal bonus damage.', stat: '+15% Back' },
      { name: 'Smoke Bomb', emoji: '🌫️', description: 'Ultimate creates a larger smoke zone.', stat: '+0.5 Radius' },
      { name: 'Deadly Poison', emoji: '☠️', description: 'Blade strikes apply damage over time.', stat: '+2 DPS' },
      { name: 'Phantom Step', emoji: '👤', description: 'Spectral agility boosts move speed.', stat: '+5% Speed' },
    ],
  },
  summoner: {
    name: 'Summoner', emoji: '👁️', role: 'Ranged Pet Master', color: '#2ecc71', shape: 'hexagon',
    stats: { hp: 95, damage: 11, speed: 1.0, cooldown: 2000, attackType: 'summon', damageMultiplier: 0.8 },
    ultimate: { name: 'Elite Summons', emoji: '👑', description: 'Summons 2 powerful elite units — one melee tank, one ranged attacker.' },
    skills: [
      { name: 'Strong Minions', emoji: '🐺', description: 'Summoned units gain bonus health.', stat: '+8 HP' },
      { name: 'Pack Rush', emoji: '💨', description: 'Minions move faster in pursuit.', stat: '+10% Speed' },
      { name: 'Feral Claws', emoji: '🦷', description: 'Summoned units deal more damage.', stat: '+3 Dmg' },
      { name: 'Horde Master', emoji: '👑', description: 'Increases maximum active summons.', stat: '+1 Max' },
      { name: 'Thick Hide', emoji: '🛡️', description: 'Minions take reduced damage.', stat: '-10% Dmg' },
      { name: 'Elite Upgrade', emoji: '⭐', description: 'Elite summons gain bonus health.', stat: '+15 HP' },
      { name: 'Soul Link', emoji: '🔗', description: 'Heal when your summons deal damage.', stat: '+3 Heal' },
    ],
  },
  chaos: {
    name: 'Chaos Witch', emoji: '🌀', role: 'Ranged Disruptor', color: '#bb6bd9', shape: 'dodecahedron',
    stats: { hp: 90, damage: 14, speed: 1.0, cooldown: 500, attackType: 'ranged', damageMultiplier: 1.1 },
    ultimate: { name: 'Area Distortion', emoji: '🌀', description: 'Warps reality in a zone, reversing all enemy controls.' },
    skills: [
      { name: 'Hex Power', emoji: '🔮', description: 'Chaotic energy amplifies base damage.', stat: '+3 Dmg' },
      { name: 'Mind Warp', emoji: '🧠', description: 'Confuse effect lasts longer on enemies.', stat: '+0.3s Confuse' },
      { name: 'Chaos Speed', emoji: '⚡', description: 'Erratic energy boosts movement speed.', stat: '+4% Speed' },
      { name: 'Entropic Shield', emoji: '🌀', description: 'Chaotic barrier increases max health.', stat: '+12 HP' },
      { name: 'Curse Amplify', emoji: '💜', description: 'Dark curses amplify all damage dealt.', stat: '+8% Dmg' },
      { name: 'Chaotic Surge', emoji: '🌊', description: 'Unstable power reduces attack delay.', stat: '-25ms CD' },
      { name: 'Void Rift', emoji: '🌑', description: 'Ultimate distortion field grows larger.', stat: '+12% Radius' },
    ],
  },
  engineer: {
    name: 'Engineer', emoji: '⚙️', role: 'Ranged Zone Control', color: '#f39c12', shape: 'cylinder',
    stats: { hp: 110, damage: 13, speed: 0.9, cooldown: 380, attackType: 'ranged', damageMultiplier: 1.0 },
    ultimate: { name: 'Deploy Turret', emoji: '🔫', description: 'Deploys an auto-targeting turret that fires at nearby enemies.' },
    skills: [
      { name: 'Extended Mines', emoji: '⏱️', description: 'Mines persist longer on the field.', stat: '+3s Life' },
      { name: 'Explosive Charge', emoji: '💣', description: 'Mines detonate with greater force.', stat: '+5 Dmg' },
      { name: 'Turret Upgrade', emoji: '🔫', description: 'Turret projectiles hit harder.', stat: '+3 Dmg' },
      { name: 'Fortified Turret', emoji: '🏗️', description: 'Turret stays deployed longer.', stat: '+2s Life' },
      { name: 'Rapid Turret', emoji: '⚙️', description: 'Turret fires rounds more frequently.', stat: '-10% CD' },
      { name: 'Mine Field', emoji: '💥', description: 'Place additional mines simultaneously.', stat: '+1 Mine' },
      { name: 'Armor Plating', emoji: '🧱', description: 'Extra plating increases max health.', stat: '+12 HP' },
    ],
  },
  paladin: {
    name: 'Paladin', emoji: '🛡️', role: 'Melee Guardian', color: '#1abc9c', shape: 'torusknot',
    stats: { hp: 140, damage: 19, speed: 0.9, cooldown: 500, attackType: 'melee', damageMultiplier: 0.9 },
    ultimate: { name: 'Divine Shield', emoji: '✨', description: 'Grants invulnerability to yourself and nearby allies for a short duration.' },
    skills: [
      { name: 'Holy Strike', emoji: '⚔️', description: 'Divine power increases base damage.', stat: '+3 Dmg' },
      { name: 'Divine Health', emoji: '💛', description: 'Blessed vitality raises max health.', stat: '+15 HP' },
      { name: 'Shield of Faith', emoji: '🛡️', description: 'Holy ward reduces incoming damage.', stat: '-5% Dmg Taken' },
      { name: 'Crusader Speed', emoji: '🏃', description: 'Blessed stride quickens movement.', stat: '+3% Speed' },
      { name: 'Consecration', emoji: '☀️', description: 'Attacks deal splash damage around target.', stat: '+2 Splash' },
      { name: 'Holy Retribution', emoji: '⚡', description: 'Righteous fury amplifies damage.', stat: '+7% Dmg' },
      { name: 'Blessing of Light', emoji: '✨', description: 'Ultimate divine shield lasts longer.', stat: '+0.5s Shield' },
    ],
  },
  necromancer: {
    name: 'Necromancer', emoji: '💀', role: 'Ranged Drainer', color: '#27ae60', shape: 'capsule',
    stats: { hp: 80, damage: 16, speed: 0.95, cooldown: 650, attackType: 'ranged', damageMultiplier: 1.3 },
    ultimate: { name: 'Soul Drain', emoji: '💥', description: 'Unleashes a soul explosion that drains life from all enemies in range.' },
    skills: [
      { name: 'Soul Drain', emoji: '💚', description: 'Attacks steal life from enemies.', stat: '+2 Lifesteal' },
      { name: 'Curse of Decay', emoji: '☠️', description: 'Projectiles apply damage over time.', stat: '+2 DPS' },
      { name: 'Dark Power', emoji: '💀', description: 'Necrotic energy increases base damage.', stat: '+3 Dmg' },
      { name: 'Undead Resilience', emoji: '🦴', description: 'Unholy constitution raises max health.', stat: '+12 HP' },
      { name: 'Death Haste', emoji: '👻', description: 'Spectral speed boosts movement.', stat: '+4% Speed' },
      { name: 'Wither Touch', emoji: '🖤', description: 'Withering curse amplifies all damage.', stat: '+8% Dmg' },
      { name: 'Soul Explosion', emoji: '💥', description: 'Ultimate soul drain grows in radius.', stat: '+10% Radius' },
    ],
  },
};

// ── VibejJam Portal System ──────────────────────────────────────────────────
function parseUrlParams() {
  const params = new URLSearchParams(window.location.search);
  return {
    portal: params.get('portal') === 'true',
    username: params.get('username') || null,
    classType: params.get('classType') || null,
    color: params.get('color') || null,
    speed: params.get('speed') ? parseFloat(params.get('speed')) : null,
    ref: params.get('ref') || null,
  };
}

let portalParams = parseUrlParams();
const PORTAL_EXIT_URL = 'https://vibejam.cc/portal/2026';
let startPortalGroup = null, startPortalBox = null, startPortalParticles = null;
let exitPortalGroup = null, exitPortalBox = null, exitPortalParticles = null;
let portalsReady = false;

// ── Socket.io ───────────────────────────────────────────────────────────────
const socket = io(SERVER_URL, {
  transports: ['websocket'],           // Skip polling, connect via WebSocket immediately
  upgrade: false,                      // Don't try to upgrade from polling
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
});
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

// ── Portal System ───────────────────────────────────────────────────────────
function buildPortalExitUrl() {
  const params = new URLSearchParams();
  params.set('portal', 'true');
  params.set('username', lobbyInput?.value || localStorage.getItem('arena_username') || 'Player');
  params.set('color', 'white');
  params.set('speed', '5');
  params.set('ref', window.location.origin);
  // Forward any existing params
  const current = new URLSearchParams(window.location.search);
  for (const [k, v] of current) {
    if (!params.has(k)) params.set(k, v);
  }
  return PORTAL_EXIT_URL + '?' + params.toString();
}

function buildReturnUrl() {
  const refUrl = portalParams.ref;
  if (!refUrl) return null;
  let url = refUrl;
  if (!url.startsWith('http://') && !url.startsWith('https://')) url = 'https://' + url;
  // Forward all current params except ref
  const current = new URLSearchParams(window.location.search);
  const newParams = new URLSearchParams();
  for (const [k, v] of current) {
    if (k !== 'ref') newParams.set(k, v);
  }
  const s = newParams.toString();
  return url + (s ? '?' + s : '');
}

function createPortal(color, position, labelText) {
  const group = new THREE.Group();
  group.position.copy(position);

  // Torus ring
  const torusGeo = new THREE.TorusGeometry(5, 0.6, 16, 64);
  const torusMat = new THREE.MeshPhongMaterial({
    color: color,
    emissive: color,
    emissiveIntensity: 0.8,
    transparent: true,
    opacity: 0.85,
  });
  group.add(new THREE.Mesh(torusGeo, torusMat));

  // Inner disc
  const discGeo = new THREE.CircleGeometry(4.2, 32);
  const discMat = new THREE.MeshBasicMaterial({
    color: color,
    transparent: true,
    opacity: 0.35,
    side: THREE.DoubleSide,
  });
  group.add(new THREE.Mesh(discGeo, discMat));

  // Label
  const canvas = document.createElement('canvas');
  canvas.width = 512; canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#' + new THREE.Color(color).getHexString();
  ctx.font = 'bold 36px Arial';
  ctx.textAlign = 'center';
  ctx.fillText(labelText, 256, 44);
  const tex = new THREE.CanvasTexture(canvas);
  const labelGeo = new THREE.PlaneGeometry(10, 1.5);
  const labelMat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide });
  const labelMesh = new THREE.Mesh(labelGeo, labelMat);
  labelMesh.position.y = 7;
  group.add(labelMesh);

  // Particles
  const pCount = 300;
  const pGeo = new THREE.BufferGeometry();
  const positions = new Float32Array(pCount * 3);
  const colors = new Float32Array(pCount * 3);
  const baseColor = new THREE.Color(color);
  for (let i = 0; i < pCount * 3; i += 3) {
    const angle = Math.random() * Math.PI * 2;
    const radius = 5 + (Math.random() - 0.5) * 2;
    positions[i] = Math.cos(angle) * radius;
    positions[i + 1] = Math.sin(angle) * radius;
    positions[i + 2] = (Math.random() - 0.5) * 2;
    colors[i] = baseColor.r * (0.8 + Math.random() * 0.2);
    colors[i + 1] = baseColor.g * (0.8 + Math.random() * 0.2);
    colors[i + 2] = baseColor.b * (0.8 + Math.random() * 0.2);
  }
  pGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  pGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const pMat = new THREE.PointsMaterial({ size: 0.3, vertexColors: true, transparent: true, opacity: 0.6 });
  const particleSystem = new THREE.Points(pGeo, pMat);
  group.add(particleSystem);

  scene.add(group);
  const box = new THREE.Box3().setFromObject(group);
  return { group, box, particleSystem };
}

function initPortals() {
  // Exit portal - always created (green), placed near map edge
  const exitPos = new THREE.Vector3(0, 6, -185);
  const exit = createPortal(0x00ff00, exitPos, 'VIBE JAM PORTAL');
  exitPortalGroup = exit.group;
  exitPortalBox = exit.box;
  exitPortalParticles = exit.particleSystem;

  // Start portal - only if player arrived via ?portal=true (red)
  if (portalParams.portal && portalParams.ref) {
    const startPos = new THREE.Vector3(0, 6, 0); // At spawn point
    const start = createPortal(0xff0000, startPos, 'RETURN PORTAL');
    startPortalGroup = start.group;
    startPortalBox = start.box;
    startPortalParticles = start.particleSystem;
  }

  portalsReady = true;
  console.log('[Portal] Portals initialized');
}

function animatePortals() {
  if (!portalsReady) return;
  const t = Date.now() * 0.001;

  // Animate exit portal particles
  if (exitPortalParticles) {
    const pos = exitPortalParticles.geometry.attributes.position.array;
    for (let i = 0; i < pos.length; i += 3) {
      pos[i + 1] += 0.04 * Math.sin(t + i);
    }
    exitPortalParticles.geometry.attributes.position.needsUpdate = true;
    exitPortalGroup.rotation.y += 0.003;
  }

  // Animate start portal particles
  if (startPortalParticles) {
    const pos = startPortalParticles.geometry.attributes.position.array;
    for (let i = 0; i < pos.length; i += 3) {
      pos[i + 1] += 0.04 * Math.sin(t + i);
    }
    startPortalParticles.geometry.attributes.position.needsUpdate = true;
    startPortalGroup.rotation.y += 0.003;
  }

  // Check player collision with portals
  const localEntry = myId ? playerMeshes[myId] : null;
  if (!localEntry) return;
  const playerPos = localEntry.mesh.position;

  // Exit portal collision
  if (exitPortalGroup) {
    const dist = playerPos.distanceTo(exitPortalGroup.position);
    if (dist < 6) {
      window.location.href = buildPortalExitUrl();
    }
  }

  // Start portal collision (return to previous game)
  if (startPortalGroup && portalParams.ref) {
    const dist = playerPos.distanceTo(startPortalGroup.position);
    if (dist < 6) {
      const returnUrl = buildReturnUrl();
      if (returnUrl) window.location.href = returnUrl;
    }
  }
}

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

  // Shared accent materials
  const metalMat = new THREE.MeshToonMaterial({ color: 0x888899, emissive: 0x333344, emissiveIntensity: 0.15 });
  const brownMat = new THREE.MeshToonMaterial({ color: 0x6b4226, emissive: 0x3a2010, emissiveIntensity: 0.1 });
  const whiteMat = new THREE.MeshToonMaterial({ color: 0xeeeeee, emissive: 0xaaaaaa, emissiveIntensity: 0.15 });

  switch (type) {
    // ── WARRIOR (cube) — Greatsword + Viking Helmet ──
    case 'cube': {
      bodyMesh = new THREE.Mesh(geoCache.cube, bodyMat);
      // Shoulder armor pads
      const padGeo = new THREE.BoxGeometry(0.35, 0.15, 0.35);
      for (const offset of [[0.5, 0.35, 0.5], [-0.5, 0.35, 0.5], [0.5, 0.35, -0.5], [-0.5, 0.35, -0.5]]) {
        const pad = new THREE.Mesh(padGeo, darkMat);
        pad.position.set(...offset);
        group.add(pad);
      }
      // Viking helmet (flat top + two horns)
      const helmet = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.5, 0.25, 8), metalMat);
      helmet.position.set(0, 0.62, 0);
      group.add(helmet);
      const hornGeo = new THREE.ConeGeometry(0.07, 0.35, 6);
      for (const side of [-1, 1]) {
        const horn = new THREE.Mesh(hornGeo, whiteMat);
        horn.position.set(side * 0.38, 0.75, 0);
        horn.rotation.z = side * -0.5;
        group.add(horn);
      }
      // Greatsword (blade + handle) — held on right side
      const blade = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.1, 0.03), metalMat);
      blade.position.set(0.65, 0.15, 0);
      group.add(blade);
      const swordTip = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.2, 4), metalMat);
      swordTip.position.set(0.65, 0.75, 0);
      group.add(swordTip);
      const hilt = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.25, 0.03), brownMat);
      hilt.position.set(0.65, -0.42, 0);
      group.add(hilt);
      const guard = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.06, 0.06), metalMat);
      guard.position.set(0.65, -0.28, 0);
      group.add(guard);
      break;
    }

    // ── ARCHER (pyramid) — Bow + Hood ──
    case 'pyramid': {
      bodyMesh = new THREE.Mesh(new THREE.TetrahedronGeometry(0.7, 0), bodyMat);
      // Eye
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.14, 10, 10), glowMat);
      eye.position.set(0, 0, 0.55);
      group.add(eye);
      // Hood (cone on top)
      const hood = new THREE.Mesh(new THREE.ConeGeometry(0.35, 0.4, 6), darkMat);
      hood.position.set(0, 0.65, 0);
      group.add(hood);
      // Bow — curved arc on left side using a torus segment
      const bowMat = new THREE.MeshToonMaterial({ color: 0x8B5A2B, emissive: 0x4a2a10, emissiveIntensity: 0.15 });
      const bowArc = new THREE.Mesh(new THREE.TorusGeometry(0.45, 0.035, 6, 12, Math.PI), bowMat);
      bowArc.position.set(-0.6, 0, 0);
      bowArc.rotation.y = Math.PI / 2;
      bowArc.rotation.z = Math.PI / 2;
      group.add(bowArc);
      // Bow string
      const stringGeo = new THREE.CylinderGeometry(0.008, 0.008, 0.9, 4);
      const stringMat = new THREE.MeshToonMaterial({ color: 0xccccaa, emissive: 0x888866, emissiveIntensity: 0.2 });
      const bowString = new THREE.Mesh(stringGeo, stringMat);
      bowString.position.set(-0.6, 0, 0);
      group.add(bowString);
      // Quiver on back (small cylinder)
      const quiver = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 0.5, 6), brownMat);
      quiver.position.set(0.15, 0.1, -0.5);
      quiver.rotation.x = 0.2;
      group.add(quiver);
      // Arrow tips sticking out of quiver
      for (let i = 0; i < 3; i++) {
        const arrowTip = new THREE.Mesh(new THREE.ConeGeometry(0.03, 0.12, 4), metalMat);
        arrowTip.position.set(0.15 + (i - 1) * 0.04, 0.42, -0.5);
        group.add(arrowTip);
      }
      break;
    }

    // ── MAGE (icosahedron) — Staff + Wizard Hat ──
    case 'icosahedron': {
      bodyMesh = new THREE.Mesh(geoCache.icosahedron, bodyMat);
      // Arcane rings
      const ringA = new THREE.Mesh(new THREE.RingGeometry(0.9, 1.05, 32), new THREE.MeshToonMaterial({ color: 0x9b59b6, emissive: 0x9b59b6, emissiveIntensity: 0.4, side: THREE.DoubleSide }));
      ringA.rotation.x = Math.PI / 2;
      ringA.position.y = 0.1;
      const ringB = new THREE.Mesh(new THREE.RingGeometry(1.25, 1.4, 32), new THREE.MeshToonMaterial({ color: 0xa29bfe, emissive: 0xa29bfe, emissiveIntensity: 0.35, side: THREE.DoubleSide }));
      ringB.rotation.y = Math.PI / 2;
      ringB.position.y = 0.05;
      group.add(ringA, ringB);
      bodyMesh.userData.magicRings = [ringA, ringB];
      // Wizard hat (cone + brim)
      const hatMat = new THREE.MeshToonMaterial({ color: 0x2c1654, emissive: 0x1a0a3a, emissiveIntensity: 0.15 });
      const hat = new THREE.Mesh(new THREE.ConeGeometry(0.32, 0.65, 8), hatMat);
      hat.position.set(0, 0.95, 0);
      hat.rotation.z = 0.15; // slightly tilted
      group.add(hat);
      const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.05, 12), hatMat);
      brim.position.set(0, 0.62, 0);
      group.add(brim);
      // Staff — on right side
      const staffPole = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.04, 1.6, 6), brownMat);
      staffPole.position.set(0.7, 0.1, 0);
      group.add(staffPole);
      // Crystal orb on top of staff
      const crystal = new THREE.Mesh(new THREE.OctahedronGeometry(0.14, 0), new THREE.MeshToonMaterial({ color: 0xaa55ff, emissive: 0xaa55ff, emissiveIntensity: 0.7 }));
      crystal.position.set(0.7, 0.95, 0);
      group.add(crystal);
      break;
    }

    // ── PRIEST (torus) — Holy Scepter + Halo Crown ──
    case 'torus': {
      bodyMesh = new THREE.Mesh(geoCache.torus, bodyMat);
      // Pulse orb
      const orb = new THREE.Mesh(new THREE.SphereGeometry(0.18, 12, 12), glowMat);
      orb.position.set(0, 0, 0);
      group.add(orb);
      bodyMesh.userData.pulseOrb = orb;
      // Halo above head
      const haloMat = new THREE.MeshToonMaterial({ color: 0xffd700, emissive: 0xffd700, emissiveIntensity: 0.6, side: THREE.DoubleSide });
      const halo = new THREE.Mesh(new THREE.RingGeometry(0.35, 0.42, 24), haloMat);
      halo.rotation.x = Math.PI / 2;
      halo.position.y = 0.7;
      group.add(halo);
      // Holy scepter — golden rod with orb
      const scepterPole = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.035, 1.0, 6), new THREE.MeshToonMaterial({ color: 0xdaa520, emissive: 0xaa8800, emissiveIntensity: 0.2 }));
      scepterPole.position.set(0.55, -0.05, 0);
      group.add(scepterPole);
      const scepterOrb = new THREE.Mesh(new THREE.SphereGeometry(0.1, 8, 8), glowMat);
      scepterOrb.position.set(0.55, 0.5, 0);
      group.add(scepterOrb);
      // White cloth drape (flat box representing robes)
      const robe = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.12, 0.7), whiteMat);
      robe.position.set(0, -0.35, 0);
      group.add(robe);
      break;
    }

    // ── ASSASSIN (octahedron) — Dual Daggers + Mask ──
    case 'octahedron': {
      bodyMesh = new THREE.Mesh(geoCache.octahedron, bodyMat);
      // Face mask (dark half-sphere in front)
      const mask = new THREE.Mesh(new THREE.SphereGeometry(0.3, 8, 6, 0, Math.PI), darkMat);
      mask.position.set(0, 0.15, 0.45);
      group.add(mask);
      // Scarf tails (two thin boxes trailing behind)
      const scarfMat = new THREE.MeshToonMaterial({ color: 0x222222, emissive: 0x111111, emissiveIntensity: 0.1 });
      for (const xOff of [-0.08, 0.08]) {
        const scarf = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.04, 0.5), scarfMat);
        scarf.position.set(xOff, 0.25, -0.7);
        scarf.rotation.x = -0.2;
        group.add(scarf);
      }
      // Dual daggers — two short blades on each side
      const daggerBlade = new THREE.BoxGeometry(0.04, 0.5, 0.02);
      const daggerHandle = new THREE.BoxGeometry(0.03, 0.15, 0.03);
      for (const side of [-1, 1]) {
        const blade = new THREE.Mesh(daggerBlade, metalMat);
        blade.position.set(side * 0.55, 0.05, 0.15);
        blade.rotation.z = side * 0.15;
        group.add(blade);
        const handle = new THREE.Mesh(daggerHandle, brownMat);
        handle.position.set(side * 0.55, -0.28, 0.15);
        handle.rotation.z = side * 0.15;
        group.add(handle);
      }
      break;
    }

    // ── SUMMONER (hexagon) — Spirit Lantern + Horned Crown ──
    case 'hexagon': {
      bodyMesh = new THREE.Mesh(geoCache.hexagon, bodyMat);
      // Orbiting spirit orbs
      for (let i = 0; i < 3; i++) {
        const spiritOrb = new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 8), glowMat);
        const angle = (Math.PI * 2 * i) / 3;
        spiritOrb.position.set(Math.cos(angle) * 0.55, 0.12, Math.sin(angle) * 0.55);
        group.add(spiritOrb);
      }
      // Horned crown
      const crownMat = new THREE.MeshToonMaterial({ color: 0x2a5a3a, emissive: 0x1a3a2a, emissiveIntensity: 0.2 });
      const crownBase = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.38, 0.12, 6), crownMat);
      crownBase.position.set(0, 0.56, 0);
      group.add(crownBase);
      for (let i = 0; i < 3; i++) {
        const a = (Math.PI * 2 * i) / 3;
        const crownSpike = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.22, 4), crownMat);
        crownSpike.position.set(Math.cos(a) * 0.28, 0.72, Math.sin(a) * 0.28);
        group.add(crownSpike);
      }
      // Spirit lantern — hanging off left side (small cage + flame)
      const lanternCage = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 0.18, 6, 1, true), darkMat);
      lanternCage.position.set(-0.6, 0.1, 0);
      group.add(lanternCage);
      const lanternFlame = new THREE.Mesh(new THREE.SphereGeometry(0.06, 6, 6), new THREE.MeshToonMaterial({ color: 0x44ffaa, emissive: 0x44ffaa, emissiveIntensity: 0.9 }));
      lanternFlame.position.set(-0.6, 0.1, 0);
      group.add(lanternFlame);
      const lanternPole = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.9, 4), brownMat);
      lanternPole.position.set(-0.6, -0.2, 0);
      group.add(lanternPole);
      break;
    }

    // ── CHAOS WITCH (dodecahedron) — Chaos Orb Staff + Witch Hat ──
    case 'dodecahedron': {
      bodyMesh = new THREE.Mesh(geoCache.dodecahedron, bodyMat);
      // Chaos spikes
      const spikeGeo = new THREE.ConeGeometry(0.08, 0.3, 6);
      for (const angle of [0, Math.PI / 2, Math.PI, Math.PI * 1.5]) {
        const spike = new THREE.Mesh(spikeGeo, glowMat);
        spike.position.set(Math.cos(angle) * 0.55, 0, Math.sin(angle) * 0.55);
        spike.rotation.x = Math.PI / 2;
        spike.rotation.z = angle;
        group.add(spike);
      }
      // Witch hat (tall crooked cone + brim)
      const witchHatMat = new THREE.MeshToonMaterial({ color: 0x2a1040, emissive: 0x1a0830, emissiveIntensity: 0.15 });
      const witchHat = new THREE.Mesh(new THREE.ConeGeometry(0.28, 0.7, 8), witchHatMat);
      witchHat.position.set(0, 0.9, 0);
      witchHat.rotation.z = 0.25; // crooked
      witchHat.rotation.x = -0.1;
      group.add(witchHat);
      const witchBrim = new THREE.Mesh(new THREE.CylinderGeometry(0.48, 0.48, 0.04, 12), witchHatMat);
      witchBrim.position.set(0, 0.58, 0);
      group.add(witchBrim);
      // Chaos orb staff — swirling orb on a twisted staff
      const chaosStaff = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.04, 1.3, 6), new THREE.MeshToonMaterial({ color: 0x3d1e5e, emissive: 0x2a1040, emissiveIntensity: 0.2 }));
      chaosStaff.position.set(0.65, 0, 0);
      group.add(chaosStaff);
      const chaosOrb = new THREE.Mesh(new THREE.DodecahedronGeometry(0.13, 0), new THREE.MeshToonMaterial({ color: 0xff44ff, emissive: 0xff44ff, emissiveIntensity: 0.7 }));
      chaosOrb.position.set(0.65, 0.7, 0);
      group.add(chaosOrb);
      break;
    }

    // ── ENGINEER (cylinder) — Wrench + Goggles ──
    case 'cylinder': {
      bodyMesh = new THREE.Mesh(geoCache.cylinder, bodyMat);
      // Armor plates
      const boxGeo = new THREE.BoxGeometry(0.2, 0.2, 0.2);
      for (const offset of [[0.45, 0.15, 0], [-0.45, 0.15, 0], [0, 0.15, 0.45], [0, 0.15, -0.45]]) {
        const box = new THREE.Mesh(boxGeo, darkMat);
        box.position.set(...offset);
        group.add(box);
      }
      const core = new THREE.Mesh(new THREE.SphereGeometry(0.15, 10, 10), glowMat);
      core.position.set(0, 0.15, 0);
      group.add(core);
      // Goggles (two small torus on face)
      const goggleMat = new THREE.MeshToonMaterial({ color: 0x444444, emissive: 0x222222, emissiveIntensity: 0.1 });
      const lensMat = new THREE.MeshToonMaterial({ color: 0x66ccff, emissive: 0x3388cc, emissiveIntensity: 0.4 });
      for (const side of [-1, 1]) {
        const goggleRim = new THREE.Mesh(new THREE.TorusGeometry(0.1, 0.025, 6, 12), goggleMat);
        goggleRim.position.set(side * 0.18, 0.25, 0.5);
        group.add(goggleRim);
        const lens = new THREE.Mesh(new THREE.CircleGeometry(0.09, 8), lensMat);
        lens.position.set(side * 0.18, 0.25, 0.52);
        group.add(lens);
      }
      const goggleStrap = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.06, 0.03), goggleMat);
      goggleStrap.position.set(0, 0.25, 0.49);
      group.add(goggleStrap);
      // Large wrench — held on right side
      const wrenchShaft = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.9, 6), metalMat);
      wrenchShaft.position.set(0.6, -0.05, 0);
      group.add(wrenchShaft);
      // Wrench head (open-ended, two prongs)
      for (const off of [-0.08, 0.08]) {
        const prong = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.2, 0.05), metalMat);
        prong.position.set(0.6 + off, 0.48, 0);
        group.add(prong);
      }
      break;
    }

    // ── PALADIN (torusknot) — Shield + Warhammer + Halo ──
    case 'torusknot': {
      bodyMesh = new THREE.Mesh(geoCache.torusknot, bodyMat);
      // Holy halo
      const halo = new THREE.Mesh(new THREE.RingGeometry(0.55, 0.7, 32), new THREE.MeshToonMaterial({ color: 0x1abc9c, emissive: 0x1abc9c, emissiveIntensity: 0.6, side: THREE.DoubleSide }));
      halo.rotation.x = Math.PI / 2;
      halo.position.y = 0.75;
      group.add(halo);
      // Shield on left side (rounded rectangle approximated with cylinder slice)
      const shieldMat = new THREE.MeshToonMaterial({ color: 0x2288aa, emissive: 0x115566, emissiveIntensity: 0.15 });
      const shield = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.3, 0.06, 6), shieldMat);
      shield.position.set(-0.65, 0, 0.05);
      shield.rotation.z = Math.PI / 2;
      group.add(shield);
      // Shield cross emblem
      const crossMat = new THREE.MeshToonMaterial({ color: 0xffd700, emissive: 0xccaa00, emissiveIntensity: 0.3 });
      const crossV = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.25, 0.02), crossMat);
      crossV.position.set(-0.65, 0, 0.09);
      group.add(crossV);
      const crossH = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.15, 0.02), crossMat);
      crossH.position.set(-0.65, 0.03, 0.09);
      crossH.rotation.z = Math.PI / 2;
      group.add(crossH);
      // Warhammer on right side
      const hammerShaft = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.035, 1.1, 6), brownMat);
      hammerShaft.position.set(0.6, 0, 0);
      group.add(hammerShaft);
      const hammerHead = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.18, 0.18), metalMat);
      hammerHead.position.set(0.6, 0.55, 0);
      group.add(hammerHead);
      break;
    }

    // ── NECROMANCER (capsule) — Scythe + Bone Crown + Skulls ──
    case 'capsule': {
      bodyMesh = new THREE.Mesh(geoCache.capsule, bodyMat);
      // Orbiting skulls
      const skullMat = new THREE.MeshToonMaterial({ color: 0x2d2d2d, emissive: 0x27ae60, emissiveIntensity: 0.3 });
      for (let i = 0; i < 2; i++) {
        const skull = new THREE.Mesh(new THREE.SphereGeometry(0.14, 8, 8), skullMat);
        const angle = Math.PI * i;
        skull.position.set(Math.cos(angle) * 0.6, 0.2, Math.sin(angle) * 0.6);
        group.add(skull);
      }
      // Bone crown (small spikes on top)
      const boneMat = new THREE.MeshToonMaterial({ color: 0xd4c9a8, emissive: 0x887755, emissiveIntensity: 0.1 });
      for (let i = 0; i < 5; i++) {
        const a = (Math.PI * 2 * i) / 5;
        const boneSpike = new THREE.Mesh(new THREE.ConeGeometry(0.04, 0.2, 4), boneMat);
        boneSpike.position.set(Math.cos(a) * 0.25, 0.65, Math.sin(a) * 0.25);
        group.add(boneSpike);
      }
      // Scythe — long curved weapon on right side
      // Shaft
      const scytheShaft = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.03, 1.5, 6), brownMat);
      scytheShaft.position.set(0.55, 0.1, 0);
      group.add(scytheShaft);
      // Blade (curved — use a torus segment)
      const scytheBladeMat = new THREE.MeshToonMaterial({ color: 0x556655, emissive: 0x27ae60, emissiveIntensity: 0.25 });
      const scytheBlade = new THREE.Mesh(new THREE.TorusGeometry(0.25, 0.02, 4, 12, Math.PI * 0.7), scytheBladeMat);
      scytheBlade.position.set(0.55, 0.85, 0.15);
      scytheBlade.rotation.y = Math.PI / 2;
      scytheBlade.rotation.x = -0.3;
      group.add(scytheBlade);
      // Blade tip (sharp end)
      const scytheTip = new THREE.Mesh(new THREE.ConeGeometry(0.04, 0.15, 4), scytheBladeMat);
      scytheTip.position.set(0.55, 0.75, 0.38);
      scytheTip.rotation.x = Math.PI / 2;
      group.add(scytheTip);
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
    emoteAnim: null,
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

function triggerEmoteAnimation(playerId, emoteId) {
  const entry = playerMeshes[playerId];
  if (!entry) return;
  entry.emoteAnim = {
    emoteId: String(emoteId || ''),
    startedAt: performance.now(),
    durationMs: EMOTE_ANIM_DURATION_MS,
  };
}

function getEmoteMotion(entry, nowMs) {
  if (!entry || !entry.emoteAnim) return null;
  const { emoteId, startedAt, durationMs } = entry.emoteAnim;
  const progress = (nowMs - startedAt) / Math.max(1, durationMs);
  if (progress >= 1) {
    entry.emoteAnim = null;
    return null;
  }

  const t = Math.max(0, Math.min(1, progress));
  const pulse = Math.sin(t * Math.PI);

  if (emoteId === '1') {
    return {
      y: Math.abs(Math.sin(t * Math.PI * 5)) * 0.22,
      yaw: 0,
      pitch: 0.04 * pulse,
      roll: Math.sin(t * Math.PI * 6) * 0.08 * (1 - t),
    };
  }

  if (emoteId === '2') {
    return {
      y: Math.abs(Math.sin(t * Math.PI * 8)) * 0.12,
      yaw: Math.sin(t * Math.PI * 20) * 0.09 * (1 - t),
      pitch: -0.06 * pulse,
      roll: 0,
    };
  }

  return {
    y: 0.10 + Math.abs(Math.sin(t * Math.PI * 6)) * 0.18,
    yaw: Math.sin(t * Math.PI * 10) * 0.18,
    pitch: 0,
    roll: 0.05 * Math.sin(t * Math.PI * 12),
  };
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

// ── Shared Projectile Geometries (allocated once) ──────────────────────────
const projGeoDefault = new THREE.SphereGeometry(0.3, 8, 8);
// Archer
const projGeoArrowShaft = new THREE.CylinderGeometry(0.06, 0.06, 1.0, 6);
const projGeoArrowHead = new THREE.ConeGeometry(0.18, 0.35, 6);
// Mage
const projGeoBoltCore = new THREE.IcosahedronGeometry(0.45, 1);
const projGeoBoltShell = new THREE.IcosahedronGeometry(0.6, 0);
// Priest
const projGeoOrbCore = new THREE.SphereGeometry(0.4, 12, 12);
const projGeoOrbRing = new THREE.RingGeometry(0.5, 0.65, 16);
// Summoner
const projGeoHomingCore = new THREE.SphereGeometry(0.35, 8, 8);
const projGeoHomingFin = new THREE.ConeGeometry(0.12, 0.5, 4);
// Chaos
const projGeoHexOuter = new THREE.OctahedronGeometry(0.4, 0);
const projGeoHexInner = new THREE.OctahedronGeometry(0.22, 0);
// Necromancer
const projGeoCurseOuter = new THREE.TetrahedronGeometry(0.45, 0);
const projGeoCurseInner = new THREE.TetrahedronGeometry(0.45, 0);

// ── Shared Accent Materials (reused across all projectiles) ────────────────
const projAccentWhiteMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
const projGreenGlowMat = new THREE.MeshBasicMaterial({
  color: 0x00ff44, transparent: true, opacity: 0.5,
  blending: THREE.AdditiveBlending
});

// Engineer mine geometry
const projGeoMineBody = new THREE.CylinderGeometry(0.4, 0.45, 0.2, 8);
const projGeoMineSpike = new THREE.ConeGeometry(0.08, 0.25, 4);

function createProjMesh(id, data) {
  if (data.visible === false) return;
  const kind = data.kind || 'normal';
  const color = data.ownerColor || '#74b9ff';
  const ownerClass = data.ownerClass || '';
  const c = new THREE.Color(color);
  const group = new THREE.Group();
  group.position.set(data.x, 0.5, data.z);
  const entry = { mesh: group, targetX: data.x, targetZ: data.z, kind, ownerClass };

  if (ownerClass === 'archer') {
    // Elongated arrow: shaft + white tip, pre-rotated so arrow points along local +Z
    const shaftMat = new THREE.MeshToonMaterial({ color: c, emissive: c, emissiveIntensity: 0.5 });
    const shaft = new THREE.Mesh(projGeoArrowShaft, shaftMat);
    shaft.rotation.x = Math.PI / 2; // lay cylinder from Y-axis to Z-axis
    const head = new THREE.Mesh(projGeoArrowHead, projAccentWhiteMat);
    head.rotation.x = Math.PI / 2; // cone tip points along +Z
    head.position.z = 0.65;
    group.add(shaft, head);
  } else if (ownerClass === 'mage') {
    // Double-shell arcane bolt
    const innerMat = new THREE.MeshBasicMaterial({ color: c });
    const inner = new THREE.Mesh(projGeoBoltCore, innerMat);
    const shellMat = new THREE.MeshBasicMaterial({
      color: c, transparent: true, opacity: 0.3,
      blending: THREE.AdditiveBlending
    });
    const shell = new THREE.Mesh(projGeoBoltShell, shellMat);
    group.add(inner, shell);
    entry.inner = inner;
    entry.shell = shell;
  } else if (ownerClass === 'priest') {
    // Healing orb with halo ring
    const coreMat = new THREE.MeshToonMaterial({ color: c, emissive: c, emissiveIntensity: 0.9 });
    const core = new THREE.Mesh(projGeoOrbCore, coreMat);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.5,
      side: THREE.DoubleSide
    });
    const ring = new THREE.Mesh(projGeoOrbRing, ringMat);
    ring.rotation.x = Math.PI / 2;
    group.add(core, ring);
    entry.ring = ring;
  } else if (ownerClass === 'necromancer') {
    // Merkaba: interlocking tetrahedra with green glow
    const outerMat = new THREE.MeshToonMaterial({ color: c, emissive: c, emissiveIntensity: 0.7 });
    const outer = new THREE.Mesh(projGeoCurseOuter, outerMat);
    const inner = new THREE.Mesh(projGeoCurseInner, projGreenGlowMat);
    inner.rotation.x = Math.PI; // inverted
    group.add(outer, inner);
    entry.inner = inner;
  } else if (ownerClass === 'chaos') {
    // Nested counter-rotating octahedra
    const outerMat = new THREE.MeshBasicMaterial({
      color: c, transparent: true, opacity: 0.45,
      side: THREE.DoubleSide
    });
    const outer = new THREE.Mesh(projGeoHexOuter, outerMat);
    const innerMat = new THREE.MeshToonMaterial({ color: c, emissive: c, emissiveIntensity: 1.0 });
    const inner = new THREE.Mesh(projGeoHexInner, innerMat);
    group.add(outer, inner);
    entry.inner = inner;
    entry.shell = outer;
  } else if (kind === 'summoner_homing') {
    // Homing tracker with 4 fins
    const coreMat = new THREE.MeshToonMaterial({ color: c, emissive: c, emissiveIntensity: 0.85 });
    const core = new THREE.Mesh(projGeoHomingCore, coreMat);
    group.add(core);
    const finMat = new THREE.MeshToonMaterial({ color: 0x222222, emissive: c, emissiveIntensity: 0.3 });
    for (let i = 0; i < 4; i++) {
      const angle = (Math.PI / 2) * i;
      const fin = new THREE.Mesh(projGeoHomingFin, finMat);
      fin.position.set(Math.cos(angle) * 0.3, 0, Math.sin(angle) * 0.3);
      fin.rotation.x = Math.PI;
      fin.rotation.y = angle;
      group.add(fin);
    }
  } else if (kind === 'mine') {
    // Engineer mine: flat disc with spikes, sits on the ground
    group.position.y = 0.12;
    const bodyMat = new THREE.MeshToonMaterial({ color: c, emissive: c, emissiveIntensity: 0.6 });
    const body = new THREE.Mesh(projGeoMineBody, bodyMat);
    group.add(body);
    const spikeMat = new THREE.MeshBasicMaterial({ color: 0xff4444 });
    for (let i = 0; i < 6; i++) {
      const angle = (Math.PI / 3) * i;
      const spike = new THREE.Mesh(projGeoMineSpike, spikeMat);
      spike.position.set(Math.cos(angle) * 0.32, 0.15, Math.sin(angle) * 0.32);
      group.add(spike);
    }
  } else {
    // Default / turret_shot: simple larger sphere
    const mat = new THREE.MeshToonMaterial({ color: c, emissive: c, emissiveIntensity: 1.0 });
    group.add(new THREE.Mesh(projGeoDefault, mat));
  }

  scene.add(group);
  projMeshes[id] = entry;
}
function removeProjMesh(id) {
  const entry = projMeshes[id];
  if (!entry) return;
  entry.mesh.traverse(obj => { if (obj.isMesh && obj.material !== projAccentWhiteMat && obj.material !== projGreenGlowMat) obj.material.dispose(); });
  scene.remove(entry.mesh);
  delete projMeshes[id];
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
function spawnSwingArc(x, z, aimRotY, color) {
  const mat = getSwingMat(color);
  const mesh = new THREE.Mesh(swingGeo, mat.clone());
  mesh.position.set(x, 0.5, z);
  mesh.rotation.x = -Math.PI / 2;
  // aimRotY points away from target (has +PI), so subtract PI to face toward target,
  // then subtract PI/4 to center the 90° arc on the aim direction
  mesh.rotation.z = aimRotY - Math.PI - Math.PI / 4;
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
const pingCounter = document.getElementById('ping-counter');
let fpsFrames = 0, fpsLastTime = performance.now();
let currentPing = 0;

// ── Ping Measurement ──
// Use socket.io volatile emit for ping-pong measurement
let pingStartTime = 0;
setInterval(() => {
  if (!inGame) return;
  pingStartTime = performance.now();
  socket.volatile.emit('ping_check');
}, 2000); // Measure every 2 seconds

socket.on('pong_check', () => {
  currentPing = Math.round(performance.now() - pingStartTime);
  if (pingCounter) {
    pingCounter.textContent = currentPing + ' ms';
    // Color code: green < 50ms, yellow < 100ms, red > 100ms
    if (currentPing < 50) pingCounter.style.color = '#4ade80';
    else if (currentPing < 100) pingCounter.style.color = '#fbbf24';
    else pingCounter.style.color = '#f87171';
  }
});
const helpButton = document.getElementById('help-button');
const howToModal = document.getElementById('howto-modal');
const howToClose = document.getElementById('howto-close');
const skillCardOverlay = document.getElementById('skill-card-overlay');
const skillCardWrap = document.getElementById('skill-card-wrap');

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
const EMOTES = { '1': '\u{1F600}', '2': '\u{1F621}', '3': '\u{1F525}' };
const EMOTE_BY_KEY_CODE = { Digit1: '1', Digit2: '2', Digit3: '3' };
let isTyping = false;
const activeSocials = [];
let ultCooldown = 15000;
let lastUltTime = 0;
const ultimateVFX = [];
const bhParticles = [];
let isHowToOpen = false;
let isSkillCardOpen = false;
let currentSkillOptions = [];

function focusChatInput() {
  if (!chatInput) return;
  chatInput.classList.add('active');
  isTyping = true;

  const applyFocus = () => {
    if (!chatInput.classList.contains('active')) return;
    chatInput.focus();
    const caret = chatInput.value.length;
    try {
      chatInput.setSelectionRange(caret, caret);
    } catch (_) {
      // Ignore selection errors on unsupported browsers/input states.
    }
  };

  // Immediate attempt + deferred retries for browsers that ignore focus while visibility toggles.
  applyFocus();
  requestAnimationFrame(applyFocus);
  setTimeout(applyFocus, 0);
  setTimeout(applyFocus, 60);
  setTimeout(applyFocus, 140);
}

function hideChatInput() {
  if (!chatInput) return;
  isTyping = false;
  chatInput.classList.remove('active');
  chatInput.blur();
}

function releaseChatFocusToGame() {
  if (!chatInput || !chatInput.classList.contains('active')) return;
  isTyping = false;
  chatInput.blur();
}

function setHowToOpen(open) {
  if (open && isSkillCardOpen) return;
  isHowToOpen = !!open;
  if (howToModal) howToModal.style.display = isHowToOpen ? 'block' : 'none';
  if (isHowToOpen) {
    if (chatInput && chatInput.classList.contains('active')) {
      hideChatInput();
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

const CLASS_COLORS = {
  warrior: '#ff4444', archer: '#44cc44', mage: '#8844ff', priest: '#ffcc44',
  assassin: '#cc44cc', summoner: '#44ccaa', chaos: '#ff6600', engineer: '#ffaa22',
  paladin: '#44aaff', necromancer: '#00cc66',
};

function renderSkillCards(choices, classType) {
  currentSkillOptions = [];
  if (!skillCardWrap) return;
  skillCardWrap.innerHTML = '';
  if (!Array.isArray(choices)) choices = [];
  const accent = CLASS_COLORS[classType] || '#7fa7ff';

  for (let i = 0; i < choices.length; i++) {
    const choice = choices[i];
    if (!choice) continue;
    currentSkillOptions[i] = String(choice.id || '');
    const currentLevel = Number(choice.currentLevel) || 0;
    const maxLevel = Math.max(1, Number(choice.maxLevel) || 5);
    const nextLevel = Math.min(maxLevel, currentLevel + 1);

    // Build pips HTML
    let pipsHTML = '';
    for (let p = 1; p <= maxLevel; p++) {
      if (p <= currentLevel) pipsHTML += '<span class="pip filled"></span>';
      else if (p === nextLevel) pipsHTML += '<span class="pip next"></span>';
      else pipsHTML += '<span class="pip"></span>';
    }

    const card = document.createElement('button');
    card.className = 'skill-card';
    card.style.setProperty('--accent', accent);
    card.innerHTML = `
      <div class="skill-card-header">
        <span class="skill-card-hotkey">[${i + 1}]</span>
        <span class="skill-card-rarity">${currentLevel > 0 ? 'UPGRADE' : 'NEW ABILITY'}</span>
      </div>
      <div class="skill-card-body">
        <div class="skill-card-icon">${choice.emoji || '✨'}</div>
        <div class="skill-card-name">${choice.name || 'Unknown Skill'}</div>
        <div class="skill-card-pips">${pipsHTML}</div>
        <div class="skill-card-desc">${choice.description || ''}</div>
        <div class="skill-card-stat">${choice.stat || `Lv ${currentLevel} → ${nextLevel}`}</div>
      </div>
    `;

    card.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      submitSkillChoiceByIndex(i);
    });

    skillCardWrap.appendChild(card);
  }
}

function clearSkillChoicesUI() {
  currentSkillOptions = [];
  if (skillCardWrap) skillCardWrap.innerHTML = '';
  setSkillCardOpen(false);
}

function submitSkillChoiceByIndex(index) {
  if (index < 0 || index >= currentSkillOptions.length) return false;
  const skillId = currentSkillOptions[index];
  if (!skillId) return false;
  socket.emit('selectSkill', skillId);
  clearSkillChoicesUI();
  return true;
}

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

socket.on('skillChoices', (data) => {
  if (!inGame) return;
  const choices = data && data.choices ? data.choices : [];
  const classType = data && data.classType ? data.classType : '';
  renderSkillCards(choices, classType);
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
  if (!payload || !payload.type || !socialContainer) return;

  const el = document.createElement('div');
  el.className = 'social-bubble';

  let lifetimeMs = 3700;
  let headOffset = 1.2;
  if (payload.type === 'chat') {
    el.classList.add('social-chat');
    el.textContent = payload.text;
  } else if (payload.type === 'emote') {
    el.classList.add('social-emote');
    el.textContent = EMOTES[payload.emoteId] || '\u{1F4AC}';
    lifetimeMs = 1800;
    headOffset = 0.95;
    triggerEmoteAnimation(payload.playerId, payload.emoteId);
  } else {
    return;
  }

  socialContainer.appendChild(el);
  const entry = { element: el, playerId: payload.playerId, createdAt: Date.now(), headOffset };
  activeSocials.push(entry);

  const fadeDelay = Math.max(0, lifetimeMs - 300);
  setTimeout(() => {
    el.style.opacity = '0';
    setTimeout(() => {
      el.remove();
      const idx = activeSocials.indexOf(entry);
      if (idx !== -1) activeSocials.splice(idx, 1);
    }, 300);
  }, fadeDelay);
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

    // ── Portal Return Button ────
    const returnPortalBtn = document.createElement('button');
    returnPortalBtn.textContent = 'VIBE JAM PORTAL';
    returnPortalBtn.style.cssText = `
      margin-top: 20px;
      padding: 12px 32px;
      font-size: 16px;
      font-weight: 700;
      letter-spacing: 0.05em;
      background: linear-gradient(135deg, #00cc44, #00ff66);
      color: #000;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      transition: all 0.3s ease;
    `;
    returnPortalBtn.onmouseover = () => returnPortalBtn.style.transform = 'scale(1.05)';
    returnPortalBtn.onmouseout = () => returnPortalBtn.style.transform = 'scale(1)';
    returnPortalBtn.onclick = () => {
      window.location.href = buildPortalExitUrl();
    };
    endgameScreen.appendChild(returnPortalBtn);

    // Countdown timer
    let secondsLeft = portalParams.portal ? 30 : 15;
    const timerInterval = setInterval(() => {
      secondsLeft--;
      const timerEl = document.getElementById('countdown-timer');
      if (timerEl) timerEl.textContent = secondsLeft;
      if (secondsLeft <= 0) {
        clearInterval(timerInterval);
        if (portalParams.portal) {
          window.location.href = buildPortalExitUrl();
        }
      }
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

    // Only update nametag once (avoid DOM writes every frame)
    if (nametags[id] && nametags[id].textContent !== data.username) {
      nametags[id].textContent = data.username;
    }

    const body = entry.bodyMesh;
    if (data.isInvincible) {
      body.material.emissiveIntensity = 1.0;
      body.material.emissive.setHex(0xf1c40f);
    } else if (data.isStunned) {
      body.material.emissiveIntensity = 0.8;
      body.material.emissive.setHex(0x9b59b6);
    } else {
      const tC = TEAM_COLORS[data.team];
      body.material.emissiveIntensity = 0.2;
      if (tC) body.material.emissive.copy(tC);
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
    if (!proj || proj.visible === false) {
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
        // Store velocity for client-side prediction between server updates
        projMeshes[id].vx = proj.vx || 0;
        projMeshes[id].vz = proj.vz || 0;
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

// Pre-allocate reusable vectors to avoid GC pressure
const _moveForward = new THREE.Vector3();
const _moveRight = new THREE.Vector3();
const _moveInputVec = new THREE.Vector3();
const _moveUpVec = new THREE.Vector3(0, 1, 0);
let _lastSentDirX = 0, _lastSentDirZ = 0;
let _moveThrottleTimer = 0;
const MOVE_SEND_INTERVAL = 50; // Send movement max 20x/sec (every 50ms)

function emitMoveIntent() {
  if (!inGame) return;

  // 1. Get the camera's actual looking direction (reuse vector)
  camera.getWorldDirection(_moveForward);
  _moveForward.y = 0;
  _moveForward.normalize();

  // 2. Calculate the perpendicular Right vector (reuse vector)
  _moveRight.crossVectors(_moveForward, _moveUpVec).normalize();

  // 3. Determine raw input (-1, 0, or 1)
  let moveForward = 0;
  let moveRight = 0;
  if (keys.w) moveForward += 1;
  if (keys.s) moveForward -= 1;
  if (keys.d) moveRight += 1;
  if (keys.a) moveRight -= 1;

  // 4. Combine vectors based on input (reuse vector)
  _moveInputVec.set(0, 0, 0);
  _moveInputVec.addScaledVector(_moveForward, moveForward);
  _moveInputVec.addScaledVector(_moveRight, moveRight);

  if (_moveInputVec.lengthSq() > 0) {
    _moveInputVec.normalize();
  }

  const dirX = _moveInputVec.x;
  const dirZ = _moveInputVec.z;

  // 5. Only send if direction actually changed OR throttle timer expired
  const now = performance.now();
  const dirChanged = Math.abs(dirX - _lastSentDirX) > 0.01 || Math.abs(dirZ - _lastSentDirZ) > 0.01;

  if (dirChanged || (now - _moveThrottleTimer > MOVE_SEND_INTERVAL && (dirX !== 0 || dirZ !== 0))) {
    socket.emit('moveIntent', { dirX, dirZ });
    _lastSentDirX = dirX;
    _lastSentDirZ = dirZ;
    _moveThrottleTimer = now;
  }
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
    const chatIsVisible = chatInput.classList.contains('active');
    if (!chatIsVisible) {
      focusChatInput();
      for (const k in keys) keys[k] = false;
      emitMoveIntent();
    } else if (!isTyping) {
      focusChatInput();
    } else {
      const text = chatInput.value.trim();
      if (text) socket.emit('sendChat', text);
      chatInput.value = '';
      hideChatInput();
    }
    e.preventDefault();
    return;
  }

  if (isTyping) return;

  const shiftEmoteId = e.shiftKey ? EMOTE_BY_KEY_CODE[e.code] : null;
  if (shiftEmoteId) {
      socket.emit('sendEmote', shiftEmoteId);
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
    // Snap rotation to aim direction immediately on attack
    const atkDx = intersection.x - entry.mesh.position.x;
    const atkDz = intersection.z - entry.mesh.position.z;
    if (atkDx * atkDx + atkDz * atkDz > 0.0001) {
      const aimRot = Math.atan2(atkDx, atkDz) + Math.PI;
      entry.targetRotY = aimRot;
      entry.mesh.rotation.y = aimRot;
    }
    if (entry.mixer) {
      entry.isAttacking = true;
      entry.attackTimer = ATTACK_ANIM_DURATION;
      fadeToAction(entry, 'Attack', 0.1);
    }
    // Melee swing visual for close-range classes
    if (MELEE_CLASSES.has(entry.currentType)) {
      const m = entry.mesh;
      const color = entry.team === 'red' ? '#ff4444' : '#4488ff';
      // Use aim direction directly instead of lerped mesh rotation
      const aimDx = intersection.x - m.position.x;
      const aimDz = intersection.z - m.position.z;
      const aimRotY = Math.atan2(aimDx, aimDz) + Math.PI;
      spawnSwingArc(m.position.x, m.position.z, aimRotY, color);
    }
  }
}

window.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  const target = e.target;
  const clickedInput = target && (target.tagName === 'INPUT' || (target.closest && target.closest('#chat-input')));
  if (inGame && isTyping && !isHowToOpen && !clickedInput) {
    // Leave typing mode but keep the chat box visible so user can refocus it.
    releaseChatFocusToGame();
  }
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

if (chatInput) {
  chatInput.addEventListener('focus', () => {
    if (inGame && chatInput.classList.contains('active')) {
      isTyping = true;
    }
  });

  chatInput.addEventListener('blur', () => {
    if (chatInput.classList.contains('active')) {
      isTyping = false;
    }
  });
}

// ── Lobby / Game Over ───────────────────────────────────────────────────────
const lobbyEl = document.getElementById('lobby');
const lobbyInput = document.getElementById('lobby-username');
const hudStats = document.getElementById('hud-stats');
const hudBasesEl = document.getElementById('hud-bases');
const minimapCont = document.getElementById('minimap-container');
const crosshair = document.getElementById('crosshair');

// ── 3D Preview System ──────────────────────────────────────────────────────
const previewCanvas = document.getElementById('preview-canvas');
let previewRenderer = null;
let previewScene = null;
let previewCamera = null;
let previewGroup = null;
let previewAnimationId = null;

function initPreviewRenderer() {
  if (previewRenderer) return;
  previewRenderer = new THREE.WebGLRenderer({ canvas: previewCanvas, antialias: true, alpha: true });
  previewRenderer.setSize(170, 170);
  previewRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  previewRenderer.setClearColor(0x000000, 0);

  previewScene = new THREE.Scene();
  previewScene.add(new THREE.AmbientLight(0xffffff, 0.7));
  const dirLight = new THREE.DirectionalLight(0xffffff, 1.8);
  dirLight.position.set(3, 5, 4);
  previewScene.add(dirLight);
  const rimLight = new THREE.DirectionalLight(0x4488ff, 0.6);
  rimLight.position.set(-3, 2, -3);
  previewScene.add(rimLight);

  previewCamera = new THREE.PerspectiveCamera(36, 1, 0.1, 100);
  previewCamera.position.set(0, 1.2, 3.8);
  previewCamera.lookAt(0, 0.2, 0);
}

function disposePreviewGroup() {
  if (!previewGroup) return;
  previewGroup.traverse((child) => {
    if (child.isMesh) {
      if (child.material && !child.material._shared) child.material.dispose();
    }
  });
  previewScene.remove(previewGroup);
  previewGroup = null;
}

function showClassPreview(classKey) {
  initPreviewRenderer();
  disposePreviewGroup();
  const data = CLIENT_CLASS_DATA[classKey];
  if (!data) return;
  const threeColor = new THREE.Color(data.color);
  const { group } = createCharacterGroup(data.shape, threeColor);
  group.scale.setScalar(1.4);
  previewGroup = group;
  previewScene.add(previewGroup);
  startPreviewLoop();
}

function startPreviewLoop() {
  if (previewAnimationId) return;
  function animate() {
    previewAnimationId = requestAnimationFrame(animate);
    if (previewGroup) {
      previewGroup.rotation.y += 0.012;
      previewGroup.position.y = Math.sin(Date.now() * 0.002) * 0.08;
    }
    if (previewRenderer && previewScene && previewCamera) {
      previewRenderer.render(previewScene, previewCamera);
    }
  }
  animate();
}

function stopPreviewLoop() {
  if (previewAnimationId) {
    cancelAnimationFrame(previewAnimationId);
    previewAnimationId = null;
  }
}

// ── Lobby UI Population ─────────────────────────────────────────────────────
const detailPanel = document.getElementById('class-detail');
const detailName = document.getElementById('detail-class-name');
const detailRole = document.getElementById('detail-class-role');
const detailAttackType = document.getElementById('detail-attack-type');
const detailStats = document.getElementById('detail-stats');
const detailAbilities = document.getElementById('detail-abilities');
const detailUltimate = document.getElementById('detail-ultimate');
const enterArenaBtn = document.getElementById('enter-arena-btn');

// Max values for stat bar normalization
const STAT_MAX = { hp: 160, damage: 22, speed: 1.35, cooldown: 750 };

function populateStats(stats, color) {
  if (!detailStats) return;
  const rows = [
    { label: 'HP', value: stats.hp, max: STAT_MAX.hp, display: stats.hp },
    { label: 'DMG', value: stats.damage * stats.damageMultiplier, max: STAT_MAX.damage * 1.4, display: Math.round(stats.damage * stats.damageMultiplier * 10) / 10 },
    { label: 'SPEED', value: stats.speed, max: STAT_MAX.speed, display: (stats.speed * 100).toFixed(0) + '%' },
    { label: 'RATE', value: (STAT_MAX.cooldown - stats.cooldown + 280), max: STAT_MAX.cooldown, display: stats.cooldown + 'ms' },
  ];
  detailStats.innerHTML = rows.map(r => {
    const pct = Math.min(100, Math.max(5, (r.value / r.max) * 100));
    return `<div class="stat-row">
      <span class="stat-label">${r.label}</span>
      <div class="stat-track"><div class="stat-fill" style="width:${pct}%;background:${color}"></div></div>
      <span class="stat-value">${r.display}</span>
    </div>`;
  }).join('');
}

function populateAbilities(skills, color) {
  if (!detailAbilities) return;
  detailAbilities.innerHTML = skills.map(s => `
    <div class="ability-card">
      <div class="ability-emoji">${s.emoji}</div>
      <div class="ability-name">${s.name}</div>
      <div class="ability-desc">${s.description}</div>
      <span class="ability-stat">${s.stat}</span>
    </div>
  `).join('');
}

function populateUltimate(ult, color) {
  if (!detailUltimate) return;
  detailUltimate.style.animation = 'none';
  detailUltimate.offsetHeight; // trigger reflow
  detailUltimate.style.animation = '';
  detailUltimate.innerHTML = `
    <div class="ult-emoji">${ult.emoji}</div>
    <div class="ult-name">${ult.name}</div>
    <div class="ult-desc">${ult.description}</div>
  `;
}

// ── Character Selection ─────────────────────────────────────────────────────
const allPickTiles = document.querySelectorAll('.pick-tile');

function selectCharacter(classType, tileEl) {
  selectedCharacter = classType;
  localStorage.setItem('arena_character', classType);

  allPickTiles.forEach(t => t.classList.remove('selected'));
  if (tileEl) tileEl.classList.add('selected');

  const data = CLIENT_CLASS_DATA[classType];
  if (!data || !detailPanel) return;

  // Show detail panel
  detailPanel.classList.add('visible');
  detailPanel.style.setProperty('--class-color', data.color);

  // Populate info
  if (detailName) detailName.textContent = data.name;
  if (detailRole) {
    detailRole.textContent = data.role;
    detailRole.style.color = data.color;
  }
  const atkIcons = { melee: '⚔️ MELEE', ranged: '🏹 RANGED', summon: '👁️ SUMMON' };
  if (detailAttackType) detailAttackType.textContent = atkIcons[data.stats.attackType] || data.stats.attackType;

  populateStats(data.stats, data.color);
  populateAbilities(data.skills, data.color);
  populateUltimate(data.ultimate, data.color);
  showClassPreview(classType);

  if (enterArenaBtn) {
    enterArenaBtn.disabled = false;
    enterArenaBtn.textContent = 'ENTER ARENA';
  }
}

// Delegated click on picker grid
const pickerGrid = document.querySelector('.picker-grid');
if (pickerGrid) {
  pickerGrid.addEventListener('click', (e) => {
    const tile = e.target.closest('.pick-tile');
    if (!tile) return;
    const classType = tile.dataset.class;
    if (classType) selectCharacter(classType, tile);
  });
}

function joinGame(classType, username = null) {
  // Use provided username or get from input
  let val = username || (lobbyInput ? lobbyInput.value.trim() : '');

  if (!val) {
    if (lobbyInput) {
      lobbyInput.style.borderColor = '#e74c3c';
      lobbyInput.focus();
    }
    return;
  }

  stopPreviewLoop();
  disposePreviewGroup();
  clearSkillChoicesUI();

  if (lobbyInput) {
    localStorage.setItem('arena_username', val);
  }

  // Initialize portal system when entering game
  initPortals();

  socket.emit('joinGame', { classType, username: val });
  lobbyEl.classList.add('hidden');
  hudStats.classList.add('visible'); hudBasesEl.classList.add('visible');
  minimapCont.classList.add('visible'); crosshair.classList.add('visible');
  if (hudUltimate) hudUltimate.classList.add('visible');
  fpsCounter.classList.add('visible');
  if (pingCounter) pingCounter.classList.add('visible');
  inGame = true;
  inLobby = false;
  lastUltTime = Date.now();
  for (const k in keys) keys[k] = false;
  emitMoveIntent();
}

if (enterArenaBtn) {
  enterArenaBtn.addEventListener('click', () => {
    if (selectedCharacter) joinGame(selectedCharacter);
  });
}

// Save username on input
if (lobbyInput) {
  lobbyInput.addEventListener('input', () => {
    localStorage.setItem('arena_username', lobbyInput.value);
  });
}

// ── Load localStorage Preferences ──────────────────────────────────────────
(function loadSavedPreferences() {
  // ── Handle VibejJam Portal Mode ──
  // When ?portal=true, instantly load into game (no lobby screen)
  if (portalParams.portal) {
    const classKeys = Object.keys(CLIENT_CLASS_DATA);
    const classType = portalParams.classType && CLIENT_CLASS_DATA[portalParams.classType]
      ? portalParams.classType
      : classKeys[Math.floor(Math.random() * classKeys.length)];
    const username = portalParams.username || 'Traveler';
    console.log('[Portal] Skipping lobby, joining as', classType, username);
    setTimeout(() => {
      selectCharacter(classType);
      joinGame(classType, username);
    }, 100);
    return;
  }

  const savedUsername = localStorage.getItem('arena_username');
  if (savedUsername && lobbyInput) lobbyInput.value = savedUsername;

  const savedCharacter = localStorage.getItem('arena_character');
  if (savedCharacter) {
    const tileEl = document.querySelector(`.pick-tile[data-class="${savedCharacter}"]`);
    if (tileEl) selectCharacter(savedCharacter, tileEl);
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
  const nowMs = performance.now();

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
    // Local player gets faster interpolation for more responsive feel
    const isLocal = (id === myId);
    const lerpSpeed = isLocal ? 0.4 : LERP_FACTOR;
    mesh.position.lerp(targetPos, lerpSpeed);
    mesh.scale.x += (targetScale - mesh.scale.x) * LERP_FACTOR;
    mesh.scale.y += (targetScale - mesh.scale.y) * LERP_FACTOR;
    mesh.scale.z += (targetScale - mesh.scale.z) * LERP_FACTOR;
    mesh.rotation.y = lerpAngle(mesh.rotation.y, targetRotY || 0, isLocal ? 0.35 : LERP_FACTOR);
    mesh.rotation.x = 0;
    mesh.rotation.z = 0;

    const emoteMotion = getEmoteMotion(entry, nowMs);
    if (emoteMotion) {
      mesh.position.y += emoteMotion.y;
      mesh.rotation.y += emoteMotion.yaw;
      mesh.rotation.x += emoteMotion.pitch;
      mesh.rotation.z += emoteMotion.roll;
    }

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
      _projVec.y += (entry.targetScale * 1.5) + (soc.headOffset || 1.2);
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
    // Client-side prediction: extrapolate position using velocity between server ticks
    if (entry.vx !== undefined && entry.vz !== undefined && (entry.vx !== 0 || entry.vz !== 0)) {
      entry.targetX += entry.vx * delta;
      entry.targetZ += entry.vz * delta;
    }
    entry.mesh.position.x += (entry.targetX - entry.mesh.position.x) * PROJ_LERP;
    entry.mesh.position.z += (entry.targetZ - entry.mesh.position.z) * PROJ_LERP;
    // Per-class projectile animations
    if (entry.ownerClass === 'archer') {
      // Arrow points in direction of travel (group's +Z faces forward)
      const dx = entry.targetX - entry.mesh.position.x;
      const dz = entry.targetZ - entry.mesh.position.z;
      if (dx * dx + dz * dz > 0.001) {
        entry.mesh.rotation.y = Math.atan2(dx, dz);
      }
    } else if (entry.ownerClass === 'mage') {
      // Inner core tumbles fast, outer shell counter-rotates slowly
      if (entry.inner) { entry.inner.rotation.x += delta * 8; entry.inner.rotation.y += delta * 12; }
      if (entry.shell) { entry.shell.rotation.y -= delta * 4; entry.shell.rotation.z += delta * 2; }
    } else if (entry.ownerClass === 'chaos') {
      // Outer wobbles erratically, inner counter-rotates
      if (entry.shell) { entry.shell.rotation.x += delta * 5; entry.shell.rotation.y += Math.sin(elapsed * 12) * delta * 10; entry.shell.rotation.z += delta * 7; }
      if (entry.inner) { entry.inner.rotation.x -= delta * 7; entry.inner.rotation.y -= delta * 9; entry.inner.rotation.z += delta * 4; }
      const cs = 1.0 + Math.sin(elapsed * 10) * 0.1;
      entry.mesh.scale.set(cs, cs, cs);
    } else if (entry.ownerClass === 'necromancer') {
      // Slow eerie spin, inner counter-rotates, scale pulses
      entry.mesh.rotation.y += delta * 3;
      entry.mesh.rotation.x = Math.sin(elapsed * 4) * 0.5;
      if (entry.inner) { entry.inner.rotation.y -= delta * 2; }
      const ns = 1.0 + Math.sin(elapsed * 6) * 0.15;
      entry.mesh.scale.set(ns, ns, ns);
    } else if (entry.ownerClass === 'priest') {
      // Halo ring spins, core bobs and pulses
      if (entry.ring) { entry.ring.rotation.z += delta * 5; }
      entry.mesh.position.y = 0.5 + Math.sin(elapsed * 5 + entry.mesh.position.x) * 0.12;
      const ps = 1.0 + Math.sin(elapsed * 3) * 0.08;
      entry.mesh.scale.set(ps, ps, ps);
    } else if (entry.kind === 'summoner_homing') {
      // Whole group spins fast — fins create pinwheel
      entry.mesh.rotation.y += delta * 10;
    } else if (entry.kind === 'mine') {
      // Mine sits on ground, slow spin + pulse
      entry.mesh.rotation.y += delta * 1.5;
      const ms = 1.0 + Math.sin(elapsed * 4) * 0.06;
      entry.mesh.scale.set(ms, ms, ms);
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

  // ── Portal Animation ────
  if (inGame && portalsReady) {
    animatePortals();
  }

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


