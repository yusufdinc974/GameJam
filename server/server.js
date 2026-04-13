const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

// Config
const PORT = process.env.PORT || 3000;
const TICK_RATE = 60;
const NET_SEND_RATE = 20;              // Network broadcasts per second (separated from game tick)
const NET_SEND_INTERVAL = Math.round(TICK_RATE / NET_SEND_RATE); // Send every N ticks
let tickCounter = 0;
const PLAYER_SPEED = 12.5;
const PLAYER_COLORS_RED  = ['#ff4444', '#ff6655', '#ee3333', '#ff5544'];
const PLAYER_COLORS_BLUE = ['#4444ff', '#5566ff', '#3333ee', '#4455ff'];

// Ecosystem
const ORB_COUNT = 180;
const MAP_BOUNDARY = 200;
const ORB_COLLECT_RADIUS = 1.2;
const EXP_PER_ORB = 5;
const BASE_EXP_REQUIREMENT = 15;
const SCALE_PER_LEVEL = 0.2;
const KILL_BOUNTY_EXP = 40;
const BOT_BOUNTY_EXP = 10;

// Combat Config
const MELEE_DAMAGE = 20;
const MELEE_RANGE = 3;
const MELEE_ARC = Math.PI / 2;
const MELEE_BASE_DAMAGE = 40;
const RANGED_DAMAGE = 15;
const RANGED_BASE_DAMAGE = 25;
const PROJECTILE_SPEED = 20;
const PROJECTILE_LIFESPAN = 2.0;
const PROJECTILE_RADIUS = 0.6;
const PROJECTILE_WALL_RADIUS = 0.2;
const PLAYER_COLLIDER_HALF_SIZE = 0.55;
const STEALTH_BREAK_DURATION_MS = 2000;
const BOT_COLLIDER_HALF_SIZE = 0.8;
const BOT_COUNT = 18;
const BOT_AGGRO_RANGE = 60;
const BOT_MELEE_RANGE = 3;
const BOT_MELEE_DAMAGE = 12;
const BOT_ATTACK_COOLDOWN_TICKS = 50;
const BOT_RESPAWN_DELAY_MS = 10000;
const SUMMONER_PET_COUNT = 3;
const SUMMONER_FOLLOW_DISTANCE = 6;
const ASSASSIN_TELEPORT_RANGE = 40;
const ASSASSIN_TELEPORT_OFFSET = 2;
const ASSASSIN_SPEED_BUFF_MS = 2000;
const ASSASSIN_SPEED_BUFF_MULT = 1.45;
const CHAOS_CONFUSE_RANGE = 30;
const CHAOS_CONFUSE_DURATION_MS = 4000;
const ENGINEER_MINE_LIFESPAN = 10;
const TURRET_LIFETIME_TICKS = TICK_RATE * 10;
const TURRET_FIRE_COOLDOWN_TICKS = Math.round(TICK_RATE * 0.65);
const TURRET_RANGE = 50;
const TURRET_PROJECTILE_SPEED = PROJECTILE_SPEED * 1.05;
const TURRET_PROJECTILE_DAMAGE = 20;

const BASE_RADIUS = 5;
const BASE_MAX_HEALTH = 2000;

// Environment
const walls = [];
const stealthZones = [];

function initializeMapEnvironment() {
  const wallSeeds = [
    { x: -120, z: -40, width: 16, depth: 34 },
    { x: -80, z: 85, width: 30, depth: 10 },
    { x: -30, z: 145, width: 14, depth: 34 },
    { x: -150, z: 45, width: 10, depth: 42 },
    { x: -95, z: -125, width: 40, depth: 12 },
  ];
  for (const seed of wallSeeds) {
    walls.push({ id: `w${walls.length + 1}`, x: seed.x, z: seed.z, width: seed.width, depth: seed.depth });
    walls.push({ id: `w${walls.length + 1}`, x: -seed.x, z: -seed.z, width: seed.width, depth: seed.depth });
  }

  const stealthSeeds = [
    { x: -135, z: -20, radius: 16 },
    { x: -55, z: 125, radius: 14 },
    { x: -165, z: 105, radius: 12 },
  ];
  for (const seed of stealthSeeds) {
    stealthZones.push({ id: `s${stealthZones.length + 1}`, x: seed.x, z: seed.z, radius: seed.radius });
    stealthZones.push({ id: `s${stealthZones.length + 1}`, x: -seed.x, z: -seed.z, radius: seed.radius });
  }
}
initializeMapEnvironment();

// Class Definitions
// attackType: 'melee' = close-range arc attack, 'ranged' = fires projectile
const CLASS_DEFS = {
  warrior: {
    type: 'cube', maxHealth: 160, currentHealth: 160, maxMana: 50, currentMana: 50,
    speedMultiplier: 0.85, attackCooldown: 550, damageMultiplier: 1.0, baseDamage: 22, attackType: 'melee',
  },
  archer: {
    type: 'pyramid', maxHealth: 85, currentHealth: 85, maxMana: 50, currentMana: 50,
    speedMultiplier: 1.2, attackCooldown: 280, damageMultiplier: 1.0, baseDamage: 12, attackType: 'ranged',
  },
  mage: {
    type: 'icosahedron', maxHealth: 90, currentHealth: 90, maxMana: 50, currentMana: 50,
    speedMultiplier: 0.9, attackCooldown: 750, damageMultiplier: 1.4, baseDamage: 18, attackType: 'ranged',
  },
  priest: {
    type: 'torus', maxHealth: 110, currentHealth: 110, maxMana: 50, currentMana: 50,
    speedMultiplier: 1.05, attackCooldown: 400, damageMultiplier: 0.6, baseDamage: 10, attackType: 'ranged',
  },
  assassin: {
    type: 'octahedron', maxHealth: 75, currentHealth: 75, maxMana: 50, currentMana: 50,
    speedMultiplier: 1.35, attackCooldown: 300, damageMultiplier: 1.3, baseDamage: 20, attackType: 'melee',
  },
  summoner: {
    type: 'hexagon', maxHealth: 95, currentHealth: 95, maxMana: 50, currentMana: 50,
    speedMultiplier: 1.0, attackCooldown: 2000, damageMultiplier: 0.8, baseDamage: 11, attackType: 'summon',
  },
  chaos: {
    type: 'dodecahedron', maxHealth: 90, currentHealth: 90, maxMana: 50, currentMana: 50,
    speedMultiplier: 1.0, attackCooldown: 500, damageMultiplier: 1.1, baseDamage: 14, attackType: 'ranged',
  },
  engineer: {
    type: 'cylinder', maxHealth: 110, currentHealth: 110, maxMana: 50, currentMana: 50,
    speedMultiplier: 0.9, attackCooldown: 380, damageMultiplier: 1.0, baseDamage: 13, attackType: 'ranged',
  },
  paladin: {
    type: 'torusknot', maxHealth: 140, currentHealth: 140, maxMana: 50, currentMana: 50,
    speedMultiplier: 0.9, attackCooldown: 500, damageMultiplier: 0.9, baseDamage: 19, attackType: 'melee',
  },
  necromancer: {
    type: 'capsule', maxHealth: 80, currentHealth: 80, maxMana: 50, currentMana: 50,
    speedMultiplier: 0.95, attackCooldown: 650, damageMultiplier: 1.3, baseDamage: 16, attackType: 'ranged',
  },
};

