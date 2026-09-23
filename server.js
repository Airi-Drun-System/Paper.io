'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { attachWebSocketServer } = require('./wsLite');
const gameLogic = require('./gameLogic');

const PORT = process.env.PORT || 3000;
const TICK_MS = 80;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const rooms = new Map();
const sockets = new Map();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8'
};

const publicDir = path.join(__dirname, 'public');

const httpServer = http.createServer((req, res) => {
  let reqPath = req.url.split('?')[0];
  if (reqPath === '/') reqPath = '/index.html';
  const filePath = path.join(publicDir, reqPath);
  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

function makeRoomCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  } while (rooms.has(code));
  return code;
}

function getOrCreateSocketMap(code) {
  if (!sockets.has(code)) sockets.set(code, new Map());
  return sockets.get(code);
}

function broadcast(code, obj) {
  const map = sockets.get(code);
  if (!map) return;
  const msg = JSON.stringify(obj);
  for (const conn of map.values()) {
    if (conn.alive) conn.send(msg);
  }
}

function sendTo(conn, obj) {
  if (conn.alive) conn.send(JSON.stringify(obj));
}

function leaveRoom(conn) {
  if (!conn.roomCode || !conn.playerId) return;
  const room = rooms.get(conn.roomCode);
  const map = sockets.get(conn.roomCode);
  if (room) gameLogic.removePlayer(room, conn.playerId);
  if (map) map.delete(conn.playerId);
  if (room && room.players.size === 0) {
    rooms.delete(conn.roomCode);
    sockets.delete(conn.roomCode);
  }
  conn.roomCode = null;
  conn.playerId = null;
}

attachWebSocketServer(httpServer, (conn) => {
  conn.playerId = null;
  conn.roomCode = null;

  conn.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    if (!msg || typeof msg.t !== 'string') return;

    if (msg.t === 'create') {
      const code = makeRoomCode();
      const room = gameLogic.makeRoom(code);
      rooms.set(code, room);
      const playerId = crypto.randomBytes(8).toString('hex');
      const player = gameLogic.addPlayer(room, playerId, msg.name);
      conn.roomCode = code;
      conn.playerId = playerId;
      getOrCreateSocketMap(code).set(playerId, conn);
      sendTo(conn, { t: 'joined', code, slot: player.slot, grid: gameLogic.GRID, colors: gameLogic.COLORS, you: playerId });
      return;
    }

    if (msg.t === 'join') {
      const code = String(msg.code || '').toUpperCase().trim();
      const room = rooms.get(code);
      if (!room) {
        sendTo(conn, { t: 'error', msg: 'Комната не найдена' });
        return;
      }
      if (room.players.size >= gameLogic.MAX_PLAYERS) {
        sendTo(conn, { t: 'error', msg: 'Комната заполнена' });
        return;
      }
      const playerId = crypto.randomBytes(8).toString('hex');
      const player = gameLogic.addPlayer(room, playerId, msg.name);
      if (!player) {
        sendTo(conn, { t: 'error', msg: 'Не удалось подключиться' });
        return;
      }
      conn.roomCode = code;
      conn.playerId = playerId;
      getOrCreateSocketMap(code).set(playerId, conn);
      sendTo(conn, { t: 'joined', code, slot: player.slot, grid: gameLogic.GRID, colors: gameLogic.COLORS, you: playerId });
      return;
    }

    if (msg.t === 'input') {
      if (!conn.roomCode || !conn.playerId) return;
      const room = rooms.get(conn.roomCode);
      if (!room) return;
      const dx = Math.sign(Number(msg.dx) || 0);
      const dy = Math.sign(Number(msg.dy) || 0);
      if (dx !== 0 && dy !== 0) return;
      gameLogic.setInput(room, conn.playerId, dx, dy);
      return;
    }

    if (msg.t === 'leave') {
      leaveRoom(conn);
      return;
    }
  });

  conn.on('close', () => leaveRoom(conn));
});

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    gameLogic.tick(room, TICK_MS / 1000, now);
    broadcast(code, { t: 'state', ...gameLogic.snapshot(room) });
  }
}, TICK_MS);

httpServer.listen(PORT, () => {
  console.log('paperio server listening on ' + PORT);
});
