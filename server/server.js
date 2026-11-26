'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');
const { Room } = require('./room.js');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json',
};

const server = http.createServer((req, res) => {
  let p = decodeURIComponent((req.url || '/').split('?')[0]);
  if (p === '/health') { res.writeHead(200); return res.end('ok'); }
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end('Interdit'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Introuvable'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, maxPayload: 4096 });
const rooms = new Map();
let nextId = 1;

function makeCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  for (;;) {
    let c = '';
    for (let i = 0; i < 4; i++) c += letters[(Math.random() * letters.length) | 0];
    if (!rooms.has(c)) return c;
  }
}
const cleanName = s => String(s || '').replace(/[^\p{L}\p{N} _'.-]/gu, '').trim().slice(0, 14) || 'Tribut';

wss.on('connection', ws => {
  const id = nextId++;
  let room = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  const send = obj => { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); };
  const sendRaw = str => { if (ws.readyState === 1 && ws.bufferedAmount < 1e6) ws.send(str); };
  const me = { id, name: 'Tribut', color: null, send, sendRaw };

  const join = (r, name) => {
    me.name = cleanName(name);
    const err = r.add(me);
    if (err) return send({ t: 'error', text: err });
    room = r;
    send({ t: 'joined', id, code: r.code });
    r.broadcastLobby();
  };

  ws.on('message', raw => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m.t !== 'string') return;
    switch (m.t) {
      case 'create': {
        if (room) return;
        const r = new Room(makeCode(), x => rooms.delete(x.code));
        rooms.set(r.code, r);
        join(r, m.name);
        break;
      }
      case 'join': {
        if (room) return;
        const r = rooms.get(String(m.code || '').toUpperCase().trim());
        if (!r) return send({ t: 'error', text: 'Aucune arène avec ce code.' });
        join(r, m.name);
        break;
      }
      case 'start': if (room) room.start(id); break;
      case 'in': if (room && room.game) room.game.input(id, m); break;
      case 'pick': if (room && room.game) room.game.pickup(id); break;
      case 'spec': if (room && room.game) room.game.spectate(id); break;
      case 'ping': send({ t: 'pong', ts: m.ts }); break;
      case 'dbg': if (process.env.HG_DEBUG && room && room.game) room.game.runEvent(String(m.ev)); break; // tests uniquement
    }
  });
  ws.on('close', () => { if (room) room.remove(id); });
  ws.on('error', () => {});
});

// Garde les connexions ouvertes derrière les proxys (Render, Cloudflare...) et nettoie les morts
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false; ws.ping();
  }
}, 25000);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🏹 Hunger Games — serveur lancé sur le port ${PORT}`);
  console.log(`   Toi (ce PC)   : http://localhost:${PORT}`);
  for (const list of Object.values(os.networkInterfaces()))
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) console.log(`   Même réseau   : http://${i.address}:${PORT}`);
  console.log('   Pour jouer à distance : voir le README (tunnel ou déploiement).\n');
});