const CLASS_SKILLS = {
  warrior: [
    { id: 'ironBody', name: 'Fortified Body', emoji: '🛡️', description: 'Reinforced constitution increases max HP.', stat: '+15 HP', maxLevel: 5 },
    { id: 'cleaveWidth', name: 'Widening Cleave', emoji: '🪓', description: 'Broadens melee arc for wider strikes.', stat: '+15° Arc', maxLevel: 5 },
    { id: 'groundSlam', name: 'Ground Slam', emoji: '💥', description: 'Attacks briefly stun nearby enemies.', stat: '+0.1s Stun', maxLevel: 5 },
    { id: 'warCry', name: 'War Cry', emoji: '📣', description: 'Battle fury amplifies all damage dealt.', stat: '+8% Dmg', maxLevel: 5 },
    { id: 'berserkerRage', name: 'Berserker Rage', emoji: '🔥', description: 'Below 40% HP, gain bonus attack speed.', stat: '+15% AS', maxLevel: 5 },
    { id: 'titanGrip', name: 'Titan Grip', emoji: '✊', description: 'Extends weapon reach for longer strikes.', stat: '+0.5 Range', maxLevel: 5 },
    { id: 'shieldWall', name: 'Shield Wall', emoji: '🏰', description: 'Hardened armor reduces incoming damage.', stat: '-5% Dmg Taken', maxLevel: 5 },
  ],
  archer: [
    { id: 'multiShot', name: 'Multi Shot', emoji: '🏹', description: 'Fire additional arrows in a spread pattern.', stat: '+1 Arrow', maxLevel: 5 },
    { id: 'rapidFire', name: 'Rapid Fire', emoji: '⚡', description: 'Decreases delay between arrow volleys.', stat: '-25ms CD', maxLevel: 5 },
    { id: 'longRange', name: 'Long Range', emoji: '🎯', description: 'Arrows travel further before fading.', stat: '+20% Range', maxLevel: 5 },
    { id: 'poisonArrow', name: 'Poison Arrow', emoji: '☠️', description: 'Arrows apply damage over time on hit.', stat: '+2 DPS', maxLevel: 5 },
    { id: 'evasion', name: 'Evasion', emoji: '💨', description: 'Nimble footwork grants movement speed.', stat: '+4% Speed', maxLevel: 5 },
    { id: 'headshot', name: 'Headshot', emoji: '🦅', description: 'Precise aim increases base arrow damage.', stat: '+3 Dmg', maxLevel: 5 },
    { id: 'piercingArrow', name: 'Piercing Arrow', emoji: '🔱', description: 'Arrows pass through enemies on hit.', stat: '+1 Pierce', maxLevel: 5 },
  ],
  mage: [
    { id: 'arcaneBlast', name: 'Arcane Blast', emoji: '✨', description: 'Amplified arcane energy increases damage.', stat: '+3 Dmg', maxLevel: 5 },
    { id: 'spellSpeed', name: 'Spell Speed', emoji: '⚡', description: 'Faster incantations reduce cast delay.', stat: '-30ms CD', maxLevel: 5 },
    { id: 'blackHoleGrowth', name: 'Singularity', emoji: '🕳️', description: 'Black hole ultimate grows in radius.', stat: '+10% Radius', maxLevel: 5 },
    { id: 'splashDamage', name: 'Chain Lightning', emoji: '⛓️', description: 'Spells damage nearby enemies on impact.', stat: '+0.5 Splash', maxLevel: 5 },
    { id: 'manaShield', name: 'Mana Shield', emoji: '🔮', description: 'Arcane barrier increases max health.', stat: '+12 HP', maxLevel: 5 },
    { id: 'spellPenetration', name: 'Spell Penetration', emoji: '🌌', description: 'Spells bypass enemy resistances.', stat: '+8% Dmg', maxLevel: 5 },
    { id: 'cometTrail', name: 'Comet Trail', emoji: '☄️', description: 'Projectiles leave damaging zones behind.', stat: '+0.2s Trail', maxLevel: 5 },
  ],
  priest: [
    { id: 'healingAura', name: 'Healing Aura', emoji: '💚', description: 'Passively heal nearby allies over time.', stat: '+2 HP/s', maxLevel: 5 },
    { id: 'blessedSpeed', name: 'Blessed Speed', emoji: '🕊️', description: 'Divine wind quickens your movement.', stat: '+4% Speed', maxLevel: 5 },
    { id: 'holyShield', name: 'Holy Shield', emoji: '🛡️', description: 'Sacred protection raises max health.', stat: '+15 HP', maxLevel: 5 },
    { id: 'divineSmite', name: 'Divine Smite', emoji: '⚔️', description: 'Holy wrath increases base damage.', stat: '+2 Dmg', maxLevel: 5 },
    { id: 'purify', name: 'Purify', emoji: '✝️', description: 'Reduces duration of debuffs on self.', stat: '-15% Debuff', maxLevel: 5 },
    { id: 'renewingOrbs', name: 'Renewing Orbs', emoji: '🌟', description: 'Healing orbs restore ally health on pass.', stat: '+3 Heal', maxLevel: 5 },
    { id: 'sanctifiedGround', name: 'Sanctified Ground', emoji: '🙏', description: 'Ultimate burst heal is more powerful.', stat: '+10 Heal', maxLevel: 5 },
  ],
  assassin: [
    { id: 'shadowBlade', name: 'Shadow Blade', emoji: '🗡️', description: 'Shadow-forged steel hits harder.', stat: '+3 Dmg', maxLevel: 5 },
    { id: 'swiftStrike', name: 'Swift Strike', emoji: '⚡', description: 'Faster blade work reduces attack delay.', stat: '-20ms CD', maxLevel: 5 },
    { id: 'cloakDuration', name: 'Cloak Mastery', emoji: '🌑', description: 'Stealth lasts longer after activation.', stat: '+1s Stealth', maxLevel: 5 },
    { id: 'backstab', name: 'Backstab', emoji: '🔪', description: 'Attacks from behind deal bonus damage.', stat: '+15% Back', maxLevel: 5 },
    { id: 'smokeBomb', name: 'Smoke Bomb', emoji: '🌫️', description: 'Ultimate creates a larger smoke zone.', stat: '+0.5 Radius', maxLevel: 5 },
    { id: 'deadlyPoison', name: 'Deadly Poison', emoji: '☠️', description: 'Blade strikes apply damage over time.', stat: '+2 DPS', maxLevel: 5 },
    { id: 'phantomStep', name: 'Phantom Step', emoji: '👤', description: 'Spectral agility boosts move speed.', stat: '+5% Speed', maxLevel: 5 },
  ],
  summoner: [
    { id: 'strongMinions', name: 'Strong Minions', emoji: '🐺', description: 'Summoned units gain bonus health.', stat: '+8 HP', maxLevel: 5 },
    { id: 'minionSpeed', name: 'Pack Rush', emoji: '💨', description: 'Minions move faster in pursuit.', stat: '+10% Speed', maxLevel: 5 },
    { id: 'minionDamage', name: 'Feral Claws', emoji: '🦷', description: 'Summoned units deal more damage.', stat: '+3 Dmg', maxLevel: 5 },
    { id: 'summonCap', name: 'Horde Master', emoji: '👑', description: 'Increases maximum active summons.', stat: '+1 Max', maxLevel: 5 },
    { id: 'minionArmor', name: 'Thick Hide', emoji: '🛡️', description: 'Minions take reduced damage.', stat: '-10% Dmg', maxLevel: 5 },
    { id: 'eliteUpgrade', name: 'Elite Upgrade', emoji: '⭐', description: 'Elite summons gain bonus health.', stat: '+15 HP', maxLevel: 5 },
    { id: 'soulLink', name: 'Soul Link', emoji: '🔗', description: 'Heal when your summons deal damage.', stat: '+3 Heal', maxLevel: 5 },
  ],
  chaos: [
    { id: 'hexPower', name: 'Hex Power', emoji: '🔮', description: 'Chaotic energy amplifies base damage.', stat: '+3 Dmg', maxLevel: 5 },
    { id: 'confusionDuration', name: 'Mind Warp', emoji: '🧠', description: 'Confuse effect lasts longer on enemies.', stat: '+0.3s Confuse', maxLevel: 5 },
    { id: 'chaosSpeed', name: 'Chaos Speed', emoji: '⚡', description: 'Erratic energy boosts movement speed.', stat: '+4% Speed', maxLevel: 5 },
    { id: 'entropicShield', name: 'Entropic Shield', emoji: '🌀', description: 'Chaotic barrier increases max health.', stat: '+12 HP', maxLevel: 5 },
    { id: 'curseAmplify', name: 'Curse Amplify', emoji: '💜', description: 'Dark curses amplify all damage dealt.', stat: '+8% Dmg', maxLevel: 5 },
    { id: 'chaoticSurge', name: 'Chaotic Surge', emoji: '🌊', description: 'Unstable power reduces attack delay.', stat: '-25ms CD', maxLevel: 5 },
    { id: 'voidRift', name: 'Void Rift', emoji: '🌑', description: 'Ultimate distortion field grows larger.', stat: '+12% Radius', maxLevel: 5 },
  ],
  engineer: [
    { id: 'mineLifespan', name: 'Extended Mines', emoji: '⏱️', description: 'Mines persist longer on the field.', stat: '+3s Life', maxLevel: 5 },
    { id: 'mineDamage', name: 'Explosive Charge', emoji: '💣', description: 'Mines detonate with greater force.', stat: '+5 Dmg', maxLevel: 5 },
    { id: 'turretDamage', name: 'Turret Upgrade', emoji: '🔫', description: 'Turret projectiles hit harder.', stat: '+3 Dmg', maxLevel: 5 },
    { id: 'turretDuration', name: 'Fortified Turret', emoji: '🏗️', description: 'Turret stays deployed longer.', stat: '+2s Life', maxLevel: 5 },
    { id: 'turretFireRate', name: 'Rapid Turret', emoji: '⚙️', description: 'Turret fires rounds more frequently.', stat: '-10% CD', maxLevel: 5 },
    { id: 'mineCount', name: 'Mine Field', emoji: '💥', description: 'Place additional mines simultaneously.', stat: '+1 Mine', maxLevel: 5 },
    { id: 'armorPlating', name: 'Armor Plating', emoji: '🧱', description: 'Extra plating increases max health.', stat: '+12 HP', maxLevel: 5 },
  ],
  paladin: [
    { id: 'holyStrike', name: 'Holy Strike', emoji: '⚔️', description: 'Divine power increases base damage.', stat: '+3 Dmg', maxLevel: 5 },
    { id: 'divineHealth', name: 'Divine Health', emoji: '💛', description: 'Blessed vitality raises max health.', stat: '+15 HP', maxLevel: 5 },
    { id: 'shieldOfFaith', name: 'Shield of Faith', emoji: '🛡️', description: 'Holy ward reduces incoming damage.', stat: '-5% Dmg Taken', maxLevel: 5 },
    { id: 'crusaderSpeed', name: 'Crusader Speed', emoji: '🏃', description: 'Blessed stride quickens movement.', stat: '+3% Speed', maxLevel: 5 },
    { id: 'consecration', name: 'Consecration', emoji: '☀️', description: 'Attacks deal splash damage around target.', stat: '+2 Splash', maxLevel: 5 },
    { id: 'holyRetribution', name: 'Holy Retribution', emoji: '⚡', description: 'Righteous fury amplifies damage.', stat: '+7% Dmg', maxLevel: 5 },
    { id: 'blessingOfLight', name: 'Blessing of Light', emoji: '✨', description: 'Ultimate divine shield lasts longer.', stat: '+0.5s Shield', maxLevel: 5 },
  ],
  necromancer: [
    { id: 'soulDrain', name: 'Soul Drain', emoji: '💚', description: 'Attacks steal life from enemies.', stat: '+2 Lifesteal', maxLevel: 5 },
    { id: 'curseOfDecay', name: 'Curse of Decay', emoji: '☠️', description: 'Projectiles apply damage over time.', stat: '+2 DPS', maxLevel: 5 },
    { id: 'darkPower', name: 'Dark Power', emoji: '💀', description: 'Necrotic energy increases base damage.', stat: '+3 Dmg', maxLevel: 5 },
    { id: 'undeadResilience', name: 'Undead Resilience', emoji: '🦴', description: 'Unholy constitution raises max health.', stat: '+12 HP', maxLevel: 5 },
    { id: 'deathHaste', name: 'Death Haste', emoji: '👻', description: 'Spectral speed boosts movement.', stat: '+4% Speed', maxLevel: 5 },
    { id: 'witherTouch', name: 'Wither Touch', emoji: '🖤', description: 'Withering curse amplifies all damage.', stat: '+8% Dmg', maxLevel: 5 },
    { id: 'soulExplosion', name: 'Soul Explosion', emoji: '💥', description: 'Ultimate soul drain grows in radius.', stat: '+10% Radius', maxLevel: 5 },
  ],
};

// Server Setup
const app = express();
const path = require('path');
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  transports: ['websocket'],          // Skip HTTP long-polling, go straight to WebSocket
  pingInterval: 10000,
  pingTimeout: 5000,
  perMessageDeflate: {                 // Compress messages
    threshold: 256,
  },
});

// ── Serve Static Client Files ────
const clientDistPath = path.join(__dirname, '../client/dist');
app.use(express.static(clientDistPath));

// Serve index.html for all routes (SPA fallback)
app.get(/.*/, (req, res) => {
  res.sendFile(path.join(clientDistPath, 'index.html'));
});

// Game State
let gameState = 'playing'; // 'playing' or 'gameOver'
const players = {};
const orbs = {};
const projectiles = {};
const blackHoles = {};
let orbsDirty = true;  // Track orb changes to avoid sending static data every frame
let cachedOrbSnapshot = {};
const bots = [];
const turrets = [];
let orbIdCounter = 0;
let projIdCounter = 0;
let botIdCounter = 0;
let turretIdCounter = 0;
let redColorIdx = 0;
let blueColorIdx = 0;

// Leviathan Boss State
let boss = null;
let bossTimer = 180; // 180 seconds = 3 minutes
let bossShockwaveTimer = 0;
const LEVIATHAN_MAX_HEALTH = 5000;
const LEVIATHAN_RADIUS = 10;
const LEVIATHAN_SHOCKWAVE_INTERVAL = 3.0; // 3 seconds
const LEVIATHAN_SHOCKWAVE_RANGE = 40;
const LEVIATHAN_SHOCKWAVE_DAMAGE = 40;
const LEVIATHAN_SPAWN_X = 0;
const LEVIATHAN_SPAWN_Z = 0;
const LEVIATHAN_BOSS_BUFF_DURATION_MS = 60000; // 60 seconds

const bases = {
  red:  { id: 'base_red', team: 'red', maxHealth: BASE_MAX_HEALTH, currentHealth: BASE_MAX_HEALTH, x: -150, z: -150, scale: 5 },
  blue: { id: 'base_blue', team: 'blue', maxHealth: BASE_MAX_HEALTH, currentHealth: BASE_MAX_HEALTH, x: 150, z: 150, scale: 5 },
};

function getTeam() {
  let r = 0, b = 0;
  for (const id in players) { if (players[id].team === 'red') r++; else if (players[id].team === 'blue') b++; }
  return r <= b ? 'red' : 'blue';
}

function getTeamColor(team) {
  if (team === 'red') return PLAYER_COLORS_RED[redColorIdx++ % PLAYER_COLORS_RED.length];
  return PLAYER_COLORS_BLUE[blueColorIdx++ % PLAYER_COLORS_BLUE.length];
}

function getSpawnPos(team) {
  const base = bases[team];
  return { x: base.x + (Math.random() - 0.5) * 10, z: base.z + (Math.random() - 0.5) * 10 };
}

function clampToMap(value, padding = 0) {
  const limit = Math.max(0, MAP_BOUNDARY - Math.max(0, padding));
  return Math.max(-limit, Math.min(limit, value));
}

function randomMapCoord(padding = 0) {
  const limit = Math.max(0, MAP_BOUNDARY - Math.max(0, padding));
  return (Math.random() * 2 - 1) * limit;
}

