'use strict';

const GRID = 50;
const SPEED = 4.5;
const MAX_PLAYERS = 8;
const RESPAWN_DELAY = 2200;
const SPAWN_BLOCK = 2;
const COLORS = ['#ff5d5d', '#5da9ff', '#5dff8a', '#ffe45d', '#ff8ad1', '#b45dff', '#5dfff0', '#ff9d5d'];

function idx(cx, cy) { return cy * GRID + cx; }
function inBounds(cx, cy) { return cx >= 0 && cy >= 0 && cx < GRID && cy < GRID; }

function makeRoom(code) {
  return {
    code,
    ownerGrid: new Uint8Array(GRID * GRID),
    trailGrid: new Uint8Array(GRID * GRID),
    players: new Map(),
    nextSlot: 1,
    createdAt: Date.now()
  };
}

function freeSlot(room) {
  const used = new Set(Array.from(room.players.values()).map(p => p.slot));
  for (let s = 1; s <= MAX_PLAYERS; s++) if (!used.has(s)) return s;
  return null;
}

function pickSpawn(room) {
  const margin = 6;
  for (let attempt = 0; attempt < 30; attempt++) {
    const cx = margin + Math.floor(Math.random() * (GRID - margin * 2));
    const cy = margin + Math.floor(Math.random() * (GRID - margin * 2));
    let clear = true;
    for (let dy = -SPAWN_BLOCK - 2; dy <= SPAWN_BLOCK + 2 && clear; dy++) {
      for (let dx = -SPAWN_BLOCK - 2; dx <= SPAWN_BLOCK + 2 && clear; dx++) {
        const gx = cx + dx, gy = cy + dy;
        if (!inBounds(gx, gy)) continue;
        if (room.ownerGrid[idx(gx, gy)] !== 0) clear = false;
      }
    }
    if (clear) return { cx, cy };
  }
  return { cx: Math.floor(GRID / 2), cy: Math.floor(GRID / 2) };
}

function claimSpawnBlock(room, player) {
  const { cx, cy } = pickSpawn(room);
  for (let dy = -SPAWN_BLOCK; dy <= SPAWN_BLOCK; dy++) {
    for (let dx = -SPAWN_BLOCK; dx <= SPAWN_BLOCK; dx++) {
      const gx = cx + dx, gy = cy + dy;
      if (!inBounds(gx, gy)) continue;
      room.ownerGrid[idx(gx, gy)] = player.slot;
    }
  }
  player.x = cx + 0.5;
  player.y = cy + 0.5;
  player.lastCell = { cx, cy };
}

function addPlayer(room, id, name) {
  if (room.players.size >= MAX_PLAYERS) return null;
  const slot = freeSlot(room);
  if (slot === null) return null;
  const player = {
    id, slot, name: String(name || 'Игрок').slice(0, 16),
    color: COLORS[(slot - 1) % COLORS.length],
    x: 0, y: 0, dir: { dx: 0, dy: 0 }, nextDir: { dx: 0, dy: 0 },
    trail: [], alive: true, score: 0, lastCell: null,
    deadUntil: 0
  };
  room.players.set(id, player);
  claimSpawnBlock(room, player);
  return player;
}

function removePlayer(room, id) {
  const player = room.players.get(id);
  if (!player) return;
  clearTrail(room, player);
  room.players.delete(id);
}

function setInput(room, id, dx, dy) {
  const player = room.players.get(id);
  if (!player || !player.alive) return;
  if (dx === 0 && dy === 0) return;
  if (dx === -player.dir.dx && dy === -player.dir.dy && (player.dir.dx || player.dir.dy)) return;
  player.nextDir = { dx, dy };
}

function clearTrail(room, player) {
  for (const c of player.trail) {
    const i = idx(c.cx, c.cy);
    if (room.trailGrid[i] === player.slot) room.trailGrid[i] = 0;
  }
  player.trail = [];
}

function killPlayer(room, player, now) {
  if (!player.alive) return;
  player.alive = false;
  player.dir = { dx: 0, dy: 0 };
  player.nextDir = { dx: 0, dy: 0 };
  clearTrail(room, player);
  player.deadUntil = now + RESPAWN_DELAY;
}

function respawnIfReady(room, player, now) {
  if (player.alive || now < player.deadUntil) return;
  for (let i = 0; i < room.ownerGrid.length; i++) {
    if (room.ownerGrid[i] === player.slot) room.ownerGrid[i] = 0;
  }
  player.alive = true;
  player.score = 0;
  claimSpawnBlock(room, player);
}

