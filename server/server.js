const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

// Config
const PORT = 3000;
const TICK_RATE = 60;
const PLAYER_SPEED = 12.5;
const PLAYER_COLORS_RED  = ['#ff4444', '#ff6655', '#ee3333', '#ff5544'];
const PLAYER_COLORS_BLUE = ['#4444ff', '#5566ff', '#3333ee', '#4455ff'];

// Ecosystem
const ORB_COUNT = 180;
const MAP_BOUNDARY = 200;
const ORB_COLLECT_RADIUS = 1.2;
const EXP_PER_ORB = 1;
const BASE_EXP_REQUIREMENT = 100;
const SCALE_PER_LEVEL = 0.2;
const KILL_BOUNTY_EXP = 50;
const BOT_BOUNTY_EXP = 12;

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
const TURRET_FIRE_COOLDOWN_TICKS = TICK_RATE;
const TURRET_RANGE = 45;
const TURRET_PROJECTILE_SPEED = PROJECTILE_SPEED * 0.9;

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
    { id: 'juggernaut', name: 'Juggernaut', emoji: '🛡️', description: 'Increases max HP and body mass.', maxLevel: 5 },
    { id: 'spikyArmor', name: 'Spiky Armor', emoji: '🦔', description: 'Hardened spikes radiate from your shell.', maxLevel: 5 },
    { id: 'battleCry', name: 'Battle Cry', emoji: '📣', description: 'Empowers your strikes with raw force.', maxLevel: 5 },
    { id: 'executioner', name: 'Executioner', emoji: '🪓', description: 'Raises basic attack lethality.', maxLevel: 5 },
    { id: 'fortressStride', name: 'Fortress Stride', emoji: '👣', description: 'Heavy steps become unexpectedly swift.', maxLevel: 5 },
  ],
  archer: [
    { id: 'eagleEye', name: 'Eagle Eye', emoji: '🦅', description: 'Precision instincts sharpen all shots.', maxLevel: 5 },
    { id: 'quickdraw', name: 'Quickdraw', emoji: '🏹', description: 'Lowers attack delay for faster firing.', maxLevel: 5 },
    { id: 'piercingShots', name: 'Piercing Shots', emoji: '🎯', description: 'Bolts punch harder through defenses.', maxLevel: 5 },
    { id: 'windrunner', name: 'Windrunner', emoji: '💨', description: 'Improves movement speed between volleys.', maxLevel: 5 },
    { id: 'marksmanFocus', name: 'Marksman Focus', emoji: '🔭', description: 'Steady aim increases baseline damage.', maxLevel: 5 },
  ],
  mage: [
    { id: 'arcaneOverflow', name: 'Arcane Overflow', emoji: '✨', description: 'Arcane output amplifies base damage.', maxLevel: 5 },
    { id: 'singularityCore', name: 'Singularity Core', emoji: '🕳️', description: 'Your gravity magic grows denser.', maxLevel: 5 },
    { id: 'manaSurge', name: 'Mana Surge', emoji: '🔋', description: 'Empowers sustained spellcasting.', maxLevel: 5 },
    { id: 'frostbrand', name: 'Frostbrand', emoji: '❄️', description: 'Infuses attacks with biting arcana.', maxLevel: 5 },
    { id: 'voidPulse', name: 'Void Pulse', emoji: '🌌', description: 'Dark pulses intensify magical impact.', maxLevel: 5 },
  ],
  priest: [
    { id: 'sacredBloom', name: 'Sacred Bloom', emoji: '🌿', description: 'Raises your health pool with holy life.', maxLevel: 5 },
    { id: 'guardianAura', name: 'Guardian Aura', emoji: '🕊️', description: 'Protective aura enhances resilience.', maxLevel: 5 },
    { id: 'swiftPrayer', name: 'Swift Prayer', emoji: '🙏', description: 'Blessed focus grants extra movement speed.', maxLevel: 5 },
    { id: 'renewingLight', name: 'Renewing Light', emoji: '💚', description: 'Healing energies strengthen your form.', maxLevel: 5 },
    { id: 'blessedShell', name: 'Blessed Shell', emoji: '🔰', description: 'Holy shell reinforces your body.', maxLevel: 5 },
  ],
  assassin: [
    { id: 'shadowstep', name: 'Shadowstep', emoji: '🌑', description: 'Dark footwork boosts movement speed.', maxLevel: 5 },
    { id: 'poisonEdge', name: 'Poison Edge', emoji: '☠️', description: 'Coated blades increase base damage.', maxLevel: 5 },
    { id: 'backstabMastery', name: 'Backstab Mastery', emoji: '🗡️', description: 'Ambush style improves strike power.', maxLevel: 5 },
    { id: 'smokeVeil', name: 'Smoke Veil', emoji: '🌫️', description: 'Veiled posture improves survivability.', maxLevel: 5 },
    { id: 'bloodlust', name: 'Bloodlust', emoji: '🩸', description: 'Kills fuel relentless offensive flow.', maxLevel: 5 },
  ],
  summoner: [
    { id: 'beastMastery', name: 'Beast Mastery', emoji: '🐺', description: 'Companions answer your call with vigor.', maxLevel: 5 },
    { id: 'packBond', name: 'Pack Bond', emoji: '🤝', description: 'Your summons coordinate more effectively.', maxLevel: 5 },
    { id: 'spiritFangs', name: 'Spirit Fangs', emoji: '🦷', description: 'Summoned attacks gain base damage.', maxLevel: 5 },
    { id: 'astralLink', name: 'Astral Link', emoji: '🔗', description: 'Links with summons harden your body.', maxLevel: 5 },
    { id: 'wildGrowth', name: 'Wild Growth', emoji: '🌱', description: 'Natural momentum increases speed.', maxLevel: 5 },
  ],
  chaos: [
    { id: 'warpedMind', name: 'Warped Mind', emoji: '🧠', description: 'Reality twists empower your output.', maxLevel: 5 },
    { id: 'entropyField', name: 'Entropy Field', emoji: '🌀', description: 'Chaotic field bolsters survivability.', maxLevel: 5 },
    { id: 'hexedMomentum', name: 'Hexed Momentum', emoji: '⚡', description: 'Hex currents accelerate your motion.', maxLevel: 5 },
    { id: 'mirrorPain', name: 'Mirror Pain', emoji: '🪞', description: 'Reflected agony sharpens your attacks.', maxLevel: 5 },
    { id: 'realityRend', name: 'Reality Rend', emoji: '💥', description: 'Rifts increase your baseline damage.', maxLevel: 5 },
  ],
  engineer: [
    { id: 'reinforcedPlating', name: 'Reinforced Plating', emoji: '🧱', description: 'Extra armor plating raises max HP.', maxLevel: 5 },
    { id: 'overclock', name: 'Overclock', emoji: '⚙️', description: 'Mechanical tuning improves speed.', maxLevel: 5 },
    { id: 'mineExpert', name: 'Mine Expert', emoji: '💣', description: 'Explosive expertise raises base damage.', maxLevel: 5 },
    { id: 'autoLoader', name: 'Auto Loader', emoji: '🔩', description: 'Auto-loading decreases attack cooldown.', maxLevel: 5 },
    { id: 'droneMatrix', name: 'Drone Matrix', emoji: '🛠️', description: 'Constructor matrix strengthens chassis.', maxLevel: 5 },
  ],
  paladin: [
    { id: 'holyFortitude', name: 'Holy Fortitude', emoji: '⛪', description: 'Divine blessing raises max HP.', maxLevel: 5 },
    { id: 'radiantStrike', name: 'Radiant Strike', emoji: '☀️', description: 'Holy light empowers your attacks.', maxLevel: 5 },
    { id: 'divineWrath', name: 'Divine Wrath', emoji: '⚔️', description: 'Righteous fury amplifies damage.', maxLevel: 5 },
    { id: 'crusaderMarch', name: 'Crusader March', emoji: '🏃', description: 'Blessed stride increases speed.', maxLevel: 5 },
    { id: 'sacredArmor', name: 'Sacred Armor', emoji: '🛡️', description: 'Holy armor reinforces your body.', maxLevel: 5 },
  ],
  necromancer: [
    { id: 'soulHarvest', name: 'Soul Harvest', emoji: '👻', description: 'Harvested souls bolster survivability.', maxLevel: 5 },
    { id: 'deathMark', name: 'Death Mark', emoji: '💀', description: 'Cursed strikes increase base damage.', maxLevel: 5 },
    { id: 'witherGrasp', name: 'Wither Grasp', emoji: '🦴', description: 'Necrotic grip raises base damage.', maxLevel: 5 },
    { id: 'darkPact', name: 'Dark Pact', emoji: '🖤', description: 'Unholy pact amplifies damage output.', maxLevel: 5 },
    { id: 'spectralHaste', name: 'Spectral Haste', emoji: '👤', description: 'Ghostly speed enhances movement.', maxLevel: 5 },
  ],
};