function getOpenMapPosition(halfSize, options = {}) {
  const avoidBases = options.avoidBases !== false;
  const padding = Math.max(2, halfSize + 2);
  for (let attempt = 0; attempt < 80; attempt++) {
    const x = randomMapCoord(padding);
    const z = randomMapCoord(padding);
    if (collidesWithAnyWall(x, z, halfSize, halfSize)) continue;

    if (avoidBases) {
      let tooCloseToBase = false;
      for (const bKey in bases) {
        const base = bases[bKey];
        const safeRadius = BASE_RADIUS + 12;
        if ((x - base.x) ** 2 + (z - base.z) ** 2 < safeRadius ** 2) {
          tooCloseToBase = true;
          break;
        }
      }
      if (tooCloseToBase) continue;
    }

    return { x, z };
  }
  return { x: randomMapCoord(padding), z: randomMapCoord(padding) };
}

function spawnOrb() {
  const id = `orb_${orbIdCounter++}`;
  const pos = getOpenMapPosition(0.2, { avoidBases: false });
  orbs[id] = { id, x: pos.x, y: 0.5, z: pos.z };
  orbsDirty = true;
}

const BOT_VARIANTS = [
  { botType: 'grunt',  maxHealth: 60,  speed: 0.5,  scale: 1.3, bountyMult: 1.0 },
  { botType: 'brute',  maxHealth: 100, speed: 0.35, scale: 1.8, bountyMult: 1.5 },
  { botType: 'scout',  maxHealth: 40,  speed: 0.75, scale: 1.0, bountyMult: 0.8 },
];

function spawnBot() {
  const spawn = getOpenMapPosition(BOT_COLLIDER_HALF_SIZE);
  const id = `bot_${botIdCounter++}`;
  const variant = BOT_VARIANTS[Math.floor(Math.random() * BOT_VARIANTS.length)];
  bots.push({
    id,
    type: 'bot',
    botType: variant.botType,
    x: spawn.x,
    z: spawn.z,
    maxHealth: variant.maxHealth,
    currentHealth: variant.maxHealth,
    speed: variant.speed,
    attackCooldown: 0,
    scale: variant.scale,
    color: 'grey',
    lastAttackerId: null,
    ownerId: null,
    ownerTeam: null,
    isSummon: false,
    respawnOnDeath: true,
    bountyExp: Math.round(BOT_BOUNTY_EXP * variant.bountyMult),
  });
}

function scheduleBotRespawn() {
  setTimeout(() => {
    if (bots.length < BOT_COUNT) spawnBot();
  }, BOT_RESPAWN_DELAY_MS);
}

function getPlayerSkillLevel(player, skillId) {
  if (!player || !skillId) return 0;
  return Number(player.skills && player.skills[skillId]) || 0;
}

function getSkillDefForPlayer(player, skillId) {
  const classSkills = CLASS_SKILLS[player && player.classType] || [];
  return classSkills.find((s) => s.id === skillId) || null;
}

function drawSkillChoices(player, count = 3) {
  const classSkills = CLASS_SKILLS[player && player.classType] || [];
  const lockedSkillIds = Object.keys(player.skills || {});
  const isLocked = lockedSkillIds.length >= 3;

  let pool;
  if (isLocked) {
    // After 3 unique skills chosen: only offer the locked 3
    pool = classSkills.filter(s => lockedSkillIds.includes(s.id) && getPlayerSkillLevel(player, s.id) < s.maxLevel);
  } else {
    // First 3 picks: offer from all 7
    pool = classSkills.filter(s => getPlayerSkillLevel(player, s.id) < s.maxLevel);
  }
  if (pool.length === 0) return [];

  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }

  return pool.slice(0, Math.min(count, pool.length)).map((skill) => ({
    id: skill.id,
    name: skill.name,
    emoji: skill.emoji,
    description: skill.description,
    stat: skill.stat || '',
    maxLevel: skill.maxLevel,
    currentLevel: getPlayerSkillLevel(player, skill.id),
  }));
}

function getExpRequirementForLevel(level) {
  const lv = Math.max(1, Number(level) || 1);
  return Math.floor(BASE_EXP_REQUIREMENT * Math.pow(lv, 1.8));
}

function applySelectedSkillEffect(player, skillId) {
  const level = getPlayerSkillLevel(player, skillId);
  switch (skillId) {
    // ── HP skills ──
    case 'ironBody': player.maxHealth += 15; player.currentHealth += 15; break;
    case 'holyShield': case 'divineHealth': player.maxHealth += 15; player.currentHealth += 15; break;
    case 'manaShield': case 'entropicShield': case 'undeadResilience': case 'armorPlating':
      player.maxHealth += 12; player.currentHealth += 12; break;
    // ── Base damage skills ──
    case 'headshot': case 'arcaneBlast': case 'shadowBlade': case 'hexPower':
    case 'darkPower': case 'holyStrike':
      player.baseDamage += 3; break;
    case 'divineSmite': player.baseDamage += 2; break;
    // ── Damage multiplier skills ──
    case 'warCry': case 'spellPenetration': case 'curseAmplify': case 'witherTouch':
      player.damageMultiplier += 0.08; break;
    case 'holyRetribution': player.damageMultiplier += 0.07; break;
    // ── Speed skills ──
    case 'evasion': case 'blessedSpeed': case 'chaosSpeed': case 'deathHaste':
      player.speedMultiplier += 0.04; break;
    case 'phantomStep': player.speedMultiplier += 0.05; break;
    case 'crusaderSpeed': player.speedMultiplier += 0.03; break;
    // ── Cooldown skills ──
    case 'rapidFire': player.attackCooldown = Math.max(120, player.attackCooldown - 25); break;
    case 'spellSpeed': player.attackCooldown = Math.max(120, player.attackCooldown - 30); break;
    case 'swiftStrike': player.attackCooldown = Math.max(120, player.attackCooldown - 20); break;
    case 'chaoticSurge': player.attackCooldown = Math.max(120, player.attackCooldown - 25); break;
    // ── Warrior mechanical ──
    case 'cleaveWidth': player.bonusMeleeArc = (player.bonusMeleeArc || 0) + (Math.PI / 12); break;
    case 'titanGrip': player.bonusMeleeRange = (player.bonusMeleeRange || 0) + 0.5; break;
    case 'shieldWall': player.damageReduction = Math.min(0.35, (player.damageReduction || 0) + 0.05); break;
    case 'groundSlam': break; // checked in combat via skill level
    case 'berserkerRage': break; // checked in combat via skill level
    // ── Archer mechanical ──
    case 'multiShot': break; // checked in attack handler via skill level
    case 'longRange': break; // checked in projectile creation via skill level
    case 'poisonArrow': break; // checked on hit via skill level
    case 'piercingArrow': break; // checked on hit via skill level
    // ── Mage mechanical ──
    case 'splashDamage': break; // checked on projectile hit
    case 'blackHoleGrowth': break; // checked in ultimate
    case 'cometTrail': break; // checked on projectile hit
    // ── Priest mechanical ──
    case 'healingAura': break; // ticked in game loop
    case 'purify': break; // checked when debuffs applied
    case 'renewingOrbs': break; // checked on projectile pass
    case 'sanctifiedGround': break; // checked in ultimate
    // ── Assassin mechanical ──
    case 'cloakDuration': break; // checked in stealth
    case 'backstab': break; // checked in melee combat
    case 'smokeBomb': break; // checked in ultimate
    case 'deadlyPoison': break; // checked on hit
    // ── Summoner mechanical ──
    case 'strongMinions': case 'minionSpeed': case 'minionDamage':
    case 'summonCap': case 'minionArmor': case 'eliteUpgrade': case 'soulLink':
      break; // applied at summon time or checked in combat
    // ── Chaos mechanical ──
    case 'confusionDuration': break; // checked in ultimate
    case 'voidRift': break; // checked in ultimate
    // ── Engineer mechanical ──
    case 'mineLifespan': case 'mineDamage': case 'turretDamage':
    case 'turretDuration': case 'turretFireRate': case 'mineCount':
      break; // applied at mine/turret creation time
    // ── Paladin mechanical ──
    case 'shieldOfFaith': player.damageReduction = Math.min(0.35, (player.damageReduction || 0) + 0.05); break;
    case 'consecration': break; // checked in melee combat
    case 'blessingOfLight': break; // checked in ultimate
    // ── Necromancer mechanical ──
    case 'soulDrain': break; // checked on hit
    case 'curseOfDecay': break; // checked on hit
    case 'soulExplosion': break; // checked in ultimate
    default: break;
  }
  if (player.currentHealth > player.maxHealth) player.currentHealth = player.maxHealth;
}

function beginSkillChoiceIfNeeded(player) {
  if (!player || player.permaDead) return;
  if (player.isChoosingSkill) return;
  if ((player.pendingSkillChoices || 0) <= 0) return;

  const choices = drawSkillChoices(player, 3);
  player.pendingSkillChoices -= 1;
  if (!choices.length) {
    player.isChoosingSkill = false;
    player.currentSkillChoices = [];
    return;
  }

  player.isChoosingSkill = true;
  player.currentSkillChoices = choices.map((choice) => choice.id);
  io.to(player.id).emit('skillChoices', { choices, classType: player.classType });
}

function grantExp(player, amount) {
  if (!player || player.permaDead || amount <= 0) return;
  if (!Number.isFinite(player.maxExp) || player.maxExp <= 0) {
    player.maxExp = getExpRequirementForLevel(player.level);
  }
  player.exp += amount;
  while (player.exp >= player.maxExp) {
    player.exp -= player.maxExp;
    player.level += 1;
    player.scale += SCALE_PER_LEVEL;
    player.maxHealth += 10;
    player.currentHealth += 10;
    player.baseDamage += 2;
    player.maxExp = getExpRequirementForLevel(player.level);
    player.pendingSkillChoices = (player.pendingSkillChoices || 0) + 1;
  }
  if (player.currentHealth > player.maxHealth) player.currentHealth = player.maxHealth;
  player.y = 0.5 * player.scale;
  beginSkillChoiceIfNeeded(player);
}

function applyBotDamage(bot, damage, attackerId) {
  if (!bot || damage <= 0) return;
  bot.currentHealth -= damage;
  bot.lastAttackerId = attackerId || bot.lastAttackerId;
  io.emit('combatEvent', { type: 'damage', x: bot.x, z: bot.z, amount: Math.round(damage), color: '#aaaaaa' });
}

function isBotHostileToTeam(bot, team) {
  if (!bot) return false;
  if (!team) return true;
  if (bot.ownerTeam) return bot.ownerTeam !== team;
  return true;
}

function areBotsHostile(botA, botB) {
  if (!botA || !botB || botA.id === botB.id) return false;
  const teamA = botA.ownerTeam || null;
  const teamB = botB.ownerTeam || null;
  if (!teamA && !teamB) return false;
  if (teamA && teamB) return teamA !== teamB;
  return true;
}

function getProjectileDamage(proj) {
  if (!proj) return 0;
  const ownerBaseDamage = Number(proj.ownerBaseDamage) || RANGED_DAMAGE;
  if (proj.kind === 'mine') return Math.max(20, ownerBaseDamage * 1.25) * (proj.ownerDamageMult || 1);
  if (proj.kind === 'summoner_homing') return ownerBaseDamage * (proj.ownerDamageMult || 1);
  if (proj.kind === 'turret_shot') return TURRET_PROJECTILE_DAMAGE * (proj.ownerDamageMult || 1);
  return ownerBaseDamage * (proj.ownerDamageMult || 1);
}

function getNearestEnemyForTeam(x, z, team, includeStealthed = false) {
  let best = null;
  let bestDistSq = Infinity;
  for (const pid in players) {
    const candidate = players[pid];
    if (candidate.permaDead || candidate.team === team || candidate.isInvincible) continue;
    if (!includeStealthed && candidate.isStealthed) continue;
    const dX = candidate.x - x;
    const dZ = candidate.z - z;
    const dSq = dX * dX + dZ * dZ;
    if (dSq < bestDistSq) {
      best = { type: 'player', entity: candidate };
      bestDistSq = dSq;
    }
  }
  for (const bot of bots) {
    if (bot.currentHealth <= 0 || !isBotHostileToTeam(bot, team)) continue;
    const dX = bot.x - x;
    const dZ = bot.z - z;
    const dSq = dX * dX + dZ * dZ;
    if (dSq < bestDistSq) {
      best = { type: 'bot', entity: bot };
      bestDistSq = dSq;
    }
  }
  if (!best) return null;
  best.distanceSq = bestDistSq;
  return best;
}