function captureTerritory(room, player) {
  if (player.trail.length === 0) return;
  const blocked = new Uint8Array(GRID * GRID);
  for (const c of player.trail) blocked[idx(c.cx, c.cy)] = 1;

  const reached = new Uint8Array(GRID * GRID);
  const queue = [];
  for (let x = 0; x < GRID; x++) {
    pushIfOpen(x, 0); pushIfOpen(x, GRID - 1);
  }
  for (let y = 0; y < GRID; y++) {
    pushIfOpen(0, y); pushIfOpen(GRID - 1, y);
  }

  function pushIfOpen(x, y) {
    const i = idx(x, y);
    if (blocked[i] || reached[i]) return;
    reached[i] = 1;
    queue.push(i);
  }

  while (queue.length) {
    const i = queue.pop();
    const cx = i % GRID, cy = Math.floor(i / GRID);
    const neighbors = [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]];
    for (const [nx, ny] of neighbors) {
      if (!inBounds(nx, ny)) continue;
      pushIfOpen(nx, ny);
    }
  }

  for (let i = 0; i < room.ownerGrid.length; i++) {
    if (blocked[i]) {
      room.ownerGrid[i] = player.slot;
    } else if (!reached[i] && room.ownerGrid[i] === 0) {
      room.ownerGrid[i] = player.slot;
    }
  }

  clearTrail(room, player);
}

function tick(room, dt, now) {
  for (const player of room.players.values()) {
    if (!player.alive) {
      respawnIfReady(room, player, now);
      continue;
    }

    if (player.nextDir.dx || player.nextDir.dy) {
      player.dir = player.nextDir;
    }
    if (!player.dir.dx && !player.dir.dy) continue;

    player.x += player.dir.dx * SPEED * dt;
    player.y += player.dir.dy * SPEED * dt;

    const cx = Math.floor(player.x);
    const cy = Math.floor(player.y);

    if (!inBounds(cx, cy)) {
      killPlayer(room, player, now);
      continue;
    }

    if (!player.lastCell || cx !== player.lastCell.cx || cy !== player.lastCell.cy) {
      player.lastCell = { cx, cy };
      const i = idx(cx, cy);

      if (room.ownerGrid[i] === player.slot) {
        if (player.trail.length > 0) captureTerritory(room, player);
      } else if (room.trailGrid[i] === player.slot) {
        killPlayer(room, player, now);
      } else if (room.trailGrid[i] !== 0) {
        const victim = Array.from(room.players.values()).find(p => p.slot === room.trailGrid[i]);
        if (victim) killPlayer(room, victim, now);
        room.trailGrid[i] = player.slot;
        player.trail.push({ cx, cy });
      } else {
        room.trailGrid[i] = player.slot;
        player.trail.push({ cx, cy });
      }
    }
  }

  const alive = Array.from(room.players.values()).filter(p => p.alive);
  for (let a = 0; a < alive.length; a++) {
    for (let b = a + 1; b < alive.length; b++) {
      const p1 = alive[a], p2 = alive[b];
      const dx = p1.x - p2.x, dy = p1.y - p2.y;
      if (dx * dx + dy * dy < 0.32 * 0.32) {
        killPlayer(room, p1, now);
        killPlayer(room, p2, now);
      }
    }
  }

  const counts = new Map();
  for (let i = 0; i < room.ownerGrid.length; i++) {
    const slot = room.ownerGrid[i];
    if (slot === 0) continue;
    counts.set(slot, (counts.get(slot) || 0) + 1);
  }
  for (const player of room.players.values()) player.score = counts.get(player.slot) || 0;
}

function snapshot(room) {
  return {
    code: room.code,
    grid: GRID,
    owner: room.ownerGrid.join(''),
    players: Array.from(room.players.values()).map(p => ({
      id: p.id, slot: p.slot, name: p.name, color: p.color,
      x: p.x, y: p.y, dir: p.dir, alive: p.alive, score: p.score,
      trail: p.trail, respawnIn: p.alive ? 0 : Math.max(0, p.deadUntil - Date.now())
    }))
  };
}

module.exports = {
  GRID, SPEED, MAX_PLAYERS, COLORS,
  makeRoom, addPlayer, removePlayer, setInput, tick, snapshot,
  captureTerritory, killPlayer, idx, inBounds
};
