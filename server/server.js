const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

// ── Config ──────────────────────────────────────────────────────────────────
const PORT = 3000;
const TICK_RATE = 30;
const PLAYER_SPEED = 5;
const PLAYER_COLORS_RED  = ['#ff4444', '#ff6655', '#ee3333', '#ff5544'];
const PLAYER_COLORS_BLUE = ['#4444ff', '#5566ff', '#3333ee', '#4455ff'];

// ── Ecosystem ───────────────────────────────────────────────────────────────
const ORB_COUNT = 70;
const MAP_BOUNDARY = 50;
const ORB_COLLECT_RADIUS = 1.2;
const EXP_PER_ORB = 1;
const EXP_PER_LEVEL = 5;
const SCALE_PER_LEVEL = 0.2;
const KILL_BOUNTY_EXP = 50;

// ── Combat Config ───────────────────────────────────────────────────────────
const MELEE_DAMAGE = 20;
const MELEE_RANGE = 3;
const MELEE_ARC = Math.PI / 2;
const MELEE_BASE_DAMAGE = 40;
const RANGED_DAMAGE = 15;
const RANGED_BASE_DAMAGE = 25;
const PROJECTILE_SPEED = 20;
const PROJECTILE_LIFESPAN = 2.0;
const PROJECTILE_RADIUS = 0.6;

const BASE_RADIUS = 5;
const BASE_MAX_HEALTH = 2000;

// ── Class Definitions ───────────────────────────────────────────────────────
const CLASS_DEFS = {
  warrior: {
    type: 'cube', maxHealth: 150, currentHealth: 150, maxMana: 50, currentMana: 50,
    speedMultiplier: 1.0, attackCooldown: 500, damageMultiplier: 1.0,
  },
  archer: {
    type: 'pyramid', maxHealth: 80, currentHealth: 80, maxMana: 50, currentMana: 50,
    speedMultiplier: 1.2, attackCooldown: 300, damageMultiplier: 1.0,
  },
  mage: {
    type: 'icosahedron', maxHealth: 90, currentHealth: 90, maxMana: 50, currentMana: 50,
    speedMultiplier: 0.9, attackCooldown: 800, damageMultiplier: 1.5,
  },
  priest: {
    type: 'torus', maxHealth: 120, currentHealth: 120, maxMana: 50, currentMana: 50,
    speedMultiplier: 1.1, attackCooldown: 400, damageMultiplier: 0.6,
  },
};

// ── Server Setup ────────────────────────────────────────────────────────────
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

// ── Game State ──────────────────────────────────────────────────────────────
const players = {};
const orbs = {};
const projectiles = {};
const blackHoles = {};
let orbIdCounter = 0;
let projIdCounter = 0;
let redColorIdx = 0;
let blueColorIdx = 0;