function spawnTurret(owner) {
  if (!owner) return null;
  const turret = {
    id: `turret_${turretIdCounter++}`,
    ownerId: owner.id,
    ownerTeam: owner.team,
    x: clampToMap(owner.x, 1),
    z: clampToMap(owner.z, 1),
    scale: 1.35,
    color: owner.color,
    lifeTicks: TURRET_LIFETIME_TICKS,
    fireCooldown: 0,
  };
  turrets.push(turret);
  return turret;
}
for (let i = 0; i < ORB_COUNT; i++) spawnOrb();
for (let i = 0; i < BOT_COUNT; i++) spawnBot();

function intersectsWall(x, z, halfWidth, halfDepth, wall) {
  const wallHalfWidth = wall.width / 2;
  const wallHalfDepth = wall.depth / 2;
  return (
    Math.abs(x - wall.x) < (halfWidth + wallHalfWidth) &&
    Math.abs(z - wall.z) < (halfDepth + wallHalfDepth)
  );
}

function collidesWithAnyWall(x, z, halfWidth, halfDepth) {
  for (const wall of walls) {
    if (intersectsWall(x, z, halfWidth, halfDepth, wall)) return true;
  }
  return false;
}

function resolveWallCollision(currentX, currentZ, nextX, nextZ, halfSize) {
  let resolvedX = currentX;
  let resolvedZ = currentZ;

  if (!collidesWithAnyWall(nextX, currentZ, halfSize, halfSize)) resolvedX = nextX;
  if (!collidesWithAnyWall(resolvedX, nextZ, halfSize, halfSize)) resolvedZ = nextZ;

  return { x: resolvedX, z: resolvedZ };
}

function projectileHitsWall(x, z) {
  for (const wall of walls) {
    const wallHalfWidth = wall.width / 2 + PROJECTILE_WALL_RADIUS;
    const wallHalfDepth = wall.depth / 2 + PROJECTILE_WALL_RADIUS;
    if (Math.abs(x - wall.x) <= wallHalfWidth && Math.abs(z - wall.z) <= wallHalfDepth) return true;
  }
  return false;
}

function isInsideStealthZone(x, z) {
  for (const zone of stealthZones) {
    const dX = x - zone.x;
    const dZ = z - zone.z;
    if (dX * dX + dZ * dZ <= zone.radius * zone.radius) return true;
  }
  return false;
}

function sanitizeMoveIntent(input) {
  let dirX = Number(input && input.dirX);
  let dirZ = Number(input && input.dirZ);
  if (!Number.isFinite(dirX)) dirX = 0;
  if (!Number.isFinite(dirZ)) dirZ = 0;

  const magnitude = Math.sqrt(dirX * dirX + dirZ * dirZ);
  if (magnitude > 1) {
    dirX /= magnitude;
    dirZ /= magnitude;
  }
  return { dirX, dirZ };
}

function resetPlayer(p) {
  const classDef = CLASS_DEFS[p.classType] || CLASS_DEFS.warrior;
  const spawn = getSpawnPos(p.team);
  p.x = spawn.x; p.y = 0.5; p.z = spawn.z;
  p.exp = 0; p.level = 1; p.maxExp = BASE_EXP_REQUIREMENT; p.scale = 1; p.permaDead = false; p.lastAttackerId = null;
  p.maxHealth = classDef.maxHealth; p.currentHealth = classDef.maxHealth;
  p.maxMana = classDef.maxMana; p.currentMana = classDef.maxMana;
  p.baseDamage = classDef.baseDamage;
  p.skills = {};
  p.pendingSkillChoices = 0;
  p.currentSkillChoices = [];
  p.isChoosingSkill = false;
  p.damageMultiplier = classDef.damageMultiplier;
  p.isStunned = false; p.isInvincible = false; p.lastUltimateTime = 0;
  p.isStealthed = false; p.lastCombatActionTime = 0;
  p.isConfused = false; p.confusedUntil = 0; p.speedBuffUntil = 0;
  p.rotY = 0; p.input = { dirX: 0, dirZ: 0 };
}

// ── Full Match Reset ────────────────────────────────────────────────────────
function resetMatch() {
  gameState = 'playing';
  bases.red.currentHealth = BASE_MAX_HEALTH;
  bases.blue.currentHealth = BASE_MAX_HEALTH;
  bots.length = 0;
  turrets.length = 0;
  for (const id in players) {
    const p = players[id];
    resetPlayer(p);
    p.kills = 0;
    p.deaths = 0;
    p.botKills = 0;
    p.damageDealt = 0;
  }
  io.emit('gameReset');
  console.log('[MATCH] Game reset - new match starting');
}