// Server Setup
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

// Game State
let gameState = 'playing'; // 'playing' or 'gameOver'
const players = {};
const orbs = {};
const projectiles = {};
const blackHoles = {};
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
  const available = classSkills.filter((skill) => getPlayerSkillLevel(player, skill.id) < skill.maxLevel);
  if (available.length === 0) return [];

  for (let i = available.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [available[i], available[j]] = [available[j], available[i]];
  }

  return available.slice(0, Math.min(count, available.length)).map((skill) => ({
    id: skill.id,
    name: skill.name,
    emoji: skill.emoji,
    description: skill.description,
    maxLevel: skill.maxLevel,
    currentLevel: getPlayerSkillLevel(player, skill.id),
  }));
}

function getExpRequirementForLevel(level) {
  const lv = Math.max(1, Number(level) || 1);
  return Math.floor(BASE_EXP_REQUIREMENT * Math.pow(lv, 1.5));
}

function applySelectedSkillEffect(player, skillId) {
  switch (skillId) {
    case 'juggernaut':
    case 'reinforcedPlating':
    case 'guardianAura':
    case 'blessedShell':
    case 'astralLink':
    case 'entropyField':
    case 'droneMatrix':
    case 'smokeVeil':
    case 'sacredBloom':
    case 'holyFortitude':
    case 'sacredArmor':
    case 'soulHarvest':
      player.maxHealth += 12;
      player.currentHealth += 12;
      break;
    case 'executioner':
    case 'marksmanFocus':
    case 'arcaneOverflow':
    case 'poisonEdge':
    case 'spiritFangs':
    case 'realityRend':
    case 'mineExpert':
    case 'radiantStrike':
    case 'deathMark':
    case 'witherGrasp':
      player.baseDamage += 2;
      break;
    case 'battleCry':
    case 'backstabMastery':
    case 'mirrorPain':
    case 'eagleEye':
    case 'voidPulse':
    case 'divineWrath':
    case 'darkPact':
      player.damageMultiplier += 0.07;
      break;
    case 'fortressStride':
    case 'windrunner':
    case 'swiftPrayer':
    case 'shadowstep':
    case 'wildGrowth':
    case 'hexedMomentum':
    case 'overclock':
    case 'crusaderMarch':
    case 'spectralHaste':
      player.speedMultiplier += 0.03;
      break;
    case 'quickdraw':
    case 'autoLoader':
      player.attackCooldown = Math.max(120, player.attackCooldown - 20);
      break;
    default:
      break;
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
  io.to(player.id).emit('skillChoices', choices);
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
  if (proj.kind === 'turret_shot') return 14 * (proj.ownerDamageMult || 1);
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
    scale: 1,
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
    io.emit('socialEvent', { type: 'emote', playerId: socket.id, emoteId });
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
      // Ult: spawn 1 strong melee unit + 1 strong ranged unit
      const ultSummons = [
        { summonType: 'elite_melee', maxHealth: 80, speed: 0.6, scale: 1.2, attackRange: BOT_MELEE_RANGE },
        { summonType: 'elite_ranged', maxHealth: 55, speed: 0.5, scale: 1.0, attackRange: 12 },
      ];
      for (let i = 0; i < ultSummons.length; i++) {
        const def = ultSummons[i];
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
    if (now - p.lastAttackTime < p.attackCooldown) return;
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
      const activeSummons = bots.filter(b => b.ownerId === socket.id && b.isSummon && b.currentHealth > 0);
      if (activeSummons.length >= 6) return; // cap summons
      const spawnDist = 1.5;
      const summonX = clampToMap(p.x + dirX * spawnDist, BOT_COLLIDER_HALF_SIZE);
      const summonZ = clampToMap(p.z + dirZ * spawnDist, BOT_COLLIDER_HALF_SIZE);
      const resolved = resolveWallCollision(p.x, p.z, summonX, summonZ, BOT_COLLIDER_HALF_SIZE);
      bots.push({
        id: `bot_${botIdCounter++}`, type: 'bot',
        x: clampToMap(resolved.x, BOT_COLLIDER_HALF_SIZE),
        z: clampToMap(resolved.z, BOT_COLLIDER_HALF_SIZE),
        maxHealth: 25, currentHealth: 25, speed: 0.65,
        attackCooldown: 0, scale: 0.6, color: 'grey',
        team: p.team, lastAttackerId: null,
        ownerId: socket.id, ownerTeam: p.team,
        isSummon: true, summonType: 'basic',
        respawnOnDeath: false, bountyExp: 0,
      });
    } else if (classDef.attackType === 'melee') {
      for (const eid in players) {
        if (eid === socket.id) continue;
        const enemy = players[eid];
        if (enemy.team === p.team || enemy.permaDead || enemy.isInvincible) continue;
        const edx = enemy.x - p.x; const edz = enemy.z - p.z;
        const eDist = Math.sqrt(edx * edx + edz * edz);
        if (eDist > MELEE_RANGE * p.scale || eDist === 0) continue;
        const dot = (edx * dirX + edz * dirZ) / eDist;
        if (Math.acos(Math.max(-1, Math.min(1, dot))) <= MELEE_ARC / 2) {
          let dmg = p.baseDamage * p.damageMultiplier;
          if (p.hasBossBuff) dmg *= 2.0;
          enemy.currentHealth -= dmg;
          enemy.lastAttackerId = socket.id;
          io.emit('combatEvent', { type: 'damage', x: enemy.x, z: enemy.z, amount: Math.round(dmg), color: enemy.color });
        }
      }
      for (const bot of bots) {
        const bdx = bot.x - p.x;
        const bdz = bot.z - p.z;
        const bDist = Math.sqrt(bdx * bdx + bdz * bdz);
        if (bDist > MELEE_RANGE * p.scale || bDist === 0) continue;
        const dot = (bdx * dirX + bdz * dirZ) / bDist;
        if (Math.acos(Math.max(-1, Math.min(1, dot))) <= MELEE_ARC / 2) {
          let dmg = p.baseDamage * p.damageMultiplier;
          if (p.hasBossBuff) dmg *= 2.0;
          applyBotDamage(bot, dmg, socket.id);
        }
      }
      // Damage the boss if in range
      if (boss && boss.currentHealth > 0) {
        const bdx = boss.x - p.x;
        const bdz = boss.z - p.z;
        const bDist = Math.sqrt(bdx * bdx + bdz * bdz);
        if (bDist <= MELEE_RANGE * p.scale + boss.radius && bDist > 0) {
          const dot = (bdx * dirX + bdz * dirZ) / bDist;
          if (Math.acos(Math.max(-1, Math.min(1, dot))) <= MELEE_ARC / 2) {
            let dmg = MELEE_BASE_DAMAGE * p.damageMultiplier;
            if (p.hasBossBuff) dmg *= 2.0;
            boss.currentHealth -= dmg;
            boss.lastAttackerId = socket.id;
            io.emit('combatEvent', { type: 'damage', x: boss.x, z: boss.z, amount: Math.round(dmg), color: '#9933ff' });
          }
        }
      }
      for (const bKey in bases) {
        const base = bases[bKey];
        if (base.team === p.team || base.currentHealth <= 0) continue;
        const bdx = base.x - p.x; const bdz = base.z - p.z;
        const bDist = Math.sqrt(bdx * bdx + bdz * bdz);
        if (bDist > (MELEE_RANGE * p.scale + BASE_RADIUS) || bDist === 0) continue;
        const dot = (bdx * dirX + bdz * dirZ) / bDist;
        if (Math.acos(Math.max(-1, Math.min(1, dot))) <= MELEE_ARC / 2) {
          const dmg = MELEE_BASE_DAMAGE * p.damageMultiplier;
          base.currentHealth = Math.max(0, base.currentHealth - dmg);
          const baseColor = base.team === 'red' ? '#ff4444' : '#4488ff';
          io.emit('combatEvent', { type: 'damage', x: base.x, z: base.z, amount: Math.round(dmg), color: baseColor });
        }
      }
    } else {
      const projId = `proj_${projIdCounter++}`;
      if (p.classType === 'engineer') {
        projectiles[projId] = {
          id: projId, kind: 'mine', ownerId: socket.id, ownerTeam: p.team, ownerColor: p.color, ownerClass: p.classType, ownerDamageMult: p.damageMultiplier,
          ownerBaseDamage: p.baseDamage,
          x: p.x, z: p.z, vx: 0, vz: 0, life: ENGINEER_MINE_LIFESPAN,
        };
      } else {
        projectiles[projId] = {
          id: projId, kind: 'normal', ownerId: socket.id, ownerTeam: p.team, ownerColor: p.color, ownerClass: p.classType, ownerDamageMult: p.damageMultiplier,
          ownerBaseDamage: p.baseDamage,
          x: p.x, z: p.z, vx: dirX * PROJECTILE_SPEED, vz: dirZ * PROJECTILE_SPEED, life: PROJECTILE_LIFESPAN,
        };
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
        p.currentHealth -= dmg;
        p.lastAttackerId = proj.ownerId;
        // Track damage dealt
        if (proj.ownerId && players[proj.ownerId]) {
          players[proj.ownerId].damageDealt = (players[proj.ownerId].damageDealt || 0) + dmg;
        }
        io.emit('combatEvent', { type: 'damage', x: p.x, z: p.z, amount: Math.round(dmg), color: p.color, targetId: p.id });
        delete projectiles[projId]; destroyed = true; break;
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
    playerSnapshot[id] = {
      id: p.id, username: p.username, x: p.x, y: p.y, z: p.z, color: p.color, team: p.team, type: p.type, classType: p.classType,
      exp: p.exp, maxExp: p.maxExp, level: p.level, maxHealth: p.maxHealth, currentHealth: p.currentHealth,
      scale: p.scale, permaDead: p.permaDead, isStunned: p.isStunned, isInvincible: p.isInvincible,
      isStealthed: p.isStealthed, isConfused: p.isConfused, isChoosingSkill: !!p.isChoosingSkill,
      skills: { ...(p.skills || {}) }, rotY: p.rotY, hasBossBuff: !!p.hasBossBuff
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

  io.emit('stateUpdate', {
    players: playerSnapshot,
    orbs: Object.fromEntries(Object.entries(orbs).map(([id, o]) => [id, { id: o.id, x: o.x, y: o.y, z: o.z }])),
    projectiles: Object.fromEntries(Object.entries(projectiles).map(([id, pr]) => [id, {
      id: pr.id,
      x: pr.x,
      z: pr.z,
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