const bases = {
  red:  { id: 'base_red', team: 'red', maxHealth: BASE_MAX_HEALTH, currentHealth: BASE_MAX_HEALTH, x: -40, z: -40, scale: 5 },
  blue: { id: 'base_blue', team: 'blue', maxHealth: BASE_MAX_HEALTH, currentHealth: BASE_MAX_HEALTH, x: 40, z: 40, scale: 5 },
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

function spawnOrb() {
  const id = `orb_${orbIdCounter++}`;
  orbs[id] = { id, x: (Math.random() - 0.5) * 2 * MAP_BOUNDARY, y: 0.5, z: (Math.random() - 0.5) * 2 * MAP_BOUNDARY };
}
for (let i = 0; i < ORB_COUNT; i++) spawnOrb();

function resetPlayer(p) {
  const classDef = CLASS_DEFS[p.classType] || CLASS_DEFS.warrior;
  const spawn = getSpawnPos(p.team);
  p.x = spawn.x; p.y = 0.5; p.z = spawn.z;
  p.exp = 0; p.level = 1; p.scale = 1; p.permaDead = false; p.lastAttackerId = null;
  p.maxHealth = classDef.maxHealth; p.currentHealth = classDef.maxHealth;
  p.maxMana = classDef.maxMana; p.currentMana = classDef.maxMana;
  p.skillPoints = 0; p.skills = { damage: 0, health: 0, speed: 0 }; p.damageMultiplier = classDef.damageMultiplier;
  p.isStunned = false; p.isInvincible = false; p.lastUltimateTime = 0;
  p.rotY = 0; p.input = { vX: 0, vZ: 0, rotY: 0 };
}

// ── Socket.io Events ────────────────────────────────────────────────────────
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
      team, classType, type: classDef.type, input: { vX: 0, vZ: 0, rotY: 0 }, rotY: 0,
      exp: 0, level: 1, scale: 1, permaDead: false,
      maxHealth: classDef.maxHealth, currentHealth: classDef.currentHealth,
      maxMana: classDef.maxMana, currentMana: classDef.currentMana,
      speedMultiplier: classDef.speedMultiplier, attackCooldown: classDef.attackCooldown, lastAttackTime: 0,
      skillPoints: 0, skills: { damage: 0, health: 0, speed: 0 }, damageMultiplier: classDef.damageMultiplier,
      lastAttackerId: null, isStunned: false, isInvincible: false, lastUltimateTime: 0
    };
    console.log(`⚔  ${username} joined team ${team} as ${classType}`);
  });

  socket.on('upgradeSkill', (skillName) => {
    const p = players[socket.id];
    if (!p || p.permaDead || p.skillPoints <= 0) return;
    if (['damage', 'health', 'speed'].includes(skillName)) {
      p.skillPoints -= 1;
      p.skills[skillName] += 1;
      if (skillName === 'damage') { p.damageMultiplier += 0.2; }
      else if (skillName === 'health') { p.maxHealth += 20; p.currentHealth += 20; }
      else if (skillName === 'speed') { p.speedMultiplier += 0.1; }
    }
  });

  socket.on('sendChat', (text) => {
    io.emit('socialEvent', { type: 'chat', playerId: socket.id, text });
  });

  socket.on('sendEmote', (emoteId) => {
    io.emit('socialEvent', { type: 'emote', playerId: socket.id, emoteId });
  });

  socket.on('move', (input) => {
    const p = players[socket.id];
    if (!p || p.permaDead || p.isStunned) return;
    p.input = input || {};
  });

  socket.on('ultimate', (data) => {
    const p = players[socket.id];
    if (!p || p.permaDead || p.isStunned) return;

    const now = Date.now();
    if (now - p.lastUltimateTime < 15000) return;
    p.lastUltimateTime = now;

    const tx = Number(data.targetX) || p.x;
    const tz = Number(data.targetZ) || p.z;
    let emittedCast = false;

    if (p.classType === 'warrior') {
      for (const eid in players) {
        if (eid === socket.id) continue;
        const enemy = players[eid];
        if (enemy.team === p.team || enemy.permaDead || enemy.isInvincible) continue;
        const dX = enemy.x - p.x; const dZ = enemy.z - p.z;
        if (dX*dX + dZ*dZ <= 15*15) {
          const dmg = 50 * p.damageMultiplier;
          enemy.currentHealth -= dmg;
          enemy.lastAttackerId = socket.id;
          enemy.isStunned = true;
          io.emit('combatEvent', { type: 'damage', x: enemy.x, z: enemy.z, amount: Math.round(dmg), color: enemy.color });
          setTimeout(() => { if(players[eid]) players[eid].isStunned = false; }, 1500);
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
        if (dX*dX + dZ*dZ <= 20*20) {
          ally.isInvincible = true;
          setTimeout(() => { if(players[eid]) players[eid].isInvincible = false; }, 4000);
        }
      }
      emittedCast = true;
    }

    if (emittedCast) io.emit('ultimateCast', { playerId: socket.id, classType: p.classType, x: p.x, z: p.z, targetX: tx, targetZ: tz });
  });

  socket.on('attack', (data) => {
    const p = players[socket.id];
    if (!p || p.permaDead || p.isStunned) return;

    const now = Date.now();
    if (now - p.lastAttackTime < p.attackCooldown) return;
    p.lastAttackTime = now;

    const tx = Number(data.targetX); const tz = Number(data.targetZ);
    if (isNaN(tx) || isNaN(tz)) return;

    const dx = tx - p.x; const dz = tz - p.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist === 0) return;
    const dirX = dx / dist; const dirZ = dz / dist;

    if (p.classType === 'warrior') {
      for (const eid in players) {
        if (eid === socket.id) continue;
        const enemy = players[eid];
        if (enemy.team === p.team || enemy.permaDead || enemy.isInvincible) continue;
        const edx = enemy.x - p.x; const edz = enemy.z - p.z;
        const eDist = Math.sqrt(edx * edx + edz * edz);
        if (eDist > MELEE_RANGE * p.scale || eDist === 0) continue;
        const dot = (edx * dirX + edz * dirZ) / eDist;
        if (Math.acos(Math.max(-1, Math.min(1, dot))) <= MELEE_ARC / 2) {
          const dmg = MELEE_DAMAGE * p.damageMultiplier;
          enemy.currentHealth -= dmg;
          enemy.lastAttackerId = socket.id;
          io.emit('combatEvent', { type: 'damage', x: enemy.x, z: enemy.z, amount: Math.round(dmg), color: enemy.color });
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
      projectiles[projId] = {
        id: projId, ownerId: socket.id, ownerTeam: p.team, ownerColor: p.color, ownerDamageMult: p.damageMultiplier,
        x: p.x, z: p.z, vx: dirX * PROJECTILE_SPEED, vz: dirZ * PROJECTILE_SPEED, life: PROJECTILE_LIFESPAN,
      };
    }
  });

  socket.on('disconnect', () => { delete players[socket.id]; });
});