// Socket.io Events
io.on('connection', (socket) => {
  socket.emit('assignId', socket.id);

  // Ping-pong for latency measurement
  socket.on('ping_check', () => {
    socket.emit('pong_check');
  });

  socket.on('joinGame', (data) => {
    if (players[socket.id] || !data) return;
    const classType = CLASS_DEFS[data.classType] ? data.classType : 'warrior';
    const username = data.username.trim() || 'Anonymous';
    const classDef = CLASS_DEFS[classType];
    const team = getTeam();
    const spawn = getSpawnPos(team);

    players[socket.id] = {
      id: socket.id, username, x: spawn.x, y: 0.5, z: spawn.z, color: getTeamColor(team),
      team, classType, type: classDef.type, input: { dirX: 0, dirZ: 0 }, rotY: 0,
      exp: 0, level: 1, maxExp: BASE_EXP_REQUIREMENT, scale: 1, permaDead: false,
      maxHealth: classDef.maxHealth, currentHealth: classDef.currentHealth,
      maxMana: classDef.maxMana, currentMana: classDef.currentMana,
      baseDamage: classDef.baseDamage,
      speedMultiplier: classDef.speedMultiplier, attackCooldown: classDef.attackCooldown, lastAttackTime: 0,
      skills: {}, pendingSkillChoices: 0, currentSkillChoices: [], isChoosingSkill: false, damageMultiplier: classDef.damageMultiplier,
      lastAttackerId: null, isStunned: false, isInvincible: false, lastUltimateTime: 0,
      isStealthed: false, lastCombatActionTime: 0,
      isConfused: false, confusedUntil: 0, speedBuffUntil: 0,
      // Match statistics
      kills: 0, deaths: 0, botKills: 0, damageDealt: 0
    };
    socket.emit('initMap', { walls, stealthZones });
    console.log(`[JOIN] ${username} joined team ${team} as ${classType}`);
  });

  socket.on('sendChat', (text) => {
    io.emit('socialEvent', { type: 'chat', playerId: socket.id, text });
  });

  socket.on('sendEmote', (emoteId) => {
    const normalizedId = String(emoteId || '');
    if (normalizedId !== '1' && normalizedId !== '2' && normalizedId !== '3') return;
    io.emit('socialEvent', { type: 'emote', playerId: socket.id, emoteId: normalizedId });
  });

  socket.on('selectSkill', (skillId) => {
    const p = players[socket.id];
    if (!p || p.permaDead || !p.isChoosingSkill) return;

    const selectedId = String(skillId || '');
    if (!p.currentSkillChoices || !p.currentSkillChoices.includes(selectedId)) return;

    const skillDef = getSkillDefForPlayer(p, selectedId);
    if (!skillDef) return;

    const currentLevel = getPlayerSkillLevel(p, selectedId);
    if (currentLevel >= skillDef.maxLevel) {
      p.isChoosingSkill = false;
      p.currentSkillChoices = [];
      beginSkillChoiceIfNeeded(p);
      return;
    }

    p.skills[selectedId] = currentLevel + 1;
    applySelectedSkillEffect(p, selectedId);
    p.isChoosingSkill = false;
    p.currentSkillChoices = [];
    beginSkillChoiceIfNeeded(p);
  });

  socket.on('moveIntent', (data) => {
    const p = players[socket.id];
    if (!p || p.permaDead || p.isStunned) return;
    const input = sanitizeMoveIntent(data);
    if (p.isConfused) {
      input.dirX *= -1;
      input.dirZ *= -1;
    }
    p.input = input;
  });

  socket.on('ultimate', (data) => {
    const p = players[socket.id];
    if (!p || p.permaDead || p.isStunned) return;

    const now = Date.now();
    if (now - p.lastUltimateTime < 15000) return;
    p.lastUltimateTime = now;
    p.lastCombatActionTime = now;
    p.isStealthed = false;

    const tx = Number(data.targetX) || p.x;
    const tz = Number(data.targetZ) || p.z;
    let emittedCast = false;
    const castPayload = { playerId: socket.id, classType: p.classType, x: p.x, z: p.z, targetX: tx, targetZ: tz };

    if (p.classType === 'warrior') {
      for (const eid in players) {
        if (eid === socket.id) continue;
        const enemy = players[eid];
        if (enemy.team === p.team || enemy.permaDead || enemy.isInvincible) continue;
        const dX = enemy.x - p.x; const dZ = enemy.z - p.z;
        if (dX*dX + dZ*dZ <= 15*15) {
          const dmg = Math.max(40, p.baseDamage * 2.5) * p.damageMultiplier;
          enemy.currentHealth -= dmg;
          enemy.lastAttackerId = socket.id;
          enemy.isStunned = true;
          io.emit('combatEvent', { type: 'damage', x: enemy.x, z: enemy.z, amount: Math.round(dmg), color: enemy.color });
          setTimeout(() => { if(players[eid]) players[eid].isStunned = false; }, 1500);
        }
      }
      for (const bot of bots) {
        const dX = bot.x - p.x;
        const dZ = bot.z - p.z;
        if (dX * dX + dZ * dZ <= 15 * 15) {
          const dmg = Math.max(40, p.baseDamage * 2.5) * p.damageMultiplier;
          applyBotDamage(bot, dmg, socket.id);
        }
      }
      emittedCast = true;
    } else if (p.classType === 'archer') {
      const dx = tx - p.x; const dz = tz - p.z;
      const mag = Math.sqrt(dx*dx + dz*dz) || 1;
      const dirX = dx/mag; const dirZ = dz/mag;
      const length = Math.min(50, mag);
      const targetPoint = { x: p.x + dirX*length, z: p.z + dirZ*length };

      for (const eid in players) {
        if (eid === socket.id) continue;
        const enemy = players[eid];
        if (enemy.team === p.team || enemy.permaDead || enemy.isInvincible) continue;
        const A2P = { x: enemy.x - p.x, z: enemy.z - p.z };
        const dot = A2P.x * dirX + A2P.z * dirZ;
        const t = Math.max(0, Math.min(length, dot));
        const closestNode = { x: p.x + dirX * t, z: p.z + dirZ * t };
        const dNode = (enemy.x - closestNode.x)**2 + (enemy.z - closestNode.z)**2;
        if (dNode <= (2.0 + 1 * enemy.scale)**2) {
          const dmg = 70 * p.damageMultiplier;
          enemy.currentHealth -= dmg;
          enemy.lastAttackerId = socket.id;
          io.emit('combatEvent', { type: 'damage', x: enemy.x, z: enemy.z, amount: Math.round(dmg), color: enemy.color });
        }
      }
      for (const bot of bots) {
        const A2P = { x: bot.x - p.x, z: bot.z - p.z };
        const dot = A2P.x * dirX + A2P.z * dirZ;
        const t = Math.max(0, Math.min(length, dot));
        const closestNode = { x: p.x + dirX * t, z: p.z + dirZ * t };
        const dNode = (bot.x - closestNode.x) ** 2 + (bot.z - closestNode.z) ** 2;
        if (dNode <= (1.6 + 0.5 * (bot.scale || 1)) ** 2) {
          const dmg = 70 * p.damageMultiplier;
          applyBotDamage(bot, dmg, socket.id);
        }
      }
      emittedCast = true;
      io.emit('ultimateCast', { playerId: socket.id, classType: 'archer', x: p.x, z: p.z, targetX: targetPoint.x, targetZ: targetPoint.z });
      return; 
    } else if (p.classType === 'mage') {
      const bhId = `bh_${Date.now()}_${socket.id}`;
      blackHoles[bhId] = { id: bhId, x: tx, z: tz, team: p.team, life: 3.0, ownerId: socket.id, damageMult: p.damageMultiplier };
      emittedCast = true;
    } else if (p.classType === 'priest') {
      for (const eid in players) {
        const ally = players[eid];
        if (ally.team !== p.team || ally.permaDead) continue;
        const dX = ally.x - p.x; const dZ = ally.z - p.z;
        if (dX*dX + dZ*dZ <= 25*25) {
          ally.currentHealth = Math.min(ally.currentHealth + 60, ally.maxHealth);
        }
      }
      emittedCast = true;
    } else if (p.classType === 'assassin') {
      const closestTarget = getNearestEnemyForTeam(p.x, p.z, p.team, true);
      if (closestTarget && closestTarget.distanceSq <= ASSASSIN_TELEPORT_RANGE * ASSASSIN_TELEPORT_RANGE) {
        const targetEntity = closestTarget.entity;
        const oldX = p.x;
        const oldZ = p.z;
        const dirXRaw = targetEntity.x - oldX;
        const dirZRaw = targetEntity.z - oldZ;
        const mag = Math.sqrt(dirXRaw * dirXRaw + dirZRaw * dirZRaw) || 1;
        const dirX = dirXRaw / mag;
        const dirZ = dirZRaw / mag;
        const destinationX = clampToMap(targetEntity.x - dirX * ASSASSIN_TELEPORT_OFFSET, PLAYER_COLLIDER_HALF_SIZE);
        const destinationZ = clampToMap(targetEntity.z - dirZ * ASSASSIN_TELEPORT_OFFSET, PLAYER_COLLIDER_HALF_SIZE);
        const resolved = resolveWallCollision(oldX, oldZ, destinationX, destinationZ, PLAYER_COLLIDER_HALF_SIZE * (p.scale || 1));
        p.x = clampToMap(resolved.x, PLAYER_COLLIDER_HALF_SIZE * (p.scale || 1));
        p.z = clampToMap(resolved.z, PLAYER_COLLIDER_HALF_SIZE * (p.scale || 1));
        p.speedBuffUntil = now + ASSASSIN_SPEED_BUFF_MS;
        castPayload.x = oldX;
        castPayload.z = oldZ;
        castPayload.targetX = p.x;
        castPayload.targetZ = p.z;
      }
      emittedCast = true;
    } else if (p.classType === 'summoner') {
      // Ult: maintain exactly 1 elite melee + 1 elite ranged (refresh existing, respawn missing)
      const ultSummons = [
        { summonType: 'elite_melee', maxHealth: 80, speed: 0.6, scale: 1.2, attackRange: BOT_MELEE_RANGE },
        { summonType: 'elite_ranged', maxHealth: 55, speed: 0.5, scale: 1.0, attackRange: 12 },
      ];

      const elitesByType = {};
      for (const def of ultSummons) elitesByType[def.summonType] = [];
      for (const bot of bots) {
        if (!bot.isSummon || bot.ownerId !== socket.id || bot.currentHealth <= 0) continue;
        if (elitesByType[bot.summonType]) elitesByType[bot.summonType].push(bot);
      }

      for (let i = 0; i < ultSummons.length; i++) {
        const def = ultSummons[i];
        const typedElites = elitesByType[def.summonType] || [];

        // Enforce non-stacking: keep one per elite type, remove extras.
        if (typedElites.length > 1) {
          for (let j = 1; j < typedElites.length; j++) {
            typedElites[j].currentHealth = 0;
          }
        }

        const activeElite = typedElites[0];
        if (activeElite) {
          // Refresh existing elite if present.
          activeElite.maxHealth = def.maxHealth;
          activeElite.currentHealth = def.maxHealth;
          activeElite.speed = def.speed;
          activeElite.scale = def.scale;
          activeElite.attackRange = def.attackRange;
          activeElite.attackCooldown = 0;
          activeElite.ownerId = socket.id;
          activeElite.ownerTeam = p.team;
          activeElite.team = p.team;
          continue;
        }

        // Missing elite: respawn it near the summoner.
        const angle = (Math.PI * 2 * i) / ultSummons.length + Math.random() * 0.5;
        const offsetDist = 2.2 + Math.random() * 1.0;
        const summonX = clampToMap(p.x + Math.cos(angle) * offsetDist, BOT_COLLIDER_HALF_SIZE);
        const summonZ = clampToMap(p.z + Math.sin(angle) * offsetDist, BOT_COLLIDER_HALF_SIZE);
        const resolved = resolveWallCollision(p.x, p.z, summonX, summonZ, BOT_COLLIDER_HALF_SIZE);
        bots.push({
          id: `bot_${botIdCounter++}`, type: 'bot',
          x: clampToMap(resolved.x, BOT_COLLIDER_HALF_SIZE),
          z: clampToMap(resolved.z, BOT_COLLIDER_HALF_SIZE),
          maxHealth: def.maxHealth, currentHealth: def.maxHealth,
          speed: def.speed, attackCooldown: 0, scale: def.scale,
          color: 'grey', team: p.team, lastAttackerId: null,
          ownerId: socket.id, ownerTeam: p.team,
          isSummon: true, summonType: def.summonType,
          attackRange: def.attackRange,
          respawnOnDeath: false, bountyExp: 0,
        });
      }
      emittedCast = true;
    } else if (p.classType === 'chaos') {
      for (const eid in players) {
        const enemy = players[eid];
        if (enemy.team === p.team || enemy.permaDead) continue;
        const dX = enemy.x - p.x;
        const dZ = enemy.z - p.z;
        if (dX * dX + dZ * dZ <= CHAOS_CONFUSE_RANGE * CHAOS_CONFUSE_RANGE) {
          enemy.isConfused = true;
          enemy.confusedUntil = Math.max(enemy.confusedUntil || 0, now + CHAOS_CONFUSE_DURATION_MS);
          setTimeout(() => {
            const target = players[eid];
            if (target && Date.now() >= (target.confusedUntil || 0)) {
              target.isConfused = false;
            }
          }, CHAOS_CONFUSE_DURATION_MS + 25);
        }
      }
      emittedCast = true;
    } else if (p.classType === 'engineer') {
      spawnTurret(p);
      emittedCast = true;
    } else if (p.classType === 'paladin') {
      for (const eid in players) {
        const ally = players[eid];
        if (ally.team !== p.team || ally.permaDead) continue;
        const dX = ally.x - p.x; const dZ = ally.z - p.z;
        if (dX * dX + dZ * dZ <= 25 * 25) {
          ally.isInvincible = true;
          setTimeout(() => { if (players[eid]) players[eid].isInvincible = false; }, 2000);
        }
      }
      emittedCast = true;
    } else if (p.classType === 'necromancer') {
      let totalDmg = 0;
      for (const eid in players) {
        if (eid === socket.id) continue;
        const enemy = players[eid];
        if (enemy.team === p.team || enemy.permaDead || enemy.isInvincible) continue;
        const dX = enemy.x - p.x; const dZ = enemy.z - p.z;
        if (dX * dX + dZ * dZ <= 20 * 20) {
          const dmg = 50 * p.damageMultiplier;
          enemy.currentHealth -= dmg;
          enemy.lastAttackerId = socket.id;
          totalDmg += dmg;
          io.emit('combatEvent', { type: 'damage', x: enemy.x, z: enemy.z, amount: Math.round(dmg), color: enemy.color });
        }
      }
      for (const bot of bots) {
        const dX = bot.x - p.x; const dZ = bot.z - p.z;
        if (dX * dX + dZ * dZ <= 20 * 20) {
          const dmg = 50 * p.damageMultiplier;
          applyBotDamage(bot, dmg, socket.id);
          totalDmg += dmg;
        }
      }
      p.currentHealth = Math.min(p.currentHealth + totalDmg * 0.5, p.maxHealth);
      emittedCast = true;
    }

    if (emittedCast) io.emit('ultimateCast', castPayload);
  });

  socket.on('attack', (data) => {
    const p = players[socket.id];
    if (!p || p.permaDead || p.isStunned) return;

    const now = Date.now();
    const rageMult = p.rageActive ? (1 - getPlayerSkillLevel(p, 'berserkerRage') * 0.15) : 1;
    if (now - p.lastAttackTime < p.attackCooldown * rageMult) return;
    p.lastAttackTime = now;
    p.lastCombatActionTime = now;
    p.isStealthed = false;

    const tx = Number(data.targetX); const tz = Number(data.targetZ);
    if (isNaN(tx) || isNaN(tz)) return;

    const dx = tx - p.x; const dz = tz - p.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist === 0) return;
    const dirX = dx / dist; const dirZ = dz / dist;

    const classDef = CLASS_DEFS[p.classType] || {};
    if (classDef.attackType === 'summon') {
      // Summoner: spawn a weak melee minion at click direction
      const maxSummons = 6 + getPlayerSkillLevel(p, 'summonCap');
      const activeSummons = bots.filter(b => b.ownerId === socket.id && b.isSummon && b.currentHealth > 0);
      if (activeSummons.length >= maxSummons) return;
      const spawnDist = 1.5;
      const summonX = clampToMap(p.x + dirX * spawnDist, BOT_COLLIDER_HALF_SIZE);
      const summonZ = clampToMap(p.z + dirZ * spawnDist, BOT_COLLIDER_HALF_SIZE);
      const resolved = resolveWallCollision(p.x, p.z, summonX, summonZ, BOT_COLLIDER_HALF_SIZE);
      const hpBonus = getPlayerSkillLevel(p, 'strongMinions') * 8;
      const spdBonus = 1 + getPlayerSkillLevel(p, 'minionSpeed') * 0.1;
      bots.push({
        id: `bot_${botIdCounter++}`, type: 'bot',
        x: clampToMap(resolved.x, BOT_COLLIDER_HALF_SIZE),
        z: clampToMap(resolved.z, BOT_COLLIDER_HALF_SIZE),
        maxHealth: 25 + hpBonus, currentHealth: 25 + hpBonus, speed: 0.65 * spdBonus,
        attackCooldown: 0, scale: 0.6, color: 'grey',
        team: p.team, lastAttackerId: null,
        ownerId: socket.id, ownerTeam: p.team,
        isSummon: true, summonType: 'basic',
        bonusDamage: getPlayerSkillLevel(p, 'minionDamage') * 3,
        damageReduction: getPlayerSkillLevel(p, 'minionArmor') * 0.1,
        respawnOnDeath: false, bountyExp: 0,
      });
    } else if (classDef.attackType === 'melee') {
      const meleeRange = (MELEE_RANGE + (p.bonusMeleeRange || 0)) * p.scale;
      const meleeArc = MELEE_ARC + (p.bonusMeleeArc || 0);
      const stunLevel = getPlayerSkillLevel(p, 'groundSlam');
      const consecLevel = getPlayerSkillLevel(p, 'consecration');
      for (const eid in players) {
        if (eid === socket.id) continue;
        const enemy = players[eid];
        if (enemy.team === p.team || enemy.permaDead || enemy.isInvincible) continue;
        const edx = enemy.x - p.x; const edz = enemy.z - p.z;
        const eDist = Math.sqrt(edx * edx + edz * edz);
        if (eDist > meleeRange || eDist === 0) continue;
        const dot = (edx * dirX + edz * dirZ) / eDist;
        if (Math.acos(Math.max(-1, Math.min(1, dot))) <= meleeArc / 2) {
          let dmg = p.baseDamage * p.damageMultiplier;
          if (p.hasBossBuff) dmg *= 2.0;
          const dr = enemy.damageReduction || 0;
          enemy.currentHealth -= dmg * (1 - dr);
          enemy.lastAttackerId = socket.id;
          io.emit('combatEvent', { type: 'damage', x: enemy.x, z: enemy.z, amount: Math.round(dmg * (1 - dr)), color: enemy.color });
          if (stunLevel > 0) { enemy.isStunned = true; setTimeout(() => { enemy.isStunned = false; }, 200 + stunLevel * 100); }
          if (consecLevel > 0) {
            for (const eid2 in players) {
              if (eid2 === socket.id || eid2 === eid) continue;
              const e2 = players[eid2];
              if (e2.team === p.team || e2.permaDead || e2.isInvincible) continue;
              const sd = Math.sqrt((e2.x - enemy.x) ** 2 + (e2.z - enemy.z) ** 2);
              if (sd <= 2.5) { e2.currentHealth -= consecLevel * 2; io.emit('combatEvent', { type: 'damage', x: e2.x, z: e2.z, amount: consecLevel * 2, color: e2.color }); }
            }
          }
        }
      }
      for (const bot of bots) {
        const bdx = bot.x - p.x; const bdz = bot.z - p.z;
        const bDist = Math.sqrt(bdx * bdx + bdz * bdz);
        if (bDist > meleeRange || bDist === 0) continue;
        const dot = (bdx * dirX + bdz * dirZ) / bDist;
        if (Math.acos(Math.max(-1, Math.min(1, dot))) <= meleeArc / 2) {
          let dmg = p.baseDamage * p.damageMultiplier;
          if (p.hasBossBuff) dmg *= 2.0;
          applyBotDamage(bot, dmg, socket.id);
        }
      }
      if (boss && boss.currentHealth > 0) {
        const bdx = boss.x - p.x; const bdz = boss.z - p.z;
        const bDist = Math.sqrt(bdx * bdx + bdz * bdz);
        if (bDist <= meleeRange + boss.radius && bDist > 0) {
          const dot = (bdx * dirX + bdz * dirZ) / bDist;
          if (Math.acos(Math.max(-1, Math.min(1, dot))) <= meleeArc / 2) {
            let dmg = MELEE_BASE_DAMAGE * p.damageMultiplier;
            if (p.hasBossBuff) dmg *= 2.0;
            boss.currentHealth -= dmg; boss.lastAttackerId = socket.id;
            io.emit('combatEvent', { type: 'damage', x: boss.x, z: boss.z, amount: Math.round(dmg), color: '#9933ff' });
          }
        }
      }
      for (const bKey in bases) {
        const base = bases[bKey];
        if (base.team === p.team || base.currentHealth <= 0) continue;
        const bdx = base.x - p.x; const bdz = base.z - p.z;
        const bDist = Math.sqrt(bdx * bdx + bdz * bdz);
        if (bDist > (meleeRange + BASE_RADIUS) || bDist === 0) continue;
        const dot = (bdx * dirX + bdz * dirZ) / bDist;
        if (Math.acos(Math.max(-1, Math.min(1, dot))) <= meleeArc / 2) {
          const dmg = MELEE_BASE_DAMAGE * p.damageMultiplier;
          base.currentHealth = Math.max(0, base.currentHealth - dmg);
          const baseColor = base.team === 'red' ? '#ff4444' : '#4488ff';
          io.emit('combatEvent', { type: 'damage', x: base.x, z: base.z, amount: Math.round(dmg), color: baseColor });
        }
      }
    } else {
      if (p.classType === 'engineer') {
        const mineLife = ENGINEER_MINE_LIFESPAN + (getPlayerSkillLevel(p, 'mineLifespan') * 3);
        const projId = `proj_${projIdCounter++}`;
        projectiles[projId] = {
          id: projId, kind: 'mine', ownerId: socket.id, ownerTeam: p.team, ownerColor: p.color, ownerClass: p.classType, ownerDamageMult: p.damageMultiplier,
          ownerBaseDamage: p.baseDamage + (getPlayerSkillLevel(p, 'mineDamage') * 5),
          x: p.x, z: p.z, vx: 0, vz: 0, life: mineLife,
        };
      } else {
        // Fire main projectile
        const lifeBonus = p.classType === 'archer' ? (1 + getPlayerSkillLevel(p, 'longRange') * 0.2) : 1;
        const projId = `proj_${projIdCounter++}`;
        projectiles[projId] = {
          id: projId, kind: 'normal', ownerId: socket.id, ownerTeam: p.team, ownerColor: p.color, ownerClass: p.classType, ownerDamageMult: p.damageMultiplier,
          ownerBaseDamage: p.baseDamage,
          x: p.x, z: p.z, vx: dirX * PROJECTILE_SPEED, vz: dirZ * PROJECTILE_SPEED, life: PROJECTILE_LIFESPAN * lifeBonus,
          pierceCount: getPlayerSkillLevel(p, 'piercingArrow'),
          splashRadius: getPlayerSkillLevel(p, 'splashDamage') * 0.5,
          poisonDps: getPlayerSkillLevel(p, 'poisonArrow') * 2 + getPlayerSkillLevel(p, 'deadlyPoison') * 2 + getPlayerSkillLevel(p, 'curseOfDecay') * 2,
          lifestealPerHit: getPlayerSkillLevel(p, 'soulDrain') * 2,
        };
        // Multi Shot: fire extra arrows at spread angles
        const extraArrows = getPlayerSkillLevel(p, 'multiShot');
        if (extraArrows > 0 && p.classType === 'archer') {
          for (let i = 1; i <= extraArrows; i++) {
            const spreadAngle = (Math.PI / 12) * i; // 15 degree spread per arrow
            for (const sign of [-1, 1]) {
              const angle = Math.atan2(dirZ, dirX) + sign * spreadAngle;
              const sdx = Math.cos(angle); const sdz = Math.sin(angle);
              const eid = `proj_${projIdCounter++}`;
              projectiles[eid] = {
                id: eid, kind: 'normal', ownerId: socket.id, ownerTeam: p.team, ownerColor: p.color, ownerClass: p.classType, ownerDamageMult: p.damageMultiplier,
                ownerBaseDamage: p.baseDamage,
                x: p.x, z: p.z, vx: sdx * PROJECTILE_SPEED, vz: sdz * PROJECTILE_SPEED, life: PROJECTILE_LIFESPAN * lifeBonus,
                pierceCount: getPlayerSkillLevel(p, 'piercingArrow'),
              };
            }
          }
        }
      }
    }
  });

  socket.on('disconnect', () => {
    delete players[socket.id];
    for (let i = bots.length - 1; i >= 0; i--) {
      if (bots[i].ownerId === socket.id) bots.splice(i, 1);
    }
    for (let i = turrets.length - 1; i >= 0; i--) {
      if (turrets[i].ownerId === socket.id) turrets.splice(i, 1);
    }
  });
});

