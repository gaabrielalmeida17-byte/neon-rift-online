const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const GAME_FILE = path.join(__dirname, 'neon-rift-online.html');

const rooms = new Map();
const clients = new Map();

function id() {
  return crypto.randomBytes(8).toString('hex');
}

function roomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = '';
    for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms.has(code));
  return code;
}

function cleanName(name) {
  return String(name || 'Piloto').replace(/[^\p{L}\p{N}_ -]/gu, '').trim().slice(0, 18) || 'Piloto';
}

function publicPlayer(c) {
  return {
    id: c.id,
    name: c.name,
    host: c.host,
    x: Number.isFinite(c.x) ? c.x : null,
    y: Number.isFinite(c.y) ? c.y : null,
    ship: Number.isFinite(c.ship) ? c.ship : 0,
    hp: Number.isFinite(c.hp) ? c.hp : 0,
    energy: Number.isFinite(c.energy) ? c.energy : 100,
    inv: Number.isFinite(c.inv) ? c.inv : 0
  };
}

function roomPlayers(room) {
  const out = {};
  for (const c of room.clients) out[c.id] = publicPlayer(c);
  return out;
}

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function broadcast(room, obj, except) {
  for (const c of room.clients) {
    if (c.ws !== except && c.ws.readyState === 1) send(c.ws, obj);
  }
}

function leaveRoom(c, notify = true) {
  if (!c.room) return;
  const room = rooms.get(c.room);
  if (!room) {
    c.room = null;
    c.host = false;
    return;
  }

  room.clients.delete(c.id);
  const wasHost = room.hostId === c.id;

  if (room.clients.size === 0) {
    rooms.delete(room.code);
  } else {
    if (wasHost) {
      const next = room.clients.values().next().value;
      room.hostId = next.id;
      next.host = true;
    }
    if (notify) broadcast(room, { type: 'left', id: c.id });
    broadcast(room, { type: 'players', players: roomPlayers(room) });
  }

  c.room = null;
  c.host = false;
}

function joinRoom(c, code) {
  code = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const room = rooms.get(code);
  if (!room) return send(c.ws, { type: 'error', message: 'SALA NÃO ENCONTRADA' });
  if (room.clients.size >= 2) return send(c.ws, { type: 'error', message: 'SALA CHEIA (MÁXIMO 2 PILOTOS)' });

  leaveRoom(c, false);
  c.room = code;
  c.host = false;
  c.name = cleanName(c.name);
  room.clients.set(c.id, c);

  send(c.ws, { type: 'roomJoined', code, role: 'guest', id: c.id, players: roomPlayers(room) });
  broadcast(room, { type: 'players', players: roomPlayers(room) }, null);
}

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname;
  if (pathname === '/health') {
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify({
      ok: true,
      service: 'neon-rift-online',
      clients: clients.size,
      rooms: rooms.size,
      time: new Date().toISOString()
    }));
    return;
  }

  if (pathname === '/' || pathname === '/index.html' || pathname === '/neon-rift-online.html') {
    fs.readFile(GAME_FILE, (err, data) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Jogo não encontrado.');
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      res.end(data);
    });
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
});

const wss = new WebSocketServer({
  server,
  maxPayload: 64 * 1024
});