// ── Game Loop ─────────────────────────────────────────────────────────────
const delta = 1 / TICK_RATE;
setInterval(() => {
  for (const id in players) {
    const p = players[id];
    if (p.permaDead || p.isStunned) continue;
    const speed = PLAYER_SPEED * p.speedMultiplier;
    
    let dx = 0; let dz = 0;
    if (p.input.up) dz -= 1;
    if (p.input.down) dz += 1;
    if (p.input.left) dx -= 1;
    if (p.input.right) dx += 1;
    
    if (dx !== 0 && dz !== 0) {
      dx *= 0.7071;
      dz *= 0.7071;
    }

    p.x += dx * speed * delta;
    p.z += dz * speed * delta;
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
          enemy.x -= (dX / dist) * 10 * delta;
          enemy.z -= (dZ / dist) * 10 * delta;
          const dmgAmount = BLACKHOLE_DPS * bh.damageMult * delta;
          enemy.currentHealth -= dmgAmount;
          enemy.lastAttackerId = bh.ownerId;
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
        delete orbs[orbId]; p.exp += EXP_PER_ORB;
        while (p.exp >= EXP_PER_LEVEL) { // Loop for potential multiple levelups dynamically
          p.exp -= EXP_PER_LEVEL; p.level += 1; p.scale += SCALE_PER_LEVEL; p.skillPoints += 1;
          p.maxHealth += 10; p.currentHealth = p.maxHealth;
        }
        p.y = 0.5 * p.scale; spawnOrb();
      }
    }
  }

  for (const projId in projectiles) {
    const proj = projectiles[projId];
    proj.x += proj.vx * delta; proj.z += proj.vz * delta; proj.life -= delta;
    if (proj.life <= 0 || Math.abs(proj.x) > MAP_BOUNDARY + 10 || Math.abs(proj.z) > MAP_BOUNDARY + 10) { delete projectiles[projId]; continue; }
    let destroyed = false;
    for (const pid in players) {
      const p = players[pid];
      if (pid === proj.ownerId || p.team === proj.ownerTeam || p.permaDead || p.isInvincible) continue;
      if ((proj.x-p.x)**2 + (proj.z-p.z)**2 < (PROJECTILE_RADIUS * p.scale)**2) {
        const dmg = RANGED_DAMAGE * proj.ownerDamageMult;
        p.currentHealth -= dmg;
        p.lastAttackerId = proj.ownerId; // Track damage source
        io.emit('combatEvent', { type: 'damage', x: p.x, z: p.z, amount: Math.round(dmg), color: p.color });
        delete projectiles[projId]; destroyed = true; break;
      }
    }
    if (destroyed) continue;
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
        console.log(`💰 ${players[p.lastAttackerId].username} claimed bounty on ${p.username}`);
      }
      p.lastAttackerId = null;

      if (bases[p.team] && bases[p.team].currentHealth > 0) resetPlayer(p);
      else { p.currentHealth = 0; p.permaDead = true; p.input = { vX: 0, vZ: 0, rotY: 0 }; }
    }
  }
  
  // Process kill bounty Multi-Level-Ups
  for (const aId in bountyQueue) {
    const atk = players[aId];
    if (atk && !atk.permaDead) {
      atk.exp += bountyQueue[aId];
      while (atk.exp >= EXP_PER_LEVEL) {
        atk.exp -= EXP_PER_LEVEL; atk.level += 1; atk.scale += SCALE_PER_LEVEL; atk.skillPoints += 1;
        atk.maxHealth += 10; atk.currentHealth = atk.maxHealth;
      }
      atk.y = 0.5 * atk.scale;
    }
  }

  const playerSnapshot = {};
  for (const id in players) {
    const p = players[id];
    playerSnapshot[id] = {
      id: p.id, username: p.username, x: p.x, y: p.y, z: p.z, color: p.color, team: p.team, type: p.type, classType: p.classType,
      exp: p.exp, level: p.level, maxHealth: p.maxHealth, currentHealth: p.currentHealth,
      scale: p.scale, permaDead: p.permaDead, skillPoints: p.skillPoints, isStunned: p.isStunned, isInvincible: p.isInvincible, rotY: p.rotY
    };
  }

  io.emit('stateUpdate', {
    players: playerSnapshot,
    orbs: Object.fromEntries(Object.entries(orbs).map(([id, o]) => [id, { id: o.id, x: o.x, y: o.y, z: o.z }])),
    projectiles: Object.fromEntries(Object.entries(projectiles).map(([id, pr]) => [id, { id: pr.id, x: pr.x, z: pr.z, ownerColor: pr.ownerColor }])),
    bases: { red: { ...bases.red }, blue: { ...bases.blue } },
  });
}, 1000 / TICK_RATE);

server.listen(PORT, () => console.log(`🚀  Game server running on http://localhost:${PORT}`));