// Game Loop
const delta = 1 / TICK_RATE;
setInterval(() => {
  const tickNow = Date.now();
  for (const id in players) {
    const p = players[id];
    if (p.permaDead || p.isStunned || gameState === 'gameOver') continue;
    if (p.isConfused && tickNow >= (p.confusedUntil || 0)) p.isConfused = false;
    const buffMult = tickNow < (p.speedBuffUntil || 0) ? ASSASSIN_SPEED_BUFF_MULT : 1;
    const speed = PLAYER_SPEED * p.speedMultiplier * buffMult;
    
    let dx = Number(p.input && p.input.dirX) || 0;
    let dz = Number(p.input && p.input.dirZ) || 0;
    const magnitude = Math.sqrt(dx * dx + dz * dz);
    if (magnitude > 1) {
      dx /= magnitude;
      dz /= magnitude;
    }

    const intendedX = clampToMap(p.x + dx * speed * delta, PLAYER_COLLIDER_HALF_SIZE);
    const intendedZ = clampToMap(p.z + dz * speed * delta, PLAYER_COLLIDER_HALF_SIZE);
    const colliderHalf = PLAYER_COLLIDER_HALF_SIZE * (p.scale || 1);
    const resolved = resolveWallCollision(p.x, p.z, intendedX, intendedZ, colliderHalf);
    p.x = clampToMap(resolved.x, colliderHalf);
    p.z = clampToMap(resolved.z, colliderHalf);

    // Process DoTs
    if (p.dots && p.dots.length > 0) {
      for (let di = p.dots.length - 1; di >= 0; di--) {
        const dot = p.dots[di];
        p.currentHealth -= dot.dps * delta;
        dot.remaining -= delta;
        if (dot.remaining <= 0) p.dots.splice(di, 1);
      }
    }

    // Healing Aura (priest)
    const healAuraLvl = getPlayerSkillLevel(p, 'healingAura');
    if (healAuraLvl > 0 && !p.permaDead) {
      for (const aid in players) {
        if (aid === id) continue;
        const ally = players[aid];
        if (ally.team !== p.team || ally.permaDead) continue;
        if ((ally.x - p.x) ** 2 + (ally.z - p.z) ** 2 <= 64) { // 8 unit radius
          ally.currentHealth = Math.min(ally.maxHealth, ally.currentHealth + healAuraLvl * 2 * delta);
        }
      }
    }

    // Berserker Rage (warrior) — reduce attack cooldown when low HP
    if (getPlayerSkillLevel(p, 'berserkerRage') > 0 && p.currentHealth <= p.maxHealth * 0.4) {
      p.rageActive = true;
    } else {
      p.rageActive = false;
    }
  }

  for (const bot of bots) {
    if (bot.attackCooldown > 0) bot.attackCooldown -= 1;

    let closestTarget = null;
    let closestDistSq = Infinity;

    for (const pid in players) {
      const target = players[pid];
      if (target.permaDead || target.isStealthed || target.isInvincible) continue;
      if (bot.ownerTeam && target.team === bot.ownerTeam) continue;
      const dX = target.x - bot.x;
      const dZ = target.z - bot.z;
      const dSq = dX * dX + dZ * dZ;
      if (dSq < closestDistSq) {
        closestDistSq = dSq;
        closestTarget = { type: 'player', entity: target };
      }
    }

    for (const otherBot of bots) {
      if (otherBot.currentHealth <= 0 || !areBotsHostile(bot, otherBot)) continue;
      const dX = otherBot.x - bot.x;
      const dZ = otherBot.z - bot.z;
      const dSq = dX * dX + dZ * dZ;
      if (dSq < closestDistSq) {
        closestDistSq = dSq;
        closestTarget = { type: 'bot', entity: otherBot };
      }
    }

    if (closestTarget && closestDistSq <= BOT_AGGRO_RANGE * BOT_AGGRO_RANGE) {
      // Ranged summons stop at their attack range, others chase into melee
      const stopRange = bot.attackRange || BOT_MELEE_RANGE;
      if (closestDistSq > stopRange * stopRange * 0.8) {
        const targetEntity = closestTarget.entity;
        const dist = Math.sqrt(closestDistSq) || 1;
        const dirX = (targetEntity.x - bot.x) / dist;
        const dirZ = (targetEntity.z - bot.z) / dist;
        const intendedX = clampToMap(bot.x + dirX * bot.speed, BOT_COLLIDER_HALF_SIZE);
        const intendedZ = clampToMap(bot.z + dirZ * bot.speed, BOT_COLLIDER_HALF_SIZE);
        const resolved = resolveWallCollision(bot.x, bot.z, intendedX, intendedZ, BOT_COLLIDER_HALF_SIZE);
        bot.x = clampToMap(resolved.x, BOT_COLLIDER_HALF_SIZE);
        bot.z = clampToMap(resolved.z, BOT_COLLIDER_HALF_SIZE);
      }
    } else if (bot.ownerId && players[bot.ownerId] && !players[bot.ownerId].permaDead) {
      const owner = players[bot.ownerId];
      const dX = owner.x - bot.x;
      const dZ = owner.z - bot.z;
      const dSq = dX * dX + dZ * dZ;
      if (dSq > SUMMONER_FOLLOW_DISTANCE * SUMMONER_FOLLOW_DISTANCE) {
        const dist = Math.sqrt(dSq) || 1;
        const intendedX = clampToMap(bot.x + (dX / dist) * bot.speed, BOT_COLLIDER_HALF_SIZE);
        const intendedZ = clampToMap(bot.z + (dZ / dist) * bot.speed, BOT_COLLIDER_HALF_SIZE);
        const resolved = resolveWallCollision(bot.x, bot.z, intendedX, intendedZ, BOT_COLLIDER_HALF_SIZE);
        bot.x = clampToMap(resolved.x, BOT_COLLIDER_HALF_SIZE);
        bot.z = clampToMap(resolved.z, BOT_COLLIDER_HALF_SIZE);
      }
    }

    if (!closestTarget) continue;
    const targetEntity = closestTarget.entity;
    const meleeDx = targetEntity.x - bot.x;
    const meleeDz = targetEntity.z - bot.z;
    const targetDistSq = meleeDx * meleeDx + meleeDz * meleeDz;
    const botRange = bot.attackRange || BOT_MELEE_RANGE;
    if (bot.attackCooldown <= 0 && targetDistSq <= botRange * botRange) {
      if (bot.summonType === 'elite_ranged') {
        // Ranged summon fires a projectile
        const tDist = Math.sqrt(targetDistSq) || 1;
        const dX = meleeDx / tDist; const dZ = meleeDz / tDist;
        const projId = `proj_${projIdCounter++}`;
        projectiles[projId] = {
          id: projId, kind: 'summoner_homing', ownerId: bot.ownerId, ownerTeam: bot.team,
          ownerColor: bot.team === 'red' ? '#ff6666' : '#6688ff', ownerClass: 'summoner',
          ownerDamageMult: 1.0, ownerBaseDamage: 10,
          x: bot.x, z: bot.z, vx: dX * PROJECTILE_SPEED * 0.6, vz: dZ * PROJECTILE_SPEED * 0.6, life: 1.5,
        };
        bot.attackCooldown = BOT_ATTACK_COOLDOWN_TICKS + 10;
      } else {
        if (closestTarget.type === 'player') {
          if (!targetEntity.isInvincible) {
            targetEntity.currentHealth -= BOT_MELEE_DAMAGE;
            targetEntity.lastAttackerId = bot.ownerId || null;
            io.emit('combatEvent', { type: 'damage', x: targetEntity.x, z: targetEntity.z, amount: BOT_MELEE_DAMAGE, color: targetEntity.color });
          }
        } else {
          applyBotDamage(targetEntity, BOT_MELEE_DAMAGE, bot.ownerId || null);
        }
        bot.attackCooldown = BOT_ATTACK_COOLDOWN_TICKS;
      }
    }
  }

  for (let i = turrets.length - 1; i >= 0; i--) {
    const turret = turrets[i];
    turret.lifeTicks -= 1;
    if (turret.lifeTicks <= 0) {
      turrets.splice(i, 1);
      continue;
    }
    if (turret.fireCooldown > 0) {
      turret.fireCooldown -= 1;
      continue;
    }

    let closest = null;
    let closestDistSq = Infinity;
    for (const pid in players) {
      const target = players[pid];
      if (target.permaDead || target.team === turret.ownerTeam || target.isStealthed || target.isInvincible) continue;
      const dX = target.x - turret.x;
      const dZ = target.z - turret.z;
      const dSq = dX * dX + dZ * dZ;
      if (dSq < closestDistSq) {
        closest = target;
        closestDistSq = dSq;
      }
    }
    for (const bot of bots) {
      if (bot.currentHealth <= 0 || !isBotHostileToTeam(bot, turret.ownerTeam)) continue;
      const dX = bot.x - turret.x;
      const dZ = bot.z - turret.z;
      const dSq = dX * dX + dZ * dZ;
      if (dSq < closestDistSq) {
        closest = bot;
        closestDistSq = dSq;
      }
    }
    if (!closest || closestDistSq > TURRET_RANGE * TURRET_RANGE) continue;

    const dist = Math.sqrt(closestDistSq) || 1;
    const dirX = (closest.x - turret.x) / dist;
    const dirZ = (closest.z - turret.z) / dist;
    const projId = `proj_${projIdCounter++}`;
    projectiles[projId] = {
      id: projId,
      kind: 'turret_shot',
      ownerId: turret.ownerId,
      ownerTeam: turret.ownerTeam,
      ownerColor: turret.color,
      ownerDamageMult: 1.0,
      x: turret.x,
      z: turret.z,
      vx: dirX * TURRET_PROJECTILE_SPEED,
      vz: dirZ * TURRET_PROJECTILE_SPEED,
      life: 1.8,
    };
    turret.fireCooldown = TURRET_FIRE_COOLDOWN_TICKS;
  }

  const BLACKHOLE_DPS = 20;
  for (const bhId in blackHoles) {
    const bh = blackHoles[bhId];
    bh.life -= delta;
    if (bh.life <= 0) { delete blackHoles[bhId]; continue; }
    for (const pid in players) {
      const enemy = players[pid];
      if (enemy.team === bh.team || enemy.permaDead || enemy.isInvincible) continue;
      const dX = bh.x - enemy.x; const dZ = bh.z - enemy.z;
      const dSq = dX*dX + dZ*dZ;
      if (dSq > 0 && dSq < 25*25) {
          const dist = Math.sqrt(dSq);
          const pullX = enemy.x - (dX / dist) * 10 * delta;
          const pullZ = enemy.z - (dZ / dist) * 10 * delta;
          const colliderHalf = PLAYER_COLLIDER_HALF_SIZE * (enemy.scale || 1);
          const resolved = resolveWallCollision(enemy.x, enemy.z, pullX, pullZ, colliderHalf);
          enemy.x = clampToMap(resolved.x, colliderHalf);
          enemy.z = clampToMap(resolved.z, colliderHalf);
          const dmgAmount = BLACKHOLE_DPS * bh.damageMult * delta;
          enemy.currentHealth -= dmgAmount;
          enemy.lastAttackerId = bh.ownerId;
      }
    }
    for (const bot of bots) {
      const dX = bh.x - bot.x;
      const dZ = bh.z - bot.z;
      const dSq = dX * dX + dZ * dZ;
      if (dSq > 0 && dSq < 25 * 25) {
        const dist = Math.sqrt(dSq);
        const pullX = bot.x - (dX / dist) * 10 * delta;
        const pullZ = bot.z - (dZ / dist) * 10 * delta;
        const colliderHalf = BOT_COLLIDER_HALF_SIZE * (bot.scale || 1);
        const resolved = resolveWallCollision(bot.x, bot.z, pullX, pullZ, colliderHalf);
        bot.x = clampToMap(resolved.x, colliderHalf);
        bot.z = clampToMap(resolved.z, colliderHalf);
        const dmgAmount = BLACKHOLE_DPS * bh.damageMult * delta;
        bot.currentHealth -= dmgAmount;
        bot.lastAttackerId = bh.ownerId;
      }
    }
  }

  for (const playerId in players) {
    const p = players[playerId];
    if (p.permaDead) continue;
    const collectRadius = ORB_COLLECT_RADIUS * p.scale;
    for (const orbId in orbs) {
      const orb = orbs[orbId];
      if ((p.x-orb.x)**2 + (p.z-orb.z)**2 < collectRadius**2) {
        delete orbs[orbId];
        orbsDirty = true;
        grantExp(p, EXP_PER_ORB);
        spawnOrb();
      }
    }
  }

  for (const projId in projectiles) {
    const proj = projectiles[projId];
    const projKind = proj.kind || 'normal';
    if (projKind === 'summoner_homing') {
      const target = getNearestEnemyForTeam(proj.x, proj.z, proj.ownerTeam, false);
      if (target) {
        const dX = target.entity.x - proj.x;
        const dZ = target.entity.z - proj.z;
        const dist = Math.sqrt(dX * dX + dZ * dZ) || 1;
        const targetVX = (dX / dist) * PROJECTILE_SPEED * 0.75;
        const targetVZ = (dZ / dist) * PROJECTILE_SPEED * 0.75;
        proj.vx = proj.vx * 0.85 + targetVX * 0.15;
        proj.vz = proj.vz * 0.85 + targetVZ * 0.15;
      }
    }

    proj.x += proj.vx * delta;
    proj.z += proj.vz * delta;
    proj.life -= delta;
    if (proj.life <= 0 || Math.abs(proj.x) > MAP_BOUNDARY + 10 || Math.abs(proj.z) > MAP_BOUNDARY + 10) { delete projectiles[projId]; continue; }
    if (projKind !== 'mine' && projectileHitsWall(proj.x, proj.z)) { delete projectiles[projId]; continue; }
    let destroyed = false;

    for (const pid in players) {
      const p = players[pid];
      if (pid === proj.ownerId || p.team === proj.ownerTeam || p.permaDead || p.isInvincible) continue;
      if ((proj.x-p.x)**2 + (proj.z-p.z)**2 < (PROJECTILE_RADIUS * p.scale)**2) {
        const dmg = getProjectileDamage(proj);
        const dr = p.damageReduction || 0;
        p.currentHealth -= dmg * (1 - dr);
        p.lastAttackerId = proj.ownerId;
        if (proj.ownerId && players[proj.ownerId]) {
          players[proj.ownerId].damageDealt = (players[proj.ownerId].damageDealt || 0) + dmg;
          // Lifesteal
          if (proj.lifestealPerHit > 0) {
            const owner = players[proj.ownerId];
            owner.currentHealth = Math.min(owner.maxHealth, owner.currentHealth + proj.lifestealPerHit);
          }
        }
        io.emit('combatEvent', { type: 'damage', x: p.x, z: p.z, amount: Math.round(dmg * (1 - dr)), color: p.color, targetId: p.id });
        // Splash damage to nearby enemies
        if (proj.splashRadius > 0) {
          for (const sid in players) {
            if (sid === proj.ownerId || sid === pid) continue;
            const sp = players[sid];
            if (sp.team === proj.ownerTeam || sp.permaDead || sp.isInvincible) continue;
            if ((sp.x - p.x) ** 2 + (sp.z - p.z) ** 2 <= proj.splashRadius * proj.splashRadius) {
              const splashDmg = dmg * 0.4;
              sp.currentHealth -= splashDmg;
              io.emit('combatEvent', { type: 'damage', x: sp.x, z: sp.z, amount: Math.round(splashDmg), color: sp.color });
            }
          }
        }
        // Poison/DoT
        if (proj.poisonDps > 0) {
          p.dots = p.dots || [];
          p.dots.push({ dps: proj.poisonDps, remaining: 2.0, attackerId: proj.ownerId });
        }
        // Piercing: don't destroy, decrement
        if (proj.pierceCount > 0) { proj.pierceCount--; } else { delete projectiles[projId]; destroyed = true; break; }
      }
    }
    if (destroyed) continue;

    // Check boss damage
    if (boss && boss.currentHealth > 0 && (proj.x - boss.x)**2 + (proj.z - boss.z)**2 < (PROJECTILE_RADIUS + boss.radius)**2) {
      let dmg = getProjectileDamage(proj);
      const shooter = players[proj.ownerId];
      if (shooter && shooter.hasBossBuff) dmg *= 2.0;
      boss.currentHealth -= dmg;
      boss.lastAttackerId = proj.ownerId;
      io.emit('combatEvent', { type: 'damage', x: boss.x, z: boss.z, amount: Math.round(dmg), color: '#9933ff' });
      delete projectiles[projId];
      destroyed = true;
    }
    if (destroyed) continue;

    for (const bot of bots) {
      if (!isBotHostileToTeam(bot, proj.ownerTeam)) continue;
      const hitRadius = PROJECTILE_RADIUS + BOT_COLLIDER_HALF_SIZE * (bot.scale || 1);
      if ((proj.x - bot.x) ** 2 + (proj.z - bot.z) ** 2 < hitRadius ** 2) {
        const dmg = getProjectileDamage(proj);
        applyBotDamage(bot, dmg, proj.ownerId);
        delete projectiles[projId];
        destroyed = true;
        break;
      }
    }
    if (destroyed) continue;

    if (projKind === 'mine' || projKind === 'turret_shot') continue;
    for (const bKey in bases) {
      const base = bases[bKey];
      if (base.team === proj.ownerTeam || base.currentHealth <= 0) continue;
      if ((proj.x-base.x)**2 + (proj.z-base.z)**2 < BASE_RADIUS**2) {
        const dmg = RANGED_BASE_DAMAGE * proj.ownerDamageMult;
        base.currentHealth = Math.max(0, base.currentHealth - dmg);
        const baseColor = base.team === 'red' ? '#ff4444' : '#4488ff';
        io.emit('combatEvent', { type: 'damage', x: base.x, z: base.z, amount: Math.round(dmg), color: baseColor });
        delete projectiles[projId]; break;
      }
    }
  }

  const bountyQueue = {}; // { attackerId: amount }

  for (const id in players) {
    const p = players[id];
    if (!p.permaDead && p.currentHealth <= 0) {
      io.emit('combatEvent', { type: 'death', x: p.x, z: p.z, color: p.color });

      // Award Bounty
      if (p.lastAttackerId && players[p.lastAttackerId] && !players[p.lastAttackerId].permaDead) {
        bountyQueue[p.lastAttackerId] = (bountyQueue[p.lastAttackerId] || 0) + KILL_BOUNTY_EXP;
        // Track kill
        players[p.lastAttackerId].kills = (players[p.lastAttackerId].kills || 0) + 1;
        console.log(`[BOUNTY] ${players[p.lastAttackerId].username} claimed bounty on ${p.username}`);
      }
      p.lastAttackerId = null;

      // Track death
      p.deaths = (p.deaths || 0) + 1;

      if (bases[p.team] && bases[p.team].currentHealth > 0) resetPlayer(p);
      else {
        p.currentHealth = 0;
        p.permaDead = true;
        p.input = { dirX: 0, dirZ: 0 };
        p.isChoosingSkill = false;
        p.currentSkillChoices = [];
        p.pendingSkillChoices = 0;
      }
    }
  }

  for (let i = bots.length - 1; i >= 0; i--) {
    const bot = bots[i];
    if (bot.currentHealth > 0) continue;
    io.emit('combatEvent', { type: 'death', x: bot.x, z: bot.z, color: '#aaaaaa' });
    if ((bot.bountyExp || 0) > 0 && bot.lastAttackerId && players[bot.lastAttackerId] && !players[bot.lastAttackerId].permaDead) {
      bountyQueue[bot.lastAttackerId] = (bountyQueue[bot.lastAttackerId] || 0) + bot.bountyExp;
      // Track bot kill
      players[bot.lastAttackerId].botKills = (players[bot.lastAttackerId].botKills || 0) + 1;
    }
    bots.splice(i, 1);
    if (bot.respawnOnDeath !== false) scheduleBotRespawn();
  }

  // ── Boss Death ────────────────────────────────────────
  if (boss && boss.currentHealth <= 0) {
    io.emit('combatEvent', { type: 'death', x: boss.x, z: boss.z, color: '#9933ff' });
    if (boss.lastAttackerId && players[boss.lastAttackerId] && !players[boss.lastAttackerId].permaDead) {
      const attacker = players[boss.lastAttackerId];
      const winningTeam = attacker.team;
      io.emit('announcement', `${winningTeam.toUpperCase()} SECURED THE LEVIATHAN!`);
      console.log(`[BOSS] Team ${winningTeam} defeated the Leviathan!`);
      
      // Apply buff to all players on winning team
      for (const pid in players) {
        const p = players[pid];
        if (p.team === winningTeam && !p.permaDead) {
          p.hasBossBuff = true;
        }
      }
      
      // Remove buff after 60 seconds
      setTimeout(() => {
        for (const pid in players) {
          const p = players[pid];
          if (p.team === winningTeam) {
            p.hasBossBuff = false;
          }
        }
      }, LEVIATHAN_BOSS_BUFF_DURATION_MS);
    }
    boss = null;
    bossTimer = 180; // Reset the 3-minute timer
    bossShockwaveTimer = 0;
  }
  
  // Process kill bounty Multi-Level-Ups
  for (const aId in bountyQueue) {
    const atk = players[aId];
    if (atk && !atk.permaDead) {
      grantExp(atk, bountyQueue[aId]);
    }
  }

  const now = Date.now();
  for (const playerId in players) {
    const p = players[playerId];
    if (p.permaDead) {
      p.isStealthed = false;
      p.isConfused = false;
      continue;
    }
    if (p.isConfused && now >= (p.confusedUntil || 0)) p.isConfused = false;
    const insideZone = isInsideStealthZone(p.x, p.z);
    const recentlyExposed = now - (p.lastCombatActionTime || 0) < STEALTH_BREAK_DURATION_MS;
    p.isStealthed = insideZone && !recentlyExposed;
  }

  // ── Leviathan Boss Logic ────────────────────────────────
  // Boss Shockwave Attack
  if (boss && boss.currentHealth > 0) {
    bossShockwaveTimer -= delta;
    if (bossShockwaveTimer <= 0) {
      bossShockwaveTimer = LEVIATHAN_SHOCKWAVE_INTERVAL;
      // Deal damage to all players within range
      for (const pid in players) {
        const p = players[pid];
        if (p.permaDead || p.isInvincible) continue;
        const dX = p.x - boss.x;
        const dZ = p.z - boss.z;
        const distSq = dX * dX + dZ * dZ;
        if (distSq <= LEVIATHAN_SHOCKWAVE_RANGE * LEVIATHAN_SHOCKWAVE_RANGE) {
          p.currentHealth -= LEVIATHAN_SHOCKWAVE_DAMAGE;
          io.emit('combatEvent', { type: 'damage', x: p.x, z: p.z, amount: LEVIATHAN_SHOCKWAVE_DAMAGE, color: '#9933ff' });
        }
      }
      io.emit('combatEvent', { type: 'bossShockwave', x: boss.x, z: boss.z });
    }
  }

  const playerSnapshot = {};
  for (const id in players) {
    const p = players[id];
    // Only send dynamic data that changes every tick (position, health, status)
    // Static data (username, color, team, type, classType) sent once via 'playerInit'
    playerSnapshot[id] = {
      id: p.id, x: p.x, y: p.y, z: p.z, rotY: p.rotY,
      exp: p.exp, maxExp: p.maxExp, level: p.level,
      maxHealth: p.maxHealth, currentHealth: p.currentHealth,
      scale: p.scale, permaDead: p.permaDead,
      isStunned: p.isStunned, isInvincible: p.isInvincible,
      isStealthed: p.isStealthed, isConfused: p.isConfused,
      isChoosingSkill: !!p.isChoosingSkill, hasBossBuff: !!p.hasBossBuff,
      // Include static fields only for new/unknown players (client caches these)
      username: p.username, color: p.color, team: p.team,
      type: p.type, classType: p.classType,
    };
  }

  // ── Check for Base Destruction (Game Over) ──
  if (gameState === 'playing') {
    const redDestroyed = bases.red.currentHealth <= 0;
    const blueDestroyed = bases.blue.currentHealth <= 0;
    
    if (redDestroyed || blueDestroyed) {
      gameState = 'gameOver';
      const winningTeam = redDestroyed ? 'blue' : 'red';
      const destroyedBasePos = redDestroyed ? { x: bases.red.x, z: bases.red.z } : { x: bases.blue.x, z: bases.blue.z };
      
      const scoreboardData = Object.values(players)
        .filter(p => !p.permaDead)
        .sort((a, b) => (b.kills || 0) - (a.kills || 0) || (b.damageDealt || 0) - (a.damageDealt || 0))
        .map(p => ({
          id: p.id,
          username: p.username,
          team: p.team,
          classType: p.classType,
          kills: p.kills || 0,
          deaths: p.deaths || 0,
          botKills: p.botKills || 0,
          damageDealt: p.damageDealt || 0,
          level: p.level || 1
        }));
      
      io.emit('gameOver', { 
        winningTeam, 
        scoreboardData, 
        destroyedBasePos 
      });
      
      // Schedule reset for 15 seconds
      setTimeout(() => {
        resetMatch();
      }, 15000);
      
      console.log(`[GAME OVER] Team ${winningTeam} wins!`);
    }
  }

  // ── Network Broadcast (throttled to NET_SEND_RATE) ──
  tickCounter++;
  if (tickCounter >= NET_SEND_INTERVAL) {
    tickCounter = 0;

    // Cache orb snapshot only when orbs change
    if (orbsDirty) {
      cachedOrbSnapshot = {};
      for (const id in orbs) {
        const o = orbs[id];
        cachedOrbSnapshot[id] = { id: o.id, x: o.x, y: o.y, z: o.z };
      }
      orbsDirty = false;
    }

    io.emit('stateUpdate', {
      players: playerSnapshot,
      orbs: cachedOrbSnapshot,
      projectiles: Object.fromEntries(Object.entries(projectiles).map(([id, pr]) => [id, {
        id: pr.id,
        x: pr.x,
        z: pr.z,
        vx: pr.vx,            // Send velocity for client-side prediction
        vz: pr.vz,
        ownerColor: pr.ownerColor,
        ownerClass: pr.ownerClass,
        kind: pr.kind || 'normal',
        visible: true,
      }])),
      bots: bots.map((bot) => ({
        id: bot.id,
        type: bot.type,
        x: bot.x,
        z: bot.z,
        maxHealth: bot.maxHealth,
        currentHealth: bot.currentHealth,
        scale: bot.scale,
        color: bot.color,
        team: bot.team || null,
        ownerId: bot.ownerId || null,
        ownerTeam: bot.ownerTeam || null,
        isSummon: !!bot.isSummon,
      })),
      turrets: turrets.map((turret) => ({
        id: turret.id,
        x: turret.x,
        z: turret.z,
        scale: turret.scale,
        color: turret.color,
        ownerTeam: turret.ownerTeam,
        ownerId: turret.ownerId,
      })),
      bases: { red: { ...bases.red }, blue: { ...bases.blue } },
      boss: boss ? { id: boss.id, maxHealth: boss.maxHealth, currentHealth: boss.currentHealth, x: boss.x, z: boss.z, radius: boss.radius } : null,
    });
  }
}, 1000 / TICK_RATE);

// ── Boss Timer (1 second tick) ────────────────────
setInterval(() => {
  if (boss === null) {
    bossTimer -= 1;
    if (bossTimer <= 0) {
      boss = {
        id: 'leviathan',
        maxHealth: LEVIATHAN_MAX_HEALTH,
        currentHealth: LEVIATHAN_MAX_HEALTH,
        x: LEVIATHAN_SPAWN_X,
        z: LEVIATHAN_SPAWN_Z,
        radius: LEVIATHAN_RADIUS,
      };
      bossShockwaveTimer = LEVIATHAN_SHOCKWAVE_INTERVAL;
      io.emit('announcement', 'THE LEVIATHAN HAS SPAWNED!');
      console.log('[BOSS] The Leviathan has spawned!');
    }
  }
}, 1000);

server.listen(PORT, () => console.log(`[SERVER] Game server running on http://localhost:${PORT}`));