wss.on('connection', ws => {
  const c = {
    ws,
    id: id(),
    name: 'Piloto',
    room: null,
    host: false,
    x: null,
    y: null,
    ship: 0,
    hp: 0,
    energy: 100,
    inv: 0,
    alive: true
  };
  clients.set(c.id, c);

  send(ws, { type: 'hello', id: c.id });

  ws.on('message', raw => {
    let m;
    try {
      m = JSON.parse(raw.toString());
    } catch {
      return send(ws, { type: 'error', message: 'MENSAGEM INVÁLIDA' });
    }
    if (!m || typeof m.type !== 'string') return;

    if (m.type === 'hello') {
      c.name = cleanName(m.name);
      return;
    }

    if (m.type === 'create') {
      leaveRoom(c, false);
      c.name = cleanName(m.name);
      const code = roomCode();
      const room = { code, hostId: c.id, clients: new Map(), started: false, level: 1 };
      rooms.set(code, room);
      c.room = code;
      c.host = true;
      room.clients.set(c.id, c);
      return send(ws, { type: 'roomCreated', code, role: 'host', id: c.id, players: roomPlayers(room) });
    }

    if (m.type === 'join') {
      c.name = cleanName(m.name);
      return joinRoom(c, m.code);
    }

    if (m.type === 'start') {
      if (!c.room) return send(ws, { type: 'error', message: 'ENTRE EM UMA SALA PRIMEIRO' });
      const room = rooms.get(c.room);
      if (!room) return send(ws, { type: 'error', message: 'SALA ENCERRADA' });
      if (room.hostId !== c.id) return send(ws, { type: 'error', message: 'SOMENTE O HOST PODE INICIAR' });
      if (room.clients.size < 2) return send(ws, { type: 'error', message: 'AGUARDE O SEGUNDO PILOTO' });
      room.started = true;
      room.level = Math.max(1, Math.min(1000, Number(m.level) || 1));
      broadcast(room, { type: 'start', level: room.level });
      return;
    }

    if (m.type === 'state') {
      if (!c.room) return;
      const room = rooms.get(c.room);
      if (!room) return;
      const num = v => Number.isFinite(Number(v)) ? Number(v) : 0;
      c.x = Math.max(-1000, Math.min(2000, num(m.x)));
      c.y = Math.max(-1000, Math.min(3000, num(m.y)));
      c.ship = Math.max(0, Math.min(99, Math.floor(num(m.ship))));
      c.hp = Math.max(0, Math.min(9999, num(m.hp)));
      c.energy = Math.max(0, Math.min(100, num(m.energy)));
      c.inv = Math.max(0, Math.min(10, num(m.inv)));
      broadcast(room, { type: 'peerState', id: c.id, state: publicPlayer(c) }, ws);
      return;
    }

    if (m.type === 'shot') {
      if (!c.room) return;
      const room = rooms.get(c.room);
      if (!room) return;
      const n = v => Number.isFinite(Number(v)) ? Number(v) : 0;
      const shot = {
        type: 'peerShot',
        id: c.id,
        x: Math.max(-1000, Math.min(2000, n(m.x))),
        y: Math.max(-1000, Math.min(3000, n(m.y))),
        vx: Math.max(-2000, Math.min(2000, n(m.vx))),
        vy: Math.max(-3000, Math.min(3000, n(m.vy))),
        damage: Math.max(0, Math.min(999, n(m.damage)))
      };
      broadcast(room, shot, ws);
      return;
    }

    if (m.type === 'leave') {
      leaveRoom(c);
      return;
    }

    if (m.type === 'ping') {
      return send(ws, { type: 'pong', t: Date.now() });
    }
  });

  ws.on('close', () => {
    leaveRoom(c);
    clients.delete(c.id);
  });

  ws.on('error', () => {
    leaveRoom(c);
    clients.delete(c.id);
  });
});

const heartbeat = setInterval(() => {
  for (const c of clients.values()) {
    if (c.ws.readyState !== 1) continue;
    try {
      c.ws.ping();
    } catch {}
  }
}, 25000);

process.on('SIGINT', () => {
  clearInterval(heartbeat);
  for (const c of clients.values()) {
    try { c.ws.close(1001, 'Servidor encerrando'); } catch {}
  }
  server.close(() => process.exit(0));
});

server.listen(PORT, HOST, () => {
  console.log(`Neon Rift Online HTTP: listening on ${HOST}:${PORT}`);
  console.log(`WebSocket: same origin (${process.env.RENDER_EXTERNAL_URL ? process.env.RENDER_EXTERNAL_URL.replace(/^http/i, 'ws') : 'ws://localhost:'+PORT})`);
});
